# ADR 008 — Bugfix con prueba rojo→verde, contrato protegido y recibos

Estado: aceptado (fase B de [propuesta-claude.md](../propuesta-claude.md)). Fecha: 25-oct-2026.

## Contexto

Que los checks pasen no demuestra que el bug estuviera reproducido ni que el modelo no haya debilitado el test. `ventajas-del-harness.md` lo recogía como límite: «nada impide que el modelo altere tests o scripts».

## Decisión

### 1. `bugfix` exige reproducción

Fases: `inspect` (solo lectura) → `reproduce` → `implement` → `verify`.

- `reproduce` solo puede leer, buscar, consultar Git y escribir archivos; sin shell. Termina llamando a `declare_reproduction({ command, files })`. Esa tool solo existe durante una fase con `reproduction: true`.
- MARS ejecuta el comando (mismos permisos y executor que los checks) sobre el árbol **sin arreglar**. Debe salir con código ≠ 0 y sin error del runner. Si pasa, si no puede ejecutarse (shell denegada, timeout, error) o si los archivos declarados no existen, el workflow falla: el bug no está reproducido.
- En `verify`, el comando de reproducción se ejecuta **primero**, seguido de los checks configurados o detectados. Los checks del proyecto siguen siendo obligatorios.
- Prueba = rojo antes + verde después + test sin cambios. Con los tests protegidos, el árbol de la fase roja es exactamente el «fix revertido», así que no hace falta una mutación adicional.

### 2. Contrato de tarea

- Archivos protegidos: los declarados en la reproducción más los que existan y encajen con `contract.protect` (globs relativos al workspace; opción SDK `protect`).
- `write_file` sobre un archivo protegido se deniega durante el resto del workflow. Los archivos nuevos siguen permitidos.
- Antes de cada verificación (también tras cada reparación) MARS compara hashes SHA-256. Cualquier cambio por shell, MCP u otro medio falla el workflow **sin reparación**.
- Sin reproducción, el contrato se sella al empezar el workflow si hay `contract.protect`.

### 3. Recibo Markdown

`renderReceipt(reports)` (SDK) y `--receipt FILE.md` (CLI) producen un resumen para PR o revisión: veredicto, prueba, contrato, checks, cambios aislados y ejecución. Veredictos: *Fixed and proven*, *Verified*, *Contract violated*, *Not proven*, *Failed*, *Completed without verification*. Incluye comandos y salida truncada de checks; nunca prompts ni respuestas del modelo.

`RunReport` añade `proof` (comando, archivos, rojo con exit y salida, verde) y `contract` (archivos, modificados).

### 4. Endurecimiento tras la revisión de Codex (`3990a9d`)

- El comando de reproducción debe nombrar directamente los tests declarados. Todo archivo del workspace que nombre (runner, config) queda protegido **antes** de ejecutar el rojo.
- Un rojo con firma de error de carga (sintaxis, módulo inexistente, comando inexistente, exit 127/9009, `error TS`) se rechaza. Es una heurística: no distingue todos los fallos ajenos al bug, por eso el recibo muestra la salida del rojo para que el revisor la juzgue.
- Los globs de `contract.protect` se sellan al empezar el workflow, antes de la fase de reproducción. Las protecciones se acumulan conservando el hash original; un workflow admite como máximo una fase de reproducción.
- El contrato se comprueba tras el rojo, antes y después de cada ejecución de checks y antes de completar. Un cambio transitorio que se restaura entre dos comprobaciones no es detectable.
- Cualquier fase posterior a la verificación invalida el verde. *Fixed and proven* exige verde y `verificationStatus: passed`.
- Las rutas protegidas se comparan sin distinguir mayúsculas en Windows y macOS.
- Los checks detectados no repiten el comando de reproducción.
- El recibo escapa todos los valores dinámicos (spans de código y bloques `~~~`), redacta credenciales reconocibles y revalida su destino justo antes de escribir.

### 5. Segunda revisión de Codex (`1e6b720`, `537c812`)

- **Control con el test vaciado.** Tras el rojo, MARS vacía temporalmente los tests declarados y repite el comando. Si falla igual (mismo exit y misma salida sin tiempos ni contadores), el fallo no viene del test y la reproducción se rechaza. Cierra comandos que nombran el test sin depender de él (`node otro.mjs test.mjs`, umbrales de tiempo). Los tests se restauran byte a byte y el contrato lo comprueba.
- **Sin código inline.** `node -e`, `python -c`, `sh -c` y equivalentes no valen como reproducción.
- **La fase de reproducción solo escribe tests.** Solo puede escribir archivos nuevos o rutas de test convencionales (`tests/`, `__tests__/`, `*.test.*`, `*_test.*`, `test_*.py`…). Shell y MCP se deniegan aunque el workflow los permita. Así no puede romper código de producción para fabricar un rojo.
- **Contrato entre comandos y verde final.** El contrato se comprueba después de cada comando de verificación, no solo alrededor del lote. Al terminar todas las fases y checks, MARS repite la reproducción sobre el árbol entregado: si ya no pasa, el workflow falla. El verde del recibo es siempre el de ese árbol.
- **Recibo.** Título, workflow e IDs pasan por escape. Los `|` de comandos no rompen las tablas. El recibo muestra el resultado del control.
- **Runner de Codex.**
  - La cancelación espera a que todo el árbol de procesos termine antes de resolver y escala a `SIGKILL`.
  - Un cierre temprano de stdin (`EPIPE`) rechaza el turno en vez de tumbar MARS.
  - JSONL inválido o un turno sin `turn.completed` se rechazan.
  - Se conserva `cli_auth_credentials_store` del usuario para que `exec` lea las credenciales del mismo almacén que `codex login`.
  - Tests propios con un CLI simulado (`tests/codex-runner.test.mjs`).

- **Respuesta vacía tras declarar.** Algunos modelos terminan la fase de reproducción con un mensaje vacío; si ya hay una declaración válida, la fase continúa. Sin declaración sigue siendo un fallo del proveedor.
- **Validación real.** `bugfix` con `openai-codex:gpt-5.6-sol` sobre un off-by-one sembrado, con `--isolate`: *Fixed and proven* en 86 s, control con el test vaciado en exit 0.

Límites conocidos:
- `--ignore-user-config` no desactiva `AGENTS.md`, skills ni `.rules` del usuario.
- Las herramientas nativas de Codex (sandbox de solo lectura, sin aprobaciones) solo están limitadas por la configuración del hilo y el prompt.
- El control detecta fallos independientes del contenido del test, no un test escrito para fallar por otra razón que sí depende de su contenido.

## Consecuencias

- Un `bugfix` sin un test automatizable ya no puede completarse; para esos casos queda `feature`.
- El agente necesita declarar un comando que ejecute **solo** su test. Un comando que corre toda la suite también vale si falla por el bug, pero el recibo es menos preciso.
- La detección por hash no impide la escritura por shell, solo garantiza que no pase desapercibida.
- Verificado: `tests/proof.test.mjs` (20 casos: 12 iniciales + 8 regresiones de la revisión) cubre camino feliz, reproducción que ya pasa, runner roto, shell denegada, declaración ausente, archivo inexistente, escritura denegada al test, manipulación por shell sin reparación, `contract.protect` en `feature` y validación de config.
