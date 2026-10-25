# Propuesta de producto — «MARS: cambios con prueba»

Autor: Claude (revisión externa), 25-oct-2026. Documento de discusión para Codex y el mantenedor; nada de esto está implementado.

## Diagnóstico

MARS ya tiene algo que la mayoría de harnesses no tiene: **el runtime, no el modelo, es dueño de la verdad** (checks con exit code, fases read-only forzadas, reparación acotada, informes, memoria que exige aprobación). El problema es que hoy eso se presenta como una lista de capacidades de harness genérico (providers, tools, MCP, skills, workflows…). Nadie elige un harness por la lista; lo elige porque hace **una tarea concreta mejor que Codex/Claude Code**.

Tesis: **MARS es el harness cuyo resultado puedes mergear sin leer la transcripción.** Cada tarea termina en un *recibo* verificable, no en un mensaje del modelo.

Wedge inicial: **bugs y regresiones con prueba** («MARS arregla el bug y demuestra que lo ha arreglado»). Segundo wedge: **upgrades de dependencias / migraciones mecánicas** hasta CI verde. Ambos son verificables, repetitivos, caros en tiempo humano y donde el valor del runtime (checks, reparación, aislamiento) supera al del modelo.

## Ideas, por impacto

### 1. Prueba rojo→verde automática (bugfix con evidencia)

El workflow `bugfix` pasa a ser *reproduce-first*:

1. `reproduce`: el agente escribe un test o script que falla. MARS lo ejecuta y **exige** exit ≠ 0 sobre el árbol original.
2. `implement`: corrige.
3. MARS ejecuta el test → debe pasar.
4. **Prueba de mutación inversa**: MARS revierte temporalmente el diff de producción (manteniendo el test) y comprueba que el test vuelve a fallar. Si no falla, el test no prueba nada → la tarea no se marca verificada.

Esto no lo hace ningún agente generalista y es barato (dos ejecuciones extra). Es la frase de marketing: *«MARS no dice que lo ha arreglado; lo demuestra»*.

### 2. Contrato de tarea con tests bloqueados

Ataca el límite reconocido en `ventajas-del-harness.md` («nada impide que el modelo altere tests»):

- Antes de implementar, el contrato (tests de aceptación, archivos protegidos, comandos de check) se fija y el usuario lo aprueba.
- MARS guarda hashes de los archivos del contrato. Cualquier escritura sobre ellos durante `implement`/`repair` se deniega o marca el recibo como `contract-modified`.
- `.mars/config.json`: `"protect": ["tests/**", "package.json#scripts"]`.

### 3. Aislamiento Git por ejecución (prerrequisito de confianza)

Hoy no hay worktrees ni checkpoints Git (`grep worktree` → nada). Propuesta:

- Cada `mars run` trabaja en un `git worktree` en `refs/mars/runs/<id>`; checkpoint por turno como commit en ese ref.
- `mars diff <run>`, `mars apply <run>`, `mars undo <run>`, `mars runs`.
- Atribución exacta: el diff del recibo es solo trabajo del agente, nunca cambios previos del usuario.
- Habilita ejecuciones en paralelo y comparar modelos sobre la misma tarea (idea 5).

### 4. Recibo de cambio («MARS Receipt»)

Evolución de `RunReport` a artefacto de primera clase:

- Diff atribuido + hash del árbol verificado (los checks valen para *ese* árbol).
- Prueba rojo→verde, contrato intacto/alterado, checks con salida acotada.
- Hallazgos del revisor (idea 6), reparaciones, modelos, tokens/coste, duración.
- Render a Markdown para comentario de PR y a GitHub Check Run. `mars receipt <run> --format md`.

El recibo es lo que se ve en el PR y lo que hace que otra persona diga «este PR lo hizo MARS, me fío».

### 5. `mars bench`: qué modelo funciona en *mi* repo

MARS es independiente del proveedor; esa es su ventaja estructural frente a Codex/Claude Code, y hoy apenas se explota.

- Suite local de tareas (`.mars/bench/*.json`: tarea + checks de aceptación + commit base).
- Ejecuta N modelos × configuraciones en worktrees aislados; tabla de tasa de éxito verificada, coste, tiempo, reparaciones.
- Alimenta el routing: `routing.strategy: "evidence"` elige el modelo con mejor relación éxito/coste por rol **para este repo**, usando la evidencia que ya se registra.

Producto: «deja de adivinar qué modelo usar; MARS lo mide».

### 6. Revisión cruzada entre proveedores

Implementador modelo A, revisor modelo B de otro proveedor, con contexto limpio: solo contrato + diff + salida de checks, tools read-only. Hallazgos con archivo/línea al recibo. Si B bloquea, una ronda de reparación. Es la «revisión independiente» que el propio roadmap marca como pendiente, y el multi-proveedor la hace natural.

### 7. Modo headless / CI y GitHub

- `mars ci` (sin TTY, permisos desde config, exit codes estables, recibo como salida).
- GitHub Action: issue con label `mars:fix` → rama + PR con recibo. Dependabot/Renovate PR rojo → MARS intenta dejarlo verde con N reparaciones.
- Esto convierte MARS en algo que un equipo instala, no solo un CLI personal.

### 8. Consola local (`mars ui`)

Servidor local (ya hay `apps/site/server.mjs` como base) con: ejecuciones y recibos, diff por run con apply/undo, cola de revisión de memoria/skills (hoy incómoda por CLI), resultados de `bench`. Sin backend central, coherente con la promesa local-first.

### 9. Presupuesto global (ya priorizado)

Tiempo, peticiones y tokens compartidos por todas las fases y reparaciones; corte antes de la siguiente llamada; registrado en el recibo. Necesario para que `bench` y `ci` sean seguros.

## Qué no hacer (por ahora)

Más providers, swarm/subagentes arbitrarios, chat UI genérica, marketplace, RAG/vector DB. Ninguno refuerza la tesis «cambio con prueba».

## Orden propuesto

| Fase | Entrega | Por qué primero |
| --- | --- | --- |
| A | Aislamiento Git (3) + presupuesto global (9) | Base de confianza y prerrequisito del resto |
| B | Bugfix rojo→verde (1) + contrato protegido (2) + recibo MD (4) | El wedge: demo de 30 s que nadie más hace |
| C | Revisión cruzada (6) + `mars ci` / Action (7) | Lleva el recibo al PR y al equipo |
| D | `mars bench` + routing por evidencia (5) | Explota la independencia de proveedor |
| E | `mars ui` (8) | Hace todo lo anterior visible y revisable |

## Pendiente tras las tareas principales: coste por tarea

Medido el 25-oct-2026 con `openai-codex:gpt-5.6-sol`. Cada llamada a Codex paga ~16k tokens de entrada fijos: el prompt base de Codex más las skills y el `AGENTS.md` del usuario. El ~90 % llega cacheado. MARS hace más llamadas que `codex exec` (una por paso de herramienta), así que reporta +13 % frente a la baseline en la tarea de paginación.

1. Registrar `cached_input_tokens` en informes y recibos: hoy todo el input se cuenta como nuevo y se sobrestima el coste.
2. Omitir la fase de revisión `verify` cuando MARS va a ejecutar los checks igualmente.
3. Excluir skills y `AGENTS.md` del usuario en las llamadas de MARS a Codex, como ya se hace con MCP y plugins.
4. Volver a ejecutar los evals y comparar el coste antes y después.

## Métrica norte

**% de tareas que terminan en un recibo verificado (rojo→verde + contrato intacto + revisión sin bloqueos) y se mergean sin cambios humanos.** Medido con `bench` sobre tareas reales, publicado con fallos incluidos, como ya exige `ventajas-del-harness.md`.
