# 安装与运行指南（macOS + Chrome）

## 1. 前置条件

1. macOS 系统，Node.js 20+（已在 Node 22 环境验证）。
2. Google Chrome（需要开启开发者模式以加载本地扩展）。
3. 可访问目标网页终端（Browser Terminal）页面。

## 2. 构建项目

在仓库根目录执行：

```bash
npm install
npm run build
```

## 3. 启动本地 Bridge 守护进程

在本机 `localhost` 启动守护进程：

```bash
npm run start:bridge -- --host 127.0.0.1 --port 17373 --token your-shared-token
```

可选参数：

```bash
--default-timeout-ms 120000
--max-timeout-ms 600000
--ping-interval-ms 15000
--debug
```

健康检查接口：

```bash
curl http://127.0.0.1:17373/v1/health
```

## 4. 在 Chrome 加载扩展

1. 打开 `chrome://extensions`。
2. 打开右上角 **开发者模式**。
3. 点击 **加载已解压的扩展程序**。
4. 选择仓库中的 `extension/` 目录。

## 5. 配置扩展

1. 打开扩展的设置页面（Options）。
2. 填写：
   - **Bridge URL**: `ws://127.0.0.1:17373/extension`
   - **Auth Token**: 与守护进程启动参数中的 `--token` 保持一致。
3. 点击保存。

## 6. 绑定终端标签页

1. 在 Chrome 打开你的网页终端页面。
2. 在加载或更新扩展后，先刷新一次该终端页面。
3. 点击一次扩展图标。
4. 当前标签页会被设置为优先执行目标。

## 7. 使用 CLI

健康检查：

```bash
npm run start:cli -- --token your-shared-token health
```

执行命令：

```bash
npm run start:cli -- --token your-shared-token exec "uname -a"
```

JSON 输出模式：

```bash
npm run start:cli -- --token your-shared-token exec --json "ls -la"
```

取消运行中的请求：

```bash
npm run start:cli -- --token your-shared-token cancel <requestId>
```

## 8. 预期行为

1. CLI 实时流式输出浏览器终端执行结果。
2. CLI 进程退出码与远端命令退出码一致。
3. Bridge 会排队请求，并且同一时刻只执行一个命令。

## 9. 故障排查

### `execution failed: extension is not connected`
- 确认 Bridge 守护进程正在运行。
- 确认扩展中的 URL 和 Token 配置正确。
- 确认扩展 service worker 已激活（可打开扩展管理页触发）。

### `no terminal tab available`
- 先打开终端页面。
- 点击扩展图标绑定该标签页。
- 刷新该终端页面后再重试。

### 命令卡住或无输出
- 某些终端产品使用了不兼容的 websocket 协议或编码。
- 尝试重新绑定标签页后再执行。
- 使用 Bridge 的 `--debug` 查看日志。

### 首次执行时出现 Chrome 调试权限提示
- 扩展现在会使用 Chrome Debugger API 注入可信输入（提升兼容性）。
- 首次触发时如出现权限弹窗，请点允许。

### 输出中出现 marker 字符串
- 说明解析器未完全隔离终端流中的标记边界。
- 可先重试；若稳定复现，需要按目标终端协议调整解析逻辑。
