# JDauto 用户指南

## 环境要求

- Node.js >= 21
- 已安装 `@jackwener/opencli` 并验证 `opencli doctor` 通过
- 已安装 RTK（可选，降低 token 消耗）
- 至少 1 个（建议多个）独立浏览器 Profile（每个对应一个京东账号，Edge/Chrome 均可）

---

## 第一步：配置浏览器 Profile

每个京东账号需要独立的浏览器 Profile：

1. 打开 Edge/Chrome → 右上角头像 → **添加配置文件**
2. 给每个 profile 命名（如 `账号1`、`账号2`、`账号3`）
3. 登录京东账号（确保已保存登录态）
4. 重复以上步骤创建多个 profile（按需要的并发账号数）

**Profile 目录位置**（通常）：
```
C:\Users\<用户名>\AppData\Local\Google\Chrome\User Data\<ProfileName>
```

---

## 第二步：验证 Browser Bridge 连接

每个 Chrome 实例需要安装并启用 OpenCLI Browser Bridge 扩展：

1. 在每个 Chrome Profile 中安装 OpenCLI 扩展
2. 打开扩展，确保证实 connected
3. 验证连接（看到多个 connected 才代表多账号可用）：

```bash
opencli profile list                    # 查看已连接 profile
opencli --profile 账号1 browser tab list   # 验证指定 profile
```

---

## 第三步：自动同步账号配置（推荐）

当你手动创建了新 Profile 并安装好 OpenCLI 插件后，可以用一条命令自动完成：

- 自动为无别名的 profile 执行 `opencli profile rename`
- 自动把新账号写入 `config/accounts.json`
- 自动分配可用 `cdpPort`

```bash
npm run sync:profiles
```

可选参数：

```bash
# 仅同步，不自动 rename
node scripts/sync-opencli-accounts.mjs --no-rename

# 自定义账号前缀与起始编号（默认: 账号 + 1）
node scripts/sync-opencli-accounts.mjs --prefix 账号 --start-index 1
```

---

## 第四步：创建/检查配置文件

复制 `config/example-config.json` 并修改：

```json
{
  "accounts": [
    {
      "name": "账号1",
      "profile": "JDProfile1",
      "chromePath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "cdpPort": 9221
    },
    {
      "name": "账号2",
      "profile": "JDProfile2",
      "chromePath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "cdpPort": 9222
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

---

## 第五步：运行抢购

自动模式现在是“混合启动”：

- 若账号对应浏览器已打开且 Browser Bridge 已连接：直接复用
- 若账号未打开或未连接：程序自动启动该账号浏览器并等待连接

**方式 A — 单命令行（单账号）：**

```bash
jdauto --sku 100218876132 \
  --time "2026-05-07T20:00:00" \
  --password 263414 \
  --config config/example-config.json \
  --accounts 1
```

**方式 B — 配置文件（多账号多任务）：**

```bash
export JDAUTO_PASSWORD=263414
jdauto --config config/example-config.json
```

---

## 工作流程

```
PREPARE 阶段（抢购时间 -45s，默认）
  └─ 快速判断是否已在提交页
  └─ 打开购物车检查 SKU（在车则跳过加购）
  └─ 不在车则执行加购
  └─ 去结算/领券结算，预热到提交订单页

EXECUTE 阶段（精确到抢购时间）
  └─ 若提交页未就绪则兜底跳转到提交页
  └─ 点击"提交订单"（失败重试 3 次）
      ↓ 成功
  PAYMENT 阶段
      └─ 单次注入自动支付观察器（页面内自动点击立即支付/输入密码/确认支付）
      └─ Node 侧仅轮询 done/failed 状态（50ms）
```

---

## 安全提示

- 支付密码**仅在运行时注入**，不落盘、不写入日志
- 建议使用环境变量 `JDAUTO_PASSWORD` 而非命令行明文传递
- 抢购完成后请**手动检查订单状态**

---

## 故障排除

**Browser Bridge 连接失败**
```bash
opencli doctor                    # 检查 opencli 环境
opencli profile list              # 查看已连接 profile
```

**日志显示“仅 1/N 个账号就绪”**
- 先执行 `opencli profile list`，确认是否真的有 N 个 connected
- 对失败账号逐个验证：`opencli --profile 账号X browser tab list`
- 若无别名或别名缺失，执行 `npm run sync:profiles` 自动补齐
- 若仍失败，打开对应 Profile 检查 OpenCLI 扩展是否 enabled + connected

**Chrome 无法启动**
- 检查 `chromePath` 是否正确
- 检查端口是否被占用（CDP 端口冲突）

**购物车为空**
- 确认账号已登录京东
- 确认商品在抢购时间前有库存

---

## 命令行参数

| 参数 | 说明 |
|------|------|
| `--sku` | 商品 SKU |
| `--time` | 抢购时间（ISO 8601） |
| `--password` | 支付密码 |
| `--config` | 配置文件路径 |
| `--max-retries` | 提交订单失败重试次数（默认 3） |
| `--prepare-ahead` | 提前多少秒开始 PREPARE（默认 45） |
| `--accounts` | 本次启用账号数量（从配置文件前 N 个账号中选取） |

---

## 配置项补充

`accounts` 中每个账号支持以下字段：

- `profile`：OpenCLI profile 名称（用于 `opencli --profile <name>`）
- `browserProfileDir`：浏览器真实 profile 目录名（用于 `--profile-directory`，可选）

当 `profile` 与浏览器目录名不同（例如 OpenCLI 别名是 `账号11`，浏览器目录是 `Profile 2`）时，建议显式配置：

```json
{
  "name": "账号11",
  "profile": "账号11",
  "browserProfileDir": "Profile 2",
  "chromePath": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "cdpPort": 9231
}
```
