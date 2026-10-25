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

## Consecuencias

- Un `bugfix` sin un test automatizable ya no puede completarse; para esos casos queda `feature`.
- El agente necesita declarar un comando que ejecute **solo** su test. Un comando que corre toda la suite también vale si falla por el bug, pero el recibo es menos preciso.
- La detección por hash no impide la escritura por shell, solo garantiza que no pase desapercibida.
- Verificado: `tests/proof.test.mjs` (12 casos) cubre camino feliz, reproducción que ya pasa, runner roto, shell denegada, declaración ausente, archivo inexistente, escritura denegada al test, manipulación por shell sin reparación, `contract.protect` en `feature` y validación de config.
