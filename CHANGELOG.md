# Changelog

Todos los cambios relevantes se documentarán aquí. El proyecto sigue [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Memoria y procedimientos revisados por proyecto, con propuestas del agente, revisión CLI/interactiva, procedencia, lock de escritura y carga por relevancia.
- Captura local `mars learn SESSION_ID` / SDK `learnFrom` desde sesiones verificadas, sin enviar historiales ni llamar al modelo.
- Recibos mínimos de verificación en sesiones y comandos de gestión local independientes del backend de credenciales.
- Reparación opt-in de workflows tras checks fallidos, acotada a 0–3 intentos y sin escalada de permisos.
- Informes SDK `lastRun` / `RunReport` y exportación CLI `--report` con resultados de checks, métricas observadas y uso comunicado por proveedores.
- Documento de ventajas del harness frente a uso directo del modelo, con capacidades actuales, límites y prioridades pendientes.
- Agent runtime multi-provider, CLI interactiva, tools de workspace, sesiones y SDK.
- Routing determinista, workflows, skills, evidencia local, MCP stdio y sandbox Docker opt-in.
- Empaquetado npm con la CLI `mars`.

### Changed

- La API pública adopta `createMars`, `MarsError`, `MarsOptions` y `MarsHook`; se elimina la nomenclatura provisional anterior.
- Core, SDK y CLI se dividen en módulos con dependencias explícitas; el SDK expone únicamente su superficie pública deliberada.
- El paquete publica exclusivamente el binario `mars`.
- Los checks de proyecto usan el mismo executor, permisos y sandbox que el shell del agente.
- Las sesiones compactan turnos antiguos completos al alcanzar el límite local de contexto.
- OpenAI Codex usa el SDK/runtime oficial para acceder mediante suscripción de ChatGPT; Kimi subscription auth queda experimental y desactivado por defecto.

### Security

- Búsqueda y diffs Git excluyen rutas sensibles; Git de inspección desactiva helpers ejecutables.
- Las fases de lectura restringen sus herramientas en runtime y shell respeta las políticas Git reconocibles.
- El adapter Anthropic bloquea OAuth y elimina el client ID heredado; Kimi exige opt-in también al usar credenciales guardadas.
- Anthropic browser auth queda desactivado para cumplir su política de integraciones de terceros.
- La verificación requiere al menos un check real con exit code cero.

### Fixed

- Gemini envía `systemInstruction`, usa IDs de herramientas únicos y rechaza streams incompletos; Gemini y Anthropic procesan SSE con CRLF y límites de tamaño.
- Codex reinicia el hilo cuando cambian el modelo, herramientas o historial; OpenAI permite esquemas MCP con propiedades opcionales sin exigir strict incompatible.
- Workflows y checks mantienen exclusión de sesión, propagan cancelación y persisten fallos; `check --json` devuelve código de error cuando corresponde.
- MCP drena stderr, descubre páginas de herramientas, acota respuestas y permite reconectar tras cerrar.
- Configuración y sesiones tienen versiones; los fallos de persistencia no provocan rechazos asíncronos sin manejar.
- La CLI rechaza resume sin terminal y conserva la conversación si falla el cambio de modelo; logout Gemini con API key no requiere un cliente OAuth.
