# ADR 011 — Lista de features y bucle `mars next`

Estado: propuesto. Fecha: 7-nov-2026. Contexto: [posicionamiento](../posicionamiento.md), [ADR 010](010-agents-and-cross-review.md) y el patrón de "harness engineering" (features del tamaño de una sesión, estado verificado, validación independiente, el flujo en código y no en prosa).

## Contexto

Con `cross-review` una tarea queda implementada, comprobada y revisada por otro motor. Falta lo que conecta tareas en un proyecto: qué hay que hacer, en qué orden, qué está hecho de verdad y qué está bloqueado. Si eso vive en un prompt o en un `PROGRESS.md` que edita el modelo, el modelo puede saltárselo o marcar algo como hecho sin estarlo.

## Decisión

### `.mars/features.json`: la fuente única del estado

```json
{
  "version": 1,
  "agents": { "implementer": "codex", "reviewer": "claude" },
  "features": [
    {
      "id": "booking-free-slot",
      "title": "A member books a free slot",
      "description": "Opcional: contexto en una o dos frases.",
      "dependsOn": ["auth-login"],
      "spec": "docs/specs/booking-free-slot.md",
      "acceptance": ["Booking a free slot shows it as taken", "Booking a taken slot is rejected"],
      "verify": ["pnpm test -- booking"],
      "status": "not_started"
    }
  ]
}
```

- Las personas escriben `id`, `title`, `description`, `dependsOn`, `spec`, `acceptance` y `verify`. JSON y no Markdown: los modelos lo reescriben menos de forma indebida, y MARS lo valida (ids únicos, dependencias existentes, sin ciclos).
- **Solo MARS cambia `status`, `attempts` y `evidence`.** Durante una ejecución MARS conserva su copia; lo que un motor escriba en el fichero se descarta al guardar.
- Estados: `not_started` → `in_progress` → `passing` (checks en verde, revisión con hallazgos abiertos) → `accepted` (checks en verde y revisor que aprueba). `blocked` tras agotar intentos: lo desbloquea una persona devolviéndolo a `not_started`.

### `mars next`

`mars next [--implementer A --reviewer B] [--max-features N] [--max-attempts N] [--isolate]`

1. Elige la primera feature, en el orden del fichero, que no esté `accepted` ni `blocked` y cuyas dependencias estén todas `accepted`.
2. La marca `in_progress`, suma un intento y guarda.
3. Construye la tarea: título, descripción, escenarios de aceptación (cada uno debe quedar cubierto por un test), la spec si existe y la Definition of Done. Los comandos `verify` de la feature se añaden delante de los checks del proyecto.
4. La ejecuta con el workflow `cross-review` (agentes de los flags o de `agents` en el fichero).
5. Estado según el veredicto del recibo: *Verified* → `accepted`; *Review findings open* → `passing`; cualquier fallo → `in_progress`, o `blocked` si se alcanzó `--max-attempts` (2 por defecto).
6. Guarda la evidencia (`run`, `session`, `verdict`, `reviews`, `at`, `isolation`) y el recibo en `.mars/features/<id>.md`.
7. Con `--max-features N` sigue con la siguiente solo si la anterior quedó `accepted`. Con `--isolate` para tras una, porque el diff no está aplicado y la siguiente feature no lo vería.

`mars features` lista el estado; `--json` para scripts y CI.

## Consecuencias

- Es el bucle "spec → implementa → valida → decide" con presupuesto, escrito en código: el modelo no puede marcar una feature como aceptada.
- No hay commits automáticos todavía: tras `accepted`, la persona revisa y hace commit. Un `--commit` por feature aceptada queda para después, detrás de la política `gitCommit`.
- Paralelizar features en worktrees queda fuera: primero validación, después autonomía, después paralelismo.
