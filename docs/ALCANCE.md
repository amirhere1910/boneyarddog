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

## Copia y transferencia (Fase 3A)

El motor (`src/core/transfer.js`) copia carpetas a otro disco (USB/pendrive, disco duro o SSD; destinos NTFS, exFAT o FAT32), **verifica** la copia y, solo si todo quedó verificado, retira el original: **Papelera** (con aviso si puede no caber) o **cuarentena** (`BoneYardDog-Cuarentena`, en el mismo disco, sin borrar). Corre en su propio hilo (`src/service/transfer-service.js`). **No tiene pantallas todavía** y la app normal no lo usa (Fase 3B). Garantías y límites, en lenguaje llano: [`SEGURIDAD-TRANSFERENCIAS.md`](SEGURIDAD-TRANSFERENCIAS.md). Guía para probar a mano con USB reales: [`PRUEBAS-MANUALES.md`](PRUEBAS-MANUALES.md).

Decisiones de esta fase:

- **El original nunca se elimina por la fuerza**: solo Papelera inyectada o `rename` a cuarentena, y solo tras verificación completa y tras comprobar que el origen no cambió. Una prueba revisa el código fuente y otras espían el sistema de archivos.
- **Verificación completa por defecto** (huella SHA-256 archivo por archivo); la **rápida** (tamaño y fecha) existe pero se rotula siempre «no comprueba el contenido» y **no permite retirar el original**.
- **Nunca sobrescribe**: los archivos se abren con «crear, no existir» y cada lote tiene carpeta propia (`BoneYardDog\<fecha>\<unidad>\<ruta original>`), con `ESTADO.json`, `MANIFIESTO.json` y `LEEME.txt`.
- **Lo que no se copia impide retirar el original**: si una carpeta tiene enlaces, elementos ilegibles o especiales, se copia pero su original no se toca.
- **Papelera**: se rechaza si el volumen es extraíble o si lo enviado supera el 5 % del disco de origen (estimación de la cuota por omisión de Windows), salvo aceptación explícita.
- **La Papelera real vive en el proceso principal** (`shell.trashItem`): el motor la recibe inyectada y el hilo se la pide por mensajes.
- **Una sola excepción a «sin `child_process`»**: `src/main/volume-info.js` (tipo y formato de la unidad por PowerShell, con `execFile`, sin shell, 8 s como máximo y salida validada). Los lanzadores de `scripts/` también lo usan, pero no forman parte de la aplicación.
- **`BoneYardDog-Cuarentena` es una ruta protegida**: el detector nunca la ofrece.
- **Pruebas de mutación** (`node scripts/mutaciones-transferencia.js`): se rompe el motor a propósito y se comprueba que alguna prueba falle.
- **Pulido del mapa**: los cuadros diminutos (menos de 20 px de lado o 500 px²) se pliegan en «Otras» y nunca reciben foco; en la pestaña Mapa la ventana es una columna a pantalla completa; el tope de 500 carpetas seleccionadas avisa sin perder la selección; 40 celdas por defecto.

## El mapa (Fase 2C)

Dos pestañas: **Mapa** (la que se abre al terminar de escanear) y **Lista de candidatas**. El período "Sin uso desde hace" es el mismo para las dos.

**Cuadros.** Cada subcarpeta de la carpeta actual es un cuadro; su área es proporcional a su tamaño (algoritmo *squarified treemap*, `src/shared/treemap.js`). Se muestran las carpetas de más de X (10 MB a 1 GB, por defecto 100 MB, se guarda en `mapMinBytes`). Lo que queda bajo el mínimo, o fuera del tope de celdas (80 por defecto), se agrupa en un cuadro "Otras"; los archivos sueltos de la carpeta forman otro cuadro. La suma de todos los cuadros es siempre el tamaño de la carpeta: no se pierde nada.

**Colores por actividad** (`src/shared/activity.js`), según los días sin uso (D) frente al período elegido (P):

| Estado | Condición | Color |
|---|---|---|
| Muy reciente | D ≤ P/3 | naranja |
| Reciente | D ≤ P | amarillo |
| Sin movimiento | D ≤ 2·P | azul |
| Muy antigua | D > 2·P | plomo azulado oscuro |
| Desconocido | sin fecha | gris claro |

Cálidos = hubo movimiento reciente; fríos = no. Todos los pares de color de fondo y de texto cumplen contraste WCAG ≥ 4,5 (hay una prueba). **El color nunca va solo**: cada cuadro lleva texto ("Sin uso hace 1 año"), tiene nombre accesible, y la leyenda explica los cinco estados con sus límites.

**Interacción.**
- Clic o Enter en una carpeta con subcarpetas: **entra** a ella (migas de pan para volver; Retroceso sube un nivel). En una carpeta sin subcarpetas, el clic abre sus detalles.
- Ctrl+clic o Espacio: marca/desmarca (borde grueso y ✓) sin entrar. La barra de selección inferior suma el espacio con `summarizeSelection` (sin contar dos veces una carpeta y algo dentro de ella, ni lo protegido). La selección se conserva al navegar y al cambiar de pestaña, y se limpia al escanear de nuevo.
- Clic derecho, Shift+F10 o tecla Menú: menú con "Entrar a la carpeta", "Mostrar en el Explorador", "Ver detalles", "Copiar a otro disco…" y "Transferir a otro disco (mover)…" (**los dos últimos desactivados hasta la Fase 3**; si la carpeta está protegida, el motivo es "Protegida por el sistema") e "Ignorar esta carpeta". Flechas, Inicio/Fin, Esc.
- Panel de detalles: tamaño, archivos, subcarpetas, último uso, archivo más reciente, avisos, reparto por antigüedad (con texto) y las 5 subcarpetas más pesadas.
- Marcas en los cuadros: 🔒 protegida (borde discontinuo), ⚠ no se leyó todo, "enlaces" (la carpeta contiene accesos directos que no se siguen).

Todo el cálculo (celdas, detalles, selección) lo hace el servicio en su hilo; la interfaz recibe resultados pequeños y solo manda rutas que el servicio reconoce.

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
| **Enlaces: se ofrece la carpeta, con aviso** | Una carpeta que contiene enlaces simbólicos o junctions sigue siendo candidata, pero se marca (`hasLinks`) y la interfaz avisa que los enlaces no se siguen ni se cuentan. |
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
| 2B | Detección de carpetas grandes sin uso, configuración, ignoradas, unidades y pantalla de lista | **Terminada** |
| 2C | Mapa visual de cuadros por tamaño con color por actividad, pestañas, menú contextual, detalles y selección con espacio total | **Terminada** |
| 3A | **Motor** de copia y transferencia (sin pantallas): revisión previa, copia con huella SHA-256, verificación, retirada del original (Papelera o cuarentena) y `verifyBatch`; más el pulido del mapa | **Terminada** (esta) |
| 3B | Pantallas (revisión previa, progreso, resultado), activar «Copiar…» y «Transferir…» en el menú y la barra, y los canales IPC | Pendiente |
| 4 | Instalador para Windows y publicación | Pendiente |

Ideas futuras (sin fecha): escanear todas las unidades a la vez; un mapa con las subcarpetas anidadas dentro de cada cuadro.

## Estructura

- `src/core/` — motor (escáner, análisis, protecciones, reglas y motor de transferencia). Sin dependencias.
- `src/service/` — servicio de análisis (`AnalysisService`, `analysis-worker.js`) y de transferencias (`TransferService`, `transfer-worker.js`).
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
- **Copiar y transferir** (los botones del menú y de la barra de selección ya existen, desactivados): copiar primero, **verificar** lo copiado, y solo después enviar el original a la papelera.
- **Copiar SIN seguir enlaces** (simbólicos ni junctions) y avisar cuáles hay: el escáner ya los marca (`hasLinks`) y no los cuenta en el tamaño.
- **Archivos de OneDrive "solo en la nube":** su tamaño es el completo, y copiarlos los descarga. Hay que detectarlos y avisar antes de actuar.
