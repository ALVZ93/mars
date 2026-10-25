# 006 — Memoria y aprendizaje revisados por proyecto

Estado: aceptado. Fecha: 2026-10-11.

## Objetivo y alcance

MARS pasa a ser un asistente de trabajo con IA sobre un workspace: conserva hechos útiles y convierte sesiones verificadas en procedimientos reutilizables. Primera entrega local, textual y por proyecto. No añade mensajería, cron, embeddings, delegación, publicación de skills ni entrenamiento del modelo.

## Autoridad y datos

- El agente puede proponer una nota mediante `propose_memory`; nunca recibe herramientas para aprobar, rechazar o borrar conocimiento.
- `mars memory` permite listar, ver, proponer, aprobar, rechazar y olvidar notas. `mars skills` mantiene la lista de skills y añade revisión de procedimientos propuestos.
- `mars learn SESSION_ID` / SDK `learnFrom` capturan localmente un borrador a partir de herramientas exitosas y checks de una sesión guardada. Se permite únicamente si la última operación terminó y pasó checks reales. Una respuesta textual no constituye evidencia.
- La captura no llama al modelo ni ejecuta shell, archivos del proyecto o MCP. Extrae nombres/rutas de archivos y comandos, sin copiar contenidos de archivos ni outputs; filtra credenciales reconocibles. La sesión fuente no se modifica. El usuario debe generalizar y revisar el borrador antes de aprobarlo.
- Toda propuesta nace pendiente, con nombre, contenido y origen. La aprobación explícita la activa; reemplazar una entrada del mismo tipo/nombre requiere otra propuesta y aprobación. El rechazo no elimina el contenido; `forget` sí.
- `.mars/knowledge.json` es versionado, acotado y específico del workspace. Escrituras atómicas y lock entre procesos evitan perder actualizaciones. Un lock abandonado se comunica, no se elimina automáticamente.
- Se rechazan rutas enlazadas, archivos no regulares y formas reconocibles de credenciales. Es un filtro parcial, no una garantía de detección de secretos o prompt injection.
- Los datos aprobados son referencia subordinada a políticas e instrucciones actuales. Nunca se cargan pendientes/rechazados. Las notas tienen presupuesto JSON total de 8.000 caracteres; las skills se seleccionan por relevancia.
- Las notas se refrescan al empezar cada fase/tarea; al olvidar se retira el bloque inyectado en próximas tareas. Desactivar la integración se aplica al crear/reanudar una sesión y retira bloques heredados al ejecutar la siguiente tarea. No se promete borrar menciones ya copiadas a conversaciones anteriores.
- `knowledge.enabled` controla la integración automática de la CLI. `--no-save` desactiva también esa integración. SDK requiere `knowledgeStore` explícito.
- Shell host/MCP siguen siendo código de confianza; la revisión del harness no puede impedir que código arbitrario autorizado modifique sus archivos.

## Compatibilidad y evidencia

- Sesiones antiguas sin recibo siguen reanudándose, pero no se pueden usar como fuente de aprendizaje verificado.
- Se guarda un recibo mínimo de la última operación, ligado al número de mensajes. Comenzar otra operación invalida el recibo anterior; una caída intermedia no conserva una verificación antigua como vigente.
- Aprender no exporta historiales ni consume tokens. La extracción semántica con un modelo queda pendiente: la revisión automática rechazó implementar el envío de historiales sin autorización específica para esa transferencia.

## Aceptación

1. Nota propuesta en una sesión no aparece en otra hasta aprobar; tras aprobar aparece y tras olvidar desaparece de la próxima tarea.
2. Una sesión verificada con tools exitosas produce una skill pendiente mediante captura local; solo tras aprobar se selecciona en tareas relevantes.
3. Sesión fallida, no verificada, sin pasos reutilizables, de otro workspace o legacy: rechazo sin llamadas al modelo.
4. Nombres/rutas inválidos, credenciales reconocibles, versión futura, archivo corrupto, presupuesto excedido y enlaces: rechazo sin modificar el conocimiento aprobado.
5. Escrituras concurrentes desde dos instancias conservan ambas propuestas. Repetir aprobación no duplica datos; aprobar una revisión supersede la anterior.
6. CLI y SDK cubren el ciclo completo; cancelación no crea ni activa conocimiento parcial. Ninguna propuesta activa permisos, modifica políticas o ejecuta sus procedimientos.

Verificación: tests de almacenamiento, contexto, extracción y CLI con proveedores deterministas; suite completa y compilación.
