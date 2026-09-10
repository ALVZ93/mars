# MARS — Handoff 2.0
## Consolidación, dogfooding y hardening antes de v0.1 pública

> Repositorio: https://github.com/ALVZ93/mars  
> Estado: harness funcional, cross-platform, CI verde y con múltiples capabilities ya implementadas.  
> Objetivo de esta fase: **dejar de añadir amplitud y convertir MARS en una herramienta fiable, medible y defendible como daily driver.**

---

# 1. Contexto

MARS ya ha superado la fase de scaffold. Actualmente existen, entre otras cosas:

- agent loop funcional;
- provider abstraction;
- providers reales;
- auth;
- credential storage;
- tools;
- workspace boundaries;
- permisos;
- shell;
- Git;
- sesiones;
- context builder;
- skills;
- workflows;
- evidence store;
- routing;
- MCP;
- sandbox Docker;
- CLI;
- SDK;
- site;
- package npm;
- CI en Windows/macOS/Linux;
- package smoke tests;
- release workflow.

El principal riesgo del proyecto ha cambiado.

Antes era:

> ¿Podemos construir un agent harness funcional?

Ahora es:

> ¿Podemos conseguir que MARS sea realmente mejor de usar que simplemente abrir Codex, Claude Code u otro agente equivalente?

La prioridad debe cambiar en consecuencia.

---

# 2. Mandato principal de esta fase

## Congelar scope

Durante esta fase, **NO añadir features nuevas de producto salvo que sean necesarias para corregir un problema descubierto durante dogfooding**.

No implementar ahora:

- más providers por tener más providers;
- nuevos protocolos;
- nuevos tipos de memoria;
- browser automation;
- subagents arbitrarios;
- swarm;
- cron;
- cloud runtime;
- desktop;
- marketplace;
- voice;
- nuevos workflows;
- nuevas tools decorativas;
- RAG;
- vector DB;
- background agents.

El foco es:

```text
existing capabilities
        ↓
real-world use
        ↓
failures
        ↓
measure
        ↓
fix
        ↓
repeat
```

---

# 3. Objetivos de Handoff 2.0

Esta fase debe cerrar seis frentes:

1. **Dogfooding real**
2. **Modularización**
3. **Naming Forge → MARS**
4. **Auth por suscripción segura y defendible**
5. **Routing medible**
6. **Release readiness real**

---

# 4. Prioridad absoluta: dogfooding

MARS debe empezar a usarse contra repositorios reales antes de seguir creciendo.

Crear un plan de dogfooding con al menos:

- 3 repositorios distintos;
- 5 tareas reales;
- providers distintos cuando sea viable;
- workflow normal vs workflow explícito;
- tareas de lectura;
- tareas de bugfix;
- tareas de modificación;
- tareas de verificación;
- al menos una sesión retomada.

Tipos de repos recomendados:

```text
1. proyecto TypeScript / Next.js
2. repo backend o Node
3. repo OSS ajeno o más desconocido
```

No crear repos artificiales solo para hacer tests felices.

---

# 5. Casos de dogfooding

## Caso A — análisis

```bash
mars "Explica la arquitectura de este proyecto y señala los puntos de entrada principales"
```

Observar:

- tools elegidas;
- número de tool calls;
- si lee demasiado;
- si entiende estructura;
- si consume contexto inútil;
- si alucina archivos.

## Caso B — bug real

```bash
mars "Encuentra por qué falla este test y corrígelo"
```

Observar:

- reproducción;
- inspección;
- hipótesis;
- edición;
- verificación;
- si reclama éxito sin pruebas.

## Caso C — feature pequeña

```bash
mars "Añade X manteniendo el comportamiento actual"
```

Observar:

- scope del diff;
- cambios innecesarios;
- elección de tools;
- uso de contexto;
- calidad de la verificación.

## Caso D — review

```bash
mars "Revisa el diff actual y señala riesgos concretos"
```

Observar:

- si distingue bugs reales de preferencias;
- si usa Git correctamente;
- si corre checks cuando procede;
- calidad del reasoning.

## Caso E — sesión

```text
mars
/new
...
exit
mars resume <id>
```

Comprobar:

- continuidad;
- contexto;
- compaction;
- estado restaurado;
- tool history.

---

# 6. Métricas mínimas

No mejorar MARS únicamente “a ojo”. Registrar por run:

```text
task id
repo
provider
model
workflow
role
start time
duration
turns
tool calls
tool errors
permission prompts
input tokens
output tokens
estimated cost if available
verification status
final result accepted?
retry count
context compactions
```

No registrar contenido de código o prompts en telemetría remota. Puede persistirse localmente.

---

# 7. Resultado de dogfooding

Crear:

```text
docs/dogfooding/
├─ README.md
├─ findings.md
└─ runs/
```

Cada hallazgo importante debe clasificarse:

```text
P0 - rompe tarea / peligroso
P1 - reduce fiabilidad
P2 - UX molesta
P3 - mejora futura
```

No convertir cada observación en feature.

---

# 8. Naming cleanup: Forge → MARS

Antes de estabilizar SDK y publicar públicamente, eliminar deuda de naming histórica.

Objetivo:

```text
ForgeError        → MarsError
ForgeOptions      → MarsOptions
ForgeHook         → MarsHook
createForge()     → createMars()
```

Revisar también:

```text
forge binary alias
handoff-forge-agent-harness.md
.forge
forge-specific comments
forge-specific temp prefixes
```

Decisión recomendada:

- mantener alias `forge` solo si existe motivo real de compatibilidad;
- como todavía no hay release pública estable, preferir eliminarlo;
- no mantener compatibilidad histórica innecesaria.

El package público debe presentar una identidad única:

```text
@alvz/mars
mars
createMars()
MarsError
MarsOptions
```

---

# 9. Breaking change policy

Como todavía estamos pre-1.0:

- priorizar API limpia;
- no conservar nombres antiguos por miedo;
- documentar breaking changes en CHANGELOG;
- no introducir wrappers de compatibilidad innecesarios.

---

# 10. Modularización del core

Actualmente el core concentra demasiado en `index.ts`.

Separar en módulos:

```text
packages/core/src/
├─ errors.ts
├─ messages.ts
├─ providers.ts
├─ tools.ts
├─ events.ts
├─ abort.ts
├─ compaction.ts
├─ agent-loop.ts
└─ index.ts
```

`index.ts` debe limitarse a re-exportar.

---

# 11. Modularización CLI

`apps/cli/src/index.ts` no debe seguir creciendo.

Separar aproximadamente en:

```text
apps/cli/src/
├─ index.ts
├─ commands/
│  ├─ auth.ts
│  ├─ config.ts
│  ├─ models.ts
│  ├─ sessions.ts
│  ├─ doctor.ts
│  ├─ check.ts
│  └─ run.ts
├─ interactive/
│  ├─ repl.ts
│  ├─ slash-commands.ts
│  └─ input.ts
├─ render/
│  ├─ events.ts
│  ├─ errors.ts
│  └─ tables.ts
└─ utils/
```

No sobrefragmentar. El objetivo es:

- comandos independientes;
- tests fáciles;
- `index.ts` pequeño;
- CLI sin lógica de runtime.

---

# 12. Regla de límites arquitectónicos

Verificar que:

```text
core
↓
NO importa CLI
NO importa providers concretos
NO importa auth concreta
NO importa runtime de UI
```

Y:

```text
providers
↓
dependen de core
y credenciales abstraídas
```

Y:

```text
cli
↓
consume SDK
```

Evitar imports profundos cruzados tipo:

```ts
../../core/src/index.js
```

si el monorepo puede usar package exports internos.

---

# 13. SDK público

El SDK debe ser deliberado. Reducir exports accidentales.

Preguntarse para cada export:

> ¿Queremos soportar esto públicamente?

API objetivo:

```ts
import {
  createMars,
  MarsError,
  type ModelProvider,
  type Tool,
  type AuthProvider
} from '@alvz/mars';
```

Evitar exponer estructuras internas porque “ya existen”.

---

# 14. Auth por suscripción: objetivo

Esta parte necesita hardening antes de poder considerarse feature real.

Separar claramente:

```text
stable auth
experimental auth
unsupported auth
```

---

# 15. OpenAI / Codex subscription auth

No reutilizar silenciosamente mecanismos internos de Codex como si MARS fuera Codex.

La implementación experimental actual basada en client ID/endpoints/parámetros de Codex puede servir para investigación, pero **NO debe convertirse en la implementación pública estable sin una vía soportada**.

Prioridad:

## Investigar integración mediante Codex app-server

Evaluar:

```text
Codex app-server
↓
login flow oficial
↓
MARS como cliente/orquestador
```

En vez de:

```text
MARS
↓
imita el cliente OAuth interno de Codex
```

Crear ADR:

```text
docs/decisions/ADR-codex-auth.md
```

Debe responder:

- cuál es el flujo soportado;
- qué API expone app-server;
- cómo se obtiene `authUrl`;
- cómo se recibe login completion;
- cómo se obtiene capability/model access;
- si MARS puede delegar autenticación sin manipular tokens directamente;
- limitaciones;
- términos aplicables;
- fallback.

Hasta resolver lo anterior:

```text
OpenAI API key = estable
Codex subscription auth = experimental
```

No prometer en README “usa tu suscripción ChatGPT” salvo que el camino esté validado de forma defendible.

---

# 16. Anthropic / Claude subscription auth

Mantener:

```text
Anthropic API key = estable
Claude subscription login = disabled
```

No intentar bypass.

No automatizar cookies.

No reutilizar credenciales de Claude Code.

No copiar tokens existentes.

---

# 17. Kimi / otros subscription providers

Seguir el mismo criterio:

```text
documented third-party flow?
        ↓
yes → candidate stable
no  → experimental/disabled
```

No inferir permisos por el hecho de que un cliente oficial lo haga.

---

# 18. Provider auth matrix

Actualizar:

```text
docs/auth/provider-matrix.md
```

Añadir columnas:

```text
stable
experimental
third-party officially documented
uses own client id
uses provider client id
billing source
subscription entitlement
refresh supported
logout/revoke
```

---

# 19. Credential handling

La base actual es buena. Mantener:

```text
Credential Manager
Keychain
Secret Service
```

Validar durante dogfooding:

- Windows;
- macOS;
- Linux;
- migration;
- missing optional dependency;
- corrupted credential;
- expired OAuth;
- refresh failure;
- logout.

Nunca imprimir tokens.

---

# 20. Logout real

Revisar providers donde:

```ts
async logout(): Promise<void> {}
```

Distinguir:

```text
local credential deletion
vs
provider-side token revocation
```

Si el proveedor no expone revocation:

- borrar local;
- documentar que no se revoca remotamente.

---

# 21. Routing: problema actual

El routing actual es funcional, pero heurístico.

Ejemplo conceptual:

```text
reviewer → Anthropic bonus
researcher → Gemini bonus
verifier → economical bonus
```

Eso es aceptable como baseline, pero no es diferenciación real.

**No seguir añadiendo reglas manuales.**

---

# 22. Routing v2

Construir routing basado en datos.

Pipeline:

```text
task
↓
role / requirements
↓
authenticated targets
↓
hard filters
↓
historical metrics
↓
cost/latency
↓
score
↓
selected target
```

---

# 23. Hard filters

Considerar:

```text
authenticated
tools
vision
reasoning
structured output
context window
provider allowed
budget
local-only
sandbox constraints
availability
rate-limit state
```

---

# 24. Historical performance

Crear stats locales por target y role.

```ts
interface ModelPerformance {
  target: string;
  role: TaskRole;
  runs: number;
  successes: number;
  verifiedSuccesses: number;
  failures: number;
  avgDurationMs?: number;
  avgInputTokens?: number;
  avgOutputTokens?: number;
  avgEstimatedCost?: number;
}
```

No mezclar tareas incompatibles.

```text
anthropic:X reviewer
```

y:

```text
anthropic:X implementer
```

son stats diferentes.

---

# 25. Routing score

Primera versión:

```text
hard filters first

score =
  verifiedSuccessRate * W1
+ successRate * W2
- normalizedCost * W3
- normalizedLatency * W4
+ userPreference * W5
```

No hace falta optimización estadística sofisticada todavía.

Sí hace falta:

- determinismo;
- explicabilidad;
- tests;
- fallback.

---

# 26. Routing transparency

Cuando se usa routing:

```bash
mars ... --route
```

permitir explicar:

```text
Selected: provider:model

Reason:
- authenticated
- tools supported
- role: implementer
- 8/10 verified successes
- lower latency than candidate B
```

No mostrar solo “best model selected”.

---

# 27. Cold start

Sin historial, usar:

```text
config
+
capabilities
+
conservative static baseline
```

No inventar precisión inexistente.

---

# 28. Provider health

Usar `ProviderHealthTracker` de forma real.

Routing debe excluir o penalizar:

```text
auth failed
rate limited
temporarily unavailable
high recent error rate
```

Health necesita expiración. No dejar un provider marcado “bad forever”.

---

# 29. Cost accounting

Registrar cuando el provider lo permita:

```text
input tokens
output tokens
cached tokens
estimated API cost
```

Si subscription auth no permite obtener coste:

```text
cost = null
```

No inventar.

---

# 30. Workflow evaluation

No añadir más workflows.

Validar solo:

```text
bugfix
feature
review
```

Comparar:

```text
plain run
vs
workflow
```

Medir:

- éxito;
- tool calls;
- duración;
- tokens;
- verification.

Si workflow no mejora nada, simplificarlo.

---

# 31. Evidence store

Mantener el enfoque actual:

```text
record outcomes
↓
manual suggestion
```

No crear skills automáticamente todavía.

No cambiar a:

```text
LLM thinks it learned something
↓
save skill
```

---

# 32. Evidence quality

El `passed` debe ser más estricto.

Distinguir:

```text
agent completed
verification executed
verification passed
user accepted
```

No considerar “success” simplemente porque `runAgent()` devolvió final.

Crear un outcome explícito:

```ts
type Outcome =
  | 'completed'
  | 'verified'
  | 'failed'
  | 'cancelled'
  | 'unverified';
```

Si no hubo evidencia externa:

```text
unverified
```

---

# 33. Verification

`runProjectChecks()` es una pieza clave.

Dogfood en:

- Node;
- proyecto sin package.json;
- Python;
- Rust;
- custom commands.

No asumir JavaScript como mundo entero.

La config explícita debe ganar.

---

# 34. Verification false positives

Asegurar que MARS nunca diga:

```text
✓ verified
```

si:

- no encontró checks;
- un command no arrancó;
- permiso fue denegado;
- timeout;
- test output desconocido.

Distinguir:

```text
PASSED
FAILED
NOT VERIFIED
```

---

# 35. Shell execution

Validar:

- Ctrl+C;
- timeout;
- child process;
- child tree;
- Windows PowerShell;
- bash;
- processes que ignoran SIGTERM;
- output masivo.

En Windows, revisar si `child.kill()` termina correctamente procesos descendientes. Documentar limitación si no.

---

# 36. Docker sandbox

No expandir. Solo validar:

```text
workspace mount
cwd
network none
network host
memory
cpus
timeout
cancellation
Windows paths
macOS paths
Linux paths
```

No añadir Kubernetes, microVM, Firecracker, etc.

---

# 37. MCP

MCP ya existe. No añadir más protocolo.

Validar:

- conexión;
- server crash;
- malformed schema;
- duplicate tool;
- timeout;
- close;
- permission boundary.

Importante: MCP tools no deben saltarse permisos relevantes si realizan operaciones sensibles. Documentar trust boundary.

---

# 38. Tool safety

Revisar cada built-in tool:

```text
read_file
write_file
search_files
shell
git
```

Preguntas:

- ¿puede escapar workspace?
- ¿puede leer secret?
- ¿puede seguir symlink?
- ¿puede exponer env?
- ¿puede bloquear proceso?
- ¿puede devolver output enorme?
- ¿puede producir error con secreto?

---

# 39. Git tool

Ahora es principalmente read-only. Mantener así por defecto.

Si se añaden writes:

```text
git.commit
git.push
```

deben ser tools separadas o acciones explícitas con permisos.

No esconder push dentro de shell autorizada genéricamente sin política.

---

# 40. Context quality

Dogfood `buildProjectContext`.

Medir:

- cuánto contexto inyecta;
- si skills irrelevantes entran;
- si AGENTS.md precedence es correcta;
- si context instructions se duplican;
- si history se hincha.

No cargar documentos “porque existen”.

---

# 41. Compaction

La compaction actual elimina historial antiguo con marcador.

Validar:

- tareas largas;
- tool call/result consistency;
- systems múltiples;
- continuidad;
- sesiones resumidas.

Posible mejora futura:

```text
model-assisted summary
```

pero NO implementar salvo que el truncado actual falle claramente.

---

# 42. Error handling

Mantener taxonomy estable y accionable:

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
LimitError
```

Todos los errores públicos deben ser:

- accionables;
- seguros;
- sin secretos;
- con código estable.

---

# 43. Retry policy

La decisión actual de retries desactivados por defecto es sensata.

Validar:

- no duplicar tool execution;
- no duplicar billing fácilmente;
- no retry después de streaming parcial;
- RateLimit;
- transient 5xx;
- cancellation.

No introducir retries agresivos.

---

# 44. Tests

No bajar cobertura cualitativa.

Añadir tests específicamente por bugs encontrados en dogfooding.

Regla:

> cada fallo real que llegue a ser reproducible debe generar un regression test.

---

# 45. CI

Mantener:

```text
windows-latest
ubuntu-latest
macos-latest
```

Y:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:package
```

No eliminar matrix para ahorrar minutos sin necesidad.

---

# 46. Node baseline

Revisar si exigir:

```text
Node >=24
```

es realmente necesario.

Si no se usa ninguna API exclusiva importante, evaluar Node 22 LTS como baseline.

No cambiar por estética.

Crear ADR:

```text
docs/decisions/ADR-node-baseline.md
```

Comparar:

- soporte;
- ecosystem;
- optional native deps;
- user friction;
- AbortSignal APIs usadas;
- package compatibility.

---

# 47. Dependency hygiene

Mantener pocas dependencias.

Antes de añadir una dependency:

- ¿reduce riesgo?
- ¿está mantenida?
- ¿cross-platform?
- ¿bundle implications?
- ¿native build?

Especial cuidado con credential store.

---

# 48. Release workflow

No publicar v0.1 solo porque package smoke funciona.

Antes:

```text
dogfooding pass
naming cleanup
SDK cleanup
auth matrix settled
CI green
package smoke green
README accurate
SECURITY accurate
CHANGELOG
```

---

# 49. Release readiness checklist

Crear:

```text
docs/release/v0.1-readiness.md
```

Con:

```text
[ ] CLI daily-driver usable
[ ] Windows validated
[ ] macOS validated
[ ] Linux validated
[ ] npm install validated
[ ] npx validated
[ ] auth stable path validated
[ ] keychain validated
[ ] sessions validated
[ ] cancellation validated
[ ] workspace safety validated
[ ] provider errors validated
[ ] README matches reality
[ ] no experimental auth marketed as stable
[ ] naming Mars complete
[ ] no accidental public SDK exports
[ ] release notes
```

---

# 50. README

Principio:

> README debe describir lo estable, no lo técnicamente posible.

Separar:

```text
Stable
Experimental
Planned
```

---

# 51. Experimental flags

Mantener una política clara.

Ejemplo:

```text
MARS_ENABLE_EXPERIMENTAL_SUBSCRIPTION_AUTH=1
```

Todo experimental debe:

- aparecer en docs;
- estar off por default;
- tener warning;
- no contar como stable compatibility.

---

# 52. Doctor command

Convertir `mars doctor` en herramienta real de soporte.

Debe comprobar:

```text
Node
Git
workspace
config
credential backend
providers
Docker
shell
MCP config
verification config
```

No hacer llamadas caras innecesarias.

---

# 53. UX de permisos

Dogfood cuántas veces pregunta.

Problema a evitar:

```text
ask
ask
ask
ask
ask
```

que hace MARS inutilizable.

Considerar approvals de sesión:

```text
allow once
allow for session
deny
```

pero solo si el dogfooding muestra fricción real.

---

# 54. User trust

Mostrar claramente:

```text
read
write
shell
network
sandbox
```

No ocultar cambios.

Idealmente, el resumen final puede incluir:

```text
Changed:
- src/a.ts
- tests/a.test.ts

Verified:
- npm test ✓
- npm run lint ✓
```

Solo implementar si puede obtenerse con fiabilidad.

---

# 55. Multi-provider orchestration

No construir swarm.

La forma aceptable por ahora:

```text
role-based sequential workflow
```

Ejemplo:

```text
planner → model A
implementer → model B
verifier → model C
```

Todo mediado por MARS.

No comunicación directa entre modelos.

---

# 56. Inter-model context

Cuando una fase entrega a otra, no pasar todo indiscriminadamente.

Preferir:

```text
shared session
+
workspace state
+
phase result
+
original task
```

Medir contexto.

---

# 57. Independent reviewer

Si hay múltiples providers autenticados, permitir opcionalmente que reviewer sea distinto al implementer.

No forzar.

Puede ser una diferenciación útil si demuestra valor.

---

# 58. Diferenciación real

MARS debe probar al menos una de estas ventajas:

```text
A. mejor verification
B. mejor provider portability
C. mejor workflow reliability
D. mejor subscription/provider unification
E. mejor model routing
F. mejor evidence loop
```

No hace falta ganar en todas.

Para v0.1 bastan 1–2.

---

# 59. Comparativa real

Durante dogfooding hacer comparativa informal:

```text
same task
↓
MARS
vs
Codex direct
vs
Claude Code if available
```

No buscar benchmarks científicos todavía.

Observar:

- resolución;
- tiempo;
- fricción;
- calidad;
- verificación;
- control.

---

# 60. Qué NO perseguir

No obsesionarse con:

```text
"más potente que Hermes"
```

ni:

```text
"más inteligente que Codex"
```

MARS no controla el modelo.

La propuesta es:

```text
better orchestration
better guardrails
better portability
better verification
```

---

# 61. Code quality

Durante refactor:

- strict TS;
- imports claros;
- modules pequeños;
- evitar god objects;
- no abstraer por adelantado;
- reducir circular deps;
- public API explícita.

---

# 62. SDK createMars()

API objetivo:

```ts
const mars = await createMars({
  workspace,
  provider,
  model
});

await mars.run(task);
```

Más adelante:

```ts
await mars.runWorkflow(...);
```

Debe seguir siendo sencilla.

No convertir configuración en 80 opciones obligatorias.

---

# 63. Config normalization

Asegurar que config:

- valida;
- tiene defaults;
- mergea correctamente;
- CLI override funciona;
- project > user;
- no guarda secretos.

---

# 64. Config versioning

Antes de v0.1, añadir `version` si no existe.

```json
{
  "version": 1
}
```

No hace falta framework complejo de migraciones todavía.

---

# 65. Session versioning

Añadir `schemaVersion` al formato de sesión si no existe.

No publicar un formato persistido implícito sin versión.

---

# 66. Data ownership

MARS debe seguir siendo local-first.

No backend.

No remote telemetry.

No cuenta MARS.

Todo:

```text
config
sessions
evidence
credentials
```

controlado por usuario.

Esto es una fortaleza.

---

# 67. Privacy documentation

Actualizar SECURITY/README:

- qué se manda al provider;
- qué queda local;
- qué pueden ver MCP servers;
- qué ve shell;
- qué guarda evidence;
- qué guarda session history.

---

# 68. Package release

Antes del primer publish hacer instalación desde tarball:

```bash
npm pack
npm install -g ./alvz-mars-0.1.0.tgz
```

Test real del binario.

---

# 69. Global binary

Publicar solo:

```text
mars
```

salvo decisión explícita.

Eliminar `forge` si no existe usuario real dependiente.

---

# 70. Semver

Usar:

```text
0.1.0
0.1.1
0.2.0
```

Mientras SDK sea inestable.

No prometer API stability hasta 1.0.

---

# 71. ADRs requeridos para esta fase

Crear/actualizar:

```text
ADR - naming Mars
ADR - Node baseline
ADR - Codex subscription auth
ADR - SDK public surface
ADR - routing metrics
```

Cortos. No escribir papers.

---

# 72. Milestone 2A — Cleanup

Objetivo:

```text
naming + modularización + public API
```

Definition of Done:

- Forge names eliminados;
- core modularizado;
- CLI modularizada;
- SDK limpio;
- tests verdes;
- package smoke verde.

---

# 73. Milestone 2B — Dogfooding

Objetivo:

```text
5 real tasks
```

Definition of Done:

- runs documentados;
- P0/P1 hallazgos;
- regression tests;
- fixes aplicados;
- no nuevas features.

---

# 74. Milestone 2C — Auth hardening

Definition of Done:

- stable vs experimental claro;
- Codex auth ADR;
- Anthropic restriction respetada;
- provider matrix actualizada;
- keychain tested;
- logout semantics documentadas.

---

# 75. Milestone 2D — Routing v2

Definition of Done:

- structured run metrics;
- model performance history;
- hard filters;
- explainable score;
- health-aware routing;
- deterministic fallback;
- tests.

---

# 76. Milestone 2E — v0.1 readiness

Definition of Done:

- checklist cerrada;
- README accurate;
- CI green;
- package test;
- dogfooding successful;
- no P0;
- no P1 conocido sin documentar.

---

# 77. Orden de trabajo recomendado

NO ejecutar todos los milestones simultáneamente.

Orden:

```text
1. cleanup
2. dogfooding
3. fixes
4. auth hardening
5. routing metrics
6. dogfooding 2
7. release readiness
```

---

# 78. Primer trabajo que Codex debe hacer

Antes de escribir código:

1. inspeccionar repo completo;
2. leer este handoff;
3. comparar con implementación;
4. crear checklist;
5. NO añadir features;
6. empezar por cleanup de naming y modularización.

---

# 79. Primer commit set recomendado

```text
refactor: rename Forge API to Mars
refactor: split core modules
refactor: split CLI commands
test: preserve public behavior after refactor
```

No mezclar cambios funcionales grandes con naming.

---

# 80. Después del refactor

Ejecutar:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:package
```

Push y confirmar CI:

```text
Windows ✓
Linux ✓
macOS ✓
```

---

# 81. Dogfood execution protocol

Por cada task registrar:

```text
task
repo
provider
model
workflow
outcome
verification
issues
```

No alterar manualmente el resultado para hacer parecer que funcionó.

---

# 82. Quality gates

No avanzar a release si:

```text
P0 unresolved
workspace escape possible
credentials leak
auth ambiguous
session corruption
verification lies
cross-platform CI red
package install broken
```

---

# 83. Feature freeze rule

Si durante esta fase aparece una idea:

```text
"estaría guapo que..."
```

ponerla en:

```text
docs/backlog.md
```

No implementarla automáticamente.

---

# 84. Backlog categories

```text
Now
Next
Later
Maybe
```

Todo nuevo va a Later/Maybe salvo bug o blocker.

---

# 85. Product question for each change

Preguntar:

> ¿Esto hace MARS más fiable, más portable, más seguro o más verificable hoy?

Si no, probablemente no entra en esta fase.

---

# 86. Diferenciación de v0.1

MARS v0.1 debería poder decir honestamente:

> MARS es un agent harness local, provider-independent y cross-platform que permite trabajar sobre repositorios con tools, sesiones, permisos, verificación y routing básico, manteniendo credenciales y datos bajo control del usuario.

No prometer todavía:

- auto-learning;
- superior routing;
- seamless subscription aggregation;
- autonomous multi-agent;
- enterprise sandbox.

---

# 87. Target de experiencia

MARS debe poder usarse así:

```bash
npm install -g @alvz/mars
cd repo
mars init
mars doctor
mars login openai --api-key
mars
```

Y resultar suficientemente estable para dejarlo abierto.

---

# 88. Target de fiabilidad

Una tarea debe terminar en uno de:

```text
COMPLETED
VERIFIED
FAILED
CANCELLED
UNVERIFIED
```

Nunca en una ambigüedad donde el texto dice que funcionó pero runtime no sabe.

---

# 89. Target de transparencia

Al final de una tarea importante MARS debería poder conocer:

```text
provider/model
tools used
files changed
verification
duration
usage
```

No necesariamente mostrar todo siempre.

---

# 90. Target de routing

Routing v2 no necesita ser “AI magic”.

Debe ser:

```text
boring
measurable
deterministic
explainable
```

Eso es mejor.

---

# 91. Target de auth

Auth debe ser:

```text
official where possible
explicit where experimental
secure locally
never reverse-engineered silently
```

---

# 92. Target de codebase

Antes de v0.1, ningún archivo central debería crecer indefinidamente.

Preferencia aproximada:

```text
< 500 LOC
```

No como dogma. Si un módulo más largo tiene cohesión real, mantenerlo.

---

# 93. Test philosophy

Prioridad:

```text
integration tests
>
behavior tests
>
implementation mocks
```

El FakeProvider es importante. Mantenerlo.

---

# 94. FakeProvider

Expandir solo para cubrir casos reales:

- multiple tool calls;
- malformed output;
- stream error;
- retry;
- cancellation;
- workflow;
- routing.

No convertirlo en un lenguaje de scripting enorme.

---

# 95. Public release blockers

Antes de publicar:

- no secretos committed;
- no client secrets;
- no experimental behavior por default;
- no stale docs;
- package contents correctos;
- license correct;
- NOTICE correct.

---

# 96. Security pass

Hacer revisión específica antes de release:

```text
auth
workspace
shell
credential store
MCP
Docker
logs
error messages
```

No confiar solo en unit tests.

---

# 97. Final acceptance criteria de Handoff 2.0

Esta fase termina cuando:

## Architecture

- naming 100% MARS;
- core modular;
- CLI modular;
- SDK surface deliberada.

## Reliability

- 5+ real-world dogfood runs;
- P0 resueltos;
- P1 críticos resueltos;
- regression tests añadidos.

## Auth

- stable/experimental matrix clara;
- Codex auth pathway decidido;
- no unsupported Claude subscription login;
- keychain validated.

## Routing

- metrics local;
- hard filters;
- health-aware;
- historical performance;
- explainable scoring.

## Cross-platform

- Windows green;
- macOS green;
- Linux green.

## Release

- package smoke green;
- README accurate;
- v0.1 readiness checklist complete;
- no experimental claims presented as stable.

---

# 98. Instrucción final para Codex

Actúa como maintainer de MARS, no como feature generator.

Tu prioridad es:

```text
reliability
>
security
>
testability
>
cross-platform behavior
>
clarity
>
new functionality
```

Durante esta fase:

- no añadas features sin necesidad;
- no ensanches scope;
- no hagas refactors cosméticos gigantes;
- no ocultes limitaciones;
- no marques algo como verificado si no lo está;
- no uses auth de terceros de forma no soportada;
- no mantengas compatibilidad con Forge si no hay usuarios que la necesiten;
- no optimices routing sin datos;
- convierte fallos reales en tests;
- mantén el runtime independiente del provider y de la CLI.

El objetivo de Handoff 2.0 no es que MARS haga más cosas.

El objetivo es:

> **que las cosas que ya hace sean suficientemente buenas como para que alguien quiera usarlo de verdad.**
