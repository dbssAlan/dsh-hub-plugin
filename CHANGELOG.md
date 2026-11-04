# Changelog

## 0.8.0

安全与可用性收口（**建议所有 0.7.x 用户升级**）：

- **修复公网未认证管理接口**：`/_status`、`/_config?reveal=1`、`/_sessions`、`/_audit`、`/_peers` 等管理接口不再把“来源是 loopback”当身份（隧道回源恰好是 127.0.0.1）。现在只接受宿主每次启动生成的随机令牌（`x-dsh-hub-admin`），浏览器永远拿不到该令牌。
- **修复局域网访问全部 403**：管理接口的判断不再拦截 `/_login`、首页、静态资源与反代；同一 WiFi 的手机/平板可以正常打开 `http://<局域网IP>:19388/`。
- **修复远程页面可读取明文密码**：设置页同源路由 `/dsh-hub/*` 只接受本机直连，经 Hub 反代进入的请求一律 403（即使已登录 DSH 也读不到）。
- **SSRF 防护**：添加远程设备时先解析域名，拒绝内网 / 回环 / 链路本地 / 云元数据地址，并直连已解析 IP 以防 DNS rebinding。
- **Cookie 加固**：HTTPS（含 cloudflared 隧道）下自动加 `Secure`；Cookie 值持久化，保存配置/重启后不再把所有设备踢下线；登录 Cookie 比较改为恒定时间。
- **限速修正**：隧道场景下按 `CF-Connecting-IP` 识别真实来源（原先进隧道后所有人共用 127.0.0.1，一个人错 5 次锁死全部人）；失败记录定期清理。
- **凭据卫生**：密码不再写入 `hub.log`、不再出现在子进程命令行（改走环境变量）；`dsh-hub.json` / 状态文件统一 0600 并原子写；日志超 5 MB 轮转。
- **反代健壮性**：上游 30s 超时、`headersSent` 兜底、全程 try/catch；宿主换端口时自动重新探测；cloudflared 退出自动重试（最多 5 次）并更新状态。
- **iframe 白名单**：只有本机页面（如桌面端「远程设备」浮层）嵌入时才放开 `X-Frame-Options`/`frame-ancestors`，其他站点仍被挡住；CSP 的其他指令保留。
- **cloudflared 下载校验**：移除第三方镜像；按 GitHub Release 的 sha256 digest 校验，无法校验时默认拒绝（可用 `--allow-unverified-cloudflared` 显式跳过）。
- **审计**：`audit.jsonl` 超 2 MB 轮转，读取改为只读尾部 256 KB；设备会话活跃时间按会话独立刷新。
- **测试**：新增 `scripts/test.mjs`（27 项端到端断言：登录/限速/撤销/管理令牌/SSRF/反代/iframe/局域网来源/重启不掉登录），CI 三平台运行。
- 独立运行脚本修正：`dsh-hub.sh` 指向真实入口，新增 `dsh-hub.cmd`。

**升级说明**：本次改动涉及 `index.js`（宿主模块），需要重启一次 DSH 桌面端；`lib/hub-cli.mjs` 仍可热重载。管理员令牌每次启动变化，不落盘。

## 0.7.0-beta.3

- 「远程设备」浮层改为只占内容区：自动测量侧边栏右边缘与标题栏底边，侧边栏/标题栏保持可见；窄屏回退全屏

## 0.7.0-beta.2

- 修复「远程设备」浮层空白且无法退出：改用 portal 挂到 body（避免被侧边栏裁剪）、增加 Esc 关闭、错误边界与关闭兜底

## 0.7.0-beta.1

- 跨平台：cloudflared 按平台/架构下载（win/darwin/linux × amd64/arm64），macOS 解压 tgz 并 chmod
- 端口扫描：macOS/Linux 使用 lsof/ss；进程检测使用 ps；桌面缓存路径按平台
- 凭据读取失败时给出明确提示（macOS 系统钥匙串暂不支持）
- 新增 dsh-hub.sh、scripts/smoke.mjs、GitHub Actions 三平台 CI
- 待真机验证：macOS 桌面版 / dsh web、Linux

## 0.6.2

- 新增「重载插件」按钮与 `/dsh-hub/reload`：更新 hub-cli 运行时无需重启 DSH 桌面端
- README 增加热更新边界说明（index.js / client.js 仍需各重启一次）

## 0.6.1

- 修复快速隧道公网地址误取 cloudflared 日志里的 API 端点 `https://api.trycloudflare.com`；现在只取真实隧道域名

## 0.6.0

- 新增「远程设备」：设置里添加对方地址（探测 /_health），侧边栏按钮 + 全屏浮层 iframe 嵌入对端 DSH
- 代理移除 x-frame-options / frame-ancestors，允许被嵌入
- 文档补充：共享会话请用单中心模式（两台打开同一台 DSH）

## 0.5.6

- 访问密码合并为单个「显示/隐藏」按钮：字段为空且已保存时点击直接取回并显示；否则切换明文/密文

## 0.5.5

- 新增 scripts/test-host.ps1：测试宿主用普通 node.exe + PID 文件启停，禁止按进程名杀进程

## 0.5.4

- 访问密码新增「显示 / 隐藏」切换
- 新增「查看」按钮：点击或长按显示已保存密码（`_config?reveal=1`，仅本机管理接口）
- 明文密码只返回给已登录的设置页，普通配置接口不回显

## 0.5.3

- 修复复制按钮竖排：设置页地址行、设备页分享行改为横向 flex 布局
- 设备导航页新增「复制地址」按钮（地址与按钮同一行）

## 0.5.2

- 修复从隧道域名（远程页面）打开设置页时保存配置返回 `403 forbidden`
- 防 CSRF 改为校验 `x-dsh-hub` 请求头，不再限制 Origin
- 保存失败时显示服务端文本，而不是 `Unexpected token` 的 JSON 解析错误

## 0.5.1

- 修复设置页二维码破图：`img` 地址改为宿主同源路由 `/dsh-hub/qr`

## 0.5.0

- 设备会话：登录写入 `dsh-hub-sid` 会话 Cookie，按设备记录名称/IP/最近活跃
- 设置页可查看会话、逐个撤销、撤销全部（撤销后该设备立即失效）
- 登录审计：`dsh-hub-plugin/audit.jsonl`（登录成功/失败/撤销/配置变更）
- 设置页新增二维码（`/dsh-hub/qr?data=...`），手机可直接扫码
- **升级说明**：旧版本登录态没有会话 ID，升级后需要重新登录一次

## 0.4.0

- PWA：`/manifest.webmanifest`、`/sw.js`、`/icon.svg`
- 首页自动注入 manifest / theme-color / iOS 全屏 meta 与安全区样式
- 手机可「添加到主屏幕」，以独立窗口打开
- 设备导航页增加「添加到主屏幕」提示

## 0.3.0

- 设置页改走宿主同源路由 `/dsh-hub/status`、`/dsh-hub/config`，不再跨端口请求
- 保存配置后自动重启反代子进程，页面轮询等待恢复
- 修复：跨端口请求被浏览器拦截导致设置页显示「连不上本地管理接口」

## 0.2.0

- 设置页内直接修改开关、密码、隧道模式、端口
- 配置持久化到 `config.json`，首次启动由 Cordis 配置生成
- 未启用时仍提供管理接口，可在设置页重新开启
- 写接口要求同源 `Origin`

## 0.1.0

- 插件骨架：host 半 + 设置页入口
- 复用已验证的反代、密码页、设备导航页、cloudflared 隧道逻辑
- 支持快速隧道与命名隧道








