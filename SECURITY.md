# Seguridad

## Versiones soportadas

Hasta la primera release estable solo se corrige la rama principal. Esta sección se actualizará cuando existan versiones publicadas.

## Reportar una vulnerabilidad

Usa el reporte privado de vulnerabilidades de [ALVZ93/mars](https://github.com/ALVZ93/mars/security/advisories/new). No abras una issue pública con tokens, credenciales, rutas privadas, código sensible o instrucciones de explotación.

Incluye la versión o commit, plataforma, configuración de sandbox, impacto observado y una reproducción mínima sin secretos. Se confirmará la recepción y se coordinará la divulgación después de disponer de una corrección.

## Límites conocidos

El shell en modo host ejecuta procesos con los permisos del usuario. Docker es opt-in y requiere una imagen confiable. Los servidores MCP configurados por el usuario también son procesos externos y deben considerarse código de confianza.

El clasificador de shell añade comprobaciones para operaciones reconocibles, pero no analiza scripts o programas arbitrarios. Docker monta el workspace completo; los bloqueos de las herramientas de archivos no filtran lo visible a un comando aprobado.

## Datos y credenciales

- Los proveedores reciben tareas, instrucciones seleccionadas, historial, esquemas de herramientas y resultados. Codex recibe ese contexto mediante su runtime oficial.
- `.mars/sessions/` guarda conversaciones y resultados en JSON local sin cifrado. Secretos incluidos por el usuario en su tarea también pueden persistirse. Eliminar sesiones locales no elimina copias enviadas a proveedores.
- `.mars/events.jsonl` redacta texto del modelo y targets de permisos; conserva eventos, identificadores, nombres y conteos. `.mars/evidence.json` guarda contadores y referencias de skills/workflows, sin tareas o respuestas.
- MARS no envía telemetría remota propia. Solicitudes a proveedores y procesos MCP obedecen a los servicios configurados.
- Credenciales MARS usan el almacén nativo; JSON requiere selección explícita de desarrollo. Codex conserva sus propios tokens y MARS guarda una referencia externa.
- Shell recibe un entorno limitado, pero en host puede leer archivos accesibles al usuario. MCP recibe argumentos de tools y variables configuradas; como proceso de confianza también puede acceder a archivos y red.
- Logout elimina la credencial local; Codex delega logout a su runtime. Eliminar una API key local no revoca la clave en el proveedor.

Las comprobaciones pendientes están en [la auditoría funcional](docs/audit-2026-10-11.md).
