# MARS — matriz de autenticación por proveedor

Actualizada: 2026-09-09. Esta matriz separa tres cosas que suelen confundirse: login de un producto oficial, OAuth para una aplicación de terceros y acceso API facturado por consumo o por un plan de herramientas.

| Proveedor | Login de suscripción documentado | OAuth oficial utilizable por una app como MARS | Camino API/plan para MARS | Decisión |
| --- | --- | --- | --- | --- |
| OpenAI API | No es una suscripción; uso facturado por consumo | No aplica | API key y Chat Completions | Implementado como `openai:*`. |
| OpenAI / Codex | Sí, en Codex CLI, SDK y app-server | Codex gestiona OAuth, almacenamiento y refresh sin exponer tokens a MARS | SDK/runtime oficial incluido con MARS | Implementado como `openai-codex:*`; estable para uso local con una suscripción compatible. |
| Anthropic / Claude | Sí, en Claude Code | Anthropic dice expresamente que terceros no pueden ofrecer login de claude.ai sin aprobación previa | API key y Messages API | Login de navegador desactivado; `anthropic:*` estable solo con API key. |
| Kimi Code | Sí, Kimi Code ofrece OAuth device-code | La documentación describe el servicio gestionado y menciona plataformas de terceros, pero no publica todavía un contrato inequívoco para este cliente | API key o endpoint compatible | Device flow experimental y desactivado por defecto hasta validación; API key estable. |
| Google Gemini API | La suscripción de Gemini de consumo no es el mismo producto que la API | MARS permite OAuth PKCE con un cliente Cloud propio (`MARS_GEMINI_CLIENT_ID`) | Gemini API key u OAuth Cloud | Implementado para un proyecto Cloud del usuario; no se presenta como acceso a la suscripción de consumo. |
| Qwen / Alibaba Model Studio | Token Plan/Coding Plan son planes de API/herramientas | No hay OAuth de consumo documentado para apps propias | API key/Token Plan y OpenAI-compatible | Implementado con `qwen:*` y `QWEN_BASE_URL`; no se inventa login web. |
| OpenRouter | No es una suscripción de consumo para MARS; agrega APIs de modelos | No aplica | `OPENROUTER_API_KEY` y endpoint OpenAI-compatible | Implementado como adapter explícito con `openrouter:*`. |
| Ollama | Runtime local del usuario | No aplica | Endpoint local OpenAI-compatible, sin credencial | Implementado como `ollama:*`; la disponibilidad se comprueba al ejecutar. |

## Reglas de implementación

- Un `AuthProvider` declara sus métodos (`oauth-pkce`, `oauth-device`, `api-key`, etc.) y el adapter de modelo recibe una credencial ya resuelta.
- OpenAI Codex guarda y renueva su propia sesión. MARS persiste únicamente una referencia `external`; el SDK oficial ejecuta el modelo y MARS conserva el control de sus herramientas.
- El núcleo OAuth de MARS genera `state` y PKCE, escucha solo en `127.0.0.1`, valida el callback y no imprime tokens.
- `createCredentialStore()` usa Credential Manager, Keychain o Secret Service mediante `@napi-rs/keyring`. Los modos `auto` y `keychain` exigen ese backend y fallan de forma explícita si no está disponible. `MARS_CREDENTIAL_STORE=file` habilita el archivo atómico únicamente por elección expresa de desarrollo; `mars auth migrate` lo copia al llavero, verifica cada entrada y después lo elimina.
- MARS solo usa endpoints y contratos declarados por cada adapter. No automatiza cookies, tokens internos ni credenciales de otra aplicación.
- El adapter experimental de Kimi solo puede habilitarse en desarrollo con `MARS_ENABLE_EXPERIMENTAL_SUBSCRIPTION_AUTH=1`; Anthropic permanece bloqueado incluso con ese flag.

## Fuentes oficiales

- [OpenAI — autenticación de Codex](https://learn.chatgpt.com/docs/auth)
- [OpenAI — Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [OpenAI — Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Anthropic — Agent SDK authentication restriction](https://code.claude.com/docs/en/agent-sdk/overview)
- [Anthropic — Claude Code authentication](https://code.claude.com/docs/en/authentication)
- [Kimi Code — first launch and `/login`](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started)
- [Google — Gemini API OAuth quickstart](https://ai.google.dev/gemini-api/docs/oauth)
- [Alibaba Cloud — Token Plan](https://www.alibabacloud.com/help/en/model-studio/token-plan-overview)
