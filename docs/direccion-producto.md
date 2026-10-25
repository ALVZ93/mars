# MARS: un workspace para trabajar con IA

Decisión de producto: 11 de octubre de 2026.

**MARS debe ser útil para quienes trabajan con IA de forma habitual: conservar contexto que merece durar, reutilizar procedimientos y controlar las acciones del agente.** El primer entorno es una carpeta de trabajo local, con repositorios como caso de uso fuerte. La interfaz actual sigue siendo terminal y SDK.

La referencia de Hermes ayuda a orientar memoria y reutilización. No buscamos declarar equivalencia funcional: esta entrega no incorpora mensajería, agentes paralelos, cron ni un asistente permanentemente activo.

## Lo implementado en esta entrega

| Necesidad | Comportamiento disponible |
| --- | --- |
| No repetir convenciones y preferencias | Memoria revisada por proyecto; solo notas aprobadas se incorporan a las siguientes tareas. |
| Que el modelo pueda recordar algo útil | Tool `propose_memory`: crea una propuesta pendiente y muestra su identificador para revisión. No puede aprobarla mediante esa tool. |
| Reutilizar trabajo que ya funcionó | `mars learn SESSION_ID` captura localmente un borrador de procedimiento desde acciones exitosas de una sesión verificada. |
| Evitar que una ocurrencia se convierta en regla | Listado, inspección, aprobación, rechazo y eliminación explícitos de notas y procedimientos. |
| Revisar de dónde sale lo aprendido | Origen, sesión y run de referencia; recibo persistido de la última verificación. |
| Cambiar una regla sin perder control | Una revisión nueva permanece pendiente; aprobarla supersede la versión aprobada del mismo nombre. |
| Trabajar sin conectividad para gestionar conocimiento | Memoria, revisión y captura local no requieren modelo, credenciales ni llamadas al proveedor. |

El prompt base admite trabajo general sobre el workspace. Las herramientas siguen siendo textuales: archivos, búsqueda, shell, Git y las integraciones MCP configuradas. Generar documentos Office, investigar en la web o controlar otras aplicaciones requiere las herramientas apropiadas; cambiar el posicionamiento no añade esas capacidades por sí solo.

## Uso diario

### Guardar una convención del proyecto

```sh
mars memory add idioma-informes "Redactar los informes de este proyecto en español y con conclusiones breves."
mars memory pending
mars memory show ID
mars memory approve ID
```

`ID` es el identificador que imprime `add` o `pending`. No hay activación implícita: hasta aprobar, la nota no se carga como memoria. En una conversación, `/remember NOMBRE CONTENIDO` crea la misma propuesta; `/memory` y `/memory show ID` permiten revisarla.

También se puede pedir al agente que proponga una nota. El runtime muestra `[memory pending] ID` cuando la propuesta se guarda, aunque el modelo no lo explique bien.

### Reutilizar una sesión verificada

```sh
mars run "Corrige la regresión y añade una prueba" --workflow bugfix --repair-attempts 1
mars learn SESSION_ID
mars skills pending
mars skills show ID
mars skills approve ID
```

`SESSION_ID` es la sesión guardada de la tarea. El workflow ya ejecuta checks. Para una tarea normal se puede usar `--verify` o `/check` después de trabajar en una sesión interactiva; `/learn` captura la sesión interactiva actual.

La captura local:

- Exige que la última operación guardada haya completado y pasado checks reales.
- Extrae nombres de tools, rutas y comandos exitosos de la última tarea; añade los comandos de verificación.
- No copia contenidos de archivos ni salida de tools al procedimiento.
- No ejecuta los pasos, no modifica la sesión fuente y no llama al modelo.
- Produce un borrador pendiente. Debe revisarse y generalizarse: los pasos capturados pueden ser específicos, incompletos o insuficientes para otros casos.
- Solo tras aprobar se selecciona la skill en tareas relevantes; no se añade a todas las conversaciones.

Las sesiones antiguas sin recibo y las tareas sin pasos reutilizables no pueden convertirse en un procedimiento verificado. La compactación puede haber eliminado pasos del historial; la captura no reconstruye lo que ya no está.

### Escribir un procedimiento directamente

Para trabajo no relacionado con código, o cuando no hay checks automáticos adecuados:

```sh
mars skills add comparativas "Para comparar herramientas: fijar criterios, consultar fuentes primarias, registrar fechas y enlaces, separar hechos de inferencias y revisar las conclusiones."
mars skills show ID
mars skills approve ID
```

Esta propuesta identifica su origen como usuario; no afirma que proceda de una ejecución verificada. Se puede usar el mismo nombre para proponer una revisión, que sustituye la anterior solo al aprobar.

### Corregir, rechazar u olvidar

```sh
mars memory reject ID
mars memory forget ID
mars skills reject ID
mars skills forget ID
mars config set knowledge.enabled false
```

`reject` conserva la propuesta para inspección; `forget` elimina su contenido del almacén. Al olvidar una entrada deja de inyectarse en las próximas tareas; sus menciones en historiales anteriores no se borran. La configuración se aplica al crear o reanudar una sesión. `--no-save` desactiva la integración automática del almacén para esa invocación; `learn --no-save` se rechaza porque aprender guarda una propuesta.

## SDK

La integración es explícita para aplicaciones que embeben MARS:

```ts
import { createMars, FileKnowledgeStore } from '@alvz93/mars';

const mars = await createMars({
  workspace,
  provider,
  model,
  sessionStore,
  knowledgeStore: new FileKnowledgeStore(workspace),
});

try {
  await mars.run(task);
  // Tras verificar y guardar la sesión:
  // const proposal = await mars.learnFrom(sourceSessionId);
} finally {
  await mars.close();
}
```

`workspace`, `provider`, `model`, `sessionStore` y `task` los proporciona la aplicación. `includeProjectContext: false` desactiva también la carga automática de notas y skills; no elimina el almacén. El SDK expone `KnowledgeStore`, entradas y procedencia como tipos públicos y emite `knowledge:proposed` sin contenido de las notas.

## Límites de confianza y datos

Los datos viven en `.mars/knowledge.json`, asociados al workspace y con versión de formato. Las escrituras usan un lock entre procesos y reemplazo atómico. Un lock abandonado produce un error; no se elimina automáticamente porque podría pertenecer a otro escritor activo.

El almacén rechaza enlaces, formatos inválidos, versiones futuras, presupuestos excedidos y algunas formas reconocibles de credenciales. Ese filtro no detecta todos los secretos ni toda instrucción maliciosa. Las notas aprobadas se introducen como referencia subordinada a la petición actual y las políticas del runtime.

La revisión ocurre en el harness; shell host y MCP autorizados siguen siendo código de confianza. No es una frontera de seguridad frente a código arbitrario que tenga permiso para escribir en `.mars`.

La captura local no envía historiales. Cuando se reutilizan notas o skills en una tarea con un proveedor remoto, pasan a formar parte del contexto enviado a ese proveedor, como las demás instrucciones del proyecto. No deben contener secretos.

## Qué significa «aprendizaje» aquí

MARS ahora conserva conocimiento aprobado y reutiliza procedimientos seleccionados por relevancia. **No entrena el modelo ni deduce automáticamente una estrategia general a partir del éxito de un test.** La captura es un punto de partida local y revisable.

La extracción semántica mediante un modelo queda fuera de esta entrega: requiere un flujo explícito para seleccionar y autorizar qué historial se enviaría al proveedor. La alternativa local permite completar el ciclo de reutilización sin esa transferencia adicional.

## Siguientes prioridades

1. Presupuesto global de tarea que abarque fases, reparaciones y reintentos: tiempo y peticiones primero; tokens/coste cuando estén disponibles.
2. Búsqueda local de sesiones con fragmentos y ámbito explícito, para recuperar decisiones sin cargar historiales completos.
3. Evaluaciones con tareas reales de desarrollo, análisis y documentación: corrección, intervención humana, tiempo y consumo comunicado.
4. Procedimientos con parámetros y revisión de cambios más cómoda; extracción semántica solo con un flujo explícito para seleccionar y autorizar los datos enviados.
5. Integraciones para trabajo general, elegidas por casos de uso concretos y con permisos claros. Cron, mensajería y delegación requieren contratos propios antes de incorporarse.

El contrato técnico y los casos de aceptación están en [ADR 006](decisions/006-reviewed-project-knowledge.md); las pruebas en [knowledge.test.mjs](../tests/knowledge.test.mjs). Los bloqueos de validación online y distribución siguen recogidos en [preparación de release](release-readiness.md).

Validación de esta entrega: compilación TypeScript y **122/122 tests aprobados** en Windows/Node 24.11.1, incluidos 10 nuevos tests de conocimiento; duración de la suite completa: 55,75 s. No se han hecho llamadas facturables ni publicado el paquete.
