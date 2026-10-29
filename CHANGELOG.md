# Changelog

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






