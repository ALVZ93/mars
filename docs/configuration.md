# Configuración y datos locales

MARS combina defaults, configuración de usuario, configuración del proyecto, entorno y flags. El valor más específico gana: flags → entorno → proyecto → usuario → defaults.

## Rutas

| Dato | Windows | macOS/Linux |
| --- | --- | --- |
| Configuración de usuario | `%APPDATA%\\mars\\config.json` | `${XDG_CONFIG_HOME:-~/.config}/mars/config.json` |
| Configuración del proyecto | `<workspace>\\.mars\\config.json` | `<workspace>/.mars/config.json` |
| Sesiones | `<workspace>\\.mars\\sessions` | `<workspace>/.mars/sessions` |
| Evidencia | `<workspace>\\.mars\\evidence.json` | `<workspace>/.mars/evidence.json` |
| Eventos locales | `<workspace>\\.mars\\events.jsonl` | `<workspace>/.mars/events.jsonl` |
| Credenciales en modo `file` | `%APPDATA%\\mars\\auth.json` | `${XDG_CONFIG_HOME:-~/.config}/mars/auth.json` |

Las credenciales usan el almacén del sistema por defecto. `MARS_CREDENTIAL_STORE=file` habilita expresamente el archivo JSON de desarrollo. No guardes claves en `.mars/config.json`, `AGENTS.md`, skills ni configuración MCP versionada.

## Configuración completa de proyecto

```json
{
  "model": {
    "default": "openai:MODEL"
  },
  "routing": {
    "enabled": true,
    "planner": "openai:MODEL",
    "implementer": "openai:MODEL",
    "reviewer": "anthropic:MODEL",
    "verifier": "openai:MODEL"
  },
  "permissions": {
    "shell": "ask",
    "destructiveShell": "deny",
    "network": "ask",
    "gitCommit": "ask",
    "gitPush": "ask"
  },
  "limits": {
    "maxTurns": 24,
    "maxToolCalls": 64,
    "timeoutMs": 120000,
    "maxContextChars": 200000,
    "maxRetries": 0,
    "retryDelayMs": 500
  },
  "mcp": {
    "servers": [
      {
        "name": "local",
        "command": "node",
        "args": ["./mcp-server.mjs"],
        "cwd": ".",
        "timeoutMs": 30000
      }
    ]
  }
}
```

`allow`, `ask` y `deny` son los únicos valores válidos para permisos. Los servidores MCP se inician por stdio y su `cwd` se resuelve desde el workspace.

## Comandos de configuración

```sh
mars config show
mars config path
mars config set model.default openai:MODEL
mars config set permissions.shell ask
mars config set routing.enabled true
mars config set mcp.servers '[{"name":"local","command":"node","args":["./mcp-server.mjs"]}]'
```

`mars config set` escribe la configuración del proyecto de forma atómica.

## Instrucciones y skills

MARS carga `AGENTS.md` desde los directorios padre hasta el workspace y después `.mars/instructions.md`. Las instrucciones más cercanas al proyecto aparecen al final del contexto.

Una skill de proyecto vive en `.mars/skills/<nombre>/SKILL.md`; una skill personal, en `~/.mars/skills/<nombre>/SKILL.md`. Si comparten nombre, prevalece la del proyecto. MARS selecciona hasta tres skills relevantes en cada tarea.

```text
.mars/
  instructions.md
  skills/
    testing/
      SKILL.md
```

## Limpieza y actualización

```sh
mars auth logout PROVIDER
mars evidence clear
npm install --global @alvz/mars@latest
```

Para borrar historial local, elimina `.mars/sessions` y `.mars/events.jsonl` dentro del workspace. Para reiniciar la configuración, elimina el `config.json` correspondiente. El logout borra la entrada del proveedor del almacén nativo; no elimines todo el llavero del sistema.
