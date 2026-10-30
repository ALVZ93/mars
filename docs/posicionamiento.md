# Posicionamiento de MARS (borrador para decidir)

Borrador: 30 de octubre de 2026. Sustituye, si se aprueba, el foco de [dirección de producto](direccion-producto.md).

## Por qué cambiamos el tiro

Las evals del 30 de octubre ([RESULTS](../evals/RESULTS.md)) lo dejan claro: con la misma instrucción, Codex solo arregla 16/16 bugs difíciles y MARS + Codex también 16/16, en el doble de tiempo. Competir con Anthropic u OpenAI en *cómo de bien arregla el modelo* es una carrera perdida: ellos tienen el cómputo y mejoran cada trimestre.

MARS no debe ser un agente mejor. Debe ser **la capa que coordina, controla y abarata los agentes que un equipo ya usa**.

## Para quién

Equipos que trabajan con agentes de IA sobre **código que va a producción**, sea un proyecto nuevo o uno legacy, con varias personas tocando el mismo repositorio. El valor crece con el tamaño del código y del equipo, pero el producto no se especializa en un tipo de proyecto. Para un desarrollador solo con un proyecto pequeño, Claude Code o Codex a pelo suelen bastar.

## El problema que tienen hoy

| Necesidad del equipo | Qué hay hoy | Hueco |
| --- | --- | --- |
| Usar el mejor modelo para cada tarea | Cada CLI empuja su modelo; OpenCode y Hermes permiten elegir, pero a mano o por reglas fijas | Nadie decide **con datos del propio repositorio** qué modelo rinde mejor en cada tipo de tarea |
| Combinar modelos (uno hace, otro revisa) | Orquestadores en paralelo (Conductor, Claude Squad, Composio): lanzan agentes lado a lado | Paralelo no es complementario: falta el flujo "Codex implementa → Claude revisa → evidencia" |
| Saber cuánto cuesta y en qué se va | Facturas por proveedor | Coste por tarea, persona y tipo de trabajo; presupuestos que cortan |
| Confiar en lo que llega a `main` | Diff y PR | Evidencia verificable de qué se comprobó (tests, checks, alcance), igual venga de un modelo o de otro |
| Reglas del equipo | CLAUDE.md, AGENTS.md, opencode.json, cada uno a su manera | Una sola configuración del equipo que se aplica a todos los motores |

## Qué es MARS

**Un orquestador de agentes de código para equipos: elige el motor por tarea con datos, combina motores en workflows, controla el gasto y deja evidencia de cada cambio.**

1. **Routing medido.** El harness de evals ya existe: se convierte en producto. `mars bench` sobre las tareas del propio equipo dice qué modelo (o combinación) rinde mejor por tipo de tarea y coste; el router usa esos datos. Ni Hermes ni OpenCode hacen esto con datos del repositorio del cliente.
2. **Workflows multi-motor.** Workflows declarativos donde cada paso nombra su motor: implementar con Codex, revisar con Claude, verificar con los checks del proyecto. Los engines `--engine claude|codex` ya son la base.
3. **Coste y presupuesto.** Tareas fáciles a modelos baratos o locales; difíciles a frontera. Coste por tarea en el informe. Presupuestos ya implementados.
4. **Evidencia y control.** Worktrees aislados, recibos, contrato protegido de tests. Se mantiene, pero como garantía, no como argumento de "arregla mejor".
5. **Personalizable.** Workflows, skills, memoria revisada y reglas en ficheros del repo, como OpenCode o Hermes.

## Qué NO es

- No es otro agente que compite con Claude Code o Codex en calidad de arreglo.
- No es un lanzador de agentes en paralelo con dashboard (ese mercado ya está cubierto).
- No es un asistente personal general (eso es Hermes).

## Criterios de éxito medibles

1. **Coste:** a igual tasa de acierto que el mejor motor solo, ≥30 % menos coste por tarea gracias al routing.
2. **Combinación:** un workflow "implementa A, revisa B" acierta más que A o B solos en un corpus que no hayamos visto al diseñarlo.
3. **Adopción en equipo:** un equipo configura sus reglas una vez y se aplican igual a Claude y a Codex, sin duplicar CLAUDE.md/AGENTS.md.

Si en un plazo razonable no se cumple ninguno de los tres, MARS no aporta lo suficiente y se para.

## Restricciones

- Claude solo con API key en el producto. Antes de publicar, revisar también los términos de OpenAI sobre usar el login de Codex de cada usuario desde una herramienta de terceros.
- Sin backend central ni telemetría: los datos de routing viven en el repositorio o la máquina del equipo.

## Qué funciona en la competencia y qué copiamos

Revisado en la documentación oficial el 30 de octubre de 2026 ([OpenCode](https://opencode.ai/docs/), [Hermes Agent](https://hermes-agent.nousresearch.com/docs/), [Aider](https://aider.chat/docs/usage/modes.html), [Orchestrator.inc](https://github.com/ComposioHQ/agent-orchestrator), [Claude Squad](https://github.com/smtg-ai/claude-squad), [Conductor](https://www.conductor.build/docs/)).

| De | Qué hacen | Qué copiamos en MARS |
| --- | --- | --- |
| OpenCode | Agentes como Markdown con frontmatter (`.opencode/agents/*.md`) o JSON: `description`, `mode` primary/subagent, `model`, `steps`, `permission`; el cuerpo es el prompt | **Agentes declarativos en `.mars/agents/*.md`** con motor y modelo por agente. Es la forma natural de escribir "Codex implementa, Claude revisa" |
| OpenCode | Permisos `allow`/`ask`/`deny` por herramienta, patrones glob para `bash`, gana la última regla, override por agente; `.env` pide permiso por defecto | **El mismo modelo de permisos**, traducido a cada motor (allowedTools de Claude, sandbox de Codex). Una política, todos los motores |
| OpenCode | `/init` genera `AGENTS.md`, que se commitea como reglas del proyecto | **Leer `AGENTS.md` como fuente única** de reglas y pasarla a Claude y Codex; no inventar otro formato |
| OpenCode | Plugins JS/TS con hooks (`tool.execute.before/after`, `session.*`, `permission.*`, `file.edited`) | **Hooks de plugin** con nombres parecidos sobre los eventos que MARS ya emite |
| OpenCode Enterprise | Configuración central, SSO, restringir a un gateway interno. La página no menciona auditoría ni control de costes | Confirma el hueco: **coste por tarea y registro auditable** son nuestros |
| Hermes | Slots auxiliares por tipo de tarea (`auxiliary.<tarea>.model/provider`) con `fallback_chain` | **Routing configurable por tipo de tarea con cadena de respaldo**, como base del routing medido |
| Hermes | Skills en el estándar abierto agentskills.io (`SKILL.md` + `references/`, `scripts/`…); escritura con aprobación (`write_approval`), skills del repo inactivas hasta `hermes skills trust` | **Adoptar el estándar `SKILL.md`** para que las skills sirvan también en Claude Code, Hermes y OpenCode. Ya tenemos aprobación de skills; añadir **trust por repositorio** |
| Hermes | Skills Hub con escaneo de seguridad y niveles de confianza | Más adelante: instalar skills de fuentes externas con escaneo y nivel de confianza |
| Aider | Modo *architect*: un modelo razona la solución y otro (más barato) escribe las ediciones | **Patrón de combinación probado**: incluirlo como workflow de serie y medirlo |
| Orchestrator.inc | Un agente planifica y reparte en workers, cada uno en su worktree; los fallos de CI, comentarios de review y conflictos vuelven al worker dueño de la rama; un agente revisor lee cada PR antes que un humano | **Bucle CI/review → mismo motor** y **revisor de otro proveedor** como paso de workflow. No copiamos el tablero ni la app móvil |
| Claude Squad / Conductor | Worktree y rama por tarea, diff, commit/push, perfiles `{name, program}` | Ya lo tenemos (`--isolate`, `mars runs`). Mercado saturado: no competimos aquí |

**Qué no copiamos:** mensajería en 20+ plataformas, voz, cron y personalidad (Hermes es un asistente personal); tableros de agentes en paralelo y apps móviles (Conductor, Orchestrator.inc).

**Huecos confirmados:** en la documentación revisada nadie elige el modelo con datos medidos en el repositorio del equipo, y OpenCode Enterprise no menciona auditoría ni costes. No he podido comprobar el seguimiento de costes de Hermes: su página de configuración es muy larga y solo leí la primera parte.

## Qué hacer con el código actual

- **Se queda:** engines, routing, presupuestos, aislamiento, recibos, workflows, memoria, harness de evals.
- **Se congela:** afinar prompts del workflow bugfix para ganar puntos de acierto.
- **Siguiente trabajo, en orden:**
  1. Agentes declarativos en `.mars/agents/*.md` (motor, modelo, permisos) y un workflow multi-motor implementa/revisa, medido contra cada motor solo.
  2. Coste por tarea en el informe.
  3. `AGENTS.md` como fuente única de reglas y permisos `allow`/`ask`/`deny` aplicados a todos los motores.
  4. `mars bench` sobre tareas del propio repositorio, alimentando el router.
  5. Skills en formato `SKILL.md` estándar.
