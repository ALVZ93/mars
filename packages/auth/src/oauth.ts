import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';
import { ForgeError } from '../../core/src/index.js';
import type { AuthContext, AuthMethod, AuthProvider, AuthStatus, Credential, OAuthCredential } from './index.js';

export interface BrowserOAuthConfig {
  provider: string;
  displayName: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
  clientSecret?: string;
  authorizationParams?: Record<string, string>;
  tokenParams?: Record<string, string>;
  revokeEndpoint?: string;
  callbackPath?: string;
  timeoutMs?: number;
}

const asBase64Url = (value: Buffer): string => value.toString('base64url');
const expiry = (value: unknown): number | undefined => {
  const seconds = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Date.now() + Math.floor(seconds * 1000) - 30_000 : undefined;
};
const safeEndpoint = (value: string): URL => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error();
    return url;
  } catch { throw new ForgeError('ConfigurationError', 'OAuth endpoint must use HTTPS.'); }
};

export class BrowserOAuthProvider implements AuthProvider {
  readonly id: string;
  readonly displayName: string;
  readonly #config: BrowserOAuthConfig;
  constructor(config: BrowserOAuthConfig) {
    safeEndpoint(config.authorizationEndpoint);
    safeEndpoint(config.tokenEndpoint);
    if (config.revokeEndpoint) safeEndpoint(config.revokeEndpoint);
    if (!config.provider || !config.clientId || !config.scopes.length) throw new ForgeError('ConfigurationError', 'OAuth provider configuration is incomplete.');
    this.#config = { ...config, callbackPath: config.callbackPath ?? '/oauth/callback', timeoutMs: config.timeoutMs ?? 120_000 };
    this.id = config.provider;
    this.displayName = config.displayName;
  }
  methods(): readonly AuthMethod[] { return ['oauth-pkce']; }
  async login(method: AuthMethod, context: AuthContext): Promise<OAuthCredential> {
    if (method !== 'oauth-pkce') throw new ForgeError('ConfigurationError', `${this.displayName} does not support ${method}.`);
    const verifier = asBase64Url(randomBytes(48));
    const challenge = asBase64Url(createHash('sha256').update(verifier).digest());
    const state = asBase64Url(randomBytes(32));
    const server = createServer();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let finish!: (value: { code: string } | Error) => void;
    const callback = new Promise<{ code: string }>((resolve, reject) => {
      finish = result => {
        if (settled) return;
        settled = true;
        if (result instanceof Error) reject(result); else resolve(result);
        server.close();
      };
    });
    // The browser can hit the callback before openUrl() resolves; attach a
    // handler immediately so an early rejected callback is never unhandled.
    void callback.catch(() => {});
    server.on('request', (request, response) => {
      try {
        const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (requestUrl.pathname !== this.#config.callbackPath) { response.writeHead(404).end(); return; }
        if (requestUrl.searchParams.get('state') !== state) { response.writeHead(400).end('Invalid OAuth state.'); finish(new ForgeError('AuthenticationError', 'OAuth state validation failed.')); return; }
        const providerError = requestUrl.searchParams.get('error');
        if (providerError) { response.writeHead(400).end('MARS login was denied.'); finish(new ForgeError('AuthenticationError', 'OAuth authorization was denied.')); return; }
        const code = requestUrl.searchParams.get('code');
        if (!code) { response.writeHead(400).end('Missing authorization code.'); finish(new ForgeError('AuthenticationError', 'OAuth response did not contain an authorization code.')); return; }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<p>MARS login complete. You can close this window.</p>');
        finish({ code });
      } catch { response.writeHead(400).end('Invalid OAuth callback.'); finish(new ForgeError('AuthenticationError', 'Invalid OAuth callback.')); }
    });
    const abort = () => finish(new ForgeError(context.signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'CancelledError', 'OAuth login cancelled.'));
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new ForgeError('ConfigurationError', 'Could not allocate a local OAuth callback.');
      const redirectUri = `http://127.0.0.1:${address.port}${this.#config.callbackPath}`;
      const authorization = safeEndpoint(this.#config.authorizationEndpoint);
      authorization.search = new URLSearchParams({
        response_type: 'code', client_id: this.#config.clientId, redirect_uri: redirectUri,
        scope: this.#config.scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256',
        ...this.#config.authorizationParams,
      }).toString();
      await context.openUrl(authorization.toString());
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ForgeError('TimeoutError', 'OAuth login timed out.')), this.#config.timeoutMs); });
      const result = await Promise.race([callback, timeout]);
      return await exchangeCode(this.#config, result.code, verifier, redirectUri, context.signal);
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      throw new ForgeError('AuthenticationError', 'OAuth login failed.');
    } finally {
      if (timer) clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      if (!settled) finish(new ForgeError('CancelledError', 'OAuth login cancelled.'));
      server.close();
    }
  }
  async refresh(credential: OAuthCredential, context: AuthContext): Promise<OAuthCredential> {
    if (credential.provider !== this.id || credential.kind !== 'oauth' || !credential.refreshToken) throw new ForgeError('AuthenticationError', 'No refresh token is available.');
    const endpoint = safeEndpoint(this.#config.tokenEndpoint);
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: this.#config.clientId, refresh_token: credential.refreshToken, ...this.#config.tokenParams });
    if (this.#config.clientSecret) body.set('client_secret', this.#config.clientSecret);
    return parseToken(await fetchToken(endpoint, body, context.signal), this.id, credential.refreshToken);
  }
  async logout(credential: Credential, context: AuthContext): Promise<void> {
    if (!this.#config.revokeEndpoint || credential.provider !== this.id || credential.kind !== 'oauth') return;
    const body = new URLSearchParams({ token: credential.refreshToken ?? credential.accessToken, client_id: this.#config.clientId });
    await fetchToken(safeEndpoint(this.#config.revokeEndpoint), body, context.signal).catch(() => {});
  }
  async status(credential: Credential | undefined): Promise<AuthStatus> {
    if (!credential || credential.provider !== this.id) return { authenticated: false, message: 'Not connected.' };
    if (credential.kind !== 'oauth') return { authenticated: true, method: 'api-key' };
    if (credential.expiresAt && credential.expiresAt <= Date.now()) return { authenticated: false, method: 'oauth-pkce', expiresAt: credential.expiresAt, message: 'Access token expired.' };
    return { authenticated: true, method: 'oauth-pkce', expiresAt: credential.expiresAt };
  }
}

async function exchangeCode(config: BrowserOAuthConfig, code: string, verifier: string, redirectUri: string, signal: AbortSignal): Promise<OAuthCredential> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId, code, redirect_uri: redirectUri, code_verifier: verifier, ...config.tokenParams });
  if (config.clientSecret) body.set('client_secret', config.clientSecret);
  return parseToken(await fetchToken(safeEndpoint(config.tokenEndpoint), body, signal), config.provider);
}
async function fetchToken(endpoint: URL, body: URLSearchParams, signal: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response;
  try { response = await fetch(endpoint, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body, signal }); }
  catch { throw new ForgeError('AuthenticationError', 'OAuth token request failed.'); }
  if (!response.ok) throw new ForgeError('AuthenticationError', 'OAuth token request was rejected.');
  try {
    const json: unknown = await response.json();
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error();
    return json as Record<string, unknown>;
  } catch { throw new ForgeError('AuthenticationError', 'OAuth token response was invalid.'); }
}
function parseToken(value: Record<string, unknown>, provider: string, fallbackRefresh?: string): OAuthCredential {
  if (typeof value.access_token !== 'string' || !value.access_token) throw new ForgeError('AuthenticationError', 'OAuth response did not contain an access token.');
  const refreshToken = typeof value.refresh_token === 'string' && value.refresh_token ? value.refresh_token : fallbackRefresh;
  const expiresAt = expiry(value.expires_in);
  return {
    provider, kind: 'oauth', accessToken: value.access_token, ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(typeof value.token_type === 'string' ? { tokenType: value.token_type } : {}),
    ...(typeof value.scope === 'string' ? { scope: value.scope.split(' ').filter(Boolean) } : {}),
  };
}

export function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', () => reject(new ForgeError('ConfigurationError', 'Could not open the default browser.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
