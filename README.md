# MARS

```text
███    ███  █████  ██████  ███████
████  ████ ██   ██ ██   ██ ██
██ ████ ██ ███████ ██████  ███████
██  ██  ██ ██   ██ ██   ██      ██
██      ██ ██   ██ ██   ██ ███████
```

[![CI](https://github.com/ALVZ93/mars/actions/workflows/ci.yml/badge.svg)](https://github.com/ALVZ93/mars/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-EF4137.svg)](LICENSE)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-303030.svg)](https://nodejs.org/en/download)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-EF4137.svg)](#instalación)

MARS es un arnés de agentes local para trabajar sobre repositorios desde la terminal. Conecta el modelo que elijas, mantiene sesiones por proyecto y ofrece herramientas de lectura, escritura, búsqueda, Git, shell, verificación, skills, workflows y servidores MCP.

- Funciona en Windows, macOS y Linux.
- Las credenciales se guardan en Credential Manager, Keychain o Secret Service.
- No requiere una cuenta de MARS, backend central ni telemetría remota.
- Cada usuario conecta su suscripción de ChatGPT/Codex o aporta sus propias credenciales de proveedor.

Licencia [Apache 2.0](LICENSE) · [Repositorio](https://github.com/ALVZ93/mars) · [Incidencias](https://github.com/ALVZ93/mars/issues) · [Seguridad](SECURITY.md)

## Requisitos

- Node.js 24 o posterior.
- npm, incluido con Node.js.
- Una terminal: PowerShell en Windows; Terminal, bash o zsh en macOS/Linux.
- Opcional: Docker para aislar la ejecución de shell.

Descarga Node.js desde [nodejs.org/download](https://nodejs.org/en/download). Después abre una terminal nueva y comprueba:

```sh
node --version
npm --version
```

`node --version` debe mostrar `v24` o una versión posterior.

## Instalación

El comando es el mismo en los tres sistemas.

### Windows — PowerShell

```powershell
npm install --global @alvz93/mars
mars --version
```

### macOS — Terminal

```sh
npm install --global @alvz93/mars
mars --version
```

### Linux — bash o zsh

```sh
npm install --global @alvz93/mars
mars --version
```

Para probar MARS sin instalarlo globalmente:

```sh
npx @alvz93/mars@latest --version
npx @alvz93/mars@latest "Responde con: MARS funciona" --model fake:scripted --no-save
```

Si macOS o Linux devuelve `EACCES` durante la instalación global, usa un gestor de versiones de Node o ejecuta MARS mediante `npx`; no hace falta instalarlo con `sudo`. Consulta la [guía oficial de permisos de npm](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally/).

Para actualizar o desinstalar:

```sh
npm install --global @alvz93/mars@latest
npm uninstall --global @alvz93/mars
```

## Prueba sin cuenta ni API key

`fake:scripted` es un proveedor local determinista para comprobar la instalación. No usa red ni consume tokens.

```sh
mkdir mars-test
cd mars-test
mars init
mars doctor
mars "Responde con: instalación correcta" --model fake:scripted --no-save
```

Puedes borrar la carpeta `mars-test` al terminar.

## OpenAI con tu suscripción de ChatGPT

MARS incluye el runtime oficial de Codex y puede usar los límites incluidos en una suscripción de ChatGPT compatible. Codex gestiona el navegador, los tokens y su renovación; MARS no los lee ni los guarda.

```sh
mars login openai-codex
mars auth status
mars config set model.default openai-codex:gpt-5.6-sol
mars "Analiza este repositorio y explícame cómo está organizado"
```

En un servidor sin navegador usa el flujo de código de dispositivo:

```sh
mars login openai-codex --device
```

Este acceso consume la cuota de Codex de tu plan de ChatGPT. La disponibilidad de modelos y los límites dependen de la cuenta y del workspace elegidos.

## OpenAI con API key

MARS admite OpenAI mediante una API key. El comando abre una entrada oculta y guarda la clave en el almacén seguro del sistema:

```sh
mars login openai --api-key
mars auth status
mars config set model.default openai:gpt-4o-mini
mars "Analiza este repositorio y explícame cómo está organizado"
```

El modelo debe estar habilitado en tu cuenta de OpenAI API y puede sustituirse por cualquier ID compatible mostrado por `mars models`. La API de OpenAI se factura por separado de ChatGPT. MARS no lee cookies ni reutiliza sesiones del navegador.

## Conectar un proveedor

La forma recomendada para una persona es el login interactivo: MARS solicita la API key sin mostrarla y la guarda en el almacén seguro del sistema.

```sh
mars auth providers
mars login openai --api-key
mars auth status
mars models
```

También están disponibles:

```sh
mars login anthropic --api-key
mars login kimi-code --api-key
mars login gemini --api-key
mars login qwen --api-key
mars login openrouter --api-key
```

Selecciona después un identificador mostrado por `mars models`:

```sh
mars config set model.default openai:gpt-4o-mini
mars
```

| Proveedor | Identificador | Autenticación estable |
| --- | --- | --- |
| OpenAI / Codex | `openai-codex:MODELO` | Suscripción de ChatGPT mediante el runtime oficial de Codex |
| OpenAI API | `openai:MODELO` | API key con facturación por consumo |
| Anthropic API | `anthropic:MODELO` | API key |
| Kimi Code | `kimi-code:MODELO` | API key |
| Google Gemini API | `gemini:MODELO` | API key u OAuth con cliente propio |
| Qwen / Model Studio | `qwen:MODELO` | API key |
| OpenRouter | `openrouter:MODELO` | API key |
| Ollama local | `ollama:MODELO` | No requiere login |

El acceso por suscripción de OpenAI usa exclusivamente el runtime oficial de Codex. Kimi subscription auth permanece experimental y desactivado por defecto; el login de claude.ai no se ofrece a aplicaciones de terceros sin aprobación. Consulta la [matriz de proveedores](docs/auth/provider-matrix.md).

### Variables de entorno para automatización

El login interactivo evita dejar secretos en el historial de la terminal. Para CI o automatización puedes usar variables de entorno gestionadas por tu plataforma.

PowerShell:

```powershell
$env:OPENAI_API_KEY = "tu-clave"
mars "Revisa este proyecto" --model openai:MODELO --no-save
```

Símbolo del sistema de Windows:

```bat
set OPENAI_API_KEY=tu-clave
mars "Revisa este proyecto" --model openai:MODELO --no-save
```

macOS/Linux:

```sh
export OPENAI_API_KEY="tu-clave"
mars "Revisa este proyecto" --model openai:MODELO --no-save
```

MARS reconoce también `ANTHROPIC_API_KEY`, `KIMI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `DASHSCOPE_API_KEY`, `QWEN_API_KEY` y `OPENROUTER_API_KEY`.

## Usarlo en un proyecto

Abre una terminal dentro de cualquier repositorio:

```sh
cd ruta/al/proyecto
mars init
mars doctor
mars
```

MARS usa el directorio actual como workspace. `--workspace RUTA` permite seleccionar otro. Dentro del modo interactivo:

- Enter envía la tarea.
- Tab abre el selector de modelos.
- Ctrl+P muestra los comandos.
- Esc o Ctrl+C interrumpe la tarea activa.
- `/permissions` revisa el acceso a shell.
- `/new` crea una sesión y `/resume ID` retoma otra.
- `/model`, `/models`, `/check`, `/skills`, `/workflows` y `/help` muestran las funciones principales.

También puedes ejecutar una tarea sin abrir la interfaz:

```sh
mars "Explica la arquitectura de este repositorio"
mars "Corrige los tests que fallan" --verify
mars "Revisa el diff actual" --workflow review --route
```

## Comandos principales

| Comando | Función |
| --- | --- |
| `mars` | Abre una sesión interactiva |
| `mars "TAREA"` | Ejecuta una tarea y termina |
| `mars init` | Crea `.mars/config.json` en el proyecto |
| `mars doctor` | Diagnostica Node, Git, configuración, credenciales y sandbox |
| `mars login PROVEEDOR --api-key` | Guarda una API key de forma interactiva |
| `mars login openai-codex` | Conecta una suscripción de ChatGPT mediante Codex |
| `mars auth status` | Muestra proveedores conectados |
| `mars auth logout PROVEEDOR` | Elimina una credencial |
| `mars auth migrate` | Migra el antiguo archivo de credenciales al llavero nativo |
| `mars models` | Lista modelos conocidos y su estado de autenticación |
| `mars sessions` | Lista sesiones del proyecto |
| `mars resume ID` | Retoma una sesión |
| `mars check` | Ejecuta la verificación del proyecto |
| `mars skills` | Lista skills personales y del proyecto |
| `mars workflows` | Lista workflows disponibles |
| `mars health` | Muestra el último estado observado de los proveedores |
| `mars --help` | Muestra todas las opciones |

## Configuración

La configuración del proyecto vive en `.mars/config.json`. La configuración personal se guarda en:

| Sistema | Ruta |
| --- | --- |
| Windows | `%APPDATA%\\mars\\config.json` |
| macOS/Linux | `${XDG_CONFIG_HOME:-~/.config}/mars/config.json` |

La precedencia es: flags, entorno, proyecto, usuario y valores predeterminados.

```sh
mars config show
mars config path
mars config set permissions.shell ask
mars config set limits.maxTurns 32
mars config set verification.commands '["npm test","npm run lint"]'
```

En PowerShell, si las comillas del JSON se modifican al copiar el último comando, edita `.mars/config.json` directamente:

```json
{
  "verification": {
    "commands": ["npm test", "npm run lint"]
  }
}
```

Sin `verification.commands`, MARS detecta los scripts `typecheck`, `test`, `lint` y `build` de `package.json`. Los checks configurados permiten verificar proyectos Python, Rust, Go u otros stacks y atraviesan los mismos permisos y sandbox que la shell.

La referencia completa de configuración, routing, roles, permisos, skills y MCP está en [docs/configuration.md](docs/configuration.md).

## Credenciales y datos locales

Por defecto, MARS exige el almacén nativo del sistema. Si `mars doctor` indica que no está disponible, comprueba que la dependencia opcional se instaló y que Linux dispone de un servicio de secretos compatible.

`MARS_CREDENTIAL_STORE=file` habilita un JSON local únicamente para desarrollo. `mars auth migrate` copia ese archivo al llavero, verifica cada entrada y solo entonces elimina el original.

Las sesiones, evidencia y eventos permanecen dentro de `.mars/` en cada workspace. Los eventos no guardan el texto del modelo ni el contenido de las tareas. Consulta las rutas y comandos de limpieza en [docs/configuration.md](docs/configuration.md).

## Permisos y aislamiento

La shell pide permiso por defecto. En Windows ejecuta PowerShell; en macOS y Linux ejecuta bash. `--allow-shell` permite shell durante ese proceso y debe usarse solo con tareas de confianza.

```sh
mars "Ejecuta los tests y corrige los fallos" --allow-shell
mars "Ejecuta los tests y corrige los fallos" --sandbox docker
```

El modo host corre con los permisos de tu usuario. `--sandbox docker` usa un contenedor efímero, monta el workspace, desactiva la red y limita CPU y memoria; requiere Docker y una imagen que contenga las herramientas del proyecto.

Las herramientas de archivos bloquean escapes del workspace, rutas sensibles y enlaces peligrosos. Los servidores MCP configurados por el usuario son procesos externos y deben tratarse como código de confianza.

## Estado y compatibilidad

La CI prueba Node.js 24 en Windows, macOS y Linux. Instala el tarball en un directorio limpio y valida instalación local/global, `npx`, `pnpm dlx`, CLI, exports del SDK y carga del backend nativo. Los tests offline no validan permisos ni disponibilidad de cuentas reales de proveedores.

Para informar de un fallo, abre una [issue](https://github.com/ALVZ93/mars/issues) con sistema operativo, versión de Node, salida de `mars doctor` y pasos de reproducción, sin incluir claves ni tokens. Las vulnerabilidades deben enviarse mediante el [reporte privado](https://github.com/ALVZ93/mars/security/advisories/new).

## Desarrollo

Las instrucciones para clonar, compilar, probar y contribuir viven en [CONTRIBUTING.md](CONTRIBUTING.md). El proceso de release está en [docs/releasing.md](docs/releasing.md).
