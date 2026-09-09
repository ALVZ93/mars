# MARS: pendientes hasta la primera release pública

Revisión: 2026-09-09. Fuente: handoff, código y pruebas locales.

La landing queda como último hito, después de validar e instalar la release.
Este documento registra pendientes; no certifica seguridad ni compatibilidad de proveedores externos.

## Evidencia actual

- `pnpm test`: build correcto y 69 tests aprobados, sin fallos ni skips, en Windows.
- Existen core independiente, SDK, CLI interactiva, streaming, tools, sesiones y configuración.
- Hay adapters reales y fake, API keys, flujos OAuth/device, refresh y logout.
- Hay skills, routing, workflows, evidencia, eventos, MCP stdio y Docker, con alcance parcial.
- La matriz CI pasa en Windows, macOS y Linux sobre el commit público `f92d171`.
- El repositorio público está creado en `https://github.com/ALVZ93/mars` y `main` sigue a `origin/main`.
- El paquete raíz ya es publicable y ejecuta el build en `prepack`; todavía no tiene workflow de publicación.
- No se hicieron llamadas facturables, login real, instalación limpia del tarball ni publicación.
- `npm pack` ejecuta el build; el tarball actual contiene 59 archivos/81,0 kB, incluida la licencia, y permite arrancar CLI e importar SDK desde el contenido extraído.

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
- [ ] Permitir estrategia de verificación explícita para proyectos sin package.json.

Aceptación: no ejecutar scripts en host cuando se seleccionó Docker; no marcar como
verificada una tarea que no ejecutó ninguna comprobación.

### 2. Credenciales y contratos de autenticación

`packages/auth/src/store.ts:createCredentialStore` cae automáticamente a JSON si no
puede cargar keytar. El handoff prohíbe ese fallback como default de release.
Los adapters de suscripción incluyen client IDs por defecto; la matriz actual no
demuestra autorización oficial para que MARS los use como cliente de terceros.

- [ ] Almacenamiento nativo probado en cada plataforma; archivo solo mediante elección explícita de desarrollo.
- [ ] Definir recuperación/migración de credenciales y fallo claro sin backend nativo.
- [x] Auditar con documentación oficial vigente qué flujos de suscripción son admitidos para MARS.
- [x] Resolver el desacuerdo entre el handoff y ADR 002: Anthropic browser auth queda bloqueado; OpenAI Codex y Kimi quedan experimentales y desactivados por defecto.
- [ ] Validar login, refresh, logout y tool calls con cuentas reales de los proveedores que se anuncien.

No se concluye aquí que esos flujos estén permitidos o prohibidos: queda pendiente
validación externa. Tener un adapter y tests simulados no resuelve ese punto.

### 3. Uso cotidiano y personalización

- [x] Corregir precedencia de skills por identidad: proyecto prevalece sobre usuario y `.mars` sobre `.forge`.
- [x] Actualizar skills relevantes al cambiar de tarea y al retomar sesión.
- [x] Compactar turnos antiguos completos al alcanzar el límite, conservando instrucciones y la tarea actual.
- [ ] Añadir ejemplos completos de configuración global/proyecto, roles, permisos, skills y MCP.
- [ ] Documentar dónde se guardan configuración, sesiones y credenciales, cómo borrarlas y cómo actualizar MARS.
- [ ] Validar primera instalación desde una cuenta/directorio limpio, sin estado del desarrollador.

Compaction es una mejora de uso diario propuesta; el handoff la aplaza más allá del MVP.

### 4. GitHub, paquete y release

- [x] Inicializar Git, crear el remoto público `ALVZ93/mars` y subir `main`.
- [x] Publicar el proyecto bajo Apache-2.0, añadir LICENSE y conservar NOTICE en el paquete.
- [x] Completar metadata del paquete para `ALVZ93/mars`, licencia y enlaces de soporte.
- [x] Preparar build previo a empaquetar, declarar types/exports y comprobar el contenido del tarball.
- [ ] Probar instalación global, npx y pnpm dlx desde el artefacto, en los tres sistemas.
- [ ] Verificar binario ejecutable, exports SDK y dependencias nativas con Node soportado.
- [ ] Confirmar nombre/scope y acceso de publicación npm; configurar release versionada y credencial de publicación apropiada.
- [x] Ejecutar CI remota en Windows, macOS y Linux.
- [ ] Ejecutar smoke tests reales de instalación y proveedores separados de los tests offline.
- [x] Actualizar README para que los límites y la política de autenticación coincidan con el código.
- [x] Añadir instrucciones de contribución, reporte privado de vulnerabilidades y changelog.

La publicación y las decisiones de licencia/cuenta son pasos posteriores; no se han realizado en esta revisión.

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
