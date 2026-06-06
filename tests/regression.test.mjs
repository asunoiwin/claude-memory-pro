// 回归测试：锁住两个静默丢数据 bug 的修复（commit f466ef2 等）
// 用 node --test 运行：npm test。临时 LanceDB + 假向量，不碰真实库、不烧 embedding。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../dist/store.js";
import { KnowledgeGraphManager } from "../dist/knowledge-graph.js";

const DIM = 8;
const vec = () => new Array(DIM).fill(0.1);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let dbPath, store;

before(async () => {
  dbPath = mkdtempSync(join(tmpdir(), "memtest-"));
  store = new MemoryStore({ dbPath, vectorDim: DIM });
  await store.init();
  // 505 条填充，跨过 list() 单页 500 上限
  for (let i = 0; i < 505; i++) {
    await store.store({ text: `filler memory number ${i}`, vector: vec(), category: "fact", scope: "test", importance: 0.5 });
  }
});

after(() => { try { rmSync(dbPath, { recursive: true, force: true }); } catch {} });

test("Bug B: listAll 不被 500 单页上限截断", async () => {
  const total = await store.count();
  const all = await store.listAll();
  const onePage = await store.list(undefined, undefined, 500, 0);
  assert.equal(onePage.length, 500, "旧 list 单页应封顶 500");
  assert.ok(total >= 505, "总数应 >= 505");
  assert.equal(all.length, total, "listAll 必须覆盖全量，不丢最老记忆");
  const ids = new Set(all.map(e => e.id));
  assert.equal(ids.size, all.length, "listAll 不得有重复 id");
});

test("Bug B: KG build 收录全部非 task 记忆（不漏最老的）", async () => {
  const kg = new KnowledgeGraphManager(store);
  await kg.build();
  const total = await store.count();
  assert.equal(kg.getStats().totalNodes, total, "KG 节点数应等于全部非 task 记忆数");
});

test("Bug A: KG 认 metadata.supersededBy，召回过滤被取代记忆", async () => {
  const older = await store.store({ text: "zebraunique legacy arch uses lago billing", vector: vec(), category: "fact", scope: "test", importance: 0.6 });
  const newer = await store.store({ text: "modern arch self built billing no lago", vector: vec(), category: "fact", scope: "test", importance: 0.6 });

  const kg = new KnowledgeGraphManager(store);

  // 标废前：旧记忆两种模式都能召回（基线，证明它可路由）
  await kg.build();
  const before = kg.getStats().supersededNodes;
  assert.ok(kg.query("zebraunique legacy", { includeSuperseded: false }).some(r => r.id === older.id), "标废前应能召回旧记忆");

  // 标废：旧 → 新（跨 entityKey，靠 supersededBy 字段）
  await store.updateEntrySupersedes(older.id, newer.id);
  await kg.build();

  assert.equal(kg.getStats().supersededNodes, before + 1, "标废后 supersededNodes 应 +1");
  const withSup = kg.query("zebraunique legacy", { includeSuperseded: true }).some(r => r.id === older.id);
  const noSup = kg.query("zebraunique legacy", { includeSuperseded: false }).some(r => r.id === older.id);
  assert.ok(withSup, "includeSuperseded=true 仍应能召回（证明它在图谱、可路由）");
  assert.ok(!noSup, "includeSuperseded=false 必须过滤掉被取代的旧记忆");
});

test("P0: KG entityKey 取代方向正确（留最新，废较旧）", async () => {
  const fk = JSON.stringify({ factKey: "shared_arch_topic_xyz" });
  const old1 = await store.store({ text: "arch topic xyz old version", vector: vec(), category: "fact", scope: "test", importance: 0.6, metadata: fk });
  await sleep(8);
  const new1 = await store.store({ text: "arch topic xyz new version", vector: vec(), category: "fact", scope: "test", importance: 0.6, metadata: fk });

  const kg = new KnowledgeGraphManager(store);
  await kg.build();
  const res = kg.query("arch topic xyz", { includeSuperseded: false });
  const ids = new Set(res.map(r => r.id));
  assert.ok(ids.has(new1.id), "应保留最新一条");
  assert.ok(!ids.has(old1.id), "应过滤掉较旧一条（方向不能反）");
});

test("P0: 原子 update 不丢行不产生重复", async () => {
  const before = await store.count();
  const e = await store.store({ text: "atomic update target original", vector: vec(), category: "fact", scope: "test", importance: 0.5 });
  assert.equal(await store.count(), before + 1);
  const upd = await store.update(e.id, { text: "atomic update target CHANGED" });
  assert.equal(upd.text, "atomic update target CHANGED");
  assert.equal(await store.count(), before + 1, "update 后总行数不变（无孤儿/无重复）");
  const got = await store.getByIds([e.id]);
  assert.equal(got.length, 1, "id 唯一");
  assert.equal(got[0].text, "atomic update target CHANGED", "更新已持久化");
});

test("P0: 原子 incrementRecallBatch 计数且不丢行", async () => {
  const before = await store.count();
  const e = await store.store({ text: "recall count target", vector: vec(), category: "fact", scope: "test", importance: 0.5 });
  await store.incrementRecallBatch([e.id]);
  assert.equal(await store.count(), before + 1, "计数后总行数不变");
  const got = await store.getByIds([e.id]);
  assert.equal(got.length, 1, "id 唯一");
  assert.equal(got[0].recallCount, 1, "recallCount 应 +1");
});
