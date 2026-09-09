import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { ForgeError } from '../../core/src/index.js';
import type { Credential, CredentialStore } from './index.js';

function clone(credential: Credential): Credential {
  return structuredClone(credential);
}

export function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== 'string' || !record.provider || typeof record.kind !== 'string') return false;
  if (record.kind === 'api-key') return typeof record.secret === 'string';
  if (record.kind !== 'oauth' || typeof record.accessToken !== 'string') return false;
  if (record.refreshToken !== undefined && typeof record.refreshToken !== 'string') return false;
  if (record.expiresAt !== undefined && (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt))) return false;
  if (record.tokenType !== undefined && typeof record.tokenType !== 'string') return false;
  if (record.scope !== undefined && (!Array.isArray(record.scope) || record.scope.some(item => typeof item !== 'string'))) return false;
  if (record.accountId !== undefined && typeof record.accountId !== 'string') return false;
  if (record.metadata !== undefined) {
    if (!record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) return false;
    if (Object.values(record.metadata).some(item => typeof item !== 'string')) return false;
  }
  return true;
}

export function defaultCredentialPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.USERPROFILE ?? env.HOME ?? process.cwd();
  const root = process.platform === 'win32'
    ? env.APPDATA ?? join(home, 'AppData', 'Roaming')
    : env.XDG_CONFIG_HOME ?? join(home, '.config');
  return join(root, 'mars', 'auth.json');
}

/** Development fallback: atomic per-user storage. Prefer createCredentialStore() for OS keychain support. */
export class FileCredentialStore implements CredentialStore {
  readonly path: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(path = defaultCredentialPath()) { this.path = path; }

  async get(provider: string): Promise<Credential | undefined> {
    return this.#serial(async () => {
      const values = await this.#read();
      const credential = values[provider];
      return credential ? clone(credential) : undefined;
    });
  }

  async set(credential: Credential): Promise<void> {
    await this.#serial(async () => {
      const values = await this.#read();
      values[credential.provider] = clone(credential);
      await this.#write(values);
    });
  }

  async delete(provider: string): Promise<void> {
    await this.#serial(async () => {
      const values = await this.#read();
      delete values[provider];
      await this.#write(values);
    });
  }

  async #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.then(() => {}, () => {});
    return next;
  }

  async #read(): Promise<Record<string, Credential>> {
    let raw: string;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new ForgeError('ConfigurationError', 'Could not read the MARS credential store.');
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      const values: Record<string, Credential> = Object.create(null) as Record<string, Credential>;
      for (const [provider, credential] of Object.entries(parsed)) {
        if (!isCredential(credential) || credential.provider !== provider) throw new Error();
        values[provider] = credential;
      }
      return values;
    } catch {
      throw new ForgeError('ConfigurationError', 'The MARS credential store is invalid. Remove it and log in again.');
    }
  }

  async #write(values: Record<string, Credential>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path);
    } catch {
      await unlink(temporary).catch(() => {});
      throw new ForgeError('ConfigurationError', 'Could not write the MARS credential store.');
    }
  }
}

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

const require = createRequire(import.meta.url);
function loadKeytar(): KeytarLike | undefined {
  try {
    const value = require('keytar') as Partial<KeytarLike>;
    if (typeof value.getPassword !== 'function' || typeof value.setPassword !== 'function' || typeof value.deletePassword !== 'function') return undefined;
    return value as KeytarLike;
  } catch { return undefined; }
}

/** Native Credential Manager/Keychain/Secret Service adapter when optional keytar is installed. */
export class KeychainCredentialStore implements CredentialStore {
  readonly service: string;
  readonly #keytar: KeytarLike;
  constructor(service = 'mars', keytar = loadKeytar()) {
    if (!keytar) throw new ForgeError('ConfigurationError', 'The native credential backend is unavailable. Install the optional keytar dependency or use file storage.');
    this.service = service;
    this.#keytar = keytar;
  }
  async get(provider: string): Promise<Credential | undefined> {
    const raw = await this.#keytar.getPassword(this.service, provider).catch(() => { throw new ForgeError('ConfigurationError', 'Could not read the native MARS credential store.'); });
    if (!raw) return undefined;
    try {
      const value: unknown = JSON.parse(raw);
      if (!isCredential(value) || value.provider !== provider) throw new Error();
      return clone(value);
    } catch { throw new ForgeError('ConfigurationError', 'The native MARS credential store is invalid. Log in again.'); }
  }
  async set(credential: Credential): Promise<void> {
    if (!isCredential(credential)) throw new ForgeError('AuthenticationError', 'Invalid credential for the selected provider.');
    await this.#keytar.setPassword(this.service, credential.provider, JSON.stringify(credential)).catch(() => { throw new ForgeError('ConfigurationError', 'Could not write the native MARS credential store.'); });
  }
  async delete(provider: string): Promise<void> {
    await this.#keytar.deletePassword(this.service, provider).catch(() => { throw new ForgeError('ConfigurationError', 'Could not delete the native MARS credential.'); });
  }
}

export type CredentialStoreMode = 'auto' | 'file' | 'keychain';
export function keychainAvailable(): boolean { return Boolean(loadKeytar()); }
export function createCredentialStore(options: { mode?: CredentialStoreMode; filePath?: string; service?: string } = {}): CredentialStore {
  const mode = options.mode ?? (process.env.MARS_CREDENTIAL_STORE as CredentialStoreMode | undefined) ?? 'auto';
  if (!['auto', 'file', 'keychain'].includes(mode)) throw new ForgeError('ConfigurationError', 'MARS_CREDENTIAL_STORE must be auto, file or keychain.');
  if (mode !== 'file') {
    const keytar = loadKeytar();
    if (keytar) return new KeychainCredentialStore(options.service ?? 'mars', keytar);
    if (mode === 'keychain') throw new ForgeError('ConfigurationError', 'The native credential backend is unavailable. Install keytar or set MARS_CREDENTIAL_STORE=file.');
  }
  return new FileCredentialStore(options.filePath);
}
