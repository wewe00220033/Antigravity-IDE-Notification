'use strict';

/**
 * Single-source-of-truth patcher for `extensions/agy/vscode/extension.js` (L2 layer).
 * Supports Antigravity IDE v2.6, v2.8, v1-patched v2.8, and future v2.9+ builds via
 * minifier-agnostic structural anchors, strict `count === 1` checks, RTL preservation,
 * and version+SHA256-keyed backups tracked in `state.json`.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { loadConfig, loadState, saveState } = require('./config_store');

const PATCH_START = '/* AGY-NOTIF-PATCH-START */';
const PATCH_END = '/* AGY-NOTIF-PATCH-END */';
const RTL_START = '/* RTL-PATCH-START */';
const WIN_TOAST_MARKER = '/*AGY_WIN_TOAST_V2*/';
const OUTER_MARKER = '/*AGY_OUTER_V2*/';
const INNER_MARKER = '/*AGY_INNER_V2*/';

const RE_APP_ID = /([A-Za-z_$][\w$]*\.AGY_NOTIFY_APP_ID\s*=\s*)"([^"]+)"/g;
const RE_RWH_4ARGS = /(renderWebviewHtml\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{)(if\(globalThis\.__rtlChatProxyUrl\)\4=globalThis\.__rtlChatProxyUrl\(\4\);)?(if\(globalThis\.__agyNotifProxyUrl\)\4=globalThis\.__agyNotifProxyUrl\(\4\);)?/g;
const RE_SHOW_WIN_HEADER = /(showWindowsNotification\(([A-Za-z_$][\w$]*),\s*(?:\/\/[^\n]*\n\s*)?([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{[\s\S]{0,180}?delete\s+([A-Za-z_$][\w$]*)\.ELECTRON_RUN_AS_NODE;)\6\.AGY_NOTIFY_APP_ID="[^"]+";[\s\S]{0,650}?\6\.AGY_NOTIFY_URI=\4;(?:\/\*AGY_WIN_TOAST_V2\*\/)?/g;
const RE_START_APPS_ORIG = /(\$App\s*=\s*\$Apps\s*\|\s*Where-Object\s*\{\$_\.Name\s*-like\s*"\*Visual Studio Code\*"\})(\s*\|\s*Select-Object\s*-First\s*1)/g;
const RE_PS_TEXT2_ORIG = /\(\$RawXml\.toast\.visual\.binding\.text\s*\|\s*Where-Object\s*\{\$_\.id\s*-eq\s*\\'2\\'\}\)\.AppendChild\(\$RawXml\.CreateTextNode\(\$env:AGY_NOTIFY_BODY\)\)\s*\|\s*Out-Null/g;
const RE_OUTER_NOTIFY = /(async showBrowserNotification\(([A-Za-z_$][\w$]*)\)\{[\s\S]{0,1100}?showBrowserNotification\(\2,\{isConversationVisible:([A-Za-z_$][\w$]*)\}\)[\s\S]{0,80}?return\{\}\}finally\{[\s\S]{0,20}\}\}\s*async showNotification\(\2\)\{[\s\S]{0,180}?&&!([A-Za-z_$][\w$]*)\.window\.state\.focused)/g;
const RE_OUTER_FOCUS_STMT = /(?:if\(globalThis\.__agyNotifPreFilter[\s\S]{0,460}?return\{\};?\}\/\*AGY_OUTER_V2\*\/|if\((?:!1|[A-Za-z_$][\w$]*\.window\.state\.focused&&[A-Za-z_$][\w$]*&&\([A-Za-z_$][\w$]*\|\|[A-Za-z_$][\w$]*\))\)return\{\};)/g;
const RE_INNER_NOTIFY = /(async showBrowserNotification\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{[\s\S]{0,520}?([A-Za-z_$][\w$]*)=\(\)=>\{[\s\S]{0,160}?this\.showOpenChatToast\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*\)\}(?:,[A-Za-z_$][\w$]*)?;)(?:!1\?\4\(\):|\(\(([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.window\.state\)==null\?0:\5\.focused\)\?\4\(\):|\(globalThis\.__agyNotifShouldSkipInner\?globalThis\.__agyNotifShouldSkipInner\(([A-Za-z_$][\w$]*)\):!1\)\/\*AGY_INNER_V2\*\/\?\4\(\):)?((?:[A-Za-z_$][\w$]*\(await\s+[A-Za-z_$][\w$]*\()?(?:this\.showSystemNotification\([^)]*\)))/g;

function buildRuntimeHeader() {
  return [
    PATCH_START,
    `;(function(){try{`,
    `var os=require("os"),p=require("path");`,
    `var d=process.env.AGY_NOTIF_HOME||p.join(os.homedir(),".antigravity-notifications");`,
    `var m=require(p.join(d,"core","proxy_runtime.js"));`,
    `if(m&&typeof m.initRuntime==="function")m.initRuntime(d);`,
    `}catch(_){}})();`,
    PATCH_END,
  ].join('\n');
}

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Remove our self-contained runtime header if present without touching RTL markers.
 * @param {string} source
 * @returns {string}
 */
function stripNotifHeader(source) {
  const start = source.indexOf(PATCH_START);
  const end = source.indexOf(PATCH_END);
  if (start === -1 || end === -1 || end < start) return source;
  const after = source.slice(end + PATCH_END.length).replace(/^\r?\n/, '');
  return source.slice(0, start) + after;
}

/**
 * Inspect extension.js patch status across all 6 capabilities.
 * @param {string} text
 * @param {string} [expectedAppId]
 */
function inspectExtensionStatus(text, expectedAppId = 'Google.AntigravityIDE') {
  const appMatch = /([A-Za-z_$][\w$]*\.AGY_NOTIFY_APP_ID\s*=\s*)"([^"]+)"/.exec(text);
  const currentAppId = appMatch ? appMatch[2] : null;
  const fallbackOk = text.includes('-or $_.Name -like "*Antigravity*"');
  const winToastHookOk = text.includes(WIN_TOAST_MARKER) && text.includes('AGY_NOTIFY_SILENT');
  const outerHookOk = text.includes(OUTER_MARKER);
  const innerHookOk = text.includes(INNER_MARKER);
  const proxyHookOk = text.includes('globalThis.__agyNotifProxyUrl');
  const runtimeHeaderOk = text.includes(PATCH_START) && text.includes(PATCH_END);
  const rtlPresent = text.includes(RTL_START) || text.includes('globalThis.__rtlChatProxyUrl');

  const allOk = (
    currentAppId === expectedAppId &&
    fallbackOk &&
    winToastHookOk &&
    outerHookOk &&
    innerHookOk &&
    proxyHookOk &&
    runtimeHeaderOk
  );

  return {
    appIdValue: currentAppId,
    appIdOk: currentAppId === expectedAppId,
    fallbackOk,
    winToastHookOk,
    outerHookOk,
    innerHookOk,
    proxyHookOk,
    runtimeHeaderOk,
    rtlPresent,
    allOk,
  };
}

/**
 * Apply all v2 notification hooks idempotently onto `extensions/agy/vscode/extension.js`.
 * Fails fast on any anchor ambiguity (`count !== 1`) so an unexpected future IDE build
 * leaves `extension.js` untouched.
 * @param {string} text
 * @param {string} [appId]
 * @returns {{ content: string, changes: string[] }}
 */
function patchExtensionSource(text, appId = 'Google.AntigravityIDE') {
  let out = text;
  const changes = [];

  // 1. Runtime header at top (always kept above RTL / main bundle without altering RTL block)
  const expectedHeader = buildRuntimeHeader();
  if (!out.includes(expectedHeader)) {
    out = stripNotifHeader(out);
    out = `${expectedHeader}\n${out}`;
    changes.push('Injected self-contained notification runtime loader');
  }

  // 2. renderWebviewHtml hook chained AFTER __rtlChatProxyUrl + MAX_ATTEMPTS >= 16
  const rwhMatches = out.match(RE_RWH_4ARGS) || [];
  if (rwhMatches.length !== 1) {
    throw new Error(`Anchor mismatch: expected 1 renderWebviewHtml(4args), found ${rwhMatches.length}`);
  }
  out = out.replace(RE_RWH_4ARGS, (full, head, _w, _o, cArg, _o2, rtlStmt, notifStmt) => {
    const rtlPart = rtlStmt || '';
    const expectedNotif = `if(globalThis.__agyNotifProxyUrl)${cArg}=globalThis.__agyNotifProxyUrl(${cArg});`;
    if (notifStmt === expectedNotif) return full;
    changes.push('Hooked renderWebviewHtml notification proxy (chained cleanly after RTL)');
    return `${head}${rtlPart}${expectedNotif}`;
  });

  if (out.includes('const MAX_ATTEMPTS = 6;')) {
    out = out.replace('const MAX_ATTEMPTS = 6;', 'const MAX_ATTEMPTS = 16;');
    changes.push('Widened iframe watchdog MAX_ATTEMPTS 6 -> 16');
  }

  // 3. showWindowsNotification hook + AppID + silent audio + clean 1-line title
  const winMatches = out.match(RE_SHOW_WIN_HEADER) || [];
  if (winMatches.length !== 1) {
    throw new Error(`Anchor mismatch: expected 1 showWindowsNotification block, found ${winMatches.length}`);
  }
  out = out.replace(RE_SHOW_WIN_HEADER, (full, prefix, aArg, bArg, cArg, _dArg, envVar) => {
    const replacement = (
      `${prefix}${envVar}.AGY_NOTIFY_APP_ID="${appId}";` +
      `var __aw=globalThis.__agyNotifFormatWinToast?globalThis.__agyNotifFormatWinToast(${aArg},${bArg}):` +
      `{title:${aArg}==="Antigravity"?(String(${bArg}||${aArg}).replace(/^Agent finished:\\s*/,"")||"Agent finished"):${aArg},body:${aArg}==="Antigravity"?"":(${bArg}||""),silent:!1};` +
      `${envVar}.AGY_NOTIFY_TITLE=__aw.title;${envVar}.AGY_NOTIFY_BODY=__aw.body||"";` +
      `${envVar}.AGY_NOTIFY_SILENT=__aw.silent?"1":"0";${envVar}.AGY_NOTIFY_URI=${cArg};${WIN_TOAST_MARKER}`
    );
    if (full === replacement) return full;
    changes.push(`Updated showWindowsNotification formatter + silent hook (appId=${appId})`);
    return replacement;
  });

  // 4. StartApps fallback (*Antigravity*)
  if (!out.includes('-or $_.Name -like "*Antigravity*"')) {
    const fbMatches = out.match(RE_START_APPS_ORIG) || [];
    if (fbMatches.length !== 1) {
      throw new Error(`Anchor mismatch: expected 1 StartApps fallback, found ${fbMatches.length}`);
    }
    out = out.replace(
      RE_START_APPS_ORIG,
      '($App = $Apps | Where-Object {$_.Name -like "*Visual Studio Code*" -or $_.Name -like "*Antigravity*"})$2'
    );
    changes.push('Added *Antigravity* fallback to StartApps query');
  }

  // 5. PowerShell XML conditional text id='2' + <audio silent="true" />
  if (!out.includes('AGY_NOTIFY_SILENT')) {
    throw new Error('Internal error: AGY_NOTIFY_SILENT env injection missing before PS XML patch');
  }
  if (!out.includes("if ($env:AGY_NOTIFY_SILENT -eq \"1\")")) {
    const ps2Matches = out.match(RE_PS_TEXT2_ORIG) || [];
    if (ps2Matches.length !== 1) {
      throw new Error(`Anchor mismatch: expected 1 PS text id=2 node, found ${ps2Matches.length}`);
    }
    out = out.replace(
      RE_PS_TEXT2_ORIG,
      `if ($env:AGY_NOTIFY_BODY) { ($RawXml.toast.visual.binding.text | Where-Object {$_.id -eq \\'2\\'}).AppendChild($RawXml.CreateTextNode($env:AGY_NOTIFY_BODY)) | Out-Null }; if ($env:AGY_NOTIFY_SILENT -eq "1") { $AgAudio = $RawXml.CreateElement("audio"); $AgAudio.SetAttribute("silent", "true"); $RawXml.toast.AppendChild($AgAudio) | Out-Null }`
    );
    changes.push('Added conditional body + <audio silent="true"/> support to Windows Toast XML');
  }

  // 6. Outer showBrowserNotification pre-filter + focus control
  const outerMatches = out.match(RE_OUTER_NOTIFY) || [];
  if (outerMatches.length !== 1) {
    throw new Error(`Anchor mismatch: expected 1 outer showBrowserNotification handler, found ${outerMatches.length}`);
  }
  let winIdentFromOuter = null;
  out = out.replace(RE_OUTER_NOTIFY, (block, _full, actArg, visArg, winIdent) => {
    winIdentFromOuter = winIdent;
    if (block.includes(OUTER_MARKER)) return block;
    const focusMatches = block.match(RE_OUTER_FOCUS_STMT) || [];
    if (focusMatches.length !== 1) {
      throw new Error(`Anchor mismatch: expected 1 outer focus statement, found ${focusMatches.length}`);
    }
    const injected = (
      `if(globalThis.__agyNotifPreFilter){var __apf=globalThis.__agyNotifPreFilter(${actArg},{focused:Boolean(${winIdent}.window.state.focused),isConversationVisible:Boolean(${visArg})});` +
      `if(__apf&&__apf.drop)return{};if(__apf&&__apf.payload)${actArg}={...${actArg},payload:__apf.payload}}${OUTER_MARKER}`
    );
    changes.push('Patched outer showBrowserNotification with live pre-filter');
    return block.replace(RE_OUTER_FOCUS_STMT, injected);
  });

  // 7. Inner showBrowserNotification focus bypass + Open Chat banner toggle
  const innerMatches = out.match(RE_INNER_NOTIFY) || [];
  if (innerMatches.length !== 1) {
    throw new Error(`Anchor mismatch: expected 1 inner showBrowserNotification delegate, found ${innerMatches.length}`);
  }
  out = out.replace(RE_INNER_NOTIFY, (full, prefix, _actArg, optsArg, cbVar, _uVar, winVar, prevWinVar, suffix) => {
    const winRef = winVar || prevWinVar || winIdentFromOuter || 'n';
    let updatedPrefix = prefix;
    const toastRe = new RegExp(`\\(\\(${optsArg}==null\\?0:${optsArg}\\.isConversationVisible\\)\\|\\|this\\.showOpenChatToast`);
    if (toastRe.test(updatedPrefix)) {
      updatedPrefix = updatedPrefix.replace(
        toastRe,
        `(((${optsArg}==null?0:${optsArg}.isConversationVisible)&&!(globalThis.__agyNotifAllowOpenChatBanner&&globalThis.__agyNotifAllowOpenChatBanner()))||this.showOpenChatToast`
      );
    }
    const focusExpr = `(globalThis.__agyNotifShouldSkipInner?globalThis.__agyNotifShouldSkipInner(${winRef}):!1)${INNER_MARKER}?${cbVar}():`;
    const next = `${updatedPrefix}${focusExpr}${suffix}`;
    if (full === next) {
      return full;
    }
    changes.push('Patched inner showBrowserNotification focus guard & same-chat banner rule');
    return next;
  });

  return { content: out, changes };
}

/**
 * Copy core runtime and default config into persistent `%USERPROFILE%\.antigravity-notifications\`.
 * @param {string} repoNotifDir
 * @param {string} [customHome]
 */
function deployPersistentRuntime(repoNotifDir, customHome) {
  const { getDataDir } = require('./config_store');
  const dataDir = getDataDir(customHome);
  const coreDst = path.join(dataDir, 'core');
  const cfgDst = path.join(dataDir, 'config');
  fs.mkdirSync(coreDst, { recursive: true });
  fs.mkdirSync(cfgDst, { recursive: true });

  const coreSrc = path.join(repoNotifDir, 'core');
  for (const name of fs.readdirSync(coreSrc)) {
    if (name.endsWith('.js')) {
      fs.copyFileSync(path.join(coreSrc, name), path.join(coreDst, name));
    }
  }
  const defCfgSrc = path.join(repoNotifDir, 'config', 'default_config.json');
  if (fs.existsSync(defCfgSrc)) {
    fs.copyFileSync(defCfgSrc, path.join(cfgDst, 'default_config.json'));
  }
  loadConfig(customHome);
  return dataDir;
}

/**
 * Record version + SHA-256 backup safely so --restore never restores across mismatched IDE versions.
 */
function ensureVersionedBackup(ideDir, extPath, rawOriginalContent, ideVersion, customHome) {
  const extDir = path.dirname(extPath);
  const unpatchedOrCurHash = sha256Hex(rawOriginalContent).slice(0, 12);
  const safeVer = String(ideVersion || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  const state = loadState(customHome);
  const key = path.resolve(ideDir).toLowerCase();
  const entry = state.installations[key] || { backups: {} };
  if (!entry.backups || typeof entry.backups !== 'object') entry.backups = {};

  // Reuse if we already backed up this exact (version, patchedOrOriginalHash) OR migrate cleanly from v1 backup
  const curStatus = inspectExtensionStatus(rawOriginalContent);
  const isV1Patched = rawOriginalContent.includes('if(!1)return{};') && !curStatus.outerHookOk;
  const isFreshUnpatched = !isV1Patched && !curStatus.allOk && !curStatus.outerHookOk && !curStatus.innerHookOk && !curStatus.winToastHookOk;

  const sigKey = `${safeVer}__${unpatchedOrCurHash}`;
  let chosenBakPath = null;

  if (isFreshUnpatched) {
    const bakName = `extension.js.notif_v${safeVer}_${unpatchedOrCurHash}.bak`;
    chosenBakPath = path.join(extDir, bakName);
    if (!fs.existsSync(chosenBakPath)) {
      fs.writeFileSync(chosenBakPath, rawOriginalContent, 'utf8');
    }
    entry.originalHash = unpatchedOrCurHash;
  } else {
    // Already patched (e.g. migrating from v1 extension.js.notif_280_bak or v2)
    for (const candidateName of [`extension.js.notif_v${safeVer}_`, 'extension.js.notif_280_bak', 'extension.js.notif_bak']) {
      const files = fs.readdirSync(extDir).filter((f) => f.startsWith(candidateName) && f.endsWith('bak'));
      if (files.length > 0) {
        chosenBakPath = path.join(extDir, files[0]);
        break;
      }
    }
    if (!chosenBakPath) {
      const fallbackBak = path.join(extDir, `extension.js.notif_v${safeVer}_${unpatchedOrCurHash}.pre_v2.bak`);
      if (!fs.existsSync(fallbackBak)) {
        fs.writeFileSync(fallbackBak, rawOriginalContent, 'utf8');
      }
      chosenBakPath = fallbackBak;
    }
  }

  entry.ideVersion = ideVersion;
  entry.lastPatchedAt = new Date().toISOString();
  entry.activeBackup = chosenBakPath;
  entry.backups[sigKey] = chosenBakPath;
  state.installations[key] = entry;
  saveState(state, customHome);
  return chosenBakPath;
}

/**
 * Restore backup strictly matching current IDE version (rejects mismatched cross-version restores).
 */
function restoreVersionedBackup(ideDir, extPath, ideVersion, customHome) {
  const state = loadState(customHome);
  const key = path.resolve(ideDir).toLowerCase();
  const entry = state.installations[key];
  const extDir = path.dirname(extPath);
  const safeVer = String(ideVersion || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');

  let targetBak = null;
  if (entry && entry.ideVersion === ideVersion && entry.activeBackup && fs.existsSync(entry.activeBackup)) {
    targetBak = entry.activeBackup;
  } else {
    const matched = fs.readdirSync(extDir).filter((f) => f.startsWith(`extension.js.notif_v${safeVer}_`) && f.endsWith('.bak'));
    if (matched.length > 0) {
      targetBak = path.join(extDir, matched[0]);
    } else if (!entry && fs.existsSync(path.join(extDir, 'extension.js.notif_280_bak')) && ideVersion === '2.8.0') {
      targetBak = path.join(extDir, 'extension.js.notif_280_bak');
    }
  }

  if (!targetBak) {
    throw new Error(
      `Refused restore: no backup matching current IDE version (${ideVersion}). ` +
      (entry ? `Stored backup belongs to ${entry.ideVersion}.` : 'No state entry found.')
    );
  }

  fs.copyFileSync(targetBak, extPath);
  return targetBak;
}

module.exports = {
  PATCH_START,
  PATCH_END,
  RTL_START,
  WIN_TOAST_MARKER,
  OUTER_MARKER,
  INNER_MARKER,
  buildRuntimeHeader,
  stripNotifHeader,
  sha256Hex,
  inspectExtensionStatus,
  patchExtensionSource,
  deployPersistentRuntime,
  ensureVersionedBackup,
  restoreVersionedBackup,
};
