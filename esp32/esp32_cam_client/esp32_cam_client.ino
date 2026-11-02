/*
 * ESP32-CAM (AI-Thinker) -> Server inferensi Diabetic Retinopathy
 *
 * Alur: tekan tombol (GPIO13 ke GND), ketik 'c' di Serial Monitor, atau klik
 *       "Ambil Foto" di dashboard (ESP32 menanyakan /api/device/poll tiap 1,5 detik)
 *       -> ambil foto JPEG -> POST ke /api/predict -> tampilkan hasil
 *
 * Live view: selama dashboard menonton (poll membalas live=true), ESP32 mengirim
 *       frame kecil terus-menerus ke /api/device/frame, yang balasannya sama dengan poll.
 *
 * Library: ArduinoJson v7 (Library Manager). Board: "AI Thinker ESP32-CAM".
 * Partition scheme: "Huge APP (3MB No OTA)".
 */
#include "esp_camera.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

#include "secrets.h"   // salin secrets.example.h -> secrets.h lalu isi (tidak ikut di-commit)

const char* WIFI_SSID   = SECRET_WIFI_SSID;
const char* WIFI_PASS   = SECRET_WIFI_PASS;
const char* SERVER_URL  = SECRET_SERVER_URL;
const char* API_KEY     = SECRET_API_KEY;   // isi jika server memakai env API_KEY
const char* DEVICE_ID   = "esp32-cam-01";

#define POLL_INTERVAL_MS 1500   // jeda menanyakan perintah foto ke server
#define LIVE_JPEG_QUALITY 14    // kompresi frame live (lebih kasar = lebih lancar)

#define BUTTON_PIN   13   // tombol ke GND
#define LED_PIN      33   // LED merah onboard (aktif LOW)
#define FLASH_PIN     4   // LED flash; JANGAN diarahkan langsung ke mata
#define FLASH_CHANNEL 7   // kanal LEDC untuk PWM flash; kanal 0 dipakai XCLK kamera

// Pengaturan dari dashboard (/api/device/poll). Nilai awal = default server.
int    settingsVersion = 0;
String flashMode       = "capture";   // off | capture | on
int    flashIntensity  = 128;         // 0-255
framesize_t captureFs  = FRAMESIZE_SVGA;   // resolusi foto untuk analisis
int    captureQuality  = 10;
framesize_t liveFs     = FRAMESIZE_QVGA;   // resolusi live view
bool   liveMode        = false;

// Pin kamera AI-Thinker
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

void blink(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, LOW);  delay(ms);
    digitalWrite(LED_PIN, HIGH); delay(ms);
  }
}

bool initCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM; c.pin_d1 = Y3_GPIO_NUM; c.pin_d2 = Y4_GPIO_NUM; c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM; c.pin_d5 = Y7_GPIO_NUM; c.pin_d6 = Y8_GPIO_NUM; c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM; c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM; c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM; c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM; c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.grab_mode = CAMERA_GRAB_LATEST;

  if (psramFound()) {
    // Init di UXGA agar buffer cukup untuk resolusi apa pun dari dashboard,
    // lalu turunkan ke SVGA (800x600) sebagai default di bawah.
    c.frame_size = FRAMESIZE_UXGA;
    c.jpeg_quality = 10;             // 0-63, makin kecil makin bagus
    c.fb_count = 2;
    c.fb_location = CAMERA_FB_IN_PSRAM;
  } else {
    c.frame_size = FRAMESIZE_VGA;
    c.jpeg_quality = 12;
    c.fb_count = 1;
    c.fb_location = CAMERA_FB_IN_DRAM;
  }

  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    Serial.printf("Kamera gagal init: 0x%x\n", err);
    return false;
  }
  sensor_t* s = esp_camera_sensor_get();
  captureFs = psramFound() ? FRAMESIZE_SVGA : FRAMESIZE_VGA;
  s->set_framesize(s, captureFs);
  return true;
}

void setFlash(int duty) {
  ledcWrite(FLASH_PIN, constrain(duty, 0, 255));
}

framesize_t parseFramesize(const char* name) {
  if (!strcmp(name, "VGA"))  return FRAMESIZE_VGA;
  if (!strcmp(name, "XGA"))  return FRAMESIZE_XGA;
  if (!strcmp(name, "HD"))   return FRAMESIZE_HD;
  if (!strcmp(name, "SXGA")) return FRAMESIZE_SXGA;
  if (!strcmp(name, "UXGA")) return FRAMESIZE_UXGA;
  return FRAMESIZE_SVGA;
}

framesize_t parseLiveFramesize(const char* name) {
  if (!strcmp(name, "VGA"))  return FRAMESIZE_VGA;
  if (!strcmp(name, "HVGA")) return FRAMESIZE_HVGA;
  return FRAMESIZE_QVGA;
}

// Pasang resolusi & kompresi sesuai mode (live: kecil dan cepat, foto: sesuai pengaturan).
void useCameraMode(bool live) {
  sensor_t* s = esp_camera_sensor_get();
  s->set_framesize(s, live ? liveFs : captureFs);
  s->set_quality(s, live ? LIVE_JPEG_QUALITY : captureQuality);
}

void setLiveMode(bool on) {
  if (on == liveMode) return;
  liveMode = on;
  useCameraMode(on);
  Serial.println(on ? "Live view dimulai" : "Live view berhenti");
}

// Terapkan pengaturan kamera & flash dari server (dipanggil saat versinya berubah).
void applySettings(JsonObject cfg) {
  sensor_t* s = esp_camera_sensor_get();
  captureFs = parseFramesize(cfg["resolution"] | "SVGA");
  if (!psramFound() && captureFs > FRAMESIZE_VGA) captureFs = FRAMESIZE_VGA;   // tanpa PSRAM buffer tidak cukup
  captureQuality = cfg["jpeg_quality"] | 10;
  liveFs = parseLiveFramesize(cfg["live_resolution"] | "QVGA");
  useCameraMode(liveMode);
  s->set_brightness(s, cfg["brightness"] | 0);
  s->set_contrast(s, cfg["contrast"] | 0);
  s->set_saturation(s, cfg["saturation"] | 0);
  s->set_ae_level(s, cfg["ae_level"] | 0);
  s->set_whitebal(s, cfg["awb"] | true);
  s->set_hmirror(s, cfg["hmirror"] | false);
  s->set_vflip(s, cfg["vflip"] | false);

  flashMode = String(cfg["flash_mode"] | "capture");
  flashIntensity = cfg["flash_intensity"] | 128;
  setFlash(flashMode == "on" ? flashIntensity : 0);

  settingsVersion = cfg["version"] | 0;
  Serial.printf("Pengaturan v%d diterapkan: %s q=%d flash=%s(%d)\n", settingsVersion,
                (const char*)(cfg["resolution"] | "SVGA"), (int)(cfg["jpeg_quality"] | 10),
                flashMode.c_str(), flashIntensity);
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Menghubungkan WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\nTerhubung. IP ESP32: %s\n", WiFi.localIP().toString().c_str());
}

void captureAndSend() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();

  // Mode "capture": nyalakan flash lalu beri waktu eksposur otomatis menyesuaikan
  bool flashForShot = flashMode == "capture" && flashIntensity > 0;
  if (flashForShot) {
    setFlash(flashIntensity);
    delay(150);
  }

  // Saat live, kamera sedang di resolusi kecil: pindah ke resolusi foto dulu
  if (liveMode) useCameraMode(false);

  // Buang frame lama (diambil sebelum flash/perubahan setelan) agar yang dikirim foto terbaru
  camera_fb_t* fb;
  for (int i = 0; i < (flashForShot || liveMode ? 3 : 1); i++) {
    fb = esp_camera_fb_get();
    if (fb) esp_camera_fb_return(fb);
  }

  digitalWrite(LED_PIN, LOW);
  fb = esp_camera_fb_get();
  if (flashForShot) setFlash(0);
  if (liveMode) useCameraMode(true);
  if (!fb) {
    Serial.println("Gagal mengambil foto");
    digitalWrite(LED_PIN, HIGH);
    blink(5, 80);
    return;
  }
  Serial.printf("Foto %u byte, mengirim ke server...\n", fb->len);

  HTTPClient http;
  http.begin(SERVER_URL);
  http.setTimeout(20000);
  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("X-Device-Id", DEVICE_ID);
  if (strlen(API_KEY) > 0) http.addHeader("X-API-Key", API_KEY);

  int code = http.POST(fb->buf, fb->len);
  esp_camera_fb_return(fb);
  digitalWrite(LED_PIN, HIGH);

  if (code != 200) {
    Serial.printf("HTTP error %d: %s\n", code, code > 0 ? http.getString().c_str() : http.errorToString(code).c_str());
    http.end();
    blink(5, 80);
    return;
  }

  JsonDocument doc;
  DeserializationError e = deserializeJson(doc, http.getString());
  http.end();
  if (e) {
    Serial.printf("JSON tidak valid: %s\n", e.c_str());
    return;
  }

  int grade         = doc["grade"];
  const char* label = doc["label"];
  float conf        = doc["confidence"];
  bool referable    = doc["referable"];
  bool qualityOk    = doc["quality_ok"];

  Serial.println("===== HASIL =====");
  Serial.printf("Grade      : %d (%s)\n", grade, label);
  Serial.printf("Keyakinan  : %.1f%%\n", conf * 100);
  Serial.printf("Rujukan    : %s\n", referable ? "PERLU dirujuk ke dokter mata" : "tidak perlu");
  if (!qualityOk) Serial.println("Peringatan : kualitas gambar kurang, ulangi pengambilan");
  Serial.println("=================");

  // Umpan balik LED: 1 kedip = normal, 3 kedip = perlu rujukan
  blink(referable ? 3 : 1, 300);
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH);
  ledcAttachChannel(FLASH_PIN, 5000, 8, FLASH_CHANNEL);
  setFlash(0);

  if (!initCamera()) {
    while (true) blink(1, 100);
  }
  connectWiFi();
  Serial.println("Siap. Tekan tombol, ketik 'c' di Serial Monitor, atau klik Ambil Foto di dashboard.");
}

// URL lain diturunkan dari SERVER_URL: .../api/predict -> .../api/device/poll, /api/device/frame
String deviceUrl(const char* path) {
  String url = SERVER_URL;
  url.replace("/api/predict", path);
  return url;
}

// Balasan poll/frame: {capture, live, settings}. Mengembalikan true jika diminta memotret.
bool handleDeviceReply(const String& body) {
  JsonDocument doc;
  if (deserializeJson(doc, body)) return false;
  JsonObject cfg = doc["settings"];
  if (!cfg.isNull() && (int)(cfg["version"] | 0) != settingsVersion) applySettings(cfg);
  setLiveMode(doc["live"] | false);
  return doc["capture"] | false;
}

// Satu HTTPClient dengan keep-alive untuk frame live agar tidak membuka koneksi baru tiap frame
HTTPClient liveHttp;

// Kirim satu frame live ke server. Balasannya sama dengan poll.
bool sendLiveFrame() {
  if (WiFi.status() != WL_CONNECTED) { setLiveMode(false); return false; }
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) return false;
  liveHttp.setReuse(true);
  liveHttp.begin(deviceUrl("/api/device/frame"));
  liveHttp.setTimeout(5000);
  liveHttp.addHeader("Content-Type", "image/jpeg");
  liveHttp.addHeader("X-Device-Id", DEVICE_ID);
  if (strlen(API_KEY) > 0) liveHttp.addHeader("X-API-Key", API_KEY);
  liveHttp.addHeader("X-Settings-Version", String(settingsVersion));
  int code = liveHttp.POST(fb->buf, fb->len);
  esp_camera_fb_return(fb);
  bool capture = false;
  if (code == 200) {
    capture = handleDeviceReply(liveHttp.getString());
  } else {
    Serial.printf("Frame live gagal: %d\n", code);
    setLiveMode(false);   // kembali ke polling; poll berikutnya akan menyalakan lagi jika masih ditonton
  }
  liveHttp.end();
  return capture;
}

// Tanya server apakah dashboard meminta foto, sekaligus menandai perangkat online
// dan mengambil pengaturan kamera terbaru.
bool captureRequested() {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  http.begin(deviceUrl("/api/device/poll"));
  http.setTimeout(3000);
  http.addHeader("X-Device-Id", DEVICE_ID);
  if (strlen(API_KEY) > 0) http.addHeader("X-API-Key", API_KEY);
  http.addHeader("X-Settings-Version", String(settingsVersion));
  int code = http.GET();
  bool capture = code == 200 && handleDeviceReply(http.getString());
  http.end();
  return capture;
}

void loop() {
  static unsigned long lastPress = 0;
  static unsigned long lastPoll = 0;
  bool pressed = digitalRead(BUTTON_PIN) == LOW && millis() - lastPress > 1000;
  bool serialCmd = Serial.available() && Serial.read() == 'c';
  bool webCmd = false;
  if (liveMode) {
    webCmd = sendLiveFrame();   // secepat koneksi mengizinkan
    lastPoll = millis();
  } else if (millis() - lastPoll > POLL_INTERVAL_MS) {
    lastPoll = millis();
    webCmd = captureRequested();
  }
  if (webCmd) Serial.println("Perintah foto dari dashboard");
  if (pressed || serialCmd || webCmd) {
    lastPress = millis();
    captureAndSend();
  }
  delay(20);
}
