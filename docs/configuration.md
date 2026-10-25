# Configuración y datos locales

MARS combina defaults, configuración de usuario, configuración del proyecto, entorno y flags. El valor más específico gana: flags → entorno → proyecto → usuario → defaults.

## Rutas

| Dato | Windows | macOS/Linux |
| --- | --- | --- |
| Configuración de usuario | `%APPDATA%\\mars\\config.json` | `${XDG_CONFIG_HOME:-~/.config}/mars/config.json` |
| Configuración del proyecto | `<workspace>\\.mars\\config.json` | `<workspace>/.mars/config.json` |
| Sesiones | `<workspace>\\.mars\\sessions` | `<workspace>/.mars/sessions` |
| Evidencia | `<workspace>\\.mars\\evidence.json` | `<workspace>/.mars/evidence.json` |
| Eventos locales | `<workspace>\\.mars\\events.jsonl` | `<workspace>/.mars/events.jsonl` |
| Memoria y procedimientos revisados | `<workspace>\\.mars\\knowledge.json` | `<workspace>/.mars/knowledge.json` |
| Credenciales en modo `file` | `%APPDATA%\\mars\\auth.json` | `${XDG_CONFIG_HOME:-~/.config}/mars/auth.json` |

Las credenciales usan el almacén del sistema por defecto. `MARS_CREDENTIAL_STORE=file` habilita expresamente el archivo JSON de desarrollo. No guardes claves en `.mars/config.json`, `AGENTS.md`, skills ni configuración MCP versionada.

## Configuración completa de proyecto

```json
{
  "model": {
    "default": "openai:MODEL"
  },
  "knowledge": {
    "enabled": true
  },
  "routing": {
    "enabled": true,
    "planner": "openai:MODEL",
    "implementer": "openai:MODEL",
    "reviewer": "anthropic:MODEL",
    "verifier": "openai:MODEL"
  },
  "permissions": {
    "shell": "ask",
    "destructiveShell": "deny",
    "network": "ask",
    "gitCommit": "ask",
    "gitPush": "ask"
  },
  "limits": {
    "maxTurns": 24,
    "maxToolCalls": 64,
    "timeoutMs": 120000,
    "maxContextChars": 200000,
    "maxRetries": 0,
    "retryDelayMs": 500
  },
  "verification": {
    "commands": ["pnpm typecheck", "pnpm test"],
    "maxRepairAttempts": 0
  },
  "mcp": {
    "servers": [
      {
        "name": "local",
        "command": "node",
        "args": ["./mcp-server.mjs"],
        "cwd": ".",
        "timeoutMs": 30000
      }
    ]
  }
}
```

`allow`, `ask` y `deny` son los únicos valores válidos para permisos. `verification.commands` sustituye la detección automática de scripts y permite verificar proyectos sin `package.json`; cada comando atraviesa los mismos permisos y sandbox que la shell del agente. Los servidores MCP se inician por stdio y su `cwd` se resuelve desde el workspace.

## Comandos de configuración

```sh
mars config show
mars config path
mars config set model.default openai:MODEL
mars config set permissions.shell ask
mars config set routing.enabled true
mars config set verification.commands '["cargo test","cargo clippy"]'
mars config set verification.maxRepairAttempts 1
mars config set knowledge.enabled false
mars config set mcp.servers '[{"name":"local","command":"node","args":["./mcp-server.mjs"]}]'
```

`mars config set` escribe la configuración del proyecto de forma atómica.

## Reparación e informes

`verification.maxRepairAttempts` admite enteros de 0 a 3; default 0. `--repair-attempts N` lo sustituye para la invocación y requiere `--workflow`. Los workflows `bugfix` y `feature` reutilizan el implementador tras un check ejecutado con exit code no cero, repasan la verificación y repiten la lista original de comandos. El límite se comparte entre fases. `review`, permisos denegados, ausencia de checks, errores del executor, timeout y cancelación no disparan reparación. Los límites de turnos y tiempo son por fase; el presupuesto global de la sección siguiente cubre la operación completa.

```sh
mars run "Corrige la regresión" --workflow bugfix --repair-attempts 1 --report reports/bugfix-001.json
```

`--report PATH` exporta JSON de las operaciones de una tarea no interactiva, también tras fallo. El destino debe ser un archivo nuevo permitido dentro del workspace; `.mars` y otras rutas sensibles quedan excluidas. `--verify` añade una operación de verificación al informe. El SDK expone `mars.lastRun` y el tipo público `RunReport`.

El informe contiene comandos y salida de checks, que pueden incluir datos privados; no incluye campos de prompts ni respuestas del modelo. Los tokens son solo los comunicados por el proveedor, sin estimación de coste. `--no-save` no cancela una exportación solicitada expresamente con `--report`. Consulta las [ventajas y límites del harness](ventajas-del-harness.md).

## Presupuesto global y ejecuciones aisladas

`budget.maxDurationMs`, `budget.maxModelRequests` y `budget.maxTokens` limitan una operación completa (todas las fases, reparaciones, reintentos y checks). Sin valor, no hay límite. Los flags `--budget-time`, `--budget-requests` y `--budget-tokens` los sustituyen para la invocación. Se comprueban antes de cada petición al modelo; agotarlos devuelve `BudgetExceededError` y el informe registra `budget.exceeded`. Los tokens no comunicados marcan `tokensKnown: false`.

```sh
mars config set budget.maxModelRequests 40
mars run "Corrige la regresión" --workflow bugfix --repair-attempts 2 --budget-time 900000
```

`--isolate` ejecuta la tarea en un `git worktree` desechable creado desde el estado actual del árbol (incluidos cambios sin commitear). Tu árbol no se modifica hasta que lo apliques:

```sh
mars run "Añade la validación" --isolate
mars runs                     # lista ejecuciones aisladas
mars runs diff ID [--stat]    # diff exacto del agente
mars runs apply ID            # aplica al árbol de trabajo, sin tocar el índice
mars runs discard ID          # elimina worktree y refs
```

Requiere Git con al menos un commit; no admite submódulos ni `--sandbox docker` por ahora. `node_modules` se enlaza al worktree para que los checks funcionen. `mars resume ID` reabre el mismo worktree. Detalles en [ADR 007](decisions/007-isolated-runs-and-task-budget.md).

## Bugfix con prueba y contrato

`--workflow bugfix` exige un test que reproduzca el bug: el agente lo escribe y lo declara, MARS comprueba que falla antes del arreglo y que pasa después, y el test queda protegido. `contract.protect` añade globs que ningún workflow puede modificar:

```json
{ "contract": { "protect": ["tests/**", "fixtures/**"] } }
```

```sh
mars run "add() devuelve un resultado incorrecto" --workflow bugfix --isolate --receipt reports/add-fix.md
```

`--receipt` escribe un resumen Markdown listo para un PR. Detalles en [ADR 008](decisions/008-bugfix-proof-contract-and-receipts.md).

## Instrucciones y skills

La CLI incorpora notas y skills aprobadas de `.mars/knowledge.json` cuando `knowledge.enabled` está activo y no se usa `--no-save`. Pendientes, rechazadas y supersedidas no se cargan. La configuración se aplica al iniciar/reanudar una sesión; las aprobaciones y eliminaciones se refrescan al empezar cada fase. `includeProjectContext: false` desactiva la carga automática en el SDK. Consulta [memoria y captura local de procedimientos](direccion-producto.md) para revisar, aprobar y olvidar entradas.

MARS carga `AGENTS.md` desde los directorios padre hasta el workspace y después `.mars/instructions.md`. Las instrucciones más cercanas al proyecto aparecen al final del contexto.

Una skill de proyecto vive en `.mars/skills/<nombre>/SKILL.md`; una skill personal, en `~/.mars/skills/<nombre>/SKILL.md`. Si comparten nombre, prevalece la del proyecto. MARS selecciona hasta tres skills relevantes en cada tarea.

Las skills aprobadas del almacén participan en esa selección: prevalecen los archivos de skill del proyecto, después las propuestas aprobadas y finalmente las skills personales del mismo nombre. Las notas aprobadas tienen un presupuesto JSON conjunto de 8.000 caracteres, cada nota hasta 1.200; cada procedimiento admite hasta 10.000. El almacén limita el total a 256 entradas y 1 MB. Se puede liberar espacio con `forget`; no se elimina conocimiento automáticamente.

```text
.mars/
  instructions.md
  skills/
    testing/
      SKILL.md
```

## Limpieza y actualización

```sh
mars auth logout PROVIDER
mars auth migrate
mars evidence clear
npm install --global @alvz93/mars@latest
```

`mars auth migrate` copia el antiguo `auth.json` al llavero nativo, verifica cada entrada y solo después elimina el archivo. Si una copia falla, conserva el archivo completo para poder reintentar. Para borrar historial local, elimina `.mars/sessions` y `.mars/events.jsonl` dentro del workspace. Para reiniciar la configuración, elimina el `config.json` correspondiente. El logout borra la entrada del proveedor del almacén nativo; no elimines todo el llavero del sistema.
