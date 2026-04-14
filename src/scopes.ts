/**
 * Multi-Scope Access Control System
 */

export interface ScopeDefinition {
  description: string;
  metadata?: Record<string, unknown>;
}

export interface ScopeConfig {
  default: string;
  definitions: Record<string, ScopeDefinition>;
  agentAccess: Record<string, string[]>;
}

export interface ScopeManager {
  getAccessibleScopes(agentId?: string): string[];
  getDefaultScope(agentId?: string): string;
  isAccessible(scope: string, agentId?: string): boolean;
  validateScope(scope: string): boolean;
  getAllScopes(): string[];
  getScopeDefinition(scope: string): ScopeDefinition | undefined;
}

export const DEFAULT_SCOPE_CONFIG: ScopeConfig = {
  default: "global",
  definitions: {
    global: { description: "Shared knowledge across all agents" },
  },
  agentAccess: {},
};

const SCOPE_PATTERNS = {
  GLOBAL: "global",
  AGENT: (agentId: string) => `agent:${agentId}`,
  CUSTOM: (name: string) => `custom:${name}`,
  PROJECT: (projectId: string) => `project:${projectId}`,
  USER: (userId: string) => `user:${userId}`,
};

export class MemoryScopeManager implements ScopeManager {
  private config: ScopeConfig;

  constructor(config: Partial<ScopeConfig> = {}) {
    this.config = {
      default: config.default || DEFAULT_SCOPE_CONFIG.default,
      definitions: { ...DEFAULT_SCOPE_CONFIG.definitions, ...config.definitions },
      agentAccess: { ...DEFAULT_SCOPE_CONFIG.agentAccess, ...config.agentAccess },
    };
    if (!this.config.definitions.global) {
      this.config.definitions.global = { description: "Shared knowledge across all agents" };
    }
  }

  private isBuiltInScope(scope: string): boolean {
    return scope === "global" || scope.startsWith("agent:") || scope.startsWith("custom:") || scope.startsWith("project:") || scope.startsWith("user:");
  }

  getAccessibleScopes(agentId?: string): string[] {
    if (!agentId) return this.getAllScopes();
    const explicitAccess = this.config.agentAccess[agentId];
    if (explicitAccess) return explicitAccess;
    const defaultScopes = ["global"];
    const agentScope = SCOPE_PATTERNS.AGENT(agentId);
    if (this.config.definitions[agentScope] || this.isBuiltInScope(agentScope)) {
      defaultScopes.push(agentScope);
    }
    return defaultScopes;
  }

  getDefaultScope(agentId?: string): string {
    if (!agentId) return this.config.default;
    const agentScope = SCOPE_PATTERNS.AGENT(agentId);
    const accessibleScopes = this.getAccessibleScopes(agentId);
    if (accessibleScopes.includes(agentScope)) return agentScope;
    return this.config.default;
  }

  isAccessible(scope: string, agentId?: string): boolean {
    if (!agentId) return this.validateScope(scope);
    return this.getAccessibleScopes(agentId).includes(scope);
  }

  validateScope(scope: string): boolean {
    if (!scope || typeof scope !== "string" || scope.trim().length === 0) return false;
    return this.config.definitions[scope.trim()] !== undefined || this.isBuiltInScope(scope.trim());
  }

  getAllScopes(): string[] {
    return Object.keys(this.config.definitions);
  }

  getScopeDefinition(scope: string): ScopeDefinition | undefined {
    return this.config.definitions[scope];
  }

  addScopeDefinition(scope: string, definition: ScopeDefinition): void {
    this.config.definitions[scope] = definition;
  }

  removeScopeDefinition(scope: string): boolean {
    if (scope === "global") throw new Error("Cannot remove global scope");
    if (!this.config.definitions[scope]) return false;
    delete this.config.definitions[scope];
    for (const [agentId, scopes] of Object.entries(this.config.agentAccess)) {
      const filtered = scopes.filter(s => s !== scope);
      if (filtered.length !== scopes.length) this.config.agentAccess[agentId] = filtered;
    }
    return true;
  }

  setAgentAccess(agentId: string, scopes: string[]): void {
    this.config.agentAccess[agentId] = [...scopes];
  }

  removeAgentAccess(agentId: string): boolean {
    if (!this.config.agentAccess[agentId]) return false;
    delete this.config.agentAccess[agentId];
    return true;
  }

  exportConfig(): ScopeConfig {
    return JSON.parse(JSON.stringify(this.config));
  }

  getStats(): { totalScopes: number; agentsWithCustomAccess: number; scopesByType: Record<string, number> } {
    const scopes = this.getAllScopes();
    const scopesByType: Record<string, number> = { global: 0, agent: 0, custom: 0, project: 0, user: 0, other: 0 };
    for (const scope of scopes) {
      if (scope === "global") scopesByType.global++;
      else if (scope.startsWith("agent:")) scopesByType.agent++;
      else if (scope.startsWith("custom:")) scopesByType.custom++;
      else if (scope.startsWith("project:")) scopesByType.project++;
      else if (scope.startsWith("user:")) scopesByType.user++;
      else scopesByType.other++;
    }
    return { totalScopes: scopes.length, agentsWithCustomAccess: Object.keys(this.config.agentAccess).length, scopesByType };
  }
}

export function createScopeManager(config?: Partial<ScopeConfig>): MemoryScopeManager {
  return new MemoryScopeManager(config);
}

export function parseScopeId(scope: string): { type: string; id: string } | null {
  if (scope === "global") return { type: "global", id: "" };
  const colonIndex = scope.indexOf(":");
  if (colonIndex === -1) return null;
  return { type: scope.substring(0, colonIndex), id: scope.substring(colonIndex + 1) };
}
