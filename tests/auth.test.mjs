import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MemoryCredentialStore, KeychainCredentialStore, resolveCredential, BrowserOAuthProvider, AuthRegistry, createCredentialStore } from '../dist/packages/auth/src/index.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('credential store factory supports an explicit file fallback', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mars-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createCredentialStore({ mode: 'file', filePath: path.join(root, 'auth.json') });
  await store.set({ provider: 'openai', kind: 'api-key', secret: 'private-secret' });
  assert.equal((await store.get('openai')).secret, 'private-secret');
  const raw = await readFile(path.join(root, 'auth.json'), 'utf8');
  assert.match(raw, /private-secret/);
});

test('keychain credential adapter keeps the same store contract', async () => {
  const values = new Map();
  const keytar = {
    async getPassword(service, account) { return values.get(`${service}:${account}`) ?? null; },
    async setPassword(service, account, password) { values.set(`${service}:${account}`, password); },
    async deletePassword(service, account) { return values.delete(`${service}:${account}`); },
  };
  const store = new KeychainCredentialStore('mars-test', keytar);
  await store.set({ provider: 'openai', kind: 'api-key', secret: 'keychain-secret' });
  assert.deepEqual(await store.get('openai'), { provider: 'openai', kind: 'api-key', secret: 'keychain-secret' });
  await store.delete('openai');
  assert.equal(await store.get('openai'), undefined);
});

test('credential resolution: explicit > store > environment > unauthenticated', async () => {
  const store = new MemoryCredentialStore();
  assert.equal(await resolveCredential('openai', { env: {} }), undefined);
  assert.equal((await resolveCredential('openai', { env: { OPENAI_API_KEY: 'env' } })).secret, 'env');
  await store.set({ provider: 'openai', kind: 'api-key', secret: 'stored' });
  const options = { store, env: { OPENAI_API_KEY: 'env' } };
  assert.equal((await resolveCredential('openai', options)).secret, 'stored');
  assert.equal((await resolveCredential('openai', { ...options, explicit: { provider: 'openai', kind: 'api-key', secret: 'explicit' } })).secret, 'explicit');
  const copy = await store.get('openai'); copy.secret = 'mutated';
  assert.equal((await store.get('openai')).secret, 'stored');
  await store.delete('openai');
  assert.equal(await store.get('openai'), undefined);
});
test('mismatched and empty credentials are rejected without leaking their values', async () => {
  for (const credential of [{ provider: 'other', kind: 'api-key', secret: 'PRIVATE' }, { provider: 'openai', kind: 'api-key', secret: ' ' }]) {
    await assert.rejects(resolveCredential('openai', { explicit: credential, env: {} }), error => error.code === 'AuthenticationError' && !error.message.includes('PRIVATE'));
  }
});

test('browser OAuth uses PKCE, validates state, and returns a refreshable credential', async t => {
  let tokenRequest;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/token') {
      let body = '';
      for await (const chunk of request) body += chunk;
      tokenRequest = new URLSearchParams(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600, token_type: 'Bearer', scope: 'model:read model:tools' }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const provider = new BrowserOAuthProvider({ provider: 'oauth-test', displayName: 'OAuth Test', clientId: 'mars-client', authorizationEndpoint: `${base}/authorize`, tokenEndpoint: `${base}/token`, scopes: ['model:read', 'model:tools'] });
  const openUrl = async authUrl => {
    const authorization = new URL(authUrl);
    assert.equal(authorization.searchParams.get('client_id'), 'mars-client');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.match(authorization.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    const callback = new URL(authorization.searchParams.get('redirect_uri'));
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set('state', authorization.searchParams.get('state'));
    await fetch(callback);
  };
  const credential = await provider.login('oauth-pkce', { signal: new AbortController().signal, openUrl });
  assert.equal(credential.accessToken, 'access-secret');
  assert.equal(credential.refreshToken, 'refresh-secret');
  assert.deepEqual(credential.scope, ['model:read', 'model:tools']);
  assert.equal(tokenRequest.get('grant_type'), 'authorization_code');
  assert.equal(tokenRequest.get('code'), 'auth-code');
  assert.equal(tokenRequest.get('client_id'), 'mars-client');
  assert.match(tokenRequest.get('code_verifier'), /^[A-Za-z0-9_-]{64}$/);
  const refreshed = await provider.refresh(credential, { signal: new AbortController().signal, openUrl });
  assert.equal(refreshed.accessToken, 'access-secret');
  assert.equal((await provider.status(refreshed)).authenticated, true);
});

test('browser OAuth rejects a wrong state and never accepts arbitrary callback parameters', async t => {
  const server = createServer((_request, response) => response.writeHead(404).end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const provider = new BrowserOAuthProvider({ provider: 'oauth-test', displayName: 'OAuth Test', clientId: 'mars-client', authorizationEndpoint: `http://127.0.0.1:${address.port}/authorize`, tokenEndpoint: `http://127.0.0.1:${address.port}/token`, scopes: ['model:read'], timeoutMs: 1000 });
  await assert.rejects(provider.login('oauth-pkce', { signal: new AbortController().signal, openUrl: async authUrl => {
    const authorization = new URL(authUrl);
    const callback = new URL(authorization.searchParams.get('redirect_uri'));
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set('state', 'attacker-state');
    await fetch(callback);
  } }), { code: 'AuthenticationError' });
});

test('auth registry refuses duplicate IDs and exposes provider capabilities', () => {
  const registry = new AuthRegistry();
  const provider = { id: 'test', displayName: 'Test', methods: () => ['oauth-pkce'], login: async () => ({ provider: 'test', kind: 'oauth', accessToken: 'x' }), logout: async () => {}, status: async () => ({ authenticated: false }) };
  registry.register(provider);
  assert.equal(registry.get('test'), provider);
  assert.deepEqual(registry.list(), [provider]);
  assert.throws(() => registry.register(provider), { code: 'ConfigurationError' });
});
