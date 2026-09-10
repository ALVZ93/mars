# Changelog

Todos los cambios relevantes se documentarán aquí. El proyecto sigue [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Agent runtime multi-provider, CLI interactiva, tools de workspace, sesiones y SDK.
- Routing determinista, workflows, skills, evidencia local, MCP stdio y sandbox Docker opt-in.
- Empaquetado npm con CLI `mars` y alias `forge`.

### Changed

- Los checks de proyecto usan el mismo executor, permisos y sandbox que el shell del agente.
- Las sesiones compactan turnos antiguos completos al alcanzar el límite local de contexto.
- OpenAI Codex usa el SDK/runtime oficial para acceder mediante suscripción de ChatGPT; Kimi subscription auth queda experimental y desactivado por defecto.

### Security

- Anthropic browser auth queda desactivado para cumplir su política de integraciones de terceros.
- La verificación requiere al menos un check real con exit code cero.
