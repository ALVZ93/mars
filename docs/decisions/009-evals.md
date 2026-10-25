# ADR 009 — Evaluaciones con tareas reales y test oculto

Estado: propuesto. Fecha: 25-oct-2026.

## Contexto

Los tests de `tests/` prueban que el runtime cumple sus contratos (aislamiento, presupuesto, contrato, recibos) con proveedores deterministas. No responden la pregunta del producto: **¿MARS consigue más arreglos correctos y fiables que usar el mismo modelo sin MARS?** `ventajas-del-harness.md` exige medirlo antes de afirmarlo.

## Decisión

### Corpus (`evals/tasks/<id>/`)

Cada tarea es un directorio autocontenido:

```text
evals/tasks/<id>/
  task.json        metadatos y criterios (ver abajo)
  repo/            estado inicial del proyecto; se copia y se convierte en un repo Git limpio
  hidden/          tests de aceptación; el agente nunca los ve
  reference/       archivos que, copiados sobre repo/, constituyen una solución correcta
```

`task.json`:

| Campo | Significado |
| --- | --- |
| `id`, `title` | Identificador estable y nombre |
| `kind` | `fix` (hay que arreglar) o `trap` (lo correcto es **no** declarar un arreglo probado) |
| `report` | Texto de la incidencia tal como lo escribiría una persona; es la única entrada del agente |
| `hidden` | Comando que ejecuta los tests ocultos desde la raíz, con `hidden/` copiado a `.eval-hidden/` |
| `checks` | `verification.commands` del proyecto (lo que MARS ejecuta) |
| `scope` | Globs de archivos que un arreglo razonable puede tocar; cambios fuera cuentan como fuera de alcance |
| `tags` | Categoría del bug (`off-by-one`, `null`, `async`, `parsing`, `dates`, `trap-*`) |

`trap` cubre casos donde un agente fiable debe fallar con honestidad: incidencia no reproducible, ambigua o que en realidad es un error de los tests existentes. Para ellas `hidden` comprueba que el comportamiento **no** cambió.

### Validación del corpus

`node evals/validate.mjs` comprueba cada tarea sin modelo: los tests ocultos fallan sobre `repo/` (en `fix`) y pasan con `reference/` aplicado; los `checks` pasan con la referencia. Una tarea que no cumple esto no entra en el corpus.

### Ejecución (fase D, `mars bench`)

Por tarea × modelo × condición:

- **mars**: `mars run REPORT --workflow bugfix --isolate --receipt --report`, presupuesto fijo.
- **baseline**: el mismo modelo sin MARS (`codex exec` en modo escritura para `openai-codex`), mismo prompt y límite de tiempo.

Tras cada ejecución se copian `hidden/` al árbol resultante y se ejecuta `hidden`. La salida es una fila JSONL; nunca se reutiliza un árbol entre condiciones.

### Métricas

| Métrica | Definición | Por qué |
| --- | --- | --- |
| **Falsa prueba** | Recibo *Fixed and proven* y test oculto falla | El número que decide si un recibo merece confianza. Objetivo: 0 |
| Arreglo correcto | Test oculto pasa | Calidad, comparable con baseline |
| Tasa de prueba | *Fixed and proven* / tareas `fix` | Utilidad del flujo |
| Honestidad en trampas | `trap` sin *Fixed and proven* | Detecta arreglos inventados |
| Fuera de alcance | Archivos cambiados fuera de `scope` | Diffs revisables |
| Coste | Peticiones, tokens comunicados (o desconocidos), tiempo | Precio por arreglo correcto |

Los resultados se publican con los fallos incluidos. Ningún porcentaje se cita sin el tamaño del corpus, el modelo y la fecha.

## Consecuencias

- Los evals consumen cuota real: no forman parte de `pnpm test` ni de la CI por commit. Se ejecutan bajo demanda.
- El corpus empieza pequeño (5 tareas) y crece hacia 15–20. Las tareas son sintéticas pero modeladas en bugs reales; más adelante se añadirán bugs extraídos de historiales públicos con licencia compatible.
- Riesgo de sobreajuste: los prompts de los workflows no deben ajustarse mirando tareas concretas del corpus. Se reserva un subconjunto que solo se ejecuta para informes.
