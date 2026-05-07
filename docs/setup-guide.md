# Chrome Profile 配置指南

## 什么是 Chrome Profile？

Chrome Profile 用于在同一浏览器实例中隔离不同用户的会话。每个 Profile 有独立的：
- Cookie（登录态）
- 浏览器缓存
- 扩展程序
- 设置

## 为 JDauto 创建 10 个 Profile

### 方式一：图形界面（推荐）

1. 打开 Chrome，点击右上角头像
2. 点击 "添加" → "创建个人资料"
3. 填写名称（如 `JD账号1`）
4. 选择头像颜色
5. 重复创建 10 个 Profile

### 方式二：命令行创建

```bash
# 创建新 Profile（启动时指定目录）
chrome.exe --profile-directory="JDProfile1"
```

## 登录京东

每个 Profile 创建后：
1. 打开京东官网
2. 登录对应账号
3. 建议开启"记住密码"并确认 cookie 有效

## 验证登录态

在每个 Profile 中访问 `https://item.jd.com/100218876132.html`，如果需要登录则手动登录一次。

## Profile 目录

Windows 默认路径：
```
C:\Users\<用户名>\AppData\Local\Google\Chrome\User Data\<ProfileName>
```

示例（JDProfile1）：
```
C:\Users\q1234\AppData\Local\Google\Chrome\User Data\JDProfile1
```

## 配置到 accounts.json

```json
{
  "name": "账号1",
  "profile": "JDProfile1",
  "chromePath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "cdpPort": 9221
}
```

## 注意事项

- 每个 profile 的调试端口（cdpPort）必须不同（9221, 9222, ... 9230）
- Browser Bridge 扩展需要在**每个 Profile** 中单独安装
- 建议先测试 1-2 个账号，确认流程跑通后再扩展到 10 个