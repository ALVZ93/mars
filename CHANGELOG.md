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
- OpenAI Codex y Kimi subscription auth quedan experimentales y desactivados por defecto.

### Security

- Anthropic browser auth queda desactivado para cumplir su política de integraciones de terceros.
- La verificación requiere al menos un check real con exit code cero.
