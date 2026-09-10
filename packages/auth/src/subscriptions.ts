import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { ForgeError } from '../../core/src/index.js';
import type { AuthContext, AuthMethod, AuthProvider, AuthStatus, Credential, OAuthCredential } from './index.js';

type FetchLike = typeof fetch;
type TokenShape = Record<string, unknown>;

const asBase64Url = (value: Buffer): string => value.toString('base64url');
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
  } catch { throw new ForgeError('ConfigurationError', 'Authentication endpoint must use HTTPS.'); }
};
const abortError = (signal: AbortSignal): ForgeError => new ForgeError(
  signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'CancelledError',
  signal.reason?.name === 'TimeoutError' ? 'Authentication timed out.' : 'Authentication cancelled.',
);
const requestJson = async (fetchImpl: FetchLike, input: string | URL, init: RequestInit, signal: AbortSignal): Promise<TokenShape> => {
  let response: Response;
  try { response = await fetchImpl(input, { ...init, signal }); }
  catch (error) {
    if (signal.aborted) throw abortError(signal);
    throw new ForgeError('AuthenticationError', 'Authentication request failed.');
  }
  if (!response.ok) throw new ForgeError('AuthenticationError', 'Authentication request was rejected.');
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as TokenShape;
  } catch { throw new ForgeError('AuthenticationError', 'Authentication response was invalid.'); }
};

interface PkceConfig {
  provider: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string;
  callbackPath: string;
  callbackPort: number;
  authorizationParams?: Record<string, string>;
  tokenParams?: Record<string, string>;
  tokenFormat?: 'form' | 'json';
  tokenState?: boolean;
  stateFromVerifier?: boolean;
  timeoutMs?: number;
  fetch?: FetchLike;
  parseToken?: (value: TokenShape, provider: string, fallbackRefresh?: string) => OAuthCredential;
}

function parseOAuthToken(value: TokenShape, provider: string, fallbackRefresh?: string): OAuthCredential {
  if (typeof value.access_token !== 'string' || !value.access_token) throw new ForgeError('AuthenticationError', 'Authentication response did not contain an access token.');
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

async function browserPkce(config: PkceConfig, context: AuthContext): Promise<OAuthCredential> {
  safeHttpUrl(config.authorizationEndpoint);
  safeHttpUrl(config.tokenEndpoint);
  const verifier = asBase64Url(randomBytes(48));
  const challenge = asBase64Url(createHash('sha256').update(verifier).digest());
  const state = config.stateFromVerifier ? verifier : asBase64Url(randomBytes(32));
  const server = createServer();
  let settled = false;
  let finish!: (value: { code: string } | Error) => void;
  const callback = new Promise<{ code: string }>((resolve, reject) => {
    finish = value => {
      if (settled) return;
      settled = true;
      if (value instanceof Error) reject(value); else resolve(value);
      server.close();
    };
  });
  void callback.catch(() => {});
  server.on('request', (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== config.callbackPath) { response.writeHead(404).end(); return; }
      if (url.searchParams.get('state') !== state) {
        response.writeHead(400).end('Invalid authentication state.');
        finish(new ForgeError('AuthenticationError', 'Authentication state validation failed.'));
        return;
      }
      const providerError = url.searchParams.get('error');
      if (providerError) {
        response.writeHead(400).end('MARS login was denied.');
        finish(new ForgeError('AuthenticationError', 'Authentication was denied.'));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        response.writeHead(400).end('Missing authorization code.');
        finish(new ForgeError('AuthenticationError', 'Authentication response did not contain a code.'));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<p>MARS login complete. You can close this window.</p>');
      finish({ code });
    } catch {
      response.writeHead(400).end('Invalid callback.');
      finish(new ForgeError('AuthenticationError', 'Invalid authentication callback.'));
    }
  });
  const abort = () => finish(abortError(context.signal));
  context.signal.addEventListener('abort', abort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.callbackPort, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new ForgeError('ConfigurationError', 'Could not allocate the authentication callback.');
    const redirectUri = `http://localhost:${address.port}${config.callbackPath}`;
    const authorization = safeHttpUrl(config.authorizationEndpoint);
    authorization.search = new URLSearchParams({
      response_type: 'code', client_id: config.clientId, redirect_uri: redirectUri,
      scope: config.scopes, state, code_challenge: challenge, code_challenge_method: 'S256',
      ...config.authorizationParams,
    }).toString();
    context.notify?.({ type: 'auth-url', url: authorization.toString(), instructions: 'Completa el login en el navegador; MARS espera el callback local.' });
    await context.openUrl(authorization.toString());
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ForgeError('TimeoutError', 'Authentication timed out.')), config.timeoutMs ?? 120_000); });
    const result = await Promise.race([callback, timeout]);
    const bodyValues = { grant_type: 'authorization_code', client_id: config.clientId, code: result.code, redirect_uri: redirectUri, code_verifier: verifier, ...(config.tokenState ? { state } : {}), ...config.tokenParams };
    const format = config.tokenFormat ?? 'form';
    const token = await requestJson(config.fetch ?? fetch, config.tokenEndpoint, {
      method: 'POST',
      headers: format === 'json' ? { accept: 'application/json', 'content-type': 'application/json' } : { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: format === 'json' ? JSON.stringify(bodyValues) : new URLSearchParams(bodyValues),
    }, context.signal);
    return (config.parseToken ?? parseOAuthToken)(token, config.provider);
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    if (context.signal.aborted) throw abortError(context.signal);
    throw new ForgeError('AuthenticationError', 'Browser authentication failed.');
  } finally {
    if (timer) clearTimeout(timer);
    context.signal.removeEventListener('abort', abort);
    if (!settled) finish(new ForgeError('CancelledError', 'Authentication cancelled.'));
    server.close();
  }
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
    if (result.status === 'failed') throw new ForgeError('AuthenticationError', result.message ?? 'Device authentication failed.');
    if (result.status === 'slow_down') interval = Math.min(interval + 5, 30);
    if (!(first && options.waitBeforeFirstPoll)) await delay(interval * 1000, options.signal);
  }
  throw new ForgeError('TimeoutError', 'Device authentication timed out.');
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
const ANTHROPIC_CLIENT_ID = Buffer.from('9d1c250a-e61b-44d9-88ed-594dd1962f5e').toString('base64');
const ANTHROPIC_AUTH_URL = 'https://claude.ai/oauth/authorize';
const ANTHROPIC_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const ANTHROPIC_SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
export class AnthropicAuthProvider implements AuthProvider {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic / Claude';
  readonly #options: Required<Pick<AnthropicAuthOptions, 'clientId' | 'authorizationEndpoint' | 'tokenEndpoint' | 'callbackPort' | 'timeoutMs'>> & { fetch?: FetchLike };
  constructor(options: AnthropicAuthOptions = {}) {
    this.#options = { clientId: options.clientId ?? process.env.MARS_ANTHROPIC_CLIENT_ID ?? Buffer.from(ANTHROPIC_CLIENT_ID, 'base64').toString('utf8'), authorizationEndpoint: options.authorizationEndpoint ?? ANTHROPIC_AUTH_URL, tokenEndpoint: options.tokenEndpoint ?? ANTHROPIC_TOKEN_URL, callbackPort: options.callbackPort ?? 53692, timeoutMs: options.timeoutMs ?? 120_000, fetch: options.fetch };
  }
  methods(): readonly AuthMethod[] { return ['oauth-pkce']; }
  async login(method: AuthMethod, context: AuthContext): Promise<OAuthCredential> {
    if (method !== 'oauth-pkce') throw new ForgeError('ConfigurationError', `${this.displayName} does not support ${method}.`);
    return browserPkce({ provider: this.id, clientId: this.#options.clientId, authorizationEndpoint: this.#options.authorizationEndpoint, tokenEndpoint: this.#options.tokenEndpoint, scopes: ANTHROPIC_SCOPES, callbackPath: '/callback', callbackPort: this.#options.callbackPort, timeoutMs: this.#options.timeoutMs, fetch: this.#options.fetch, tokenFormat: 'json', tokenState: true, stateFromVerifier: true, authorizationParams: { code: 'true' }, parseToken: parseOAuthToken }, context);
  }
  async refresh(credential: OAuthCredential, context: AuthContext): Promise<OAuthCredential> {
    if (credential.provider !== this.id || !credential.refreshToken) throw new ForgeError('AuthenticationError', 'No refresh token is available.');
    const value = await requestJson(this.#options.fetch ?? fetch, this.#options.tokenEndpoint, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', client_id: this.#options.clientId, refresh_token: credential.refreshToken }) }, context.signal);
    return parseOAuthToken(value, this.id, credential.refreshToken);
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
    if (method !== 'oauth-device') throw new ForgeError('ConfigurationError', `${this.displayName} does not support ${method}.`);
    const response = await requestJson(this.#options.fetch ?? fetch, `${this.#options.oauthHost}/api/oauth/device_authorization`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.#options.clientId }) }, context.signal);
    const deviceCode = typeof response.device_code === 'string' ? response.device_code : undefined;
    const userCode = typeof response.user_code === 'string' ? response.user_code : undefined;
    const verificationUri = typeof response.verification_uri === 'string' ? response.verification_uri : undefined;
    const verificationUriComplete = typeof response.verification_uri_complete === 'string' ? response.verification_uri_complete : undefined;
    if (!deviceCode || !userCode || !verificationUri || !verificationUriComplete) throw new ForgeError('AuthenticationError', 'Kimi device authentication response was invalid.');
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
    if (credential.provider !== this.id || !credential.refreshToken) throw new ForgeError('AuthenticationError', 'No refresh token is available.');
    const value = await requestJson(this.#options.fetch ?? fetch, `${this.#options.oauthHost}/api/oauth/token`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.#options.clientId, grant_type: 'refresh_token', refresh_token: credential.refreshToken }) }, context.signal);
    return parseOAuthToken(value, this.id, credential.refreshToken);
  }
  async logout(): Promise<void> {}
  async status(credential: Credential | undefined): Promise<AuthStatus> { return authStatus(credential, this.id, 'oauth-device'); }
}
