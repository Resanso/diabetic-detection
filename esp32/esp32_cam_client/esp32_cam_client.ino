/*
 * ESP32-CAM (AI-Thinker) -> Server inferensi Diabetic Retinopathy
 *
 * Alur: tekan tombol (GPIO13 ke GND) atau ketik 'c' di Serial Monitor
 *       -> ambil foto JPEG -> POST ke /api/predict -> tampilkan hasil
 *
 * Library: ArduinoJson v7 (Library Manager). Board: "AI Thinker ESP32-CAM".
 * Partition scheme: "Huge APP (3MB No OTA)".
 */
#include "esp_camera.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ====== GANTI SESUAI JARINGAN ANDA ======
const char* WIFI_SSID   = "NAMA_WIFI";
const char* WIFI_PASS   = "PASSWORD_WIFI";
const char* SERVER_URL  = "http://192.168.1.10:8000/api/predict";  // IP laptop/RPi yang menjalankan uvicorn
const char* API_KEY     = "";            // isi jika server memakai env API_KEY
const char* DEVICE_ID   = "esp32-cam-01";
// ========================================

#define BUTTON_PIN   13   // tombol ke GND
#define LED_PIN      33   // LED merah onboard (aktif LOW)
#define FLASH_PIN     4   // LED flash; JANGAN diarahkan langsung ke mata

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
    c.frame_size = FRAMESIZE_SVGA;   // 800x600: cukup untuk model 320px, upload tetap cepat
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
  return true;
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

  // Buang 1 frame lama agar yang dikirim benar-benar foto terbaru
  camera_fb_t* fb = esp_camera_fb_get();
  if (fb) esp_camera_fb_return(fb);

  digitalWrite(LED_PIN, LOW);
  fb = esp_camera_fb_get();
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
  pinMode(FLASH_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH);
  digitalWrite(FLASH_PIN, LOW);

  if (!initCamera()) {
    while (true) blink(1, 100);
  }
  connectWiFi();
  Serial.println("Siap. Tekan tombol atau ketik 'c' di Serial Monitor.");
}

void loop() {
  static unsigned long lastPress = 0;
  bool pressed = digitalRead(BUTTON_PIN) == LOW && millis() - lastPress > 1000;
  bool serialCmd = Serial.available() && Serial.read() == 'c';
  if (pressed || serialCmd) {
    lastPress = millis();
    captureAndSend();
  }
  delay(20);
}
