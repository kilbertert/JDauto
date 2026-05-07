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

- **Runtime**: Node.js >= 21
- **CLI Framework**: [OpenCLI](https://github.com/jackwener/opencli)
- **Browser Automation**: `opencli browser` 原语（Chrome CDP）
- **语言**: TypeScript / JavaScript
- **运行环境**: Windows（Chrome/Chromium 浏览器 + Browser Bridge 扩展）

---

## 目录结构

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

## 核心设计

### 多实例架构
- 每个京东账号 = 1 个独立的 Chrome 浏览器实例（通过 `opencli browser` CDP 控制）
- 实例之间完全隔离，互不干扰
- 主控进程通过配置文件管理所有实例的 SKU、抢购时间、支付密码

### 抢购流程状态机
```
IDLE → PREPARE（提前打开商品页）→ ADD_CART → CHECKOUT → SUBMIT → PAYMENT → DONE
                                              ↓
                                           FAILED → RETRY
```

### 关键时间控制
- 抢购时间精确到秒，到点触发
- 提前刷新页面 + 反复尝试提交
- 支付密码在订单提交成功后立即注入

---

## 代码规范

- **TypeScript**: 优先 `.ts`，类型标注完整
- **函数命名**: 动词前缀（`snap`, `addCart`, `submitOrder`, `pay`, `injectPassword`）
- **常量**: `UPPER_SNAKE_CASE`，无魔法数
- **错误处理**: 每步必须捕获异常，超时重试机制

---

## 测试与提交流流程

1. 每次改动后跑 `npm test`
2. 全量测试通过后再提 PR
3. PR 必须包含：改动说明、测试结果、影响范围

### Commit 规范
- `feat:` 新功能
- `fix:` 修 bug
- `docs:` 文档
- `refactor:` 重构
- `chore:` 杂项

---

## 常用命令

```bash
# 环境验证
opencli doctor

# 调试用（透传原始命令）
rtk proxy <cmd>

# 开发者
npm install
npm test
npm run lint
```

---

## Three Man Team
Available agents: Arch (Architect), Bob (Builder), Richard (Reviewer)