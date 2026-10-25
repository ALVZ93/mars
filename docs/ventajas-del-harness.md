# Qué aporta nuestro Harness: MARS

Fecha: 11 de octubre de 2026. Estado: capacidades del código local, incluidas las mejoras de esta entrega; no implica que estén publicadas en npm.

Verificación local: compilación TypeScript y **122 tests aprobados**, incluidos 15 nuevos sobre reparación, permisos e informes y 10 sobre memoria/procedimientos; una prueba corrige un archivo y vuelve a ejecutar checks reales de Node.

**MARS convierte una petición al modelo en trabajo sobre un repositorio con herramientas, permisos, continuidad y comprobaciones ejecutables. Su ventaja es controlar y hacer visible el proceso que lleva a un resultado útil.**

La entrega posterior añade [memoria revisada y captura local de procedimientos](direccion-producto.md): hechos aprobados por proyecto y borradores reutilizables desde sesiones verificadas, sin llamadas adicionales al modelo. El alcance se amplía a carpetas de trabajo con IA, manteniendo desarrollo como primer caso fuerte.

El modelo propone acciones y redacta respuestas. El harness ejecuta las herramientas, limita su alcance, conserva la sesión y comprueba los resultados. Un modelo mejor ayuda; una respuesta convincente por sí sola no demuestra que el código funcione.

## 1. Comparación que tiene sentido

En este documento, «sin harness» significa usar un chat o una API de modelo y coordinar manualmente el trabajo: proporcionar archivos, aplicar cambios, ejecutar comandos, copiar fallos y reconstruir el contexto. Si se añade todo eso a una integración propia, se está construyendo otro harness.

Compararnos con un agente de programación que ya incorpora estas funciones requiere otra evaluación. No podemos presentar herramientas, sesiones o permisos como exclusivos de MARS, ni afirmar que superamos a otros agentes sin una prueba comparable.

| Necesidad | Chat/API sin un runtime equivalente | Qué ofrece MARS hoy | Ventaja práctica |
| --- | --- | --- | --- |
| Trabajar sobre código real | Copiar archivos y aplicar propuestas manualmente; un chat puede trabajar con contexto incompleto. | Lectura, escritura, búsqueda, Git y shell sobre un workspace. | Acorta el ciclo entre entender el problema y producir un cambio revisable. |
| Mantener las reglas del proyecto | Repetir convenciones y comandos en cada conversación. | Carga de `AGENTS.md`, instrucciones locales y selección de skills por tarea. | Reduce la preparación repetida y hace reutilizables los procedimientos del equipo. |
| Retomar una tarea | Reconstruir el historial y explicar de nuevo lo que ocurrió. | Sesiones por proyecto, checkpoints de turnos completos y reanudación. | Permite continuar con el contexto registrado y diagnosticar dónde se interrumpió el trabajo. |
| Controlar acciones | Aprobar y ejecutar cada acción manualmente o programar permisos desde cero. | Políticas `allow/ask/deny`, restricciones de herramientas por fase y bloqueo de rutas sensibles en las herramientas de archivos. | Da control explícito sobre las acciones reconocidas por el runtime. |
| Saber si algo pasa los checks | Interpretar lo que afirma el modelo o ejecutar las pruebas por separado. | Comandos de verificación con exit code, salida y estado estructurados. | Separa «el agente terminó» de «los checks pasaron». |
| Recuperarse de un fallo de tests | Copiar el fallo al modelo, aplicar otra propuesta y repetir. | Reparación opt-in de workflows, con límite de intentos y nueva verificación. | Automatiza un ciclo frecuente sin dejarlo abierto indefinidamente. |
| Revisar lo sucedido | Reconstruir pasos desde una conversación extensa. | Informe exportable con duración, modelos, llamadas, errores, reparaciones e historial de checks. | Facilita revisión, integración en CI y comparación de ejecuciones. |
| Cambiar de modelo o integrar herramientas | Rehacer adaptadores, historial y ejecución de tools. | Interfaz común de proveedores, SDK, tools registrables y MCP stdio. | Permite reutilizar el mismo proceso con distintas integraciones. |

Estas ventajas dependen de tener buenos checks, un contexto útil y permisos adecuados. El harness no corrige por sí solo una especificación ambigua o una prueba que acepta comportamiento incorrecto.

## 2. Las ventajas que más valor aportan

### A. Verificación que pertenece al runtime

MARS ejecuta los comandos configurados para el proyecto. Si no se configuran, busca scripts estándar de `package.json`: `typecheck`, `test`, `lint` y `build`. Un proyecto de otro lenguaje puede definir, por ejemplo, `cargo test` o `python -m pytest`.

- Un check solo pasa con exit code cero.
- No encontrar checks deja la tarea sin verificar y hace fallar la verificación.
- Un permiso denegado tampoco cuenta como check superado.
- El runtime conserva la salida y detiene la secuencia ante el primer fallo.
- Los checks usan el mismo executor, permisos y sandbox de shell configurados para el agente.

**Valor:** quien revisa recibe evidencia de lo ejecutado, en lugar de depender del texto final del modelo. Esto permite convertir requisitos comprobables en una condición de entrega.

**Límite:** los checks cubren lo que el proyecto comprueba. Que pasen no demuestra ausencia de bugs, vulnerabilidades o cambios de requisitos.

Implementación: [verificación](../packages/tools/src/index.ts), [tests de runtime](../tests/v02.test.mjs).

### B. Ciclo de reparación acotado — añadido en esta entrega

Los workflows `bugfix` y `feature` pueden volver al implementador después de un check fallido:

```text
Plan/inspección → Implementación → Revisión de verificación → Checks
                                                             |
                                                    fallo ejecutado
                                                             |
                                Reparación → Nueva revisión → Checks
```

- Se activa con `--repair-attempts 1` o `verification.maxRepairAttempts`.
- Default: **0**. Rango: **0–3** reparaciones para todo el workflow.
- Reutiliza el proveedor, las herramientas permitidas y los permisos del implementador.
- Le entrega la tarea original, el comando fallido, su exit code y salida acotada como datos no confiables.
- Repite la lista de comandos seleccionada en la primera verificación, incluso si desaparecen scripts de `package.json`.
- No repara por falta de checks, permisos denegados, error del executor, timeout o cancelación.
- `review` no adquiere una fase de escritura: sigue sin reparar.
- Un workflow propio debe declarar explícitamente su `repairPhase` implementadora para participar.

**Valor:** resuelve el ciclo «test falla → localizar causa → corregir → probar» con menos coordinación manual y un límite visible de trabajo adicional.

**Límites:** los intentos adicionales pueden consumir tokens. Los límites de turnos, tools y timeout se aplican por fase; todavía no hay presupuesto monetario ni timeout global del workflow. Repetir comandos no impide que un modelo altere tests o scripts: el diff sigue necesitando revisión.

Implementación: [SDK](../packages/sdk/src/internal.ts), [workflows](../packages/runtime/src/workflows.ts), [contrato](decisions/005-verification-repair-and-reports.md), [pruebas de reparación](../tests/value.test.mjs).

### C. Informe de ejecución — añadido en esta entrega

`--report reports/tarea-001.json` exporta un JSON local. El SDK expone el último informe mediante `mars.lastRun`, también después de una operación fallida.

Cada operación registra:

- Identificador de ejecución y sesión; tipo `run`, `workflow` o `verify`.
- Estado `completed`, `failed` o `cancelled`, timestamps y duración.
- Modelos utilizados, peticiones, reintentos, llamadas a tools, errores y denegaciones de permisos observados.
- Intentos de reparación e historial de verificaciones, con comando, exit code y salida.
- Tokens comunicados por cada proveedor, con número de muestras; ausencia de muestras significa **consumo desconocido**.
- Estado de verificación independiente: `not-run`, `passed` o `failed`.

Si se usa `--verify` después de una tarea normal, la exportación contiene ambas operaciones. Una fase posterior a unos checks invalida su estado de verificación vigente: el historial conserva esos checks, pero no certifica la nueva fase.

**Valor:** permite responder «qué se ejecutó, qué falló y qué pasó después» y preparar comparaciones medibles. El informe no incluye campos de prompts ni respuestas del modelo.

**Límites:** comandos y salida de checks pueden contener información privada. La exportación se solicita expresamente, se limita a rutas permitidas del workspace y rechaza archivos existentes. `--no-save` desactiva sesiones/eventos, pero no cancela una exportación pedida con `--report`. No hay cálculo fiable de euros, atribución completa del diff ni almacenamiento histórico automático de estos informes.

Implementación: [esquema y contadores](../packages/sdk/src/reports.ts), [exportación CLI](../apps/cli/src/commands/index.ts), [pruebas de informes](../tests/value.test.mjs).

### D. Proceso reutilizable y extensible

MARS permite separar planificación, implementación y revisión mediante workflows; asignar proveedores por rol; registrar herramientas; conectar servidores MCP; y embeber el runtime en otra aplicación mediante el SDK.

**Valor:** las convenciones y los límites pertenecen a nuestro proceso y pueden mantenerse al cambiar de proveedor. Una integración propia no tiene que reconstruir el bucle de ejecución, sesiones y verificaciones.

**Límites:** routing por rol no equivale a elegir dinámicamente el modelo óptimo por coste o salud. Distintos roles tampoco garantizan revisores independientes: pueden usar el mismo proveedor e historial. La compatibilidad depende del adaptador y de las credenciales disponibles, no de una suscripción universal.

Implementación: [routing](../packages/runtime/src/routing.ts), [SDK](../packages/sdk/src/index.ts), [MCP](../packages/tools/src/mcp.ts), [autenticación por proveedor](auth/provider-matrix.md).

## 3. Cómo usar las mejoras

Configurar checks concretos hace que la verificación tenga valor desde el primer día. Ejemplo de `.mars/config.json`:

```json
{
  "verification": {
    "commands": ["pnpm typecheck", "pnpm test"],
    "maxRepairAttempts": 1
  }
}
```

Los comandos deben existir en ese repositorio; este proyecto usa `pnpm build` y `pnpm test`. También se puede configurar el número de reparaciones sin sustituir los comandos:

```sh
mars config set verification.maxRepairAttempts 1
```

Una corrección con una reparación como máximo y un informe nuevo:

```sh
mars run "Corrige la regresión de paginación y añade su prueba" --workflow bugfix --repair-attempts 1 --report reports/paginacion-001.json
```

Una revisión con checks y sin fase de reparación:

```sh
mars run "Revisa el diff y señala errores concretos" --workflow review --report reports/revision-001.json
```

Una tarea normal con verificación posterior:

```sh
mars run "Añade la validación solicitada" --verify --report reports/validacion-001.json
```

Hace falta seleccionar previamente un modelo autenticado o pasar `--model provider:model`. Los permisos siguen aplicándose: con `shell: ask`, hay que aprobar los comandos. En automatización sin terminal, `ask` deniega shell; `--allow-shell` autoriza su ejecución en ese proceso y debe reservarse para un workspace y comandos de confianza. Los workflows anteriores ya incluyen verificación: no necesitan además `--verify`.

## 4. Qué falta y merece incorporarse después

La prioridad debe depender del problema que elimina, no de cuántas funciones añade al catálogo.

| Prioridad | Función pendiente | Beneficio concreto | Condición para considerarla terminada |
| --- | --- | --- | --- |
| Alta | Presupuesto global de tarea: tiempo, peticiones y tokens; coste cuando haya datos fiables. | Evitar que fases, reparaciones y reintentos acumulen trabajo por encima de lo esperado. | Todas las fases comparten contador; se corta antes de nuevas llamadas; uso desconocido se trata explícitamente. |
| Alta | Evaluaciones de tareas reales con baseline y criterios de aceptación. | Saber si MARS aumenta el porcentaje de entregas correctas y reduce intervención humana. | Mismas tareas/modelo/límites; resultados revisados; fallos incluidos; informe reproducible. |
| Alta | Atribución de cambios y checkpoint Git aislado opt-in. | Distinguir el trabajo del agente de cambios previos y facilitar recuperación. | Preserva cambios del usuario, detecta modificaciones externas y nunca hace rollback destructivo automático. |
| Media | Revisión independiente configurable. | Detectar errores de la implementación sin compartir todas sus suposiciones. | Contexto acotado, tools de lectura, hallazgos con archivo/línea; revisión y tests medidos por separado. |
| Media | Routing que considere salud y fallback explícito. | Reducir bloqueos por indisponibilidad sin repetir efectos ya ejecutados. | Consentimiento sobre proveedores/datos; transición trazable; límites de coste; no reejecuta tools por cambiar de modelo. |

Las dos mejoras de esta entrega —reparación acotada e informes— ya están implementadas, no forman parte de esta lista pendiente. Un marketplace de skills, más modelos en un catálogo o más fases no serían prioridades sin evidencia de utilidad.

## 5. Cómo demostrar el valor sin inventar ROI

Preparar una batería pequeña de tareas representativas: una regresión, una feature con requisitos comprobables, una revisión con defectos conocidos y una interrupción que deba retomarse. Para evitar que una demo favorable se confunda con una evaluación, fijar antes los criterios de aceptación y conservar también los fallos.

Comparar el mismo modelo con y sin MARS, en copias equivalentes del repositorio. Registrar cuánto trabajo manual exige cada condición; controlar el presupuesto y la calidad de las instrucciones.

| Métrica | Qué medir |
| --- | --- |
| Entrega correcta | Checks de aceptación superados y revisión del diff; no basta el mensaje final. |
| Tiempo | Tiempo hasta un resultado aceptable, incluida la intervención humana. |
| Coordinación manual | Veces que hubo que aportar archivos, trasladar errores, ejecutar checks o reconstruir contexto. |
| Recuperación | Fallos de verificación reparados dentro del límite; intentos agotados y causas. |
| Consumo | Peticiones y tokens comunicados; marcar datos ausentes y no tratarlos como cero. |
| Calidad del cambio | Defectos nuevos, cambios fuera de alcance y tests debilitados, detectados por revisión independiente. |

**Todavía no tenemos evidencia para prometer un porcentaje de ahorro, mayor calidad que cualquier otro agente o funcionamiento al 100%.** Las pruebas deterministas verifican el runtime; no sustituyen esta evaluación con modelos y tareas reales.

## 6. Límites del estado actual

- Las políticas de shell reconocen patrones de comandos; no son aislamiento del sistema operativo. Shell en host y servidores MCP configurados deben tratarse como código de confianza.
- El bloqueo de rutas sensibles se aplica a las herramientas de archivos y Git del harness; no garantiza que un comando autorizado en host no pueda leerlas.
- El modo Docker es opcional; su ejecución real no se ha validado en esta máquina por falta de un motor disponible.
- Persistir una sesión permite retomar contexto; no hace transaccionales las escrituras ni deshace efectos de tools al interrumpir el proceso.
- Los datos de sesiones y eventos se guardan localmente. Usar un proveedor remoto envía el contexto necesario a ese proveedor; «local» no significa que todas las llamadas sean offline.
- La evidencia histórica de skills/workflows cuenta resultados observados; no demuestra aprendizaje, causalidad ni calidad semántica del código.
- Quedan pendientes validación online de proveedores, instalación limpia con dependencias y revisión de vulnerabilidades de dependencias, descritas en la [auditoría técnica](audit-2026-10-11.md).

La propuesta defendible es: **un proceso de desarrollo asistido controlable, extensible y comprobable, con menos coordinación manual y evidencia de sus límites.**
