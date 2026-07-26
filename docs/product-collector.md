# 京东 SKU 商品信息采集

采集器通过 OpenCLI Browser Bridge 打开京东商品页，并从网络捕获中提取
`pc_detailpage_wareBusiness` 响应。每个 SKU 输出一个 UTF-8 JSON 文件，顶层结构与
`id采集商品信息.json` 一致。响应中的主商品 SKU 必须与输入 SKU 相同；捕获窗口里的
旧商品响应不会被写入当前结果。

## 输入

文本文件可按换行、空格或逗号分隔：

```text
10023749565113
100218876132
```

也支持 JSON 数组，或包含 `skus`、`skuIds`、`items` 数组的 JSON 对象。
CSV 输入会读取 `id` 列；存在 `platform` 列时只采集值为 `jd` 的行。

## 运行

先启动配置中的浏览器 profile，确认 Browser Bridge 已连接：

```powershell
npm run build
opencli doctor
npm run collect -- --input .\skus.txt --output .\data\products --accounts 4
```

也可以显式指定 profile：

```powershell
npm run collect -- --input .\skus.json --profiles 账号1,账号2,账号3,账号4
```

采集器默认断点续跑：输出目录中已有、可解析且详情 SKU 一致的 `<SKU>.json` 会跳过。
旧版本生成的错配文件会被重新采集。失败项记录到 `errors.jsonl`。重新运行相同命令即可
继续；如需强制覆盖已有结果，增加 `--no-resume`。

## 容量与限制

- 同一 profile 内严格串行；不同 profile 可作为并行 worker。
- 捕获到其他 SKU 但没有目标 SKU 时，本次尝试会失败并进入现有重试流程。
- 出现 403、验证页或登录失效时应停止任务，先降低频率并人工检查账号状态。
- 监控进程退出码：`0` 全部成功，`2` 有 SKU 失败，`1` 为输入、配置或运行时致命错误。
- 保留 `errors.jsonl`、成功率、P95 单 SKU 耗时和 403/验证页比例。
- 2026-07-26 的 30 条实测在成功 14 条后进入京东 PC 频控页，当前浏览器链路不能承诺
  稳定日采 10,000；详见[端到端验证报告](e2e-validation-2026-07-26.md)。

京东接口及页面结构可能变化，稳定运行仍需遵守平台规则、控制访问频率，并准备在字段或
接口变更时更新提取逻辑。
