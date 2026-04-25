#include <ESP8266WiFi.h>
#include <Firebase_ESP_Client.h>

// Provide the token generation process info.
#include "addons/TokenHelper.h"
// Provide the RTDB payload printing info and other helper functions.
#include "addons/RTDBHelper.h"

/* ============================================================
   1. ওয়াইফাই (WiFi) ক্রেডেনশিয়ালস দিন
   ============================================================ */
#define WIFI_SSID "YOUR_WIFI_NAME"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

/* ============================================================
   2. ফায়ারবেস (Firebase) ক্রেডেনশিয়ালস
   ============================================================ */
#define API_KEY "AIzaSyBgqF29FrfApthkf7Zy-maOKuqyREenCwU"
#define DATABASE_URL "https://khamba-ache-current-nai-default-rtdb.asia-southeast1.firebasedatabase.app/"

/* ============================================================
   3. ডিভাইসের একটি ইউনিক আইডি দিন (ড্যাশবোর্ডে যেটা দিয়েছেন)
   ============================================================ */
#define DEVICE_ID "esp_mir_10"

// Firebase Data objects
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

// Timing
unsigned long sendDataPrevMillis = 0;
bool signupOK = false;
bool bootEventSent = false;

// Heartbeat প্রতি ১ মিনিটে পাঠাবে
const unsigned long HEARTBEAT_INTERVAL = 60000;
// WiFi Timeout
const unsigned long WIFI_TIMEOUT = 15000;

/* ============================================================
   কিভাবে Accurate ডাটা কাজ করে (Smart Boot Sequence):
   
   ESP বুট হলে:
   ১. Firebase থেকে পুরনো lastHeartbeat পড়ে (GET)
      → এটি ≈ কারেন্ট যাওয়ার সময় (±১ মিনিট accuracy)
   
   ২. নতুন lastBootTime সেট করে (Timestamp)
      → এটি = কারেন্ট আসার একদম সঠিক সময়
   
   ৩. Duration ক্যালকুলেট করে:
      → outage = bootTime - পুরনো lastHeartbeat
   
   ৪. Firebase-এ history তে সেভ করে:
      → {type, cutTime, restoredTime, durationMinutes}
   
   ৫. নতুন lastHeartbeat সেট করে (Timestamp)
   
   ফলাফল: ড্যাশবোর্ডে কারেন্ট যাওয়া-আসার
   সম্পূর্ণ হিস্ট্রি Date-Time সহ দেখা যাবে!
   ============================================================ */

void setup() {
  Serial.begin(115200);
  Serial.println();
  Serial.println("===== PowerPulse ESP8266 Monitor =====");
  Serial.print("Device ID: ");
  Serial.println(DEVICE_ID);

  // দ্রুত WiFi কানেক্ট
  WiFi.persistent(true);
  WiFi.setAutoConnect(true);
  WiFi.setAutoReconnect(true);
  WiFi.mode(WIFI_STA);

  connectWiFi();

  // Firebase কনফিগারেশন
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;

  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println("[OK] Firebase Auth successful.");
    signupOK = true;
  } else {
    Serial.printf("[ERROR] Auth Failed: %s\n", config.signer.signupError.message.c_str());
  }

  config.token_status_callback = tokenStatusCallback;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  Serial.println("[OK] Firebase initialized.");
  Serial.println();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WARN] WiFi lost! Reconnecting...");
    connectWiFi();
    return;
  }

  if (!signupOK || !Firebase.ready()) return;

  // ====== ধাপ ১: Smart Boot Event (একবারই) ======
  if (!bootEventSent) {
    handleSmartBoot();
    return;
  }

  // ====== ধাপ ২: প্রতি ১ মিনিটে Heartbeat ======
  if (millis() - sendDataPrevMillis >= HEARTBEAT_INTERVAL) {
    sendDataPrevMillis = millis();
    sendHeartbeat();
  }
}

// ===== WiFi কানেক্ট =====
void connectWiFi() {
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[WiFi] Connecting");

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_TIMEOUT) {
    Serial.print(".");
    delay(500);
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(" OK! IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println(" FAILED! Retrying...");
  }
}

// ===== Smart Boot: পুরো Outage ইভেন্ট ক্যালকুলেট ও সেভ =====
void handleSmartBoot() {
  String basePath = "/devices/" + String(DEVICE_ID);

  // ──────────────────────────────────────────────
  // ধাপ ১: পুরনো lastHeartbeat পড়ো (কারেন্ট যাওয়ার আনুমানিক সময়)
  // ──────────────────────────────────────────────
  double oldHeartbeat = 0;

  if (Firebase.RTDB.getDouble(&fbdo, (basePath + "/lastHeartbeat").c_str())) {
    oldHeartbeat = fbdo.to<double>();
    Serial.print("[BOOT] Old lastHeartbeat found: ");
    Serial.println(oldHeartbeat, 0);
  } else {
    Serial.println("[BOOT] No previous heartbeat (fresh device).");
  }

  // ──────────────────────────────────────────────
  // ধাপ ২: নতুন lastBootTime সেট করো (কারেন্ট আসার সঠিক সময়)
  // ──────────────────────────────────────────────
  double newBootTime = 0;

  if (Firebase.RTDB.setTimestamp(&fbdo, (basePath + "/lastBootTime").c_str())) {
    newBootTime = fbdo.to<double>();
    Serial.print("[BOOT] Power restored at: ");
    Serial.println(newBootTime, 0);
  } else {
    Serial.print("[ERROR] Failed to set bootTime: ");
    Serial.println(fbdo.errorReason());
    return; // পরের লুপে আবার চেষ্টা করবে
  }

  // ──────────────────────────────────────────────
  // ধাপ ৩: নতুন lastHeartbeat সেট করো
  // ──────────────────────────────────────────────
  if (!Firebase.RTDB.setTimestamp(&fbdo, (basePath + "/lastHeartbeat").c_str())) {
    Serial.print("[ERROR] Failed to set heartbeat: ");
    Serial.println(fbdo.errorReason());
    return;
  }

  // ──────────────────────────────────────────────
  // ধাপ ৩.৫: ESP এর IP Address Firebase-এ পাঠাও (ভেরিফিকেশনের জন্য)
  // ──────────────────────────────────────────────
  String localIP = WiFi.localIP().toString();
  Firebase.RTDB.setString(&fbdo, (basePath + "/deviceIP").c_str(), localIP.c_str());
  Serial.print("[BOOT] Device IP saved: ");
  Serial.println(localIP);

  // ──────────────────────────────────────────────
  // ধাপ ৪: Outage হিস্ট্রি ক্যালকুলেট ও সেভ করো
  // ──────────────────────────────────────────────
  if (oldHeartbeat > 0 && newBootTime > oldHeartbeat) {
    // Outage Duration ক্যালকুলেট
    double outageDurationMs = newBootTime - oldHeartbeat;
    int outageMins = (int)(outageDurationMs / 60000.0);

    Serial.print("[BOOT] Outage detected! Duration: ");
    Serial.print(outageMins);
    Serial.println(" minutes");

    // Firebase-এ হিস্ট্রি এন্ট্রি পুশ করো
    // push() একটি ইউনিক ID দিয়ে নতুন চাইল্ড তৈরি করে
    FirebaseJson historyEntry;
    historyEntry.set("type", "outage");
    historyEntry.set("cutTime", oldHeartbeat);       // কারেন্ট যাওয়ার সময় (±1 min)
    historyEntry.set("restoredTime", newBootTime);    // কারেন্ট আসার সময় (exact)
    historyEntry.set("durationMins", outageMins);     // কতক্ষণ ছিল না

    if (Firebase.RTDB.pushJSON(&fbdo, (basePath + "/history").c_str(), &historyEntry)) {
      Serial.println("[OK] Outage history saved to Firebase!");
    } else {
      Serial.print("[ERROR] Failed to save history: ");
      Serial.println(fbdo.errorReason());
    }
  } else {
    Serial.println("[BOOT] First boot or no previous data. No outage to record.");
  }

  bootEventSent = true;
  sendDataPrevMillis = millis();
  Serial.println("[OK] Boot sequence complete. Starting heartbeat loop...");
  Serial.println();
}

// ===== নিয়মিত Heartbeat =====
void sendHeartbeat() {
  String path = "/devices/" + String(DEVICE_ID) + "/lastHeartbeat";

  if (Firebase.RTDB.setTimestamp(&fbdo, path.c_str())) {
    Serial.print("[OK] Heartbeat: ");
    Serial.println(fbdo.to<double>(), 0);
  } else {
    Serial.print("[ERROR] ");
    Serial.println(fbdo.errorReason());
  }
}
