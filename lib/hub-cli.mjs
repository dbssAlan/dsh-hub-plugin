#!/usr/bin/env node
/**
 * dsh-hub.mjs —— 单中心公网中枢：把本机 DSH 发布到公网，供 Mac / 鸿蒙手机 / 平板访问。
 * 同时支持两种宿主：DSH 桌面版（Electron）与 dsh web（CLI），二者共享同一 DSH_HOME
 * 与会话存储——只要工作区目录一致，就能看到同一批任务。
 *
 * 它做五件事（除 Cloudflare 隧道外全部在本机完成）：
 *   1. 自动探测正在运行的 DSH 宿主端口（桌面版端口每次启动会变）
 *   2. 读本机签名密钥，为 loopback 地址签发会话 Cookie（桌面版不打印启动 token）
 *   3. 起反向代理：把 Host 改写成 127.0.0.1:<port>，绕过 DSH 的 Host 栅栏
 *   4. 校验 Cookie 是否被该宿主接受（识别不同 DSH_HOME 的情况）
 *   5. 可选拉起 cloudflared 免费隧道；并提供带二维码的「设备导航页」
 *
 * 用法：
 *   node dsh-hub.mjs                     # 自动选宿主（桌面版优先）+ 公网隧道
 *   node dsh-hub.mjs --mode web          # 指定发布 dsh web 宿主
 *   node dsh-hub.mjs --mode desktop      # 指定发布桌面版
 *   node dsh-hub.mjs --no-tunnel         # 只在本机/局域网发布
 *   node dsh-hub.mjs --port 19388        # 指定代理端口（默认 19388）
 *   node dsh-hub.mjs --target 43825      # 手动指定宿主端口
 *   node dsh-hub.mjs --key <密码>         # 指定访问密码（否则自动生成并保存）
 *   node dsh-hub.mjs --tunnel-token <t>  # 用 Cloudflare 命名隧道（固定域名）
 *   node dsh-hub.mjs --public-url <u>    # 命名隧道已知域名时直接打印
 *   node dsh-hub.mjs --wait 600          # 开机自启时等待宿主启动
 *   node dsh-hub.mjs --link-key          # 允许 /_login?key=<密码> 直接登录（默认关闭）
 *
 * 认证方式：默认是**密码表单**——URL 本身不含密码，打开后必须输入密码；
 * 登录成功写入 30 天 HttpOnly Cookie。`--link-key` 才恢复"链接即登录"（不建议）。
 *
 * 设备导航页：/_devices（登录后可见），含二维码与分享卡片（离线库 vendor/qrcode.js）。
 * 追加其他设备：编辑 %DSH_HOME%\dsh-hub-devices.json：
 *   { "devices": [ { "name": "公司 Mac", "url": "https://mac的地址/", "note": "Mac" } ] }
 *
 * 安全：DSH 能执行本机命令，
 * 公网地址等于把电脑控制权暴露出去，请自用、勿外传口令、用完关掉。
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const QR_LIB = path.join(HERE, 'vendor', 'qrcode.js');

// ── PWA（v0.4）──────────────────────────────────────────────────────────────
const PWA_TAGS = [
  '<link rel="manifest" href="/manifest.webmanifest">',
  '<meta name="theme-color" content="#4f6ef7">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<meta name="apple-mobile-web-app-title" content="DSH Hub">',
  '<style id="dsh-hub-mobile">html{-webkit-text-size-adjust:100%}body{-webkit-tap-highlight-color:transparent;padding-bottom:env(safe-area-inset-bottom)}</style>',
].join('');

const PWA_MANIFEST = JSON.stringify({
  name: 'DSH Hub',
  short_name: 'DSH Hub',
  description: '远程访问这台电脑上的 DSH',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0f1115',
  theme_color: '#4f6ef7',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
});

const PWA_SW = [
  "self.addEventListener('install', e => self.skipWaiting());",
  "self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));",
  "self.addEventListener('fetch', () => {});",
  '',
].join('\n');

function injectPwa(html) {
  if (!html.includes('</head>')) return html;
  return html.replace('</head>', `${PWA_TAGS}</head>`);
}

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const LISTEN_PORT = Number(opt('--port', '19388'));
const MANUAL_TARGET = Number(opt('--target', '0')) || 0;
const WANT_TUNNEL = !hasFlag('--no-tunnel');
const ALLOW_MULTI_HOST = hasFlag('--allow-multi-host');
const STOP_WEB_HOST = hasFlag('--stop-web-host');
const STATUS_FILE = opt('--status-file', '');
const CONFIG_FILE = opt('--config-file', '');
const DISABLED = hasFlag('--disabled');

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const STATE_FILE = path.join(DSH_HOME, 'dsh-hub.json');
const DEVICES_FILE = path.join(DSH_HOME, 'dsh-hub-devices.json');

/** 插件模式下的状态文件（避免子进程 stdout 缓冲导致看不到地址）。 */
function writeStatus(patch) {
  if (!STATUS_FILE) return;
  try {
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch {}
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...prev, ...patch, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch {}
}
const LOG_DIR = path.join(DSH_HOME, 'dsh-hub-logs');
const CREDENTIALS = path.join(DSH_HOME, '.credentials.yaml');

// 命名隧道的 token / 域名会持久化，之后直接复用
const state = loadState();
const TUNNEL_TOKEN = opt('--tunnel-token', process.env.DSH_HUB_TUNNEL_TOKEN ?? state.tunnelToken ?? '');
const PUBLIC_URL_OVERRIDE = opt('--public-url', state.publicUrl ?? '');

const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

// ── 小工具 ──────────────────────────────────────────────────────────────────
const ok = (t) => console.log(`\x1b[32m✓\x1b[0m ${t}`);
const step = (t) => console.log(`\x1b[36m»\x1b[0m ${t}`);
const warn = (t) => console.log(`\x1b[33m!\x1b[0m ${t}`);
const bad = (t) => console.log(`\x1b[31m✗\x1b[0m ${t}`);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(patch) {
  const next = { ...loadState(), ...patch };
  try { fs.mkdirSync(DSH_HOME, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8'); } catch {}
  return next;
}

// 直接执行 exe 并把结果写文件（不经 cmd，避免受限环境里 cmd.exe 初始化失败）
function runExeToText(exe, args) {
  const tmp = path.join(os.tmpdir(), `dsh-hub-out-${process.pid}-${Math.random().toString(16).slice(2)}.txt`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    const r = spawnSync(exe, args, { stdio: ['ignore', fd, fd], windowsHide: true, timeout: 15000 });
    fs.closeSync(fd);
    fd = undefined;
    if (r.error) return '';
    return fs.readFileSync(tmp, 'utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function netstatText() {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  const candidates = [
    path.join(root, 'System32', 'netstat.exe'),
    'netstat',
  ];
  for (const exe of candidates) {
    const text = runExeToText(exe, ['-ano']);
    if (text) return text;
  }
  return '';
}

/** 从桌面版 Electron 的缓存里捞它用过的 127.0.0.1:<port>（netstat 不可用时的后备）。 */
function desktopCachePorts() {
  const appdata = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const roots = [
    path.join(appdata, '@deepseek-ai', 'dsh-desktop', 'Cache', 'Cache_Data'),
    path.join(appdata, '@deepseek-ai', 'dsh-desktop', 'Network'),
  ];
  const ports = new Set();
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries.slice(0, 200)) {
      if (!e.isFile()) continue;
      let buf;
      try {
        const st = fs.statSync(path.join(root, e.name));
        if (st.size > 4 * 1024 * 1024) continue;
        buf = fs.readFileSync(path.join(root, e.name));
      } catch { continue; }
      const text = buf.toString('latin1');
      for (const m of text.matchAll(/127\.0\.0\.1:(\d{4,5})/g)) {
        const p = Number(m[1]);
        if (p > 1024 && p < 65536) ports.add(p);
      }
    }
  }
  return [...ports];
}

function listeningLoopbackPorts() {
  const text = netstatText();
  const ports = new Set();
  for (const line of text.split(/\r?\n/u)) {
    const m = line.match(/TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING/iu);
    if (m) ports.add(Number(m[1]));
  }
  if (ports.size === 0) {
    for (const p of desktopCachePorts()) ports.add(p);
  }
  return [...ports];
}

async function looksLikeDsh(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1200), redirect: 'manual' });
    const text = await r.text().catch(() => '');
    if (r.status === 401) {
      // DSH 的 401 有固定文案；其他服务的 "Unauthorized" 不能算
      return /dsh web authentication required/iu.test(text);
    }
    if (r.status !== 200) return false;
    return /<div id="root"/iu.test(text) && /dsh|DeepSeek Harness/iu.test(text);
  } catch { return false; }
}

/** 用本机密钥签一个 Cookie 去验；能 200 才说明是同一个 DSH_HOME 的 DSH。 */
async function verifyWithCookie(port) {
  try {
    const c = mintCookie(port);
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { cookie: `${c.name}=${c.value}` },
      signal: AbortSignal.timeout(2000),
    });
    return r.status === 200;
  } catch { return false; }
}

// ── 1. 探测目标端口（支持桌面版与 dsh web 两种宿主）────────────────────────
const MODE = opt('--mode', 'auto'); // auto | desktop | web
let TARGET_KIND = 'unknown';
let TARGET_WORKSPACE = '';

function readWebHostState() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'dsh-web-host.json'), 'utf8'));
    return s && Number(s.port) ? s : null;
  } catch { return null; }
}

/** 检测是否还有另一个 DSH 宿主（桌面版 / dsh web）在共用这个 DSH_HOME。 */
async function detectOtherHosts() {
  const web = readWebHostState();
  const webAlive = web ? await looksLikeDsh(Number(web.port)) : false;

  let desktopAlive = false;
  try {
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    const text = runExeToText(path.join(root, 'System32', 'tasklist.exe'), [
      '/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH',
    ]);
    desktopAlive = /DeepSeek Harness\.exe/iu.test(text);
  } catch {}

  return { web, webAlive, desktopAlive };
}

async function detectTarget() {
  if (!['auto', 'desktop', 'web'].includes(MODE)) {
    warn(`--mode ${MODE} 无效，按 auto 处理`);
  }
  if (MANUAL_TARGET) {
    if (!(await looksLikeDsh(MANUAL_TARGET))) warn(`--target ${MANUAL_TARGET} 没有响应 DSH 特征，仍按指定端口使用`);
    TARGET_KIND = 'manual';
    return MANUAL_TARGET;
  }

  const envPort = (() => { try { return Number(new URL(process.env.DSH_WEB_URL ?? '').port) || 0; } catch { return 0; } })();
  const webState = readWebHostState();
  const webStatePort = webState ? Number(webState.port) : 0;
  const webAlive = webStatePort && await looksLikeDsh(webStatePort);

  const asWeb = () => {
    TARGET_KIND = 'web';
    TARGET_WORKSPACE = webState?.workspace ?? '';
    return webStatePort;
  };

  if (MODE === 'web') {
    if (webAlive) return asWeb();
    if (await looksLikeDsh(3080)) { TARGET_KIND = 'web'; TARGET_WORKSPACE = ''; return 3080; }
    return 0;
  }

  if (MODE === 'desktop') {
    if (envPort && await looksLikeDsh(envPort)) { TARGET_KIND = 'desktop'; return envPort; }
    const candidates = listeningLoopbackPorts().filter((p) => p > 1024 && p !== webStatePort);
    const ordered = [...new Set([43825, 19387, ...candidates])];
    const hits = [];
    for (const p of ordered) {
      if (await looksLikeDsh(p)) hits.push(p);
    }
    for (const p of hits) {
      if (await verifyWithCookie(p)) { TARGET_KIND = 'desktop'; return p; }
    }
    if (hits.length) { TARGET_KIND = 'desktop'; return hits[0]; }
    return 0;
  }

  // auto：桌面版优先（同 DSH_HOME 下两者共享工作区与会话，选哪个都能看到同样的任务）
  if (envPort && await looksLikeDsh(envPort)) { TARGET_KIND = 'desktop'; return envPort; }
  const candidates = listeningLoopbackPorts().filter((p) => p > 1024);
  const preferred = [43825, 19387, 3080, 3000, 8080];
  const ordered = [...new Set([...candidates.filter((p) => preferred.includes(p)), ...candidates])];

  const hits = [];
  for (const p of ordered) {
    if (await looksLikeDsh(p)) hits.push(p);
  }
  if (hits.length === 0) return 0;

  // 多个候选时，优先能通过本机 Cookie 校验的那个
  for (const p of hits) {
    if (await verifyWithCookie(p)) {
      if (webAlive && p === webStatePort) return asWeb();
      TARGET_KIND = 'desktop';
      return p;
    }
  }

  // 没有能通过 Cookie 校验的，退回到第一个像 DSH 的（稍后会提示校验失败）
  const p = hits[0];
  warn(`候选端口 ${hits.join(', ')} 都没通过本机 Cookie 校验；暂用 ${p}。`);
  if (webAlive && p === webStatePort) return asWeb();
  TARGET_KIND = 'desktop';
  return p;
}

// ── 2. 会话 Cookie ──────────────────────────────────────────────────────────
const RECORD_KEY = 'client-connection/browser-session';

function readSecret(file) {
  let inRecord = false, ri = -1, inPayload = false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    if (/^\s*#/u.test(line) || !line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (!inRecord) { if (t === `${RECORD_KEY}:`) { inRecord = true; ri = indent; } continue; }
    if (indent <= ri && !t.startsWith('payload')) { inRecord = false; inPayload = false; continue; }
    if (t === 'payload:') { inPayload = true; continue; }
    if (inPayload && t.startsWith('secret:')) return t.slice(7).trim().replace(/^["']|["']$/gu, '');
  }
  return undefined;
}

function mintCookie(targetPort, days = 30) {
  const secretB64 = readSecret(CREDENTIALS);
  if (!secretB64) throw new Error(`未在 ${CREDENTIALS} 找到签名密钥（请先启动一次 DSH 桌面版）`);
  const secret = Buffer.from(secretB64.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  if (secret.byteLength !== 32) throw new Error('签名密钥长度异常');
  const authority = `127.0.0.1:${targetPort}`;
  const issuedAt = Date.now();
  const expiresAt = issuedAt + days * 86400_000;
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'));
  return {
    authority,
    name: 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest()),
    value: `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`,
    expiresAt,
  };
}

// ── 3. 反代 + 登录入口 ──────────────────────────────────────────────────────
/** 设备导航页：列出本机与可选的其他设备，并渲染二维码（离线库，不外传密钥）。 */
function renderDevicesPage() {
  const host = os.hostname();
  const lan = `http://${lanAddress()}:${LISTEN_PORT}/`;
  const pub = publicUrl ? `${publicUrl}/` : '';

  const extra = (() => {
    try {
      const cfg = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
      return Array.isArray(cfg?.devices) ? cfg.devices : [];
    } catch { return []; }
  })();

  const cards = [
    { name: `${host}（本机·${TARGET_KIND === 'web' ? 'dsh web' : 'DSH 桌面版'}）`, url: pub || lan, note: pub ? '公网地址' : '局域网地址（未开隧道）' },
    ...(pub ? [{ name: `${host}（局域网）`, url: lan, note: '同一 WiFi 时更快' }] : []),
    ...extra.map((d) => ({ name: d.name ?? '未命名设备', url: d.url ?? '', note: d.note ?? '' })),
  ].filter((c) => c.url);

  const qrLib = fs.existsSync(QR_LIB) ? fs.readFileSync(QR_LIB, 'utf8') : '';
  const shareUrl = pub || lan;
  const cardsHtml = cards.map((c, i) => `
    <section class="card">
      <h2>${escapeHtml(c.name)}</h2>
      <p class="note">${escapeHtml(c.note)}</p>
      <a class="url" href="${escapeAttr(c.url)}">${escapeHtml(c.url)}</a>
      <div class="qr" id="qr${i}"></div>
      <button data-url="${escapeAttr(c.url)}" data-qr="qr${i}">显示二维码</button>
    </section>`).join('');

  const shareHtml = `
    <section class="card share">
      <h2>分享给其他设备</h2>
      <p class="note">分享「地址」和「访问密码」。对方打开地址后需要输入密码；<b>地址本身不含密码</b>，泄露地址也进不来。</p>
      <div class="row">
        <a class="url" href="${escapeAttr(shareUrl)}">${escapeHtml(shareUrl)}</a>
        <button type="button" id="copyShare" data-url="${escapeAttr(shareUrl)}">复制地址</button>
      </div>
      <div class="row">
        <span class="note" style="margin:0">访问密码：</span>
        <code id="pwd" data-pwd="${escapeAttr(LOGIN_KEY)}">••••••</code>
        <button type="button" id="togglePwd">显示</button>
        <button type="button" id="copyPwd">复制密码</button>
      </div>
    </section>`;

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 设备导航</title>
<style>
  :root{color-scheme:light dark}
  body{font:15px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;padding:24px;background:#0f1115;color:#e6e6e6}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#8b93a1;font-size:13px;margin-bottom:20px}
  .grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
  .card{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:16px}
  .card.share{grid-column:1/-1;border-color:#3a4a6b}
  h2{font-size:15px;margin:0 0 6px}
  .note{color:#8b93a1;font-size:12px;margin:0 0 10px}
  .row{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:nowrap}
  .row .url{flex:1;min-width:0;margin:0}
  .row button{flex:none}
  .row code{flex:none}
  .url{display:block;word-break:break-all;font-size:12px;color:#7aa2f7;text-decoration:none;margin-bottom:12px}
  .qr{display:none;background:#fff;padding:8px;border-radius:8px;width:max-content;margin-bottom:12px}
  .qr.show{display:block}
  .qr svg{display:block}
  button{background:#2b3446;color:#e6e6e6;border:0;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer}
  button:hover{background:#36415a}
</style></head><body>
<h1>DSH 设备导航</h1>
<div class="sub">点开链接即可进入对应设备的 DSH；二维码可用手机相机扫。手机浏览器菜单里可「添加到主屏幕」，当作 App 使用。链接含登录口令，请勿外传。</div>
${shareHtml}
<div class="grid">${cardsHtml}</div>
${qrLib ? `<script>${qrLib}</script>
<script>
document.querySelectorAll('button[data-url]').forEach(function(b){
  b.addEventListener('click', function(){
    var box = document.getElementById(b.getAttribute('data-qr'));
    if (box.classList.contains('show')) { box.classList.remove('show'); box.innerHTML=''; b.textContent='显示二维码'; return; }
    try {
      var qr = qrcode(0, 'M');
      qr.addData(b.getAttribute('data-url'));
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4 });
      box.classList.add('show');
      b.textContent = '收起二维码';
    } catch (e) { box.textContent = '二维码生成失败: ' + e.message; box.classList.add('show'); }
  });
});
</script>` : '<p class="note">未找到 vendor/qrcode.js，二维码功能不可用。</p>'}
<script>
var pwdEl = document.getElementById('pwd');
var toggleBtn = document.getElementById('togglePwd');
if (toggleBtn && pwdEl) toggleBtn.addEventListener('click', function () {
  if (pwdEl.textContent === '••••••') { pwdEl.textContent = pwdEl.getAttribute('data-pwd'); toggleBtn.textContent = '隐藏'; }
  else { pwdEl.textContent = '••••••'; toggleBtn.textContent = '显示'; }
});
var copyPwdBtn = document.getElementById('copyPwd');
if (copyPwdBtn && pwdEl) copyPwdBtn.addEventListener('click', function () {
  var v = pwdEl.getAttribute('data-pwd');
  if (navigator.clipboard) {
    navigator.clipboard.writeText(v).then(function () { copyPwdBtn.textContent = '已复制'; }, function () { copyPwdBtn.textContent = '请手动选择'; });
  } else { copyPwdBtn.textContent = '请手动选择'; }
});
var copyShareBtn = document.getElementById('copyShare');
if (copyShareBtn) copyShareBtn.addEventListener('click', function () {
  var u = copyShareBtn.getAttribute('data-url');
  if (navigator.clipboard) {
    navigator.clipboard.writeText(u).then(function () { copyShareBtn.textContent = '已复制'; }, function () { copyShareBtn.textContent = '请手动选择'; });
  } else { copyShareBtn.textContent = '请手动选择'; }
});
</script>
</body></html>`;
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(v) { return escapeHtml(v); }

const LOGIN_KEY = opt('--key', state.loginKey ?? randomBytes(9).toString('hex'));
saveState({ loginKey: LOGIN_KEY });
if (TUNNEL_TOKEN) saveState({ tunnelToken: TUNNEL_TOKEN });
if (PUBLIC_URL_OVERRIDE) saveState({ publicUrl: PUBLIC_URL_OVERRIDE });

const failWindow = new Map(); // ip -> { count, until }
function throttled(ip) {
  const rec = failWindow.get(ip);
  return rec !== undefined && rec.until > Date.now();
}
function recordFailure(ip) {
  const rec = failWindow.get(ip) ?? { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 5) { rec.until = Date.now() + 60_000; rec.count = 0; }
  failWindow.set(ip, rec);
}

let TARGET_PORT = 0;
let cookie = null;
let publicUrl = '';
let tunnelProc = null;
let tunnelLog = '';

const lanAddress = () => {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) if (info.family === 'IPv4' && !info.internal) return info.address;
  }
  return '127.0.0.1';
};

// ── v0.5：设备会话 / 登录审计 / 二维码 ─────────────────────────────────────
const STATE_DIR = path.join(DSH_HOME, 'dsh-hub-plugin');
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
const AUDIT_FILE = path.join(STATE_DIR, 'audit.jsonl');
const SESSION_TTL_MS = 30 * 86400_000;

function readSessions() {
  try {
    const v = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeSessions(list) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
  } catch {}
}

function writeAudit(event, extra = {}) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify({ at: new Date().toISOString(), event, ...extra })}\n`);
  } catch {}
}

function readAudit(limit = 100) {
  try {
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split(/\r?\n/u).filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return { raw: line }; }
    }).reverse();
  } catch {
    return [];
  }
}

function describeUa(ua) {
  const s = String(ua ?? '');
  const browser = /Edg\//u.test(s) ? 'Edge' : /Chrome\//u.test(s) ? 'Chrome' : /Firefox\//u.test(s) ? 'Firefox' : /Safari\//u.test(s) ? 'Safari' : '浏览器';
  const osName = /Android/u.test(s) ? 'Android' : /iPhone|iPad/u.test(s) ? 'iOS' : /HarmonyOS/u.test(s) ? 'HarmonyOS' : /Mac OS X/u.test(s) ? 'macOS' : /Windows/u.test(s) ? 'Windows' : '未知系统';
  return `${browser} · ${osName}`;
}

function createSession(req) {
  const ua = String(req.headers['user-agent'] ?? '');
  const now = Date.now();
  const s = {
    id: randomBytes(16).toString('hex'),
    name: describeUa(ua),
    ip: req.socket.remoteAddress ?? '',
    ua: ua.slice(0, 200),
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  };
  const list = readSessions();
  list.push(s);
  writeSessions(list);
  writeAudit('login', { session: s.id.slice(0, 8), ip: s.ip, name: s.name });
  return s;
}

let lastTouch = 0;
function touchSession(id) {
  if (Date.now() - lastTouch < 60_000) return;
  lastTouch = Date.now();
  const list = readSessions();
  const s = list.find((x) => x.id === id);
  if (s) { s.lastSeenAt = Date.now(); writeSessions(list); }
}

function findSession(id) {
  if (!id) return null;
  const s = readSessions().find((x) => x.id === id);
  if (!s || s.revokedAt) return null;
  if (Date.now() - s.lastSeenAt > SESSION_TTL_MS) return null;
  return s;
}

function cookieValue(req, name) {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

let qrCodeFn = null;
function qrSvg(text) {
  if (!qrCodeFn) {
    const code = fs.readFileSync(QR_LIB, 'utf8');
    const sandbox = { module: { exports: {} }, exports: {} };
    sandbox.exports = sandbox.module.exports;
    vm.runInNewContext(code, sandbox, { timeout: 2000 });
    qrCodeFn = sandbox.module.exports;
  }
  const qr = qrCodeFn(0, 'M');
  qr.addData(String(text).slice(0, 512));
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4 });
}

// ── v0.6：设备配对（远程设备列表）──────────────────────────────────────────
const PEERS_FILE = path.join(STATE_DIR, 'peers.json');
const MACHINE_FILE = path.join(STATE_DIR, 'machine.json');

function readPeers() {
  try {
    const v = JSON.parse(fs.readFileSync(PEERS_FILE, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writePeers(list) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(PEERS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
  } catch {}
}

function machineInfo() {
  let id = '';
  try {
    id = JSON.parse(fs.readFileSync(MACHINE_FILE, 'utf8')).id ?? '';
  } catch {}
  if (!id) {
    id = randomBytes(8).toString('hex');
    try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(MACHINE_FILE, JSON.stringify({ id }), { mode: 0o600 }); } catch {}
  }
  let version = '';
  try { version = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version ?? ''; } catch {}
  return { id, name: os.hostname(), version };
}

function normalizePeerUrl(raw) {
  const s = String(raw ?? '').trim().replace(/\/+$/u, '');
  if (!/^https?:\/\/[^/\s]+/iu.test(s)) throw new Error('地址必须以 http:// 或 https:// 开头');
  return s;
}

function startProxy() {
  const targetAuthority = `127.0.0.1:${TARGET_PORT}`;
  const ALLOW_LINK_KEY = hasFlag('--link-key');

  const isAuthed = (req) => {
    const raw = req.headers.cookie;
    if (typeof raw !== 'string') return false;
    const want = `${cookie.name}=${cookie.value}`;
    if (!raw.split(';').some((s) => s.trim() === want)) return false;
    const sid = cookieValue(req, 'dsh-hub-sid');
    if (!sid || !findSession(sid)) return false;
    touchSession(sid);
    return true;
  };

  const sendLoginCookie = (res, location = './', sid = '') => {
    const cookies = [
      `${cookie.name}=${cookie.value}; Max-Age=${String(30 * 86400)}; Path=/; Expires=${new Date(cookie.expiresAt).toUTCString()}; HttpOnly; SameSite=Lax`,
    ];
    if (sid) {
      cookies.push(`dsh-hub-sid=${sid}; Max-Age=${String(30 * 86400)}; Path=/; HttpOnly; SameSite=Lax`);
    }
    res.writeHead(303, {
      'set-cookie': cookies,
      location,
      'cache-control': 'no-store',
    });
    res.end();
  };

  const passwordMatches = (value) => {
    const a = Buffer.from(String(value ?? ''), 'utf8');
    const b = Buffer.from(LOGIN_KEY, 'utf8');
    return a.byteLength === b.byteLength && timingSafeEqual(a, b);
  };

  const loginPage = (error = '') => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 登录</title>
<style>
  :root{color-scheme:light dark}
  body{font:15px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0f1115;color:#e6e6e6}
  form{background:#171a21;border:1px solid #262b36;border-radius:14px;padding:26px;width:min(92vw,360px)}
  h1{font-size:18px;margin:0 0 6px}
  p{color:#8b93a1;font-size:13px;margin:0 0 16px}
  input{width:100%;box-sizing:border-box;background:#0f1115;border:1px solid #333b4a;border-radius:9px;padding:11px 12px;color:#e6e6e6;font-size:15px}
  button{margin-top:14px;width:100%;background:#3b82f6;color:#fff;border:0;border-radius:9px;padding:11px;font-size:15px;cursor:pointer}
  .err{color:#f87171;font-size:13px;margin-top:10px;min-height:18px}
</style></head><body>
<form method="post" action="/_login">
  <h1>DSH 访问密码</h1>
  <p>请输入这台电脑上 DSH 中枢的访问密码。</p>
  <input type="password" name="password" autocomplete="current-password" autofocus required>
  <button type="submit">进入</button>
  <div class="err">${error ? escapeHtml(error) : ''}</div>
</form>
</body></html>`;

  const readBody = (req, limit = 4096) => new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { resolve(''); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://hub.invalid');
    const ip = req.socket.remoteAddress ?? 'unknown';

    if (await handleAdmin(req, res, url)) return;

    if (url.pathname === '/_health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, target: targetAuthority, targetKind: TARGET_KIND, tunnel: Boolean(publicUrl), publicUrl }, null, 2));
      return;
    }

    // PWA 公共资源（不含敏感信息，登录前也可取）
    if (url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(PWA_MANIFEST);
      return;
    }
    if (url.pathname === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(PWA_SW);
      return;
    }
    if (url.pathname === '/icon.svg') {
      try {
        const svg = fs.readFileSync(path.join(HERE, '..', 'icon.svg'));
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
        res.end(svg);
      } catch {
        res.writeHead(404); res.end();
      }
      return;
    }

    if (url.pathname === '/_devices') {
      if (!isAuthed(req)) {
        res.writeHead(302, { location: '/_login', 'cache-control': 'no-store' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderDevicesPage());
      return;
    }

    if (url.pathname === '/_login') {
      if (throttled(ip)) {
        res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('尝试过于频繁，请 60 秒后再试。\n');
        return;
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        if (passwordMatches(params.get('password'))) {
          const sess = createSession(req);
          sendLoginCookie(res, './', sess.id);
          return;
        }
        recordFailure(ip);
        writeAudit('login-failed', { ip, name: describeUa(req.headers['user-agent']), path: 'password' });
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(loginPage('密码错误，请重试。'));
        return;
      }

      // 可选：--link-key 才允许用 URL 里的 key 直接登录（默认关闭）
      if (url.searchParams.has('key')) {
        if (ALLOW_LINK_KEY && passwordMatches(url.searchParams.get('key'))) {
          const sess = createSession(req);
          sendLoginCookie(res, './', sess.id);
          return;
        }
        recordFailure(ip);
        writeAudit('login-failed', { ip, name: describeUa(req.headers['user-agent']), path: 'link-key' });
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('链接登录已关闭，或链接中的口令错误。请打开 /_login 输入密码。\n');
        return;
      }

      if (isAuthed(req)) {
        res.writeHead(303, { location: './', 'cache-control': 'no-store' });
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(loginPage());
      return;
    }

    // 其余所有请求（含首页与静态资源）都必须先登录
    if (!isAuthed(req)) {
      res.writeHead(302, { location: '/_login', 'cache-control': 'no-store' });
      res.end();
      return;
    }

    const publicAuthority = req.headers.host ?? `127.0.0.1:${LISTEN_PORT}`;
    const headers = { ...req.headers };
    headers.host = targetAuthority;
    delete headers.origin;
    delete headers['sec-fetch-site'];
    // 首页 HTML 需要注入 PWA 标签，要求上游返回明文，避免压缩流无法改写
    const wantsHtml = req.method === 'GET' && (req.url === '/' || req.url === '');
    if (wantsHtml) headers['accept-encoding'] = 'identity';

    const upstream = http.request(
      { host: '127.0.0.1', port: TARGET_PORT, method: req.method, path: req.url, headers },
      (up) => {
        const out = { ...up.headers };
        // 允许本插件的「远程设备」面板用 iframe 嵌入对端 DSH
        delete out['x-frame-options'];
        if (typeof out['content-security-policy'] === 'string' && /frame-ancestors/iu.test(out['content-security-policy'])) {
          delete out['content-security-policy'];
        }
        if (out.location) {
          out.location = String(out.location)
            .replaceAll(`http://${targetAuthority}`, `http://${publicAuthority}`)
            .replaceAll(`https://${targetAuthority}`, `https://${publicAuthority}`);
        }
        const isHtml = wantsHtml && String(out['content-type'] ?? '').includes('text/html') && req.method === 'GET';
        if (isHtml) {
          delete out['content-encoding'];
          delete out['transfer-encoding'];
          delete out['content-length'];
          const chunks = [];
          up.on('data', (c) => chunks.push(c));
          up.on('end', () => {
            const html = injectPwa(Buffer.concat(chunks).toString('utf8'));
            const body = Buffer.from(html, 'utf8');
            out['content-length'] = body.length;
            res.writeHead(up.statusCode ?? 200, out);
            res.end(body);
          });
          return;
        }
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`DSH 桌面版不可达（${targetAuthority}）：${err.message}\n桌面版是否已退出或换了端口？重新运行本脚本即可。\n`);
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    if (!isAuthed(req)) { socket.destroy(); return; }
    const headers = { ...req.headers };
    headers.host = targetAuthority;
    delete headers.origin;
    delete headers['sec-fetch-site'];
    const up = net.connect(TARGET_PORT, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) {
        if (Array.isArray(v)) for (const one of v) lines.push(`${k}: ${one}`);
        else if (v !== undefined) lines.push(`${k}: ${v}`);
      }
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const die = () => socket.destroy();
    up.on('error', die);
    socket.on('error', die);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(LISTEN_PORT, '0.0.0.0', () => resolve(server));
  });
}

// ── 4. 隧道 ────────────────────────────────────────────────────────────────
const MANUAL_CF = opt('--cloudflared', '');
const CF_BIN_DIR = path.join(DSH_HOME, 'bin');
const CF_LOCAL = path.join(CF_BIN_DIR, 'cloudflared.exe');
let CF_PATH = '';

function worksAsCloudflared(candidate) {
  return new Promise((resolve) => {
    if (!candidate) return resolve(false);
    let p;
    try { p = spawn(candidate, ['--version'], { stdio: 'ignore', windowsHide: true }); } catch { return resolve(false); }
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

async function resolveCloudflared() {
  const candidates = [MANUAL_CF, 'cloudflared', CF_LOCAL].filter(Boolean);
  for (const c of candidates) {
    if (await worksAsCloudflared(c)) return c;
  }
  return '';
}

async function downloadCloudflared() {
  const urls = [
    'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
    'https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  ];
  fs.mkdirSync(CF_BIN_DIR, { recursive: true });
  const tmp = `${CF_LOCAL}.download`;
  for (const url of urls) {
    try {
      step(`下载 cloudflared：${url.split('/')[2]} …（约 50MB，慢是正常的）`);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) { warn(`HTTP ${res.status}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 5 * 1024 * 1024) { warn(`文件太小（${buf.length} 字节），跳过`); continue; }
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, CF_LOCAL);
      ok(`已保存到 ${CF_LOCAL}（${(buf.length / 1048576).toFixed(1)} MB）`);
      if (await worksAsCloudflared(CF_LOCAL)) return CF_LOCAL;
      warn('下载完成但无法执行，可能被安全软件拦截');
    } catch (err) {
      warn(`下载失败：${err.message}`);
    }
  }
  try { fs.unlinkSync(tmp); } catch {}
  return '';
}

function spawnCloudflared(extraArgs) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  tunnelLog = path.join(LOG_DIR, `cloudflared-${new Date().toISOString().replace(/[:.]/gu, '-')}.log`);
  const fd = fs.openSync(tunnelLog, 'a');
  const p = spawn(CF_PATH || 'cloudflared', extraArgs, { stdio: ['ignore', fd, fd], windowsHide: true });
  return p;
}

async function waitForTunnelUrl(ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800));
    try {
      const text = fs.readFileSync(tunnelLog, 'utf8');
      const matches = [...text.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/giu)].map((m) => m[0]);
      // cloudflared 日志里还会出现 API 端点 https://api.trycloudflare.com，必须跳过
      const real = matches.find((u) => !/^https:\/\/api\./iu.test(u));
      if (real) return real;
      if (/error|failed/iu.test(text) && /1033|connection|denied/iu.test(text)) {
        // 继续等，可能只是启动告警
      }
    } catch {}
    if (tunnelProc && tunnelProc.exitCode !== null) break;
  }
  return '';
}

// ── 本地管理接口（设置页用；仅 loopback）────────────────────────────────────
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLoopback = (req) => LOOPBACK.has(req.socket.remoteAddress ?? '');

function corsFor(req) {
  const origin = req.headers.origin;
  const ok = typeof origin === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/iu.test(origin);
  return ok
    ? {
        'access-control-allow-origin': origin,
        vary: 'origin',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,x-dsh-hub',
      }
    : {};
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function readPluginConfig() {
  if (!CONFIG_FILE) return null;
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; }
}

function writePluginConfig(patch) {
  const prev = readPluginConfig() ?? {};
  const next = { ...prev, ...patch };
  next.password = String(next.password ?? '');
  next.listenPort = Number(next.listenPort) || 19388;
  next.tunnel = ['off', 'quick', 'named'].includes(next.tunnel) ? next.tunnel : 'quick';
  next.tunnelToken = String(next.tunnelToken ?? '');
  next.publicUrl = String(next.publicUrl ?? '');
  next.targetPort = Number(next.targetPort) || 0;
  next.enabled = Boolean(next.enabled);
  if (next.enabled && next.password.length < 8) throw new Error('启用时访问密码至少 8 位');
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

function adminStatus() {
  const cfg = readPluginConfig() ?? {};
  return {
    enabled: !DISABLED,
    listenPort: LISTEN_PORT,
    target: TARGET_PORT || null,
    lanUrl: `http://${lanAddress()}:${LISTEN_PORT}/`,
    publicUrl: publicUrl || null,
    tunnel: TUNNEL_TOKEN ? 'named' : WANT_TUNNEL ? 'quick' : 'off',
    passwordSet: Boolean(cfg.password),
    updatedAt: new Date().toISOString(),
  };
}

function adminConfigView(reveal = false) {
  const cfg = readPluginConfig() ?? {};
  return {
    enabled: Boolean(cfg.enabled),
    passwordSet: Boolean(cfg.password),
    ...(reveal ? { password: cfg.password ?? '' } : {}),
    listenPort: cfg.listenPort ?? 19388,
    tunnel: cfg.tunnel ?? 'quick',
    tunnelTokenSet: Boolean(cfg.tunnelToken),
    publicUrl: cfg.publicUrl ?? '',
    targetPort: cfg.targetPort ?? 0,
  };
}

async function handleAdmin(req, res, url) {
  if (!isLoopback(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('localhost only\n');
    return true;
  }
  const cors = corsFor(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return true; }
  if (url.pathname === '/_status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors });
    res.end(JSON.stringify(adminStatus(), null, 2));
    return true;
  }
  if (url.pathname === '/_config' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors });
    res.end(JSON.stringify(adminConfigView(url.searchParams.get('reveal') === '1'), null, 2));
    return true;
  }
  if (url.pathname === '/_config' && req.method === 'POST') {
    if (req.headers['x-dsh-hub'] !== '1') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', ...cors });
      res.end('missing x-dsh-hub header\n');
      return true;
    }
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', ...cors });
      res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
      return true;
    }
    try {
      const patch = {};
      for (const k of ['enabled', 'password', 'listenPort', 'tunnel', 'tunnelToken', 'publicUrl', 'targetPort']) {
        if (k in body) patch[k] = body[k];
      }
      const next = writePluginConfig(patch);
      writeStatus({ enabled: next.enabled });
      writeAudit('config', { keys: Object.keys(patch).filter((k) => k !== 'password') });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...cors });
      res.end(JSON.stringify({ ok: true, restarting: true }));
      setTimeout(() => process.exit(0), 250);
      return true;
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', ...cors });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return true;
    }
  }
  if (url.pathname === '/_sessions' && req.method === 'GET') {
    const sessions = readSessions().map((s) => ({
      id: s.id.slice(0, 8),
      fullId: s.id,
      name: s.name,
      ip: s.ip,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      revokedAt: s.revokedAt ?? null,
    }));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors });
    res.end(JSON.stringify({ sessions }, null, 2));
    return true;
  }
  if (url.pathname === '/_sessions/revoke' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const id = String(body?.id ?? '');
    const list = readSessions();
    const target = list.find((s) => s.id === id || s.id.slice(0, 8) === id);
    if (!target) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', ...cors });
      res.end(JSON.stringify({ ok: false, error: 'session not found' }));
      return true;
    }
    target.revokedAt = Date.now();
    writeSessions(list);
    writeAudit('revoke', { session: target.id.slice(0, 8), name: target.name });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...cors });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  if (url.pathname === '/_sessions/revoke-all' && req.method === 'POST') {
    const list = readSessions();
    let count = 0;
    for (const s of list) {
      if (!s.revokedAt) { s.revokedAt = Date.now(); count += 1; }
    }
    writeSessions(list);
    writeAudit('revoke-all', { count });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...cors });
    res.end(JSON.stringify({ ok: true, revoked: count }));
    return true;
  }
  if (url.pathname === '/_audit' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors });
    res.end(JSON.stringify({ entries: readAudit(100) }, null, 2));
    return true;
  }
  if (url.pathname === '/_qr' && req.method === 'GET') {
    const data = String(url.searchParams.get('data') ?? '');
    if (!data) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', ...cors });
      res.end(JSON.stringify({ ok: false, error: 'missing data' }));
      return true;
    }
    try {
      const svg = qrSvg(data);
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store', ...cors });
      res.end(svg);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', ...cors });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }
  if (url.pathname === '/_peer' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors });
    res.end(JSON.stringify(machineInfo(), null, 2));
    return true;
  }
  if (url.pathname === '/_peers' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors });
    res.end(JSON.stringify({ peers: readPeers() }, null, 2));
    return true;
  }
  if (url.pathname === '/_peers' && req.method === 'POST') {
    const body = await readJsonBody(req);
    try {
      const urlStr = normalizePeerUrl(body?.url);
      const name = String(body?.name ?? '').trim() || new URL(urlStr).host;
      let reachable = false;
      try {
        const probe = await fetch(`${urlStr}/_health`, { signal: AbortSignal.timeout(4000) });
        reachable = probe.ok;
      } catch {}
      if (!reachable) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', ...cors });
        res.end(JSON.stringify({ ok: false, error: '连不上对方设备（/_health 无响应）' }));
        return true;
      }
      const list = readPeers();
      if (list.some((p) => p.url === urlStr)) {
        res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', ...cors });
        res.end(JSON.stringify({ ok: false, error: '该地址已存在' }));
        return true;
      }
      const peer = { id: randomBytes(6).toString('hex'), name, url: urlStr, createdAt: Date.now() };
      list.push(peer);
      writePeers(list);
      writeAudit('peer-add', { name });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...cors });
      res.end(JSON.stringify({ ok: true, peer }, null, 2));
      return true;
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', ...cors });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return true;
    }
  }
  if (url.pathname === '/_peers/remove' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const id = String(body?.id ?? '');
    const list = readPeers();
    const next = list.filter((p) => p.id !== id);
    writePeers(next);
    writeAudit('peer-remove', { id });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...cors });
    res.end(JSON.stringify({ ok: true, removed: list.length - next.length }));
    return true;
  }
  return false;
}

/** 未启用时只跑管理接口，其余请求 503。 */
function startDisabledServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://hub.invalid');
      if (url.pathname === '/_health') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, enabled: false }));
        return;
      }
      if (await handleAdmin(req, res, url)) return;
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('DSH Hub 未启用。请在 DSH 设置 → 远程访问 中开启。\n');
    });
    server.on('error', reject);
    server.listen(LISTEN_PORT, () => {
      ok(`管理接口已监听 127.0.0.1:${LISTEN_PORT}（未启用）`);
      resolve(server);
    });
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
(async () => {
  const WAIT_SEC = Number(opt('--wait', '0')) || 0;
  if (DISABLED) {
    step('DSH Hub 未启用，仅提供本地管理接口');
    try {
      await startDisabledServer();
    } catch (err) {
      bad(`管理接口启动失败：${err.message}`);
      process.exit(1);
    }
    return;
  }
  step('探测 DSH 宿主端口（桌面版 / dsh web）…');
  TARGET_PORT = await detectTarget();
  let waited = 0;
  while (!TARGET_PORT && waited < WAIT_SEC) {
    step(`还没检测到桌面版，继续等待…（已等 ${waited}s / 最多 ${WAIT_SEC}s）`);
    await new Promise((r) => setTimeout(r, 5000));
    waited += 5;
    TARGET_PORT = await detectTarget();
  }
  if (!TARGET_PORT) {
    bad('没有找到正在运行的 DSH 宿主（桌面版或 dsh web）。请先打开其中之一，或手动指定 --target <端口>。');
    try {
      const ports = listeningLoopbackPorts();
      console.log(`    诊断：解析到 ${ports.length} 个 loopback 监听端口` +
        (ports.length ? `（${ports.slice(0, 12).join(', ')}${ports.length > 12 ? '…' : ''}）` : '（为空：netstat 可能被安全软件/受限令牌拦截）'));
    } catch {}
    console.log('    也可以直接指定端口：.\\dsh-hub.cmd --target <端口>');
    if (!WAIT_SEC) bad('提示：加 --wait 600 可以在开机自启时等待宿主启动。');
    process.exit(1);
  }
  const kindLabel = TARGET_KIND === 'web' ? 'dsh web 宿主' : TARGET_KIND === 'manual' ? '手动指定' : 'DSH 桌面版';
  ok(`目标 DSH：http://127.0.0.1:${TARGET_PORT}（${kindLabel}${TARGET_WORKSPACE ? `，工作区 ${TARGET_WORKSPACE}` : ''}）`);
  writeStatus({ target: TARGET_PORT, kind: TARGET_KIND, workspace: TARGET_WORKSPACE || null });
  if (TARGET_KIND === 'web') {
    warn('注意：dsh web 与桌面版共享会话的前提是**同一个工作区目录**；不一致时两边看到的任务会不同。');
  }
  if (TUNNEL_TOKEN) {
    ok(`命名隧道已配置${PUBLIC_URL_OVERRIDE ? `：${PUBLIC_URL_OVERRIDE}` : '（未设置 --public-url）'}`);
    console.log(`    请确认 Cloudflare 中该隧道的 Public Hostname 指向 http://127.0.0.1:${LISTEN_PORT}`);
  }

  cookie = mintCookie(TARGET_PORT);
  ok(`已签发会话 Cookie（有效期至 ${new Date(cookie.expiresAt).toLocaleString('zh-CN', { hour12: false })}）`);

  // 多宿主冲突检查：桌面版与 dsh web 共用同一个 DSH_HOME 时会争抢会话写租约
  const others = await detectOtherHosts();
  if (others.webAlive && TARGET_KIND !== 'web') {
    if (STOP_WEB_HOST) {
      step(`停止 web 宿主（端口 ${others.web?.port ?? '?'}，PID ${others.web?.pid ?? '?'}）…`);
      try { process.kill(Number(others.web.pid), 'SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 1500));
      try { fs.unlinkSync(path.join(DSH_HOME, 'dsh-web-host.json')); } catch {}
      ok('已停止 web 宿主，现在只有桌面版持有会话');
    } else if (ALLOW_MULTI_HOST) {
      warn('已按 --allow-multi-host 允许双宿主共存；同一会话仍只能由一个宿主持有。');
    } else {
      warn('检测到 dsh web 与桌面版同时在跑，且共用同一个 DSH_HOME。');
      console.log('    两者会争抢同一批会话（session/writer-held），表现为一边能发、另一边发不了。');
      console.log('    建议只保留一个宿主：');
      console.log('      .\\dsh-web-host.cmd -Stop            停掉 web 宿主，只留桌面版');
      console.log('      或给本脚本加 --stop-web-host         由中枢自动停掉它');
      console.log('      确实要让两者共存时加 --allow-multi-host');
    }
  }
  if (others.desktopAlive && TARGET_KIND === 'web') {
    warn('桌面版也在运行；若它打开过同一会话，本 web 宿主可能拿到 session/writer-held。');
  }

  try {
    const probe = await fetch(`http://127.0.0.1:${TARGET_PORT}/`, { headers: { cookie: `${cookie.name}=${cookie.value}` }, signal: AbortSignal.timeout(4000) });
    if (probe.status === 200) ok('会话 Cookie 校验通过');
    else warn(`会话 Cookie 校验未通过（HTTP ${probe.status}）——这个宿主可能用了不同的 DSH_HOME，或密钥已轮换。`);
  } catch (err) {
    warn(`会话 Cookie 校验失败：${err.message}`);
  }

  let server;
  try {
    server = await startProxy();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      bad(`端口 ${LISTEN_PORT} 已被占用。可能已有一个中枢在运行；用浏览器打开 http://127.0.0.1:${LISTEN_PORT}/_health 确认，或换 --port。`);
    } else {
      bad(`代理启动失败：${err.message}`);
    }
    process.exit(1);
  }
  ok(`本机代理已监听 0.0.0.0:${LISTEN_PORT}`);
  writeStatus({ listenPort: LISTEN_PORT, lanUrl: `http://${lanAddress()}:${LISTEN_PORT}/` });

  const lan = lanAddress();
  console.log('');
  console.log('═══ 局域网（同一 WiFi）═══');
  console.log(`  访问地址： http://${lan}:${LISTEN_PORT}/`);
  console.log(`  访问密码： ${LOGIN_KEY}`);
  console.log(`  设备导航： http://${lan}:${LISTEN_PORT}/_devices`);

  if (!WANT_TUNNEL) {
    console.log('');
    warn('已跳过公网隧道（--no-tunnel）。Ctrl+C 停止。');
    return;
  }

  step('检查 cloudflared …');
  CF_PATH = await resolveCloudflared();
  if (!CF_PATH) {
    step('未找到 cloudflared，尝试自动下载到本机 …');
    CF_PATH = await downloadCloudflared();
  }
  if (!CF_PATH) {
    console.log('');
    warn('无法获得 cloudflared，公网隧道未开启。可手动处理：');
    console.log('    winget install --id Cloudflare.cloudflared -e');
    console.log(`    或把 cloudflared.exe 放到：${CF_LOCAL}`);
    console.log('  然后重新运行本脚本。');
    console.log('');
    warn('局域网地址仍可用。Ctrl+C 停止。');
    return;
  }
  ok(`cloudflared 就绪：${CF_PATH}`);

  if (TUNNEL_TOKEN) {
    step('以命名隧道模式启动（固定域名，需你在 Cloudflare 配好 ingress）…');
    tunnelProc = spawnCloudflared(['tunnel', 'run', '--token', TUNNEL_TOKEN]);
    publicUrl = PUBLIC_URL_OVERRIDE;
  } else {
    step('建立免费快速隧道（地址每次重启会变）…');
    tunnelProc = spawnCloudflared(['tunnel', '--url', `http://127.0.0.1:${LISTEN_PORT}`, '--no-autoupdate']);
    publicUrl = await waitForTunnelUrl();
  }

  tunnelProc.on('exit', (code) => {
    if (code !== 0) {
      warn(`cloudflared 已退出（code ${code}）。常见原因：本机代理/VPN 的 TUN 模式掐断了隧道连接。`);
      if (tunnelLog) console.log(`  日志：${tunnelLog}`);
    }
    publicUrl = '';
  });

  if (publicUrl) {
    saveState({ lastPublicUrl: publicUrl });
    writeStatus({ publicUrl, tunnel: TUNNEL_TOKEN ? 'named' : 'quick' });
    console.log('');
    console.log('═══ 公网（4G / 任意网络 / 其他设备）═══');
    console.log(`  访问地址： ${publicUrl}/`);
    console.log(`  访问密码： ${LOGIN_KEY}`);
    console.log(`  设备导航： ${publicUrl}/_devices`);
  } else if (TUNNEL_TOKEN) {
    console.log('');
    warn(`命名隧道已启动，但公网地址由你的 Cloudflare 配置决定。`);
    console.log('  如果你已绑定域名，访问： <你的域名>/ ，密码：' + LOGIN_KEY);
    writeStatus({ tunnel: 'named', publicUrl: PUBLIC_URL_OVERRIDE || null });
    if (tunnelLog) console.log(`  日志：${tunnelLog}`);
  } else {
    console.log('');
    warn('隧道尚未给出公网地址。若 30 秒后仍无地址，请查看日志：');
    if (tunnelLog) console.log(`  ${tunnelLog}`);
    console.log('  常见原因：本机代理/VPN 的 TUN 模式掐断隧道（关掉 TUN 再试）。');
  }

  console.log('');
  console.log('提示：本窗口保持开启；Ctrl+C 停止中枢与隧道。电脑休眠会断开，建议设置“永不睡眠”。');
  console.log('');

  const shutdown = () => {
    try { tunnelProc?.kill(); } catch {}
    try { server.close(); } catch {}
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((err) => {
  bad(err.stack ?? String(err));
  process.exit(1);
});
