#!/bin/bash
# Claude Memory Pro - 安装脚本
# 用法: bash scripts/install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Claude Memory Pro 安装 ==="
echo ""

# 1. 安装依赖
echo "📦 安装依赖..."
cd "$PROJECT_DIR"
npm install

# 2. 编译
echo "🔨 编译 TypeScript..."
npm run build

# 3. 创建数据目录
DB_PATH="${HOME}/.claude/memory-pro/lancedb"
mkdir -p "$DB_PATH"
echo "📁 数据目录: $DB_PATH"

# 4. 提示配置
echo ""
echo "=== 安装完成 ==="
echo ""
echo "接下来请配置 Embedding API Key："
echo ""
echo "方式一：通过 .mcp.json 配置（推荐）"
echo "将以下内容添加到项目的 .mcp.json 或全局 ~/.claude/.mcp.json："
echo ""
cat << 'EOF'
{
  "mcpServers": {
    "claude-memory-pro": {
      "command": "node",
      "args": ["${PROJECT_DIR}/dist/mcp-server.js"],
      "env": {
        "EMBEDDING_API_KEY": "你的API_KEY",
        "EMBEDDING_BASE_URL": "https://api.siliconflow.cn/v1",
        "EMBEDDING_MODEL": "BAAI/bge-m3"
      }
    }
  }
}
EOF
echo ""
echo "方式二：作为 Claude Code Plugin 安装"
echo "在 settings.json 中启用插件后自动配置。"
echo ""
