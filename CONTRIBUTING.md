# Contribuir a MARS

## Preparación

Requisitos: Node.js 24 y pnpm 11.19.0.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

## Cambios

- Mantén `core` independiente de CLI y proveedores concretos.
- No incluyas credenciales, archivos `.mars/`, sesiones ni outputs con datos privados.
- Añade pruebas para invariantes, errores, cancelación y diferencias entre plataformas cuando correspondan.
- Documenta decisiones que cambien auth, permisos, persistencia, extensiones o distribución en `docs/decisions/`.
- Ejecuta la suite completa antes de abrir un pull request.

Los pull requests deben explicar el comportamiento anterior, el nuevo comportamiento y la verificación realizada. Al contribuir aceptas que tu aportación se publique bajo Apache-2.0, conforme a la sección 5 de la licencia.
