#!/bin/bash
# setup-profile.sh — 为 Chrome Profile 安装 Browser Bridge 扩展并连接到 daemon
# 使用方式: bash setup-profile.sh 账号1

PROFILE_NAME="$1"
if [ -z "$PROFILE_NAME" ]; then
  echo "用法: bash setup-profile.sh <profile名称>"
  echo "示例: bash setup-profile.sh 账号1"
  exit 1
fi

echo "=== 为 $PROFILE_NAME 配置 Browser Bridge ==="
echo ""
echo "请按顺序执行以下步骤："
echo ""
echo "1. 关闭当前所有 Chrome 窗口"
echo ""
echo "2. 用指定的 Profile 启动 Chrome："
echo "   Windows: 打开运行对话框 (Win+R)，输入："
echo "   chrome.exe --profile-directory=\"$PROFILE_NAME\""
echo ""
echo "3. 在这个 Chrome Profile 中安装 OpenCLI 扩展："
echo "   - 访问 Chrome Web Store 安装"
echo "   - 或打开 chrome://extensions，启用开发者模式"
echo "   - 点击'加载已解压的扩展程序'，选择 OpenCLI 扩展目录"
echo ""
echo "4. 扩展安装后，点击扩展图标，确保显示 'connected'"
echo ""
echo "5. 回到这里运行以下命令验证连接："
echo ""
echo "   opencli profile list"
echo "   opencli --profile $PROFILE_NAME browser tab list"
echo ""
echo "6. 如果 profile list 中出现了新的 contextId，运行："
echo "   opencli profile rename <新contextId> $PROFILE_NAME"
echo ""
echo "完成后告诉我，我帮你验证连接是否成功。"