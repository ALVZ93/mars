# MARS en 5 minutos

## Qué es

MARS es una herramienta de terminal que pone a trabajar a un modelo de IA (ChatGPT, Claude, Gemini…) sobre tu proyecto. Le describes un problema y el modelo lo arregla.

Hasta ahí, como cualquier asistente de código. La diferencia es esta: **MARS no se fía de lo que dice el modelo. Lo comprueba.**

Cuando un asistente normal te dice «arreglado, los tests pasan», tienes que creértelo o comprobarlo tú. MARS ejecuta las comprobaciones por su cuenta y te entrega un **recibo** con lo que pasó de verdad.

## Qué hace distinto, con un ejemplo

Tienes este bug: «la página 1 del listado muestra los elementos de la página 2».

```sh
mars run "La página 1 muestra los elementos de la página 2" --workflow bugfix --isolate --receipt recibo.md
```

MARS hace esto, en orden:

1. **Mira el código** sin tocar nada.
2. **Escribe un test que demuestra el bug** y declara qué casos cubre. MARS lo ejecuta y exige que falle. Si no falla, el bug no está demostrado y MARS se para: no «arregla» algo que no ha visto roto.
3. **Comprueba que el fallo viene de ese test.** Lo vacía un momento, repite y verifica que el resultado cambia.
4. **Arregla el código.** El test queda bloqueado: el modelo no puede «hacer trampa» cambiándolo para que pase.
5. **Ejecuta tus tests** y vuelve a pasar el test del bug sobre el resultado final.
6. **Te da el recibo:**

```text
✅ MARS — Fixed and proven
- Before the fix: failed with exit 1 — expected
- With the test emptied: exit 0 — the failure comes from the test
- After the fix: passed (exit 0)
1 protected file(s) unchanged: test/paginate.test.js
2 file(s) in isolated run: src/paginate.js, test/paginate.test.js
```

El recibo, extractado, sale en inglés para poder pegarlo en un PR de cualquier equipo. Dice: qué casos cubre la prueba (solo esos quedan demostrados), falló antes del arreglo, el fallo viene del test, pasa después, el test protegido no cambió, y estos son los archivos cambiados.

Si el código está bien y lo que falla es un test antiguo, MARS no «arregla» el código: propone el cambio del test con ⚠️ *Test change proposed* y te deja decidir.

Si algo sale mal (no se pudo reproducir, se acabó el tiempo, alguien tocó el test), el recibo lo dice. MARS no adorna resultados.

## Tu código está a salvo

Con `--isolate`, MARS trabaja en **una copia aparte** de tu proyecto. Tus archivos no cambian hasta que tú decidas:

```sh
mars runs diff ID      # ver exactamente qué cambió el modelo
mars runs apply ID     # aplicarlo a tu proyecto
mars runs discard ID   # tirarlo
```

La copia empieza desde tu estado actual, incluidos los cambios que aún no has guardado en Git.

## Empezar

Necesitas Node.js 24 o posterior.

```sh
npm install --global @alvz93/mars
cd tu-proyecto
mars init
mars doctor
```

Conecta un modelo. Con una suscripción de ChatGPT:

```sh
mars login openai-codex
mars config set model.default openai-codex:gpt-5.6-sol
```

Para probar sin cuenta ni coste existe un modelo simulado: `--model fake:scripted`.

## Otras cosas útiles

- **Presupuesto:** `--budget-time 900000 --budget-requests 40` corta la tarea si se pasa de 15 minutos o 40 peticiones al modelo.
- **Proteger archivos:** en `.mars/config.json`, `"contract": { "protect": ["tests/**"] }` impide que el modelo toque esos archivos.
- **Sesión interactiva:** `mars` sin argumentos abre un chat sobre tu proyecto.
- **Revisión:** `mars run "revisa mis cambios" --workflow review` revisa el diff actual sin modificar nada.

## Preguntas frecuentes

**¿Es más rápido que usar ChatGPT o Codex directamente?**
No. En bugs sencillos, la app del modelo suele tardar menos. MARS añade pasos para poder demostrar el resultado. Lo que ganas es poder fiarte sin revisarlo todo tú, y en adelante, que MARS combine varios modelos para resolver lo que uno solo no resuelve.

**¿Cuánto cuesta?**
MARS es gratuito y de código abierto. El coste es el de tu modelo: con una suscripción de ChatGPT se consume su cuota; con una API key se paga por uso. Un bug sencillo usa del orden de 100–200 mil tokens con Codex, la mayoría cacheados.

**¿Envía mi código a algún sitio?**
Solo al proveedor de modelo que elijas, como cualquier asistente. MARS no tiene servidor propio ni telemetría. Sesiones, recibos y configuración se quedan en tu proyecto (`.mars/`).

**¿Y si el modelo no consigue arreglarlo?**
El recibo dice «Failed» y explica por qué. Con `--isolate`, tu proyecto queda intacto.

**¿Qué modelos admite?**
ChatGPT (suscripción, a través de Codex), OpenAI API, Anthropic, Gemini, Qwen, Kimi, OpenRouter y modelos locales con Ollama. `mars models` lista los disponibles.

## Para saber más

- [Arquitectura](arquitectura.md): cómo funciona por dentro.
- [Configuración](configuration.md): todas las opciones.
- [Resultados de evaluación](../evals/RESULTS.md): cómo se mide si MARS aporta algo.
