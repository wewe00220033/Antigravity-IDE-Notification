"""Antigravity IDE Windows Notification Enhancer CLI & Persistent Extension Installer.

Delegates JS anchor patching, version+SHA256 backup management, and status inspection
to `core/cli.js` (single source of truth) executed via Electron's built-in Node runtime
or system Node.js, validates syntax after edits with automatic rollback on failure,
and installs the persistent companion VS Code extension into `.antigravity-ide/extensions/`.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

NOTIF_ROOT = Path(__file__).resolve().parent
EXTENSION_FOLDER_NAME = "local-agy.antigravity-notification-enhancer-2.0.0"
EXTENSION_ID = "local-agy.antigravity-notification-enhancer"


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


def resolve_node_runner(ide_dir: Path | None = None) -> tuple[list[str], dict[str, str]]:
    """Return command prefix + env to run Node scripts without requiring global node.exe."""
    env = os.environ.copy()
    if ide_dir is not None:
        exe = find_ide_executable(ide_dir)
        if exe is not None:
            env["ELECTRON_RUN_AS_NODE"] = "1"
            return [str(exe)], env
    node_bin = shutil.which("node")
    if node_bin:
        env.pop("ELECTRON_RUN_AS_NODE", None)
        return [node_bin], env
    for installed in find_ide_installations():
        exe = find_ide_executable(installed)
        if exe is not None:
            env["ELECTRON_RUN_AS_NODE"] = "1"
            return [str(exe)], env
    raise RuntimeError("Neither Antigravity IDE executable nor system node.exe was found.")


def read_product_metadata(ide_dir: Path) -> tuple[str, str]:
    """Return (ide_version, win32_app_user_model_id) from product.json."""
    product_path = ide_dir / "resources" / "app" / "product.json"
    if not product_path.is_file():
        return "unknown", "Google.AntigravityIDE"
    data = json.loads(product_path.read_text(encoding="utf-8"))
    version = str(data.get("ideVersion") or data.get("version") or "unknown")
    app_id = str(data.get("win32AppUserModelId") or "Google.AntigravityIDE")
    return version, app_id


def verify_js_syntax(ide_dir: Path, js_path: Path) -> tuple[bool, str]:
    """Validate JavaScript syntax via Electron Node mode or system Node.js."""
    try:
        runner, env = resolve_node_runner(ide_dir)
    except RuntimeError as exc:
        return True, f"Skipped syntax check ({exc})"

    proc = subprocess.run(
        [*runner, "--check", str(js_path)],
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    return proc.returncode == 0, (proc.stdout + proc.stderr).strip()


def run_core_cli(
    ide_dir: Path,
    action_flag: str,
    app_id_override: str | None = None,
    custom_home: str | None = None,
    extra_flags: list[str] | None = None,
) -> subprocess.CompletedProcess[str]:
    runner, env = resolve_node_runner(ide_dir)
    if custom_home:
        env["AGY_NOTIF_HOME"] = custom_home
    cli_js = NOTIF_ROOT / "core" / "cli.js"
    cmd = [
        *runner,
        str(cli_js),
        action_flag,
        "--ide-dir",
        str(ide_dir),
        "--notif-root",
        str(NOTIF_ROOT),
    ]
    if app_id_override:
        cmd.extend(["--app-id", app_id_override])
    if custom_home:
        cmd.extend(["--home", custom_home])
    if extra_flags:
        cmd.extend(extra_flags)
    return subprocess.run(
        cmd,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )


def apply_patch(
    ide_dir: Path,
    app_id_override: str | None = None,
    custom_home: str | None = None,
) -> int:
    ext_path = get_extension_path(ide_dir)
    ok_before, msg_before = verify_js_syntax(ide_dir, ext_path)
    if not ok_before:
        print(f"[ERROR] Pre-patch JS syntax check failed: {msg_before}", file=sys.stderr)
        return 1

    pre_snapshot = ext_path.read_bytes()
    proc = run_core_cli(ide_dir, "--apply", app_id_override=app_id_override, custom_home=custom_home)
    if proc.stdout.strip():
        print(proc.stdout.strip())
    if proc.returncode != 0:
        if proc.stderr.strip():
            print(proc.stderr.strip(), file=sys.stderr)
        return proc.returncode

    ok_after, msg_after = verify_js_syntax(ide_dir, ext_path)
    if not ok_after:
        ext_path.write_bytes(pre_snapshot)
        print(f"[ERROR] Post-patch syntax check failed; rolled back! {msg_after}", file=sys.stderr)
        return 1

    print("Syntax check: OK")
    return 0


def restore_backup(ide_dir: Path, custom_home: str | None = None) -> int:
    proc = run_core_cli(ide_dir, "--restore", custom_home=custom_home)
    if proc.stdout.strip():
        print(proc.stdout.strip())
    if proc.returncode != 0 and proc.stderr.strip():
        print(proc.stderr.strip(), file=sys.stderr)
    return proc.returncode


def show_status(
    ide_dir: Path,
    app_id_override: str | None = None,
    custom_home: str | None = None,
) -> int:
    proc = run_core_cli(ide_dir, "--status", app_id_override=app_id_override, custom_home=custom_home)
    if proc.stdout.strip():
        print(proc.stdout.strip())
    if proc.returncode != 0 and proc.stderr.strip():
        print(proc.stderr.strip(), file=sys.stderr)
    return proc.returncode


def get_user_extensions_dirs() -> list[Path]:
    """Return user VS Code/Antigravity extension roots where persistent extensions survive updates."""
    home = Path.home()
    roots = [home / ".antigravity-ide" / "extensions"]
    return [r for r in roots if r.is_dir() or r.parent.is_dir()]


def install_persistent_extension(ext_roots: list[Path] | None = None) -> list[Path]:
    """Install the companion auto-heal VS Code extension and sync extensions.json cleanly."""
    targets = ext_roots if ext_roots is not None else get_user_extensions_dirs()
    installed: list[Path] = []
    ext_src = NOTIF_ROOT / "extension"
    core_src = NOTIF_ROOT / "core"
    cfg_src = NOTIF_ROOT / "config"
    ps_src = NOTIF_ROOT / "test_toast.ps1"

    for root in targets:
        root.mkdir(parents=True, exist_ok=True)
        dest = root / EXTENSION_FOLDER_NAME
        dest.mkdir(parents=True, exist_ok=True)

        shutil.copy2(ext_src / "package.json", dest / "package.json")
        shutil.copy2(ext_src / "extension.js", dest / "extension.js")
        if ps_src.is_file():
            shutil.copy2(ps_src, dest / "test_toast.ps1")

        core_dst = dest / "core"
        core_dst.mkdir(parents=True, exist_ok=True)
        for js_file in core_src.glob("*.js"):
            shutil.copy2(js_file, core_dst / js_file.name)

        cfg_dst = dest / "config"
        cfg_dst.mkdir(parents=True, exist_ok=True)
        if (cfg_src / "default_config.json").is_file():
            shutil.copy2(cfg_src / "default_config.json", cfg_dst / "default_config.json")

        ext_json = root / "extensions.json"
        if ext_json.is_file():
            try:
                entries = json.loads(ext_json.read_text(encoding="utf-8"))
                if isinstance(entries, list):
                    entries = [
                        e for e in entries
                        if not (isinstance(e, dict) and e.get("identifier", {}).get("id") == EXTENSION_ID)
                    ]
                    posix_path = "/" + dest.resolve().as_posix().lstrip("/")
                    entries.append({
                        "identifier": {"id": EXTENSION_ID},
                        "version": "2.0.0",
                        "location": {"$mid": 1, "path": posix_path, "scheme": "file"},
                        "relativeLocation": EXTENSION_FOLDER_NAME,
                        "metadata": {
                            "isApplicationScoped": False,
                            "isMachineScoped": False,
                            "isBuiltin": False,
                            "installedTimestamp": int(time.time() * 1000),
                            "source": "vsix",
                        },
                    })
                    ext_json.write_text(json.dumps(entries, indent=2, ensure_ascii=False), encoding="utf-8")
            except Exception as exc:
                print(f"[WARN] Could not update {ext_json}: {exc}", file=sys.stderr)

        installed.append(dest)
        print(f"Persistent extension installed: {dest}")

    return installed


def run_toast_test(app_id: str = "Google.AntigravityIDE") -> int:
    if os.name != "nt":
        print("Live Windows Toast test is only supported on Windows.")
        return 0
    ps_script = NOTIF_ROOT / "test_toast.ps1"
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
            "-Title",
            "Test Conversation (No Agent finished prefix)",
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
    parser = argparse.ArgumentParser(description="Antigravity IDE Windows Notification Enhancer")
    parser.add_argument("--apply", action="store_true", help="Apply notification hooks and install persistent extension")
    parser.add_argument("--status", action="store_true", help="Inspect current L1/L2/RTL patch status")
    parser.add_argument("--restore", action="store_true", help="Restore matching version backup of extension.js")
    parser.add_argument("--test", action="store_true", help="Send a live Windows Toast test notification")
    parser.add_argument("--install-extension", action="store_true", help="Install/update companion VS Code extension")
    parser.add_argument("--no-extension", action="store_true", help="Skip companion VS Code extension install during --apply")
    parser.add_argument("--ide-dir", help="Explicit path to Antigravity IDE installation directory")
    parser.add_argument("--app-id", help="Override Windows AUMID (default: read from product.json)")
    parser.add_argument("--home", help="Override ~/.antigravity-notifications data directory")
    args = parser.parse_args(argv)

    do_apply = args.apply or not (args.status or args.restore or args.test or args.install_extension)

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
            exit_code |= restore_backup(ide_dir, custom_home=args.home)
        if args.status:
            exit_code |= show_status(ide_dir, app_id_override=args.app_id, custom_home=args.home)
        if do_apply:
            exit_code |= apply_patch(ide_dir, app_id_override=args.app_id, custom_home=args.home)

    if (args.install_extension or (do_apply and not args.no_extension)) and exit_code == 0:
        install_persistent_extension()

    if args.test and exit_code == 0:
        exit_code |= run_toast_test(app_id=resolved_app_id)

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
