// 回归测试：锁住两个静默丢数据 bug 的修复（commit f466ef2 等）
// 用 node --test 运行：npm test。临时 LanceDB + 假向量，不碰真实库、不烧 embedding。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../dist/store.js";
import { KnowledgeGraphManager } from "../dist/knowledge-graph.js";
import { detectSimpleContradiction } from "../dist/memory-daily-reorg.js";

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

test("P2: ensureFresh 在 store 变更后自动重建（修跨进程/写后陈旧）", async () => {
  const kg = new KnowledgeGraphManager(store);
  await kg.build();
  const n0 = kg.getStats().totalNodes;
  // 模拟"另一个进程/写库后未刷新"：直接写库，不手动 build/addNode
  await store.store({ text: "ensurefresh brand new entry zzz", vector: vec(), category: "fact", scope: "test", importance: 0.5 });
  await kg.ensureFresh();
  assert.equal(kg.getStats().totalNodes, n0 + 1, "store 变更后 ensureFresh 应重建并纳入新记忆");
  // 版本未变则不重复重建（幂等）
  await kg.ensureFresh();
  assert.equal(kg.getStats().totalNodes, n0 + 1, "版本未变不应再增");
});

test("中文矛盾: 干净的否定矛盾(X vs 不X)应判矛盾", () => {
  assert.equal(detectSimpleContradiction("计费用 Lago 引擎不要自建", "计费用 Lago 引擎要自建"), true, "不要X vs 要X");
  assert.equal(detectSimpleContradiction("不允许外部访问数据库", "允许外部访问数据库"), true, "不允许 vs 允许");
  assert.equal(detectSimpleContradiction("别开启调试模式给生产", "开启调试模式给生产"), true, "别开启 vs 开启");
  assert.equal(detectSimpleContradiction("勿添加管理员权限给访客", "添加管理员权限给访客"), true, "勿添加 vs 添加");
});

test("中文矛盾: 三轮审计的各类反例都不误判(从严)", () => {
  // 同向否定 / 双重否定
  assert.equal(detectSimpleContradiction("计费用 Lago 引擎不要自建", "计费用 Lago 引擎不要自研"), false, "都'不要'但内容不同");
  assert.equal(detectSimpleContradiction("这个功能不能开启给用户", "这个功能不能关闭给用户"), false, "都'不能'");
  assert.equal(detectSimpleContradiction("生产不能不开启审计", "生产开启审计"), false, "双重否定=肯定，不算矛盾");
  // 单字嵌入常见词 / 子串误命中
  assert.equal(detectSimpleContradiction("计费用 Lago 引擎自建", "计不用 Lago 引擎自建"), false, "费用≠用，去否定后不等");
  assert.equal(detectSimpleContradiction("flag falsey value is allowed", "flag true value is allowed"), false, "falsey≠true");
  // 不相关
  assert.equal(detectSimpleContradiction("今天天气很好适合出门", "数据库索引需要重建优化"), false, "不相关");
});

test("双审#3: incrementRecallBatch 并发自增不丢计数（DB端原子）", async () => {
  const e = await store.store({ text: "concurrent recall target", vector: vec(), category: "fact", scope: "test", importance: 0.5 });
  await Promise.all(Array.from({ length: 20 }, () => store.incrementRecallBatch([e.id])));
  const got = await store.getByIds([e.id]);
  assert.equal(got[0].recallCount, 20, "20 次并发自增应得 20（非 read-modify-write 丢计数）");
});

test("复审#1: 表版本驱动新鲜度——召回计数后再写结构，绝不被掩盖", async () => {
  const e = await store.store({ text: "version masking target", vector: vec(), category: "fact", scope: "test", importance: 0.5 });
  const kg = new KnowledgeGraphManager(store);
  await kg.build();
  const n0 = kg.getStats().totalNodes;

  // 关键反掩盖序列：先召回计数写，再来一条结构写，ensureFresh 必须纳入新记忆
  await store.incrementRecallBatch([e.id]);
  await store.store({ text: "structural after recall masking zzz", vector: vec(), category: "fact", scope: "test", importance: 0.5 });
  await kg.ensureFresh();
  assert.equal(kg.getStats().totalNodes, n0 + 1, "结构写绝不能被召回计数掩盖");

  // 版本未变则幂等不重复重建
  const after = kg.getStats().totalNodes;
  await kg.ensureFresh();
  assert.equal(kg.getStats().totalNodes, after, "版本未变不应再增");
});

test("P1: delete 删 0 行返回 false（不假报已删除）", async () => {
  assert.equal(await store.delete("non-existent-id-xyz"), false, "删不存在的 id 应返回 false");
  const e = await store.store({ text: "delete target real", vector: vec(), category: "fact", scope: "test", importance: 0.5 });
  assert.equal(await store.delete(e.id), true, "删真实存在的应返回 true");
  assert.equal(await store.delete(e.id), false, "重复删已删除的应返回 false");
});

test("listAll化: getRecallCandidates 按召回量取 top（不漏老的高频，库已 >500）", async () => {
  const lo = await store.store({ text: "recall cand low", vector: vec(), category: "fact", scope: "test", importance: 0.5 });
  const hi = await store.store({ text: "recall cand high", vector: vec(), category: "fact", scope: "test", importance: 0.5 });
  await store.incrementRecallBatch([lo.id]);
  await store.incrementRecallBatch([hi.id]);
  await store.incrementRecallBatch([hi.id]);
  const cands = await store.getRecallCandidates(50);
  assert.ok(cands.every(e => (e.recallCount ?? 0) > 0), "只含召回过的");
  const ids = cands.map(e => e.id);
  assert.ok(ids.includes(hi.id) && ids.includes(lo.id), "高频记忆都在候选里（不被最新N窗口挡掉）");
  assert.ok(ids.indexOf(hi.id) < ids.indexOf(lo.id), "按召回量降序：hi 在 lo 前");
});
