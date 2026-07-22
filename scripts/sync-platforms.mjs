#!/usr/bin/env node
/**
 * 记忆插件单一真源同步器
 *
 * 背景：claude-memory-pro 与 codex-memory-pro 是同一套记忆内核的两个平台外壳，
 * 真实代码差异仅 server name 一行，存储通过 MEMORY_DB_PATH 共享同一 LanceDB。
 * 本脚本以 claude-memory-pro/src 为唯一真源，一键刷到各平台目标，
 * 自动施加平台专属补丁（仅字符串替换，内容寻址，非行号），消灭手动双份维护。
 *
 * 全程不碰 hooks（记忆插件无 hooks）、不碰 package.json/manifest/dist、不碰存储路径。
 *
 * 用法：node scripts/sync-platforms.mjs [--build]
 *   --build  同步后在目标目录跑 npm run build
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const CANON_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// 平台目标：目录 + 该平台的字符串补丁（真源值 → 平台值）
const TARGETS = [
  {
    name: 'codex-memory-pro',
    src: '/Users/rico/codex/projects/codex-memory-pro/plugins/codex-memory-pro/src',
    root: '/Users/rico/codex/projects/codex-memory-pro/plugins/codex-memory-pro',
    patches: [
      { file: 'mcp-server.ts', from: 'name: "claude-memory-pro"', to: 'name: "codex-memory-pro"' },
    ],
  },
];

const doBuild = process.argv.includes('--build');

function listTs(dir) {
  return readdirSync(dir).filter(f => f.endsWith('.ts') && statSync(join(dir, f)).isFile());
}

for (const t of TARGETS) {
  const patchMap = new Map(t.patches.map(p => [p.file, p]));
  let copied = 0, patched = 0;
  for (const f of listTs(CANON_SRC)) {
    let content = readFileSync(join(CANON_SRC, f), 'utf8');
    const p = patchMap.get(f);
    if (p) {
      if (!content.includes(p.from)) throw new Error(`补丁失效：${f} 未找到 "${p.from}"，真源结构可能变了`);
      content = content.replace(p.from, p.to);
      patched++;
    }
    writeFileSync(join(t.src, f), content);
    copied++;
  }
  console.log(`[${t.name}] 同步 ${copied} 个 src 文件，施加 ${patched} 处平台补丁`);
  if (doBuild) {
    execFileSync('npm', ['run', 'build'], { cwd: t.root, stdio: 'inherit' });
    console.log(`[${t.name}] 构建完成`);
  }
}
console.log('同步完成。真源：claude-memory-pro/src');
