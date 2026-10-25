import { MarsError } from '../../core/src/index.js';
import type { AuthContext, AuthMethod, AuthProvider, AuthStatus, Credential, OAuthCredential } from './index.js';

type FetchLike = typeof fetch;
type TokenShape = Record<string, unknown>;

const secondsFrom = (value: unknown, fallback?: number): number | undefined => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Date.now() + Math.floor(number * 1000) - 30_000 : fallback;
};
const safeHttpUrl = (value: string): URL => {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error();
    return url;
  } catch { throw new MarsError('ConfigurationError', 'Authentication endpoint must use HTTPS.'); }
};
const abortError = (signal: AbortSignal): MarsError => new MarsError(
  signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'CancelledError',
  signal.reason?.name === 'TimeoutError' ? 'Authentication timed out.' : 'Authentication cancelled.',
);
const requestJson = async (fetchImpl: FetchLike, input: string | URL, init: RequestInit, signal: AbortSignal): Promise<TokenShape> => {
  let response: Response;
  try { response = await fetchImpl(input, { ...init, signal }); }
  catch (error) {
    if (signal.aborted) throw abortError(signal);
    throw new MarsError('AuthenticationError', 'Authentication request failed.');
  }
  if (!response.ok) throw new MarsError('AuthenticationError', 'Authentication request was rejected.');
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as TokenShape;
  } catch { throw new MarsError('AuthenticationError', 'Authentication response was invalid.'); }
};


function parseOAuthToken(value: TokenShape, provider: string, fallbackRefresh?: string): OAuthCredential {
  if (typeof value.access_token !== 'string' || !value.access_token) throw new MarsError('AuthenticationError', 'Authentication response did not contain an access token.');
  const refreshToken = typeof value.refresh_token === 'string' && value.refresh_token ? value.refresh_token : fallbackRefresh;
  const scope = typeof value.scope === 'string' ? value.scope.split(' ').filter(Boolean) : undefined;
  const expiresAt = secondsFrom(value.expires_in);
  return {
    provider, kind: 'oauth', accessToken: value.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(typeof value.token_type === 'string' ? { tokenType: value.token_type } : {}),
    ...(scope?.length ? { scope } : {}),
  };
}

interface DevicePollOptions<T> {
  intervalSeconds: number;
  expiresInSeconds: number;
  signal: AbortSignal;
  waitBeforeFirstPoll?: boolean;
  poll: () => Promise<{ status: 'pending' | 'slow_down' | 'complete' | 'failed'; value?: T; message?: string; intervalSeconds?: number }>;
}
async function pollDevice<T>(options: DevicePollOptions<T>): Promise<T> {
  const deadline = Date.now() + options.expiresInSeconds * 1000;
  let interval = Math.max(0.1, options.intervalSeconds);
  let first = true;
  while (Date.now() < deadline) {
    if (first && options.waitBeforeFirstPoll) await delay(interval * 1000, options.signal);
    first = false;
    const result = await options.poll();
    if (result.status === 'complete' && result.value !== undefined) return result.value;
    if (result.status === 'failed') throw new MarsError('AuthenticationError', result.message ?? 'Device authentication failed.');
    if (result.status === 'slow_down') interval = Math.min(interval + 5, 30);
    if (!(first && options.waitBeforeFirstPoll)) await delay(interval * 1000, options.signal);
  }
  throw new MarsError('TimeoutError', 'Device authentication timed out.');
}
async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(abortError(signal)); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
function authStatus(credential: Credential | undefined, provider: string, method: AuthMethod): AuthStatus {
  if (!credential || credential.provider !== provider) return { authenticated: false, message: 'Not connected.' };
  if (credential.kind === 'api-key') return { authenticated: true, method: 'api-key' };
  if (credential.kind === 'external') return { authenticated: true, method: 'local' };
  if (credential.expiresAt && credential.expiresAt <= Date.now()) return { authenticated: false, method, expiresAt: credential.expiresAt, message: 'Access token expired.' };
  return { authenticated: true, method, expiresAt: credential.expiresAt };
}


export interface AnthropicAuthOptions {
  clientId?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  fetch?: FetchLike;
  callbackPort?: number;
  timeoutMs?: number;
}
export class AnthropicAuthProvider implements AuthProvider {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic / Claude';
  constructor(_options: AnthropicAuthOptions = {}) {}
  methods(): readonly AuthMethod[] { return []; }
  async login(_method: AuthMethod, _context: AuthContext): Promise<OAuthCredential> {
    throw new MarsError('ConfigurationError', 'Anthropic subscription login is disabled in MARS. Use an Anthropic API key.');
  }
  async refresh(credential: OAuthCredential, context: AuthContext): Promise<OAuthCredential> {
    throw new MarsError('AuthenticationError', 'Anthropic subscription credentials are not supported. Use an Anthropic API key.');
  }
  async logout(): Promise<void> {}
  async status(credential: Credential | undefined): Promise<AuthStatus> { return authStatus(credential, this.id, 'oauth-pkce'); }
}

export interface KimiCodeAuthOptions {
  clientId?: string;
  oauthHost?: string;
  fetch?: FetchLike;
  waitBeforeFirstPoll?: boolean;
}
const KIMI_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
export class KimiCodeAuthProvider implements AuthProvider {
  readonly id = 'kimi-code';
  readonly displayName = 'Kimi Code';
  readonly #options: { clientId: string; oauthHost: string; fetch?: FetchLike; waitBeforeFirstPoll: boolean };
  constructor(options: KimiCodeAuthOptions = {}) {
    const host = options.oauthHost ?? process.env.KIMI_CODE_OAUTH_HOST ?? process.env.KIMI_OAUTH_HOST ?? 'https://auth.kimi.com';
    safeHttpUrl(host);
    this.#options = { clientId: options.clientId ?? KIMI_CLIENT_ID, oauthHost: host.replace(/\/+$/, ''), fetch: options.fetch, waitBeforeFirstPoll: options.waitBeforeFirstPoll ?? true };
  }
  methods(): readonly AuthMethod[] { return ['oauth-device']; }
  async login(method: AuthMethod, context: AuthContext): Promise<OAuthCredential> {
    if (method !== 'oauth-device') throw new MarsError('ConfigurationError', `${this.displayName} does not support ${method}.`);
    const response = await requestJson(this.#options.fetch ?? fetch, `${this.#options.oauthHost}/api/oauth/device_authorization`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.#options.clientId }) }, context.signal);
    const deviceCode = typeof response.device_code === 'string' ? response.device_code : undefined;
    const userCode = typeof response.user_code === 'string' ? response.user_code : undefined;
    const verificationUri = typeof response.verification_uri === 'string' ? response.verification_uri : undefined;
    const verificationUriComplete = typeof response.verification_uri_complete === 'string' ? response.verification_uri_complete : undefined;
    if (!deviceCode || !userCode || !verificationUri || !verificationUriComplete) throw new MarsError('AuthenticationError', 'Kimi device authentication response was invalid.');
    safeHttpUrl(verificationUri); safeHttpUrl(verificationUriComplete);
    const interval = Number(response.interval);
    const expiresInSeconds = Number(response.expires_in);
    const effectiveInterval = Number.isFinite(interval) && interval > 0 ? interval : 5;
    const effectiveExpiry = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 15 * 60;
    context.notify?.({ type: 'device-code', verificationUri, verificationUriComplete, userCode, expiresAt: Date.now() + effectiveExpiry * 1000 });
    await context.openUrl(verificationUriComplete).catch(() => {});
    const value = await pollDevice<TokenShape>({ intervalSeconds: effectiveInterval, expiresInSeconds: effectiveExpiry, waitBeforeFirstPoll: this.#options.waitBeforeFirstPoll, signal: context.signal, poll: async () => {
      let response: Response;
      try { response = await (this.#options.fetch ?? fetch)(`${this.#options.oauthHost}/api/oauth/token`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.#options.clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }), signal: context.signal }); }
      catch { if (context.signal.aborted) throw abortError(context.signal); return { status: 'failed', message: 'Kimi device authentication request failed.' }; }
      const json = await response.json().catch(() => ({})) as TokenShape;
      if (response.ok && typeof json.access_token === 'string') return { status: 'complete', value: json };
      if (json.error === 'authorization_pending') return { status: 'pending' };
      if (json.error === 'slow_down') return { status: 'slow_down' };
      if (json.error === 'expired_token' || json.error === 'access_denied') return { status: 'failed', message: 'Kimi device authentication was denied or expired.' };
      if (response.status >= 500) return { status: 'failed', message: 'Kimi authentication service is unavailable.' };
      return { status: 'failed', message: 'Kimi device authentication was rejected.' };
    }});
    return parseOAuthToken(value, this.id);
  }
  async refresh(credential: OAuthCredential, context: AuthContext): Promise<OAuthCredential> {
    if (credential.provider !== this.id || !credential.refreshToken) throw new MarsError('AuthenticationError', 'No refresh token is available.');
    const value = await requestJson(this.#options.fetch ?? fetch, `${this.#options.oauthHost}/api/oauth/token`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.#options.clientId, grant_type: 'refresh_token', refresh_token: credential.refreshToken }) }, context.signal);
    return parseOAuthToken(value, this.id, credential.refreshToken);
  }
  async logout(): Promise<void> {}
  async status(credential: Credential | undefined): Promise<AuthStatus> { return authStatus(credential, this.id, 'oauth-device'); }
}
