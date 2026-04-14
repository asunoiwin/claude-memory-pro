# Claude Memory Pro

**Claude Code 语义记忆增强插件** — 基于 LanceDB 向量数据库的混合检索长期记忆系统。

> 从 [OpenClaw Memory Enhanced](https://github.com/asunoiwin/openclaw-memory-enhanced) 移植适配，专为 Claude Code 生态打造。

## 为什么需要这个插件？

Claude Code 原生记忆系统是纯文本文件（`MEMORY.md` + 按需读取 `.md` 文件），存在以下局限：

| 维度 | Claude Code 原生记忆 | Claude Memory Pro |
|------|---------------------|-------------------|
| **存储** | 纯 Markdown 文件 | LanceDB 向量数据库 |
| **检索** | 启动时加载前200行索引 | **混合检索**：向量(70%) + BM25(30%) + RRF 融合 |
| **语义理解** | 无（纯文本匹配） | BAAI/bge-m3 嵌入，1024维向量，余弦相似度 |
| **时间感知** | 无 | 60天半衰期时间衰减 + 14天新鲜度加成 |
| **去重** | 无 | MMR 多样性过滤（阈值0.85） |
| **噪音过滤** | 无 | 自动过滤问候、模板语句、元问题 |
| **重要性加权** | 无 | 0-1 重要性评分加权排序 |
| **长度归一化** | 无 | 防止长文本因关键词密度垄断结果 |

## 核心特性

- **混合检索引擎**：向量语义搜索 + BM25 全文搜索，RRF 融合排序
- **多维后处理**：时间衰减 → 新鲜度加成 → 重要性加权 → 长度归一化 → MMR 去重
- **智能去噪**：自动过滤问候语、否认回复、元问题、模板语句
- **自动去重**：存储时通过向量相似度（>98%）检测重复
- **嵌入缓存**：LRU 缓存 + 30分钟 TTL，减少 API 调用
- **多域隔离**：支持 scope 机制，按项目/领域隔离记忆
- **召回计数**：自动追踪每条记忆的召回频率

## 快速开始

### 方式一：MCP Server 直接使用（推荐）

```bash
# 1. 克隆并编译
git clone https://github.com/asunoiwin/claude-memory-pro.git
cd claude-memory-pro
npm install && npm run build

# 2. 配置 MCP（全局）
# 编辑 ~/.claude/.mcp.json
```

在 `~/.claude/.mcp.json` 中添加：

```json
{
  "mcpServers": {
    "claude-memory-pro": {
      "command": "node",
      "args": ["/你的路径/claude-memory-pro/dist/mcp-server.js"],
      "env": {
        "EMBEDDING_API_KEY": "你的嵌入模型API_KEY",
        "EMBEDDING_BASE_URL": "https://api.siliconflow.cn/v1",
        "EMBEDDING_MODEL": "BAAI/bge-m3"
      }
    }
  }
}
```

### 方式二：Claude Code Plugin 安装

```bash
# 通过 settings.json 配置 marketplace
```

在 `~/.claude/settings.json` 中添加：

```json
{
  "extraKnownMarketplaces": {
    "claude-memory-pro": {
      "source": {
        "source": "github",
        "repo": "asunoiwin/claude-memory-pro"
      }
    }
  },
  "enabledPlugins": {
    "claude-memory-pro@claude-memory-pro": true
  }
}
```

## 嵌入模型配置

支持任何 OpenAI 兼容的嵌入 API。推荐选项：

| 提供商 | 模型 | 维度 | 说明 |
|--------|------|------|------|
| **SiliconFlow**（推荐） | `BAAI/bge-m3` | 1024 | 中英双语，免费额度大 |
| OpenAI | `text-embedding-3-small` | 1536 | 英文最佳 |
| Jina | `jina-embeddings-v5-text-small` | 1024 | 多语言 |

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `EMBEDDING_API_KEY` | 是 | - | 嵌入模型 API Key |
| `EMBEDDING_BASE_URL` | 否 | `https://api.siliconflow.cn/v1` | API 地址 |
| `EMBEDDING_MODEL` | 否 | `BAAI/bge-m3` | 模型名称 |
| `EMBEDDING_DIMENSIONS` | 否 | 自动 | 向量维度（通常自动推断） |
| `MEMORY_DB_PATH` | 否 | `~/.claude/memory-pro/lancedb` | 数据库路径 |

## 工具列表

### `memory_recall` — 语义检索

搜索长期记忆，使用混合检索（向量 + BM25）：

```
使用 memory_recall 工具搜索 "Lago 计费平台的配置方式"
```

参数：
- `query`（必填）：搜索文本
- `limit`：最大返回数（默认5，最多20）
- `scope`：限定记忆域
- `category`：限定分类（preference/fact/decision/entity/other）

### `memory_store` — 存储记忆

保存重要信息，自动去重和噪音过滤：

```
使用 memory_store 工具保存 "Rico 偏好使用 Spring Boot + Lago 架构"，分类为 preference
```

参数：
- `text`（必填）：要记住的内容
- `importance`：重要性 0-1（默认0.7）
- `category`：分类（默认 other）
- `scope`：记忆域（默认 global）

### `memory_forget` — 删除记忆

按 ID 或搜索删除：

```
使用 memory_forget 工具删除关于旧配置的记忆
```

### `memory_update` — 更新记忆

原地更新内容、重要性或分类：

```
使用 memory_update 工具更新记忆 abc123 的重要性为 1.0
```

### `memory_list` — 列出记忆

浏览记忆列表：

```
使用 memory_list 工具列出最近20条 fact 类记忆
```

### `memory_stats` — 系统统计

查看存储统计、检索配置和缓存状态。

## 检索算法详解

### 混合检索流水线

```
查询输入
  ↓
┌─────────────────────────────────────┐
│ 并行执行                              │
│  ├── 向量搜索（嵌入 → LanceDB ANN）    │
│  └── BM25 全文搜索（分词 → 倒排索引）   │
└─────────────────────────────────────┘
  ↓
RRF 融合排序（向量70% + BM25 15%加成）
  ↓
余弦相似度重排
  ↓
┌─────────────────────────────────────┐
│ 后处理流水线                          │
│  ├── 新鲜度加成（14天半衰期）           │
│  ├── 重要性加权（0.7基准 + 0.3×分值）   │
│  ├── 时间衰减（60天半衰期，底线0.5x）    │
│  ├── 长度归一化（500字符锚点）          │
│  ├── 硬分数门槛（0.35）               │
│  ├── 噪音过滤                        │
│  └── MMR 多样性去重（0.85阈值）        │
└─────────────────────────────────────┘
  ↓
Top-K 返回
```

### 评分公式

**新鲜度加成**：`boost = exp(-ageDays / 14) × 0.10`

**时间衰减**：`factor = 0.5 + 0.5 × exp(-ageDays / 60)`
- 0天：1.0x（无衰减）
- 60天：~0.68x
- 120天：~0.59x
- 底线 0.5x

**重要性加权**：`factor = 0.7 + 0.3 × importance`

**长度归一化**：`factor = 1 / (1 + 0.5 × log₂(max(charLen/500, 1)))`

## 数据存储

所有数据存储在本地 LanceDB 数据库中：

```
~/.claude/memory-pro/
└── lancedb/
    └── memories.lance/    # 向量数据表
```

- 纯本地存储，不上传云端
- Lance 列式格式，高效压缩
- 支持 FTS 全文搜索索引

## 与 OpenClaw Memory Enhanced 的关系

本项目从 [OpenClaw Memory Enhanced v2.0.0](https://github.com/asunoiwin/openclaw-memory-enhanced) 移植而来，核心检索算法完全保留：

**保留的核心能力**：
- LanceDB 向量存储 + BM25 混合检索
- RRF 融合排序 + 余弦相似度重排
- 时间衰减 + 新鲜度加成 + 重要性加权
- MMR 多样性去重
- 噪音过滤
- 嵌入缓存

**适配变更**：
- OpenClaw Plugin API → MCP Server（Model Context Protocol）
- 移除 OpenClaw 专属模块（KnowledgeGraph、DreamManager、HabitTracker 等）
- 简化配置，使用环境变量
- 添加 Claude Code Plugin 清单（`.claude-plugin/`）
- 添加 Rules 和 Skills 集成

## 许可证

MIT License
