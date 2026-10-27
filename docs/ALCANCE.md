# BoneYardDog — Alcance del proyecto

Documento vivo: se actualiza al terminar cada fase.

## Visión

BoneYardDog ayuda a revisar discos en Windows 11 (64 bits): muestra qué ocupa más espacio y, sobre todo, qué lleva mucho tiempo sin usarse, para eliminarlo (a la papelera) o moverlo a un disco externo. Es gratis y de código abierto (MIT).

Principio rector: **nunca perder datos por accidente**. Toda sugerencia pasa por protecciones conservadoras, y nada se borra definitivamente.

## Decisiones técnicas

| Decisión | Motivo |
|---|---|
| **Electron** para la app de escritorio | Una sola base de código en JavaScript, instalador para Windows y buen acceso al sistema de archivos. |
| **Núcleo sin dependencias externas** (solo módulos de Node.js) | El motor se prueba sin red, es fácil de auditar y no arrastra riesgos de terceros. |
| **Papelera por defecto** al eliminar | Un error del usuario (o nuestro) se puede deshacer. |
| **Mover a disco externo** como alternativa a borrar | Liberar espacio sin perder el archivo. |
| **Tamaño = `stat.size`** (tamaño real del archivo) | No es el "tamaño en disco" (clústeres, compresión NTFS, archivos dispersos, OneDrive "solo en la nube"), por lo que puede diferir de lo que muestra el Explorador. |
| **No seguir enlaces simbólicos ni junctions** | Evita bucles y contar dos veces. Se registran como "omitidos". |
| **Fecha de "último uso" = la más reciente entre acceso (atime) y modificación (mtime)** | Windows suele tener desactivado el registro de último acceso, por eso el motor evalúa si atime es fiable. |
| **Protecciones fijas** (Windows, Program Files, etc.) | Lo protegido nunca se sugiere para eliminar ni mover. |
| **AppData protegida** (también `NTUSER.DAT*`, `.ssh`, `.gnupg`, `.aws`) | Borrar ahí puede romper programas, perfiles o claves. La opción `allowAppData` queda preparada para un "modo avanzado" futuro, sin interfaz todavía. |
| **Lo no leído nunca se ofrece entero** | Una carpeta con subcarpetas ilegibles o sin datos no se sugiere completa: su tamaño y su fecha de uso no son confiables. |
| **El análisis corre en un hilo aparte** (`worker_threads`) | El árbol de un disco grande ocupa del orden de 1 GB; no debe congelar la ventana. |
| **El árbol completo nunca viaja a la interfaz** | La interfaz solo recibe resultados pequeños ("nodos livianos") y solo manda rutas, nunca datos de nodos. El servicio busca cada ruta en su propio árbol y rechaza las desconocidas. |
| **Electron aislado por diseño** | `contextIsolation`, sin `nodeIntegration`, `sandbox`, CSP estricta, sin red, IPC validado, y la carpeta a escanear solo sale del diálogo del sistema. |
| **Node 22** | Node 20 ya salió de soporte. |

## Fases

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Núcleo de escaneo, reglas de análisis y protecciones (sin interfaz) | **Terminada** |
| 2A | Correcciones de la revisión, servicio de análisis en hilo aparte, esqueleto de Electron y prueba automática en Windows | **En curso** |
| 2B | Interfaz completa: árbol, listas de resultados y selección | Pendiente |
| 3 | Acciones: enviar a la papelera, mover a disco externo, con confirmación | Pendiente |
| 4 | Instalador para Windows y publicación | Pendiente |

## Estructura

- `src/core/` — motor (escáner, análisis, protecciones). Sin dependencias.
- `src/service/` — servicio de análisis (`AnalysisService`) y su hilo (`analysis-worker.js`).
- `src/main/` — proceso principal de Electron: ventana, IPC validado (`validate.js`), puente seguro (`preload.js`) y prueba automática (`smoke.js`).
- `src/renderer/` — pantalla de prueba (HTML, CSS y JS propios, sin librerías).
- `assets/` — logo.
- `scripts/` — utilidades (`smoke.js` lanza la prueba automática; `medir-memoria.js` mide el tamaño del árbol).
- `test/` — pruebas (`npm test`).
- `docs/` — documentación.

## Medidas

Con 50 000 archivos (50 501 nodos), en Linux: ~358 bytes por nodo en memoria y ~203 bytes por nodo al serializarlo. Es una medida del árbol actual; todavía no se ha optimizado.

## Notas para la Fase 3 (acciones)

- **Las protecciones se vuelven a comprobar justo antes de actuar**, no solo al listar: entre el escaneo y la acción el disco puede haber cambiado (un enlace nuevo, una carpeta renombrada).
- **`isProtectedPath` no resuelve nombres cortos 8.3 dentro de la carpeta de usuario** (p. ej. `C:\Users\amir\DOCUME~1`). Hoy no es explotable porque el escáner entrega siempre nombres largos, pero la Fase 3 no debe aceptar rutas escritas a mano sin resolverlas antes.
