"""Unit tests for patch_notifications.py covering v2.6, v2.8, RTL preservation, and restore."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import patch_notifications as pn  # noqa: E402

SAMPLE_V26 = (
    '/* RTL-PATCH-START */\n;(function(){})();\n/* RTL-PATCH-END */\n'
    'class Delegate{showWindowsNotification(a,b,c,d){var g=this.getLogoPath(),h={...process.env};'
    'h.AGY_NOTIFY_APP_ID="Microsoft.VisualStudioCode";'
    'var cmd=\'if (-not $App) { $App = $Apps | Where-Object {$_.Name -like "*Visual Studio Code*"} | Select-Object -First 1 };\';}'
    'async showBrowserNotification(a,b){if(a.payload){var{title:g,body:h,cascadeId:m,path:p}=a.payload;'
    'var t=()=>{},r;((r=n.window.state)==null?0:r.focused)?t():this.showSystemNotification(a,h,m,p,t)}}}\n'
    'class Handler{async showBrowserNotification(a){let d=!0,t=!1,v=!0;if(n.window.state.focused&&d&&(v||t))return{};'
    'await this.browserNotificationDelegate.showBrowserNotification(a,{isConversationVisible:t})}}'
)

SAMPLE_V28 = (
    '/* RTL-PATCH-START */\n;(function(){globalThis.__rtlChatProxyUrl=u=>u;})();\n/* RTL-PATCH-END */\n'
    'class Delegate{showWindowsNotification(a,b,c,d){var g=this.getLogoPath(),h={...process.env};'
    'h.AGY_NOTIFY_APP_ID="Microsoft.VisualStudioCode";'
    'var cmd=\'if (-not $App) { $App = $Apps | Where-Object {$_.Name -like "*Visual Studio Code*"} | Select-Object -First 1 };\';}'
    'async showBrowserNotification(a,b){var c=f.asyncContextStart(),d=c();c=c(1);try{if(a.payload){'
    'var{title:g,body:h,cascadeId:m,path:p}=a.payload;var t=()=>{},u;'
    '((u=n.window.state)==null?0:u.focused)?t():c(await d(this.showSystemNotification(a,h,m,p,t)))}}finally{d()}}}\n'
    'class Handler{async showBrowserNotification(a){let d=!0,u=!1,x=!0;if(n.window.state.focused&&d&&(x||u))return{};'
    'await this.browserNotificationDelegate.showBrowserNotification(a,{isConversationVisible:u})}}'
)


class PatchNotificationsTests(unittest.TestCase):
    def test_patch_v26_and_idempotency(self) -> None:
        patched, changes = pn.patch_extension_source(SAMPLE_V26)
        self.assertEqual(len(changes), 4)
        status = pn.inspect_extension_status(patched)
        self.assertTrue(status["app_id_ok"])
        self.assertTrue(status["fallback_ok"])
        self.assertTrue(status["inner_focus_ok"])
        self.assertTrue(status["outer_focus_ok"])
        self.assertTrue(status["rtl_present"])

        patched2, changes2 = pn.patch_extension_source(patched)
        self.assertEqual(changes2, [])
        self.assertEqual(patched2, patched)

    def test_patch_v28_and_custom_app_id(self) -> None:
        patched, changes = pn.patch_extension_source(SAMPLE_V28, app_id="Google.AntigravityIDE")
        self.assertEqual(len(changes), 4)
        self.assertIn("globalThis.__rtlChatProxyUrl", patched)
        status = pn.inspect_extension_status(patched, expected_app_id="Google.AntigravityIDE")
        self.assertTrue(all(status[k] for k in ("app_id_ok", "fallback_ok", "inner_focus_ok", "outer_focus_ok", "rtl_present")))

        patched2, changes2 = pn.patch_extension_source(patched, app_id="Google.AntigravityIDE")
        self.assertEqual(changes2, [])
        self.assertEqual(patched2, patched)

    def test_apply_and_restore_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ide_dir = Path(tmp) / "Antigravity IDE"
            vscode_dir = ide_dir / "resources" / "app" / "extensions" / "agy" / "vscode"
            vscode_dir.mkdir(parents=True)
            (ide_dir / "resources" / "app" / "product.json").write_text(
                '{"ideVersion": "2.8.0", "win32AppUserModelId": "Google.AntigravityIDE"}',
                encoding="utf-8",
            )
            ext_path = vscode_dir / "extension.js"
            ext_path.write_text(SAMPLE_V28, encoding="utf-8")

            self.assertEqual(pn.apply_patch(ide_dir), 0)
            self.assertNotEqual(ext_path.read_text(encoding="utf-8"), SAMPLE_V28)
            self.assertTrue((vscode_dir / "extension.js.notif_bak").is_file())

            # Second apply is a no-op
            self.assertEqual(pn.apply_patch(ide_dir), 0)

            # Restore brings back exact original
            self.assertEqual(pn.restore_backup(ide_dir), 0)
            self.assertEqual(ext_path.read_text(encoding="utf-8"), SAMPLE_V28)


if __name__ == "__main__":
    unittest.main()
