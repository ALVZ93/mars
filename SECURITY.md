# Seguridad

## Versiones soportadas

Hasta la primera release estable solo se corrige la rama principal. Esta sección se actualizará cuando existan versiones publicadas.

## Reportar una vulnerabilidad

Usa el reporte privado de vulnerabilidades de [ALVZ93/mars](https://github.com/ALVZ93/mars/security/advisories/new). No abras una issue pública con tokens, credenciales, rutas privadas, código sensible o instrucciones de explotación.

Incluye la versión o commit, plataforma, configuración de sandbox, impacto observado y una reproducción mínima sin secretos. Se confirmará la recepción y se coordinará la divulgación después de disponer de una corrección.

## Límites conocidos

El shell en modo host ejecuta procesos con los permisos del usuario. Docker es opt-in y requiere una imagen confiable. Los servidores MCP configurados por el usuario también son procesos externos y deben considerarse código de confianza.
