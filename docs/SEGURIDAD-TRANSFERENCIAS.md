# Seguridad de las transferencias (copiar y mover carpetas a otro disco)

Este documento explica, sin tecnicismos, **qué garantiza** el motor de transferencia de BoneYardDog y **qué no**. Es la primera vez que la app toca archivos del usuario, así que la prioridad es una sola: **no perder datos**.

> Estado: el motor existe y está probado, pero **todavía no tiene pantallas** (Fase 3B). Hasta entonces la aplicación no copia ni mueve nada por sí sola, y el aviso "aún no usar para borrar datos reales" sigue vigente.

## La regla de oro

El programa **nunca elimina nada del original**, salvo de dos maneras permitidas y solo **después de verificar todo**:

1. enviándolo a la **Papelera** de Windows, o
2. **cambiándolo de sitio** a una carpeta de cuarentena del mismo disco (`BoneYardDog-Cuarentena`), sin borrarlo.

Lo único que el motor puede borrar por su cuenta son **archivos que él mismo creó** en el destino (por ejemplo, una copia que quedó a medias), y solo dentro de su propia carpeta de lote. Hay pruebas automáticas que lo vigilan: espían las llamadas al sistema de archivos y revisan el código fuente para comprobar que no existe ninguna otra forma de eliminar.

No existe, en esta versión, ninguna opción de **eliminación definitiva**.

## Qué se hace, paso a paso

1. **Revisión previa** (sin escribir nada en el destino, salvo un archivito de prueba que se crea y se quita). Si algo es peligroso, es un **impedimento** y no se puede continuar:
   - el origen está protegido por el sistema (se vuelve a comprobar en ese momento);
   - el destino está dentro del origen, o es una ruta de red;
   - no se puede escribir en el destino, o falta espacio libre (lo que se copia más un margen: el mayor entre 64 MB y el 1 %);
   - el destino es FAT32 y hay un archivo de más de 4 GB;
   - hay nombres que el destino no admite (caracteres prohibidos, nombres reservados de Windows como `CON` o `NUL`, nombres que terminan en espacio o punto, o dos nombres que solo se diferencian por mayúsculas);
   - se pide retirar el original con la verificación rápida (para retirar hace falta la completa);
   - se pide la Papelera y es probable que no quepa (ver más abajo).
2. **Copia**: cada archivo se lee en trozos, se calcula su huella **SHA-256** mientras se lee, y se escribe en el destino con la opción de "crear, nunca sobrescribir". Se fuerza la escritura física (`fsync`) antes de cerrar cada archivo, importante en memorias USB. Se conservan las fechas de modificación de archivos y carpetas, y se crean las carpetas vacías.
3. **Verificación**:
   - **Completa (por defecto):** se vuelve a leer cada archivo del destino y se compara su huella con la del original. Detecta cualquier byte distinto.
   - **Rápida (opcional):** solo compara tamaño y fecha. **No comprueba el contenido** y por eso se rotula siempre así; con ella **no se puede retirar el original**.
   - Además, por cada carpeta se comparan los nombres, las cantidades y los bytes del destino con lo planificado (faltantes o sobrantes = error).
4. **Retirar el original** (solo al "mover", y solo carpeta por carpeta): únicamente si **todo** se copió y verificó sin errores **y** el original **no cambió** desde la planificación (mismos nombres, tamaños y fechas, nada nuevo). Si algo cambió, el original no se toca.
5. **Constancia**: en el destino queda `BoneYardDog\<fecha>\` con `ESTADO.json` (cómo terminó), `MANIFIESTO.json` (lista de archivos con tamaño, fecha y huella, y qué se hizo con cada original) y `LEEME.txt` (en español: qué es, cómo restaurar y cómo verificar).

Cada carpeta de origen es **independiente**: si una falla, las demás siguen su camino.

## Cuando algo sale mal

| Situación | Qué pasa |
|---|---|
| Un archivo está bloqueado o sin permiso | Error de **ese** archivo; esa carpeta queda "con errores" y su original **no se toca**. No hay reintentos silenciosos. |
| El disco de destino se llena | Se detiene toda la operación con el mensaje "Sin espacio en el destino". No se toca ningún original. |
| Se desconecta el disco, o falla la lectura/escritura | Se detiene **toda** la operación. No se toca ningún original. |
| El archivo cambia mientras se copia | Ese archivo falla ("cambió durante la copia"), se quita la copia a medias y el original no se retira. |
| Se cancela | Se detiene en cualquier momento; no se toca ningún original que no se haya retirado ya; `ESTADO.json` queda en "cancelado". |
| La Papelera falla o no retira la carpeta | El original sigue donde estaba y se informa. |
| La cuarentena no puede mover la carpeta | El original sigue donde estaba y se informa. |

## Papelera: qué sabemos y qué no

- **Qué hace la app:** pide a Windows enviar la carpeta a la Papelera (`shell.trashItem` de Electron) y luego **comprueba que la ruta original ya no exista**. Si no se retiró, no se da por hecho.
- **Qué hace Electron cuando no cabe** (revisado en el código fuente de la versión 45.0.0, [`shell/common/platform_util_win.cc`](https://github.com/electron/electron/blob/v45.0.0/shell/common/platform_util_win.cc)): usa `IFileOperation` con `FOFX_RECYCLEONDELETE` y sin cuadros de diálogo, y un filtro que **cancela la operación (`E_ABORT`)** si el elemento no se puede reciclar. Es decir, Electron **no cae a un borrado definitivo**: la promesa se rechaza y el original queda donde estaba. Documentación de la función: [`shell.trashItem`](https://www.electronjs.org/docs/latest/api/shell) ("Rejects if there was an error while deleting the requested item"; no promete nada más sobre el motivo).
- **Qué hace el Explorador de Windows** en el mismo caso (fuentes de terceros, no de Microsoft): muestra el aviso "este archivo es demasiado grande para la Papelera" y pregunta si se quiere eliminar de forma permanente ([ElevenForum](https://www.elevenforum.com/t/change-maximum-size-for-recycle-bin-in-windows-11.5109/), [Handy Recovery](https://www.handyrecovery.com/recover-files-too-large-for-recycle-bin/)). BoneYardDog **no hace esa pregunta ni ese borrado**.
- **Cuota de la Papelera:** cada disco tiene un máximo (por omisión, **alrededor del 5 % del disco**; el usuario puede cambiarlo). No se puede leer sin permisos especiales, así que la app usa una **estimación conservadora**: si lo que se envía supera el 5 % del disco de origen, avisa que "puede no caber" y **rechaza la Papelera** salvo que se acepte el riesgo explícitamente.
- **Discos extraíbles y de red:** no tienen Papelera. Se rechaza igual ("sin Papelera").
- **Lo que NO hemos podido confirmar:** el comportamiento exacto de la versión instalada de Windows ante una carpeta que excede la cuota. Lo anterior sale del código fuente y de fuentes de terceros; la prueba en Windows real (`npm run smoke:transfer`) registra lo que ocurre en el caso normal, pero **no provoca** el caso de la cuota excedida (haría falta crear varios GB).

Si la Papelera no es adecuada, la alternativa es la **cuarentena**: la carpeta original se cambia de lugar dentro del mismo disco (instantáneo, sin límite de tamaño) a `BoneYardDog-Cuarentena\<lote>\…`, con un `LEEME.txt` que explica que se puede borrar desde el Explorador cuando el usuario lo decida. BoneYardDog **nunca ofrece** esa carpeta como candidata a copiar o mover (está protegida).

## Qué NO garantiza (límites honestos)

1. **La caché de Windows.** La verificación vuelve a leer el archivo del destino, pero Windows puede responder desde su memoria caché y no desde el disco físico. Por eso existe **«Verificar un lote»** (`verifyBatch`): conviene usarlo **después de expulsar y volver a conectar el disco**, que es cuando la lectura sí viene del disco.
2. **La verificación rápida no comprueba el contenido.** Detecta tamaño o fecha distintos, nada más. Una corrupción que conserve tamaño y fecha pasa desapercibida. Está probado y documentado así.
3. **La cuota de la Papelera es una estimación.** La regla del 5 % es conservadora pero no exacta.
4. **Las fechas de creación no se conservan** en el destino (solo las de modificación): la copia tiene fecha de creación nueva.
5. **OneDrive.** Si el origen está dentro de OneDrive, los archivos "solo en la nube" tienen su tamaño completo y **copiarlos los descarga**. La app avisa cuando el origen está en una carpeta de OneDrive, pero **no detecta archivo por archivo** cuáles están solo en la nube.
6. **Enlaces y accesos especiales.** Los enlaces simbólicos y las uniones (junctions) **no se siguen ni se copian**; se listan. Si una carpeta contiene enlaces, elementos ilegibles o de tipo especial, **su original no se retira** (se perdería lo que no se copió).
7. **Atributos y permisos.** Se copian los datos y las fechas de modificación; no se garantizan los permisos (ACL), los flujos alternos de datos de NTFS ni otros atributos.
8. **Rutas muy largas.** Las rutas de destino de más de 240 caracteres generan un aviso (el Explorador falla a partir de 260). Lo que se pueda o no copiar depende del sistema.
9. **Rutas de red** no se admiten como destino en esta fase.
10. **Una persona o un programa que modifique el destino durante la operación** puede alterar el resultado; la comparación final por carpeta lo detecta como faltante o sobrante.
11. **No hay eliminación definitiva** en esta versión; liberar espacio depende de que el usuario vacíe la Papelera o la cuarentena.

## Cómo se prueba

- Pruebas automáticas con carpetas temporales: copia feliz, corrupción de un byte, el origen que cambia durante la copia o antes de retirar, cancelación, disco lleno, disco que desaparece, FAT32 simulado, nombres inválidos, enlaces, Papelera simulada (éxito y fallo), cuarentena real, carpetas independientes, `quitarCopiado` (incluido el intento de salir del lote a través de un enlace) y `verifyBatch`.
- **Pruebas de mutación** (`node scripts/mutaciones-transferencia.js`): se rompe el motor a propósito (saltar la huella, retirar sin verificar, sobrescribir, omitir la comprobación de que el origen no cambió, ignorar el límite de FAT32, retirar antes de verificar, y otras) y se comprueba que alguna prueba falle.
- **Windows real** en cada envío al repositorio (`npm run smoke:transfer`, dentro de Electron con la Papelera de verdad): ver el último artefacto `transferencia.json`.
- Falta, y debe hacerse a mano con datos de prueba, lo descrito en [`PRUEBAS-MANUALES.md`](PRUEBAS-MANUALES.md): USB reales en FAT32, exFAT y NTFS, desconexión real, etc.
