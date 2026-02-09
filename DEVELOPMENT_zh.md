# 开发命令说明

本文件用于仓库开发流程，不是最终用户安装指南。

## 前置条件

- Node.js 20+
- npm 10+

## 安装依赖

```bash
npm install
```

## 构建 / 测试 / 类型检查

```bash
npm run build
npm run test
npm run lint
```

## 在仓库中运行

通过 workspace 构建产物启动守护进程：

```bash
npm run start:browterm-daemon -- --host 127.0.0.1 --port 17373
```

通过 workspace 构建产物运行 CLI：

```bash
npm run start:browterm -- health
npm run start:browterm -- exec "uname -a"
npm run start:browterm -- exec --json "ls -la"
npm run start:browterm -- cancel <requestId>
```

## 开发态 watch

```bash
npm run dev:bridge
npm run dev:cli
```

## 发包前打包预检

```bash
npm pack --dry-run --workspace @browser-terminal-use/core
npm pack --dry-run --workspace @browser-terminal-use/bridge
npm pack --dry-run --workspace @browser-terminal-use/cli
```
