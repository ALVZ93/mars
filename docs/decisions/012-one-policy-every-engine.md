# ADR 012 — Una política para todos los motores

Estado: propuesto. Fecha: 7-nov-2026. Contexto: [posicionamiento](../posicionamiento.md) (reglas del equipo que valen para todos los motores; registro auditable) y la idea de que una regla importante debe vivir en un permiso o en código, no en un texto que el modelo puede ignorar.

## Contexto

Cada motor tiene su propio sistema de permisos: Claude Code reglas `allow`/`deny` por herramienta y patrón; Codex un sandbox (solo lectura o escritura en el workspace, red sí/no) sin reglas por comando en `exec`. Los hooks de cada CLI están apagados en MARS (Claude con `--bare`, Codex sin la configuración del usuario). Un equipo que mezcla motores no tiene hoy una regla que se cumpla en todos.

Lo que cada motor permite imponer:

| Regla | Claude Code | Codex | MARS (después de cada turno) |
| --- | --- | --- | --- |
| No editar ciertos ficheros | `--disallowedTools Edit(glob) Write(glob)`: lo impide | No puede impedirlo | Hash antes y después: la ejecución falla (*Contract violated*) |
| No ejecutar ciertos comandos | `--disallowedTools Bash(prefijo:*)`: lo impide | No puede impedirlo; red ya desactivada | Lee los comandos que ejecutó el motor: la ejecución falla (*Policy violated*) |
| Saber qué comandos se ejecutaron | Eventos `tool_use` de `stream-json` | Eventos `command_execution` | Los guarda en el informe y el recibo |

## Decisión

En `.mars/config.json`, sección `contract`:

```json
{ "contract": { "protect": ["migrations/**", ".github/**"], "denyCommands": ["git push", "npm publish", "rm -rf"] } }
```

- `protect` (ya existía para los workflows de MARS) se aplica también a los engines: Claude lo recibe como reglas de denegación; para todos, MARS compara hashes tras cada turno.
- `denyCommands` son prefijos de comando. Claude los recibe como `Bash(prefijo:*)` denegados. Para todos, MARS revisa cada comando ejecutado (deshaciendo el envoltorio `powershell -Command` / `bash -lc` y separando `&&`, `||`, `;`, `|`) y, si uno empieza por un prefijo denegado, la ejecución falla.
- Cada comando ejecutado por un motor queda en el informe (`commands[]`: agente y línea de comando) y el recibo lo resume. Es el registro de auditoría.

**Prevenir frente a detectar.** Con Claude la regla impide la acción. Con Codex, MARS la detecta después del turno y rechaza el resultado, pero el comando ya se ejecutó dentro del sandbox. Por eso Codex sigue sin red y con escritura limitada al workspace (o al worktree con `--isolate`). La documentación lo dice tal cual.

Sin hooks propios de cada CLI: un hook de Claude no corre en Codex. Los puntos de control comunes son el gate (checks tras cada cambio), el contrato y esta auditoría, todos en código de MARS.

## Consecuencias

- Las reglas sin excepciones de un equipo se escriben una vez y se aplican igual a todos los motores.
- La lectura de ficheros sensibles (`.env`) no se puede impedir en Codex; queda fuera hasta tener un sandbox que lo permita (Docker).
- El análisis de comandos es por prefijo, no un intérprete de shell: `sh -c "git push"` dentro de otro comando no se detecta. Es una red de seguridad, no una frontera de seguridad; la frontera es el sandbox.
