import { ForgeError } from '../../core/src/index.js';
import { FileCredentialStore, defaultCredentialPath } from './store.js';

export type AuthMethod = 'oauth-pkce' | 'oauth-device' | 'api-key' | 'environment' | 'local';
export interface ApiKeyCredential { provider: string; kind: 'api-key'; secret: string }
export interface OAuthCredential {
  provider: string;
  kind: 'oauth';
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string[];
  /** Non-secret routing data returned by a provider (for example account ID). */
  accountId?: string;
  metadata?: Record<string, string>;
}
export type Credential = ApiKeyCredential | OAuthCredential;

export type AuthNotification =
  | { type: 'auth-url'; url: string; instructions?: string }
  | { type: 'device-code'; verificationUri: string; verificationUriComplete?: string; userCode: string; expiresAt?: number }
  | { type: 'progress'; message: string };

export interface AuthContext {
  signal: AbortSignal;
  openUrl(url: string): Promise<void>;
  notify?(event: AuthNotification): void;
}
export interface AuthStatus {
  authenticated: boolean;
  method?: AuthMethod;
  expiresAt?: number;
  message?: string;
}
export interface AuthProvider {
  readonly id: string;
  readonly displayName: string;
  methods(): readonly AuthMethod[];
  login(method: AuthMethod, context: AuthContext): Promise<Credential>;
  refresh?(credential: OAuthCredential, context: AuthContext): Promise<OAuthCredential>;
  logout(credential: Credential, context: AuthContext): Promise<void>;
  status(credential: Credential | undefined, context: AuthContext): Promise<AuthStatus>;
}

export class AuthRegistry {
  #providers = new Map<string, AuthProvider>();
  register(provider: AuthProvider): void {
    if (this.#providers.has(provider.id)) throw new ForgeError('ConfigurationError', `Duplicate auth provider: ${provider.id}`);
    this.#providers.set(provider.id, provider);
  }
  get(id: string): AuthProvider | undefined { return this.#providers.get(id); }
  list(): AuthProvider[] { return [...this.#providers.values()]; }
}

export interface CredentialStore {
  get(provider: string): Promise<Credential | undefined>;
  set(credential: Credential): Promise<void>;
  delete(provider: string): Promise<void>;
}
export class MemoryCredentialStore implements CredentialStore {
  #credentials = new Map<string, Credential>();
  async get(provider: string) { const value = this.#credentials.get(provider); return value && structuredClone(value); }
  async set(credential: Credential) { this.#credentials.set(credential.provider, structuredClone(credential)); }
  async delete(provider: string) { this.#credentials.delete(provider); }
}

export { FileCredentialStore, KeychainCredentialStore, createCredentialStore, defaultCredentialPath, isCredential, keychainAvailable, type CredentialStoreMode } from './store.js';

const environmentNames: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY'],
  'openai-codex': ['MARS_OPENAI_CODEX_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  'kimi-code': ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
};

function sanitiseCredential(provider: string, credential: Credential): Credential {
  if (credential.provider !== provider) throw new ForgeError('AuthenticationError', 'Invalid credential for the selected provider.');
  if (credential.kind === 'api-key') {
    if (!credential.secret.trim()) throw new ForgeError('AuthenticationError', 'Invalid credential for the selected provider.');
    return { ...credential, secret: credential.secret.trim() };
  }
  if (!credential.accessToken.trim()) throw new ForgeError('AuthenticationError', 'Invalid credential for the selected provider.');
  return {
    ...credential,
    accessToken: credential.accessToken.trim(),
    ...(credential.refreshToken?.trim() ? { refreshToken: credential.refreshToken.trim() } : {}),
    ...(credential.accountId?.trim() ? { accountId: credential.accountId.trim() } : {}),
  };
}

export async function resolveAuthCredential(provider: string, options: {
  explicit?: Credential;
  store?: CredentialStore;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<Credential | undefined> {
  const stored = await options.store?.get(provider);
  const environment = options.env ?? process.env;
  const secret = (environmentNames[provider] ?? []).map(name => environment[name]).find(value => Boolean(value?.trim()));
  const credential = options.explicit ?? stored ?? (secret ? { provider, kind: 'api-key' as const, secret } : undefined);
  return credential ? sanitiseCredential(provider, credential) : undefined;
}

/** Backwards-compatible API-key-only resolver. */
export async function resolveCredential(provider: string, options: {
  explicit?: ApiKeyCredential;
  store?: CredentialStore;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ApiKeyCredential | undefined> {
  const credential = await resolveAuthCredential(provider, options);
  return credential?.kind === 'api-key' ? credential : undefined;
}

export async function refreshCredential(provider: AuthProvider, credential: Credential, options: {
  store?: CredentialStore;
  context?: AuthContext;
} = {}): Promise<Credential> {
  if (credential.kind !== 'oauth' || !provider.refresh || !credential.expiresAt || credential.expiresAt > Date.now() + 60_000) return credential;
  const context = options.context ?? { signal: new AbortController().signal, openUrl: async () => {} };
  const refreshed = await provider.refresh(credential, context);
  await options.store?.set(refreshed);
  return refreshed;
}

export const providerAuthCatalog = [
  { id: 'openai', name: 'OpenAI API', browser: 'api-key', apiKey: true, subscription: false },
  { id: 'openai-codex', name: 'OpenAI / Codex', browser: 'experimental; disabled by default', apiKey: false, subscription: true },
  { id: 'anthropic', name: 'Anthropic / Claude', browser: 'not available to unapproved third-party apps', apiKey: true, subscription: false },
  { id: 'kimi-code', name: 'Kimi Code', browser: 'experimental device flow; disabled by default', apiKey: true, subscription: true },
  { id: 'gemini', name: 'Google Gemini API', browser: 'oauth-pkce (own Cloud client)', apiKey: true, subscription: false },
  { id: 'qwen', name: 'Qwen / Model Studio', browser: 'api-key / token plan', apiKey: true, subscription: false },
  { id: 'openrouter', name: 'OpenRouter', browser: 'api-key', apiKey: true, subscription: false },
  { id: 'ollama', name: 'Ollama local', browser: 'local', apiKey: false, subscription: false },
] as const;

export { BrowserOAuthProvider, openBrowser, type BrowserOAuthConfig } from './oauth.js';
export { AnthropicAuthProvider, KimiCodeAuthProvider, OpenAICodexAuthProvider } from './subscriptions.js';
export { GoogleGeminiAuthProvider } from './google.js';
