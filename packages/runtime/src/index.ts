import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { MarsError } from '../../core/src/index.js';
import type { AgentMessage, ModelDescriptor } from '../../core/src/index.js';

export class Workspace {
  private constructor(readonly root: string) {}
  static async open(root: string): Promise<Workspace> {
    const canonical = await realpath(root);
    if (!(await lstat(canonical)).isDirectory()) throw new MarsError('ConfigurationError', 'Workspace must be a directory.');
    return new Workspace(canonical);
  }
  async resolve(input: string): Promise<string> {
    if (!input || input.includes('\0') || (process.platform !== 'win32' && /[\\:]|^[A-Za-z]:/.test(input))) {
      throw new MarsError('WorkspaceViolationError', 'Invalid workspace path.');
    }
    const target = path.resolve(this.root, input);
    const relative = path.relative(this.root, target);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new MarsError('WorkspaceViolationError', 'Path is outside the workspace.');
    }
    const parts = relative.split(path.sep).filter(Boolean);
    let current = this.root;
    for (const part of parts) {
      if (part.includes(':') || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) {
        throw new MarsError('WorkspaceViolationError', 'Ambiguous or reserved path.');
      }
      if (/^(\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.config|\.git|\.mars|\.mars|credentials(?:\..*)?|id_rsa|id_ed25519|.*\.(pem|key|p12|pfx))$/i.test(part)) {
        throw new MarsError('PermissionDeniedError', 'Sensitive path is blocked.');
      }
      current = path.join(current, part);
      try {
        const stat = await lstat(current);
        // ponytail: reject all links; allow internal links only with an OS sandbox later.
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new MarsError('WorkspaceViolationError', 'Linked paths are blocked.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return target;
  }
}

export type Policy = 'allow' | 'ask' | 'deny';
export type ShellApproval = (command: string, cwd: string, signal: AbortSignal) => Promise<boolean>;
export type PermissionKind =
  | 'filesystem.read' | 'filesystem.write' | 'filesystem.writeOutsideWorkspace'
  | 'shell.execute' | 'shell.destructive' | 'network.access'
  | 'git.commit' | 'git.push' | 'credentials.read';
export interface PermissionPolicies {
  shell?: Policy;
  destructiveShell?: Policy;
  network?: Policy;
  gitCommit?: Policy;
  gitPush?: Policy;
}
export type PermissionEvent = (event: { type: 'permission:requested' | 'permission:granted' | 'permission:denied'; permission: PermissionKind; target?: string }) => void;

function shellSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||[|;\n]|\bthen\b)/gi)
    .map(segment => segment.trim())
    .filter(Boolean);
}

/** Conservative command classifier. It is intentionally extensible and fails closed for destructive operations. */
export function isDestructiveShell(command: string): boolean {
  const segments = shellSegments(command);
  return segments.some(segment => {
    const normalized = segment.replace(/^\s*(?:sudo|doas|command|env)\s+/i, '').trim();
    if (/^(?:rm|rmdir|del|erase|rd|remove-item|ri)\b/i.test(normalized)) return true;
    if (/^(?:git\s+(?:reset\s+--hard|clean\b|checkout\s+--|restore\s+--source))\b/i.test(normalized)) return true;
    if (/^(?:format|diskpart|shutdown|restart-computer|stop-computer)\b/i.test(normalized)) return true;
    if (/\b(?:drop\s+database|truncate\s+table)\b/i.test(normalized)) return true;
    if (/(?:^|\s)(?:--delete|--force-delete|--purge)(?:\s|$)/i.test(normalized)) return true;
    return false;
  });
}

export function isNetworkShell(command: string): boolean {
  return shellSegments(command).some(segment => {
    const normalized = segment.replace(/^\s*(?:sudo|doas|command|env)\s+/i, '').trim();
    return /^(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|scp|sftp|ftp|git\s+(?:clone|fetch|pull|push)|npm\s+(?:install|i)|pnpm\s+(?:install|add|fetch)|yarn\s+(?:install|add)|bun\s+(?:install|add))\b/i.test(normalized)
      || /(?:https?:\/\/|ftp:\/\/)/i.test(normalized);
  });
}

export class Permissions {
  shell: Policy;
  readonly destructiveShell: Policy;
  readonly network: Policy;
  readonly gitCommit: Policy;
  readonly gitPush: Policy;
  constructor(
    shell: Policy = 'ask',
    private readonly approve?: ShellApproval,
    policies: PermissionPolicies = {},
    private readonly emit?: PermissionEvent,
  ) {
    this.shell = policies.shell ?? shell;
    this.destructiveShell = policies.destructiveShell ?? 'deny';
    this.network = policies.network ?? 'ask';
    this.gitCommit = policies.gitCommit ?? 'ask';
    this.gitPush = policies.gitPush ?? 'ask';
  }
  policy(kind: PermissionKind): Policy {
    if (kind === 'shell.execute') return this.shell;
    if (kind === 'shell.destructive') return this.destructiveShell;
    if (kind === 'network.access') return this.network;
    if (kind === 'git.commit') return this.gitCommit;
    if (kind === 'git.push') return this.gitPush;
    return kind === 'filesystem.read' || kind === 'filesystem.write' ? 'allow' : 'ask';
  }
  async check(kind: PermissionKind, target: string, signal: AbortSignal): Promise<void> {
    const policy = this.policy(kind);
    if (policy === 'allow') { this.emit?.({ type: 'permission:granted', permission: kind, target }); return; }
    this.emit?.({ type: 'permission:requested', permission: kind, target });
    if (policy === 'ask' && this.approve && await this.approve(target, process.cwd(), signal)) {
      this.emit?.({ type: 'permission:granted', permission: kind, target });
      return;
    }
    this.emit?.({ type: 'permission:denied', permission: kind, target });
    throw new MarsError('PermissionDeniedError', `${kind} was not approved.`);
  }
  async checkGit(operation: 'commit' | 'push', target: string, cwd: string, signal: AbortSignal): Promise<void> {
    const kind: PermissionKind = operation === 'push' ? 'git.push' : 'git.commit';
    const policy = this.policy(kind);
    if (policy === 'allow') { this.emit?.({ type: 'permission:granted', permission: kind, target }); return; }
    this.emit?.({ type: 'permission:requested', permission: kind, target });
    if (policy === 'ask' && this.approve && await this.approve(target, cwd, signal)) { this.emit?.({ type: 'permission:granted', permission: kind, target }); return; }
    this.emit?.({ type: 'permission:denied', permission: kind, target });
    throw new MarsError('PermissionDeniedError', `${kind} was not approved.`);
  }
  async checkShell(command: string, cwd: string, signal: AbortSignal): Promise<void> {
    let approved = false;
    if (isDestructiveShell(command)) {
      if (this.destructiveShell === 'deny') {
        this.emit?.({ type: 'permission:denied', permission: 'shell.destructive', target: command });
        throw new MarsError('PermissionDeniedError', 'Destructive shell commands are denied by policy.');
      }
      this.emit?.({ type: 'permission:requested', permission: 'shell.destructive', target: command });
      if (this.destructiveShell === 'ask' && (!this.approve || !(approved = await this.approve(command, cwd, signal)))) {
        this.emit?.({ type: 'permission:denied', permission: 'shell.destructive', target: command });
        throw new MarsError('PermissionDeniedError', 'Destructive shell commands were not approved.');
      }
      this.emit?.({ type: 'permission:granted', permission: 'shell.destructive', target: command });
    }
    if (isNetworkShell(command)) {
      if (this.network === 'deny') {
        this.emit?.({ type: 'permission:denied', permission: 'network.access', target: command });
        throw new MarsError('PermissionDeniedError', 'Network access is denied by policy.');
      }
      this.emit?.({ type: 'permission:requested', permission: 'network.access', target: command });
      if (this.network === 'ask' && !approved && (!this.approve || !(approved = await this.approve(command, cwd, signal)))) {
        this.emit?.({ type: 'permission:denied', permission: 'network.access', target: command });
        throw new MarsError('PermissionDeniedError', 'Network access was not approved.');
      }
      this.emit?.({ type: 'permission:granted', permission: 'network.access', target: command });
    }
    if (this.shell === 'allow') { this.emit?.({ type: 'permission:granted', permission: 'shell.execute', target: command }); return; }
    this.emit?.({ type: 'permission:requested', permission: 'shell.execute', target: command });
    if (this.shell === 'ask' && (approved || (this.approve && await this.approve(command, cwd, signal)))) {
      this.emit?.({ type: 'permission:granted', permission: 'shell.execute', target: command });
      return;
    }
    this.emit?.({ type: 'permission:denied', permission: 'shell.execute', target: command });
    throw new MarsError('PermissionDeniedError', 'Shell execution was not approved.');
  }
}

export { Permissions as PermissionEngine };

export { loadConfig, saveConfig, mergeConfig, defaultConfigPath, projectConfigPath, type MarsConfig, type McpServerConfig, type ConfigPaths, type ConfigPatch } from './config.js';
export { FileSessionStore, defaultSessionDirectory, type Session, type SessionStore, type SessionSummary } from './sessions.js';
export { buildProjectContext, discoverProjectFiles, SkillRegistry, type ProjectContext, type ContextOptions, type Skill } from './context.js';
export { MODEL_CATALOG, ModelRegistry, routeTask, classifyTask, type RouteOptions, type RouteDecision, type TaskRole } from './routing.js';
export { BUILTIN_WORKFLOWS, WorkflowRegistry, selectWorkflow, type WorkflowDefinition, type WorkflowPhase } from './workflows.js';
export { FileEvidenceStore, evidencePath, type EvidenceRun, type EvidenceSnapshot, type EvidenceStore, type EvidenceSuggestion, type SkillEvidence, type WorkflowEvidence } from './evidence.js';
export { FileEventLog, ProviderHealthTracker, eventLogPath, readEventLog, readEventLogEntries, type EventLogEntry, type FileEventLogOptions, type ProviderHealth } from './observability.js';
