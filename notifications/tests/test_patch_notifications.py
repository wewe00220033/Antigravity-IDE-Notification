"""Python integration tests for patch_notifications CLI, backups, and extension installation."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import patch_notifications as pn  # noqa: E402

SAMPLE_EXT_V28 = (
    '/* RTL-PATCH-START */\n;(function(){globalThis.__rtlChatProxyUrl=u=>u;})();\n/* RTL-PATCH-END */\n'
    'const MAX_ATTEMPTS = 6;\n'
    'class Webview{renderWebviewHtml(a,b,c,d){if(globalThis.__rtlChatProxyUrl)c=globalThis.__rtlChatProxyUrl(c);var x=1;}}\n'
    'class Delegate{showWindowsNotification(a,b,c,d){var g=this.getLogoPath(),h={...process.env};delete h.ELECTRON_RUN_AS_NODE;'
    'h.AGY_NOTIFY_APP_ID="Microsoft.VisualStudioCode";h.AGY_NOTIFY_TITLE=`Antigravity \\u2014 ${a}`;'
    'h.AGY_NOTIFY_BODY=b||a;h.AGY_NOTIFY_URI=c;var cmd=\'if (-not $App) { $App = $Apps | Where-Object {$_.Name -like "*Visual Studio Code*"} | Select-Object -First 1 }; '
    '($RawXml.toast.visual.binding.text | Where-Object {$_.id -eq \\\'2\\\'}).AppendChild($RawXml.CreateTextNode($env:AGY_NOTIFY_BODY)) | Out-Null\';}'
    'async showBrowserNotification(a,b){var c=f.asyncContextStart(),d=c();c=c(1);try{if(a.payload){'
    'var{title:g,body:h,cascadeId:m,path:p}=a.payload;a=g||"Antigravity";var q=a==="Antigravity"&&h?h:Ar(a,h),'
    't=()=>{(b==null?0:b.isConversationVisible)||this.showOpenChatToast(q,m,p)},u;'
    '((u=n.window.state)==null?0:u.focused)?t():c(await d(this.showSystemNotification(a,h,m,p,t)))}}finally{d()}}}\n'
    'class Handler{async showBrowserNotification(a){var b=f.asyncContextStart(),c=b();b=b(1);try{'
    'let d=!0,u=!1,x=!0;if(n.window.state.focused&&d&&(x||u))return{};'
    'let B;b(await c((B=this.browserNotificationDelegate)==null?void 0:B.showBrowserNotification(a,{isConversationVisible:u})));'
    'return{}}finally{c()}}async showNotification(a){var b;return((b=this.browserNotificationDelegate)==null?0:b.showFocusingNotification)&&!n.window.state.focused}}'
)


class PatchNotificationsCliTests(unittest.TestCase):
    def test_apply_idempotency_and_version_locked_restore(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ide_dir = root / "Antigravity IDE"
            data_home = root / "data_home"
            vscode_dir = ide_dir / "resources" / "app" / "extensions" / "agy" / "vscode"
            vscode_dir.mkdir(parents=True)
            product_path = ide_dir / "resources" / "app" / "product.json"
            product_path.write_text(
                '{"ideVersion": "2.8.0", "win32AppUserModelId": "Google.AntigravityIDE"}',
                encoding="utf-8",
            )
            ext_path = vscode_dir / "extension.js"
            ext_path.write_text(SAMPLE_EXT_V28, encoding="utf-8")

            self.assertEqual(pn.apply_patch(ide_dir, custom_home=str(data_home)), 0)
            patched = ext_path.read_text(encoding="utf-8")
            self.assertIn("AGY-NOTIF-PATCH-START", patched)
            self.assertIn("globalThis.__agyNotifProxyUrl", patched)
            self.assertIn("RTL-PATCH-START", patched)
            self.assertTrue((data_home / "config.json").is_file())
            self.assertTrue((data_home / "state.json").is_file())

            # Version+hash backup created
            baks = list(vscode_dir.glob("extension.js.notif_v2.8.0_*.bak"))
            self.assertEqual(len(baks), 1)

            # Second apply is idempotent
            self.assertEqual(pn.apply_patch(ide_dir, custom_home=str(data_home)), 0)
            self.assertEqual(ext_path.read_text(encoding="utf-8"), patched)

            # Status exits 0
            self.assertEqual(pn.show_status(ide_dir, custom_home=str(data_home)), 0)

            # Simulating upgrade to 2.9.0 refuses restoring 2.8.0 backup!
            product_path.write_text(
                '{"ideVersion": "2.9.0", "win32AppUserModelId": "Google.AntigravityIDE"}',
                encoding="utf-8",
            )
            self.assertNotEqual(pn.restore_backup(ide_dir, custom_home=str(data_home)), 0)

            # Matching 2.8.0 restores exact original bytes
            product_path.write_text(
                '{"ideVersion": "2.8.0", "win32AppUserModelId": "Google.AntigravityIDE"}',
                encoding="utf-8",
            )
            self.assertEqual(pn.restore_backup(ide_dir, custom_home=str(data_home)), 0)
            self.assertEqual(ext_path.read_text(encoding="utf-8"), SAMPLE_EXT_V28)

    def test_install_persistent_extension_preserves_existing_entries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ext_root = Path(tmp) / "extensions"
            ext_root.mkdir(parents=True)
            ext_json = ext_root / "extensions.json"
            existing_rtl = {
                "identifier": {"id": "batalelo.antigravity-rtl-patcher"},
                "version": "2.5.1",
            }
            ext_json.write_text(json.dumps([existing_rtl]), encoding="utf-8")

            installed = pn.install_persistent_extension(ext_roots=[ext_root])
            self.assertEqual(len(installed), 1)
            dest = installed[0]
            self.assertTrue((dest / "package.json").is_file())
            self.assertTrue((dest / "extension.js").is_file())
            self.assertTrue((dest / "test_toast.ps1").is_file())
            self.assertTrue((dest / "core" / "proxy_runtime.js").is_file())
            self.assertTrue((dest / "config" / "default_config.json").is_file())

            entries = json.loads(ext_json.read_text(encoding="utf-8"))
            ids = [e["identifier"]["id"] for e in entries]
            self.assertEqual(ids, ["batalelo.antigravity-rtl-patcher", pn.EXTENSION_ID])

    def test_js_unit_and_integration_suite(self) -> None:
        runner, env = pn.resolve_node_runner()
        test_file = Path(__file__).with_name("js_tests.mjs")
        import subprocess

        proc = subprocess.run(
            [*runner, "--test", str(test_file)],
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
        self.assertEqual(proc.returncode, 0, msg=f"JS tests failed:\n{proc.stdout}\n{proc.stderr}")


if __name__ == "__main__":
    unittest.main()
