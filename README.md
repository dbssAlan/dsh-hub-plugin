# DSH Hub 远程访问（dsh-hub-plugin）

把 DSH 安全地发布到**局域网 / 公网**：访问密码、二维码、设备导航页、cloudflared 隧道，全部在 DSH 设置页里管理，无需命令行。

## 功能

- **访问密码**：URL 不含密码，打开后必须输入；30 天 HttpOnly Cookie
- **局域网 + 公网**：同一 WiFi 直接访问；公网使用 cloudflared 隧道（免费随机域名，或命名隧道固定域名）
- **设备导航页**：二维码、分享链接、访问密码一键复制
- **多宿主冲突提示**：桌面版与 `dsh web` 同时运行时提醒（避免会话写租约互相锁）
- **安全默认**：默认关闭；密码至少 8 位；仅本机反代，公网入口必须密码
- **插件形态**：随 DSH 启停，不需要单独开终端

## 安装

### 从 GitHub 安装（推荐）

```
https://github.com/dbssAlan/dsh-hub-plugin
```

- 桌面版：**设置 → 插件 → 添加插件**，填入上面的仓库地址
- 命令行（web profile）：

```bash
dsh plugin --profile web add -w https://github.com/dbssAlan/dsh-hub-plugin
```

安装后：**设置 → 远程访问**（或 `Ctrl + ,` → 远程访问）。

### 本地目录（开发）

桌面 profile 由 Electron 管理，CLI 不能直接安装。请在桌面端：
**设置 → 插件 → 安装**，选择本地目录。

### 命令行（本地 web profile）

```bash
DSH_HOME=/path/to/home dsh plugin --profile web add -w /path/to/dsh-hub-plugin
```

然后在 profile 的 `cordis.patch.yml` 里覆盖配置（或用设置表单）：

```yaml
- id: dsh-hub-plugin
  name: dsh-hub-plugin
  config:
    enabled: true
    password: "至少8位"
    listenPort: 19388
    tunnel: off   # off | quick | named
    targetPort: 0
```

> 桌面版的 profile 由 Electron 管理，请通过桌面端的「插件」页安装，不要用 CLI 直接改。

## 配置项

首次启动时，Cordis 配置会写入 `%USERPROFILE%\.dsh\dsh-hub-plugin\config.json`；之后**以设置页/该文件为准**（JSON 覆盖 YAML）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 启用远程访问 |
| `password` | `""` | 访问密码，至少 8 位 |
| `listenPort` | `19388` | 本机代理端口 |
| `tunnel` | `quick` | `off`（仅局域网）/ `quick`（免费随机域名）/ `named`（固定域名） |
| `tunnelToken` | `""` | 命名隧道 Token |
| `publicUrl` | `""` | 命名隧道对外地址，如 `https://dsh.example.com` |
| `targetPort` | `0` | 目标宿主端口；0 = 自动（当前宿主） |

## 使用（v0.3：全在设置页，走宿主同源路由）

1. 打开 **设置 → 远程访问**
2. 勾选「启用远程访问」，填访问密码（≥8 位），选隧道模式
3. 点「保存并重启」——宿主会自动重建反代，**不用重启 DSH**
4. 点「打开设备导航页」看二维码/分享；公网地址显示在页面上

手机/平板：打开公网地址 → 输入密码 → 30 天内免登录。

> 设置页通过宿主同源路由 `/dsh-hub/status`、`/dsh-hub/config` 访问反代，
> 不再跨端口请求（避免浏览器的跨源/本地网络限制）。
> 写接口要求请求 Origin 与宿主一致；配置保存在 `config.json`（权限 0600），密码不回显。

## 日志与排错

- 日志：`%USERPROFILE%\.dsh\dsh-hub-plugin\hub.log`

- 状态：`%USERPROFILE%\.dsh\dsh-hub-plugin\status.json`（目标端口、局域网地址、公网地址、隧道类型）
- 健康检查：`http://127.0.0.1:<listenPort>/_health`
- 隧道连不上（`error 1033`）：本机代理/VPN 的 TUN 模式可能掐断隧道，关掉或给 `trycloudflare.com`、`argotunnel.com` 加直连规则
- `session/writer-held`：另一个 DSH 宿主占着会话；只保留一个宿主（桌面版或 `dsh web`）
- 子进程日志为空：地址以 `status.json` 为准（Electron 子进程 stdout 有缓冲）

## 安全

- 访问密码是唯一门槛；DSH 可执行本机命令，等于电脑控制权
- 不要分享不带密码的地址；不要外传密码
- 公网长期使用建议叠加 Cloudflare Access
- 电脑保持开机、不休眠，否则隧道断开

## 许可

MIT。二维码库使用 `qrcode-generator`（MIT），见 `lib/vendor/`。

## 路线图

- v0.2：设置页内开关/密码/隧道，保存即生效（已实现）
- v0.3：设置页改走宿主同源路由 `/dsh-hub/*`，不再跨端口（已实现）
- v0.4：PWA 与移动端样式注入
- v0.5：设备级令牌与撤销、登录审计
