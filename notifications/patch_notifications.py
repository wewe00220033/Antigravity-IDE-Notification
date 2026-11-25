"""Universal, idempotent Windows notification patcher for Antigravity IDE (v2.6 - v2.8+)."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

APP_ID_RE = re.compile(
    r'([A-Za-z_$][\w$]*\.AGY_NOTIFY_APP_ID\s*=\s*)"([^"]+)"'
)
FALLBACK_ORIG_RE = re.compile(
    r'(\$App\s*=\s*\$Apps\s*\|\s*Where-Object\s*\{\$_\.Name\s*-like\s*"\*Visual Studio Code\*"\})'
    r'(\s*\|\s*Select-Object\s*-First\s*1)'
)
FALLBACK_PATCHED_CHECK = '-or $_.Name -like "*Antigravity*"'

INNER_FOCUS_ORIG_RE = re.compile(
    r'\(\(([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*\.window\.state)\)==null\?0:\1\.focused\)'
    r'(\?[A-Za-z_$][\w$]*\(\):(?:[A-Za-z_$][\w$]*\(await\s+[A-Za-z_$][\w$]*\()?(?:this\.showSystemNotification))'
)
INNER_FOCUS_PATCHED_RE = re.compile(
    r'(?:!1\?[A-Za-z_$][\w$]*\(\):|try\{if\(a\.payload\)\{[\s\S]{0,260}?var\s+[A-Za-z_$][\w$]*=[^;]+;)'
    r'(?:[A-Za-z_$][\w$]*\(await\s+[A-Za-z_$][\w$]*\()?(?:this\.showSystemNotification\()'
)

OUTER_FOCUS_ORIG_RE = re.compile(
    r'if\(([A-Za-z_$][\w$]*\.window\.state\.focused&&[A-Za-z_$][\w$]*&&\([A-Za-z_$][\w$]*\|\|[A-Za-z_$][\w$]*\))\)return\{\};'
)
OUTER_FOCUS_PATCHED_CHECK = "if(!1)return{};"


def find_ide_installations(custom_dir: str | None = None) -> list[Path]:
    """Locate Antigravity IDE installation folders containing extensions/agy/vscode/extension.js."""
    candidates: list[Path] = []
    if custom_dir:
        candidates.append(Path(custom_dir))
    else:
        local_app = os.environ.get("LOCALAPPDATA", "")
        prog_files = os.environ.get("ProgramFiles", "")
        for base in (local_app, prog_files):
            if not base:
                continue
            programs_dir = Path(base) / "Programs" if base == local_app else Path(base)
            for name in ("Antigravity IDE", "Antigravity"):
                candidates.append(programs_dir / name)

    found: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        ext_path = get_extension_path(candidate)
        if ext_path.is_file():
            resolved = candidate.resolve()
            if resolved not in seen:
                seen.add(resolved)
                found.append(resolved)
    return found


def get_extension_path(ide_dir: Path) -> Path:
    return ide_dir / "resources" / "app" / "extensions" / "agy" / "vscode" / "extension.js"


def find_ide_executable(ide_dir: Path) -> Path | None:
    for exe_name in ("Antigravity IDE.exe", "Antigravity.exe"):
        exe = ide_dir / exe_name
        if exe.is_file():
            return exe
    return None


def read_product_metadata(ide_dir: Path) -> tuple[str, str]:
    """Return (ide_version, win32_app_user_model_id) from product.json."""
    product_path = ide_dir / "resources" / "app" / "product.json"
    if not product_path.is_file():
        return "unknown", "Google.AntigravityIDE"
    data = json.loads(product_path.read_text(encoding="utf-8"))
    version = str(data.get("ideVersion") or data.get("version") or "unknown")
    app_id = str(data.get("win32AppUserModelId") or "Google.AntigravityIDE")
    return version, app_id


def inspect_extension_status(text: str, expected_app_id: str = "Google.AntigravityIDE") -> dict[str, object]:
    """Inspect whether all 4 notification fixes and RTL markers are present."""
    app_match = APP_ID_RE.search(text)
    current_app_id = app_match.group(2) if app_match else None

    fallback_patched = FALLBACK_PATCHED_CHECK in text
    inner_orig = bool(INNER_FOCUS_ORIG_RE.search(text))
    inner_patched = (not inner_orig) and bool(INNER_FOCUS_PATCHED_RE.search(text))

    outer_orig = bool(OUTER_FOCUS_ORIG_RE.search(text))
    outer_patched = (not outer_orig) and (OUTER_FOCUS_PATCHED_CHECK in text or "if (false) return {};" in text)

    return {
        "app_id_value": current_app_id,
        "app_id_ok": current_app_id == expected_app_id,
        "fallback_ok": fallback_patched,
        "inner_focus_ok": inner_patched,
        "outer_focus_ok": outer_patched,
        "rtl_present": "/* RTL-PATCH-START */" in text,
    }


def patch_extension_source(text: str, app_id: str = "Google.AntigravityIDE") -> tuple[str, list[str]]:
    """Apply all 4 notification fixes idempotently to extension.js content."""
    changes: list[str] = []
    out = text

    app_matches = list(APP_ID_RE.finditer(out))
    if len(app_matches) != 1:
        raise RuntimeError(f"Expected 1 AGY_NOTIFY_APP_ID assignment, found {len(app_matches)}")
    if app_matches[0].group(2) != app_id:
        out = APP_ID_RE.sub(lambda m: f'{m.group(1)}"{app_id}"', out, count=1)
        changes.append(f"AGY_NOTIFY_APP_ID -> {app_id}")

    if FALLBACK_PATCHED_CHECK not in out:
        fb_matches = list(FALLBACK_ORIG_RE.finditer(out))
        if len(fb_matches) != 1:
            raise RuntimeError(f"Expected 1 StartApps fallback match, found {len(fb_matches)}")
        out = FALLBACK_ORIG_RE.sub(
            r'($App = $Apps | Where-Object {$_.Name -like "*Visual Studio Code*" -or $_.Name -like "*Antigravity*"})\2',
            out,
            count=1,
        )
        changes.append("StartApps fallback -> added *Antigravity*")

    inner_orig_matches = list(INNER_FOCUS_ORIG_RE.finditer(out))
    if inner_orig_matches:
        if len(inner_orig_matches) != 1:
            raise RuntimeError(f"Expected 1 inner focus guard match, found {len(inner_orig_matches)}")
        out = INNER_FOCUS_ORIG_RE.sub(r"!1\3", out, count=1)
        changes.append("Inner focus suppression -> disabled")
    elif not INNER_FOCUS_PATCHED_RE.search(out):
        raise RuntimeError("Could not locate inner focus guard or patched signature in showBrowserNotification")

    if OUTER_FOCUS_PATCHED_CHECK not in out and "if (false) return {};" not in out:
        outer_matches = list(OUTER_FOCUS_ORIG_RE.finditer(out))
        if len(outer_matches) != 1:
            raise RuntimeError(f"Expected 1 outer focus guard match, found {len(outer_matches)}")
        out = OUTER_FOCUS_ORIG_RE.sub(OUTER_FOCUS_PATCHED_CHECK, out, count=1)
        changes.append("Outer focus suppression -> disabled")

    return out, changes


def verify_js_syntax(ide_dir: Path, js_path: Path) -> tuple[bool, str]:
    """Validate JavaScript syntax via Electron Node mode or system Node.js."""
    exe = find_ide_executable(ide_dir)
    if exe is not None:
        env = os.environ.copy()
        env["ELECTRON_RUN_AS_NODE"] = "1"
        cmd = [str(exe), "--check", str(js_path)]
    else:
        node_bin = shutil.which("node")
        if not node_bin:
            return True, "Skipped syntax check (neither IDE exe nor node found)"
        env = os.environ.copy()
        cmd = [node_bin, "--check", str(js_path)]

    proc = subprocess.run(
        cmd,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    return proc.returncode == 0, (proc.stdout + proc.stderr).strip()


def find_existing_backup(ext_path: Path) -> Path | None:
    for name in ("extension.js.notif_bak",):
        candidate = ext_path.parent / name
        if candidate.is_file():
            return candidate
    matches = sorted(ext_path.parent.glob("extension.js.notif_*bak"), key=lambda p: p.stat().st_mtime, reverse=True)
    return matches[0] if matches else None


def create_backup(ext_path: Path) -> Path:
    existing = find_existing_backup(ext_path)
    if existing is not None:
        return existing
    bak_path = ext_path.parent / "extension.js.notif_bak"
    shutil.copy2(ext_path, bak_path)
    return bak_path


def apply_patch(ide_dir: Path, app_id_override: str | None = None) -> int:
    version, detected_app_id = read_product_metadata(ide_dir)
    app_id = app_id_override or detected_app_id
    ext_path = get_extension_path(ide_dir)

    print(f"IDE: {ide_dir} (version={version}, appId={app_id})")
    src = ext_path.read_text(encoding="utf-8")

    ok_before, msg_before = verify_js_syntax(ide_dir, ext_path)
    if not ok_before:
        print(f"[ERROR] Pre-patch JS syntax check failed: {msg_before}", file=sys.stderr)
        return 1

    bak_path = create_backup(ext_path)
    print(f"Backup: {bak_path.name}")

    patched, changes = patch_extension_source(src, app_id=app_id)
    if not changes:
        print("Status: Already patched (0 changes needed).")
        return 0

    ext_path.write_text(patched, encoding="utf-8")
    ok_after, msg_after = verify_js_syntax(ide_dir, ext_path)
    if not ok_after:
        shutil.copy2(bak_path, ext_path)
        print(f"[ERROR] Post-patch syntax check failed; rolled back! {msg_after}", file=sys.stderr)
        return 1

    for c in changes:
        print(f"  + {c}")
    print("Syntax check: OK")
    return 0


def restore_backup(ide_dir: Path) -> int:
    ext_path = get_extension_path(ide_dir)
    bak_path = find_existing_backup(ext_path)
    if bak_path is None:
        print(f"[WARN] No notification backup found in {ext_path.parent}")
        return 1
    shutil.copy2(bak_path, ext_path)
    print(f"Restored {ext_path} from {bak_path.name}")
    return 0


def show_status(ide_dir: Path, app_id_override: str | None = None) -> int:
    version, detected_app_id = read_product_metadata(ide_dir)
    app_id = app_id_override or detected_app_id
    ext_path = get_extension_path(ide_dir)
    text = ext_path.read_text(encoding="utf-8")
    status = inspect_extension_status(text, expected_app_id=app_id)
    bak = find_existing_backup(ext_path)

    print(f"IDE: {ide_dir} (version={version}, expected_appId={app_id})")
    print(f"  AGY_NOTIFY_APP_ID : {status['app_id_value']} ({'OK' if status['app_id_ok'] else 'NEEDS PATCH'})")
    print(f"  StartApps Fallback: {'OK' if status['fallback_ok'] else 'NEEDS PATCH'}")
    print(f"  Inner Focus Guard : {'DISABLED (OK)' if status['inner_focus_ok'] else 'ACTIVE (NEEDS PATCH)'}")
    print(f"  Outer Focus Guard : {'DISABLED (OK)' if status['outer_focus_ok'] else 'ACTIVE (NEEDS PATCH)'}")
    print(f"  RTL Patch Intact  : {'YES' if status['rtl_present'] else 'NO'}")
    print(f"  Backup File       : {bak.name if bak else 'None'}")
    return 0


def run_toast_test(app_id: str = "Google.AntigravityIDE") -> int:
    if os.name != "nt":
        print("Live Windows Toast test is only supported on Windows.")
        return 0
    ps_script = Path(__file__).with_name("test_toast.ps1")
    if not ps_script.is_file():
        print(f"[ERROR] Missing {ps_script}", file=sys.stderr)
        return 1
    proc = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(ps_script),
            "-AppId",
            app_id,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=20,
    )
    if proc.stdout.strip():
        print(proc.stdout.strip())
    if proc.returncode != 0:
        print(f"[ERROR] Toast test failed: {proc.stderr.strip()}", file=sys.stderr)
    return proc.returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Antigravity IDE Windows Notification Patcher")
    parser.add_argument("--apply", action="store_true", help="Apply notification patch (default action)")
    parser.add_argument("--status", action="store_true", help="Inspect current patch status")
    parser.add_argument("--restore", action="store_true", help="Restore original extension.js from backup")
    parser.add_argument("--test", action="store_true", help="Send a live Windows Toast test notification")
    parser.add_argument("--ide-dir", help="Explicit path to Antigravity IDE installation directory")
    parser.add_argument("--app-id", help="Override Windows AUMID (default: read from product.json)")
    args = parser.parse_args(argv)

    do_apply = args.apply or not (args.status or args.restore or args.test)

    ides = find_ide_installations(args.ide_dir)
    if not ides and (do_apply or args.status or args.restore):
        print("[ERROR] Could not find Antigravity IDE installation directory.", file=sys.stderr)
        return 1

    exit_code = 0
    resolved_app_id = args.app_id or "Google.AntigravityIDE"
    for ide_dir in ides:
        _, detected_app_id = read_product_metadata(ide_dir)
        resolved_app_id = args.app_id or detected_app_id
        if args.restore:
            exit_code |= restore_backup(ide_dir)
        if args.status:
            exit_code |= show_status(ide_dir, app_id_override=args.app_id)
        if do_apply:
            exit_code |= apply_patch(ide_dir, app_id_override=args.app_id)

    if args.test and exit_code == 0:
        exit_code |= run_toast_test(app_id=resolved_app_id)

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
