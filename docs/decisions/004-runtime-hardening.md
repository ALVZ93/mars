# ADR 004 — Fronteras de ejecución y persistencia

Estado: implementado. Fecha: 2026-10-11.

- Una sesión tiene un único propietario de ejecución: `run`, `runWorkflow` y `verify` se excluyen mutuamente. El bloqueo del workflow incluye sus checks; la sesión permanece `active` hasta terminar toda la operación. `close` rechaza cerrar una operación activa.
- `WorkflowPhase.allowedTools` restringe tanto los esquemas ofrecidos al proveedor como la ejecución efectiva. Las fases built-in de planificación, revisión y verificación permiten únicamente `read_file`, `search_files` y `git`. MCP y extensiones no heredan acceso implícito a esas fases.
- La verificación se decide por exit codes estructurados. Cancelación se propaga como cancelación. JSON conserva el mismo código de salida de error que el formato de texto. Un workflow personalizado sin checks puede terminar, pero no registra `verificationPassed: true`.
- Configuración escribe `version: 1`; sesiones escriben `schemaVersion: 1`. Los archivos anteriores sin versión siguen siendo legibles; versiones distintas se rechazan. Los checkpoints se encolan tras cada turno completo. Fallos de almacenamiento se capturan y comunican al finalizar, sin rechazos de promesas sin manejar.
- Búsqueda usa la misma validación de rutas que lectura/escritura. Git desactiva fsmonitor, external diff y textconv; diffs excluyen los nombres y directorios sensibles bloqueados por el workspace.
- Las políticas Git se comprueban también en comandos shell reconocibles. El clasificador sigue siendo heurístico y el modo host conserva los permisos del usuario; no constituye una frontera contra código arbitrario.
- La prohibición de login Anthropic se aplica dentro del adapter, además de la CLI. Se elimina el client ID y el flujo de suscripción heredado. Credenciales guardadas no evitan esta regla ni el opt-in de Kimi experimental.
- Docker utiliza un nombre único por ejecución y solicita eliminar el contenedor al cancelar el cliente. Su validación real queda pendiente de un motor disponible; no se certifica aislamiento a partir de pruebas de argumentos.

No se añaden colas distribuidas, infraestructura remota ni nuevos sistemas de plugins. Los cambios corrigen contratos ya anunciados.
