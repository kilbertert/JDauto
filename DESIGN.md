# JDauto 设计文档

## 设计概述

JDauto 是一个基于 TypeScript、Electron 和 OpenCLI Browser Bridge 的京东自动化项目。
当前包含两条相互独立、共享基础设施的业务链路：

1. 自动下单：面向定时抢购，执行预热、提交订单和支付。
2. SKU 商品信息采集：输入京东 SKU，捕获商品页聚合接口并输出原始 JSON。

两条链路共享账号配置、浏览器 profile 和 `opencli-wrap.ts`，但使用独立 CLI 入口，避免采集逻辑
进入支付状态机。

### 目标

- 复用用户已登录的浏览器状态执行京东自动化。
- 保持下单状态机与商品采集任务职责分离。
- 商品采集结果与 `id采集商品信息.json` 的顶层结构一致。
- 提供批量输入、失败重试、断点续跑和可审计错误记录。

### 非目标

- 不绕过京东登录、安全验证或访问频控。
- 不保证浏览器采集链路可以稳定达到 10,000 SKU/日。
- 不把京东内部响应字段当作稳定的公开 API 契约。
- 不在配置文件中持久化支付密码。

## 整体架构

```mermaid
flowchart TD
    Config["config/accounts.json"] --> OrderCLI["下单 CLI<br/>src/index.ts"]
    Config --> CollectCLI["采集 CLI<br/>src/collect.ts"]
    Desktop["Electron 桌面端<br/>src/desktop/main.ts"] --> OrderCLI

    OrderCLI --> Manager["InstanceManager"]
    OrderCLI --> Clock["JD Clock"]
    OrderCLI --> Scheduler["FlashSaleScheduler"]
    Scheduler --> Order["FlashSaleInstance"]

    CollectCLI --> Collector["product-collector.ts"]
    Collector --> Wrapper["opencli-wrap.ts"]
    Order --> Wrapper
    Manager --> Wrapper

    Wrapper --> Bridge["OpenCLI daemon + Browser Bridge"]
    Bridge --> JD["京东页面与网络请求"]
    Collector --> Files["data/products/&lt;SKU&gt;.json<br/>errors.jsonl"]
```

## 自动下单链路

入口为 `src/index.ts`：

1. 读取账号和任务配置，或使用命令行 SKU/时间覆盖任务。
2. `InstanceManager` 启动或复用配置中的浏览器 profile，并验证 Browser Bridge。
3. `syncJdClock` 估算京东服务器时间偏移。
4. `FlashSaleScheduler` 注册 `PREPARE` 和 `EXECUTE` 定时器。
5. 每个账号和任务对应一个 `FlashSaleInstance`，按状态机执行：
   `IDLE → PREPARE → EXECUTING → PAYMENT → DONE/FAILED`。
6. 页面打开、DOM 操作、加购和支付操作统一经过 `opencli-wrap.ts`。

## SKU 商品信息采集链路

入口为 `src/collect.ts`：

1. 从文件或标准输入读取 SKU。
2. `parseSkuInput` 支持纯文本、JSON 和 CSV；CSV 存在 `platform` 列时只保留 `jd`。
3. 按 profile 创建 worker。同一 profile 内串行，不同 profile 可并行。
4. 对每个 SKU 打开 `https://item.jd.com/<SKU>.html`。
5. OpenCLI 在导航前开始网络捕获；采集器选择
   `pc_detailpage_wareBusiness` 的最新有效响应。
6. 响应经过最小解包后构造以下顶层结构：

```json
{
  "商品ID": "10023749565113",
  "商品名称": "商品标题",
  "商品平台": "京东",
  "商品链接": "https://item.jd.com/10023749565113.html",
  "采集时间": "2026/7/26 13:21:28",
  "详情数据": {}
}
```

7. 结果先写临时文件再原子重命名为 `<SKU>.json`。
8. 已存在且合法的结果默认跳过；失败记录追加到 `errors.jsonl`。

## 核心组件

| 组件 | 职责 |
| --- | --- |
| `src/index.ts` | 自动下单 CLI 参数解析和流程编排 |
| `src/collect.ts` | 商品采集 CLI 参数解析和进度输出 |
| `src/product-collector.ts` | SKU 输入、响应提取、记录构造、worker、重试和落盘 |
| `src/commands/opencli-wrap.ts` | OpenCLI 子进程、页面操作、网络捕获和支付封装 |
| `src/instance-manager.ts` | 浏览器实例启动、复用和 Bridge 就绪检查 |
| `src/instance.ts` | 单账号下单状态执行 |
| `src/scheduler.ts` | PREPARE/EXECUTE 定时调度 |
| `src/state-machine.ts` | 下单状态与合法状态转换 |
| `src/jd-clock.ts` | 京东服务器时间偏移估算 |
| `src/desktop/main.ts` | Electron 窗口、下单进程与日志管理 |

## 关键设计决策

| 日期 | 决策 | 理由 |
| --- | --- | --- |
| 2026-07-26 | 采集使用独立 `jdcollect` 入口 | 防止批处理逻辑污染下单和支付状态机 |
| 2026-07-26 | 捕获聚合接口而非拼装 DOM | 保留详情字段并与目标 JSON 接近 |
| 2026-07-26 | 单 profile 串行、多 profile worker | 避免同一浏览器上下文命令竞争 |
| 2026-07-26 | 每 SKU 一个 JSON 文件 | 支持原子写入、断点续跑和局部重试 |
| 2026-07-26 | 固定 OpenCLI 1.7.14 | 当前封装依赖该版本的 browser 命令格式 |

## 已知限制

- 2026-07-26 的 30 SKU 端到端验证中仅成功 14 条，随后进入京东 `reason=403`
  PC 频控页；详见 `docs/e2e-validation-2026-07-26.md`。
- 多 profile 可以提升本地并行度，但共享公网出口时不能视为频控解决方案。
- `pc_detailpage_wareBusiness` 是页面内部接口，名称和响应字段可能变化。
- Browser Bridge、profile 登录态和京东页面状态均是运行前置条件。
- 当前桌面端只编排自动下单；商品采集通过 CLI 使用。

## 安全与运维

- 支付密码只从命令行或 `JDAUTO_PASSWORD` 注入，不写入配置。
- SKU 输入必须是 5–20 位数字或标准京东商品链接。
- 采集失败不会生成半写入 JSON；中间文件仅用于原子落盘。
- 采集输出位于 `data/`，不进入版本控制。
- 遇到 403、验证页或登录失效时应停止任务并检查平台规则，不应简单扩容规避限制。

## 验证

```powershell
npm run build
npm test
```

测试覆盖原状态机冒烟检查，以及 SKU 文本/JSON/CSV 解析、网络响应提取、输出结构和样例数据回归。
