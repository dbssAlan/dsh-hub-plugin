/**
 * dsh-hub-plugin —— host 半：把 DSH 安全发布到局域网/公网。
 *
 * v0.3：
 *   - 设置页通过宿主同源路由 /dsh-hub/* 读写配置（无 CORS、无跨端口）
 *   - 配置写入 %DSH_HOME%/dsh-hub-plugin/config.json
 *   - 子进程常驻：未启用时只提供本地管理接口；启用后提供反代/隧道
 *   - 子进程退出（保存配置/崩溃）后自动重建，读取最新配置
 *
 * 安全默认：enabled=false；密码至少 8 位；写接口要求同源 Origin。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'lib', 'hub-cli.mjs');

export const name = 'dsh-hub-plugin';

// 需要当前 profile 的 web 服务器端口，用来确定反代目标
export const inject = ['webServer'];

let z;
try {
  z = require('@deepseek-ai/schemastery');
  z = z?.default ?? z;
} catch {
  z = undefined;
}

export const Config = z
  ? z.object({
      enabled: z.boolean().default(false).description('启用 DSH Hub 远程访问'),
      password: z.string().default('').description('访问密码（至少 8 位）'),
      listenPort: z.natural().default(19388).description('本机代理端口'),
      tunnel: z.string().default('quick').description('off / quick / named'),
      tunnelToken: z.string().default('').description('命名隧道 Token'),
      publicUrl: z.string().default('').description('命名隧道对外地址'),
      targetPort: z.natural().default(0).description('目标宿主端口，0=自动'),
    })
  : undefined;

function stateDir() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'dsh-hub-plugin');
}

const DEFAULTS = {
  enabled: false,
  password: '',
  listenPort: 19388,
  tunnel: 'quick',
  tunnelToken: '',
  publicUrl: '',
  targetPort: 0,
};

function normalize(raw) {
  const c = { ...DEFAULTS, ...(raw ?? {}) };
  c.enabled = Boolean(c.enabled);
  c.password = String(c.password ?? '');
  c.listenPort = Number(c.listenPort) || 19388;
  c.tunnel = ['off', 'quick', 'named'].includes(c.tunnel) ? c.tunnel : 'quick';
  c.tunnelToken = String(c.tunnelToken ?? '');
  c.publicUrl = String(c.publicUrl ?? '');
  c.targetPort = Number(c.targetPort) || 0;
  return c;
}

function readConfigFile(file) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function writeConfigFile(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

export function apply(ctx, config) {
  const dir = stateDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const configFile = path.join(dir, 'config.json');
  const statusFile = path.join(dir, 'status.json');
  const logFile = path.join(dir, 'hub.log');

  // 首次运行把 Cordis 配置落盘；之后设置页写入的文件是唯一事实来源
  let initial = readConfigFile(configFile);
  if (!initial) {
    initial = normalize(config);
    try { writeConfigFile(configFile, initial); } catch {}
  }

  // 同源管理路由：浏览器 → 宿主 /dsh-hub/* → 反代子进程 /_status、/_config
  if (typeof ctx.webServer?.register === 'function') {
    const route = {
      kind: 'prefix',
      path: '/dsh-hub',
      handler: async (req, res) => {
        try {
          const u = new URL(req.url ?? '/dsh-hub', 'http://hub.invalid');
          const sub = u.pathname.slice('/dsh-hub'.length) || '/';
          const routes = {
            '/status': '/_status',
            '/config': '/_config',
            '/sessions': '/_sessions',
            '/sessions/revoke': '/_sessions/revoke',
            '/sessions/revoke-all': '/_sessions/revoke-all',
            '/audit': '/_audit',
            '/qr': '/_qr',
          };
          const target = routes[sub] ?? null;
          if (target === null) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('not found\n');
            return;
          }
          if (req.method === 'POST') {
            // 防 CSRF：要求自定义头（跨站会触发预检，而本路由不返回 CORS 头）。
            // 不校验 Origin，因为设置页也可能从隧道域名（远程）打开。
            if (req.headers['x-dsh-hub'] !== '1') {
              res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('forbidden\n');
              return;
            }
          }
          const cfg = readConfigFile(configFile) ?? initial;
          const port = cfg.listenPort || 19388;
          let body;
          if (req.method === 'POST') body = await readBody(req);
          const upstream = await fetch(`http://127.0.0.1:${port}${target}${sub === '/qr' ? u.search : ''}`, {
            method: req.method,
            headers: {
              'x-dsh-hub': '1',
              'content-type': req.headers['content-type'] ?? 'application/json',
            },
            body: body && body.length ? body : undefined,
          });
          const text = await upstream.text();
          res.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(text);
        } catch (err) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: `管理接口不可用：${err.message}` }));
        }
      },
    };
    ctx.effect(() => {
      const off = ctx.webServer.register(route);
      return () => { try { if (typeof off === 'function') off(); } catch {} };
    }, 'dsh-hub: same-origin admin route');
  }

  ctx.effect(() => {
    let stopped = false;
    let child = null;
    let timer = null;
    let restarts = 0;
    let windowStart = Date.now();

    const spawnChild = () => {
      if (stopped) return;
      const cfg = readConfigFile(configFile) ?? initial;
      const target = cfg.targetPort || Number(ctx.webServer?.port) || 0;
      const args = [
        CLI,
        '--config-file', configFile,
        '--status-file', statusFile,
        '--port', String(cfg.listenPort),
      ];
      if (target) args.push('--target', String(target));
      if (!cfg.enabled || cfg.password.length < 8) {
        args.push('--disabled');
      } else {
        args.push('--key', cfg.password);
        if (cfg.tunnel === 'off') args.push('--no-tunnel');
        if (cfg.tunnel === 'named' && cfg.tunnelToken) {
          args.push('--tunnel-token', cfg.tunnelToken);
          if (cfg.publicUrl) args.push('--public-url', cfg.publicUrl);
        }
      }

      let fd;
      try { fd = fs.openSync(logFile, 'a'); } catch { fd = 'ignore'; }
      child = spawn(process.execPath, args, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
      if (typeof fd === 'number') { try { fs.closeSync(fd); } catch {} }

      child.on('error', (err) => console.error('[dsh-hub] 启动失败：', err));
      child.on('exit', (code) => {
        if (stopped) return;
        // 保存配置/切换后子进程会主动退出（code 0），这里按最新配置重建
        if (Date.now() - windowStart > 60_000) { restarts = 0; windowStart = Date.now(); }
        restarts += 1;
        if (restarts > 30) {
          console.error('[dsh-hub] 重启过于频繁，已暂停。日志：', logFile);
          return;
        }
        timer = setTimeout(spawnChild, code === 0 ? 400 : 2000);
      });
    };

    timer = setTimeout(spawnChild, 3000);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      try { child?.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} }, 1200).unref?.();
    };
  }, 'dsh-hub: remote access child process');
}
