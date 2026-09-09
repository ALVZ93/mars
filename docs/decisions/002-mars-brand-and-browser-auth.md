# ADR 002 — MARS y autenticación de navegador

Estado: sustituido parcialmente por la auditoría de 2026-09-09 en `docs/auth/provider-matrix.md`. Fecha original: 2026-09-08.

## Decisión

El producto pasa a llamarse MARS. `mars` es el binario principal y `forge` queda como alias de compatibilidad. La CLI muestra una animación breve únicamente en terminales interactivas; no se emite ANSI en pipes, CI o sesiones con `NO_COLOR`.

La decisión original sobre login de suscripción no se considera apta para release: Anthropic lo prohíbe para terceros no aprobados y OpenAI documenta un flujo gestionado por Codex app-server. Los adapters directos de OpenAI Codex y Kimi quedan experimentales y desactivados por defecto; Anthropic estable usa API key.

La autenticación se modela con un `AuthProvider` común. MARS implementa adapters separados para OpenAI Codex (PKCE y device), Anthropic Claude (PKCE), Kimi Code (device) y Google Cloud Gemini (PKCE con client ID propio). Qwen/Model Studio usa API key y endpoint compatible. Los modelos reciben una credencial resuelta; nunca acceden al store.

## Motivo

El handoff exige OAuth/PKCE, `state`, callback localhost, device flow, refresh, logout y almacenamiento seguro en su sección 9.1. Esta ampliación conserva API keys y añade los flujos que Pi ya demuestra en CLI, con opt-in explícito para los proveedores que pueden cambiar su contrato.

Las suscripciones de consumidor no son intercambiables por definición con las APIs. Codex, Claude Code y Kimi Code tienen flujos de cliente que MARS puede ejecutar como adapters aislados; Google requiere un proyecto Cloud y client ID propios; Alibaba documenta planes mediante claves y endpoints compatibles. MARS no copia cookies ni sesiones del navegador.

## Flujo OAuth

```text
MARS CLI -> AuthProvider -> state + PKCE -> browser -> provider consent
         -> 127.0.0.1 callback -> code exchange -> OAuthCredential
         -> per-user atomic store -> ModelProvider
```

El callback solo acepta el `state` emitido para esa ejecución. El token nunca entra en mensajes del modelo, logs ni URLs de tarea. La interfaz soporta refresh y revoke cuando el proveedor lo publica.

## Límite

El store seleccionado por defecto es `auto`: usa Credential Manager/Keychain/Secret Service mediante `keytar` si está instalado y mantiene un fallback de archivo atómico (`%APPDATA%\\mars\\auth.json` o `~/.config/mars/auth.json`) para desarrollo. `MARS_CREDENTIAL_STORE=keychain` obliga al backend nativo y `file` fuerza el fallback. Los endpoints de suscripción pueden requerir cambios del proveedor; las pruebas locales cubren PKCE, device code, refresh, callbacks y transports SSE sin consumir tokens.
