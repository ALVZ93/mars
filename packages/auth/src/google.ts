import { BrowserOAuthProvider } from './oauth.js';
import { ForgeError } from '../../core/src/index.js';
import type { AuthContext, AuthMethod, AuthProvider, AuthStatus, Credential, OAuthCredential } from './index.js';

/** Google Cloud OAuth for a user's own Gemini API project (not the consumer Gemini subscription). */
export class GoogleGeminiAuthProvider implements AuthProvider {
  readonly id = 'gemini';
  readonly displayName = 'Google Gemini API';
  #provider?: BrowserOAuthProvider;
  #getProvider(): BrowserOAuthProvider {
    if (this.#provider) return this.#provider;
    const clientId = process.env.MARS_GEMINI_CLIENT_ID;
    if (!clientId) throw new ForgeError('ConfigurationError', 'Set MARS_GEMINI_CLIENT_ID to use Google Cloud browser login.');
    this.#provider = new BrowserOAuthProvider({
      provider: this.id,
      displayName: this.displayName,
      clientId,
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      clientSecret: process.env.MARS_GEMINI_CLIENT_SECRET,
      authorizationParams: { access_type: 'offline', prompt: 'consent' },
    });
    return this.#provider;
  }
  methods(): readonly AuthMethod[] { return ['oauth-pkce']; }
  async login(method: AuthMethod, context: AuthContext): Promise<OAuthCredential> {
    if (method !== 'oauth-pkce') throw new ForgeError('ConfigurationError', `${this.displayName} does not support ${method}.`);
    const credential = await this.#getProvider().login(method, context) as OAuthCredential;
    const projectId = process.env.GOOGLE_CLOUD_PROJECT;
    return projectId ? { ...credential, metadata: { projectId } } : credential;
  }
  async refresh(credential: OAuthCredential, context: AuthContext): Promise<OAuthCredential> {
    const refreshed = await this.#getProvider().refresh(credential, context);
    return credential.metadata ? { ...refreshed, metadata: credential.metadata } : refreshed;
  }
  async logout(credential: Credential, context: AuthContext): Promise<void> { return this.#getProvider().logout(credential, context); }
  async status(credential: Credential | undefined, context: AuthContext): Promise<AuthStatus> {
    if (!credential) return { authenticated: false, message: process.env.MARS_GEMINI_CLIENT_ID ? 'Not connected.' : 'Set MARS_GEMINI_CLIENT_ID for browser login.' };
    if (credential.kind === 'api-key') return { authenticated: true, method: 'api-key' };
    return this.#getProvider().status(credential);
  }
}
