import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const configStore = require('../core/config_store.js');
const formatter = require('../core/formatter.js');
const mainRewriter = require('../core/main_js_rewriter.js');
const extPatcher = require('../core/extension_patcher.js');
const proxyRuntime = require('../core/proxy_runtime.js');

const SAMPLE_MAIN_JS = `
function middleware(p){
  var c,d="Antigravity",h;
  if(C$a.match(p)){
    let y=u.isConversationInView;
    h=y;
  }
  const v = summary;
  c?.({id:"agent-finished-c1-1",title:d,body:v?\`Agent finished: \${v}\`:"Agent finished"});
}
class WebNotif {
  send(a){
    typeof document!=="undefined"&&document.hasFocus()||this.extensionApi.showBrowserNotification({payload:a});
  }
}
`;

const SAMPLE_EXT_V26 = (
  '/* RTL-PATCH-START */\n;(function(){globalThis.__rtlChatProxyUrl=u=>u;})();\n/* RTL-PATCH-END */\n' +
  'class Webview{renderWebviewHtml(a,b,c,d){if(globalThis.__rtlChatProxyUrl)c=globalThis.__rtlChatProxyUrl(c);var x=1;}}\n' +
  'class Delegate{showWindowsNotification(a, // secret-detector:ignore\n' +
  'b,c,d){var g=this.getLogoPath(),h={...process.env};delete h.ELECTRON_RUN_AS_NODE;' +
  'h.AGY_NOTIFY_APP_ID="Microsoft.VisualStudioCode";h.AGY_NOTIFY_TITLE=`Antigravity \\u2014 ${a}`;' +
  'h.AGY_NOTIFY_BODY=b||a;h.AGY_NOTIFY_URI=c;var cmd=\'if (-not $App) { $App = $Apps | Where-Object {$_.Name -like "*Visual Studio Code*"} | Select-Object -First 1 }; ' +
  '($RawXml.toast.visual.binding.text | Where-Object {$_.id -eq \\\'2\\\'}).AppendChild($RawXml.CreateTextNode($env:AGY_NOTIFY_BODY)) | Out-Null\';}' +
  'async showBrowserNotification(a,b){if(a.payload){var{title:g,body:h,cascadeId:m,path:p}=a.payload;' +
  'a=g||"Antigravity";var q=a==="Antigravity"&&h?h:Ar(a,h),t=()=>{(b==null?0:b.isConversationVisible)||this.showOpenChatToast(q,m,p)},r;' +
  '((r=n.window.state)==null?0:r.focused)?t():this.showSystemNotification(a,h,m,p,t)}}}\n' +
  'class Handler{async showBrowserNotification(a){var b=f.asyncContextStart(),c=b();c=c(1);try{' +
  'let d=!0,t=!1,v=!0;if(n.window.state.focused&&d&&(v||t))return{};' +
  'b(await c((x=this.browserNotificationDelegate)==null?void 0:x.showBrowserNotification(a,{isConversationVisible:t})));' +
  'return{}}finally{c()}}async showNotification(a){return this.delegate&&!n.window.state.focused}}'
);

const SAMPLE_EXT_V28 = (
  '/* RTL-PATCH-START */\n;(function(){globalThis.__rtlChatProxyUrl=u=>u;})();\n/* RTL-PATCH-END */\n' +
  'const MAX_ATTEMPTS = 6;\n' +
  'class Webview{renderWebviewHtml(a,b,c,d){if(globalThis.__rtlChatProxyUrl)c=globalThis.__rtlChatProxyUrl(c);var x=1;}}\n' +
  'class Delegate{showWindowsNotification(a,b,c,d){var g=this.getLogoPath(),h={...process.env};delete h.ELECTRON_RUN_AS_NODE;' +
  'h.AGY_NOTIFY_APP_ID="Microsoft.VisualStudioCode";h.AGY_NOTIFY_TITLE=`Antigravity \\u2014 ${a}`;' +
  'h.AGY_NOTIFY_BODY=b||a;h.AGY_NOTIFY_URI=c;var cmd=\'if (-not $App) { $App = $Apps | Where-Object {$_.Name -like "*Visual Studio Code*"} | Select-Object -First 1 }; ' +
  '($RawXml.toast.visual.binding.text | Where-Object {$_.id -eq \\\'2\\\'}).AppendChild($RawXml.CreateTextNode($env:AGY_NOTIFY_BODY)) | Out-Null\';}' +
  'async showBrowserNotification(a,b){var c=f.asyncContextStart(),d=c();c=c(1);try{if(a.payload){' +
  'var{title:g,body:h,cascadeId:m,path:p}=a.payload;a=g||"Antigravity";var q=a==="Antigravity"&&h?h:Ar(a,h),' +
  't=()=>{(b==null?0:b.isConversationVisible)||this.showOpenChatToast(q,m,p)},u;' +
  '((u=n.window.state)==null?0:u.focused)?t():c(await d(this.showSystemNotification(a,h,m,p,t)))}}finally{d()}}}\n' +
  'class Handler{async showBrowserNotification(a){var b=f.asyncContextStart(),c=b();b=b(1);try{' +
  'let d=!0,u=!1,x=!0;if(n.window.state.focused&&d&&(x||u))return{};' +
  'let B;b(await c((B=this.browserNotificationDelegate)==null?void 0:B.showBrowserNotification(a,{isConversationVisible:u})));' +
  'return{}}finally{c()}}async showNotification(a){var b;return((b=this.browserNotificationDelegate)==null?0:b.showFocusingNotification)&&!n.window.state.focused}}'
);

test('config_store loads defaults, merges partial config, and falls back on corrupt JSON', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cfg-'));
  try {
    const first = configStore.loadConfig(tmpHome);
    assert.equal(first.error, null);
    assert.equal(first.config.enabled, true);
    assert.equal(first.config.notifySameActiveChat, true);
    assert.equal(first.config.events.finished.titleTemplate, '{body}');
    assert.equal(first.config.events.finished.bodyTemplate, '');

    // Partial update preserves defaults + schema v1 respectPayload migrates cleanly to windows
    fs.writeFileSync(configStore.getConfigPath(tmpHome), JSON.stringify({ schemaVersion: 1, soundMode: 'respectPayload' }), 'utf8');
    assert.equal(configStore.loadConfig(tmpHome).config.soundMode, 'windows');

    const saved = configStore.saveConfig({ soundMode: 'silent', events: { finished: { titleTemplate: 'Done: {body}' } } }, tmpHome);
    assert.equal(saved.soundMode, 'silent');
    assert.equal(saved.events.finished.titleTemplate, 'Done: {body}');
    assert.equal(saved.events.askQuestion.enabled, true);

    // Corrupt JSON falls back gracefully without throwing
    fs.writeFileSync(configStore.getConfigPath(tmpHome), '{corrupt json', 'utf8');
    const fallback = configStore.loadConfig(tmpHome);
    assert.ok(fallback.error);
    assert.equal(fallback.config.enabled, true);
    assert.equal(fallback.config.notifySameActiveChat, true);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('formatter classifies payload.type=request_action properly via id prefix and formats cleanly', () => {
  const cfg = configStore.cloneDefaultConfig();

  // agent-finished always emits payload.type === "request_action" upstream!
  // Default soundMode ("windows") ensures Windows chime plays even if upstream sets silent: true
  const fin = formatter.formatNotification(
    {
      id: 'agent-finished-abc-12',
      title: 'Antigravity',
      body: 'Agent finished: الذكاء الاصطناعي للمزودين',
      silent: true,
      cascadeId: 'abc',
      type: 'request_action',
    },
    cfg,
    { focused: true, isConversationVisible: true }
  );
  assert.equal(fin.drop, false);
  assert.equal(fin.eventType, 'finished');
  assert.equal(fin.title, 'الذكاء الاصطناعي للمزودين');
  assert.equal(fin.body, '');
  assert.equal(fin.silent, false);
  assert.equal(fin.suppressOpenChatToast, true);

  // When explicitly set to respectPayload, upstream silent: true is preserved
  const finRespect = formatter.formatNotification(
    { id: 'agent-finished-abc-13', title: 'Antigravity', body: 'Agent finished: Test', silent: true },
    { ...cfg, soundMode: 'respectPayload' }
  );
  assert.equal(finRespect.silent, true);

  // AskQuestion preserves question clearly and shows Open Chat banner when outside same chat
  const qRes = formatter.formatNotification(
    {
      id: '4abc',
      title: 'The agent has a question for you:',
      body: 'Approve migration?',
      silent: false,
      cascadeId: 'abc',
    },
    cfg,
    { focused: true, isConversationVisible: false }
  );
  assert.equal(qRes.drop, false);
  assert.equal(qRes.eventType, 'askQuestion');
  assert.equal(qRes.title, 'The agent has a question for you:');
  assert.equal(qRes.body, 'Approve migration?');
  assert.equal(qRes.silent, false);
  assert.equal(qRes.suppressOpenChatToast, false);

  // RunCommand classification + Unknown pass-through
  const cmdRes = formatter.formatNotification(
    { id: '5abc', title: 'Requesting your permission in Terminal:', body: 'Command: npm test' },
    cfg
  );
  assert.equal(cmdRes.eventType, 'runCommand');

  const unkRes = formatter.formatNotification(
    { id: 'custom-1', title: 'New Custom Alert', body: 'Details here' },
    cfg
  );
  assert.equal(unkRes.eventType, 'unknown');
  assert.equal(unkRes.title, 'Antigravity \u2014 New Custom Alert');
  assert.equal(unkRes.body, 'Details here');
});

test('formatter respects sound modes and deduplication window', () => {
  assert.equal(formatter.resolveWindowsSilent('respectPayload', true), true);
  assert.equal(formatter.resolveWindowsSilent('respectPayload', false), false);
  assert.equal(formatter.resolveWindowsSilent('windows', true), false);
  assert.equal(formatter.resolveWindowsSilent('antigravity', false), true);
  assert.equal(formatter.resolveWindowsSilent('silent', false), true);
  assert.equal(formatter.resolveWindowsSilent('both', true), false);

  const dedup = new formatter.NotificationDeduplicator(5);
  assert.equal(dedup.isDuplicate('k1', 2500, 1000), false);
  assert.equal(dedup.isDuplicate('k1', 2500, 2000), true);
  assert.equal(dedup.isDuplicate('k1', 2500, 3600), false);
});

test('main_js_rewriter handles 3 unique anchors, executes cleanly under live config, and passes through on mismatch', () => {
  const res = mainRewriter.rewriteMainJs(SAMPLE_MAIN_JS);
  assert.equal(res.rewritten, true);
  assert.equal(res.reason, null);

  // Verify rewritten JS compiles and respects dynamic globalThis.__AGY_NOTIF_CFG__
  const buildSandbox = new Function(
    'document', 'C$a', 'summary', 'u',
    `${res.code}\n;return { middleware, WebNotif };`
  );

  let lastSent = null;
  let extCalled = 0;
  const fakeDoc = { hasFocus: () => true };
  const fakeMatch = { match: (x) => Boolean(x && x.isCfg) };
  const uObj = { isConversationInView: () => true };
  const fakeExt = { showBrowserNotification: (x) => { extCalled += 1; lastSent = x; } };

  // Inject c capture by replacing `c?.` in middleware? No: run directly when C$a triggers `c` is internal in sample,
  // so verify Anchor 1 & 2 via middleware execution and Anchor 3 via WebNotif.send()!
  const sandbox = buildSandbox(fakeDoc, fakeMatch, 'عربي سريع', uObj);
  const wn = new sandbox.WebNotif();
  wn.extensionApi = fakeExt;

  // Case A: enabled + focused + sameChat -> WebNotif still invokes extensionApi despite document.hasFocus() === true
  globalThis.__AGY_NOTIF_CFG__ = { enabled: true, notifySameActiveChat: true, notifyWhenFocused: true, stripFinishedPrefix: true };
  wn.send({ id: '1', title: 'Antigravity', body: 'عربي سريع' });
  assert.equal(extCalled, 1);

  // Case B: live toggle notifyWhenFocused=false -> WebNotif suppresses when hasFocus() === true
  globalThis.__AGY_NOTIF_CFG__ = { enabled: true, notifySameActiveChat: false, notifyWhenFocused: false, stripFinishedPrefix: false };
  wn.send({ id: '2', title: 'Antigravity', body: 'Agent finished: عربي سريع' });
  assert.equal(extCalled, 1);

  // Verify Anchor 1 & 2 strings transformed safely
  assert.ok(res.code.includes('globalThis.__AGY_NOTIF_CFG__?.notifySameActiveChat'));
  assert.ok(res.code.includes('globalThis.__AGY_NOTIF_CFG__?.stripFinishedPrefix'));
  assert.doesNotThrow(() => buildSandbox(fakeDoc, fakeMatch, '', uObj));
  delete globalThis.__AGY_NOTIF_CFG__;

  // Safe pass-through on broken / unknown anchor build
  const broken = mainRewriter.rewriteMainJs('console.log("no anchors here");');
  assert.equal(broken.rewritten, false);
  assert.equal(broken.code, 'console.log("no anchors here");');
  assert.match(broken.reason, /Anchor mismatch/);
});

test('extension_patcher patches v2.6 & v2.8 idempotently while preserving RTL hook order', () => {
  for (const [label, sample] of [['v2.6', SAMPLE_EXT_V26], ['v2.8', SAMPLE_EXT_V28]]) {
    const r1 = extPatcher.patchExtensionSource(sample, 'Google.AntigravityIDE');
    assert.ok(r1.changes.length >= 6, `${label} should apply changes`);

    // Must preserve RTL and run __agyNotifProxyUrl AFTER __rtlChatProxyUrl
    assert.ok(r1.content.includes('/* RTL-PATCH-START */'), `${label} preserves RTL start`);
    assert.ok(r1.content.includes('/* RTL-PATCH-END */'), `${label} preserves RTL end`);
    assert.ok(
      r1.content.includes('if(globalThis.__rtlChatProxyUrl)c=globalThis.__rtlChatProxyUrl(c);if(globalThis.__agyNotifProxyUrl)c=globalThis.__agyNotifProxyUrl(c);'),
      `${label} chains __agyNotifProxyUrl cleanly after __rtlChatProxyUrl`
    );

    const status = extPatcher.inspectExtensionStatus(r1.content, 'Google.AntigravityIDE');
    assert.equal(status.allOk, true, `${label} inspect allOk`);
    assert.equal(status.rtlPresent, true, `${label} rtlPresent`);

    // Idempotency
    const r2 = extPatcher.patchExtensionSource(r1.content, 'Google.AntigravityIDE');
    assert.deepEqual(r2.changes, [], `${label} second run is no-op`);
    assert.equal(r2.content, r1.content, `${label} byte-identical on second run`);
  }

  // Fails cleanly on ambiguous input without partial mutation
  assert.throws(() => extPatcher.patchExtensionSource('function unrelated(){}', 'Google.AntigravityIDE'));
});

test('chained NotifProxy -> Mock RTL Proxy -> Mock Hub serves HTML+RTL+cfg, caches ETag /main.js, and handles gzip', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-proxy-'));
  configStore.saveConfig({ notifySameActiveChat: true, stripPrefixes: ['Agent finished: '] }, tmpHome);

  let mainHits = 0;
  let currentEtag = 'W/"build-1"';
  let currentMainJs = SAMPLE_MAIN_JS;
  let sawOriginHeader = '';

  const hubServer = http.createServer((req, res) => {
    sawOriginHeader = String(req.headers.origin || '');
    if (req.url === '/') {
      const html = '<!doctype html><html><head><title>Chat</title></head><body><script src="/main.js"></script></body></html>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.url === '/main.js') {
      mainHits += 1;
      // Return gzipped response if client allowed gzip (proxy should strip accept-encoding, and even if compressed should decode cleanly)
      const buf = zlib.gzipSync(Buffer.from(currentMainJs, 'utf8'));
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'content-encoding': 'gzip',
        etag: currentEtag,
      });
      res.end(buf);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => hubServer.listen(0, '127.0.0.1', r));
  const hubPort = hubServer.address().port;

  // Simulated batalelo RTL proxy in between
  const rtlServer = http.createServer((req, res) => {
    const up = http.request(
      { hostname: '127.0.0.1', port: hubPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${hubPort}`, origin: `http://127.0.0.1:${hubPort}` } },
      (upRes) => {
        if (req.url === '/' && String(upRes.headers['content-type'] || '').includes('text/html')) {
          const chunks = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('end', () => {
            const html = Buffer.concat(chunks).toString('utf8').replace('</head>', '<style id="rtl-chat-patch">body{direction:rtl}</style></head>');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
            res.end(html);
          });
        } else {
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(res);
        }
      }
    );
    req.pipe(up);
  });
  await new Promise((r) => rtlServer.listen(0, '127.0.0.1', r));
  const rtlPort = rtlServer.address().port;

  let warningReason = null;
  const notifProxy = proxyRuntime.createNotificationProxyServer({
    customHome: tmpHome,
    onRewriteFailure: (reason) => { warningReason = reason; },
  });
  await notifProxy.listenPromise;

  try {
    const rtlUrl = `http://127.0.0.1:${rtlPort}/`;
    const proxiedUrl = notifProxy.rewriteUrl(rtlUrl);
    assert.ok(proxiedUrl.startsWith(`http://127.0.0.1:${notifProxy.getPort()}/`));

    const httpGet = (p) => new Promise((resolve, reject) => {
      http.get(`${proxiedUrl.replace(/\/$/, '')}${p}`, { headers: { Origin: proxiedUrl.replace(/\/$/, '') } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      }).on('error', reject);
    });

    // 1. HTML contains BOTH RTL style AND our live config script
    const htmlRes = await httpGet('/');
    assert.equal(htmlRes.status, 200);
    assert.ok(htmlRes.body.includes('<style id="rtl-chat-patch">'));
    assert.ok(htmlRes.body.includes('<script src="/__agy_notif_cfg.js"></script>'));
    assert.equal(sawOriginHeader, `http://127.0.0.1:${hubPort}`);

    // 2. Live config endpoint updates without restarting proxy
    const cfgRes1 = await httpGet('/__agy_notif_cfg.js');
    assert.ok(cfgRes1.body.includes('"notifySameActiveChat":true'));
    configStore.saveConfig({ notifySameActiveChat: false }, tmpHome);
    const cfgRes2 = await httpGet('/__agy_notif_cfg.js');
    assert.ok(cfgRes2.body.includes('"notifySameActiveChat":false'));

    // 3. /main.js rewrites + reuses cached transform by ETag + invalidates on new build ETag
    const jsRes1 = await httpGet('/main.js');
    assert.equal(jsRes1.status, 200);
    assert.ok(jsRes1.body.includes(mainRewriter.MARKER));
    const jsRes2 = await httpGet('/main.js');
    assert.equal(jsRes2.body, jsRes1.body);
    assert.equal(mainHits, 2);

    currentEtag = 'W/"build-2"';
    currentMainJs = SAMPLE_MAIN_JS.replace('summary', 'nextSummary');
    const jsRes3 = await httpGet('/main.js');
    assert.ok(jsRes3.body.includes('nextSummary'));

    // 4. Safe pass-through + warning callback if future build breaks anchors
    currentEtag = 'W/"build-broken"';
    currentMainJs = 'console.log("future incompatible main.js");';
    const jsRes4 = await httpGet('/main.js');
    assert.equal(jsRes4.body, currentMainJs);
    assert.match(String(warningReason || ''), /Anchor mismatch/);
  } finally {
    await notifProxy.close();
    await new Promise((r) => rtlServer.close(r));
    await new Promise((r) => hubServer.close(r));
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
  assert.match(String(warningReason || ''), /Anchor mismatch/);
});
