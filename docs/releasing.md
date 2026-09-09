# Publicar MARS en npm

Las releases públicas se publican desde `.github/workflows/release.yml` mediante npm Trusted Publishing. El workflow exige que el tag `vX.Y.Z` coincida con la versión de `package.json`, repite los tests y prueba el tarball antes de publicar.

## Primera publicación

npm solo permite configurar un trusted publisher cuando el paquete ya existe. La primera publicación de `@alvz/mars` debe crear el paquete desde un equipo autenticado:

```powershell
npm login
pnpm install --frozen-lockfile
pnpm test
pnpm test:package
npm publish --access public
```

La cuenta de npm debe controlar el scope `@alvz` y tener 2FA activado. No crees todavía una GitHub Release: dispararía el workflow antes de que Trusted Publishing esté configurado.

## Configurar Trusted Publishing

En la configuración del paquete `@alvz/mars` en npm, añade un publisher de GitHub Actions con estos valores:

| Campo | Valor |
| --- | --- |
| Organization or user | `ALVZ93` |
| Repository | `mars` |
| Workflow filename | `release.yml` |
| Environment | `npm` |

El repositorio ya contiene el environment `npm` y el workflow solicita `id-token: write`. No hace falta guardar un token npm en GitHub. Consulta la [documentación de Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) y la [documentación de provenance](https://docs.npmjs.com/generating-provenance-statements/).

## Releases posteriores

1. Actualiza `version` en `package.json` y `pnpm-lock.yaml`.
2. Mueve las entradas relevantes de `Unreleased` a `X.Y.Z` en `CHANGELOG.md`.
3. Ejecuta `pnpm test` y `pnpm test:package`.
4. Fusiona los cambios en `main`.
5. Publica una GitHub Release con el tag exacto `vX.Y.Z`.
6. Comprueba el workflow y la instalación pública:

```powershell
npm view @alvz/mars version
npx @alvz/mars@X.Y.Z --version
```

Un tag incorrecto falla antes de publicar. Una versión que ya exista en npm también falla y debe resolverse creando una versión nueva; las versiones publicadas no se reutilizan.
