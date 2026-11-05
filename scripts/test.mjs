// 端到端回归测试：起一个假 DSH 宿主，验证 Hub 的登录、限速、会话撤销、
// 管理令牌、SSRF 防护、反代与 iframe 白名单。
//
//   node scripts/test.mjs
//
// 全部在本机 127.0.0.1 上跑，不需要 cloudflared，也不会碰用户真实的 DSH_HOME。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'));
const CLI = path.join(HERE, '..', 'lib', 'hub-cli.mjs');
// 测试凭据每次运行随机生成：源码里不留任何 token/密码字面量（避免密钥扫描误报）。
const TOKEN = randomBytes(24).toString('hex');
const KEY = 'pw-' + randomBytes(12).toString('base64url');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

function request(port, opts = {}) {
  const { method = 'GET', path: p = '/', headers = {}, host = '127.0.0.1', body } = opts;
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path: p, headers, timeout: 10_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        setCookie: res.headers['set-cookie'] ?? [],
      }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function cookieOf(setCookie) {
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

function freePort() {
  return 19000 + Math.floor(Math.random() * 500);
}

async function waitHealth(port, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const r = await request(port, { path: '/_health' });
      if (r.status === 200) return JSON.parse(r.body);
    } catch {}
    await sleep(200);
  }
  return null;
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-test-'));
  const secret = Buffer.alloc(32, 7).toString('base64url');
  fs.writeFileSync(path.join(home, '.credentials.yaml'),
    `client-connection/browser-session:\n  payload:\n    secret: ${secret}\n`);
  return home;
}

async function startHub(extra = {}) {
  const port = extra.port ?? freePort();
  const home = extra.home ?? makeHome();
  const statusFile = path.join(home, 'status.json');
  const child = spawn(process.execPath, [
    CLI,
    '--port', String(port),
    '--no-tunnel',
    '--key', KEY,
    '--admin-token', TOKEN,
    '--no-print-key',
    '--status-file', statusFile,
    ...(extra.args ?? []),
  ], {
    env: { ...process.env, ...(extra.env ?? {}), DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const health = await waitHealth(port);
  if (!health?.ok) {
    child.kill('SIGKILL');
    throw new Error(`hub 未启动（port ${port}）\n输出：\n${output.slice(0, 3000)}`);
  }
  return { port, home, statusFile, child, stop: () => { try { child.kill('SIGKILL'); } catch {} } };
}

async function main() {
  // ── 假 DSH 宿主 ────────────────────────────────────────────────────────────
  let lastUpstreamHeaders = {};
  const upstream = http.createServer((req, res) => {
    lastUpstreamHeaders = req.headers;
    if (req.url === '/api') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    });
    res.end('<!doctype html><html><head><title>dummy</title></head><body><div id="root">dummy dsh</div></body></html>');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.address().port;

  const hub = await startHub({ args: ['--target', String(upstreamPort)] });
  const lan = lanAddress();

  try {
    // ── 基础 ────────────────────────────────────────────────────────────────
    const health = await request(hub.port, { path: '/_health' });
    check('_health 只暴露最小信息', () => {
      const j = JSON.parse(health.body);
      assert.equal(j.ok, true);
      assert.equal(j.target, undefined);
      assert.equal(j.publicUrl, undefined);
    });

    const root = await request(hub.port, { path: '/' });
    check('未登录访问首页 → 302 登录页', () => assert.equal(root.status, 302));

    const loginPageRes = await request(hub.port, { path: '/_login' });
    check('登录页可访问', () => {
      assert.equal(loginPageRes.status, 200);
      assert.match(loginPageRes.body, /DSH 访问密码/u);
    });

    // ── 管理接口必须带令牌（原先公网可未认证读密码）──────────────────────────
    const adminNoToken = await request(hub.port, { path: '/_status' });
    check('管理接口无令牌 → 403', () => assert.equal(adminNoToken.status, 403));

    const revealNoToken = await request(hub.port, { path: '/_config?reveal=1' });
    check('未认证读明文密码 → 403（回归）', () => {
      assert.equal(revealNoToken.status, 403);
      assert.equal(JSON.parse(revealNoToken.body).password, undefined);
    });

    const admin = { 'x-dsh-hub-admin': TOKEN };
    const statusRes = await request(hub.port, { path: '/_status', headers: admin });
    check('管理接口带令牌 → 200', () => assert.equal(statusRes.status, 200));

    const reveal = await request(hub.port, { path: '/_config?reveal=1', headers: admin });
    check('带令牌可读配置（含密码）', () => assert.equal(JSON.parse(reveal.body).password, KEY));

    const peerSsrF = await request(hub.port, {
      method: 'POST', path: '/_peers', headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1' }),
    });
    check('peer 地址指向内网 → 400', () => {
      assert.equal(peerSsrF.status, 400);
      assert.match(peerSsrF.body, /内网|回环|保留/u);
    });

    // ── 登录成功（HTTPS 场景要带 Secure）────────────────────────────────────
    const loginHttps = await request(hub.port, {
      method: 'POST', path: '/_login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' },
      body: `password=${encodeURIComponent(KEY)}`,
    });
    check('正确密码 → 303 + HttpOnly/Secure Cookie', () => {
      assert.equal(loginHttps.status, 303);
      const joined = loginHttps.setCookie.join('\n');
      assert.match(joined, /dsh-hub-sid=/u);
      assert.match(joined, /HttpOnly/u);
      assert.match(joined, /Secure/u);
    });
    const cookies = cookieOf(loginHttps.setCookie);

    const homeRes = await request(hub.port, { path: '/', headers: { cookie: cookies } });
    check('登录后首页经反代返回，并注入 PWA', () => {
      assert.equal(homeRes.status, 200);
      assert.match(homeRes.body, /manifest\.webmanifest/u);
      assert.match(homeRes.body, /dummy dsh/u);
    });
    check('反代不透传 Origin、注入内部标记', () => {
      assert.equal(lastUpstreamHeaders.origin, undefined);
      assert.equal(lastUpstreamHeaders['x-dsh-hub-proxy'], '1');
    });

    const apiRes = await request(hub.port, { path: '/api', headers: { cookie: cookies } });
    check('API 直通', () => assert.equal(apiRes.status, 200));

    // ── 重启后不掉登录（Cookie 复用）────────────────────────────────────────
    hub.stop();
    await sleep(400);
    const hub2 = await startHub({ port: hub.port, home: hub.home, args: ['--target', String(upstreamPort)] });
    try {
      const afterRestart = await request(hub2.port, { path: '/', headers: { cookie: cookies } });
      check('重启 hub 后旧 Cookie 仍然有效', () => assert.equal(afterRestart.status, 200));
    } finally {
      // 继续用重启后的实例跑剩余用例
      Object.assign(hub, { port: hub2.port, child: hub2.child, stop: hub2.stop });
    }

    // ── iframe 白名单 ───────────────────────────────────────────────────────
    const normalFrame = await request(hub.port, { path: '/', headers: { cookie: cookies } });
    check('普通访问保留 X-Frame-Options', () => assert.equal(normalFrame.headers['x-frame-options'], 'DENY'));

    const embedFrame = await request(hub.port, {
      path: '/', headers: { cookie: cookies, 'sec-fetch-dest': 'iframe', referer: 'http://127.0.0.1:9/' },
    });
    check('本机页面嵌入时放开 frame 限制但保留其他 CSP', () => {
      assert.equal(embedFrame.headers['x-frame-options'], undefined);
      const csp = embedFrame.headers['content-security-policy'] ?? '';
      assert.doesNotMatch(csp, /frame-ancestors/u);
      assert.match(csp, /default-src/u);
    });

    const evilFrame = await request(hub.port, {
      path: '/', headers: { cookie: cookies, 'sec-fetch-dest': 'iframe', referer: 'https://evil.example/' },
    });
    check('第三方站点嵌入仍被 X-Frame-Options 挡住', () => assert.equal(evilFrame.headers['x-frame-options'], 'DENY'));

    // ── 设备页与会话 ────────────────────────────────────────────────────────
    const devices = await request(hub.port, { path: '/_devices', headers: { cookie: cookies } });
    check('/_devices 登录后可访问', () => assert.equal(devices.status, 200));

    const sessions = JSON.parse((await request(hub.port, { path: '/_sessions', headers: admin })).body).sessions;
    check('会话列表含当前设备', () => assert.ok(sessions.some((s) => !s.revokedAt)));

    const revoke = await request(hub.port, {
      method: 'POST', path: '/_sessions/revoke', headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ id: sessions[0].fullId }),
    });
    check('撤销会话 → 200', () => assert.equal(revoke.status, 200));

    const afterRevoke = await request(hub.port, { path: '/', headers: { cookie: cookies } });
    check('撤销后旧 Cookie 失效 → 302', () => assert.equal(afterRevoke.status, 302));

    // ── 局域网来源不再 403（P0 回归）────────────────────────────────────────
    if (lan) {
      try {
        const lanRoot = await request(hub.port, { path: '/', host: lan });
        check(`局域网来源 http://${lan}:${hub.port}/ 不再 403`, () => assert.equal(lanRoot.status, 302));
        const lanAdmin = await request(hub.port, { path: '/_status', host: lan });
        check('局域网来源调用管理接口仍被拒绝', () => assert.equal(lanAdmin.status, 403));
      } catch (err) {
        console.log(`  ..  跳过局域网用例（本机无法经 ${lan} 回连：${err.code ?? err.message}）`);
      }
    } else {
      console.log('  ..  跳过局域网用例（没有非 loopback 网卡）');
    }

    // ── 限速（放最后，会锁住本机 IP 60s）────────────────────────────────────
    for (let i = 0; i < 5; i += 1) {
      await request(hub.port, {
        method: 'POST', path: '/_login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=wrong-password',
      });
    }
    const throttledRes = await request(hub.port, {
      method: 'POST', path: '/_login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=wrong-password',
    });
    check('连续失败 5 次后限速 → 429', () => assert.equal(throttledRes.status, 429));

    const throttledCorrect = await request(hub.port, {
      method: 'POST', path: '/_login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(KEY)}`,
    });
    check('限速期间正确密码也被拒', () => assert.equal(throttledCorrect.status, 429));

    // ── 停用模式 ────────────────────────────────────────────────────────────
    const disabled = await startHub({ args: ['--disabled'] });
    try {
      const h = JSON.parse((await request(disabled.port, { path: '/_health' })).body);
      check('停用模式 _health 标记 enabled=false', () => assert.equal(h.enabled, false));
      const adminDisabled = await request(disabled.port, { path: '/_status' });
      check('停用模式管理接口仍要令牌', () => assert.equal(adminDisabled.status, 403));
      const adminDisabledWithToken = await request(disabled.port, { path: '/_status', headers: admin });
      check('停用模式带令牌可管理', () => assert.equal(adminDisabledWithToken.status, 200));
    } finally {
      disabled.stop();
    }
  } finally {
    hub.stop();
    upstream.close();
    await sleep(300);
    try { fs.rmSync(hub.home, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}：${passed} 通过，${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试运行失败：', err);
  process.exit(1);
});
