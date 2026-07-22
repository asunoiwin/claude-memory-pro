# 记忆插件单一真源约定

## 结论
`claude-memory-pro` 与 `codex-memory-pro` 是**同一套记忆内核的两个平台外壳**：
- 两边 `src/` 逐字节相同，唯一有意差异是 MCP server 的 `name` 字符串。
- 存储通过 `MEMORY_DB_PATH` 指向**同一个 LanceDB**，两插件共享同一份记忆数据（进程间靠 store.ts 的陈旧句柄自愈协调）。

## Hook 是平台专属，不进同步
- **claude-memory-pro 有 hook**（声明在 `.claude-plugin/plugin.json`）：`SessionStart`（含 compact 变体）注入工作先验/习惯，`Stop` 刷新习惯与知识图谱；实现在 `scripts/session-start-hook.cjs` / `session-end-hook.cjs`。
- **codex-memory-pro 无 hook**（codex 平台 hook 事件为 `session_start`/`pre_tool_use`/`post_tool_use`，命名与 claude 不同）。
- 两平台 hook 事件模型不同，**绝不跨平台共享**。同步脚本只刷 `src/*.ts`，**刻意排除 manifest / scripts / hooks**，各平台 hook 各自维护——这既是设计也是红线。

## 真源
**`claude-memory-pro/src` 是唯一真源。** 任何内核改动只改这里。

## 同步到 codex
```bash
cd ~/claude-memory-pro
node scripts/sync-platforms.mjs --build
```
脚本会把 `src/*.ts` 刷到 codex 目标，并自动施加平台补丁（server name），不碰 package.json / manifest / dist / 存储路径。`--build` 顺带重建 codex dist。

## 禁止
- ❌ 直接改 codex 的 `src/`（会被下次同步覆盖，且造成分叉）
- ❌ 在同步脚本外手动维护第二份内核

## 平台专属（各自维护，不同步）
package.json、`.claude-plugin/` vs `.codex-plugin/`、tsconfig 之外的平台配置、tests 目录。
