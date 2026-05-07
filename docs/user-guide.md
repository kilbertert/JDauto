# JDauto 用户指南

## 环境要求

- Node.js >= 21
- 已安装 `@jackwener/opencli` 并验证 `opencli doctor` 通过
- 已安装 RTK（可选，降低 token 消耗）
- 10 个独立的 Chrome Profile（每个对应一个京东账号）

---

## 第一步：配置 Chrome Profile

每个京东账号需要独立的 Chrome Profile：

1. 打开 Chrome → 设置 → **用户** → 添加人员
2. 给每个 profile 命名（如 `JDProfile1`、`JDProfile2`）
3. 登录京东账号（确保已保存登录态）
4. 重复以上步骤创建 10 个 profile

**Profile 目录位置**（通常）：
```
C:\Users\<用户名>\AppData\Local\Google\Chrome\User Data\<ProfileName>
```

---

## 第二步：验证 Browser Bridge 连接

每个 Chrome 实例需要安装并启用 OpenCLI Browser Bridge 扩展：

1. 在每个 Chrome Profile 中安装 OpenCLI 扩展
2. 打开扩展，确保证实 connected
3. 验证连接：

```bash
opencli profile list                    # 查看已连接 profile
opencli --profile JDProfile1 browser tab list   # 验证指定 profile
```

---

## 第三步：创建配置文件

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

## 第四步：运行抢购

**方式 A — 单命令行（单账号）：**

```bash
jdauto --sku 100218876132 \
  --time "2026-05-07T20:00:00" \
  --password 263414 \
  --config config/example-config.json
```

**方式 B — 配置文件（多账号多任务）：**

```bash
export JDAUTO_PASSWORD=263414
jdauto --config config/example-config.json
```

---

## 工作流程

```
PREPARE 阶段（抢购时间 -10s）
  └─ 打开商品页 → 加入购物车

EXECUTE 阶段（精确到抢购时间）
  └─ 打开购物车 → 点击"去结算" → 点击"提交订单"（失败重试 3 次）
      ↓ 成功
  PAYMENT 阶段
      └─ 点击"立即支付" → 注入支付密码 → 点击"立即支付"确认
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
| `--prepare-ahead` | 提前多少秒开始 PREPARE（默认 10） |