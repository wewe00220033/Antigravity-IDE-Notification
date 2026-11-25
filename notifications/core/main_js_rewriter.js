'use strict';

/**
 * Minifier-agnostic rewriter for agy.exe webview `/main.js` (Option C).
 * Uses 3 structural anchors verified to appear uniquely (count === 1) without
 * spoofing global `document.hasFocus()` across unrelated UI/Lexical editor paths.
 *
 * Uses strict-mode-safe optional chaining against `globalThis.__AGY_NOTIF_CFG__`
 * (served dynamically at `/__agy_notif_cfg.js`), falling back to raw `/main.js`
 * if any anchor count !== 1.
 */

const RE_IS_CONV_IN_VIEW = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.isConversationInView;/g;
const RE_AGENT_FINISHED_BODY = /body:([A-Za-z_$][\w$]*)\?`Agent finished: \$\{\1\}`:"Agent finished"/g;
const RE_EXT_HAS_FOCUS = /typeof document!=="undefined"&&document\.hasFocus\(\)\|\|(this\.extensionApi\.showBrowserNotification\()/g;
const MARKER = '/*__AGY_NOTIF_WEBVIEW_REWRITTEN__*/';

/**
 * Inspect anchor counts without mutating input.
 * @param {string} source
 */
function inspectMainJsAnchors(source) {
  if (typeof source !== 'string') {
    return {
      alreadyRewritten: false,
      isConversationInView: 0,
      agentFinishedBody: 0,
      extHasFocusGuard: 0,
      readyToRewrite: false,
    };
  }
  const alreadyRewritten = source.includes(MARKER);
  const c1 = (source.match(RE_IS_CONV_IN_VIEW) || []).length;
  const c2 = (source.match(RE_AGENT_FINISHED_BODY) || []).length;
  const c3 = (source.match(RE_EXT_HAS_FOCUS) || []).length;

  return {
    alreadyRewritten,
    isConversationInView: c1,
    agentFinishedBody: c2,
    extHasFocusGuard: c3,
    readyToRewrite: !alreadyRewritten && c1 === 1 && c2 === 1 && c3 === 1,
  };
}

/**
 * Rewrite webview `/main.js` cleanly. Returns safe pass-through output if any anchor
 * fails strict count === 1 validation, so UI breakage never occurs across future builds.
 * @param {string} source
 * @returns {{ code: string, rewritten: boolean, reason: string | null, anchors: ReturnType<typeof inspectMainJsAnchors> }}
 */
function rewriteMainJs(source) {
  const anchors = inspectMainJsAnchors(source);
  if (anchors.alreadyRewritten) {
    return { code: source, rewritten: true, reason: null, anchors };
  }
  if (
    anchors.isConversationInView !== 1 ||
    anchors.agentFinishedBody !== 1 ||
    anchors.extHasFocusGuard !== 1
  ) {
    const failed = [];
    if (anchors.isConversationInView !== 1) failed.push(`isConversationInView=${anchors.isConversationInView}`);
    if (anchors.agentFinishedBody !== 1) failed.push(`agentFinishedBody=${anchors.agentFinishedBody}`);
    if (anchors.extHasFocusGuard !== 1) failed.push(`extHasFocusGuard=${anchors.extHasFocusGuard}`);
    return {
      code: source,
      rewritten: false,
      reason: `Anchor mismatch (safe pass-through): ${failed.join(', ')}`,
      anchors,
    };
  }

  let out = source;

  // Anchor 1: Bypass isConversationInView suppression when notifySameActiveChat !== false
  out = out.replace(RE_IS_CONV_IN_VIEW, (_, lhs, obj) => (
    `${lhs}=(globalThis.__AGY_NOTIF_CFG__?.enabled!==!1&&globalThis.__AGY_NOTIF_CFG__?.notifySameActiveChat!==!1)?void 0:${obj}.isConversationInView;`
  ));

  // Anchor 2: Strip "Agent finished: " cleanly according to live config
  out = out.replace(RE_AGENT_FINISHED_BODY, (_, varName) => (
    `body:${varName}?((globalThis.__AGY_NOTIF_CFG__?.enabled!==!1&&globalThis.__AGY_NOTIF_CFG__?.stripFinishedPrefix!==!1)?\`\${${varName}}\`:\`Agent finished: \${${varName}}\`):(globalThis.__AGY_NOTIF_CFG__?.enabled!==!1&&globalThis.__AGY_NOTIF_CFG__?.fallbackFinishedText?globalThis.__AGY_NOTIF_CFG__.fallbackFinishedText:"Agent finished")`
  ));

  // Anchor 3: Allow extensionApi.showBrowserNotification even when webview iframe has DOM focus
  out = out.replace(RE_EXT_HAS_FOCUS, (_, callStart) => (
    `(!(globalThis.__AGY_NOTIF_CFG__?.enabled!==!1&&globalThis.__AGY_NOTIF_CFG__?.notifyWhenFocused!==!1)&&(typeof document!=="undefined"&&document.hasFocus()))||${callStart}`
  ));

  out = `${MARKER}${out}`;
  return { code: out, rewritten: true, reason: null, anchors };
}

module.exports = {
  MARKER,
  RE_IS_CONV_IN_VIEW,
  RE_AGENT_FINISHED_BODY,
  RE_EXT_HAS_FOCUS,
  inspectMainJsAnchors,
  rewriteMainJs,
};
