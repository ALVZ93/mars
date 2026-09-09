# Forge — Agent Harness CLI
## Handoff técnico para Codex

> Estado: diseño inicial / greenfield  
> Objetivo inmediato: construir un agent harness CLI funcional, multi-provider, extensible y cross-platform.  
> Plataforma inicial: Windows, sin comprometer compatibilidad con macOS/Linux.  
> Runtime: TypeScript + Node.js.  
> Package manager recomendado: pnpm.  
> Distribución inicial: npm registry (`npm`, `pnpm dlx`, `npx`).  
> UI inicial: terminal/CLI.  
> Desktop: fase posterior, consumiendo el mismo core/SDK.

---

# 1. Visión

Forge debe ser un **agent harness independiente del modelo**.

No se pretende construir otro modelo de IA ni un simple wrapper de APIs. El producto debe ser una capa de runtime capaz de:

- autenticar distintos proveedores/modelos;
- ejecutar un agent loop;
- exponer herramientas al modelo;
- gestionar contexto y sesiones;
- aplicar reglas y permisos mediante código;
- permitir skills, hooks y extensiones;
- soportar múltiples modelos/proveedores;
- enrutar tareas entre modelos;
- verificar resultados;
- evolucionar hacia workflows reutilizables y aprendizaje basado en evidencia;
- reutilizar, cuando sea posible y esté soportado oficialmente, suscripciones ya existentes del usuario (p. ej. Codex/ChatGPT, Claude, Copilot, OpenRouter) además de API keys;
- funcionar desde terminal como producto principal;
- exponer un SDK para que futuras interfaces —especialmente desktop— usen exactamente el mismo runtime.

La propuesta de valor a medio plazo no debe ser:

> "Otro Claude Code / Codex."

Debe evolucionar hacia:

> "Un harness que unifica modelos, proveedores, suscripciones, tools y workflows, y usa cada recurso donde sea más eficiente."

---

# 2. Principios de arquitectura

## 2.1. El core no conoce la interfaz

Regla:

> `core` nunca debe saber que existe una terminal.

La CLI será un consumidor del SDK/core.

La futura desktop app será otro consumidor.

No introducir lógica de negocio en comandos CLI ni componentes de UI.

---

## 2.2. El core no conoce proveedores concretos

Regla:

> `core` nunca debe depender directamente de OpenAI, Anthropic, Google, OpenRouter, Ollama, etc.

Debe depender de interfaces internas.

Ejemplo conceptual:

```ts
interface ModelProvider {
  id: string;

  listModels(ctx: ProviderContext): Promise<ModelDescriptor[]>;

  stream(
    request: ModelRequest,
    ctx: ProviderContext
  ): AsyncIterable<ModelEvent>;
}
```

Cada proveedor implementa esa interfaz.

---

## 2.3. Separar decisión cognitiva de ejecución mecánica

El modelo:

- interpreta;
- razona;
- decide qué tool usar;
- formula argumentos;
- propone siguiente acción.

El harness:

- valida;
- aplica permisos;
- ejecuta;
- captura output;
- devuelve observaciones;
- gestiona estado;
- decide si el workflow puede terminar;
- verifica invariantes;
- controla retries/timeouts/cancelación.

Nunca depender exclusivamente de prompts para reglas importantes.

Ejemplo:

Incorrecto:

```text
"Por favor no ejecutes comandos destructivos."
```

Correcto:

```ts
if (policy.isDestructive(call)) {
  throw new PermissionDeniedError();
}
```

---

## 2.4. Extensibilidad antes que features monolíticas

Regla:

> Si una funcionalidad puede vivir como extensión, no debe entrar en `core`.

El core debe ser pequeño.

Skills, verificadores, workflows, tool packs y routing avanzado deben poder añadirse sin modificar el agent loop fundamental.

---

## 2.5. CLI-first

Priorizar:

1. runtime fiable;
2. tools;
3. auth;
4. sesiones;
5. permisos;
6. routing;
7. observabilidad;
8. UX terminal.

No invertir demasiado pronto en:

- animaciones;
- paneles complejos;
- mouse support;
- TUI sofisticada;
- desktop;
- visualizadores de tokens;
- temas avanzados.

---

# 3. Arquitectura propuesta

Usar monorepo pnpm.

```text
forge/
├─ apps/
│  └─ cli/
│
├─ packages/
│  ├─ core/
│  │  ├─ src/
│  │  │  ├─ agent/
│  │  │  ├─ loop/
│  │  │  ├─ events/
│  │  │  ├─ messages/
│  │  │  └─ types/
│  │
│  ├─ providers/
│  │  ├─ openai/
│  │  ├─ anthropic/
│  │  ├─ google/
│  │  ├─ openrouter/
│  │  └─ ollama/
│  │
│  ├─ auth/
│  │  ├─ src/
│  │  │  ├─ registry/
│  │  │  ├─ oauth/
│  │  │  ├─ api-key/
│  │  │  ├─ credential-store/
│  │  │  └─ types/
│  │
│  ├─ tools/
│  │  ├─ filesystem/
│  │  ├─ shell/
│  │  ├─ search/
│  │  └─ git/
│  │
│  ├─ runtime/
│  │  ├─ context/
│  │  ├─ sessions/
│  │  ├─ permissions/
│  │  ├─ platform/
│  │  ├─ skills/
│  │  └─ extensions/
│  │
│  ├─ routing/
│  │  ├─ registry/
│  │  ├─ scorer/
│  │  └─ router/
│  │
│  ├─ workflows/
│  │  ├─ bugfix/
│  │  ├─ feature/
│  │  ├─ review/
│  │  └─ verifier/
│  │
│  └─ sdk/
│
├─ examples/
├─ docs/
├─ pnpm-workspace.yaml
├─ package.json
├─ tsconfig.base.json
└─ README.md
```

No es obligatorio crear todos los paquetes en el primer commit. Evitar scaffolding vacío excesivo.

Primera implementación mínima:

```text
packages/core
packages/auth
packages/providers
packages/tools
packages/runtime
packages/sdk
apps/cli
```

---

# 4. Modelo mental del runtime

```text
Usuario
  ↓
CLI
  ↓
SDK
  ↓
Agent Runtime
  │
  ├─ Context Builder
  ├─ Session
  ├─ Model Router
  ├─ Tool Registry
  ├─ Permission Engine
  └─ Event Bus
  ↓
Provider
  ↓
Modelo
  ↓
tool_call
  ↓
Runtime valida
  ↓
Tool Executor
  ↓
observation
  ↓
Modelo
  ↓
...
  ↓
respuesta final
```

---

# 5. Agent loop v0

El primer loop debe ser deliberadamente pequeño.

Conceptualmente:

```ts
while (!done) {
  const response = await provider.stream({
    model,
    messages,
    tools: toolRegistry.schemas()
  });

  messages.push(response.message);

  if (response.toolCalls.length === 0) {
    return response.message;
  }

  for (const call of response.toolCalls) {
    const validated = toolRegistry.validate(call);

    await permissions.check(validated);

    const result = await toolRegistry.execute(validated);

    messages.push(
      createToolResultMessage(call.id, result)
    );
  }
}
```

Necesidades reales desde muy pronto:

- streaming;
- abort signal;
- max turns;
- max tool calls;
- timeouts;
- output truncation;
- structured errors;
- tool validation;
- tool-call correlation ids;
- event emission;
- retry policy;
- provider errors normalizados.

---

# 6. Modelo interno de mensajes

No usar directamente estructuras propietarias de cada proveedor dentro del runtime.

Crear un IR común.

Ejemplo:

```ts
type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | SystemMessage;

interface AssistantMessage {
  role: "assistant";
  content: ContentPart[];
  toolCalls?: ToolCall[];
}

interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}
```

Cada adapter transforma:

```text
Forge IR
↔
OpenAI format
↔
Anthropic format
↔
Google format
↔
OpenRouter format
```

Esto es obligatorio para evitar provider leakage.

---

# 7. Tool system

Crear una abstracción genérica.

```ts
interface Tool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  schema: JsonSchema;

  execute(
    input: TInput,
    ctx: ToolExecutionContext
  ): Promise<TOutput>;
}
```

## Tools iniciales

### read

```text
read_file(path)
```

### write

```text
write_file(path, content)
```

### search

```text
search_files(query, path?)
```

### shell

```text
shell(command, cwd?, timeout?)
```

### git

Inicialmente puede apoyarse en shell, pero debe existir una capa propia más adelante para operaciones sensibles.

---

# 8. Shell cross-platform

No diseñar la API como `bash()`.

Diseñar:

```ts
shell.execute({
  command,
  cwd,
  timeout,
  env
})
```

El platform layer resuelve el executor.

Windows:

- PowerShell;
- `cmd` si es necesario;
- Git Bash solo si el usuario lo configura.

macOS/Linux:

- `bash`;
- `zsh`;
- shell configurado del usuario cuando proceda.

Evitar asumir sintaxis POSIX dentro del core.

Crear:

```text
packages/runtime/src/platform/
├─ shell.ts
├─ filesystem.ts
├─ paths.ts
├─ process.ts
└─ os.ts
```

---

# 9. Auth: requisito central

Forge debe soportar dos familias de autenticación:

## 9.1. Subscription / browser auth

UX objetivo:

```text
forge login
```

o desde modo interactivo:

```text
/login
```

Mostrar:

```text
Connect provider

> OpenAI Codex
  Claude
  GitHub Copilot
  OpenRouter
  Google
  API key
```

Cuando el proveedor soporte oficialmente un flujo de cliente externo:

```text
Forge CLI
  ↓
genera state + PKCE
  ↓
abre navegador
  ↓
login proveedor
  ↓
consentimiento
  ↓
localhost callback / device flow
  ↓
authorization code
  ↓
token exchange
  ↓
access token + refresh token
  ↓
secure credential store
```

Requisitos:

- OAuth PKCE para native clients cuando proceda;
- state validation;
- short-lived localhost callback server;
- device code flow como fallback donde tenga sentido;
- token refresh;
- logout;
- status;
- token expiration handling;
- nunca imprimir tokens completos.

IMPORTANTE:

No asumir que un flujo usado por Pi, Codex, Claude Code u otro cliente puede ser reutilizado legal/técnicamente por Forge.

Cada provider debe implementar únicamente métodos soportados/permitidos oficialmente para apps de terceros.

Si subscription OAuth no está disponible oficialmente:

- fallback a API key;
- explicar claramente al usuario;
- no copiar client IDs, secrets o tokens de otros productos.

---

## 9.2. API key / environment

Soportar:

```text
forge login openai --api-key
```

y variables de entorno:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
GOOGLE_API_KEY
OPENROUTER_API_KEY
```

Prioridad sugerida:

1. explicit current-session credential;
2. secure credential store;
3. environment;
4. config reference;
5. unauthenticated.

---

# 10. Credential storage

Nunca guardar secretos directamente en:

```text
~/.forge/config.json
```

Preferir secure storage por SO.

Objetivo:

Windows:

```text
Credential Manager
```

macOS:

```text
Keychain
```

Linux:

```text
Secret Service / libsecret / keyring
```

Puede usarse una librería Node madura que abstraiga keychain/keyring si es estable y mantenida.

Fallback temporal solo para desarrollo:

```text
~/.forge/dev-auth.json
```

pero:

- debe estar claramente marcado como inseguro;
- nunca debe ser el default;
- nunca subirlo a git;
- no usarlo en release.

Config solo guarda referencias:

```json
{
  "providers": {
    "openai": {
      "credential": "keychain://forge/openai/default"
    }
  }
}
```

---

# 11. Auth provider abstraction

Ejemplo:

```ts
type AuthMethod =
  | "oauth-pkce"
  | "oauth-device"
  | "api-key"
  | "environment"
  | "local";

interface AuthProvider {
  id: string;

  methods(): AuthMethod[];

  login(
    method: AuthMethod,
    ctx: AuthContext
  ): Promise<Credential>;

  refresh?(
    credential: Credential,
    ctx: AuthContext
  ): Promise<Credential>;

  logout(
    credential: Credential,
    ctx: AuthContext
  ): Promise<void>;

  status(
    credential: Credential | null,
    ctx: AuthContext
  ): Promise<AuthStatus>;
}
```

El provider de modelos nunca debe manipular directamente el keychain.

Debe recibir un credential resuelto.

---

# 12. Provider + model identity

Nunca identificar un modelo solo por nombre.

Usar:

```text
provider:model
```

Ejemplos conceptuales:

```text
openai:gpt-x
anthropic:claude-x
google:gemini-x
openrouter:anthropic/claude-x
ollama:qwen-x
```

Porque el mismo modelo lógico puede existir:

- directamente;
- vía agregador;
- con distinto coste;
- distinta latencia;
- distintos límites;
- distinta auth;
- distintas capabilities.

---

# 13. Model registry

Crear una estructura normalizada.

```ts
interface ModelDescriptor {
  id: string;
  provider: string;
  model: string;

  capabilities: {
    tools: boolean;
    vision: boolean;
    reasoning: boolean;
    structuredOutput: boolean;
    streaming: boolean;
  };

  contextWindow?: number;

  pricing?: {
    inputPerMillion?: number;
    outputPerMillion?: number;
  };

  metadata?: Record<string, unknown>;
}
```

No hardcodear demasiado pronto rankings subjetivos tipo:

```text
Claude = coding
GPT = reasoning
Gemini = research
```

Ese tipo de preferencias debe vivir en:

- config;
- benchmarks;
- historical performance;
- user overrides;
- routing policies.

---

# 14. Routing multi-modelo

Objetivo a medio plazo:

```text
Task
  ↓
requirements extraction
  ↓
candidate models
  ↓
hard filters
  ↓
score
  ↓
selected model
```

## Hard filters

Ejemplos:

- necesita tools;
- necesita vision;
- contexto mínimo;
- provider autenticado;
- presupuesto;
- provider permitido;
- local-only;
- latency class.

## Soft scoring

Más adelante:

```text
score =
  qualityWeight
+ successHistory
+ taskAffinity
- costPenalty
- latencyPenalty
```

No hacer routing con un LLM como única decisión.

Puede existir un router LLM, pero debe operar sobre candidatos filtrados y datos estructurados.

---

# 15. Multi-orquestación

Los modelos no deben "hablar directamente".

El harness actúa como intermediario.

Ejemplo:

```text
Task
  ↓
Planner model
  ↓
Harness
  ↓
Implementation model
  ↓
Harness
  ↓
Verifier model
  ↓
Harness
  ↓
Tests
```

Cada paso produce artifacts/resultados normalizados.

Ejemplo de pipeline futuro:

```text
plan
  → implement
  → test
  → independent review
  → revise if needed
  → final verification
```

Debe ser posible elegir:

- mismo modelo;
- modelos distintos;
- modelo barato para routing;
- modelo fuerte para implementación;
- modelo independiente para review.

---

# 16. Permisos

No confiar solo en prompts.

Crear `PermissionEngine`.

Categorías mínimas:

```text
filesystem.read
filesystem.write
filesystem.writeOutsideWorkspace
shell.execute
shell.destructive
network.access
git.commit
git.push
credentials.read
```

Políticas:

```text
allow
ask
deny
```

Defaults iniciales recomendados:

```text
read project              allow
write project             allow
write outside project     ask
network                    ask
git commit                 ask/allow configurable
git push                   ask
destructive shell          deny
credentials                deny
```

Definir detección de comandos destructivos como sistema extensible, no simple búsqueda de substring.

---

# 17. Workspace boundary

El agente necesita un workspace explícito.

Al lanzar:

```bash
forge
```

el cwd se convierte inicialmente en root del workspace.

Resolver:

- symlinks;
- path traversal;
- `..`;
- absolute paths;
- Windows drive boundaries;
- UNC paths.

Nunca confiar únicamente en `startsWith()` para validar rutas.

Usar canonical/real paths cuando sea posible.

---

# 18. Session system

No empezar con Postgres.

Usar filesystem o SQLite.

Recomendación:

SQLite para metadata + JSON/JSONL para eventos si simplifica debugging.

Sesión:

```ts
interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  model: string;
  messages: AgentMessage[];
  metadata: Record<string, unknown>;
}
```

Necesidades:

```text
forge sessions
forge resume <id>
forge new
```

Y dentro de UI:

```text
/new
/resume
```

---

# 19. Event model

Diseñar un event bus desde el inicio.

Eventos recomendados:

```text
session:start
session:end

turn:start
turn:end

model:request
model:response
model:error

tool:before
tool:start
tool:end
tool:error

permission:requested
permission:granted
permission:denied

context:built
context:compacted

workflow:start
workflow:end
```

Esto permitirá:

- CLI rendering;
- observabilidad;
- logging;
- plugins;
- desktop;
- telemetry opcional;
- testing.

---

# 20. Context builder

Contexto inicial:

```text
system prompt
+
Forge runtime instructions
+
user/project instructions
+
AGENTS.md
+
relevant skills
+
session history
+
current user request
```

Nunca cargar indiscriminadamente todo el repo.

Primeras funciones:

- localizar `AGENTS.md`;
- leer config de Forge;
- incluir working directory;
- incluir git status opcional;
- truncar tool output;
- limitar tamaño de contexto.

Compaction avanzada más adelante.

---

# 21. Skills

Formato sencillo basado en archivos.

```text
~/.forge/skills/
project/.forge/skills/
```

Skill:

```text
testing/
└─ SKILL.md
```

Resolver precedence:

```text
project skill
>
user skill
>
built-in skill
```

No ejecutar automáticamente skills irrelevantes.

Crear `SkillRegistry`.

Futuro:

- metadata;
- triggers;
- version;
- dependencies;
- score;
- usage history.

---

# 22. Extensions / hooks

Necesitamos extensibilidad programática.

API conceptual:

```ts
forge.on("beforeToolCall", handler);
forge.on("afterToolCall", handler);
forge.on("contextBuild", handler);
forge.on("turnStart", handler);
forge.on("turnEnd", handler);

forge.registerTool(tool);
forge.registerWorkflow(workflow);
forge.registerProvider(provider);
forge.registerAuthProvider(authProvider);
```

Evitar API enorme en v0.

Primero diseñar hooks mínimos y estables.

---

# 23. Workflows

Una de las features diferenciales a medio plazo.

Un workflow no es solo un prompt.

Ejemplo:

```ts
defineWorkflow("bugfix", async (ctx) => {
  await ctx.requireArtifact("reproduction");

  await ctx.agent.solve();

  await ctx.requireVerification("tests");

  await ctx.review();

  await ctx.complete();
});
```

Objetivo:

```text
bugfix
  ↓
reproduce
  ↓
inspect
  ↓
hypothesis
  ↓
implement
  ↓
test
  ↓
review
  ↓
regression
```

Si no hay tests:

- detectar;
- pedir estrategia alternativa;
- no fingir verificación.

---

# 24. Evidence-based skill learning

NO implementar en MVP.

Pero diseñar para poder añadirlo.

Idea:

```text
task
  ↓
workflow
  ↓
result
  ↓
evidence
  ├─ tests pass
  ├─ lint pass
  ├─ user accepted
  ├─ diff survived review
  └─ repeated success
  ↓
candidate skill
  ↓
evaluation
  ↓
save / update
```

No guardar una skill simplemente porque un LLM diga:

> "He aprendido X."

Necesita evidencia.

Metadata futura:

```ts
interface SkillEvidence {
  executions: number;
  successes: number;
  failures: number;
  lastUsedAt: string;
  confidence: number;
}
```

---

# 25. CLI

Nombre provisional:

```text
forge
```

Si el package name está ocupado, usar scope:

```text
@alvz/forge
```

## Comandos iniciales

```text
forge
forge run "<task>"
forge login
forge logout
forge auth status
forge models
forge sessions
forge resume <session>
forge config
```

Modo interactivo:

```text
/help
/login
/models
/model
/new
/sessions
/resume
/exit
```

---

# 26. UX inicial

Ejemplo:

```text
╭──────────────────────────────────────────────╮
│ Forge                                        │
│ C:\Desarrollo\my-project                     │
│ openai:codex-x                               │
╰──────────────────────────────────────────────╯

› find why tests fail and fix it

◈ Inspecting project

  read package.json
  search "test"
  shell pnpm test

✕ 2 tests failing

◈ Investigating

  read src/auth/session.ts
  read tests/session.test.ts

◈ Editing

  write src/auth/session.ts

◈ Verifying

  shell pnpm test

✓ 42 tests passed

Done.
```

No intentar clonar exactamente Codex, Claude Code o Pi.

---

# 27. Config

User-level:

```text
~/.forge/config.json
```

Project-level:

```text
project/.forge/config.json
```

Ejemplo futuro:

```json
{
  "model": {
    "default": "openai:codex-x"
  },
  "routing": {
    "enabled": false
  },
  "permissions": {
    "filesystemWriteOutsideWorkspace": "ask",
    "network": "ask",
    "gitPush": "ask",
    "destructiveShell": "deny"
  }
}
```

Precedence:

```text
CLI flags
>
project config
>
user config
>
defaults
```

---

# 28. NPM distribution

Root/package:

```json
{
  "name": "@alvz/forge",
  "type": "module",
  "bin": {
    "forge": "./dist/cli.js"
  }
}
```

Debe funcionar:

```bash
npm install -g @alvz/forge
forge
```

y:

```bash
npx @alvz/forge
```

y:

```bash
pnpm dlx @alvz/forge
```

No crear paquetes diferentes para npm/pnpm.

---

# 29. Cross-platform

CI obligatorio desde temprano:

```text
Windows
Ubuntu
macOS
```

GitHub Actions matrix:

```yaml
os:
  - windows-latest
  - ubuntu-latest
  - macos-latest
```

Testear especialmente:

- paths;
- shell;
- child processes;
- signals;
- cancellation;
- credential storage;
- line endings;
- executable bin;
- symlinks;
- temp dirs.

---

# 30. Seguridad

## No exponer secretos al modelo

El modelo no debería recibir:

```text
OPENAI_API_KEY
refresh_token
password
SSH private keys
```

El provider adapter usa credenciales directamente.

Nunca incluirlas en prompt/context.

---

## Environment sanitization

Antes de shell tool, considerar filtrar variables sensibles.

Ejemplo:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
AWS_SECRET_ACCESS_KEY
GITHUB_TOKEN
```

No pasar automáticamente todas las variables de entorno al proceso agent-controlled.

---

## Sensitive files

Configurable blocklist:

```text
.env
.env.*
~/.ssh/
credentials files
browser profiles
cloud credentials
```

No confiar solo en nombres: mantener política extensible.

---

# 31. Observabilidad

Desde v0 usar structured logging internamente.

```ts
logger.info({
  event: "tool:end",
  tool: "shell",
  durationMs,
  success: true
});
```

Pero CLI debe mostrar output humano.

No loguear secretos.

Telemetry remota:

- NO en MVP;
- si se añade, opt-in/transparent;
- nunca transmitir código sin consentimiento explícito.

---

# 32. Testing

Este proyecto necesita tests desde el primer milestone.

## Unit tests

- message conversion;
- tool validation;
- permission engine;
- path sandboxing;
- auth state;
- config precedence;
- routing filters.

## Integration tests

Usar fake provider.

```ts
class FakeProvider implements ModelProvider {
  // deterministic scripted responses
}
```

Permite simular:

```text
assistant → tool call
tool result
assistant → final
```

sin gastar tokens ni depender de APIs.

## E2E

CLI contra fake provider.

Luego smoke tests opcionales con providers reales bajo env flags.

---

# 33. Fake provider obligatorio

Debe existir pronto.

Ejemplo:

```text
fake:scripted
```

Caso:

```text
turn 1 → read_file(package.json)
turn 2 → shell(pnpm test)
turn 3 → final
```

Esto hará que el agent loop sea completamente testeable.

---

# 34. Error taxonomy

Normalizar errores:

```text
AuthenticationError
ProviderUnavailableError
RateLimitError
ContextLimitError
InvalidToolCallError
ToolExecutionError
PermissionDeniedError
WorkspaceViolationError
TimeoutError
CancelledError
ConfigurationError
```

La CLI decide cómo renderizarlos.

---

# 35. Provider implementation order

Primera etapa recomendada:

1. OpenAI API adapter;
2. Anthropic API adapter;
3. OpenRouter;
4. fake provider;
5. Ollama/local;
6. Google.

El orden puede cambiar si subscription OAuth oficial ofrece mejor camino durante implementación.

Para browser subscription auth, investigar por separado cada proveedor y documentar:

```text
supported officially?
native app OAuth?
PKCE?
device code?
subscription entitlement?
token refresh?
API scope?
terms?
```

No hacer reverse engineering de credenciales privadas.

---

# 36. MVP v0.1

Objetivo:

> Ejecutar Forge desde terminal, autenticarse/configurar un provider, enviar una tarea y permitir que el modelo lea/escriba archivos y ejecute shell dentro del workspace.

Debe incluir:

- pnpm monorepo;
- CLI;
- agent loop;
- internal message format;
- provider abstraction;
- 1 provider real;
- fake provider;
- API-key auth;
- credential abstraction;
- `read_file`;
- `write_file`;
- `shell`;
- workspace boundary;
- streaming básico;
- event bus mínimo;
- session in-memory o simple persistence;
- tests.

NO incluir:

- multi-agent;
- learning;
- desktop;
- browser;
- MCP;
- cron;
- RAG;
- vector DB;
- cloud execution;
- voice;
- subagents;
- sophisticated TUI.

---

# 37. MVP v0.1 acceptance criteria

Se considera terminado cuando:

```bash
pnpm install
pnpm build
pnpm test
```

pasan en Windows.

Y:

```bash
pnpm forge
```

o equivalente arranca CLI.

El usuario puede configurar un provider.

Puede ejecutar:

```text
› inspect package.json and tell me what framework this project uses
```

El modelo puede solicitar:

```text
read_file
```

y recibir resultado.

También:

```text
› create hello.txt with "hello forge"
```

y Forge:

- recibe tool call;
- valida path;
- aplica permisos;
- escribe archivo;
- devuelve observation;
- modelo responde.

También:

```text
› run the tests
```

y:

- shell ejecuta en workspace;
- timeout funciona;
- output vuelve al modelo;
- Ctrl+C cancela limpiamente.

---

# 38. v0.2

Objetivo:

> convertir el MVP en una herramienta utilizable diariamente.

Añadir:

- persistent sessions;
- resume;
- git tool;
- auth status;
- models command;
- config files;
- project instructions;
- AGENTS.md;
- better streaming;
- output truncation;
- retries;
- structured errors;
- Windows/macOS/Linux CI.

---

# 39. v0.3

Permisos reales:

- allow/ask/deny;
- filesystem boundary;
- network policy;
- destructive command detection;
- git push protection;
- secure credential store.

---

# 40. v0.4

Skills:

- global skills;
- project skills;
- skill loader;
- precedence;
- relevant skill activation.

---

# 41. v0.5

Extensions:

- lifecycle hooks;
- custom tools;
- custom providers;
- custom commands.

---

# 42. v0.6

Multi-model routing:

- model registry;
- provider health;
- capability filters;
- routing policies;
- manual task-role overrides.

Ejemplo:

```json
{
  "routing": {
    "planning": "openai:model-a",
    "implementation": "anthropic:model-b",
    "review": "openai:model-c"
  }
}
```

---

# 43. v0.7

Verification workflows:

- bugfix workflow;
- feature workflow;
- review workflow;
- required tests;
- required diff inspection;
- verifier model;
- retry loops.

---

# 44. v0.8

Evidence-based skills:

- execution history;
- workflow scoring;
- candidate skill creation;
- evaluation before persistence;
- skill update/versioning.

---

# 45. v0.9

Sandboxing:

Considerar:

- Docker;
- Windows Sandbox/containers donde sea viable;
- process isolation;
- filesystem mounts;
- network policy;
- CPU/memory limits.

No intentar resolver microVMs en primeras versiones.

---

# 46. v1.0

Objetivo:

- CLI estable;
- SDK estable;
- plugin API documentada;
- auth/provider abstraction estable;
- cross-platform;
- reproducible;
- usable como daily driver;
- npm release.

---

# 47. Desktop

No construir hasta que core y SDK sean maduros.

Arquitectura:

```text
Forge Core
   │
   ├─ CLI
   └─ Desktop
```

Opciones:

## Electron

Ventajas:

- Node runtime natural;
- reutilización máxima;
- React fácil;
- integración directa con SDK.

Desventajas:

- footprint alto.

## Tauri

Ventajas:

- ligera;
- binario pequeño.

Desventajas:

- introduce Rust/native bridge;
- puede complicar runtime Node-dependent.

No decidir ahora.

---

# 48. Ideas explícitamente fuera de alcance inicial

Evitar scope creep:

```text
- swarm multi-agent;
- social/chat integrations;
- WhatsApp;
- Telegram;
- browser automation;
- MCP full ecosystem;
- marketplace;
- hosted cloud;
- billing;
- team accounts;
- vector DB;
- embeddings;
- generic long-term memory;
- automatic code deployment;
- autonomous background loops;
```

Todo puede llegar después.

---

# 49. Decisiones que Codex NO debe tomar sin documentar

Si durante implementación hay que elegir:

- framework CLI;
- schema library;
- keychain library;
- SQLite library;
- logging library;
- OAuth helper;
- JSON schema strategy;
- build system;
- testing framework;

hacer:

1. evaluar 2–3 opciones;
2. priorizar mantenimiento, cross-platform y simplicidad;
3. elegir una;
4. registrar decisión en:

```text
docs/decisions/
```

Formato ADR corto.

---

# 50. Stack sugerido

No obligatorio si aparece una opción claramente mejor.

```text
TypeScript
Node.js current LTS
pnpm workspaces
ESM
Zod or TypeBox for runtime schemas
Vitest for tests
tsx for dev
tsup / tsdown / rollup-like build tool
SQLite later
```

Para CLI:

considerar una librería pequeña o incluso parser simple inicialmente.

No añadir framework pesado sin necesidad.

---

# 51. Coding standards

- strict TypeScript;
- no `any` salvo frontera externa documentada;
- interfaces pequeñas;
- dependency inversion;
- no provider-specific types en core;
- no CLI-specific logic en core;
- no singleton global innecesario;
- AbortSignal en operaciones largas;
- structured errors;
- deterministic tests;
- no mocks excesivamente acoplados a implementación;
- preferir fake implementations.

---

# 52. Definition of Done por feature

Cada feature debe tener:

- implementación;
- tests;
- error paths;
- cancellation si aplica;
- cross-platform consideration;
- documentación mínima;
- sin secretos en logs;
- build verde.

---

# 53. Primera sesión de trabajo recomendada

Codex debe empezar por:

## Paso 1

Crear repo/monorepo mínimo.

```text
apps/cli
packages/core
packages/providers
packages/auth
packages/tools
packages/runtime
packages/sdk
```

## Paso 2

Crear tipos internos:

```text
AgentMessage
ToolCall
ToolResult
ModelProvider
Tool
AgentEvent
```

## Paso 3

Implementar `FakeProvider`.

## Paso 4

Implementar `ToolRegistry`.

## Paso 5

Implementar tools:

```text
read_file
write_file
shell
```

con workspace boundary.

## Paso 6

Implementar agent loop usando fake provider.

## Paso 7

Tests de agent loop:

```text
user
→ model
→ tool call
→ tool result
→ model
→ final
```

## Paso 8

Crear CLI mínima.

```bash
forge run "..."
```

## Paso 9

Añadir primer provider real.

## Paso 10

Añadir auth API key segura.

No trabajar todavía en multi-routing.

---

# 54. Primeros tests importantes

## Agent loop

```text
- final response without tools
- one tool call
- multiple sequential tool calls
- malformed tool call
- unknown tool
- tool throws
- timeout
- cancellation
- max turns reached
```

## Workspace

```text
- read inside workspace
- write inside workspace
- ../ escape
- absolute escape
- symlink escape
- Windows drive escape
```

## Auth

```text
- no credential
- environment credential
- stored credential
- expired OAuth token
- refresh success
- refresh failure
- logout
```

---

# 55. Futuro: subscription auth research task

Crear documento:

```text
docs/auth/provider-matrix.md
```

Tabla:

```text
Provider
Subscription login supported?
Official third-party OAuth?
PKCE?
Device flow?
API-key fallback?
Refresh?
Known restrictions?
```

Investigar específicamente:

- OpenAI Codex / ChatGPT;
- Anthropic / Claude;
- GitHub Copilot;
- OpenRouter;
- Google.

No implementar flujos no documentados oficialmente.

---

# 56. Futuro: model capability registry

Crear capacidad de discovery.

Idealmente provider adapter puede listar modelos dinámicamente.

Si no:

```text
static catalog
+
runtime availability
```

No asumir que todos los endpoints ofrecen model listing completo.

---

# 57. Futuro: provider health

Cada target puede tener:

```ts
interface ProviderHealth {
  authenticated: boolean;
  reachable: boolean;
  rateLimited: boolean;
  lastLatencyMs?: number;
}
```

Routing debe excluir providers no disponibles.

---

# 58. Futuro: cost accounting

Aunque se use subscription auth, mantener posibilidad de accounting.

Eventos:

```text
usage.inputTokens
usage.outputTokens
usage.cachedTokens
usage.estimatedCost
```

Si provider no expone coste:

```text
estimatedCost = null
```

No inventar valores.

Esto permitirá routing cost-aware.

---

# 59. Futuro: task roles

Separar:

```text
planner
implementer
reviewer
researcher
verifier
```

de modelos concretos.

Config:

```json
{
  "roles": {
    "planner": "openai:model-a",
    "implementer": "anthropic:model-b",
    "reviewer": "openai:model-c"
  }
}
```

Así los workflows dependen de roles, no providers.

---

# 60. Diferenciación buscada

A largo plazo Forge debe destacar por:

### 1. Provider independence

El usuario no queda encerrado en un único modelo.

### 2. Subscription aggregation

Cuando sea oficialmente posible, aprovechar suscripciones existentes.

### 3. Model routing

Usar cada modelo donde aporte más.

### 4. Deterministic guardrails

Permisos y verificación mediante código.

### 5. Workflow engine

Metodologías ejecutables, no solo prompts.

### 6. Evidence-based learning

Convertir workflows demostrados en skills reutilizables.

### 7. User-owned operational knowledge

Las skills/workflows sobreviven a cambios de proveedor/modelo.

---

# 61. Anti-goals

Forge NO debe convertirse en:

- una UI que simplemente reenvía prompts;
- un clon visual de Claude Code;
- una mega-plataforma antes de tener runtime sólido;
- un sistema de prompts gigantes;
- un swarm porque "multi-agent suena bien";
- un framework con 100 abstracciones antes del MVP;
- un agente que afirma éxito sin evidencia.

---

# 62. Regla de producto

Antes de añadir una feature, responder:

> ¿Esto hace al harness mejor coordinando, ejecutando, verificando o reutilizando inteligencia?

Si no, probablemente no es prioridad.

---

# 63. Regla de simplicidad

Preferir:

```text
one reliable loop
+
few reliable tools
+
strong boundaries
```

antes que:

```text
10 agents
+
20 tools
+
memory
+
RAG
+
browser
+
cron
```

---

# 64. Primera milestone final

La primera milestone debe demostrar este flujo:

```text
forge
  ↓
provider authenticated
  ↓
user task
  ↓
model requests read_file
  ↓
Forge validates
  ↓
Forge executes
  ↓
result returns to model
  ↓
model requests write/shell
  ↓
Forge executes safely
  ↓
model returns final answer
```

Si eso funciona bien, tenemos un agent harness real.

Todo lo demás se construye encima.

---

# 65. Instrucción inicial para Codex

Empieza implementando únicamente **MVP v0.1**.

Antes de escribir código:

1. inspecciona este handoff completo;
2. crea un plan corto;
3. identifica decisiones arquitectónicas irreversibles;
4. evita sobrearquitectura;
5. crea primero el fake provider y los tests del loop;
6. mantén provider/auth/UI desacoplados;
7. documenta decisiones relevantes;
8. no implementes features de milestones posteriores salvo que sean estrictamente necesarias para no bloquear el diseño.

Prioridad:

```text
correctness
>
separation of concerns
>
testability
>
cross-platform
>
developer experience
>
visual polish
```

Objetivo:

> Al terminar la primera iteración debe existir una CLI real y testeable que pueda controlar al menos un modelo externo mediante tools, sin comprometer la arquitectura necesaria para múltiples providers y auth methods.
