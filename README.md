# JDauto
京东抢购自动下单助手

## 桌面端控制台（简易前端）

1. 安装依赖并构建
```bash
npm install
npm run build
```

2. 启动桌面端
```bash
npm run desktop
```
桌面窗口中可直接填写 SKU、抢购时间、支付密码等参数，并启动/停止任务和查看实时日志。

## 打包为 Windows EXE

```bash
npm install
npm run pack:win
```

打包产物统一输出到 `dist-electron/时间戳/` 目录（例如 `dist-electron/20260507-170500/`），用于按版本区分每次打包。

`npm run pack:win:fresh` 与 `npm run pack:win` 等价，也会输出到 `dist-electron/时间戳/`。

```bash
npm run pack:win:fresh
```

## 内置运行时说明（EXE）

- 打包版 EXE 已内置运行时与 OpenCLI CLI，不需要额外安装系统 `Node.js` 与全局 `opencli`。
- 仍需本机安装 Edge/Chrome（用于 Browser Bridge 扩展与实际下单流程）。
- 如果终端环境也要手动运行 `opencli` 命令，再单独安装全局 `@jackwener/opencli` 即可。
