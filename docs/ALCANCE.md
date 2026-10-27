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

## Fases

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Núcleo de escaneo, reglas de análisis y protecciones (sin interfaz) | **En curso** |
| 2 | Interfaz (Electron): elegir disco, ver árbol y resultados | Pendiente |
| 3 | Acciones: enviar a la papelera, mover a disco externo, con confirmación | Pendiente |
| 4 | Instalador para Windows y publicación | Pendiente |

## Estructura

- `src/core/` — motor (escáner, análisis, protecciones).
- `test/` — pruebas (`npm test`).
- `docs/` — documentación.
