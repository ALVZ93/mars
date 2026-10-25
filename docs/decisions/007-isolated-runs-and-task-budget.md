# ADR 007 — Ejecuciones aisladas en Git y presupuesto global de tarea

Estado: aceptado (fase A de [propuesta-claude.md](../propuesta-claude.md)). Fecha: 25-oct-2026.

## Contexto

- Los límites (`maxTurns`, `maxToolCalls`, `timeoutMs`) se aplican por llamada a `runAgent`. Un workflow con fases y reparaciones puede multiplicarlos sin un tope común.
- El agente escribe directamente en el árbol del usuario. No se puede distinguir su diff de cambios previos, deshacerlo con seguridad ni comparar dos ejecuciones.

## Decisión 1 — `TaskBudget`

Un presupuesto por operación (`run`, `runWorkflow`, `verify`) compartido por todas las fases, reparaciones y reintentos:

| Límite | Opción SDK | Config | Flag |
| --- | --- | --- | --- |
| Duración total | `budget.maxDurationMs` | `budget.maxDurationMs` | `--budget-time MS` |
| Peticiones al modelo | `budget.maxModelRequests` | `budget.maxModelRequests` | `--budget-requests N` |
| Tokens comunicados (entrada+salida) | `budget.maxTokens` | `budget.maxTokens` | `--budget-tokens N` |

- Se comprueba **antes** de cada petición al modelo envolviendo el proveedor; nunca corta una tool en curso. La duración aborta la operación mediante la señal compartida.
- Agotar el presupuesto produce `MarsError('BudgetExceededError')` y estado `failed`; no dispara reparaciones ni reintentos.
- Tokens: solo cuentan los comunicados por el proveedor. Si una respuesta llega sin uso, el informe marca `tokensKnown: false` y `tokens` pasa a ser una cota inferior; no se trata como cero ni se inventa.
- `RunReport.budget` registra límites, consumo y el límite agotado, si lo hay.

## Decisión 2 — Sesiones aisladas en `git worktree`

`isolation: 'worktree'` (SDK) / `--isolate` (CLI, solo tareas no interactivas):

1. **Base exacta**: MARS crea un commit con el estado actual del árbol, incluidos cambios sin commitear y archivos no ignorados, usando un índice temporal (`GIT_INDEX_FILE`). No toca el índice, el stash ni las ramas del usuario.
2. El worktree se crea *detached* en `<git-common-dir>/mars/worktrees/<id>`, fuera del árbol de trabajo, para que búsquedas y Git del workspace original no lo vean.
3. Tools, shell y checks operan en el worktree. Sesiones, eventos, evidencia y conocimiento siguen en el workspace original.
4. Al terminar cada operación MARS captura el resultado como commit y actualiza `refs/mars/runs/<id>/base` y `refs/mars/runs/<id>/result`. El diff `base..result` es exclusivamente trabajo del agente.
5. Comandos: `mars runs`, `mars diff ID`, `mars apply ID`, `mars discard ID`.
   - `apply` comprueba primero con `git apply --check` y solo entonces aplica el diff al árbol de trabajo, sin tocar el índice. Si no aplica limpiamente no cambia nada. No hay modo `--3way`: Git lo implementa sobre el índice del usuario; queda pendiente un merge con índice temporal. Nunca hay rollback destructivo.
   - `discard` elimina worktree y refs. Nunca toca el árbol del usuario.
6. La sesión persiste `metadata.isolation`. Reanudarla reutiliza su worktree sin necesidad de `--isolate`; si el run se descartó o se pide `isolation: 'none'`, falla en lugar de escribir en el árbol del usuario.
7. Los servidores MCP cuyo `cwd` está dentro del workspace arrancan en la ruta equivalente del worktree.

Requiere un repositorio Git con al menos un commit. Sin Git, `--isolate` falla con un error de configuración; no hay degradación silenciosa. Se rechazan explícitamente, hasta soportarlos: repositorios con submódulos (su contenido no se captura ni se restaura) y el sandbox Docker (el contenedor no vería los metadatos Git ni las dependencias enlazadas).

### Operaciones Git propias de MARS

Revisión de Codex sobre `52ae11e`; cada punto tiene test en `tests/isolation.test.mjs`.

- `core.hooksPath` apunta a un directorio vacío y privado fuera de cualquier repositorio: nada que escriba el agente se convierte en hook (p. ej. `reference-transaction` al actualizar refs).
- Los snapshots del worktree leen atributos del commit base (`GIT_ATTR_SOURCE`): un `.gitattributes` escrito por el agente no activa filtros `clean`. Los filtros configurados por el usuario (p. ej. LFS) siguen siendo de confianza, igual que en su uso normal de Git.
- `diff.noprefix`, `diff.mnemonicPrefix`, `diff.relative` y `apply.whitespace` se fijan por línea de comandos; el diff usa prefijos `a/`/`b/` explícitos y `apply -p1`.
- El presupuesto se vuelve a comprobar tras persistir y capturar el resultado: una operación que termina fuera de presupuesto nunca deja un recibo de éxito. Un intento sin uso comunicado, incluido uno fallido, marca `tokensKnown: false`.

## Consecuencias

- Los checks se ejecutan en el worktree. Para que funcionen sin reinstalar, `node_modules` del workspace se enlaza (junction en Windows, symlink en macOS/Linux; `linkDependencies: false` lo desactiva). Contrapartida: un `npm install` dentro del run escribe en las dependencias reales del usuario. Las herramientas de archivos siguen bloqueando rutas enlazadas y `discard` elimina solo el enlace.
- `.mars/` y `node_modules/` nunca se capturan en los snapshots; sus entradas versionadas se conservan desde el commit padre.
- Los worktrees aislados y los refs `refs/mars/runs/*` viven en el repositorio local; no se publican con un `git push` normal.
- Verificado: 9 tests en `tests/isolation.test.mjs` y prueba CLI real (`--isolate` → `runs diff/apply/discard`, `--budget-requests`).
- Habilita la fase B (prueba rojo→verde revirtiendo el diff de producción) y `mars bench` (varias ejecuciones sobre la misma base).
