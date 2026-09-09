# ADR 003 — MARS runtime diario sobre v0.1

Estado: implementado. Fecha: 2026-09-08.

MARS mantiene el loop de v0.1 y añade las piezas que permiten usarlo en un repositorio real sin introducir otro runtime: configuración con precedencia, sesiones JSON atómicas por workspace, contexto de proyecto, skills relevantes, búsqueda, Git read-only, verificación de scripts conocidos, permisos de red/destructivos, workflows opt-in, evidencia local, observabilidad redaccionada y un puente MCP stdio opt-in.

Las decisiones que evitan consumo accidental de tokens son deliberadas:

- `mars models`, `mars route`, `mars doctor`, `mars config`, `mars sessions`, `mars skills` y `mars workflows` son locales.
- El routing filtra credenciales y selecciona un target mediante reglas deterministas; no llama a un modelo para decidir.
- Los workflows solo hacen varias llamadas cuando el usuario los pide con `--workflow`.
- Con `--workflow --route`, la CLI resuelve los roles de cada fase por separado; el SDK también acepta `roleProviders` para aplicaciones que necesiten fijarlos explícitamente.
- Los reintentos de provider se pueden activar por ejecución, pero el valor por defecto es cero; solo se repiten fallos transitorios antes de recibir texto para no duplicar efectos ni facturación.
- Las pruebas de integración usan `fake:scripted`; los smoke tests reales se mantienen separados.

Las sesiones se guardan en `.mars/sessions` para que un proyecto pueda llevar su estado operativo sin depender de permisos de escritura fuera del workspace. `.mars/` está ignorado por defecto. Las credenciales usan el mismo contrato con un backend nativo opcional (`keytar`) y un fallback de archivo explícito para desarrollo, sin acoplar providers al almacén.

La verificación ejecuta únicamente scripts estándar declarados en `package.json` (`typecheck`, `test`, `lint`, `build`) y se detiene en el primer fallo. `git` expone solo inspección read-only; commit y push siguen detrás de políticas explícitas.

La evidencia registra únicamente nombres de skills, workflows, conteos y confianza; no guarda tareas ni respuestas. Los eventos locales se escriben como JSONL redaccionado y `ProviderHealthTracker` deriva estado de eventos ya observados, sin sondas de red. MCP se limita a servidores que la aplicación pasa explícitamente a `createForge`; se descubren herramientas por `tools/list`, se validan contra el subconjunto seguro del esquema JSON antes de ejecutar y se cierran con la sesión.

El modo host sigue sin aislamiento de procesos. El SDK y la CLI ofrecen `sandbox: { mode: 'docker' }`/`--sandbox docker` como opt-in: monta solo el workspace, desactiva la red por defecto y limita CPU/memoria. Docker/Windows Sandbox nativo y una política de imágenes reproducibles requieren validación posterior por plataforma.
