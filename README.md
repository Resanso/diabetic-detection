# Prototype Skrining Retinopati Diabetik (ESP32 + Server + Dashboard)

```
ESP32-CAM ──(WiFi, POST JPEG)──► Server FastAPI + ONNX Runtime ──► SQLite
     ▲                                   │
     └──── JSON {grade, label, ...} ◄────┤
                                         └──► Dashboard web (browser)
```

Model mengklasifikasikan gambar fundus ke 5 grade Diabetic Retinopathy (DR):
0 Tidak ada DR, 1 Ringan, 2 Sedang, 3 Berat, 4 Proliferatif.
Grade ≥ 2 ditandai "perlu dirujuk" (*referable DR*), standar yang umum dipakai pada skrining.

## Struktur folder

```
training/   train.py, preprocess.py   → dijalankan di Kaggle/Colab (GPU)
server/     app.py, preprocess.py, static/dashboard.html, model/
esp32/      esp32_cam_client.ino
```

---

## Tahap 1: Training model (Kaggle, gratis GPU)

1. Buat notebook baru di Kaggle, aktifkan **Accelerator: GPU T4 x2 atau P100** dan **Internet: On**.
2. Klik *Add Input*, cari dataset kompetisi **aptos2019-blindness-detection** (perlu *join competition* dulu).
3. Upload `train.py` dan `preprocess.py` ke notebook (atau salin isinya ke sel dengan `%%writefile`).
4. Jalankan:

```bash
!pip install -q timm onnx onnxruntime
!python train.py --data_dir /kaggle/input/aptos2019-blindness-detection --out /kaggle/working/output --epochs 15
```

Proses preprocessing awal sekitar 5–10 menit, lalu tiap epoch beberapa menit di GPU T4.
Di akhir log akan muncul metrik seperti:

```
Epoch 15: loss=... kappa=0.90 auc_ref=0.97 acc=0.82 sens_ref@0.5=0.90 spec_ref@0.5=0.95 skor[both]=0.935
Ambang rujukan dari val (target sensitivitas 0.95): 0.31
VAL : kappa=0.90 acc=0.82 auc_ref=0.97 sens_ref=0.95 spec_ref=0.88
TEST: kappa=0.89 acc=0.81 auc_ref=0.96 sens_ref=0.94 spec_ref=0.87
ONNX diekspor ke output/dr_model.onnx | selisih maks vs PyTorch: 1e-05
```

Data dibagi 70/15/15 menjadi train, val, dan test. Val dipakai untuk memilih checkpoint (default: rata-rata kappa dan
`auc_ref`, ubah dengan `--select kappa|auc_ref|both`) dan menyetel ambang rujukan agar sensitivitas ≥ `--target_sens`
(default 0.95). Baris **TEST** adalah angka yang jujur untuk dilaporkan, karena data uji tidak dipakai untuk keputusan apa pun.
Ambang ini disimpan di `metadata.json` dan otomatis dipakai server (bisa ditimpa dengan env `REF_PROB`).

Cara membaca metrik:

- **auc_ref** adalah kemampuan model memisahkan pasien perlu rujukan dan tidak, terlepas dari ambang yang dipilih.
- **kappa** (quadratic weighted kappa) adalah metrik resmi APTOS. Nilai sekitar 0.85–0.92 wajar untuk EfficientNet-B0.
- **sens_ref** (sensitivitas referable) paling penting untuk skrining: berapa persen pasien yang perlu dirujuk berhasil terdeteksi. Usahakan setinggi mungkin.
- **spec_ref** (spesifisitas) adalah berapa persen pasien sehat yang benar dinyatakan tidak perlu rujukan.

5. Download dari `/kaggle/working/output/`: **`dr_model.onnx`** dan **`metadata.json`**.

Tips meningkatkan akurasi: naikkan `IMG_SIZE` di `preprocess.py` ke 384 atau 512, ganti `--model efficientnet_b3`,
atau tambahkan data EyePACS 2015. Setiap kali `preprocess.py` diubah, salin juga ke folder `server/` dan training ulang.

---

## Tahap 2: Menjalankan server

Bisa di laptop, Raspberry Pi 4/5, atau VPS. Yang penting satu jaringan WiFi dengan ESP32 (untuk prototype).

```bash
cd server
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

# dr_model.onnx dan metadata.json sudah tersedia di server/model/
# jalankan server (gunakan port 8001 jika port 8000 dipakai aplikasi lain):
uvicorn app:app --host 0.0.0.0 --port 8001
```

Buka dashboard web di browser: **`http://localhost:8001`**.

```bash
curl -X POST --data-binary @contoh_fundus.jpg -H "Content-Type: image/jpeg" \
     -H "X-Device-Id: tes-curl" http://localhost:8000/api/predict
```

Cari IP server untuk ESP32: `ipconfig` (Windows) atau `hostname -I` (Linux/RPi).
Jika ESP32 tidak bisa terhubung, izinkan port 8000 di firewall.

Opsional, untuk keamanan dasar: `API_KEY=rahasia123 uvicorn app:app --host 0.0.0.0 --port 8000`, lalu isi `API_KEY` yang sama di sketch ESP32.
Dengan `API_KEY` aktif, semua endpoint `/api/*` dan `/images/*` wajib memakai header `X-API-Key` (atau cookie dari login dashboard).
Dashboard akan meminta key sekali, lalu menyimpannya sebagai cookie HttpOnly. `/health` dan halaman `/` tetap terbuka.

**Keputusan rujukan.** Status "perlu dirujuk" diambil dari peluang total grade ≥ 2 (`p_referable`), bukan dari grade dengan
probabilitas tertinggi. Ambang default 0.5 bisa diubah lewat env `REF_PROB` (misal `REF_PROB=0.3` untuk sensitivitas lebih tinggi).
Akibatnya hasil bisa berlabel "Tidak ada DR" tapi tetap ditandai perlu dirujuk; itu disengaja.

### Referensi API

| Endpoint | Fungsi |
|---|---|
| `GET /` | Web Dashboard interaktif untuk uji skrining dan evaluasi akurasi model. |
| `POST /api/benchmark/evaluate` | Evaluasi akurasi otomatis pada 50 sampel fundus terverifikasi (menghasilkan akurasi, QWK, sensitivitas, spesifisitas, matriks konfusi 5x5 dan 2x2). |
| `POST /api/benchmark/tune-threshold` | Menyetel ulang ambang probabilitas rujukan secara instan dari hasil yang tersimpan. |
| `POST /api/evaluate/single` | Uji satu citra dengan opsional label Ground Truth, menghasilkan visual pra-pemrosesan dan peta atensi lesi retina. |
| `POST /api/evaluate/batch` | Unggah file `.zip` berisi citra retina kustom untuk evaluasi akurasi massal otomatis. |
| `GET /api/benchmark/samples` | Mengambil daftar 50 sampel benchmark per grade (0..4). |
| `GET /api/model/info` | Informasi arsitektur model, ukuran citra input, label, dan metrik referensi. |
| `POST /api/predict` | Body = JPEG mentah. Header `X-Device-Id`, opsional `X-API-Key`. Respons ringkas untuk ESP32-CAM. |
| `GET /api/device/poll` | Dipanggil ESP32 tiap 1,5 detik (header `X-Device-Id`). Menandai perangkat online dan mengembalikan `{"capture": true}` bila dashboard meminta foto. |
| `POST /api/devices/{id}/capture` | Meminta perangkat memotret (tombol "Ambil Foto" di tab Kamera ESP32). 409 jika perangkat offline. |
| `GET /api/devices` | Daftar perangkat: status online, IP, dan hasil terbaru. Disimpan di memori, hilang saat server restart. |
| `GET/PUT /api/devices/{id}/settings` | Pengaturan kamera & flash (resolusi, kompresi JPEG, eksposur, kecerahan, kontras, saturasi, white balance, cermin/balik, mode & intensitas flash). Disimpan di `data/device_settings.json`; ESP32 menerapkannya lewat poll tanpa upload ulang firmware. |
| `POST /api/upload` | Multipart `file`, dipakai dashboard. Respons lengkap (probabilitas semua grade). |
| `POST /api/login` | Body `{"key": "..."}`. Menyetel cookie sesi untuk dashboard. |
| `GET /images/{nama}` | Mengambil foto retina yang tersimpan. |
| `GET /api/results?limit=100` | Riwayat hasil uji dan status pencocokan Ground Truth. |
| `DELETE /api/results` | Membersihkan log riwayat pengujian. |
| `GET /api/stats` | Ringkasan statistik per grade. |
| `GET /health` | Cek status server dan model aktif. |
Contoh respons `/api/predict`:

```json
{"id":"f28bfe428d84","grade":2,"label":"Sedang","confidence":0.81,"referable":true,"p_referable":0.93,"quality_ok":true}
```

---

## Tahap 3: ESP32-CAM

1. Arduino IDE → Board Manager → install **esp32 by Espressif**. Pilih board **AI Thinker ESP32-CAM**, partition **Huge APP**.
2. Library Manager → install **ArduinoJson** (versi 7).
3. Salin `esp32/esp32_cam_client/secrets.example.h` menjadi `secrets.h` (di-gitignore), isi SSID/password WiFi 2.4 GHz dan `SERVER_URL` (IP server dari tahap 2, port 8001).
4. Upload (pakai ESP32-CAM-MB atau FTDI; GPIO0 ke GND saat upload). Dengan arduino-cli:
   `arduino-cli compile --upload -p /dev/cu.usbserial-XXXX --fqbn esp32:esp32:esp32cam:PartitionScheme=huge_app esp32/esp32_cam_client`
   Pada sebagian ESP32-CAM-MB, tombol RST dan reset otomatis tidak bekerja. Masuk mode download dengan menahan IO0 sambil mencolok USB;
   setelah upload, cabut lalu colok USB lagi (tanpa IO0) untuk menjalankan firmware. Jika upload gagal `No serial data received`,
   tekan ESP32-CAM sampai benar-benar mentok di MB (pin U0R yang longgar adalah penyebab umum).
5. Buka Serial Monitor 115200. Tekan tombol di GPIO13 (ke GND) atau ketik `c`.

Pengaturan kualitas foto dan flash ada di kartu **Pengaturan Kamera & Flash** pada tab yang sama. Flash default menyala
saat memotret dengan intensitas 50%; mode "Selalu nyala" hanya untuk membidik sebentar.
Bisa juga memotret dari web: buka dashboard, tab **Kamera ESP32**, tunggu status online, lalu klik **Ambil Foto**.
Tab ini otomatis menampilkan foto dan hasil terbaru (diperbarui tiap 2 detik), termasuk foto dari tombol fisik.
Hasil juga muncul di Serial Monitor dan di tab Riwayat & Log.
LED merah: 1 kedipan = tidak perlu rujukan, 3 kedipan = perlu rujukan, 5 kedipan cepat = error.

---

## Catatan penting

**Optik.** ESP32-CAM tanpa lensa fundus hanya akan memotret permukaan mata, bukan retina, dan model akan tetap
mengeluarkan grade walau gambarnya tidak bermakna. Untuk prototype, pasang lensa kondensing 20D di depan kamera
(teknik *indirect ophthalmoscopy*) atau mulai dengan menguji memakai gambar dataset lewat dashboard.
Jangan arahkan LED flash langsung ke mata.

**Kualitas gambar.** Server memberi tanda "terlalu gelap / terlalu terang / buram" berdasarkan cek sederhana.
Ini bukan pengganti model kualitas gambar, tapi membantu menyaring foto yang jelas tidak layak.

**Domain shift.** Model dilatih dari foto kamera fundus klinis. Foto dari ESP32 akan sangat berbeda (resolusi,
warna, noise), sehingga akurasi di dunia nyata pasti lebih rendah dari metrik validasi. Kumpulkan foto dari
perangkat Anda sendiri, minta dokter mata memberi label, lalu fine-tune ulang.

**Medis.** Sistem ini alat bantu skrining untuk penelitian/prototype, bukan perangkat diagnosis.

## Langkah lanjutan yang bisa dikembangkan

- Ganti polling dashboard dengan WebSocket untuk notifikasi real-time.
- Tambah model penilai kualitas gambar sebelum model DR.
- Grad-CAM untuk menampilkan area retina yang memengaruhi keputusan model.
- Versi *on-device* di ESP32-S3: latih MobileNetV3-small 224px, kuantisasi int8 ke TFLite, jalankan dengan TFLite Micro atau ESP-DL, lalu bandingkan akurasinya dengan versi server.
