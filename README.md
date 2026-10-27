# DSH Hub 远程访问（dsh-hub-plugin）

[![npm](https://img.shields.io/npm/v/dsh-hub-plugin)](https://www.npmjs.com/package/dsh-hub-plugin)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

把本机 DSH（DeepSeek Harness）安全地发布到**局域网 / 公网**：访问密码、二维码、设备导航页、cloudflared 隧道，全部在 **DSH 设置页**里管理，不需要命令行。

> 适合：用手机/平板/另一台电脑，通过浏览器远程使用这台电脑上的 DSH 会话。

---

## 特性

- **访问密码**：URL 不含密码，打开后必须输入；登录后 30 天 HttpOnly Cookie
- **局域网 + 公网**：同一 WiFi 直连；公网用 cloudflared（免费随机域名，或命名隧道固定域名）
- **设备导航页**：二维码、分享链接、访问密码，一键复制
- **桌面版直连**：直接发布 Electron 桌面版宿主，不额外起第二个宿主
- **多宿主冲突提示**：检测到桌面版与 `dsh web` 同时运行会提醒（避免会话写租约互相锁）
- **插件形态**：随 DSH 启停，设置页开关，无需单独开终端
- **安全默认**：默认关闭；密码至少 8 位；写接口需 `x-dsh-hub` 头（防 CSRF）

---

## 工作原理

```
手机 / 平板 / 另一台电脑（浏览器）
        │  https://xxxx.trycloudflare.com（访问密码）
        ▼
   cloudflared 隧道
        ▼
┌──────────────────────────────┐
│ 本机 DSH Hub 反代 :19388      │
│  - 密码页 / 30 天 Cookie      │
│  - Host 改写（绕过 Host 栅栏）│
│  - 设备导航页 / 二维码        │
└──────────────┬───────────────┘
               │ 127.0.0.1:<DSH 端口>
               ▼
┌──────────────────────────────┐
│ DSH 宿主（桌面版或 dsh web）  │
│  - 会话、工作区、插件          │
└──────────────────────────────┘

设置页 ── 同源路由 /dsh-hub/* ──> 宿主插件 ──> 反代子进程
```

DSH 默认只监听 `127.0.0.1`，并对 Host 有校验。Hub 在本机做反向代理：把 Host 改写成 `127.0.0.1:<port>`，同时用本机密钥签发 DSH 认可的会话 Cookie，再把入口保护在访问密码之后。

---

## 安装

### 从 npm 安装（推荐）

```
dsh-hub-plugin
```

- **桌面版**：设置 → 插件 → 添加插件，填 `dsh-hub-plugin`
- **命令行（web profile）**：

```bash
dsh plugin --profile web add -w dsh-hub-plugin
```

### 从 GitHub 安装

```
https://github.com/dbssAlan/dsh-hub-plugin
```

- **桌面版**：设置 → 插件 → 添加插件，填上面的仓库地址
- **命令行（web profile）**：

```bash
dsh plugin --profile web add -w https://github.com/dbssAlan/dsh-hub-plugin
```

安装后打开：`Ctrl + ,` → **远程访问**。

### 本地目录（开发）

```bash
git clone https://github.com/dbssAlan/dsh-hub-plugin.git
```

桌面版：设置 → 插件 → 安装 → 选择本地目录。

> 桌面 profile 由 Electron 管理，不能用 `dsh plugin --profile desktop` 直接安装，请走桌面端插件页。

### 从源码运行（web profile）

```bash
DSH_HOME=/path/to/home dsh plugin --profile web add -w /path/to/dsh-hub-plugin
```

---

## 快速开始

1. 打开 **设置 → 远程访问**
2. 勾选「启用远程访问」
3. 填访问密码（至少 8 位）
4. 选隧道模式：`off`（仅局域网）/ `quick`（免费随机域名）/ `named`（固定域名）
5. 点「保存并重启」
6. 点「打开设备导航页」看二维码，手机扫码 → 输入密码 → 进入 DSH

手机打开公网地址后输入密码，30 天内免登录。

---

## 配置项

首次启动时，Cordis 配置会写入 `%DSH_HOME%/dsh-hub-plugin/config.json`；之后以设置页 / 该文件为准（JSON 覆盖 YAML）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 启用远程访问 |
| `password` | `""` | 访问密码，至少 8 位 |
| `listenPort` | `19388` | 本机反代端口 |
| `tunnel` | `quick` | `off` / `quick` / `named` |
| `tunnelToken` | `""` | 命名隧道 Token（Cloudflare Zero Trust） |
| `publicUrl` | `""` | 命名隧道对外地址，如 `https://dsh.example.com` |
| `targetPort` | `0` | 目标 DSH 端口；0 = 自动（当前宿主） |

### 命名隧道（固定域名）

1. Cloudflare Zero Trust → **Networks → Tunnels → Create a tunnel**
2. Public Hostname 指向 `http://127.0.0.1:19388`（与 `listenPort` 一致）
3. 复制 Tunnel Token
4. 设置页：隧道模式选 `named`，填入 Token 和你的域名（如 `https://dsh.example.com`）
5. 保存并重启

> 快速隧道的域名每次重启会变；固定域名请用命名隧道。

---

## 安全模型

- **访问密码是唯一门槛**，且不在 URL 里；链接被转发也无法直接进入
- 登录 Cookie：30 天、`HttpOnly`、`SameSite=Lax`
- 登录失败限速：5 次 / 60 秒
- 设置页写接口走宿主同源路由 `/dsh-hub/*`，校验 `x-dsh-hub` 请求头（防 CSRF）
- 公网入口由 cloudflared 提供 TLS，本机端口不直接暴露

**注意**：DSH 可以执行本机命令，密码泄露等于电脑控制权。密码明文保存在 `config.json`（权限 0600），建议用 16 位以上随机串；公网长期使用建议叠加 Cloudflare Access。

更多见 [SECURITY.md](SECURITY.md)。

---

## 设备会话、二维码与审计

设置页（`Ctrl + ,` → 远程访问）现在包含：

- **二维码**：直接显示当前公网/局域网地址，手机扫码即可打开
- **设备会话**：每台登录过的设备（浏览器 + 系统、IP、最近活跃时间），可**逐个撤销**或**撤销全部**
  - 撤销后该设备下一次请求就会被要求重新登录，不影响其他设备
- **登录审计**：最近 100 条记录（登录成功/失败、撤销、配置变更），写入
  `%DSH_HOME%/dsh-hub-plugin/audit.jsonl`

> 会话 Cookie 名为 `dsh-hub-sid`，与 DSH 登录 Cookie 一起下发；
> 撤销只影响 Hub 的会话，不改变 DSH 本身的密钥。

---

## 与同类方案的区别

| | 本插件 | dsh-pocket | dsh-remote | dsh-mobile |
|---|---|---|---|---|
| 形态 | DSH 插件 | DSH 插件 | DSH 插件 + 云端 | 手机 App |
| 桌面版宿主 | ✅ 直接发布 | 兼容模式 | 需 `dsh web` | 需 `dsh web` |
| 公网通道 | cloudflared | cloudflared | 自建/云端中继 | relay / SSH |
| 移动端 UI | 原生 Web | 专门适配 | 完整 Web | 原生 |
| 额外账号/服务 | 无 | 无 | 有 | relay 服务 |
| 多宿主冲突检测 | ✅ | — | — | — |

本插件的取舍：**零第三方账号、直连桌面版、设置页一体化**；移动端 UI 与原生 App 不是它的目标（可作为后续迭代）。

---

## 排错

| 现象 | 处理 |
|---|---|
| 设置页显示「连不上宿主管理路由」 | 确认插件已启用、桌面版已重启；必要时 `Ctrl + R` 刷新页面 |
| 公网 401 `dsh web authentication required` | 直接访问了不带密码的 URL；先打开登录页输入密码（或用带口令链接登录一次） |
| `error 1033` / 隧道连不上 | 本机代理/VPN 的 TUN 模式可能掐断隧道；关 TUN，或给 `trycloudflare.com`、`argotunnel.com` 加直连规则 |
| `session/writer-held` | 另一个 DSH 宿主占着会话；只保留一个宿主（桌面版或 `dsh web`） |
| 端口 19388 被占用 | 设置页改 `listenPort`，或先在 `/_health` 确认是否已有实例 |
| 桌面版重启后公网地址变了 | 快速隧道特性；改用命名隧道固定域名 |

日志与状态：

- 日志：`%DSH_HOME%/dsh-hub-plugin/hub.log`
- 状态：`%DSH_HOME%/dsh-hub-plugin/status.json`
- 健康检查：`http://127.0.0.1:<listenPort>/_health`

---

## 常见问题

**Q：为什么不用 SSHJ 或 VPN？**
本插件面向「手机/平板随手打开浏览器」；SSH/VPN 在鸿蒙/移动网络下的体验和配置成本更高。需要网格组网可以用 Tailscale，本插件也兼容（把地址换成 tailnet 地址即可）。

**Q：要装 cloudflared 吗？**
不需要手动装：插件首次建立隧道时会自动下载到 `%DSH_HOME%/bin`（约 53 MB）。也可以提前用 `winget install --id Cloudflare.cloudflared` 安装。

**Q：会话会和其他设备冲突吗？**
不会——所有设备访问的是**同一个宿主**，共享同一批会话。冲突只发生在「两个 DSH 宿主同时打开同一会话」时，插件会提示并支持停掉 extra 宿主。

**Q：能同时用桌面版和 `dsh web` 吗？**
可以，但每个会话只能有一个宿主写入（DSH 的跨进程租约）。建议只保留一个宿主。

**Q：手机能免密吗？**
首次输入密码后发 30 天 Cookie，期间免密；换浏览器/清 Cookie 需要重新输入。

---

## 开发

```bash
git clone https://github.com/dbssAlan/dsh-hub-plugin.git
cd dsh-hub-plugin
node --check index.js
node --check client.js
node --check lib/hub-cli.mjs
```

目录：

```
index.js           # host 半：Config、/dsh-hub/* 同源路由、子进程生命周期
client.js          # 浏览器半：设置页（settings.section）
lib/hub-cli.mjs    # 反代/密码页/设备页/隧道（可独立运行）
lib/vendor/        # 离线二维码库
locale/            # 插件市场显示用
```

独立运行（不经插件，便于调试）：

```bash
node lib/hub-cli.mjs --port 19388 --no-tunnel
```

---

## 路线图

- [x] v0.1 插件骨架 + 设置页入口
- [x] v0.2 设置页开关/密码/隧道，保存即生效
- [x] v0.3 同源路由 `/dsh-hub/*`，不再跨端口
- [x] v0.4 PWA（添加到主屏幕）+ 移动端安全区样式
- [x] v0.5 设备会话与撤销、登录审计、设置页二维码

### 手机「添加到主屏幕」

打开远程地址并登录后，在浏览器菜单里选「添加到主屏幕」：
iOS Safari 是「分享 → 添加到主屏幕」，Android/华为浏览器是「菜单 → 添加到桌面」。
添加后会以独立窗口打开（无地址栏），体验接近 App。


---

## 许可

[MIT](LICENSE)。二维码库使用 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT），见 `lib/vendor/`。

---

## English

DSH Hub is a DeepSeek Harness plugin that exposes your local DSH instance to LAN or the public internet behind an access password. It reverse-proxies the DSH host (desktop Electron or `dsh web`), rewrites the Host header, mints a valid session cookie, and optionally starts a cloudflared quick or named tunnel. Everything is configured from the DSH settings page (`Ctrl + ,` → Remote Access).

Install:

```
dsh-hub-plugin
```

Use DSH's plugin page (desktop) or `dsh plugin --profile web add -w dsh-hub-plugin`. MIT licensed.

