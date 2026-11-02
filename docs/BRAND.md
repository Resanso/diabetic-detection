# Retinova: Brand DNA & Design Guidelines

Dokumen ini menjadi acuan semua keputusan visual, interaksi, dan bahasa di aplikasi. Token di bagian 5 sampai 8
dipakai langsung oleh `web/src/styles/tokens.css`. Jika keduanya berbeda, perbarui keduanya bersamaan.

---

## 1. Inti merek

**Nama:** Retinova. Gabungan *retina* dan *nova* (baru, terang). Menyebut langsung apa yang diperiksa, dan cara
baru membawa skrining retina ke dekat pasien. Mudah diucapkan perawat maupun pasien dan tidak terikat satu bahasa.

**Kalimat posisi:** Skrining retina untuk penyandang diabetes, dikerjakan di dekat pasien dan dibaca oleh dokter.

**Masalah yang diselesaikan:** Retinopati diabetik bisa dicegah menjadi kebutaan jika terdeteksi dini, tetapi dokter
mata jauh dari kebanyakan pasien. Retinova memindahkan langkah memotret ke lapangan (posyandu, puskesmas keliling,
kunjungan rumah) dan langkah membaca ke dokter, dengan algoritma sebagai pembantu yang mengurutkan antrean.

### Pengguna

| Peran | Konteks nyata | Yang mereka butuhkan |
|---|---|---|
| **Perawat** | Di lapangan, sering di bawah matahari, sinyal naik-turun, satu tangan memegang lensa/kamera, pasien menunggu. | Alur yang tidak bisa salah langkah, tombol besar, umpan balik kualitas foto seketika, bisa melanjutkan pekerjaan yang terputus. |
| **Dokter** | Di puskesmas/RS, membaca banyak kasus sekaligus, di HP atau laptop. | Antrean yang sudah diurutkan berdasarkan risiko, foto besar yang bisa diperbesar, data klinis ringkas di samping foto, keputusan cepat dengan sedikit ketukan. |
| **Admin** | Pengelola program / IT puskesmas. | Mengelola akun, perangkat ESP32, dan memantau kinerja model. |

### Kepribadian

1. **Teliti.** Setiap angka punya satuan, setiap status punya arti yang sama di semua layar.
2. **Tenang.** Tidak ada warna alarm di luar hasil klinis. Pasien sering ikut melihat layar perawat.
3. **Membumi.** Bahasa Indonesia sehari-hari, bukan jargon teknologi. "Foto ulang", bukan "Retake capture".
4. **Jujur soal AI.** Algoritma ditampilkan sebagai *pendapat kedua* untuk dokter, lengkap dengan tingkat keyakinan.
   Keputusan klinis selalu milik dokter.

### Yang bukan Retinova

- Bukan dasbor futuristik. Tidak ada mode gelap neon, glow, gradien ungu, atau grafik dekoratif.
- Bukan aplikasi konsumen yang ceria. Tidak ada emoji, ilustrasi maskot, atau konfeti.
- Bukan alat diagnosis otomatis. Kata "diagnosis" hanya dipakai untuk keputusan dokter.

---

## 2. Prinsip desain

1. **Terbaca di bawah matahari.** Tema terang sebagai bawaan, kontras teks minimal 4,5:1 (target 7:1 untuk teks
   utama), ukuran teks isi 16 px. Informasi penting tidak boleh hanya bergantung pada warna.
2. **Ibu jari dulu.** Aksi utama setiap layar ada di zona bawah (bilah aksi menempel di bawah). Target sentuh minimal
   48 × 48 px, jarak antar target minimal 8 px.
3. **Retina adalah pusat.** Foto fundus tampil di atas latar gelap netral (konvensi pembacaan citra medis), tanpa
   bingkai dekoratif. Semua kontrol foto ada di luar area gambar.
4. **Warna adalah makna.** Warna derajat keparahan hanya muncul pada hasil klinis. Warna aksen (Kobalt) hanya untuk aksi
   dan elemen interaktif.
5. **Satu layar, satu tugas.** Alur pemeriksaan dibagi menjadi langkah yang jelas. Tidak ada tab tersembunyi di
   dalam tab.
6. **Tahan putus.** Setiap langkah tersimpan di server begitu selesai. Perawat yang kehilangan sinyal bisa melanjutkan
   dari draf.

---

## 3. Logo

**Tanda (mark):** sebuah lingkaran garis (bola mata / fundus) dengan satu titik padat yang bergeser ke kanan dari pusat
(diskus optikus, seperti yang terlihat di foto fundus mata kanan). Geometri sederhana, tetap terbaca pada 16 px.

```
  ╭─────╮
 │    ●  │     lingkaran: garis 2/24 dari diameter
 │       │     titik: diameter 6/24, pusat di (15, 12) pada kanvas 24
  ╰─────╯
```

**Wordmark:** "retinova" huruf kecil, IBM Plex Sans SemiBold, tracking −1%. Tanda selalu di kiri wordmark, jarak = lebar
titik.

**Aturan:** lingkaran = `--ink`, titik = `--accent`, tidak pernah warna keparahan. Ruang kosong minimal = tinggi huruf x
di semua sisi. Jangan diberi bayangan, gradien, atau diputar.

---

## 4. Suara & bahasa

| Lakukan | Hindari |
|---|---|
| "Foto belum layak: terlalu gelap. Dekatkan lensa lalu foto ulang." | "Error: kualitas gambar rendah" |
| "Menunggu dibaca dokter" | "Status: PENDING" |
| "Rujuk segera ke dokter mata" | "HIGH RISK!!!" |
| "Perkiraan AI: Sedang (78%)" | "AI mendiagnosis DR Sedang" |
| "Pasien baru" | "Tambah entitas pasien" |

- Kata kerja di tombol, maksimal 3 kata: **Mulai pemeriksaan**, **Ambil foto**, **Kirim ke dokter**, **Simpan bacaan**.
- Satu istilah untuk satu hal: *pemeriksaan* (bukan skrining/scan/sesi bergantian), *pasien*, *mata kanan / mata kiri*
  (OD/OS hanya di tampilan dokter sebagai keterangan kecil), *rujuk*.
- Angka memakai format Indonesia: `7,2 %`, `126 mg/dL`, `30 Okt 2026, 09.14`.
- Pesan galat menyebut apa yang terjadi dan apa yang harus dilakukan, dalam satu atau dua kalimat.
- Tanda pisah panjang tidak dipakai. Gunakan titik, koma, atau titik dua.
- Untuk perawat, istilah medis disertai bahasa awam. Untuk dokter, istilah medis boleh langsung.

---

## 5. Warna

Palet dihitung di OKLCH lalu dikonversi ke hex. Kontras di bawah diukur dari hex final (WCAG 2.x).

**Gagasan:** grafit + kobalt. Netral grafit hampir murni (tanpa semburat biru) membuat foto retina dan warna klinis
menjadi satu-satunya hal berwarna di layar. Kobalt dipilih karena biru adalah satu-satunya hue yang tidak bentrok
dengan skala keparahan (hijau, kuning, oranye, merah). Dengan begitu, "berwarna biru" selalu berarti "bisa diketuk".

**Yang dihindari:** latar slate kebiruan dan aksen periwinkle pastel di tema gelap (pola dasbor AI generik), gradien,
glow, dan warna aksen kedua.

**Pilihan tema:** bawaan **Terang** (terbaca di bawah matahari). Pengguna bisa memilih Gelap atau Ikuti sistem di menu
Akun. Pilihan disimpan per perangkat (`src/lib/theme.ts`), diterapkan lewat atribut `data-theme` sebelum render.

### Netral "Grafit"

| Token semantik | Terang | Gelap | Pemakaian |
|---|---|---|---|
| `--bg` | `#F5F6F8` | `#0E0E0F` | latar halaman |
| `--surface` | `#FFFFFF` | `#161719` | kartu, lembar, bilah |
| `--surface-2` | `#EEEFF2` | `#1F2022` | isian tenang, segmen |
| `--line` | `#DEE0E3` | `#2B2D2F` | pemisah |
| `--line-strong` | `#BBBEC3` | `#424448` | batas isian |
| `--ink` | `#171A1D` (16,2:1) | `#EFF0F2` (16,9:1) | teks utama |
| `--ink-2` | `#42454B` | `#C5C7CB` | teks sekunder |
| `--ink-3` | `#64686F` (5,2:1 di bg) | `#9C9EA3` (6,7:1 di surface) | keterangan |

### Aksen "Kobalt" (hue 266)

Isian dan teks aksen dipisah menjadi dua token agar keduanya lolos kontras di kedua tema.

| Token | Terang | Gelap | Pemakaian |
|---|---|---|---|
| `--accent` | `#2347C5` (putih 7,6:1) | `#3C67E8` (putih 4,9:1) | tombol utama, indikator aktif, fokus |
| `--accent-press` | `#1A38A6` | `#3259D1` | tombol utama saat ditekan |
| `--accent-soft` | `#E9F0FF` | `#1A2541` | latar pilihan aktif, info |
| `--accent-text` | `#2347C5` | `#96B6FE` (8,9:1 di surface) | tautan, tab aktif, chip "Menunggu dokter" |

Di tema gelap, tombol tetap kobalt pekat dengan teks putih. Versi terang kobalt hanya untuk teks.

### Derajat keparahan (khusus hasil klinis)

Selalu disertai label teks, tidak pernah warna saja.

| Derajat | Label | Terang teks / latar | Gelap teks / latar |
|---|---|---|---|
| 0 | Tidak ada DR | `#17663F` / `#E3F2E9` (6,0:1) | `#8CDD9E` / `#122D19` (9,2:1) |
| 1 | Ringan | `#7A5A00` / `#FAF0CC` (5,6:1) | `#E2C65B` / `#2E2605` (8,9:1) |
| 2 | Sedang | `#A3470B` / `#FCE8D6` (5,1:1) | `#FFB474` / `#38200A` (8,7:1) |
| 3 | Berat | `#A8231A` / `#FCE3DF` (5,9:1) | `#FFA99B` / `#3B1C18` (8,4:1) |
| 4 | Proliferatif | `#6E0F1E` / `#F5D8DD` (9,0:1) | `#FFA6B8` / `#3B1B22` (8,4:1) |

### Bahaya & status alur kerja

| Token | Terang | Gelap |
|---|---|---|
| `--danger` (teks galat) | `#A8231A` | `#FFA99B` |
| `--danger-soft` | `#FCE3DF` | `#3B1C18` |
| `--danger-solid` + putih | `#A8231A` (7,2:1) | `#C93029` (5,3:1) |

| Status | Gaya |
|---|---|
| Draf | `--surface-2`, teks `--ink-2` |
| Menunggu dokter | `--accent-soft`, teks `--accent-text` |
| Dibaca, tidak dirujuk | derajat 0 |
| Dibaca, perlu rujukan | derajat 3 |
| Rujuk segera | `--danger-solid`, teks putih. Satu-satunya status dengan latar pekat. |

### Penampil citra

Latar penampil foto retina selalu `#0B0B0C` (grafit, bukan biru tua), di tema terang maupun gelap.

---

## 6. Tipografi

- **IBM Plex Sans** (400, 500, 600) untuk semua teks. Dirancang untuk antarmuka teknis, angka jelas, dukungan
  diakritik lengkap, dan tetap rapi di layar kecil. Di-*host* sendiri (tanpa Google Fonts) agar tetap tampil saat
  sinyal lemah.
- **IBM Plex Mono** (500) hanya untuk ID pemeriksaan, nomor rekam medis, dan nilai teknis perangkat.
- Angka di tabel/metrik memakai `font-variant-numeric: tabular-nums`.

| Token | Ukuran / tinggi baris | Bobot | Pemakaian |
|---|---|---|---|
| `--t-display` | 28 / 34 | 600 | judul layar utama (Beranda) |
| `--t-title` | 22 / 28 | 600 | judul layar |
| `--t-heading` | 18 / 24 | 600 | judul bagian |
| `--t-body` | 16 / 24 | 400 | teks isi, isian (minimal 16 px agar iOS tidak memperbesar halaman) |
| `--t-label` | 14 / 20 | 500 | label isian, chip, tombol sekunder |
| `--t-caption` | 13 / 18 | 400 | keterangan, waktu |

Huruf kapital semua tidak dipakai, kecuali singkatan (DR, NIK, HbA1c).

---

## 7. Ruang, bentuk, kedalaman

- **Satuan dasar 4 px.** Skala: 4, 8, 12, 16, 20, 24, 32, 40, 56.
- **Tepi layar 16 px** di HP, 24 px di tablet. Lebar isi maksimal 720 px untuk formulir, 1200 px untuk layar dokter.
- **Sudut (aturan tetap):**
  - isian, tombol, segmen: **10 px**
  - kartu dan daftar berkelompok: **14 px**
  - lembar bawah (*bottom sheet*): **20 px** di sudut atas
  - chip status: **penuh (pil)**
  - foto retina: **lingkaran** jika sudah dipotong, atau 14 px
- **Kedalaman:** pemisahan dengan garis 1 px dan perbedaan latar, bukan bayangan. Bayangan hanya untuk elemen yang
  benar-benar melayang (lembar bawah, bilah aksi menempel, *toast*), diwarnai biru-abu: `0 8px 24px rgb(18 22 28 / .12)`.
- **Target sentuh:** tombol utama tinggi 52 px, tombol biasa 44 px dengan area sentuh 48 px.

---

## 8. Gerak

- Durasi: tekan 100 ms, perubahan status 160 ms, lembar/layar 240 ms. *Easing* `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Gerak hanya untuk umpan balik (tombol ditekan), perubahan status (foto terkirim, kualitas dinilai), dan transisi
  ruang (lembar naik dari bawah). Tidak ada animasi berulang selain indikator "menunggu ESP32" dan kerangka muat.
- `prefers-reduced-motion: reduce` mematikan semua transisi ruang; umpan balik warna tetap ada.

---

## 9. Ikon

- **Phosphor Icons**, bobot *regular* (garis 1,5), satu keluarga untuk seluruh aplikasi.
- Ukuran: 24 px di navigasi bawah, 20 px di tombol dan daftar, 16 px di chip.
- Ikon selalu didampingi label teks, kecuali tombol yang sudah sangat dikenal (tutup, kembali) dan wajib punya
  `aria-label`.

---

## 10. Pola komponen

| Komponen | Aturan |
|---|---|
| **Bilah atas** | judul layar rata kiri, tombol kembali di kiri, maksimal satu aksi di kanan. Menempel, latar `--surface`, garis bawah. |
| **Navigasi bawah** | 3 sampai 4 tujuan per peran, ikon + label, aktif = Kobalt. Menghormati *safe area* bawah. |
| **Bilah aksi bawah** | satu tombol utama selebar layar (+ maksimal satu tombol sekunder di kiri). Dipakai di semua formulir dan langkah. |
| **Isian** | label di atas, bantuan di bawah, galat di bawah dengan ikon. Tidak ada *placeholder* sebagai label. Satuan ditulis di dalam isian sebelah kanan. |
| **Pilihan tersegmen** | untuk 2 sampai 5 pilihan singkat (jenis kelamin, mata, derajat). Lebih dari itu: kartu radio. |
| **Kartu radio** | untuk keputusan dokter: judul + satu baris penjelasan, seluruh kartu bisa diketuk. |
| **Chip status** | pil, ikon 16 px + label. Warna sesuai tabel status. |
| **Baris daftar** | foto bulat 44 px (jika ada) + nama + satu baris meta + chip status di kanan. Seluruh baris bisa diketuk. |
| **Penampil retina** | latar `#0B0D10`, cubit untuk memperbesar, ketuk dua kali untuk 2×, tombol mode (Asli / Kontras / Peta atensi) di bawah gambar. |
| **Panel AI** | judul "Perkiraan AI", derajat + persentase keyakinan, bilah probabilitas rujukan dengan garis ambang, dan kalimat bantuan "Bandingkan dengan foto sebelum memutuskan." |
| **Keadaan kosong** | satu kalimat apa yang akan muncul di sini + satu tombol untuk memulainya. |
| **Keadaan memuat** | kerangka (*skeleton*) sesuai bentuk isi, bukan pemintal di tengah layar. |

---

## 11. Fotografi & citra

- Satu-satunya citra di aplikasi adalah foto fundus pasien. Tidak ada foto stok, ilustrasi orang, atau gambar
  dekoratif.
- Foto pasien tidak pernah tampil di layar daftar publik tanpa login. Thumbnail di daftar hanya untuk staf yang masuk.

---

## 12. Aksesibilitas (wajib)

- Kontras AA untuk semua teks dan ikon bermakna, termasuk di tema gelap.
- Status tidak pernah dibedakan hanya dengan warna: selalu ada label/ikon.
- Fokus papan ketik terlihat: cincin 2 px `--accent` dengan jarak 2 px.
- Isian punya `<label>` terhubung, `inputmode` yang sesuai (`numeric` untuk NIK, `decimal` untuk gula darah, `tel`
  untuk telepon).
- Zoom tidak pernah dimatikan.
