# MARS: pendientes hasta la primera release pública

Revisión: 2026-09-09. Fuente: handoff, código y pruebas locales.

La landing queda como último hito, después de validar e instalar la release.
Este documento registra pendientes; no certifica seguridad ni compatibilidad de proveedores externos.

## Evidencia actual

- `pnpm test`: build correcto y 71 tests aprobados, sin fallos ni skips, en Windows.
- Existen core independiente, SDK, CLI interactiva, streaming, tools, sesiones y configuración.
- Hay adapters reales y fake, API keys, flujos OAuth/device, refresh y logout.
- Hay skills, routing, workflows, evidencia, eventos, MCP stdio y Docker, con alcance parcial.
- La matriz CI pasa en Windows, macOS y Linux sobre el commit público `3894d91`.
- El repositorio público está creado en `https://github.com/ALVZ93/mars` y `main` sigue a `origin/main`.
- El paquete raíz ejecuta el build en `prepack`; el workflow verifica tag/versión, repite tests y publica con provenance, pendiente de configurar npm Trusted Publishing.
- No se hicieron llamadas facturables, login real ni publicación npm.
- `npm pack` ejecuta el build; la CI instala el tarball en un directorio limpio y valida instalación local/global, `npx`, `pnpm dlx`, binario, exports SDK y carga del keyring nativo.
- `pnpm audit --prod` no detecta vulnerabilidades conocidas; el tarball incluye la documentación operativa y excluye estado/credenciales locales.

## Bloqueos antes de distribuir como herramienta estable

### 1. Unificar ejecución y verificación

`packages/tools/src/index.ts:runProjectChecks` llama directamente a `executeShell`.
`packages/sdk/src/index.ts:runWorkflow` invoca esa función sin pasar el runner Docker
ni el motor de permisos. Un script estándar de package.json también ejecuta código arbitrario.

- [x] Hacer pasar los checks por el mismo executor, permisos y sandbox que las tools.
- [x] Verificar que shell denegada y el executor seleccionado se respetan también en workflows.
- [x] Devolver estado «sin verificación» cuando no existen scripts.
- [x] Comprobar éxito mediante exit code estructurado, sin buscarlo en el texto de salida.
- [x] Exigir una comprobación real antes de marcar un workflow como verificado.
- [x] Permitir estrategia de verificación explícita para proyectos sin package.json.

Aceptación: no ejecutar scripts en host cuando se seleccionó Docker; no marcar como
verificada una tarea que no ejecutó ninguna comprobación.

### 2. Credenciales y contratos de autenticación

`createCredentialStore` exige el llavero nativo salvo que el desarrollador seleccione
explícitamente el archivo. OpenAI Codex delega la sesión al runtime oficial y MARS no
incluye su client ID, tokens ni endpoints privados.

- [ ] Almacenamiento nativo probado en cada plataforma; archivo solo mediante elección explícita de desarrollo.
- [x] Definir migración comprobada del archivo al llavero y fallo claro sin backend nativo.
- [x] Auditar con documentación oficial vigente qué flujos de suscripción son admitidos para MARS.
- [x] Resolver el desacuerdo entre el handoff y ADR 002: Anthropic browser auth queda bloqueado; OpenAI Codex usa el SDK/runtime oficial y Kimi queda experimental.
- [ ] Validar login, refresh, logout y tool calls con cuentas reales de los proveedores que se anuncien.

La integración de OpenAI sigue el SDK oficial. La validación manual con una cuenta real
sigue siendo necesaria antes de etiquetar la primera release.

### 3. Uso cotidiano y personalización

- [x] Corregir precedencia de skills por identidad: proyecto prevalece sobre usuario y `.mars` sobre `.forge`.
- [x] Actualizar skills relevantes al cambiar de tarea y al retomar sesión.
- [x] Compactar turnos antiguos completos al alcanzar el límite, conservando instrucciones y la tarea actual.
- [x] Añadir ejemplos completos de configuración global/proyecto, roles, permisos, skills y MCP.
- [x] Documentar dónde se guardan configuración, sesiones y credenciales, cómo borrarlas y cómo actualizar MARS.
- [x] Validar primera instalación desde un directorio limpio, sin estado del desarrollador.

Compaction es una mejora de uso diario propuesta; el handoff la aplaza más allá del MVP.

### 4. GitHub, paquete y release

- [x] Inicializar Git, crear el remoto público `ALVZ93/mars` y subir `main`.
- [x] Publicar el proyecto bajo Apache-2.0, añadir LICENSE y conservar NOTICE en el paquete.
- [x] Completar metadata del paquete para `ALVZ93/mars`, licencia y enlaces de soporte.
- [x] Preparar build previo a empaquetar, declarar types/exports y comprobar el contenido del tarball.
- [x] Probar instalación local/global, npx y pnpm dlx desde el artefacto, en los tres sistemas.
- [x] Verificar binario ejecutable, exports SDK y dependencia nativa con Node 24 desde el tarball.
- [ ] Crear `@alvz/mars` con la primera publicación autenticada y configurar npm Trusted Publishing según `docs/releasing.md`.
- [x] Ejecutar CI remota en Windows, macOS y Linux.
- [ ] Ejecutar smoke tests reales de instalación y proveedores separados de los tests offline.
- [x] Actualizar README para que los límites y la política de autenticación coincidan con el código.
- [x] Añadir instrucciones de contribución, reporte privado de vulnerabilidades y changelog.

La licencia y el repositorio público están resueltos. La publicación npm espera autenticación y Trusted Publishing.

## Cobertura frente al roadmap del handoff

| Hito | Estado observado | Pendiente principal |
| --- | --- | --- |
| v0.1: loop, tools, auth básica, CLI | Base implementada; tests offline verdes | Validación real e instalación limpia |
| v0.2: uso diario | Mayormente implementado | Instalación limpia y pruebas reales de proveedores |
| v0.3: permisos y credenciales | Parcial | Checks fuera del executor; fallback de credenciales; aislamiento efectivo |
| v0.4: skills | Parcial | Precedencia por nombre y activación por tarea; no hay catálogo built-in |
| v0.5: extensiones | SDK con eventos y registro de tools/providers/workflows | API estable/documentada, carga de extensiones y comandos personalizados |
| v0.6: routing | Catálogo estático y roles | Salud integrada, discovery, capacidades fiables y filtros consistentes |
| v0.7: workflows | Fases y ejecución de scripts | Evidencias obligatorias, diff obligatorio, revisión/regresión y ciclos de corrección acotados |
| v0.8: aprendizaje | Contadores y sugerencias | Crear/evaluar/versionar skills; fin del loop no demuestra éxito de tarea |
| v0.9: sandbox | Docker opt-in | Verificación dentro del contenedor, imágenes reproducibles y validación por plataforma |
| v1.0: distribución estable | Pendiente | SDK/plugin API estables, release reproducible y npm |

Detalles de routing: selecciones explícitas/configuradas retornan antes de los filtros;
una ventana de contexto desconocida se trata como infinita; salud no participa en la
selección; hay preferencias por proveedor codificadas. No hay presupuestos/coste
integrados ni accounting completo. GitHub Copilot no tiene adapter en esta revisión.

Los hooks actuales son suscripciones a eventos: no equivalen a middleware asíncrono
capaz de controlar la ejecución. MCP sí está conectado desde configuración CLI,
aunque parte del README solo muestra su uso en SDK.

## Orden propuesto y criterio de cierre

1. Corregir verificación, permisos y credenciales; resolver soporte de auth.
2. Cerrar skills, continuidad de sesiones y configuración personal documentada.
3. Completar routing, workflows, extensiones y aprendizaje si se mantiene TODO el roadmap como alcance de 1.0.
4. Preparar GitHub/licencia/paquete, ejecutar CI y validar instalación real y proveedores anunciados.
5. Publicar versión comprobada e instalarla desde el canal público.
6. Terminar y publicar landing con comandos y funcionalidades ya verificadas.

Una primera release estable puede acotar el alcance y dejar aprendizaje/routing avanzado
para después, pero debe declararse esa decisión: no presentar esos hitos como completos.
Desktop, marketplace, cloud, voz, RAG y swarms están fuera del alcance inicial del handoff.

MARS es una CLI local: esta arquitectura no requiere desplegar un backend central,
base de datos remota ni cuentas propias para que cada usuario instale su arnés.
Cada usuario aporta credenciales/modelo y, si elige Docker, su instalación e imagen.
