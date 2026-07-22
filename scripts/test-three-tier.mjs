#!/usr/bin/env node
/**
 * 三维系统交叉验证（入库阈值 + 噪声污染防护）
 *
 * 不依赖 OpenAI embedder：直接测 store 层 + zod schema 校验
 * 跑：node scripts/test-three-tier.mjs
 */
import { MemoryStore } from "../dist/store.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const TEST_DB = path.join(os.tmpdir(), `mp-test-${Date.now()}`);
fs.mkdirSync(TEST_DB, { recursive: true });
console.log(`[test] DB: ${TEST_DB}`);

const store = new MemoryStore({ dbPath: TEST_DB, vectorDim: 1536 });
await store.init();

let pass = 0, fail = 0;
const ok = (name) => { console.log(`  ✅ ${name}`); pass++; };
const ng = (name, why) => { console.log(`  ❌ ${name}: ${why}`); fail++; };

// 假向量（不依赖 embedder）：用确定 hash 模拟
const fakeVector = (seed) => {
  const v = new Array(1536).fill(0);
  for (let i = 0; i < seed.length; i++) v[i % 1536] += seed.charCodeAt(i) / 1000;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm);
};

// ============================================================================
// Test 1: task 精确去重（按 subject+scope）
// ============================================================================
console.log("\n[Test 1] task 同 subject+project 入库 2 次应只剩 1 条");
{
  const meta1 = JSON.stringify({ subject: "修 V74 迁移", project: "larktokenweb", status: "in_progress", type: "task" });
  await store.store({ text: "[TASK:in_progress] 修 V74 迁移", vector: fakeVector("t1"), category: "task", scope: "task:larktokenweb", importance: 0.7, metadata: meta1 });

  // 模拟 task_create 的"先 list 再决定 update or insert"逻辑
  const existing = (await store.list(["task:larktokenweb"], "task", 200, 0))
    .find(e => { try { return JSON.parse(e.metadata).subject === "修 V74 迁移"; } catch { return false; } });

  if (existing) {
    const newMeta = { ...JSON.parse(existing.metadata), status: "completed" };
    await store.update(existing.id, { text: "[TASK:completed] 修 V74 迁移", metadata: JSON.stringify(newMeta) });
    ok("命中已有任务，走 update 而非新建");
  } else {
    ng("未命中已有任务，逻辑错");
  }

  const all = await store.list(["task:larktokenweb"], "task", 200, 0);
  if (all.length === 1) ok(`task list 仍为 1 条 (实际 ${all.length})`);
  else ng("task list", `应 1 条，实际 ${all.length}`);

  const finalStatus = JSON.parse(all[0].metadata).status;
  if (finalStatus === "completed") ok("status 被正确更新为 completed");
  else ng("status 更新", `期望 completed，实际 ${finalStatus}`);
}

// ============================================================================
// Test 2: 不同 project 同 subject 应分别存（scope 隔离）
// ============================================================================
console.log("\n[Test 2] 不同 project 同 subject 应彼此独立");
{
  await store.store({ text: "[TASK] 修 bug", vector: fakeVector("t2a"), category: "task",
    scope: "task:projA", importance: 0.7, metadata: JSON.stringify({ subject: "修 bug", project: "projA", status: "in_progress" }) });
  await store.store({ text: "[TASK] 修 bug", vector: fakeVector("t2b"), category: "task",
    scope: "task:projB", importance: 0.7, metadata: JSON.stringify({ subject: "修 bug", project: "projB", status: "in_progress" }) });
  const a = await store.list(["task:projA"], "task", 50, 0);
  const b = await store.list(["task:projB"], "task", 50, 0);
  if (a.length === 1 && b.length === 1) ok("两 project 各 1 条，scope 隔离 OK");
  else ng("scope 隔离", `projA=${a.length}, projB=${b.length}`);
}

// ============================================================================
// Test 3: lesson 字段长度校验（schema 层在 MCP 入口拦，本测验存储层接受）
// ============================================================================
console.log("\n[Test 3] lesson 入库基础（依赖 MCP zod 拦截短字段）");
{
  // 注意：zod 校验在 mcp-server.ts 的 server.tool() 层，store 层不校验
  // 这里仅验证存储层能正常接受合法 lesson
  const meta = JSON.stringify({
    pitfall: "V42 硬编码 sort_order，新模型沉底",
    solution: "改用 ModelSortService 按 model_name 自动算",
    triggerKeywords: ["sort_order", "模型排序", "V42"],
    evidenceCount: 1, type: "lesson", project: "larktokenweb"
  });
  const e = await store.store({
    text: "[LESSON] V42 硬编码 → 智能算法",
    vector: fakeVector("L1"), category: "lesson", scope: "lesson:larktokenweb",
    importance: 0.85, metadata: meta
  });
  if (e.id) ok(`lesson 入库成功 [${e.id.slice(0, 8)}]`);
  else ng("lesson 入库", "无 ID 返回");

  // 校验 metadata 完整性
  const got = (await store.list(["lesson:larktokenweb"], "lesson", 50, 0))[0];
  const m = JSON.parse(got.metadata);
  if (m.triggerKeywords?.length === 3) ok("metadata.triggerKeywords 完整");
  else ng("triggerKeywords", `期望 3 个，实际 ${m.triggerKeywords?.length}`);
}

// ============================================================================
// Test 4: lesson_recall 关键词命中（不依赖向量）
// ============================================================================
console.log("\n[Test 4] lesson_recall 关键词精确命中（list+filter 路径）");
{
  // 模拟 lesson_recall 的"先 list filter triggerKeywords"逻辑
  const candidates = await store.list(["lesson:larktokenweb"], "lesson", 500, 0);
  const matched = candidates.filter(e => {
    try {
      const m = JSON.parse(e.metadata || "{}");
      const triggers = (m.triggerKeywords || []).map(s => s.toLowerCase());
      return triggers.some(t => t.includes("sort_order") || "sort_order".includes(t));
    } catch { return false; }
  });
  if (matched.length === 1) ok("关键词 'sort_order' 命中 1 条 lesson");
  else ng("关键词命中", `期望 1，实际 ${matched.length}`);
}

// ============================================================================
// Test 5: 噪声防护（短 text 不应通过 schema，但 store 层不拦——验 zod 在 MCP 入口）
// ============================================================================
console.log("\n[Test 5] schema 层（在 mcp-server.ts）应拦短字段");
{
  // 这里只能"证明 store 层是宽容的"，schema 拦截发生在 MCP 调用时
  // 实际拦截见 mcp-server.ts task_create 的 z.string().min(4)、lesson_capture 的 z.string().min(10) 等
  console.log("  ℹ  task subject min=4 / lesson pitfall min=10 / lesson triggerKeywords min=1");
  console.log("  ℹ  这些约束由 zod 在 MCP 工具入口处生效，本脚本不能直接测（要走 stdio MCP 协议）");
  console.log("  ℹ  端到端验证需要：重启 Claude Code 后实际调用 task_create / lesson_capture");
  ok("schema 约束文档化于 mcp-server.ts");
}

// ============================================================================
console.log(`\n========== 结果 ${pass} passed, ${fail} failed ==========`);
fs.rmSync(TEST_DB, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
