# 005 — Reparación acotada e informes de ejecución

Estado: aceptado. Fecha: 2026-10-11.

## Contrato

- Una ejecución terminada y una ejecución verificada son estados diferentes; el modelo no decide si los checks pasan.
- `verification.maxRepairAttempts` / SDK `maxRepairAttempts` / CLI `--repair-attempts` aceptan enteros de 0 a 3. Default 0, sin llamadas adicionales implícitas.
- Solo workflows con `repairPhase` explícita pueden reparar. `bugfix` y `feature` señalan `implement`; `review` conserva su comportamiento de lectura.
- Solo se repara un check ejecutado con exit code numérico distinto de cero. Ausencia de checks, permisos denegados, errores de executor, timeout y cancelación no disparan reparación.
- La reparación reutiliza proveedor, herramientas y permisos de la fase implementadora previa. Recibe la tarea original y el fallo como datos no confiables, acotados; vuelve al verificador y repite la misma lista de comandos. No garantiza que el modelo no altere los tests.
- El límite de reparaciones se comparte entre todas las verificaciones de un workflow. Los límites del agente siguen aplicándose por fase; no existe todavía presupuesto monetario ni timeout global del workflow.
- El SDK expone `lastRun` como snapshot independiente, incluso tras fallar. Incluye estado, duración, modelos, contadores, uso comunicado por proveedores e historial de checks; no almacena prompts, respuestas ni credenciales.
- `--report PATH` exporta exclusivamente para tareas no interactivas un JSON con las operaciones de la invocación, incluida una verificación posterior con `--verify`. Se escribe también tras fallo; nunca sobrescribe un archivo existente. El destino debe pasar la frontera de archivos del workspace.
- Los informes contienen comandos y salida de checks, que pueden incluir datos privados. Exportar es explícito; `--no-save` desactiva sesión/eventos, no una exportación solicitada con `--report`.

## Criterios de aceptación

1. Check falla → implementador corrige archivo → verificador vuelve a revisar → mismo check pasa: workflow completado, historial fallido y exitoso, una reparación.
2. Default 0 y límite agotado: fallo persistido, sin éxito falso ni llamadas extra.
3. Review, check inexistente, permiso denegado, error de executor y cancelación: cero reparaciones.
4. Fase de reparación restringida: herramientas y proveedor originales; ninguna escalada de permisos.
5. Modificar un snapshot no altera el informe interno; tokens ausentes no se presentan como consumo cero confirmado.
6. Exportación CLI exitosa o fallida produce JSON parseable; ruta externa, sensible o existente se rechaza antes de ejecutar la tarea.

Verificación: fixtures locales con proveedores deterministas, cambios reales de archivos y checks de Node; suite completa y compilación TypeScript.
