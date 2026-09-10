import { AnthropicAuthProvider, GoogleGeminiAuthProvider, KimiCodeAuthProvider, MarsError, OpenAICodexAuthProvider, migrateFileCredentials, openBrowser, resolveAuthCredential } from '../../../../packages/sdk/src/internal.js';
import type { AuthContext, AuthProvider, CredentialStore } from '../../../../packages/sdk/src/internal.js';
import { providerAuthCatalog } from '../../../../packages/auth/src/index.js';
import { prompt, safe } from '../utils/common.js';
export function authProvider(id: string): AuthProvider | undefined {
  if (id === 'openai-codex') return new OpenAICodexAuthProvider();
  if (id === 'anthropic') return new AnthropicAuthProvider();
  if (id === 'kimi-code') return new KimiCodeAuthProvider();
  if (id === 'gemini') return new GoogleGeminiAuthProvider();
  return undefined;
}
export function authContext(signal: AbortSignal): AuthContext {
  return {
    signal,
    openUrl: async url => {
      process.stderr.write(`\nAbriendo el navegador para autenticar MARS…\n${safe(url)}\n`);
      try { await openBrowser(url); } catch { process.stderr.write('No se pudo abrir el navegador automáticamente; abre la URL anterior manualmente.\n'); }
    },
    notify: event => {
      if (event.type === 'auth-url') return;
      if (event.type === 'device-code') { process.stderr.write(`\nCódigo de dispositivo: ${safe(event.userCode)}\n${safe(event.verificationUriComplete ?? event.verificationUri)}\n`); return; }
      process.stderr.write(`${safe(event.message)}\n`);
    },
  };
}

export async function loginCommand(providerId: string | undefined, values: Record<string, unknown>, credentials: CredentialStore): Promise<void> {
  if (!providerId) {
    process.stdout.write('Connect provider\n\n');
    providerAuthCatalog.forEach((provider, index) => process.stdout.write(`${index + 1}. ${provider.name} (${provider.id})\n`));
    const choice = await prompt('Provider number or id: ', new AbortController().signal);
    const index = Number(choice.trim()) - 1;
    providerId = Number.isInteger(index) && providerAuthCatalog[index] ? providerAuthCatalog[index].id : choice.trim();
  }
  if (!providerId) throw new MarsError('ConfigurationError', 'Select a provider.');
  if (values['api-key'] === true) {
    if (!['openai', 'anthropic', 'kimi-code', 'gemini', 'qwen', 'openrouter'].includes(providerId)) throw new MarsError('ConfigurationError', 'OpenAI Codex usa login de navegador; selecciona un proveedor API para guardar una API key.');
    const labels: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', 'kimi-code': 'Kimi Code', gemini: 'Gemini', qwen: 'Qwen', openrouter: 'OpenRouter' };
    const secret = await prompt(`${labels[providerId]} API key (hidden): `, new AbortController().signal, true);
    await credentials.set({ provider: providerId, kind: 'api-key', secret });
    process.stdout.write(`${labels[providerId]} API key guardada en el almacén de credenciales de MARS.\n`);
    return;
  }
  if (providerId === 'anthropic') throw new MarsError('ConfigurationError', 'Anthropic no permite ofrecer login de claude.ai en productos de terceros sin aprobación previa; usa `mars login anthropic --api-key`.');
  if (providerId === 'kimi-code' && process.env.MARS_ENABLE_EXPERIMENTAL_SUBSCRIPTION_AUTH !== '1') {
    throw new MarsError('ConfigurationError', `El login de suscripción de ${providerId} es experimental y está desactivado. Usa un proveedor con API key o establece MARS_ENABLE_EXPERIMENTAL_SUBSCRIPTION_AUTH=1 para desarrollo.`);
  }
  if (providerId === 'openai' || providerId === 'qwen' || providerId === 'openrouter' || providerId === 'ollama') throw new MarsError('ConfigurationError', `${providerId} no ofrece login de navegador en MARS; usa su configuración local o --api-key.`);
  const provider = authProvider(providerId);
  if (!provider) throw new MarsError('ConfigurationError', `Unsupported authentication provider: ${providerId}.`);
  const method = providerId === 'kimi-code' ? 'oauth-device' : 'oauth-pkce';
  if (values.browser === false && providerId !== 'kimi-code') throw new MarsError('ConfigurationError', `${providerId} solo admite login OAuth de navegador.`);
  if (values.device === true && providerId !== 'kimi-code' && providerId !== 'openai-codex') throw new MarsError('ConfigurationError', `${providerId} no admite device code.`);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const credential = await provider.login(values.device === true ? 'oauth-device' : method, authContext(controller.signal));
    await credentials.set(credential);
    process.stdout.write(`${provider.displayName} conectado. La credencial queda disponible para futuras ejecuciones.\n`);
  } finally { process.off('SIGINT', cancel); }
}

export async function authCommand(positionals: string[], credentials: CredentialStore): Promise<void> {
  const action = positionals[1] ?? 'providers';
  if (action === 'providers' && positionals.length === 2) {
    process.stdout.write('MARS authentication providers\n\n');
    for (const provider of providerAuthCatalog) process.stdout.write(`${provider.name}\n  id: ${provider.id}\n  browser: ${provider.browser}\n  subscription: ${provider.subscription ? 'yes' : 'no'}\n  api key: ${provider.apiKey ? 'yes' : 'no'}\n\n`);
    return;
  }
  if (action === 'status' && positionals.length === 2) {
    const signal = new AbortController().signal;
    for (const entry of providerAuthCatalog) {
      const credential = await resolveAuthCredential(entry.id, { store: credentials, env: process.env });
      const provider = authProvider(entry.id);
      const status = entry.id === 'ollama' ? { authenticated: true, method: 'local' as const, message: 'No login required.' } : provider ? await provider.status(credential, authContext(signal)) : credential ? { authenticated: true, method: credential.kind === 'api-key' ? 'api-key' as const : 'local' as const } : { authenticated: false };
      process.stdout.write(`${entry.id}: ${status.authenticated ? 'connected' : 'not connected'}${status.method ? ` (${status.method})` : ''}${status.message ? ` — ${safe(status.message)}` : ''}\n`);
    }
    return;
  }
  if (action === 'logout' && positionals.length === 3) {
    const providerId = positionals[2]!;
    const credential = await credentials.get(providerId);
    const provider = authProvider(providerId);
    if (credential && provider) await provider.logout(credential, authContext(new AbortController().signal));
    await credentials.delete(providerId);
    process.stdout.write(`${providerId}: disconnected.\n`);
    return;
  }
  if (action === 'migrate' && positionals.length === 2) {
    const providers = await migrateFileCredentials();
    process.stdout.write(providers.length ? `Migrated to the native keychain: ${providers.join(', ')}.\n` : 'No file credentials found.\n');
    return;
  }
  throw new MarsError('ConfigurationError', 'Use auth providers, auth status, auth logout PROVIDER or auth migrate.');
}

export async function authenticatedProviders(credentials: CredentialStore): Promise<string[]> {
  const ids = ['openai', 'openai-codex', 'anthropic', 'kimi-code', 'gemini', 'qwen', 'openrouter'];
  const connected: string[] = [];
  for (const id of ids) if (await resolveAuthCredential(id, { store: credentials, env: process.env })) connected.push(id);
  return connected;
}
