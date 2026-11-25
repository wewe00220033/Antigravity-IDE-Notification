# 🔔 إشعارات Antigravity IDE على ويندوز (`notifications`)

أداة تلقائية لإصلاح وتفعيل إشعارات ويندوز المنبثقة (**Windows Toast Notifications**) في **Antigravity IDE** (الإصدارات `2.6.x` و `2.7.x` و `2.8.x` وما بعدها)، بحيث ترجع الإشعارات تشتغل فوراً حتى بعد أي تحديث جديد للبرنامج، وحتى أثناء وجودك وتركيزك داخل نافذة الـ IDE.

---

## 🎯 المشكلة اللي الأداة بتحلها
بعد تحديث Antigravity IDE (من `2.5.5` إلى `2.6.0` ثم `2.8.0`)، ملفات `resources/app/` بتتبدل بالكامل، وفي النسخ الجديدة بيكون فيه 3 عوائق في ملف `extensions/agy/vscode/extension.js`:
1. **معرّف تطبيق خاطئ (`AGY_NOTIFY_APP_ID`):** الكود بيبعت `"Microsoft.VisualStudioCode"` ويدور على `*Visual Studio Code*`، بينما معرف التطبيق المسجل في ويندوز هو `Google.AntigravityIDE` (`Antigravity IDE`)، فـ PowerShell بيخرج بصمت بـ `exit 1`.
2. **حجب الإشعار وقت التركيز (Outer Guard):** الدالة `showBrowserNotification` بترجع `{}` لو نافذة الـ IDE مفتوحة ومُركز عليها (`n.window.state.focused`).
3. **حجب إضافي جوه `VscodeNotificationDelegate` (Inner Guard):** بيلغي استدعاء `showSystemNotification` لو `window.state.focused` شغال.

---

## 🚀 التشغيل السريع (على أي جهاز ويندوز في ثواني)

1. افتح مجلد `notifications` وشغّل دبل كليك على:
   - **`apply_patch.bat`**
   *(بيكتشف مسار `Antigravity IDE` تلقائياً، يقرأ الـ `win32AppUserModelId` من `product.json`، ياخد نسخة احتياطية آمنة، يطبق الباتش، يفحص سلامة صياغة JavaScript، وبعدها يبعتلك إشعار تجريبي حي على ويندوز).*
2. جوه **Antigravity IDE** اضغط `Ctrl + Shift + P` واكتب:
   ```text
   Developer: Reload Window
   ```
   واضغط `Enter`.
3. تأكد مرة واحدة من `Ctrl + Shift + P` ⬅️ `Antigravity: Open Settings` ⬅️ **`Notifications`** إن:
   - ✅ `Enable Notifications for Agent` مفعّل.
   - ✅ `Enable Sounds for Agent` مفعّل.

---

## 📂 محتويات المجلد

- `patch_notifications.py`: الباتشر الشامل (Idempotent & Multi-Version + Syntax Check + Auto Rollback).
- `test_toast.ps1`: اختبار مستقل لإرسال إشعار WinRT Toast والتحقق من تسجيل `Google.AntigravityIDE`.
- `apply_patch.bat`: تشغيل الباتش + الاختبار الحي بضغطة واحدة.
- `check_status.bat`: فحص حالة الباتش على الجهاز الحالي.
- `test_toast.bat`: اختبار إشعار ويندوز مباشرة.
- `restore_backup.bat`: استرجاع النسخة الأصلية من `extension.js` عند الحاجة.
- `_run.bat`: مشغّل بايثون مشترك لكل ملفات `.bat`.
- `tests/test_patch_notifications.py`: اختبارات وحدة تغطي `v2.6` و `v2.8` والحفاظ على باتش الـ RTL العربي.

---

## 🛠️ أوامر CLI المتقدمة

```powershell
python notifications/patch_notifications.py --status
python notifications/patch_notifications.py --apply --test
python notifications/patch_notifications.py --restore
```

> ملاحظة: متوافق 100% مع إضافة التعريب `batalelo.antigravity-rtl-patcher` ولا يؤثر على ملفات `product.json` checksums.
