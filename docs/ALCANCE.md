# BoneYardDog — Alcance del proyecto

Documento vivo: se actualiza al terminar cada fase.

## Visión

BoneYardDog ayuda a revisar discos en Windows 11 (64 bits). Su objetivo principal: **encontrar CARPETAS grandes que llevan mucho tiempo sin usarse** (por defecto más de 3 meses, configurable) para transferirlas a un disco externo o USB y liberar espacio. No busca archivos sueltos grandes (para eso ya existen otras apps). Es gratis y de código abierto (MIT).

Principio rector: **nunca perder datos por accidente**. Toda sugerencia pasa por protecciones conservadoras, y nada se borra definitivamente.

### Qué significa "sin uso"

Una carpeta está **sin uso** si **ningún archivo dentro** fue modificado, ni creado o copiado, en el período elegido. Su fecha de uso es la del archivo más reciente de todo su contenido (se muestra cuál es, para que se entienda por qué).

- **La fecha de último acceso se ignora por defecto**: antivirus, indexadores y copias de seguridad la cambian sin que el usuario abra nada, y causarían falsos "en uso". Se puede activar en opciones avanzadas.
- **La fecha de creación sí cuenta por defecto**: al copiar una carpeta, Windows conserva la fecha de modificación pero pone una de creación nueva; sin esto, una carpeta vieja recién restaurada de un respaldo se ofrecería como abandonada.
- Fechas en 0 o inválidas no cuentan. Un archivo sin ninguna fecha válida deja el uso "desconocido", y lo desconocido nunca se ofrece como abandonado.
- **Limitación:** si el usuario solo *lee* archivos (fotos, música, documentos de consulta) sin modificarlos, la app no puede saberlo. Por eso cada carpeta muestra su archivo más reciente y puede marcarse "Ignorar".

## Decisiones técnicas

| Decisión | Motivo |
|---|---|
| **Electron** para la app de escritorio | Una sola base de código en JavaScript, instalador para Windows y buen acceso al sistema de archivos. |
| **Núcleo sin dependencias externas** (solo módulos de Node.js) | El motor se prueba sin red, es fácil de auditar y no arrastra riesgos de terceros. |
| **Papelera por defecto** al eliminar | Un error del usuario (o nuestro) se puede deshacer. |
| **Mover a disco externo** como alternativa a borrar | Liberar espacio sin perder el archivo. |
| **Tamaño = `stat.size`** (tamaño real del archivo) | No es el "tamaño en disco" (clústeres, compresión NTFS, archivos dispersos, OneDrive "solo en la nube"), por lo que puede diferir de lo que muestra el Explorador. |
| **No seguir enlaces simbólicos ni junctions** | Evita bucles y contar dos veces. Se registran como "omitidos". |
| **Uso = modificación y creación (acceso opcional)** | Una sola definición (`useAccessTime`, `useCreationTime`) para todo el programa; ver "Qué significa sin uso". `atimeReliability` queda solo como información en opciones avanzadas. |
| **Carpetas, no archivos** | `findStaleFolders` devuelve la carpeta más alta que cumple, sin solapamientos y sin ofrecer nunca la carpeta escaneada. |
| **Configuración en `settings.json`** (carpeta de datos del usuario) | Esquema validado, escritura atómica; un archivo dañado o de otra versión vuelve a los valores por defecto sin romper nada. |
| **Carpetas ignoradas por el usuario** | Se guardan con la ruta que conoce el análisis; una carpeta con otra ignorada dentro no se ofrece entera. |
| **"Mostrar en el Explorador" solo para rutas del análisis** | Nunca abre ni ejecuta archivos; usa `shell.showItemInFolder`. |
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
| 2A | Correcciones, servicio de análisis en hilo aparte, esqueleto de Electron seguro y prueba automática en Windows | **Terminada** |
| 2B | Detección de carpetas grandes sin uso, configuración, ignoradas, unidades y pantalla de lista | **En curso** (esta) |
| 2C | Mapa visual de cuadros por tamaño, con color por antigüedad y selección con espacio total | Pendiente |
| 3 | Copiar a disco externo/USB con verificación y, solo después, enviar a la papelera | Pendiente |
| 4 | Instalador para Windows y publicación | Pendiente |

## Estructura

- `src/core/` — motor (escáner, análisis, protecciones). Sin dependencias.
- `src/service/` — servicio de análisis (`AnalysisService`) y su hilo (`analysis-worker.js`).
- `src/main/` — proceso principal de Electron: ventana, IPC validado (`validate.js`), configuración (`settings.js`), unidades (`drives.js`), puente seguro (`preload.js`) y prueba automática (`smoke.js`).
- `src/renderer/` — pantalla (HTML, CSS y JS propios, sin librerías).
- `assets/` — logo.
- `scripts/` — utilidades (`smoke.js` lanza la prueba automática; `medir-memoria.js` mide el tamaño del árbol).
- `test/` — pruebas (`npm test`).
- `docs/` — documentación.

## Medidas

Con 50 000 archivos (50 501 nodos), en Linux: ~358 bytes por nodo en memoria y ~203 bytes por nodo al serializarlo. Es una medida del árbol actual; todavía no se ha optimizado.

## Notas para la Fase 3 (acciones)

- **Las protecciones se vuelven a comprobar justo antes de actuar**, no solo al listar: entre el escaneo y la acción el disco puede haber cambiado (un enlace nuevo, una carpeta renombrada).
- **`isProtectedPath` no resuelve nombres cortos 8.3 dentro de la carpeta de usuario** (p. ej. `C:\Users\amir\DOCUME~1`). Hoy no es explotable porque el escáner entrega siempre nombres largos, pero la Fase 3 no debe aceptar rutas escritas a mano sin resolverlas antes.
