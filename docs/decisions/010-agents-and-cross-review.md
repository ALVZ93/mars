# ADR 010 — Agentes declarativos y revisión cruzada entre motores

Estado: propuesto. Fecha: 30-oct-2026. Contexto de producto: [posicionamiento](../posicionamiento.md).

## Contexto

MARS deja de competir con Claude Code o Codex en calidad de arreglo y pasa a combinarlos. Hoy un engine (`--engine claude|codex`) solo puede hacer el workflow `bugfix`, y siempre uno solo. Falta:

1. Declarar qué agentes existen (motor, modelo, permisos) en ficheros del repo, como hace OpenCode.
2. Un workflow donde un motor implementa y otro, de otro proveedor, revisa; con la revisión devuelta al implementador.
3. Medir si la combinación acierta más que cada motor solo.

## Decisión

### Agentes: `.mars/agents/<nombre>.md`

Frontmatter con un subconjunto plano de YAML (`clave: valor` y listas `[a, b]`); el cuerpo son instrucciones que se añaden al prompt de ese agente.

```markdown
---
description: Revisa el diff contra el contrato documentado
engine: claude          # claude | codex
model: sonnet           # opcional; por defecto el del engine
effort: low             # opcional
edit: deny              # allow | deny — deny: solo lectura
commands: [npm, node]   # prefijos de shell permitidos
---
Céntrate en reglas documentadas que el diff no cumple. No comentes estilo.
```

- Nombre = nombre del fichero. Los del proyecto sustituyen a los integrados con el mismo nombre.
- Integrados: `codex` (Codex, edita) y `claude` (Claude Code, edita). `edit: deny` en un agente de revisión se impone además en el engine: Claude sin `Edit`/`Write`; Codex con sandbox `read-only`. MARS compara el árbol antes y después de cada revisión y rechaza la ejecución si cambió.
- Claude sigue exigiendo `ANTHROPIC_API_KEY` (o `MARS_EVAL_CLAUDE_LOGIN=1` en evaluación local).
- `mars agents` lista los agentes disponibles y de dónde vienen.

### Workflow `cross-review`

`mars run TAREA --workflow cross-review --implementer codex --reviewer claude`

1. **Implementa** (sesión del implementador): tarea + "cumple el contrato documentado; el test es el mínimo" + añade o actualiza tests + ejecuta los checks.
2. **Checks** de MARS; si fallan, reparación en la misma sesión (`--repair-attempts`).
3. **Revisa** (sesión del revisor, solo lectura): recibe la tarea, el diff que calcula MARS y el resultado de los checks; responde JSON `{ verdict: approve | changes, findings: [{ file, problem, fix }] }`.
4. Si `changes`: el implementador recibe los hallazgos (marcados como datos, no instrucciones), corrige, MARS repite checks y el revisor revisa otra vez. Máximo `--review-rounds` (por defecto 1 ronda de corrección).
5. El informe guarda cada revisión (`reviews[]`: ronda, agente, veredicto, hallazgos). El recibo muestra si la última revisión aprobó o si quedaron hallazgos abiertos; **un run con hallazgos abiertos no es "verificado"** aunque los checks pasen.

`bugfix` con `--engine` sigue igual. `--implementer`/`--reviewer` aceptan nombres de agente.

### Medición

Condiciones nuevas en `evals/run.mjs`: `xr-codex-claude` (Codex implementa, Claude revisa) y `xr-claude-codex`. Se comparan con `baseline` y `claude` con `--prompt contract`. Criterio de éxito del posicionamiento: la combinación acierta más que cualquiera de los dos motores solo, y en tareas no vistas al diseñarla.

## Consecuencias

- El routing, el coste por tarea y `AGENTS.md` como fuente única se apoyan en estas definiciones; quedan para ADR siguientes.
- Dos motores por tarea cuestan más tiempo y tokens. El informe ya suma uso por proveedor; el coste en dinero es el paso 2 del posicionamiento.
- Sin parser YAML completo: un frontmatter con anidamiento falla con un error claro en vez de interpretarse a medias.
