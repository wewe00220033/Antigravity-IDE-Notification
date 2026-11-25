# 🔔 إشعارات Antigravity IDE الاحترافية على ويندوز (`notifications v2.0`)

نظام ديناميكي مرن ومقاوم لتحديثات **Antigravity IDE (`2.6+` – `2.9+`)** و**`agy.exe` Hub (`2.34+`)** لإظهار إشعارات ويندوز الفورية (**Windows Toast**) بدون انقطاع — حتى وأنت داخل **نفس الشات النشط** — مع تنظيف كلمة `Agent finished:` وتكرار `Antigravity — Antigravity`، وإعادة التفعيل التلقائي بعد تحديثات البرنامج.

---

## 🎯 المشاكل التي يعالجها النظام

1. **اختفاء الإشعار والصوت داخل نفس الشات النشط (`agy.exe v2.34.0+`):**
   في الكود السحابي للواجهة (`/main.js`), دالة `isConversationInView` وخدمة `WebNotificationService` (`document.hasFocus()`) تمنعان الصوت والتنبيه عندما تكون في نفس المحادثة المفتوحة. يتم تجاوز هذا الحجب جراحياً وبأمان في طبقة البروكسي دون تزييف `document.hasFocus()` لبقية المحرر (لصق/نسخ/تركيز).
2. **قص اسم المحادثة العربي بـ `Agent finished:` وتكرار `Antigravity — Antigravity`:**
   يُنظف المنسّق البادئة ويُظهر **اسم المحادثة بوضوح** فقط في السطر الأول مع الحفاظ الكامل على وضوح إشعارات الأسئلة وطلبات الإذن (`askQuestion` / `runCommand`).
3. **مسح التعديل مع تحديثات IDE (`2.9.0+`) وتجاهل `silent`:**
   إضافة VS Code مستقلة في `%USERPROFILE%\.antigravity-ide\extensions\` تراقب ملفات البرنامج، وتعيد تطبيق الباتش تلقائياً مع فحص الـ Syntax وطلب `Reload Window` بزر واحد، مع احترام إشارة `silent` لمنع تكرار صوتين معاً.
4. **توافق 100% مع إضافة التعريب (`RTL`):**
   يتسلسل بروكسي الإشعارات (`__agyNotifProxyUrl`) بعد خطاف `__rtlChatProxyUrl` الخاص بـ `batalelo.antigravity-rtl-patcher` دون المساس بعلامات `RTL-PATCH-START/END`.

---

## 🏗️ البنية المعيارية

- `config/default_config.json`: المخطط المرقّم الافتراضي (`schemaVersion: 1`) لقوالب العرض، الصوت، نفس الشات، ومنع التكرار.
- `core/`:
  - `config_store.js`: تحميل/تحديث JSON الحي في `%USERPROFILE%\.antigravity-notifications\config.json` مع fallback تلقائي عند التلف.
  - `formatter.js`: تصنيف الأحداث عبر `id` (وليس `payload.type` المشترك)، تنظيف النصوص، حل سياسة الصوت (`soundMode`), ومنع التكرار خلال نافذة زمنية.
  - `main_js_rewriter.js`: إعادة كتابة `/main.js` عبر 3 مراسي فريدة + كاش بالـ `ETag` مع سقوط آمن (`pass-through`) إن تغيّرت البنية مستقبلاً.
  - `extension_patcher.js`: محرك باتش موحد لـ `extension.js` بمراسي غير معتمدة على أسماء مضغوطة ونسخ احتياطية مقيدة بالإصدار والـ `SHA-256`.
  - `proxy_runtime.js`: بروكسي HTTP/WebSocket متسلسل يقدّم الإعدادات حياً على `/__agy_notif_cfg.js`.
- `extension/`: إضافة VS Code الدائمة (`local-agy.antigravity-notification-enhancer`) بمؤشر في شريط الحالة وإعدادات في VS Code UI متزامنة مع `config.json`.
- `patch_notifications.py` & `*.bat`: مثبّت ومُشغّل سطر الأوامر (يستخدم Node المدمج في `Antigravity IDE.exe` دون الحاجة لتثبيت Node خارجي).
- `tests/`: اختبارات الوحدة والتكامل (`js_tests.mjs` + `test_patch_notifications.py`).

---

## 🚀 التثبيت والتشغيل السريع

1. شغّل **`apply_patch.bat`** (أو من التيرمنال: `python notifications/patch_notifications.py --apply --test`).
   - يثبت الإضافة الدائمة في `%USERPROFILE%\.antigravity-ide\extensions\`
   - ينسخ الـ Runtime والإعدادات إلى `%USERPROFILE%\.antigravity-notifications\`
   - يطبّق الباتش بعد فحص الـ Syntax والنسخ الاحتياطي المرتبط بالإصدار
   - يرسل إشعار Windows Toast تجريبي حي
2. داخل **Antigravity IDE** نفّذ `Ctrl + Shift + P` ⬅️ **`Developer: Reload Window`**.

---

## ⚙️ الإعدادات الحية (`config.json` أو Settings)

تتحدث الإعدادات **فوراً بدون إعادة تشغيل**:
- عبر Command Palette: `Antigravity Notifications: Open Config JSON`
- أو من **Settings** تحت قسم `Antigravity Notifications` (`antigravityNotifications.*`):
  - `notifySameActiveChat` (`true`): إظهار التنبيه داخل نفس الشات المفتوح.
  - `notifyWhenFocused` (`true`): إظهار التنبيه حتى مع التركيز على نافذة البرنامج.
  - `showOpenChatBannerInSameChat` (`false`): إخفاء بانر `Open Chat / Dismiss` الزائد داخل نفس الشات.
  - `soundMode` (`windows`): يشغّل صوت إشعار ويندوز الافتراضي دائماً لتفادي كتم الصوت في Webview (أو اختر `respectPayload` / `antigravity` / `both` / `silent`).
  - `dedupeWindowMs` (`2500`): منع تكرار نفس التنبيه خلال 2.5 ثانية.

---

## 🧪 الأوامر والاختبارات

```powershell
python notifications/patch_notifications.py --status
python notifications/patch_notifications.py --apply --test
python notifications/patch_notifications.py --restore
python -m unittest discover -s notifications/tests -v
```
