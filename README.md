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
Epoch 15: loss=... kappa=0.90 acc=0.82 sens_ref=0.9 spec_ref=0.95
ONNX diekspor ke output/dr_model.onnx | selisih maks vs PyTorch: 1e-05
```

Cara membaca metrik:

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

# taruh dr_model.onnx dan metadata.json ke server/model/
uvicorn app:app --host 0.0.0.0 --port 8000
```

Buka dashboard di `http://localhost:8000`. Uji dulu tanpa ESP32 dengan mengunggah satu gambar dari dataset APTOS lewat panel "Unggah gambar", atau dengan curl:

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
| `POST /api/predict` | Body = JPEG mentah. Header `X-Device-Id`, opsional `X-API-Key`. Respons ringkas untuk ESP32. |
| `POST /api/upload` | Multipart `file`, dipakai dashboard. Respons lengkap (probabilitas semua grade). |
| `POST /api/login` | Body `{"key": "..."}`. Menyetel cookie sesi untuk dashboard. |
| `GET /images/{nama}` | Foto yang tersimpan. |
| `GET /api/results?limit=50` | Riwayat hasil. |
| `GET /api/stats` | Ringkasan per grade. |
| `GET /health` | Cek server hidup. |

Contoh respons `/api/predict`:

```json
{"id":"f28bfe428d84","grade":2,"label":"Sedang","confidence":0.81,"referable":true,"p_referable":0.93,"quality_ok":true}
```

---

## Tahap 3: ESP32-CAM

1. Arduino IDE → Board Manager → install **esp32 by Espressif**. Pilih board **AI Thinker ESP32-CAM**, partition **Huge APP**.
2. Library Manager → install **ArduinoJson** (versi 7).
3. Buka `esp32/esp32_cam_client/esp32_cam_client.ino`, isi `WIFI_SSID`, `WIFI_PASS`, dan `SERVER_URL` (IP server dari tahap 2).
4. Upload (pakai ESP32-CAM-MB atau FTDI; GPIO0 ke GND saat upload).
5. Buka Serial Monitor 115200. Tekan tombol di GPIO13 (ke GND) atau ketik `c`.

Hasil muncul di Serial Monitor, dan dashboard otomatis memperbarui dalam 4 detik.
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
