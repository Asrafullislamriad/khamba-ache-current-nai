#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>         // WiFiManager by tzapu (Install from Library Manager)
#include <Firebase_ESP_Client.h>
#include <EEPROM.h>

// Provide the token generation process info.
#include "addons/TokenHelper.h"
// Provide the RTDB payload printing info and other helper functions.
#include "addons/RTDBHelper.h"

/* ============================================================
   ফায়ারবেস (Firebase) ক্রেডেনশিয়ালস
   ============================================================ */
#define API_KEY "AIzaSyBgqF29FrfApthkf7Zy-maOKuqyREenCwU"
#define DATABASE_URL "https://khamba-ache-current-nai-default-rtdb.asia-southeast1.firebasedatabase.app/"

/* ============================================================
   ডিভাইস আইডি — ESP Chip ID থেকে Auto-Generate হবে
   যেমন: PP_8A3F2C (প্রতিটি ESP এর জন্য ইউনিক)
   ============================================================ */
String DEVICE_ID = "";

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

/* ============================================================
   WiFiManager কিভাবে কাজ করে:

   ১. ESP বুট হয় → আগের সেভ করা WiFi তে কানেক্ট করার চেষ্টা করে
   ২. যদি WiFi না পায় → "PowerPulse-Setup" নামে Hotspot তৈরি করে
   ৩. User মোবাইল/PC দিয়ে ওই Hotspot এ কানেক্ট করে
   ৪. একটি Captive Portal খোলে — সেখানে WiFi Name ও Password দেয়
   ৫. ESP সেভ করে, রিবুট হয়ে WiFi তে কানেক্ট হয়
   ৬. পরের বার থেকে সরাসরি কানেক্ট হয় (আবার portal আসবে না)

   Device ID:
   ESP8266 এর Chip ID থেকে auto-generate হয়
   যেমন: PP_8A3F2C — প্রতিটি চিপের জন্য ইউনিক
   ============================================================ */

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

  // ──────────────────────────────────────────────
  // Auto-generate Device ID from ESP Chip ID
  // ──────────────────────────────────────────────
  uint32_t chipId = ESP.getChipId();
  char idBuf[16];
  snprintf(idBuf, sizeof(idBuf), "PP_%06X", chipId);
  DEVICE_ID = String(idBuf);

  Serial.print("Device ID: ");
  Serial.println(DEVICE_ID);

  // ──────────────────────────────────────────────
  // WiFiManager Setup
  // ──────────────────────────────────────────────
  WiFiManager wm;

  // WiFiManager timeout — ৩ মিনিট পর portal বন্ধ হবে এবং ESP রিবুট হবে
  wm.setConfigPortalTimeout(180);

  // Custom HTML: Device ID দেখানোর জন্য (Copy button সহ)
  // এই HTML WiFiManager portal এর উপরে দেখাবে
  String customHtml = "<br/>"
    "<div style='text-align:center;background:#1a1a2e;padding:15px;border-radius:10px;margin-bottom:15px;'>"
      "<p style='color:#94a3b8;margin:0 0 8px 0;font-size:14px;'>📋 আপনার Device ID</p>"
      "<div style='display:flex;align-items:center;justify-content:center;gap:8px;'>"
        "<input type='text' value='" + DEVICE_ID + "' id='devId' readonly "
          "style='background:#0b0d17;color:#fde68a;border:1px solid #3b82f6;border-radius:8px;"
          "padding:10px 15px;font-family:monospace;font-size:18px;font-weight:bold;text-align:center;"
          "width:180px;'/>"
        "<button onclick=\"var i=document.getElementById('devId');i.select();i.setSelectionRange(0,99);"
          "document.execCommand('copy');this.innerText='✅';setTimeout(function(){document.querySelector('#cpBtn').innerText='📋 Copy';},2000);\" "
          "id='cpBtn' style='background:#3b82f6;color:white;border:none;border-radius:8px;"
          "padding:10px 15px;cursor:pointer;font-size:14px;white-space:nowrap;'>📋 Copy</button>"
      "</div>"
      "<p style='color:#f59e0b;margin:8px 0 0 0;font-size:12px;'>⚠️ এই ID টি কপি করে রাখুন! Dashboard এ লাগবে।</p>"
    "</div>";

  // WiFiManager portal এ custom HTML যোগ করো
  WiFiManagerParameter customDeviceIdDisplay(customHtml.c_str());
  wm.addParameter(&customDeviceIdDisplay);

  // AP (Hotspot) Name ও Password
  // Password ছাড়া open hotspot — সবাই কানেক্ট করতে পারবে
  Serial.println("[WiFi] Starting WiFiManager...");
  Serial.println("[WiFi] If no saved WiFi found, connect to: PowerPulse-Setup");

  // autoConnect: আগে সেভ করা WiFi তে কানেক্ট করার চেষ্টা করবে
  // না পারলে "PowerPulse-Setup" নামে AP তৈরি করবে
  if (!wm.autoConnect("PowerPulse-Setup")) {
    Serial.println("[WiFi] Failed to connect or timeout! Restarting...");
    delay(3000);
    ESP.restart();
  }

  // WiFi কানেক্ট হয়ে গেছে!
  Serial.print("[WiFi] Connected! IP: ");
  Serial.println(WiFi.localIP());

  // ──────────────────────────────────────────────
  // Firebase কনফিগারেশন
  // ──────────────────────────────────────────────
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
    Serial.println("[WARN] WiFi lost! Restarting to reconnect...");
    delay(3000);
    ESP.restart(); // WiFiManager আবার চালু হবে
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

// ===== Smart Boot: পুরো Outage ইভেন্ট ক্যালকুলেট ও সেভ =====
void handleSmartBoot() {
  String basePath = "/devices/" + DEVICE_ID;

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
    // setTimestamp এর পর সরাসরি to<double>() কাজ নাও করতে পারে,
    // তাই আলাদাভাবে GET করে ভ্যালু পড়ো
    if (Firebase.RTDB.getDouble(&fbdo, (basePath + "/lastBootTime").c_str())) {
      newBootTime = fbdo.to<double>();
    }
    Serial.print("[BOOT] Power restored at: ");
    Serial.println(newBootTime, 0);
  } else {
    Serial.print("[ERROR] Failed to set bootTime: ");
    Serial.println(fbdo.errorReason());
    return;
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
  // ধাপ ৩.৫: IP Address Firebase-এ পাঠাও (Fake data ধরতে কাজে লাগবে)
  // ──────────────────────────────────────────────
  // Local IP (রাউটারের ভেতরের ঠিকানা)
  String localIP = WiFi.localIP().toString();
  Firebase.RTDB.setString(&fbdo, (basePath + "/localIP").c_str(), localIP.c_str());
  Serial.print("[BOOT] Local IP: ");
  Serial.println(localIP);

  // Public IP (ISP এর দেওয়া ঠিকানা — এটি দিয়ে শহর জানা যায়)
  String publicIP = getPublicIP();
  if (publicIP.length() > 0) {
    Firebase.RTDB.setString(&fbdo, (basePath + "/publicIP").c_str(), publicIP.c_str());
    Serial.print("[BOOT] Public IP: ");
    Serial.println(publicIP);
  } else {
    Serial.println("[WARN] Could not get public IP");
  }

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
  String path = "/devices/" + DEVICE_ID + "/lastHeartbeat";

  if (Firebase.RTDB.setTimestamp(&fbdo, path.c_str())) {
    Serial.print("[OK] Heartbeat: ");
    Serial.println(fbdo.to<double>(), 0);
  } else {
    Serial.print("[ERROR] ");
    Serial.println(fbdo.errorReason());
  }
}

// ===== Public IP বের করো (Fake data detection এর জন্য) =====
String getPublicIP() {
  WiFiClient client;
  HTTPClient http;
  String ip = "";

  http.begin(client, "http://api.ipify.org/");
  int httpCode = http.GET();

  if (httpCode == HTTP_CODE_OK) {
    ip = http.getString();
    ip.trim();
  }

  http.end();
  return ip;
}
