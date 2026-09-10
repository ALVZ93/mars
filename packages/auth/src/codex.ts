import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { ForgeError, checkAbort } from '../../core/src/index.js';
import type { AuthContext, AuthMethod, AuthProvider, AuthStatus, Credential, ExternalCredential } from './index.js';

const require = createRequire(import.meta.url);

function codexScript(): string {
  try { return require.resolve('@openai/codex/bin/codex.js'); }
  catch { throw new ForgeError('ConfigurationError', 'The bundled Codex runtime is unavailable. Reinstall MARS with optional platform dependencies enabled.'); }
}

async function runCodex(args: string[], signal: AbortSignal, inherit = false): Promise<{ code: number; output: string }> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [codexScript(), ...args], {
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    if (!inherit) {
      child.stdout?.on('data', chunk => { output += String(chunk); });
      child.stderr?.on('data', chunk => { output += String(chunk); });
    }
    const abort = () => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', error => {
      signal.removeEventListener('abort', abort);
      reject(new ForgeError('ConfigurationError', `Could not start the bundled Codex runtime: ${error.message}`));
    });
    child.once('exit', code => {
      signal.removeEventListener('abort', abort);
      try { checkAbort(signal); }
      catch (error) { reject(error); return; }
      resolve({ code: code ?? 1, output: output.trim() });
    });
  });
}

export interface OpenAICodexAuthOptions {
  run?: (args: string[], signal: AbortSignal, inherit: boolean) => Promise<{ code: number; output: string }>;
}

export class OpenAICodexAuthProvider implements AuthProvider {
  readonly id = 'openai-codex';
  readonly displayName = 'OpenAI Codex (ChatGPT subscription)';
  readonly #run: NonNullable<OpenAICodexAuthOptions['run']>;
  constructor(options: OpenAICodexAuthOptions = {}) { this.#run = options.run ?? runCodex; }
  methods(): readonly AuthMethod[] { return ['oauth-pkce', 'oauth-device']; }

  async login(method: AuthMethod, context: AuthContext): Promise<ExternalCredential> {
    if (method !== 'oauth-pkce' && method !== 'oauth-device') throw new ForgeError('ConfigurationError', 'OpenAI Codex supports browser or device-code login.');
    context.notify?.({ type: 'progress', message: 'Codex gestiona el acceso con tu suscripción de ChatGPT.' });
    let status = await this.status(undefined, context);
    if (!status.authenticated) {
      const result = await this.#run(['login', ...(method === 'oauth-device' ? ['--device-auth'] : [])], context.signal, true);
      if (result.code !== 0) throw new ForgeError('AuthenticationError', 'Codex login did not complete successfully.');
      status = await this.status(undefined, context);
    }
    if (!status.authenticated) throw new ForgeError('AuthenticationError', 'Codex did not report an authenticated ChatGPT session.');
    return { provider: this.id, kind: 'external', source: 'codex-cli' };
  }

  async logout(_credential: Credential, context: AuthContext): Promise<void> {
    const result = await this.#run(['logout'], context.signal, true);
    if (result.code !== 0) throw new ForgeError('AuthenticationError', 'Codex logout did not complete successfully.');
  }

  async status(_credential: Credential | undefined, context: AuthContext): Promise<AuthStatus> {
    const result = await this.#run(['login', 'status'], context.signal, false);
    return {
      authenticated: result.code === 0,
      ...(result.code === 0 ? { method: 'oauth-pkce' as const } : {}),
      message: result.output || (result.code === 0 ? 'ChatGPT subscription managed by Codex.' : 'Run mars login openai-codex.'),
    };
  }
}
