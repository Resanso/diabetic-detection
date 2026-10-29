// Salin file ini menjadi secrets.h, lalu isi sesuai jaringan Anda.
#pragma once
#define SECRET_WIFI_SSID  "NAMA_WIFI"
#define SECRET_WIFI_PASS  "PASSWORD_WIFI"
// IP laptop/RPi yang menjalankan uvicorn (cek: ipconfig getifaddr en0 / hostname -I)
#define SECRET_SERVER_URL "http://192.168.1.10:8001/api/predict"
#define SECRET_API_KEY    ""
