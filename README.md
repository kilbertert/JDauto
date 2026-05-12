# JDauto

JDauto 是一个基于 `OpenCLI Browser Bridge` 的京东自动抢购工具，支持多账号并行、预热到提交页、卡点提交订单、自动支付，以及桌面端日志查看与 Windows 打包。

> 本项目仅供学习、交流与自动化技术研究使用，不用于任何商业用途或违规用途。
> 请在遵守平台规则、法律法规和账号安全要求的前提下使用，并自行承担使用风险。

## 功能特性

- 多账号并行执行，按配置批量抢购
- `PREPARE -> EXECUTE -> PAYMENT` 全链路状态机
- 预热到提交订单页，尽量把慢步骤前移
- 自动注入支付流程，减少提交后的额外命令往返
- 京东服务器时间偏移校正，提升卡点精度
- 桌面端控制台，支持启动、停止和查看实时日志
- 支持打包为 Windows EXE

## 工作原理

```text
PREPARE
  -> 打开购物车检查 SKU
  -> 不在车则自动加购
  -> 点击 去结算 / 领券结算 / 领劵结算
  -> 预热到提交订单页

EXECUTE
  -> 精确卡点点击“提交订单”

PAYMENT
  -> 自动接管支付页
  -> 点击“立即支付”
  -> 注入支付密码
  -> 点击最终确认按钮
```

## 性能表现

- 在自动到 `PREPARE` 已完成、页面已预热到提交订单页的前提下，`EXECUTE -> PAYMENT -> DONE` 已做了专项优化
- 实测中，`提交订单成功 -> 支付完成` 通常可进入 `2~3 秒` 区间
- 部分账号在较理想网络与页面状态下，自动付款段可达到约 `2 秒级`
- 影响最终耗时的主要因素不是脚本点击本身，而是京东支付页跳转、页面渲染、账号风控状态和多账号并发带来的差异
- 因此 README 中的性能描述代表当前版本实测表现，不承诺所有账号、所有时间段都稳定一致

## 环境要求

- Node.js `>= 21`
- Windows 环境优先
- 已安装 `@jackwener/opencli`
- 浏览器已安装并启用 OpenCLI Browser Bridge 扩展
- 至少 1 个已登录京东账号的独立浏览器 Profile

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 构建

```bash
npm run build
```

### 3. 准备账号与配置

- 手动创建并登录多个浏览器 Profile
- 确保 OpenCLI Browser Bridge 显示 `connected`
- 同步账号配置：

```bash
npm run sync:profiles
```

### 4. 运行 CLI

如果你在本地开发环境中直接运行，推荐使用：

```bash
node .\dist\index.js --sku 100218876132 --time "2026-05-07T20:00:00" --password 263414 --config .\config\accounts.json --accounts 1
```

如果已经通过 `npm link` 安装了命令，也可以使用：

```bash
jdauto --sku 100218876132 --time "2026-05-07T20:00:00" --password 263414 --config .\config\accounts.json --accounts 1
```

### 5. 启动桌面端

```bash
npm run desktop
```

桌面窗口可直接填写 SKU、抢购时间、支付密码、账号数等参数，并查看实时日志。

### 桌面端操作示意

![JDauto 桌面端注释说明图](https://github-ranlei.oss-cn-shenzhen.aliyuncs.com/JDAuto/20260512_232233_%E5%9F%BA%E4%BA%8E%E5%8F%82%E8%80%83%E5%9B%BE%E7%89%87%E4%B8%AD%E7%9A%84_JDauto.png)

上图展示了桌面端主要输入项、初始化按钮与任务控制按钮，适合作为首次使用时的快速参考。

## 常用命令

```bash
npm run build
npm run test
npm run desktop
npm run sync:profiles
npm run cleanup:opencli-profiles
npm run pack:win
```

## 配置示例

`config/accounts.json` / `config/example-config.json` 结构如下：

```json
{
  "accounts": [
    {
      "name": "账号1",
      "profile": "账号1",
      "browserProfileDir": "Profile 1",
      "chromePath": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "cdpPort": 9221
    }
  ],
  "tasks": [
    {
      "sku": "100218876132",
      "flashSaleTime": "2026-05-07T20:00:00",
      "maxRetries": 3
    }
  ]
}
```

## 目录结构

```text
src/
  index.ts              CLI 入口
  scheduler.ts          PREPARE / EXECUTE 调度器
  instance.ts           单账号抢购执行器
  jd-clock.ts           京东服务器时间同步
  commands/
    opencli-wrap.ts     OpenCLI 命令封装
  desktop/
    main.ts             Electron 主进程
    preload.ts          Electron 预加载

config/
  accounts.json         本地账号配置
  example-config.json   示例配置

docs/
  user-guide.md         用户使用说明
  setup-guide.md        环境与安装说明
```

## 桌面端与打包

### 启动桌面端

```bash
npm run desktop
```

### 打包 Windows EXE

```bash
npm run pack:win
```

打包产物默认输出到 `dist-electron/时间戳/` 目录。  
`npm run pack:win:fresh` 与 `npm run pack:win` 等价。

### 打包版说明

- 打包版 EXE 已内置运行时与 OpenCLI CLI
- 仍需本机存在可用浏览器与 Browser Bridge 扩展
- 如果你想在系统终端里单独手动运行 `opencli`，仍建议额外全局安装 `@jackwener/opencli`

## 文档

- [用户指南](docs/user-guide.md)
- [项目文档 README](docs/README.md)
- [环境安装说明](docs/setup-guide.md)

## 注意事项

- 支付密码仅在运行时注入，不写入配置文件
- 建议优先使用环境变量 `JDAUTO_PASSWORD`
- 多账号并发时，不同账号的支付页跳转与渲染速度可能不同
- 抢购完成后请手动复核订单状态与支付结果
