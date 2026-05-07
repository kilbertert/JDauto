# JDauto — 京东抢购工具

## Project

基于 OpenCLI (`@jackwener/opencli`) + `opencli browser` 原语实现的京东全自动抢购工具。

**核心流程**（全链路）：
```
商品页 → 加购 → 结算 → 提交订单 → 支付页 → 立即支付（输入支付密码）
```

**多账号支持**：可同时运行 10 个浏览器实例，每个实例对应一个京东账号，支持并行抢购同一商品。

**目标用户**：有抢购需求的个人用户（秒杀、限量发售等场景）

---

## Stack

- Runtime: Node.js >= 21
- Language: TypeScript
- Browser Automation: OpenCLI `browser` / `jd` 子命令
- Runtime OS: Windows（Chrome + Browser Bridge）

---

## 目录结构（当前）

```
JDauto/
├── CLAUDE.md          ← 你正在读的文件
├── ARCHITECT.md        ← Arch 的工作手册
├── BUILDER.md          ← Bob 的工作手册
├── REVIEWER.md         ← Richard 的工作手册
├── handoff/           ← 跨 agent 交接文件（JSON）
├── docs/              ← 项目文档
│   ├── README.md      ← 索引
│   ├── memory/        ← 每日工作存档
│   └── postmortem/    ← 踩坑复盘
├── src/               ← 源代码
│   ├── core/          ← 核心逻辑（多实例管理、流程编排）
│   ├── commands/      ← OpenCLI 命令封装
│   └── utils/         ← 工具函数
└── config/            ← 配置文件
```

---

## 当前流程设计

### 状态机

```
IDLE -> PREPARE -> EXECUTING -> PAYMENT -> DONE
                      \-----------------> FAILED
```

### PREPARE（预热优先）

1. 快速判断是否已在“提交订单”页（就绪则直接返回）。
2. 打开购物车并检查 SKU 是否在车内（`isSkuInCart`）。
3. 若不在车，则执行 `jd add-cart`（可选打开商品页由 `JDAUTO_PREPARE_OPEN_ITEM=1` 控制）。
4. 执行一次“去结算/领券结算”预热并等待提交按钮就绪。
5. 预热失败不立刻中断，`EXECUTE` 阶段有兜底跳转。

### EXECUTE（到点核心动作）

1. 若提交页未就绪，执行兜底：购物车 -> 去结算 -> 等提交按钮。
2. 点击“提交订单”（带 `maxRetries` 重试，默认 3）。
3. 成功后进入 `PAYMENT` 状态。

### PAYMENT（单次注入自动支付）

1. 启动一次页面内自动支付观察器（`startAutoPayFlow`）。
2. 观察器在页面内自动执行：
   - 监听并点击“立即支付”入口
   - 等 `#shortPwdInput` 出现后注入密码并触发事件
   - 点击最终确认“立即支付”
3. Node 侧仅做高频轮询（50ms）状态：
   - `done` -> `DONE`
   - `failed`/超时 -> `FAILED`

---

## 性能策略

- 默认 `prepareAhead` 为 45 秒（`index.ts`），让加购/结算预热尽量在抢购前完成。
- 到点执行段尽量只保留“提交 + 支付”，减少 opencli 往返次数。
- `opencli-wrap.ts` 在 Windows 下通过 PowerShell 安全传参，并对 `browser eval` 使用安全脚本封装（Base64 + UTF-8 decode）。

---

## 关键配置

- `--prepare-ahead`: 提前多少秒进入 PREPARE（默认 45）
- `--max-retries`: 提交订单重试次数（默认 3）
- `--manual`: 手动模式（不启动浏览器，使用已连接 profile）
- `JDAUTO_PREPARE_OPEN_ITEM=1`: PREPARE 时强制打开商品页（默认关闭以提速）

---

## 开发命令

```bash
npm install
npm run build
npm test
```
