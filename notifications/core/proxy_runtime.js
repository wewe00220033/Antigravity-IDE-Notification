'use strict';

/**
 * Runtime loaded inside Antigravity extension host (`extensions/agy/vscode/extension.js`).
 * Registers:
 *   1. `globalThis.__agyNotifProxyUrl` (chained local HTTP + WebSocket proxy rewriting `/main.js`
 *      once per ETag + injecting `/__agy_notif_cfg.js` into HTML before `</head>`).
 *   2. Notification hooks (`__agyNotifPreFilter`, `__agyNotifShouldSkipInner`,
 *      `__agyNotifAllowOpenChatBanner`, `__agyNotifRememberSilent`, `__agyNotifFormatWinToast`)
 *      reading `~/.antigravity-notifications/config.json` live with zero restart required.
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const zlib = require('zlib');

const { loadConfig, toWebviewConfig } = require('./config_store');
const { formatNotification, formatDirectToastArgs, NotificationDeduplicator } = require('./formatter');
const { rewriteMainJs } = require('./main_js_rewriter');

const CFG_SCRIPT_PATH = '/__agy_notif_cfg.js';
const MAIN_JS_PATH = '/main.js';
const CFG_TAG = '<script src="/__agy_notif_cfg.js"></script>';

function stripQuery(urlPath) {
  const q = String(urlPath || '/').indexOf('?');
  return q >= 0 ? String(urlPath).slice(0, q) : String(urlPath || '/');
}

function forwardHeaders(headers, targetHost, forcePlainText) {
  const out = Object.assign({}, headers);
  const origin = `http://${targetHost}`;
  out.host = targetHost;
  if (out.origin) out.origin = origin;
  if (out.referer) {
    out.referer = String(out.referer).replace(/^https?:\/\/[^/]+/i, origin);
  }
  if (forcePlainText) {
    delete out['accept-encoding'];
  }
  return out;
}

function decompressBuffer(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (!enc || enc === 'identity') return buf;
  if (enc === 'gzip') return zlib.gunzipSync(buf);
  if (enc === 'deflate') return zlib.inflateSync(buf);
  if (enc === 'br' && typeof zlib.brotliDecompressSync === 'function') {
    return zlib.brotliDecompressSync(buf);
  }
  throw new Error(`Unsupported content-encoding: ${enc}`);
}

/**
 * Start a chained HTTP + WebSocket proxy forwarding to upstream target.
 * Designed to compose cleanly *after* RTL's `globalThis.__rtlChatProxyUrl`.
 * @param {{ customHome?: string, onRewriteFailure?: (reason: string) => void }} [opts]
 */
function createNotificationProxyServer(opts = {}) {
  let proxyPort = 0;
  let target = null;
  /** @type {{ etag: string, codeBuf: Buffer } | null} */
  let mainJsCache = null;
  let lastWarnedReason = null;

  const deduplicator = new NotificationDeduplicator(100);
  const silentQueueMap = new Map();

  const readLiveConfig = () => loadConfig(opts.customHome).config;

  const rememberSilent = (title, body, silent) => {
    const key = `${title || ''}\0${body || ''}`;
    const list = silentQueueMap.get(key) || [];
    list.push({ silent: Boolean(silent), ts: Date.now() });
    if (list.length > 8) list.shift();
    silentQueueMap.set(key, list);
  };

  const consumeSilent = (title, body) => {
    const key = `${title || ''}\0${body || ''}`;
    const list = silentQueueMap.get(key);
    if (!list || list.length === 0) return false;
    const now = Date.now();
    while (list.length > 0 && (now - list[0].ts) > 15000) {
      list.shift();
    }
    const item = list.shift();
    if (list.length === 0) silentQueueMap.delete(key);
    return item ? item.silent : false;
  };

  const server = http.createServer((req, res) => {
    const pathname = stripQuery(req.url);

    // 1. Dynamic live config endpoint (no-store)
    if (pathname === CFG_SCRIPT_PATH && req.method === 'GET') {
      const cfg = readLiveConfig();
      const payload = `globalThis.__AGY_NOTIF_CFG__=${JSON.stringify(toWebviewConfig(cfg))};\n`;
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate',
        'content-length': Buffer.byteLength(payload, 'utf8'),
      });
      res.end(payload);
      return;
    }

    if (!target) {
      res.writeHead(502);
      res.end('Upstream target not set');
      return;
    }

    const isHtmlCandidate = req.method === 'GET' && (pathname === '/' || pathname === '/index.html');
    const isMainJs = req.method === 'GET' && pathname === MAIN_JS_PATH;
    const shouldInspect = isHtmlCandidate || isMainJs;

    const upReq = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req.headers, target.host, shouldInspect),
      },
      (upRes) => {
        const ctype = String(upRes.headers['content-type'] || '').toLowerCase();
        const isHtml = isHtmlCandidate && ctype.includes('text/html');
        const isJs = isMainJs && (ctype.includes('javascript') || ctype.includes('ecmascript'));

        if (!isHtml && !isJs) {
          res.writeHead(upRes.statusCode || 200, upRes.headers);
          upRes.pipe(res);
          return;
        }

        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
          const rawBuf = Buffer.concat(chunks);
          let plainBuf = rawBuf;
          try {
            if (upRes.headers['content-encoding']) {
              plainBuf = decompressBuffer(rawBuf, upRes.headers['content-encoding']);
            }
          } catch (_) {
            // Safe pass-through on unknown compression
            res.writeHead(upRes.statusCode || 200, upRes.headers);
            res.end(rawBuf);
            return;
          }

          let outBuf;
          if (isHtml) {
            let html = plainBuf.toString('utf8');
            if (!html.includes(CFG_SCRIPT_PATH)) {
              html = html.includes('</head>')
                ? html.replace('</head>', `${CFG_TAG}</head>`)
                : `${CFG_TAG}${html}`;
            }
            outBuf = Buffer.from(html, 'utf8');
          } else {
            const upEtag = String(upRes.headers.etag || `len-${plainBuf.length}`);
            if (mainJsCache && mainJsCache.etag === upEtag) {
              outBuf = mainJsCache.codeBuf;
            } else {
              const source = plainBuf.toString('utf8');
              const result = rewriteMainJs(source);
              if (result.rewritten) {
                outBuf = Buffer.from(result.code, 'utf8');
                mainJsCache = { etag: upEtag, codeBuf: outBuf };
              } else {
                outBuf = plainBuf;
                if (result.reason && result.reason !== lastWarnedReason) {
                  lastWarnedReason = result.reason;
                  if (typeof opts.onRewriteFailure === 'function') {
                    opts.onRewriteFailure(result.reason);
                  } else {
                    console.warn(`[AgyNotifProxy] ${result.reason}`);
                  }
                }
              }
            }
          }

          const outHeaders = Object.assign({}, upRes.headers);
          delete outHeaders['transfer-encoding'];
          delete outHeaders['content-encoding'];
          outHeaders['content-length'] = outBuf.length;
          res.writeHead(upRes.statusCode || 200, outHeaders);
          res.end(outBuf);
        });
      }
    );

    upReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upReq);
  });

  server.on('upgrade', (req, socket, head) => {
    if (!target) {
      socket.destroy();
      return;
    }
    const up = net.connect(target.port, target.hostname, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      const headers = forwardHeaders(req.headers, target.host, false);
      for (const key of Object.keys(headers)) {
        for (const value of [].concat(headers[key])) {
          raw += `${key}: ${value}\r\n`;
        }
      }
      up.write(`${raw}\r\n`);
      if (head && head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const kill = () => {
      socket.destroy();
      up.destroy();
    };
    up.on('error', kill);
    socket.on('error', kill);
  });

  server.on('error', () => {
    proxyPort = 0;
  });

  const rewriteUrl = (url) => {
    try {
      if (!proxyPort && server.listening) {
        const addr = server.address();
        if (addr && typeof addr === 'object' && addr.port) proxyPort = addr.port;
      }
      if (!proxyPort) return url;
      const cfg = readLiveConfig();
      if (!cfg.enabled) return url;

      const u = new URL(url);
      if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) {
        return url;
      }
      if (Number(u.port) === proxyPort) return url;
      target = { hostname: u.hostname, port: Number(u.port) || 80, host: u.host };
      u.port = String(proxyPort);
      return u.toString();
    } catch (_) {
      return url;
    }
  };

  const listenPromise = new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      proxyPort = addr && typeof addr === 'object' ? addr.port : 0;
      resolve(proxyPort);
    });
  });

  if (typeof server.unref === 'function') {
    server.unref();
  }

  return {
    server,
    listenPromise,
    getPort: () => proxyPort,
    rewriteUrl,
    clearCache: () => { mainJsCache = null; },
    preFilter: (action, viewState = {}) => {
      const cfg = readLiveConfig();
      const rawPayload = action && action.payload ? action.payload : null;
      if (!rawPayload) return { drop: false, payload: rawPayload };

      const dedupeKey = `${rawPayload.cascadeId || ''}|${rawPayload.id || ''}|${rawPayload.title || ''}|${rawPayload.body || ''}`;
      if (cfg.dedupeWindowMs > 0 && deduplicator.isDuplicate(dedupeKey, cfg.dedupeWindowMs)) {
        return { drop: true, payload: null, reason: 'deduplicated' };
      }

      const result = formatNotification(rawPayload, cfg, {
        focused: Boolean(viewState.focused),
        isConversationVisible: Boolean(viewState.isConversationVisible),
      });
      if (result.drop) {
        return { drop: true, payload: null, reason: result.reason };
      }

      rememberSilent(result.title, result.body, result.silent);
      return {
        drop: false,
        payload: {
          ...rawPayload,
          title: result.title,
          body: result.body,
          silent: result.silent,
          _agyFormatted: true,
        },
      };
    },
    shouldSkipInner: (winModuleOrBool) => {
      const isFocused = typeof winModuleOrBool === 'boolean'
        ? winModuleOrBool
        : Boolean(winModuleOrBool && winModuleOrBool.window && winModuleOrBool.window.state && winModuleOrBool.window.state.focused);
      const cfg = readLiveConfig();
      if (!cfg.enabled) return isFocused;
      return cfg.notifyWhenFocused ? false : isFocused;
    },
    allowOpenChatBannerInSameChat: () => {
      const cfg = readLiveConfig();
      return Boolean(cfg.showOpenChatBannerInSameChat);
    },
    formatWinToast: (rawTitle, rawBody) => {
      const cfg = readLiveConfig();
      const trackedSilent = consumeSilent(rawTitle, rawBody);
      return formatDirectToastArgs(rawTitle, rawBody, cfg, { silent: trackedSilent });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Initialize global hooks once per Extension Host process.
 * @param {string} [customHome]
 */
function initRuntime(customHome) {
  if (globalThis.__agyNotifRuntimeInstance) {
    return globalThis.__agyNotifRuntimeInstance;
  }
  const instance = createNotificationProxyServer({ customHome });
  globalThis.__agyNotifRuntimeInstance = instance;
  globalThis.__agyNotifProxyUrl = instance.rewriteUrl;
  globalThis.__agyNotifPreFilter = instance.preFilter;
  globalThis.__agyNotifShouldSkipInner = instance.shouldSkipInner;
  globalThis.__agyNotifAllowOpenChatBanner = instance.allowOpenChatBannerInSameChat;
  globalThis.__agyNotifFormatWinToast = instance.formatWinToast;
  return instance;
}

module.exports = {
  CFG_SCRIPT_PATH,
  MAIN_JS_PATH,
  createNotificationProxyServer,
  initRuntime,
};
