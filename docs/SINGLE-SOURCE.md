# 记忆插件单一真源约定

## 结论
`claude-memory-pro` 与 `codex-memory-pro` 是**同一套记忆内核的两个平台外壳**：
- 两边 `src/` 逐字节相同，唯一有意差异是 MCP server 的 `name` 字符串。
- 存储通过 `MEMORY_DB_PATH` 指向**同一个 LanceDB**，两插件共享同一份记忆数据（进程间靠 store.ts 的陈旧句柄自愈协调）。
- 两边均**无 hooks**，合并不涉及任何 hook 逻辑。

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
