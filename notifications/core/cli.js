'use strict';

/**
 * Node CLI bridge invoked by patch_notifications.py (via node or ELECTRON_RUN_AS_NODE=1).
 * Keeps extension_patcher.js as the single source of truth for regexes and backup state.
 */

const fs = require('fs');
const path = require('path');

const { loadConfig, loadState, saveState } = require('./config_store');
const {
  deployPersistentRuntime,
  ensureVersionedBackup,
  inspectExtensionStatus,
  patchExtensionSource,
  restoreVersionedBackup,
  sha256Hex,
} = require('./extension_patcher');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

function readProductMeta(ideDir) {
  const p = path.join(ideDir, 'resources', 'app', 'product.json');
  if (!fs.existsSync(p)) return { version: 'unknown', appId: 'Google.AntigravityIDE' };
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  return {
    version: String(data.ideVersion || data.version || 'unknown'),
    appId: String(data.win32AppUserModelId || 'Google.AntigravityIDE'),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ideDir = args['ide-dir'];
  const notifRoot = args['notif-root'] || path.resolve(__dirname, '..');
  const customHome = args['home'] || undefined;

  if (!ideDir) {
    console.error('[ERROR] --ide-dir is required');
    return 2;
  }

  const extPath = path.join(ideDir, 'resources', 'app', 'extensions', 'agy', 'vscode', 'extension.js');
  if (!fs.existsSync(extPath)) {
    console.error(`[ERROR] Missing ${extPath}`);
    return 1;
  }

  const { version, appId: detectedAppId } = readProductMeta(ideDir);
  const appId = typeof args['app-id'] === 'string' ? args['app-id'] : detectedAppId;
  const currentText = fs.readFileSync(extPath, 'utf8');

  if (args.status) {
    const st = inspectExtensionStatus(currentText, appId);
    const cfgInfo = loadConfig(customHome);
    const stateInfo = loadState(customHome);
    const payload = {
      ideDir,
      version,
      expectedAppId: appId,
      status: st,
      configPath: cfgInfo.configPath,
      configError: cfgInfo.error,
      config: cfgInfo.config,
      installationState: stateInfo.installations[path.resolve(ideDir).toLowerCase()] || null,
    };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`IDE: ${ideDir} (version=${version}, expected_appId=${appId})`);
      console.log(`  AGY_NOTIFY_APP_ID : ${st.appIdValue} (${st.appIdOk ? 'OK' : 'NEEDS PATCH'})`);
      console.log(`  StartApps Fallback: ${st.fallbackOk ? 'OK' : 'NEEDS PATCH'}`);
      console.log(`  WinToast Hook v2  : ${st.winToastHookOk ? 'OK' : 'NEEDS PATCH'}`);
      console.log(`  Outer PreFilter   : ${st.outerHookOk ? 'OK' : 'NEEDS PATCH'}`);
      console.log(`  Inner Focus Hook  : ${st.innerHookOk ? 'OK' : 'NEEDS PATCH'}`);
      console.log(`  Webview Proxy Hook: ${st.proxyHookOk ? 'OK' : 'NEEDS PATCH'}`);
      console.log(`  Runtime Header    : ${st.runtimeHeaderOk ? 'OK' : 'NEEDS PATCH'}`);
      console.log(`  RTL Patch Intact  : ${st.rtlPresent ? 'YES' : 'NO'}`);
      console.log(`  Config File       : ${cfgInfo.configPath}${cfgInfo.error ? ` (FALLBACK: ${cfgInfo.error})` : ''}`);
    }
    return 0;
  }

  if (args.restore) {
    const restoredFrom = restoreVersionedBackup(ideDir, extPath, version, customHome);
    console.log(`Restored ${extPath} from ${path.basename(restoredFrom)}`);
    return 0;
  }

  if (args.apply) {
    deployPersistentRuntime(notifRoot, customHome);
    const bakPath = ensureVersionedBackup(ideDir, extPath, currentText, version, customHome);
    const { content: patched, changes } = patchExtensionSource(currentText, appId);
    if (changes.length === 0) {
      console.log(`IDE: ${ideDir} (version=${version}, appId=${appId}) — Already up to date (0 changes).`);
      return 0;
    }
    fs.writeFileSync(extPath, patched, 'utf8');
    // Update patched hash fingerprint in state.json
    const state = loadState(customHome);
    const key = path.resolve(ideDir).toLowerCase();
    state.installations[key] = {
      ...(state.installations[key] || {}),
      ideVersion: version,
      patchedHash: sha256Hex(patched).slice(0, 12),
      activeBackup: bakPath,
      lastPatchedAt: new Date().toISOString(),
    };
    saveState(state, customHome);

    console.log(`IDE: ${ideDir} (version=${version}, appId=${appId})`);
    console.log(`Backup: ${path.basename(bakPath)}`);
    for (const c of changes) {
      console.log(`  + ${c}`);
    }
    return 0;
  }

  console.error('[ERROR] Specify --status, --apply, or --restore');
  return 2;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main };
