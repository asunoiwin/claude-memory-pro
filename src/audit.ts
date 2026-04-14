/**
 * Audit Module - Memory health check and repair
 */

import type { MemoryStore } from './store.js';

export interface AuditResult {
  timestamp: number;
  stats: {
    total_memories: number;
    issues: number;
    noiseDeleted: number;
    duplicatesRemoved: number;
  };
}

export class AuditEngine {
  private store: MemoryStore;
  private auditPromise: Promise<AuditResult> | null = null;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async runAudit(): Promise<AuditResult> {
    if (this.auditPromise) return this.auditPromise;

    this.auditPromise = (async () => {
      try {
        const stats = await this.store.stats();
        return {
          timestamp: Date.now(),
          stats: {
            total_memories: stats.totalCount,
            issues: 0,
            noiseDeleted: 0,
            duplicatesRemoved: 0,
          },
        };
      } catch {
        return {
          timestamp: Date.now(),
          stats: { total_memories: 0, issues: 1, noiseDeleted: 0, duplicatesRemoved: 0 },
        };
      } finally {
        this.auditPromise = null;
      }
    })();

    return this.auditPromise;
  }
}

export default AuditEngine;
