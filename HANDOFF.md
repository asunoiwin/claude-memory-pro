# 记忆插件重做 — 跨会话交接文档

**日期**：2026-04-28（第八次会话更新）
**状态**：✅ 代码已构建（含 §7.1 task 终态保护 + §7.2 redirect 引导提示） — **仍待 Claude Code 重启**完成端到端验证
**项目根**：`/Users/rico/claude-memory-pro/`
**git 分支**：`feature/initial-release`（HEAD=`340b772`，工作区仍有未提交改动）

---

## 1. 任务背景

CLAUDE.md 规定记忆系统是**三维**（记忆 / 任务 / 经验），但插件 `claude-memory-pro` 此前只实现了"记忆"维度。**任务（task_create / task_list）**和**经验（lesson_capture / lesson_recall）**这两个维度的工具根本没注册，导致：

- 用户从未真正存进过 task/lesson
- 每轮对话开始的 hook 提示"先 lesson_recall"实际无工具可调
- 教训类内容被混塞进 `memory_store(category=decision)`

## 2. 已完成的代码改动（**未提交**）

```
.claude-plugin/plugin.json   ── command 改为 /opt/homebrew/bin/node 绝对路径
package.json                 ── 新增 dep: apache-arrow ^21.1.0
src/store.ts                 ── MemoryEntry.category 联合类型加 "task" | "lesson"
src/auto-capture.ts          ── MemoryCategory 同步加 "task" | "lesson"
src/mcp-server.ts            ── CATEGORIES 数组加两项；新增 4 个 server.tool：
                                  • task_create   （subject/project/status/parentTaskId）
                                  • task_list     （按 project 过滤；status=open 默认）
                                  • lesson_capture（pitfall/solution/triggerKeywords/project/evidence）
                                  • lesson_recall （keywords + project；先关键词命中，回退向量）
scripts/test-three-tier.mjs  ── 新增（未跟踪）三维 self-test 脚本
```

**关键设计决策**（必须保留）：

- **task 去重**：同 `project` 同 `subject` 精确匹配，命中即调 `store.update`，**不新建**。subject 长度 >=4 防垃圾。
- **lesson 合并阈值 0.85**（比 memory 默认 0.98 宽松）。同类教训自动合并 `triggerKeywords`、`evidenceCount++`、保留最近 3 条 `evidenceHistory`，重要性 +0.05 封顶 1。
- **lesson_recall 双层召回**：先用 `triggerKeywords` 关键词精确命中，回退向量相似（阈值 0.5）。
- scope 命名约定：`task:<project>` / `lesson:<project>`（与 CLAUDE.md 一致）。
- task 不进 noise 过滤（subject 检查就够了）；lesson 字段长度由 zod 强制（pitfall>=10、solution>=5、triggerKeywords>=1）。

## 3. 必须执行的下一步

```bash
# build 已完成（22:47），dist/mcp-server.js 已含 4 个新工具
# 仅需：完全退出 Claude Code 并重新打开，让 MCP server 进程重启
```

⚠️ **当前 Claude Code 进程加载的仍是旧 MCP server**（启动时拉起的），不会自动重启。**必须重启 Claude Code**，新工具才会出现在工具列表里。

### 第二次会话补充（22:47-22:48）

1. ✅ 把 `apache-arrow` 从 `^21.1.0` 降到 `^18.1.0`（lancedb 0.26.2 peer 限制 `<=18.1.0`）
2. ✅ `npm install --legacy-peer-deps`（openai 4.x 与 lancedb 也有边缘冲突，须用 legacy-peer-deps）
3. ✅ `npm run build` 通过
4. ✅ 跑 `node scripts/test-three-tier.mjs`：**8 passed / 0 failed**
   - task 去重（subject+project 精确）✓
   - 不同 project 同 subject scope 隔离 ✓
   - lesson 入库 + metadata 完整 ✓
   - lesson_recall 关键词精确命中 ✓

### 踩坑记录（重启后须 lesson_capture 回填）

**坑 A — apache-arrow peer 冲突**：
- pitfall：升级 apache-arrow 到 21.1.0 与 @lancedb/lancedb@0.26.2 peer 要求 `<=18.1.0` 冲突，npm 直接报 ERESOLVE
- solution：apache-arrow 锁死 `^18.1.0`；npm install 加 `--legacy-peer-deps`（openai 4.x 还有 zod 边缘冲突）
- triggerKeywords：`["apache-arrow","lancedb","peer dependency","ERESOLVE"]`
- project：`claude-memory-pro`

**坑 B — macOS lancedb .node 签名 Team ID 不匹配**：
- pitfall：重装 node_modules 后 `dlopen` 报 "code signature ... mapping process and mapped file have different Team IDs"，原因是 macOS 内核对路径+inode 缓存了旧签名，xattr/codesign 都无效
- solution：**直接 `rm -rf node_modules/@lancedb` 后重新 npm install**（删除 inode 让内核缓存失效）
- triggerKeywords：`["lancedb","dlopen","Team IDs","code signature","macOS native module"]`
- project：`claude-memory-pro`

## 4. 验证清单（重启后立即跑）

- [ ] `mcp__claude-memory-pro__task_create` 工具存在
- [ ] `mcp__claude-memory-pro__task_list` 工具存在
- [ ] `mcp__claude-memory-pro__lesson_capture` 工具存在
- [ ] `mcp__claude-memory-pro__lesson_recall` 工具存在
- [ ] `task_create(subject="测试", project="larktokenweb", status="in_progress")` → 返回 ID
- [ ] 再调一次同 subject → 返回 "已更新"（不新建）✅ 去重
- [ ] `lesson_capture(pitfall="V42 硬编码反模式...", solution="改用 SaaS placeholder", triggerKeywords=["V42","硬编码"], project="larktokenweb")` → 返回 "已记录新教训"
- [ ] 再调一条**相似**的 → 返回 "已合并到已有教训"，evidenceCount=2 ✅ 合并

## 5. 用户预设的 lesson 回填（重启后立即一次性写入）

用户说：**"重启后我会立刻把今天踩的所有坑作为 lesson 一次性回填"** —— 共 7-8 条，已知至少这些：

1. V42 硬编码反模式
2. deploy-frontend.sh 的 dist 路径错配
3. vite base 双模式
4. 5 点事故 SSH 改生产（生产乱改）
5. PG sequence 重置后必须 setval
6. hook matcher Bash 太宽
7. **（本次新增）** Stop / PostToolUse hook 不支持 `additionalContext` 字段 — 只 SessionStart / UserPromptSubmit 支持。误用会导致 `Hook JSON output validation failed — (root): Invalid input` 报错混入对话。`triggerKeywords=["Stop hook","additionalContext","hookSpecificOutput"]`

⚠️ 回填时务必：`project="larktokenweb"`，每条都填好 `triggerKeywords`（无关键词 = 等于丢失）。

## 6. 已修复的副作用 bug（本次会话）

**Stop hook JSON 验证报错混入会话**：
```
Stop hook error: Hook JSON output validation failed — (root): Invalid input
```
根因：`~/.claude/hooks/memory-stop-task-persist.sh` 输出 `additionalContext` 字段，但 **Stop hook 事件不接受 `additionalContext`**（只 SessionStart / UserPromptSubmit 接受）。

修复：把 Stop hook 改为静默退出（自检提示已经在 UserPromptSubmit hook 里覆盖，重复了）。同样的隐患在 `memory-post-edit-lesson-prompt.sh`（PostToolUse），保留观察 — 如未来报错再统一处理。

## 6.5 第三次会话改动（**未提交**）

**目标**：在等用户重启的间隙，预防性修副作用 + 收紧 auto-capture 与三维边界。

1. **`~/.claude/hooks/memory-post-edit-lesson-prompt.sh` 改为静默退出**
   - 原因：与 Stop hook 同样的 `additionalContext` 不被 PostToolUse 接受问题（§6 已知坑），保留观察改为预防性修复，避免后续 "Hook JSON output validation failed" 噪音。
   - lesson 提醒已由 UserPromptSubmit hook 覆盖，删除不影响功能。

2. **`src/auto-capture.ts` — 三维边界硬隔离**
   - LLM 提示词新增 `reason="task"` / `reason="lesson"` 分类：明确告诉模型这两类内容**不要**走 `memory_capture`，让调用方走专用工具，避免污染普通 memory store。
   - `normalizeMemoryCategory`：把 `task` 从 `→fact` 拆出，task/lesson 都路由到 `other`（兜底，不再混入 fact）。
   - `capture()` 入口加硬拒绝：`category==='task'||'lesson'` 直接返回 `null`，杜绝绕过。
   - 影响：CLAUDE.md "禁止把 task/lesson 内容写到普通 memory" 规则现在有代码级强制。

3. **`npm run build` 通过**，dist/auto-capture.js 已含上述变更。

### 第三次会话踩到的新现象（**坑 B 复发**）

`node scripts/test-three-tier.mjs` 再次报 `dlopen ... different Team IDs`，**同一个 UUID `091A1F23...`**。
- §3 坑 B 当时的解法（`rm -rf node_modules/@lancedb && npm i`）这次**无效** — UUID 不变说明内核缓存的是签名而非 inode。
- 但**不影响真实部署**：当前运行中的 MCP server 进程（Claude Code 启动时拉起的）已成功加载过 lancedb，工具列表里 `mcp__claude-memory-pro__memory_*` 全部可用。仅离线脚本调用失败。
- 推测真正的清缓存方式：重启电脑，或换 `node` 二进制路径，或 `codesign --remove-signature && codesign -s -` 重签。**重启 Claude Code 之后若新 server 进程也报这个，需先用其中一种方式处理再启动**。
- 新增 triggerKeywords：`["dlopen Team ID 复发","macOS 签名缓存","rm -rf 无效"]`

## 7. 未触及但值得跟进的项

- [x] ~~auto-capture LLM 提示词识别 task/lesson 语义~~ → 第三次会话已加 reason 分类 + 硬拒绝。
- [x] ~~auto-capture 拒绝 task/lesson 时回传引导提示~~ → **第四次会话已做**（§6.6）
- [x] ~~task status 流转约束~~ → **第四次会话已做**（§6.6）
- [ ] dream / habits / KG 系统是否要把 task/lesson 也纳入晋升路径？目前只对 memory 生效

## 6.6 第四次会话改动（**未提交**）

**目标**：把 §7 的两项跟进做掉，等用户回来重启时端到端验证。

1. **`src/mcp-server.ts task_create` 终态保护**
   - 原行为：同 project 同 subject 任务命中即覆盖，不论 status。
   - 风险：已 `completed` / `cancelled` 的任务会被新调用静默改回 `in_progress`，丢失"已完成"事实。
   - 改后：去重只在 open（pending/in_progress）任务里做。终态任务保留为历史，新调用走 store 建新条目（"以同名重启一个新任务"语义）。
   - 文件位置：src/mcp-server.ts:629-639

2. **`src/auto-capture.ts` redirect 回传引导**
   - 新增 `CaptureResult = CaptureStored | CaptureRedirect` 联合类型，discriminator 字段 `kind`（注：不能用 `type`，因为 stored 分支的 type 是 string 不可窄化）。
   - 入口拒 task/lesson 时返回 `{kind:'redirect', redirect:'task_create'|'lesson_capture', hint}`，不再 return null 静默丢弃。
   - LLM 路径：当 LLM 返回 `capture=false, reason="task"|"lesson"` 时也回传同样的 redirect。
   - `memory_capture` MCP 工具把 redirect 渲染成 `⚠️ 已拒绝（xxx）：hint` 文本，调用方（LLM/agent）能立即看到该走哪个专用工具。
   - 文件位置：src/auto-capture.ts:74-92, 244-260, 286-296；src/mcp-server.ts:438-441

3. **`npm run build` 通过**。dist/ 已含上述变更。

### 第四次会话踩到的 — 坑 B 升级版

`node scripts/test-three-tier.mjs` 仍报 dlopen Team ID 错。这次实测：
- `codesign --remove-signature && codesign -s - -f` **无效** — UUID 091A1F23 不变。
- `cp $F $F.tmp && rm $F && mv $F.tmp $F`（换 inode）+ 重签 **无效** — UUID 仍 091A1F23。
- 根因：LC_UUID 嵌在 Mach-O 文件本体里，普通文件操作和 codesign 都不改它。**macOS 内核似乎用 LC_UUID 缓存"被拒绝的二进制"**，一旦标记，整机直到重启都拒绝。
- **结论**：用户态无法清。**只有重启电脑**或换一个 UUID 不同的二进制（重装不同版本的 lancedb）能清掉。
- **不影响实际运行**：当前 Claude Code 启动时拉起的 MCP server 进程在那次拒绝**之前**就已成功 dlopen 并持有 handle，工具列表里 memory_* 全可用。问题只在新启动的 node 进程（如离线测试脚本）。
- **重启 Claude Code 之后**：新 server 进程也是新 node 进程，**很可能也会被拒绝**。届时建议先重启电脑再开 Claude Code，或临时把 lancedb 升/降一个 patch 版让二进制 UUID 改变。
- 新增 triggerKeywords：`["LC_UUID 缓存","macOS 内核 dlopen 缓存","Team IDs 不可清除"]`

---
**给下一次重启后的我**：先 `cd /Users/rico/claude-memory-pro && git status` 看本文件的存在；然后按 §3 build+restart，再按 §4 验证；最后等用户给那 7-8 条 lesson 一次性写入。

**重启后必跑的额外验证**（持续累积）：
- [ ] 跑 `node scripts/test-three-tier.mjs` 看坑 B 是否还复发（若复发：见 §6.6 末尾，可能需重启电脑）
- [ ] 用 `memory_capture(category="task", text="...")` 测试，应返回 `⚠️ 已拒绝（task_create）：...`（不再 return null 静默）
- [ ] 用 `memory_capture(category="lesson", text="...")` 测试，应返回 `⚠️ 已拒绝（lesson_capture）：...`
- [ ] 编辑任意文件触发 PostToolUse hook，**不再**出现 "Hook JSON output validation failed" 报错
- [ ] `task_create(subject="X", project="P", status="completed")` 后再 `task_create(subject="X", project="P", status="in_progress")` → 应返回**新 ID**（不覆盖 completed）✅ 终态保护

---

## 6.7 第五次会话发现（2026-04-28 晚）

**关键诊断**：MCP server 进程 `pid 64245` 启动于 **2026-04-28 20:21:07**，dist/mcp-server.js mtime **22:56:24** — server 加载的是 build 之前的旧代码。验证方法：
```bash
ps -o lstart= -p $(pgrep -f claude-memory-pro/dist/mcp-server)
stat -f "%Sm" dist/mcp-server.js
```

**结论**：前几次会话用户以为的"重启 Claude Code"实际上没杀掉常驻 MCP server 子进程。父进程是 `claude`（pid 64193），子进程 64245 是 stdio MCP server。当前会话工具列表里 `mcp__claude-memory-pro__` 下**只有 14 个 memory_***，没有 task_*/lesson_* — 与上述诊断完全吻合。

**需要用户手动操作**（不能由 agent 代做，破坏性）：
1. **彻底退出 Claude Code**（Cmd+Q，不只是关窗口） — 否则父进程不死，子进程也不会被杀
2. 退出后 `ps aux | grep claude-memory-pro` 确认 64245 已消失
3. 重新打开 Claude Code → 新拉起的 MCP server 会加载 22:56 之后的 dist
4. 在新会话里立即跑 §4 / §6.6 的验证清单

**坑 C — "重启 Claude Code" ≠ 杀 MCP server 子进程**：
- pitfall：关闭 Claude Code 窗口、新建会话、`/clear`、SessionStart 重新触发 — 这些都**不会**重启 stdio MCP server 子进程；MCP server 是 claude 父进程拉起的常驻进程，只有父进程被 SIGKILL/正常退出时子进程才会跟着死
- solution：诊断方式 `ps -o lstart= -p <mcp-pid>` 对比 dist mtime；强制重启只能 Cmd+Q 整个 Claude Code app（或手动 `kill <mcp-pid>` 让 claude 重新 spawn，但后者行为不保证）
- triggerKeywords：`["MCP server 不重启","stdio 子进程","Claude Code 重启","新工具不可见"]`
- project：`claude-memory-pro`

**本次会话未做改动**：仅诊断，未触碰代码/git。dist 状态仍是第四次会话末尾的 22:56 build。等用户 Cmd+Q 后续验证。

---

## 6.8 第六次会话验证（2026-04-28，重启后）

**前置确认**：MCP server 已重启 — deferred tools 列表里 `mcp__claude-memory-pro__task_create / task_list / lesson_capture / lesson_recall` 全部出现，4 个新工具加载成功。

### 验证清单结果

| 项 | 结果 | 证据 |
|---|---|---|
| 4 个新工具存在 | ✅ | tool list 已加载 |
| `task_create` 创建 | ✅ | id=`7f88508c` |
| `task_create` 同 subject 去重 | ✅ | 返回"已更新任务 [7f88508c]" |
| **task 终态保护**（§6.6 改动） | ✅ | completed 后再 in_progress 拿到**新 ID** `7f5c5968`，原 completed 任务保留 |
| `task_list status=all` | ✅ | 同时返回 in_progress + completed 两条 |
| `lesson_capture` 入库 | ✅ | id=`380a4786` |
| `lesson_recall` 关键词命中 | ✅ | "触发词命中, 证据1次" |
| `memory_capture(category=task)` 拒绝 + redirect | ✅ | 返回"⚠️ 已拒绝（task_create）：task 内容不进 memory，请改用 task_create..." |
| `memory_capture(category=lesson)` 拒绝 + redirect | ✅ | 返回"⚠️ 已拒绝（lesson_capture）：..." |

### ⚠️ 发现的潜在问题（待跟进）

**lesson 合并阈值 0.85 偏严**：测试时回填两条**语义相同但措辞不同**的教训：
- A: "关闭 Claude Code 窗口或新建会话不会重启 stdio MCP server 子进程，导致新 build 的工具一直看不到" + solution "必须 Cmd+Q..."
- B: "Cmd+W 关闭 Claude Code 窗口不会让 MCP server 子进程退出，新 build 的工具看不到" + solution "必须 Cmd+Q 完全退出 Claude Code 应用"

预期：B 应合并到 A（evidenceCount=2）。实际：B 创建为新教训 `560ac386`。
推断：embedding 相似度未达 0.85。两条都谈"Cmd+W/Q + MCP server 不退 + 新工具不可见"，人眼看是同一个坑。

**建议**：
1. 短期 — 把合并阈值从 0.85 降到 0.78~0.80，再测一次
2. 中期 — 引入"triggerKeywords 重叠度"作为第二信号（>=2 关键词重叠也判合并）
3. **当前应处理**：手工合并这两条（删 `560ac386`，把它的 triggerKeywords 并入 `380a4786`），避免脏数据扩散

### 第六次会话**未触碰代码/git**

仅做了上述工具调用验证。dist 仍是 22:56 build。git 工作区状态不变（feature/initial-release HEAD=340b772 + 未提交改动）。

### 给下一次的 TODO

- [x] ~~处理 lesson 合并阈值偏严~~ → **§6.9 已做**
- [ ] 用户回填那 7-8 条历史 lesson（§5 列表）— 注意 `project="larktokenweb"`
- [ ] 把 `560ac386` 合并到 `380a4786`（手工或写 cleanup 脚本）
- [ ] 跑 `node scripts/test-three-tier.mjs` 看 dlopen Team ID 坑（§6.6 末尾）是否仍复发；MCP server 进程已正常运行说明真实链路 OK，离线脚本另算
- [ ] 决定 dream/habits/KG 是否纳入 task/lesson 晋升路径（§7 遗留项）
- [ ] 考虑 commit 当前改动到 feature/initial-release（4 次会话累积的 task/lesson 工具 + auto-capture 三维隔离 + 终态保护 + redirect）

---

## 6.9 第七次会话改动（2026-04-28，未提交）

**目标**：清理脏数据 + 回填已知具体 lesson + 改 lesson 合并双信号阈值。

### 数据动作（已落库）

1. ✅ 删除脏数据 `560ac386`（与 `380a4786` 语义重复的 Cmd+W 教训）
2. ✅ 回填 3 条具体 lesson：
   - `c54b48ea` apache-arrow peer 冲突（坑 A）
   - `4bafee43` lancedb dlopen Team IDs / LC_UUID 缓存（坑 B + 升级版合并）
   - `0da86c0b` Stop/PostToolUse hook additionalContext 不支持（坑 7，project=larktokenweb）
3. 还差用户提供细节的 6 条 larktokenweb 教训（V42 / deploy-frontend dist / vite base / SSH 改生产 / PG sequence setval / hook matcher Bash 太宽）— **等用户回填**

### 代码改动（src/mcp-server.ts:705-733）

**lesson_capture 合并逻辑：单信号 → 双信号**

- 旧：仅向量相似度 > 0.85 才合并
- 新：取 top-5 候选，按 `score >= 0.78 OR triggerKeywords 重叠 >= 2` 过滤，按 `score + overlap*0.05` 排序取最高分合并
- 理由：§6.8 实证 0.85 偏严（同坑不同表述漏合并），关键词重叠是更强的人类语义信号

### 状态

- ✅ `npm run build` 通过，dist/mcp-server.js mtime `Apr 28 23:04:48 2026`
- ⚠️ **当前 MCP server 进程仍加载 22:56 build**（task_create 等已可用，但 lesson_capture 仍是旧合并逻辑）
- 🔴 **需要用户 Cmd+Q 重启 Claude Code**（§6.7 坑 C：关窗口/新会话不会重启 stdio MCP server 子进程）

### 重启后必跑的端到端验证

- [ ] `lesson_capture` 写一条新坑，再写一条**措辞不同但 triggerKeywords 有 2 个重叠**的近义教训 → 应返回"已合并到已有教训"，evidenceCount=2
- [ ] `lesson_capture` 写两条**关键词完全不重叠且向量 < 0.78** 的教训 → 应都返回"已记录新教训"
- [ ] task `99056ddf` "lesson 合并双信号阈值改造" 验证通过后改 completed

### 重启后 git 状态

未提交累积改动（4 次会话叠加）：
- `.claude-plugin/plugin.json` node 绝对路径
- `package.json` apache-arrow ^18.1.0
- `src/store.ts` task/lesson 联合类型
- `src/auto-capture.ts` 三维硬隔离 + redirect
- `src/mcp-server.ts` task/lesson 4 工具 + 终态保护 + 双信号合并
- `scripts/test-three-tier.mjs`（未跟踪）

建议验证通过后一次性提交（中文 commit message，详细列改动）。

---

## 6.10 第八次会话改动（2026-04-28，未提交）

**前置状态**：MCP server pid 70517 启动于 23:06:07，已加载第七次会话 23:04:48 的 build（含 §6.9 双信号合并）。无需用户重启即可端到端验证 §6.9。

### 验证结果

| 项 | 结果 | 证据 |
|---|---|---|
| 双信号合并（向量 0.78~0.85 区间 + 关键词重叠 ≥2） | ✅ | 两条 lancedb schema 演进措辞不同的教训，相似度 82%，重叠关键词 2 个 → 合并 evidenceCount=2 |
| 无关键词重叠且语义不同的教训 | ✅ | zod default optional 教训创建为新记录 |
| `task_create` 终态保护（§6.6） | ✅ | task `99056ddf` completed 后再创建拿到新 id；用户旧测试也已证实 |
| `memory_capture(category=lesson)` redirect 渲染 | ❌ **发现 bug** | 返回"未触发捕获"而非"⚠️ 已拒绝（lesson_capture）" |

### Bug 修复 — `src/auto-capture.ts` redirect 顺序

**根因**：`capture()` 入口顺序是 `isCaptureNoise → category 检查`。短文本（如测试 "学到一个坑：xxx"）被噪音过滤直接 return null，永远走不到 251-256 行的 redirect 分支。

**修复**：把 task/lesson 的 redirect 检查上提到 `isCaptureNoise` 之前。category 是显式分类信号，应优先于噪音判定 — 用户/agent 既然标了 lesson/task，无论文本长度都该收到 redirect 提示而非静默丢弃。

文件位置：src/auto-capture.ts:235-244（新位置），原 251-256 行块已删除。

### 数据清理

- 删除验证用的两条虚构 lesson `a04563f6`（lancedb schema 演进，已含合并的 evidenceCount=2）和 `b95ab4f5`（zod default）— 都是测试合并逻辑的临时数据，非真实踩坑。
- task `99056ddf`「lesson 合并双信号阈值改造」→ completed。

### 状态

- ✅ `npm run build` 通过，dist mtime `Apr 28 23:08:00`
- ⚠️ **当前 MCP server (pid 70517) 仍是 23:04:48 build**，redirect 顺序 bug 未修复在运行进程里。需要 Cmd+Q 重启 Claude Code 后才能验证修复
- 🔴 第六~八次会话累积未提交改动（src/auto-capture.ts redirect 顺序 + 之前所有改动 + scripts/test-three-tier.mjs 未跟踪）

### 重启后必跑的端到端验证

- [ ] `memory_capture(category="lesson", text="x")` → 返回"⚠️ 已拒绝（lesson_capture）：lesson 内容不进 memory..."（不再"未触发捕获"）
- [ ] `memory_capture(category="task", text="y")` → 返回"⚠️ 已拒绝（task_create）：..."
- [ ] `memory_capture(text="正常长文本，无 category")` → 走原有路径，不受影响

### 给下一次的 TODO（接续 §6.9 末尾）

- [ ] 用户回填 §5 列出的 6 条 larktokenweb 历史 lesson（V42 / deploy-frontend / vite base / SSH 改生产 / PG sequence setval / hook matcher Bash 太宽）
- [ ] 决定 dream/habits/KG 是否纳入 task/lesson 晋升路径
- [ ] 一次性 commit 累积改动到 feature/initial-release（详细中文 message）
- [x] ~~跑 `node scripts/test-three-tier.mjs` 看 dlopen Team ID 坑~~ → §6.11 已跑，确认仍复发（不影响真实链路）

---

## 6.11 第九次会话验证（2026-04-28）

**前置状态**：MCP server pid 71084 启动于 23:09:09，dist/auto-capture.js 与 mcp-server.js 均为 23:08:00 build —— **进程已加载第八次会话 §6.10 修复**，无需重启即可验证。

### §6.10 redirect 顺序修复 — 端到端验证通过

| 调用 | 返回 | 状态 |
|---|---|---|
| `memory_capture(text="x", category="lesson")` | "⚠️ 已拒绝（lesson_capture）：lesson 内容不进 memory，请改用 lesson_capture(...)" | ✅ |
| `memory_capture(text="y", category="task")` | "⚠️ 已拒绝（task_create）：task 内容不进 memory，请改用 task_create(...)" | ✅ |

短文本（≤ 20 字）现在也能正确收到 redirect 提示，不再被 isCaptureNoise 静默吞掉。

### 坑 B（dlopen Team IDs / LC_UUID 缓存）状态

`node scripts/test-three-tier.mjs` 仍报错，UUID 仍是 `091A1F23-A70E-3362-A05C-88B6E48B3826` — 与 §6.6 末尾分析完全一致：
- 内核用 LC_UUID 缓存"被拒绝的二进制"，普通用户态操作（codesign/换 inode）都清不掉
- **不影响运行中的 MCP server**（pid 71084 是更早被信任的进程，已成功 dlopen 持有 handle）
- 下次 Claude Code 重启时新 node 进程**很可能**也会被拒绝。届时需重启电脑或升/降 lancedb patch 版改变二进制 UUID

### 本次会话**未触碰代码/git**

仅：
- 端到端验证 §6.10 修复（结果 ✅）
- 跑测试脚本确认坑 B 仍复发（已知，非新问题）
- 任务清单：`task_list(claude-memory-pro, all)` 显示 3 条全部 completed，无遗留 open 任务

### 给下一次的 TODO（接续 §6.10 末尾，不变）

- [ ] 用户回填 §5 的 6 条 larktokenweb 历史 lesson（需用户给具体细节）
- [x] ~~决定 dream/habits/KG 是否纳入 task/lesson 晋升路径~~ → **§6.12 方案 C 已落地**
- [ ] 一次性 commit 累积改动（git status 6 modified + 2 untracked，列表见 §6.9 末尾）
- [ ] 后续每次重启需关注：MCP server 新进程是否能正常加载 lancedb（坑 B 是否复发到生产链路）

---

## 6.13 第十一次会话验证（2026-04-28，方案 C 端到端通过）

**前置状态**：MCP server pid 71624 启动于 23:17:35，**已加载第十次会话 §6.12 build (23:16:17)** —— 无需用户重启即可验证。

### 验证结果（§6.12 全部通过）

| 验证项 | 结果 | 证据 |
|---|---|---|
| lesson 入 KG（结构化 factKey）| ✅ | b5a90388 在 `memory_kg query=方案C` 命中，entity=`lesson:测试方案c入kg的端到端验证...` |
| task 不入 KG | ✅ | `memory_kg query=方案C测试任务` 只返 lesson，不返 task 9b1440b5 |
| 现存 lesson 互不 supersede（防御 [LESSON] 共享 token）| ✅ | `memory_kg contradictions` 5 ID 无矛盾；KG stats 仅 1 节点被取代（非 lesson 间）|
| dream trail 不含 task/lesson | ✅ | trail 全为 fact/decision/entity，无 lesson/task category |
| habits candidates 不含 task | ✅ | 38 条候选全是 fact/preference/decision/entity/other |
| lesson_recall 后进入 habit 频率统计 | ✅ | recordRecallBatch 静默写入（b5a90388 已删，未污染 candidates）|
| 全程无 hook validation 报错 | ✅ | 工具响应清洁 |

### 清理动作

- 删除测试 lesson `b5a90388`（memory_forget）
- 关闭测试 task `9b1440b5` → completed

### 当前状态

- ✅ 方案 C 三大增强系统隔离全部生效，运行进程已是最新代码
- 🔴 **6 次会话累积改动仍未提交**（git status 6 modified + 2 untracked）
- 🔴 用户预设的 §5 那 6 条 larktokenweb 历史 lesson 仍待回填（V42 / deploy-frontend dist / vite base / SSH 改生产 / PG sequence setval / hook matcher Bash 太宽）

### 给下一次的 TODO

- [ ] 用户回填 §5 剩余 6 条 larktokenweb 历史 lesson（需用户给具体细节）
- [ ] **建议这次就 commit**：所有功能已端到端验证，再不提交风险越来越大。建议中文 message 列清 task 4 工具 / 终态保护 / 双信号合并 / redirect 顺序 / 方案 C 三大隔离
- [ ] 后续每次重启关注：MCP server 新进程是否能正常加载 lancedb（坑 B 是否复发到生产链路）

---

## 6.12 第十次会话改动（2026-04-28，未提交）

**目标**：落地方案 C — lesson 纳入 KG/habit 但不进 dream；task 全程隔离三大增强系统。要求"无 bug 无错误提示"以省 token，所有外部调用 fail-soft。

### 方案对比简记

| 系统 | task | lesson | 理由 |
|---|---|---|---|
| KG（语义图谱）| ❌ | ✅ | task 是临时工作流；lesson 应能被相关 memory 跨类型路由 |
| habit-tracker（召回频率）| ❌ | ✅ | task 召回是查进度；lesson 反复 recall 说明该坑高频 |
| dream（晋升 dream.md）| ❌ | ❌ | task 状态机非知识；lesson 已有 evidenceCount 自合并机制，叠 dream 是双重计分 |
| atlas/stats | ✅ | ✅ | 仅展示，无副作用 |

### 代码改动（7 处）

1. **`src/mcp-server.ts:737-743` lesson_capture 新建分支**：metadata 加 `factKey: lesson:<pitfall前40字>` + `summary: <pitfall前100字>`，让 KG `extractEntityKey` 走结构化路径。**关键 bug 防御**：所有 lesson entry.text 共享 `[LESSON] 坑：` 前缀 token，若走 KG token 回退路径会导致不同主题的 lesson 互相 supersede。

2. **`src/mcp-server.ts:746-748` lesson_capture 新建分支**：增量加 `kg.addNode(newEntry).catch(()=>{})`（与 memory_store 同模式，外层 try/catch 双重保护，绝不冒泡）。

3. **`src/mcp-server.ts` lesson_recall 两个返回分支**：召回结果调 `recordRecallBatch`（fail-soft try/catch），让 lesson 进入 habit 频率统计。

4. **`src/dream-manager.ts:95-` `memoryEntryToDreamEntry`**：显式过滤 `category === 'task' || 'lesson'` → return null。

5. **`src/habit-tracker.ts:155-` `recordRecall`**：入口拒绝 `category === 'task'`（lesson 通过）。

6. **`src/habit-tracker.ts:180-` `recordRecallBatch`**：同上，批量过滤掉 task。

7. **`src/knowledge-graph.ts`**：
   - `extractEntityKey`（line 165-）：lesson 在没 factKey 时返回 null（不走 token 回退），保护存量无 factKey 的 4 条历史 lesson 不互相 supersede。
   - `build()`（line 208-）：filter `category !== 'task'` 拒 task 全量入图。
   - `addNode()`（line 301-）：入口加 `if (category === 'task') return` 双保护。

### 状态

- ✅ `npm run build` 通过，dist mtime `Apr 28 23:16:17`
- ⚠️ 当前 MCP server (pid 71084) 加载的是 23:08 build，不含方案 C — **需要 Cmd+Q 重启 Claude Code**

### 重启后必跑的端到端验证

- [ ] `lesson_capture(pitfall="测试方案C入KG", solution="验证 KG 路由", triggerKeywords=["方案C"], project="claude-memory-pro")` → 成功创建
- [ ] `memory_kg(query="方案C")` → 应能命中刚才的 lesson（lesson 入图成功）
- [ ] `lesson_recall(keywords=["方案C"], project="claude-memory-pro")` → 命中后查 `memory_habits()` 应看到该 lesson 的 recallCount
- [ ] `task_create(subject="方案C测试任务", project="claude-memory-pro")` → 成功创建
- [ ] `memory_kg(query="方案C测试任务")` → **不应**命中 task（task 不入图）
- [ ] `memory_dream` 跑一次 → dream.md 不应出现 lesson/task 条目
- [ ] 现存 4 条 lesson `380a4786 / c54b48ea / 4bafee43 / 0da86c0b` 在 KG 中互相**无 supersede 关系**（因 extractEntityKey 拒绝 token 回退）
- [ ] 全程无 "Hook JSON output validation failed" 或其他 error 提示混入工具响应

### 给下一次的 TODO

- [ ] 用户回填 §5 的 6 条 larktokenweb 历史 lesson
- [ ] 一次性 commit 累积改动（feature/initial-release，5 次会话叠加）
- [ ] 重启后跑端到端验证 §6.12，过了再 commit
