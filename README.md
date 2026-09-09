# MARS 0.1

MARS es el nombre de producto del agent harness. El binario nuevo es `mars`; `forge` sigue disponible como alias de transición.

Publicado bajo la [licencia Apache 2.0](LICENSE).
Repositorio oficial: [github.com/ALVZ93/mars](https://github.com/ALVZ93/mars).

## Arrancar

Requisitos: Node.js 24 y pnpm 11.19.0.

```sh
pnpm install
pnpm build
pnpm test
pnpm mars --help
pnpm mars run "inspect package.json" --model fake:scripted
```

Para instalar el binario local y poder ejecutar `mars` desde cualquier carpeta en pnpm 11:

```powershell
pnpm setup                 # solo la primera vez; después abre una terminal nueva
cd C:\Desarrollo_web\Harness
pnpm add --global .
mars --version
```

Después de autenticarte, `mars` usa el directorio actual como workspace; también puedes pasar `--workspace PATH`.

`fake:scripted` es una demo determinista, no un modelo: lee `package.json` y devuelve el resultado de la tool. No requiere red ni credenciales.

En una terminal interactiva, `mars` mantiene una pantalla TUI única durante toda
la conversación: transcript arriba, compositor abajo y estado lateral cuando hay
anchura suficiente. Enter envía, Tab abre el selector de modelos, Ctrl+P muestra
los comandos, Esc/Ctrl+C interrumpe el turno activo y `/permissions allow`
configura la shell. Los límites predeterminados son 24 turnos y 64 llamadas de
herramienta por tarea; se pueden cambiar con `--max-turns`, `--max-tool-calls` o
`mars config set limits.maxTurns N`.

MARS también puede arrancar sin `--model` cuando existe un modelo configurado o una credencial conectada. La selección es determinista y no realiza una petición adicional al proveedor.

```sh
mars init
mars config set model.default openai:gpt-5.6-sol
mars "inspect the project and fix the failing tests" --verify
```

La configuración de usuario se carga desde `%APPDATA%\\mars\\config.json` (Windows) o `~/.config/mars/config.json`; la configuración del proyecto vive en `.mars/config.json`. La precedencia es flags, entorno, proyecto, usuario y defaults. En `mcp.servers` se pueden declarar servidores stdio explícitos para las sesiones del proyecto:

Guía completa de rutas, roles, permisos, skills, MCP, limpieza y actualización: [docs/configuration.md](docs/configuration.md). El proceso de publicación está en [docs/releasing.md](docs/releasing.md).

```json
{
  "mcp": {
    "servers": [{ "name": "local", "command": "node", "args": ["./mcp-server.mjs"] }]
  }
}
```

Para comprobar también escritura y shell, este fixture crea `hello.txt` y ejecuta `node --version`:

```sh
pnpm mars run "offline fixture" --model fake:scripted --script examples/fake-script.json --allow-shell
```

## Proveedores y autenticación

La autenticación comparte una interfaz para API keys, OAuth PKCE y device code. Gemini puede usar OAuth Cloud con un cliente propio. Los adapters directos de suscripción de OpenAI Codex y Kimi son experimentales y están desactivados por defecto; Anthropic estable usa API key porque su política no permite login de claude.ai en productos de terceros no aprobados. Los tokens se refrescan cuando caducan. `createCredentialStore()` usa Credential Manager, Keychain o Secret Service mediante `@napi-rs/keyring`; si el backend nativo no está disponible, falla de forma explícita.

```sh
pnpm mars auth providers
pnpm mars auth status
```

MARS toma Pi como referencia técnica y mantiene cada flujo aislado por proveedor. No lee cookies ni reutiliza sesiones del navegador: el login devuelve un OAuth credential y el adapter lo convierte en headers del transporte.

Google OAuth requiere un proyecto Cloud, pantalla de consentimiento y cliente propio; no equivale automáticamente a la suscripción de Gemini de consumo. Configura `MARS_GEMINI_CLIENT_ID` (y opcionalmente `MARS_GEMINI_CLIENT_SECRET`) antes de `mars login gemini`. Alibaba Token/Coding Plans usan API key y base URL compatible.

Matriz completa: [docs/auth/provider-matrix.md](docs/auth/provider-matrix.md).

## Login de proveedores

```sh
pnpm mars login openai --api-key
pnpm mars login anthropic --api-key
pnpm mars login kimi-code --api-key
pnpm mars login gemini --browser  # requiere MARS_GEMINI_CLIENT_ID
pnpm mars login openrouter --api-key
pnpm mars auth logout anthropic
```

El login de navegador abre la URL y espera el callback local en `127.0.0.1`; el device code muestra la URL y el código. El backend se puede seleccionar con `MARS_CREDENTIAL_STORE=auto|keychain|file`; `auto` y `keychain` exigen el almacén nativo. `file` es una elección explícita de desarrollo que guarda JSON en `%APPDATA%\\mars\\auth.json` en Windows o `~/.config/mars/auth.json` en macOS/Linux. El archivo nunca entra en el contexto del modelo.

## OpenAI

Selecciona un identificador de modelo habilitado en tu cuenta que admita Chat Completions y function calling:

```sh
pnpm mars login openai --api-key
```

Solicita la API key sin mostrarla y la guarda en el store de credenciales de MARS.

Para automatización, establece `OPENAI_API_KEY` mediante tu gestor de secretos o entorno y ejecuta:

```sh
pnpm mars run "inspect package.json and tell me what framework this project uses" --model openai:MODEL
pnpm mars run 'create hello.txt with "hello mars"' --model openai:MODEL
```

`MARS_MODEL=provider:model` sustituye el flag `--model`; `FORGE_MODEL` queda como alias. `--workspace PATH` selecciona el directorio de trabajo; por defecto se usa el cwd.

El adaptador usa el [SDK oficial y Chat Completions](https://developers.openai.com/api/reference/resources/chat), streaming y function calling, con `store: false`. La API key se utiliza en el transporte, fuera de los mensajes. El adapter directo `openai-codex:*` permanece experimental y desactivado por defecto mientras se evalúa una integración soportada mediante Codex app-server.

## Anthropic, Kimi, Gemini y Qwen

Selecciona el protocolo con el prefijo del modelo:

```sh
pnpm mars run "inspect package.json" --model anthropic:claude-sonnet-4-5
pnpm mars run "inspect package.json" --model kimi-code:kimi-for-coding
pnpm mars run "inspect package.json" --model gemini:gemini-2.5-pro
pnpm mars run "inspect package.json" --model qwen:qwen3-coder-plus
pnpm mars run "inspect package.json" --model openrouter:anthropic/claude-sonnet-4-5
pnpm mars run "inspect package.json" --model ollama:qwen3-coder
```

Anthropic y Kimi hablan Messages SSE; Gemini usa `streamGenerateContent`; Qwen y OpenRouter usan Chat Completions compatible. API keys: `ANTHROPIC_API_KEY`, `KIMI_API_KEY`, `GOOGLE_API_KEY`, `DASHSCOPE_API_KEY` y `OPENROUTER_API_KEY`. Ollama usa su endpoint local OpenAI-compatible (`OLLAMA_BASE_URL`, por defecto `http://127.0.0.1:11434/v1`) y no necesita login.

## Sesiones, CLI y animación

- `pnpm mars --model openai:MODEL`: modo interactivo.
- Al comenzar cada tarea interactiva MARS muestra durante unos instantes un logotipo ASCII rojo con sombra 3D. Se omite automáticamente sin TTY, con `NO_COLOR=1`, `TERM=dumb` o `MARS_NO_ANIMATION=1`; `--no-animation` lo desactiva explícitamente.
- Las sesiones se guardan en `.mars/sessions` dentro del workspace y se pueden retomar con `mars sessions` y `mars resume SESSION_ID`. `--no-save` desactiva el guardado.
- `mars models`, `mars route "task"`, `mars doctor`, `mars check`, `mars workflows`, `mars skills` y `mars config` exponen el estado operativo sin llamar a un proveedor.
- `mars evidence` conserva solo métricas locales de ejecuciones y muestra candidatos de skills para promoción manual; `mars evidence clear` las elimina.
- `mars health` muestra el último estado observado de cada provider y no hace sondas de red ni consume tokens. El log local `.mars/events.jsonl` redacciona texto de modelo y objetivos de permisos.
- `/new`: nueva sesión; `/model` muestra modelos y `/model provider:model` cambia el provider de la sesión; `/models`, `/route`, `/sessions`, `/resume ID`, `/config`, `/check`, `/skills`, `/workflows`, `/help` y `/exit` están disponibles en modo interactivo.
- `--workflow bugfix|feature|review` ejecuta fases coordinadas con roles planner, implementer y verifier. Sin `--workflow`, el runtime mantiene un único loop y el router solo selecciona el target.
- El router clasifica la tarea como `planner`, `implementer`, `reviewer`, `verifier` o `researcher`, filtra proveedores autenticados y aplica los targets configurados en `routing.*`; no usa otra llamada al modelo para decidir. Con `--workflow` y `--route`, cada fase puede recibir un provider/model distinto; la CLI muestra la selección en `[workflow routing]`.
- Ctrl+C durante una tarea la cancela; en el prompt sale de la CLI.
- `read_file`: UTF-8, hasta 32.000 caracteres de salida.
- `write_file`: hasta 1.000.000 de caracteres, reemplazo mediante archivo temporal y rename.
- `shell`: PowerShell sin perfil en Windows; bash sin perfil en macOS/Linux. `cwd` y `timeout` pueden ser `null` para usar los valores predeterminados.
- `--sandbox docker` ejecuta `shell` dentro de una imagen Docker con mount del workspace, red `none`, memoria y CPU limitadas; también se puede activar con `MARS_SANDBOX=docker` y cambiar la imagen con `MARS_SANDBOX_IMAGE`. Si Docker no está disponible, MARS falla de forma explícita.
- `search_files`: búsqueda recursiva acotada que omite dependencias, builds, VCS y archivos sensibles.
- `git`: inspección read-only de `status`, `diff`, `log` y `branch` sin pasar por un shell concatenado.
- Límites predeterminados: 24 turnos, 64 tool calls, 120 segundos por tarea, 30 segundos por shell y 200.000 caracteres de historial.
- Los reintentos de provider están desactivados por defecto para evitar doble facturación o repetir una operación; se pueden activar con `--max-retries N --retry-delay MS` o `limits.maxRetries`/`limits.retryDelayMs` en `.mars/config.json`. Solo se reintentan fallos transitorios antes de que el provider emita texto.
- Los errores de tools vuelven al modelo como observaciones; una respuesta final no implica que todos los comandos hayan terminado correctamente.
- Un fallo conserva las observaciones completadas. Una operación interrumpida puede haber dejado efectos parciales: su resultado se marca como incierto para evitar repetirla a ciegas.

## MCP y extensiones

El SDK puede conectar servidores MCP por stdio de forma opt-in. Cada herramienta queda prefijada como `mcp_<servidor>_<herramienta>`, valida el esquema JSON descubierto y el proceso se inicia con `shell:false`, un entorno heredado mínimo, timeout y cierre al terminar la sesión:

```js
const forge = await createForge({
  workspace: process.cwd(),
  provider: new FakeProvider(),
  model: 'scripted',
  mcpServers: [{ name: 'local', command: 'node', args: ['./mcp-server.mjs'] }],
});
try { await forge.run('use the local MCP tool'); }
finally { await forge.close(); }
```

No se conectan servidores MCP por defecto; cada comando y sus permisos siguen siendo responsabilidad del servidor configurado.

## Límite de seguridad

Las tools de archivos comprueban rutas relativas/canónicas, escapes, unidades, UNC, nombres reservados y alternate data streams; bloquean enlaces simbólicos/junctions/hardlinks y nombres de archivos sensibles. Las escrituras son privadas por defecto donde el sistema soporta modos POSIX.

**El modo host de shell no está aislado por el sistema operativo.** El cwd validado no impide que un comando lea/escriba fuera del proyecto, acceda a la red o lea credenciales del usuario. Cada comando requiere aprobación en terminal; sin terminal se deniega. `--allow-shell` autoriza shell con acceso al host durante ese proceso y solo debe usarse con tareas de confianza. Se filtra el entorno heredado mediante allowlist y se termina el árbol de procesos en timeout/cancelación; procesos que se separen deliberadamente pueden escapar. Para aislamiento práctico, `--sandbox docker` usa un contenedor efímero con mount explícito, red `none` por defecto y límites de CPU/memoria; la imagen debe contener las herramientas del proyecto.

Las comprobaciones de archivos tampoco sustituyen un sandbox frente a un proceso local que cambie rutas concurrentemente. La blocklist de nombres no detecta secretos guardados bajo cualquier nombre. Usa un checkout de confianza sin secretos; Docker aporta aislamiento práctico cuando se configura, pero no convierte automáticamente imágenes o scripts del proyecto en confiables.

## SDK

```js
import { createForge, FakeProvider } from './dist/packages/sdk/src/index.js';

const forge = await createForge({
  workspace: process.cwd(),
  provider: new FakeProvider(),
  model: 'scripted',
  shellPolicy: 'deny',
  emit: event => { if (event.type === 'model:text') process.stdout.write(event.text); },
});
try { await forge.run('Hello'); }
finally { await forge.close(); }
```

`core` define mensajes, eventos, tools y provider contracts; `providers` adapta protocolos; `auth` resuelve credenciales; `runtime` aplica rutas/permisos; `tools` ejecuta; `sdk` compone; `cli` presenta y solicita aprobación. Los paquetes internos son privados y se compilan juntos; la API es provisional.

En el SDK, `roleProviders` permite fijar un provider/model por rol (`planner`, `implementer`, `reviewer`, `verifier` o `researcher`) cuando una aplicación quiere controlar la orquestación directamente.
`evidenceStore` registra resultados agregados de skills/workflows, `eventLog` recibe eventos redaccionados, `mcpServers` conecta herramientas MCP opt-in y `sandbox` puede seleccionar el runner Docker. Llama a `forge.close()` al terminar cuando se hayan conectado servidores MCP.

## Verificación y alcance

Las pruebas no consumen tokens: fake provider, OAuth contra servidores simulados, transportes SSE de Codex/Claude/Kimi/Gemini/Qwen, tools reales, procesos, sesiones, routing, workflows y CLI. Los tests offline no prueban disponibilidad ni permisos de una cuenta real.

La CI valida Windows, macOS y Linux, incluida la instalación local y global del tarball, `npx`, `pnpm dlx`, el binario y los exports SDK. La telemetría remota no existe. El modo host de shell y los servidores MCP siguen siendo procesos del host; el modo Docker es opt-in y requiere Docker e imagen confiable. Windows Sandbox nativo, imágenes reproducibles y publicación npm quedan para el siguiente milestone. El paquete es público en GitHub y todavía no se ha publicado en npm.

Decisiones: [docs/decisions/001-v0.1.md](docs/decisions/001-v0.1.md).

## Landing visual

La primera shell web de MARS vive en apps/site y sigue el sistema editorial de design.md: fondo bone, rails Mars red, serif de display, mono técnico, reglas finas y assets halftone.

    pnpm site

Abre http://127.0.0.1:4173. El servidor es estático y no añade dependencias de frontend. La navegación móvil, el botón de copiar, los reveals y el parallax del planeta respetan prefers-reduced-motion.
# Inicio interactivo

`/permissions` abre el selector de permisos de shell. `/permissions allow`
permite shell durante la sesión; `/permissions allow project` guarda esa
preferencia en el proyecto; `/permissions ask` vuelve a preguntar. No cambia
las políticas de red o comandos destructivos. La shell puede ejecutar código
arbitrario: el detector de comandos no sustituye al aislamiento de Docker.

Ejecuta `mars` para abrir la bienvenida centrada con logo MARS y compositor.
Si ya hay un proveedor conectado, usa el modelo guardado; Tab abre el selector
y Ctrl+P muestra los comandos. Enter envía la tarea y pasa a la conversación
con salida en streaming. La bienvenida se adapta al tamaño de la terminal y
restaura el cursor y el modo de entrada al salir. En terminales sin soporte TTY
o con `TERM=dumb` mantiene la entrada de texto sencilla.

El selector permite elegir proveedor y modelo con un menú numerado. Enter
acepta la opción marcada; `q` cancela. La elección queda guardada en el proyecto.
El selector utiliza el catálogo local y permite introducir otro ID; no consulta
la disponibilidad de tu cuenta ni consume tokens. Si falta autenticación, ofrece
el método disponible antes de entrar en la conversación.

`/model`, `/models` y `/providers` abren el selector. La conversación persistida
se conserva al cambiar de modelo; `/new` inicia otra. `--model provider:model`
omite el selector. Los marcadores como `MODEL` se rechazan antes de enviar nada.

El panel muestra proveedor, modelo, carpeta, tokens de entrada/salida reportados
desde que se abrió la terminal y porcentaje del límite local de contexto en
caracteres. Este porcentaje no es la ventana de tokens del proveedor. Codex y
OpenAI exponen uso real; si falta, se indica «no reportados» o «parcial».
