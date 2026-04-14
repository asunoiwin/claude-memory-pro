/**
 * Capture Journal Module
 * Pending capture queue with dedup and replay
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

const BASE_DIR = join(homedir(), '.claude', 'memory-pro');

export interface CaptureJournalEntry {
  id: string;
  dedupeKey: string;
  content: string;
  category?: string;
  importance?: number;
  createdAt: string;
  lastAttemptAt?: string;
  status: 'pending' | 'captured' | 'dropped';
  attempts: number;
  lastResult?: string;
  context?: Record<string, unknown>;
}

interface CaptureJournalFile {
  entries: CaptureJournalEntry[];
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; }
}

export class CaptureJournal {
  private readonly filePath: string;
  private readonly statusPath: string;
  private replayRunning = false;

  constructor(baseDir?: string) {
    const dir = baseDir || BASE_DIR;
    this.filePath = join(dir, 'capture-journal.json');
    this.statusPath = join(dir, 'capture-journal-status.json');
    mkdirSync(dirname(this.filePath), { recursive: true });
    if (!existsSync(this.filePath)) {
      writeFileSync(this.filePath, JSON.stringify({ entries: [] }, null, 2));
    }
  }

  private createDedupeKey(params: { content: string; category?: string; context?: Record<string, unknown> }): string {
    const source = String(params.context?.source || 'unknown');
    const sessionId = String(params.context?.sessionId || 'unknown');
    return createHash('sha256')
      .update(`${source}|${sessionId}|${params.category || ''}|${params.content.trim()}`)
      .digest('hex');
  }

  append(params: { content: string; category?: string; importance?: number; context?: Record<string, unknown> }): CaptureJournalEntry {
    const data = this.read();
    const dedupeKey = this.createDedupeKey(params);
    const existing = data.entries.find(e => e.status === 'pending' && e.dedupeKey === dedupeKey);
    if (existing) return existing;

    const entry: CaptureJournalEntry = {
      id: randomUUID(),
      dedupeKey,
      content: params.content,
      category: params.category,
      importance: params.importance,
      context: params.context,
      createdAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
    };
    data.entries.push(entry);
    this.write(data);
    return entry;
  }

  update(entryId: string, updates: Partial<CaptureJournalEntry>): CaptureJournalEntry | null {
    const data = this.read();
    const index = data.entries.findIndex(e => e.id === entryId);
    if (index === -1) return null;
    data.entries[index] = { ...data.entries[index], ...updates };
    this.write(data);
    return data.entries[index];
  }

  listPending(limit = 100): CaptureJournalEntry[] {
    return this.read().entries
      .filter(e => e.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  stats() {
    const entries = this.read().entries;
    const pendingEntries = entries.filter(e => e.status === 'pending');
    return {
      total: entries.length,
      pending: pendingEntries.length,
      captured: entries.filter(e => e.status === 'captured').length,
      dropped: entries.filter(e => e.status === 'dropped').length,
      oldestPending: pendingEntries.length > 0 ? pendingEntries.map(e => e.createdAt).sort()[0] : null,
      replayRunning: this.replayRunning,
    };
  }

  beginReplay(): boolean {
    if (this.replayRunning) return false;
    this.replayRunning = true;
    return true;
  }

  endReplay(): void {
    this.replayRunning = false;
  }

  prune(options: { keepCaptured?: number; keepDropped?: number } = {}): void {
    const keepCaptured = options.keepCaptured ?? 200;
    const keepDropped = options.keepDropped ?? 200;
    const data = this.read();
    const pending = data.entries.filter(e => e.status === 'pending');
    const captured = data.entries.filter(e => e.status === 'captured').slice(-keepCaptured);
    const dropped = data.entries.filter(e => e.status === 'dropped').slice(-keepDropped);
    this.write({ entries: [...pending, ...captured, ...dropped] });
  }

  private read(): CaptureJournalFile {
    return readJson<CaptureJournalFile>(this.filePath, { entries: [] });
  }

  private write(data: CaptureJournalFile): void {
    writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }
}

export default CaptureJournal;
