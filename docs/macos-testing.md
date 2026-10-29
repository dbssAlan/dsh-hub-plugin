# macOS 测试清单（v0.7.0-beta.1）

目标：验证 DSH Hub 在 macOS 桌面版 / `dsh web` 上可用，重点确认凭据、cloudflared、端口探测。

## 0. 前置检查

```bash
sw_vers
node -v
ls -l ~/.dsh/.credentials.yaml
ls /Applications | grep -i "deepseek"
```

期望：

- `node -v` ≥ 22
- `~/.dsh/.credentials.yaml` **存在**（如果不存在，说明可能用了系统钥匙串，请停止并反馈）
- 记录 DSH 版本（桌面版：设置 → 关于；CLI：`dsh --version`）

## 1. 安装插件

桌面版：

```
设置 → 插件 → 添加插件 → https://github.com/dbssAlan/dsh-hub-plugin
```

CLI（web profile）：

```bash
dsh plugin --profile web add -w https://github.com/dbssAlan/dsh-hub-plugin
```

期望：设置里出现 **「远程访问」** 页。

## 2. 启用

设置 → 远程访问：

- 勾选「启用远程访问」
- 设置访问密码（≥ 8 位）
- 隧道模式选 `quick`
- 点「保存并重启」

## 3. 本机验证

```bash
curl -s http://127.0.0.1:19388/_health
```

期望：

```json
{ "ok": true, "target": "127.0.0.1:<DSH端口>", "tunnel": true,
  "publicUrl": "https://<随机>.trycloudflare.com" }
```

- `publicUrl` 必须是随机域名，**不能是** `https://api.trycloudflare.com`
- 打开 `http://127.0.0.1:19388/_devices`，输入密码，能看到二维码

检查 cloudflared：

```bash
ls -l ~/.dsh/bin/cloudflared
~/.dsh/bin/cloudflared --version
```

期望：文件存在、可执行；版本命令有输出。

## 4. 远程与热更新验证

1. 手机 4G 打开 `publicUrl` → 输入密码 → 能进入 DSH
2. 触发热更新（按 PID，不要按进程名）：

```bash
lsof -nP -iTCP:19388 -sTCP:LISTEN
# 用上一行输出的 PID
kill <pid>
```

3. 等 3–5 秒，再次 `curl -s http://127.0.0.1:19388/_health`
4. 期望：自动恢复；快速隧道地址会变化；手机用新地址重新登录

## 5. 回传信息

```bash
cat ~/.dsh/dsh-hub-plugin/status.json
tail -100 ~/.dsh/dsh-hub-plugin/hub.log
ls -l ~/.dsh/.credentials.yaml
```

一并说明：

- macOS 版本（`sw_vers`）
- DSH 版本与宿主形态（桌面版 / `dsh web`）
- 第 3 步的 `_health` 输出
- 任何报错原文

## 常见问题

| 现象 | 处理 |
|---|---|
| cloudflared 被 Gatekeeper 拦截 | 系统设置 → 隐私与安全性 → 仍要打开；或 `xattr -d com.apple.quarantine ~/.dsh/bin/cloudflared` |
| 公司代理/VPN 导致隧道失败 | 关闭 TUN/代理，或给 `trycloudflare.com`、`argotunnel.com` 加直连规则 |
| 凭据文件不存在 | 可能使用 Keychain，当前版本不支持，请反馈 |
| 设置页 403 | 升级到 ≥ 0.5.2（同源路由 + `x-dsh-hub` 头） |
