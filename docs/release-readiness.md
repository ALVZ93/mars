# MARS: preparación de release

Revisión: 2026-10-11. El detalle de fallos, correcciones y cobertura está en [la auditoría funcional](audit-2026-10-11.md).

## Comprobado localmente

- Core, SDK y CLI, con suite offline ampliada y ejecución interactiva en Windows.
- Archivos, búsqueda y Git con política de rutas sensibles; checks con executor, permisos y exit codes comunes.
- Workflows con herramientas restringidas por fase y exclusión durante verificación.
- Reparación opt-in de checks fallidos con presupuesto de 0–3 intentos por workflow; informes SDK y exportación JSON CLI, también tras fallo.
- Memoria revisada por proyecto y captura local de procedimientos desde sesiones verificadas, con aprobación explícita y recibos persistidos.
- Configuración/sesiones versionadas, snapshots atómicos y errores de disco controlados.
- Transports de proveedores y MCP stdio con procesos reales de prueba.
- Anthropic OAuth bloqueado en adapter y CLI; Kimi experimental exige opt-in también al ejecutar.
- Tarball local con CLI, SDK y tarea fake, resolviendo dependencias desde el workspace.
- Cinco runs reales históricos en `docs/dogfooding/runs/`; no sustituyen repetirlos tras este diff.

La suite exacta y sus resultados se registran en la auditoría. El tarball offline no sustituye instalación limpia ni valida el backend nativo.

## Gates pendientes

- [ ] Completar `pnpm audit --prod` con autorización de consulta npm y resolver hallazgos.
- [ ] Completar `pnpm test:package` con instalación limpia y descargas autorizadas.
- [ ] Ejecutar CI Windows/macOS/Linux sobre este diff.
- [ ] Probar llavero nativo real en cada SO, incluido Linux con Secret Service.
- [ ] Repetir login, refresh, logout, streaming y tool calls con cuentas reales tras estos cambios.
- [ ] Probar Docker real: checks en contenedor, montaje, cancelación y eliminación. Aquí no hay motor activo.
- [ ] Resolver Codex global/marcador local (`2B-F01`) y confirmar modelos habilitados.
- [ ] Confirmar paquete npm, scope y Trusted Publishing antes de [publicar](releasing.md).
- [ ] Validar visual, accesibilidad y despliegue público de la landing al cerrar la release del runtime.

## Alcance declarado

Routing usa catálogo estático y scoring determinista, sin salud, historial, presupuesto o coste. Evidencia registra ejecución y checks; no demuestra resolución semántica de tareas. Hooks son observadores síncronos. MCP implementa tools por stdio y un subconjunto JSON Schema. SDK sigue en 0.x.

Host shell y MCP son código de confianza con permisos del usuario. Docker es opt-in y necesita motor, imagen y validación real por plataforma.

No se ha realizado publicación, push, login real ni llamadas facturables a proveedores de modelo durante esta revisión.
