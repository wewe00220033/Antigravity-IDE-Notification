'use strict';

/**
 * Persistent Antigravity Notification Enhancer VS Code Extension.
 * Installed outside `resources/app/` so it survives Antigravity IDE upgrades,
 * detects when `extensions/agy/vscode/extension.js` was reset by an update,
 * re-applies hooks safely (with syntax check + RTL preservation), syncs VS Code UI
 * settings into live `~/.antigravity-notifications/config.json`, and offers a
 * Reload Window prompt when first patched after an update.
 */

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let vscode = null;
try {
  vscode = require('vscode');
} catch (_) {
  vscode = null;
}

function resolveCoreDir() {
  const localCore = path.join(__dirname, 'core');
  if (fs.existsSync(path.join(localCore, 'extension_patcher.js'))) {
    return localCore;
  }
  return path.resolve(__dirname, '..', 'core');
}

const CORE_DIR = resolveCoreDir();
const { loadConfig, saveConfig, loadState, saveState } = require(path.join(CORE_DIR, 'config_store.js'));
const { formatDirectToastArgs } = require(path.join(CORE_DIR, 'formatter.js'));
const {
  deployPersistentRuntime,
  ensureVersionedBackup,
  inspectExtensionStatus,
  patchExtensionSource,
  restoreVersionedBackup,
  sha256Hex,
} = require(path.join(CORE_DIR, 'extension_patcher.js'));

let statusBarItem = null;
let watchHandle = null;
let watchTimer = null;
let suppressWatchUntil = 0;

function resolveIdeContext() {
  if (!vscode || !vscode.env || !vscode.env.appRoot) {
    return null;
  }
  const appDir = path.resolve(vscode.env.appRoot);
  const ideDir = path.resolve(appDir, '..', '..');
  const extPath = path.join(appDir, 'extensions', 'agy', 'vscode', 'extension.js');
  const productPath = path.join(appDir, 'product.json');

  let version = 'unknown';
  let appId = 'Google.AntigravityIDE';
  if (fs.existsSync(productPath)) {
    try {
      const prod = JSON.parse(fs.readFileSync(productPath, 'utf8'));
      version = String(prod.ideVersion || prod.version || 'unknown');
      appId = String(prod.win32AppUserModelId || 'Google.AntigravityIDE');
    } catch (_) {
      // Keep safe defaults if product.json is unreadable
    }
  }

  let exePath = null;
  for (const candidate of ['Antigravity IDE.exe', 'Antigravity.exe']) {
    const p = path.join(ideDir, candidate);
    if (fs.existsSync(p)) {
      exePath = p;
      break;
    }
  }

  return { ideDir, appDir, extPath, exePath, version, appId };
}

function verifyJsSyntax(exePath, jsContent) {
  const tmpFile = path.join(os.tmpdir(), `agy_notif_check_${process.pid}_${Date.now()}.js`);
  try {
    fs.writeFileSync(tmpFile, jsContent, 'utf8');
    const runner = exePath || process.execPath;
    const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
    const res = cp.spawnSync(runner, ['--check', tmpFile], {
      env,
      encoding: 'utf8',
      timeout: 25000,
    });
    return {
      ok: res.status === 0,
      error: res.status === 0 ? null : ((res.stderr || res.stdout || `exit=${res.status}`).trim()),
    };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

function syncExtensionBundleToRuntime() {
  const bundleRoot = fs.existsSync(path.join(__dirname, 'core')) ? __dirname : path.resolve(__dirname, '..');
  deployPersistentRuntime(bundleRoot);
}

function updateStatusBar(mode, detail) {
  if (!statusBarItem) return;
  if (mode === 'ok') {
    statusBarItem.text = '$(bell) Notif: On';
    statusBarItem.tooltip = detail || 'Antigravity enhanced notifications are active.';
    statusBarItem.color = undefined;
  } else if (mode === 'reload') {
    statusBarItem.text = '$(sync) Notif: Reload';
    statusBarItem.tooltip = detail || 'Patch applied. Reload window to activate.';
    statusBarItem.color = '#f1fa8c';
  } else if (mode === 'safe-mode') {
    statusBarItem.text = '$(warning) Notif: Safe Mode';
    statusBarItem.tooltip = detail || 'Anchor mismatch detected after update; running safely unpatched.';
    statusBarItem.color = '#ffb86c';
  } else {
    statusBarItem.text = '$(bell-slash) Notif: Off';
    statusBarItem.tooltip = detail || 'Antigravity notifications need patching.';
    statusBarItem.color = undefined;
  }
  statusBarItem.show();
}

function promptReload(message) {
  if (!vscode) return;
  vscode.window.showInformationMessage(message, 'Reload Window').then((choice) => {
    if (choice === 'Reload Window') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  });
}

function ensurePatched({ interactive = false } = {}) {
  const ctx = resolveIdeContext();
  if (!ctx || !fs.existsSync(ctx.extPath)) {
    updateStatusBar('off', 'Could not locate Antigravity extension.js');
    return { applied: false, ok: false, reason: 'missing_target' };
  }

  const { config } = loadConfig();
  syncExtensionBundleToRuntime();

  const currentText = fs.readFileSync(ctx.extPath, 'utf8');
  const status = inspectExtensionStatus(currentText, ctx.appId);
  if (status.allOk) {
    updateStatusBar('ok', `IDE v${ctx.version} · AppID ${ctx.appId} · RTL=${status.rtlPresent ? 'Yes' : 'No'}`);
    return { applied: false, ok: true, status, ctx };
  }

  try {
    const bakPath = ensureVersionedBackup(ctx.ideDir, ctx.extPath, currentText, ctx.version);
    const { content: patched, changes } = patchExtensionSource(currentText, ctx.appId);
    if (changes.length === 0) {
      updateStatusBar('ok');
      return { applied: false, ok: true, status, ctx };
    }

    const check = verifyJsSyntax(ctx.exePath, patched);
    if (!check.ok) {
      updateStatusBar('safe-mode', `Syntax verification failed: ${check.error}`);
      if (vscode) {
        vscode.window.showWarningMessage(
          `Antigravity Notifications (Safe Mode): syntax check failed before writing (${check.error}). IDE left untouched.`
        );
      }
      return { applied: false, ok: false, reason: check.error };
    }

    suppressWatchUntil = Date.now() + 4000;
    fs.writeFileSync(ctx.extPath, patched, 'utf8');

    const state = loadState();
    const key = path.resolve(ctx.ideDir).toLowerCase();
    state.installations[key] = Object.assign({}, state.installations[key], {
      ideVersion: ctx.version,
      patchedHash: sha256Hex(patched).slice(0, 12),
      activeBackup: bakPath,
      lastPatchedAt: new Date().toISOString(),
    });
    saveState(state);

    updateStatusBar('reload', `Patched IDE v${ctx.version}. Click or reload window to activate.`);
    if (interactive || config.promptReloadAfterUpdate) {
      promptReload(`Antigravity Notifications applied for v${ctx.version}. Reload window to activate.`);
    }
    return { applied: true, ok: true, changes, ctx };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    updateStatusBar('safe-mode', `Safe mode (IDE left untouched): ${msg}`);
    if (vscode) {
      vscode.window.showWarningMessage(
        `Antigravity Notifications (Safe Mode): ${msg}. Chat UI was not modified.`
      );
    }
    return { applied: false, ok: false, reason: msg };
  }
}

function syncVsCodeSettingsToConfig() {
  if (!vscode) return;
  const ws = vscode.workspace.getConfiguration('antigravityNotifications');
  const { config } = loadConfig();
  const next = JSON.parse(JSON.stringify(config));

  const mapBool = [
    'enabled',
    'notifyWhenFocused',
    'notifySameActiveChat',
    'showOpenChatBannerInSameChat',
    'autoPatchOnUpdate',
    'promptReloadAfterUpdate',
  ];
  for (const k of mapBool) {
    const v = ws.get(k);
    if (typeof v === 'boolean') next[k] = v;
  }

  const sm = ws.get('soundMode');
  if (typeof sm === 'string') next.soundMode = sm;

  const dw = ws.get('dedupeWindowMs');
  if (typeof dw === 'number') next.dedupeWindowMs = dw;

  const ft = ws.get('finishedTitleTemplate');
  if (typeof ft === 'string') next.events.finished.titleTemplate = ft;

  const fb = ws.get('finishedBodyTemplate');
  if (typeof fb === 'string') next.events.finished.bodyTemplate = fb;

  saveConfig(next);
}

function sendTestToast() {
  if (process.platform !== 'win32') {
    if (vscode) vscode.window.showInformationMessage('Windows Toast test is only supported on Windows.');
    return;
  }
  const ctx = resolveIdeContext();
  const { config } = loadConfig();
  const sample = formatDirectToastArgs(
    'Antigravity',
    'Agent finished: Test Conversation Title',
    config,
    { silent: false }
  );
  const psCandidates = [
    path.join(__dirname, 'test_toast.ps1'),
    path.resolve(__dirname, '..', 'test_toast.ps1'),
  ];
  const psFile = psCandidates.find((p) => fs.existsSync(p));
  if (!psFile) {
    if (vscode) vscode.window.showErrorMessage('test_toast.ps1 not found.');
    return;
  }

  const psArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    psFile,
    '-AppId',
    ctx ? ctx.appId : 'Google.AntigravityIDE',
    '-Title',
    sample.title || 'Antigravity Test',
  ];
  if (sample.body) psArgs.push('-Body', sample.body);
  if (sample.silent) psArgs.push('-Silent');

  cp.execFile(
    'powershell.exe',
    psArgs,
    { timeout: 15000, windowsHide: true },
    (err, _stdout, stderr) => {
      if (!vscode) return;
      if (err) {
        vscode.window.showErrorMessage(`Test toast failed: ${stderr || err.message}`);
      } else {
        vscode.window.showInformationMessage(`Test toast sent: "${sample.title}"`);
      }
    }
  );
}

function showStatusDialog() {
  const ctx = resolveIdeContext();
  if (!ctx || !fs.existsSync(ctx.extPath)) {
    if (vscode) vscode.window.showErrorMessage('Antigravity extension.js not found.');
    return;
  }
  const text = fs.readFileSync(ctx.extPath, 'utf8');
  const st = inspectExtensionStatus(text, ctx.appId);
  const { config, configPath, error } = loadConfig();
  const proxyActive = Boolean(globalThis.__agyNotifProxyUrl);
  const rtlActive = Boolean(globalThis.__rtlChatProxyUrl);
  const summary = [
    `IDE v${ctx.version}`,
    `L2 Patch=${st.allOk ? 'OK' : 'NEEDS PATCH'}`,
    `L1 Proxy=${proxyActive ? 'Active' : 'Pending Reload'}`,
    `RTL=${st.rtlPresent ? (rtlActive ? 'Active' : 'Patched') : 'Absent'}`,
    `SameChat=${config.notifySameActiveChat}`,
    `Config=${error ? 'Fallback' : path.basename(configPath)}`,
  ].join(' | ');

  if (vscode) {
    vscode.window.showInformationMessage(summary, 'Open Config', 'Test Toast').then((sel) => {
      if (sel === 'Open Config') {
        vscode.workspace.openTextDocument(configPath).then((doc) => vscode.window.showTextDocument(doc));
      } else if (sel === 'Test Toast') {
        sendTestToast();
      }
    });
  }
}

function setupWatcher() {
  const ctx = resolveIdeContext();
  if (!ctx || !fs.existsSync(ctx.extPath)) return;
  const dir = path.dirname(ctx.extPath);
  const baseName = path.basename(ctx.extPath).toLowerCase();
  try {
    watchHandle = fs.watch(dir, (_, filename) => {
      if (!filename || filename.toLowerCase() !== baseName) return;
      if (Date.now() < suppressWatchUntil) return;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        watchTimer = null;
        const { config } = loadConfig();
        if (config.autoPatchOnUpdate) {
          ensurePatched({ interactive: false });
        }
      }, 1500);
    });
  } catch (_) {
    // Non-fatal if fs.watch is unavailable
  }
}

function activate(context) {
  if (!vscode) return;

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  statusBarItem.command = 'antigravityNotif.showStatus';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityNotif.applyPatch', () => ensurePatched({ interactive: true })),
    vscode.commands.registerCommand('antigravityNotif.showStatus', showStatusDialog),
    vscode.commands.registerCommand('antigravityNotif.testToast', sendTestToast),
    vscode.commands.registerCommand('antigravityNotif.openConfig', () => {
      const { configPath } = loadConfig();
      vscode.workspace.openTextDocument(configPath).then((doc) => vscode.window.showTextDocument(doc));
    }),
    vscode.commands.registerCommand('antigravityNotif.restoreBackup', () => {
      const ctx = resolveIdeContext();
      if (!ctx) return;
      try {
        suppressWatchUntil = Date.now() + 4000;
        const bak = restoreVersionedBackup(ctx.ideDir, ctx.extPath, ctx.version);
        updateStatusBar('off', 'Restored original backup.');
        promptReload(`Restored backup (${path.basename(bak)}). Reload window to apply.`);
      } catch (err) {
        vscode.window.showErrorMessage(err && err.message ? err.message : String(err));
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('antigravityNotifications')) {
        syncVsCodeSettingsToConfig();
      }
    })
  );

  setTimeout(() => {
    const { config } = loadConfig();
    if (config.autoPatchOnUpdate) {
      ensurePatched({ interactive: false });
    } else {
      const ctx = resolveIdeContext();
      const st = ctx && fs.existsSync(ctx.extPath)
        ? inspectExtensionStatus(fs.readFileSync(ctx.extPath, 'utf8'), ctx.appId)
        : null;
      updateStatusBar(st && st.allOk ? 'ok' : 'off');
    }
    setupWatcher();
  }, 1200);
}

function deactivate() {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  if (watchHandle) {
    try { watchHandle.close(); } catch (_) {}
    watchHandle = null;
  }
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}

module.exports = {
  activate,
  deactivate,
  ensurePatched,
  syncVsCodeSettingsToConfig,
};
