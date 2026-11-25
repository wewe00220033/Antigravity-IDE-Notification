'use strict';

/**
 * Notification classifier, template formatter, sound policy resolver, and deduper.
 * Verified against Antigravity IDE (v2.6-v2.8) and agy.exe Hub (v2.34+):
 * all E$a notifications emit payload.type === "request_action", so event type
 * is classified safely from id prefix ("agent-finished-") and known titles.
 */

const { normalizeConfig } = require('./config_store');

/**
 * Classify a notification payload into one of:
 * finished | askQuestion | runCommand | openBrowserUrl | permission | unknown.
 * @param {{ id?: string, title?: string, body?: string } | null | undefined} payload
 * @returns {string}
 */
function classifyNotification(payload) {
  if (!payload || typeof payload !== 'object') return 'unknown';
  const id = typeof payload.id === 'string' ? payload.id : '';
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';

  if (id.startsWith('agent-finished-')) return 'finished';
  if (/^The agent has (?:a\s+)?questions? for you:/i.test(title)) return 'askQuestion';
  if (/^Requesting your permission in Terminal:/i.test(title)) return 'runCommand';
  if (/^Requesting your permission to open URL:/i.test(title)) return 'openBrowserUrl';
  if (/^Requesting your permission:/i.test(title) || /^Action requires your attention$/i.test(title)) {
    return 'permission';
  }
  return 'unknown';
}

/**
 * Remove configured leading prefixes (e.g., "Agent finished: ") cleanly.
 * @param {string} text
 * @param {string[]} stripPrefixes
 * @returns {string}
 */
function stripLeadingPrefixes(text, stripPrefixes) {
  let out = typeof text === 'string' ? text.trim() : '';
  if (!out || !Array.isArray(stripPrefixes)) return out;

  for (const prefix of stripPrefixes) {
    if (!prefix) continue;
    if (out.startsWith(prefix)) {
      out = out.slice(prefix.length).trim();
    } else if (out.toLowerCase().startsWith(prefix.toLowerCase())) {
      out = out.slice(prefix.length).trim();
    }
  }
  return out;
}

/**
 * Render simple "{key}" placeholders cleanly without leaving raw artifacts.
 * @param {string} template
 * @param {Record<string, string>} vars
 * @returns {string}
 */
function renderTemplate(template, vars) {
  if (typeof template !== 'string' || !template) return '';
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : ''
  )).trim();
}

/**
 * Resolve Windows Toast silent flag according to config.soundMode and upstream silent flag.
 * @param {string} soundMode
 * @param {boolean} upstreamSilent
 * @returns {boolean}
 */
function resolveWindowsSilent(soundMode, upstreamSilent) {
  switch (soundMode) {
    case 'windows':
    case 'both':
      return false;
    case 'antigravity':
    case 'silent':
      return true;
    case 'respectPayload':
    default:
      return Boolean(upstreamSilent);
  }
}

/**
 * Evaluate filtering, formatting, sound, and Open Chat toast policy for one notification.
 * @param {object} rawPayload Raw `a.payload` from extension.js (`{ id, title, body, silent, cascadeId, path }`).
 * @param {object} rawConfig Config object (normalized if partial).
 * @param {{ focused?: boolean, isConversationVisible?: boolean, nowMs?: number }} [context]
 * @returns {{ drop: boolean, reason: string | null, eventType: string, title: string, body: string, openChatText: string, silent: boolean, suppressOpenChatToast: boolean }}
 */
function formatNotification(rawPayload, rawConfig, context = {}) {
  const config = normalizeConfig(rawConfig);
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  const focused = Boolean(context.focused);
  const isConversationVisible = Boolean(context.isConversationVisible);
  const eventType = classifyNotification(payload);
  const eventRule = config.events[eventType] || config.events.unknown;

  if (!config.enabled) {
    return {
      drop: true,
      reason: 'disabled',
      eventType,
      title: '',
      body: '',
      openChatText: '',
      silent: true,
      suppressOpenChatToast: true,
    };
  }

  if (!eventRule.enabled) {
    return {
      drop: true,
      reason: `event_disabled:${eventType}`,
      eventType,
      title: '',
      body: '',
      openChatText: '',
      silent: true,
      suppressOpenChatToast: true,
    };
  }

  if (focused && !config.notifyWhenFocused) {
    return {
      drop: true,
      reason: 'window_focused',
      eventType,
      title: '',
      body: '',
      openChatText: '',
      silent: true,
      suppressOpenChatToast: true,
    };
  }

  if (isConversationVisible && !config.notifySameActiveChat) {
    return {
      drop: true,
      reason: 'same_active_chat',
      eventType,
      title: '',
      body: '',
      openChatText: '',
      silent: true,
      suppressOpenChatToast: true,
    };
  }

  const origTitle = typeof payload.title === 'string' && payload.title.trim()
    ? payload.title.trim()
    : 'Antigravity';
  const rawBody = typeof payload.body === 'string' ? payload.body.trim() : '';

  let cleanBody = rawBody;
  if (eventType === 'finished') {
    cleanBody = stripLeadingPrefixes(rawBody, config.stripPrefixes);
    if (!cleanBody || cleanBody === 'Agent finished') {
      cleanBody = config.fallbackFinishedText || 'Agent finished';
    }
  }

  const vars = {
    title: origTitle,
    body: cleanBody || origTitle,
    rawBody,
    appName: 'Antigravity',
  };

  let outTitle;
  let outBody;

  if (eventType === 'unknown') {
    outTitle = origTitle === 'Antigravity' ? (cleanBody || origTitle) : `Antigravity \u2014 ${origTitle}`;
    outBody = origTitle === 'Antigravity' ? '' : cleanBody;
  } else {
    outTitle = renderTemplate(eventRule.titleTemplate, vars);
    outBody = renderTemplate(eventRule.bodyTemplate, vars);

    if (!outTitle && outBody) {
      outTitle = outBody;
      outBody = '';
    }
    if (!outTitle) {
      outTitle = cleanBody || origTitle;
    }
  }

  // Never duplicate identical line 1 and line 2
  if (outBody && outBody === outTitle) {
    outBody = '';
  }

  const openChatText = outBody ? `${outTitle}: ${outBody}` : outTitle;
  const silent = resolveWindowsSilent(config.soundMode, Boolean(payload.silent));
  const suppressOpenChatToast = isConversationVisible && !config.showOpenChatBannerInSameChat;

  return {
    drop: false,
    reason: null,
    eventType,
    title: outTitle,
    body: outBody,
    openChatText,
    silent,
    suppressOpenChatToast,
  };
}

/**
 * Format direct showWindowsNotification arguments safely even if caller came from an
 * un-tagged upstream path (e.g. "Antigravity" + "Agent finished: title").
 * @param {string} rawTitle
 * @param {string} rawBody
 * @param {object} rawConfig
 * @param {{ silent?: boolean }} [meta]
 * @returns {{ title: string, body: string, silent: boolean }}
 */
function formatDirectToastArgs(rawTitle, rawBody, rawConfig, meta = {}) {
  const config = normalizeConfig(rawConfig);
  const titleStr = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  const bodyStr = typeof rawBody === 'string' ? rawBody.trim() : '';
  const looksFinished = titleStr === 'Antigravity' || bodyStr.startsWith('Agent finished');

  if (looksFinished) {
    const formatted = formatNotification(
      {
        id: 'agent-finished-direct',
        title: titleStr || 'Antigravity',
        body: bodyStr,
        silent: Boolean(meta && meta.silent),
      },
      config,
      { focused: false, isConversationVisible: false }
    );
    return {
      title: formatted.title || titleStr || 'Antigravity',
      body: formatted.body,
      silent: formatted.silent,
    };
  }

  return {
    title: titleStr || bodyStr || 'Antigravity',
    body: titleStr && bodyStr && bodyStr !== titleStr ? bodyStr : '',
    silent: resolveWindowsSilent(config.soundMode, Boolean(meta && meta.silent)),
  };
}

/**
 * Deduplicate rapid identical notifications within dedupeWindowMs.
 */
class NotificationDeduplicator {
  constructor(maxEntries = 100) {
    this.maxEntries = maxEntries;
    /** @type {Map<string, number>} */
    this.seen = new Map();
  }

  /**
   * Return true if the notification key should be suppressed as a recent duplicate.
   * @param {string} key
   * @param {number} windowMs
   * @param {number} [nowMs]
   * @returns {boolean}
   */
  isDuplicate(key, windowMs, nowMs = Date.now()) {
    if (!key || !windowMs || windowMs <= 0) return false;
    const prev = this.seen.get(key);
    if (prev !== undefined && (nowMs - prev) < windowMs) {
      return true;
    }
    if (this.seen.has(key)) {
      this.seen.delete(key);
    }
    this.seen.set(key, nowMs);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return false;
  }

  clear() {
    this.seen.clear();
  }
}

module.exports = {
  classifyNotification,
  stripLeadingPrefixes,
  renderTemplate,
  resolveWindowsSilent,
  formatNotification,
  formatDirectToastArgs,
  NotificationDeduplicator,
};
