# Seguridad de las transferencias (copiar y mover carpetas a otro disco)

Este documento explica, sin tecnicismos, **qué garantiza** el motor de transferencia de BoneYardDog y **qué no**. Es la primera vez que la app toca archivos del usuario, así que la prioridad es una sola: **no perder datos**.

> Estado (Fase 3B): la aplicación **ya copia y transfiere** carpetas desde sus pantallas. **Prueba primero con datos de prueba, nunca con datos que no tengas respaldados.**

## La regla de oro

Lo que el usuario decidió: **transferir = copiar, verificar y enviar el original a la Papelera**; **copiar = dejar el original**. Y si el original no puede ir a la Papelera, la única pregunta es si se quiere **borrarlo definitivamente** (después de verificar la copia).

El programa solo elimina algo del **original** de dos maneras, y en ambas **solo después de verificar todo**:

1. enviándolo a la **Papelera** de Windows (`shell.trashItem`), o
2. el **borrado definitivo** (`fs.rm`), que solo ocurre si el usuario lo confirmó de forma explícita (ver más abajo).

Lo único otro que el motor puede borrar por su cuenta son **archivos que él mismo creó** en el destino (por ejemplo, una copia que quedó a medias, o «Quitar la copia»), y solo dentro de su propia carpeta de lote. Hay pruebas automáticas que lo vigilan: espían las llamadas al sistema de archivos y revisan el código fuente para comprobar que no existe ninguna otra forma de eliminar, que el borrado definitivo vive en una sola función y que esa función hace todas sus comprobaciones **antes** de borrar.

**La cuarentena ya no existe.** La Fase 3A movía el original a una carpeta `BoneYardDog-Cuarentena`; se eliminó del motor, de las pantallas y de las pruebas. La carpeta `BoneYardDog-Cuarentena` **sigue siendo una ruta protegida** (por si alguien ya la creó con la 3A: la app nunca la ofrece ni la toca).

## Rutas reales: el hallazgo de los enlaces y su corrección

La revisión de la 3A demostró un fallo: las protecciones y las comprobaciones «está dentro de» comparaban **solo texto**. Un origen alcanzado **a través de un enlace** (un acceso simbólico o una unión, en cualquier punto de la ruta) hacia una carpeta protegida **no se bloqueaba**: se copiaba y su original iba a la Papelera.

Corrección (Fase 3B): antes de decidir nada, el motor resuelve la **ruta real** (`fs.realpath`) de cada origen y del destino, y usa las rutas reales para: carpetas protegidas, «dentro de», orígenes repetidos o anidados, «mismo disco» y «destino dentro del origen». Si la ruta pasa por un enlace hacia una zona protegida, se **bloquea con un mensaje que lo dice**. El plan y el manifiesto guardan la ruta real. Y **justo antes de retirar un original** se vuelve a resolver la ruta real: si cambió (alguien puso un enlace en su lugar), no se toca. Un enlace inofensivo en medio de la ruta sí funciona (se resuelve y se copia desde la ruta real). Pruebas: origen vía enlace hacia zona protegida, destino que es un enlace hacia el interior del origen, enlace inofensivo, y desvío justo antes de retirar; y mutaciones que las rompen a propósito.

## Borrado definitivo del original

Se ofrece **solo** cuando la Papelera no sirve: el origen es un disco extraíble (no tiene Papelera), la carpeta probablemente no cabe (más del 5 % del disco: es solo una estimación y **no bloquea**, solo avisa), o Windows rechazó enviarla. La pantalla pregunta: «Borrar definitivamente el original cuando la copia esté verificada» o «Dejar el original (solo copiar)». **Nada viene preseleccionado**, y borrar exige una confirmación aparte, en rojo, que dice cuántas carpetas y cuántos bytes se borrarán sin pasar por la Papelera y pide marcar «Entiendo que no se podrá recuperar».

Garantías del motor (se comprueban **dentro** de la función que borra, no se confía en quien la llama):

- hay `confirmPermanentDelete: true` (solo lo fija la revisión previa si se lo piden con `true`; cualquier otra cosa —`"true"`, `1`— cuenta como falso);
- la copia de esa carpeta está **verificada por completo** (SHA-256) y la operación era de verificación completa;
- la carpeta **no tiene enlaces, elementos ilegibles ni especiales**;
- **no está protegida** (se revalida con la ruta real);
- el **origen no cambió** desde el plan (misma ruta real; mismos nombres, tipos, tamaños y fechas; nada nuevo);
- la **copia sigue completa** en el destino: la carpeta de la copia sigue dentro del lote (y no es el origen visto por un enlace), y cada archivo existe con el mismo tamaño y fecha (no se vuelve a leer todo el contenido: eso ya lo hizo la verificación);
- el borrado usa `fs.rm(ruta, { recursive: true, force: false })`, que **no sigue enlaces**;
- si falla a mitad, el resultado es **«borrado parcial»** con la lista **exacta** de lo que se borró y lo que quedó, y **no se reintenta**. La copia, en ese caso, está completa.

## Qué pasa si la Papelera falla

Si Windows rechaza enviar la carpeta a la Papelera (o dice que terminó y la carpeta sigue ahí), el **original queda intacto**, el resultado es «original sin tocar» con el motivo `papelera-fallo` y el **mensaje original del error**. La pantalla de resultado dice «No se pudo enviar a la Papelera. Los originales siguen en su sitio. ¿Quieres borrarlos definitivamente?». Si el usuario acepta (con la misma confirmación en rojo), el servicio ofrece `eliminarDefinitivamente(runId, índices, confirmación)`, que **vuelve a comprobar todo** (origen sin cambios, copia completa, sin enlaces, no protegida) y **rechaza** cualquier índice que no sea una carpeta cuyo original quedó sin tocar por la Papelera.

## Qué se hace, paso a paso

1. **Revisión previa** (sin escribir nada en el destino, salvo un archivito de prueba que se crea y se quita). Si algo es peligroso, es un **impedimento** y no se puede continuar:
   - el origen está protegido por el sistema (se vuelve a comprobar en ese momento);
   - el destino está dentro del origen, o es una ruta de red;
   - no se puede escribir en el destino, o falta espacio libre (lo que se copia más un margen: el mayor entre 64 MB y el 1 %);
   - el destino es FAT32 y hay un archivo de más de 4 GB;
   - hay nombres que el destino no admite (caracteres prohibidos, nombres reservados de Windows como `CON` o `NUL`, nombres que terminan en espacio o punto, o dos nombres que solo se diferencian por mayúsculas);
   - se pide retirar el original con la verificación rápida (para retirar hace falta la completa);
   - se pide borrar definitivamente sin la confirmación explícita.
   - Además hay **avisos** (no impiden continuar): enlaces que no se copiarán (y por eso el original no se retirará), elementos ilegibles, ruta larga, mismo disco, OneDrive, formato desconocido y «probablemente no cabe en la Papelera»; ese último hace que la pantalla pregunte qué hacer.
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
| La Papelera falla o no retira la carpeta | El original sigue donde estaba, se informa con el mensaje original y se ofrece borrarlo definitivamente (con confirmación). |
| El borrado definitivo falla a mitad | «Borrado parcial»: se informa exactamente qué se borró y qué no; no se reintenta; la copia está completa. |
| Se cierra la ventana con una copia en curso | La app pide confirmación; si se acepta, cancela la operación (los originales no se tocan). |

## Papelera: qué sabemos y qué no

- **Qué hace la app:** pide a Windows enviar la carpeta a la Papelera (`shell.trashItem` de Electron) y luego **comprueba que la ruta original ya no exista**. Si no se retiró, no se da por hecho.
- **Qué hace Electron cuando no cabe** (revisado en el código fuente de la versión 45.0.0, [`shell/common/platform_util_win.cc`](https://github.com/electron/electron/blob/v45.0.0/shell/common/platform_util_win.cc)): usa `IFileOperation` con `FOFX_RECYCLEONDELETE` y sin cuadros de diálogo, y un filtro que **cancela la operación (`E_ABORT`)** si el elemento no se puede reciclar. Es decir, Electron **no cae a un borrado definitivo**: la promesa se rechaza y el original queda donde estaba. Documentación de la función: [`shell.trashItem`](https://www.electronjs.org/docs/latest/api/shell) ("Rejects if there was an error while deleting the requested item"; no promete nada más sobre el motivo).
- **Qué hace el Explorador de Windows** en el mismo caso (fuentes de terceros, no de Microsoft): muestra el aviso "este archivo es demasiado grande para la Papelera" y pregunta si se quiere eliminar de forma permanente ([ElevenForum](https://www.elevenforum.com/t/change-maximum-size-for-recycle-bin-in-windows-11.5109/), [Handy Recovery](https://www.handyrecovery.com/recover-files-too-large-for-recycle-bin/)). BoneYardDog **no hace esa pregunta ni ese borrado**.
- **Cuota de la Papelera:** cada disco tiene un máximo (por omisión, **alrededor del 5 % del disco**; el usuario puede cambiarlo). No se puede leer sin permisos especiales, así que la app usa una **estimación conservadora**: si lo que se envía supera el 5 % del disco de origen, **avisa** que «probablemente no cabe» y pregunta qué hacer (borrar definitivamente tras verificar, o dejar el original). No bloquea: es una estimación.
- **Discos extraíbles y de red:** no tienen Papelera; se pregunta lo mismo.
- **Lo que NO hemos podido confirmar:** el comportamiento exacto de la versión instalada de Windows ante una carpeta que excede la cuota. Lo anterior sale del código fuente y de fuentes de terceros; la prueba en Windows real (`npm run smoke:transfer`, ver la sección siguiente) confirma el caso normal, pero **no provoca** el caso de la cuota excedida (haría falta crear varios GB).

## Observado en Windows real (runner `windows-latest`, 27 de octubre de 2026)

Cada envío al repositorio ejecuta `npm run smoke:transfer` dentro de Electron, con la Papelera de verdad, y guarda todo lo observado en `smoke-artifacts/transferencia.json`. Lo que se vio en dos corridas:

| Qué | Observación |
|---|---|
| Unidades | `C:` y `D:` son **NTFS** y de tipo **fijo**. PowerShell tardó **~1,3 s** en responder por cada unidad. |
| Copia completa y rápida entre `D:` (origen) y `C:` (destino) | Ambas quedaron verificadas. Una comparación independiente (hecha por la prueba, no por el motor) confirmó **contenido idéntico** y origen intacto. La fecha de modificación coincidió exactamente. |
| «Mover» con la Papelera real | `shell.trashItem` retiró el original: la ruta **ya no existía** y la copia estaba verificada e idéntica. En `D:\$Recycle.Bin` apareció la carpeta de usuario (`S-1-5-21-…-500`). **Sorpresa:** en una de las dos corridas `D:\$Recycle.Bin` **no existía** antes de la llamada (Windows la crea al usarla), así que su ausencia no significa que no haya Papelera. |
| «Mover» con cuarentena (3A, **ya eliminada**) | `fs.rename` movió el original a `D:\BoneYardDog-Cuarentena\<lote>\…`. Se conserva como dato histórico: la cuarentena ya no existe. |
| Nombres con tildes, `ñ`, espacios y emoji | Copiados y verificados sin problema (incluida una carpeta vacía con `ñ`). |
| Ruta larga | Una ruta de origen de **325** caracteres y de destino de **382** se copió y verificó bien. La revisión previa **avisó** de la ruta larga (el motor no la bloquea: es el Explorador quien falla desde 260). |
| Cancelación | Con un archivo de 96 MB: `ESTADO.json` quedó en «cancelado», la Papelera **no** se llamó y el original quedó intacto. |

**Lo que esta prueba NO provoca** (haría falta crear varios GB): una carpeta que exceda la cuota de la Papelera, ni discos extraíbles, FAT32, exFAT o una desconexión real. Eso está en [`PRUEBAS-MANUALES.md`](PRUEBAS-MANUALES.md).

### Observado en la 3B, con la app entera en Windows real (27 de octubre de 2026)

`npm run smoke` abre la app en `windows-latest`, abre el asistente con ratón y teclado reales (ventana mínima, 720×520) y comprueba **en disco** (con una comparación independiente del motor):

- **Copiar** a otro volumen (`C:`, con el origen en `D:`): verificado, idéntico, original intacto; «Verificar de nuevo» y «Quitar la copia» funcionan.
- **Transferir con la Papelera real** desde la pantalla: el original se retiró (Papelera de Windows) y la copia verificada es idéntica; «Quitar la copia» no se ofrece.
- **Papelera fallida** (simulada, porque en el runner no falla): el original queda intacto; el botón de borrar no avanza sin marcar «Entiendo…»; con la marca, original ausente y copia idéntica.
- **Origen sin Papelera** (simulado): aparece la pregunta con nada preseleccionado; borrar exige la confirmación en rojo; «dejar el original» copia y verifica.
- **Verificar una copia anterior**: copia sana → «La copia está bien»; copia alterada a propósito (un byte, un archivo borrado, uno sobrante) → 3 problemas detectados.
- Las **capturas** de cada paso (`asistente-*.png`) están en el artefacto `smoke-artifacts` de la ejecución.

**Sorpresas:** (1) una marca interna del destino anterior seguía en la pantalla al abrir otra operación (corregido); (2) en la ventana mínima el cuadro de una carpeta transferida puede estar plegado en «Otras», así que la marca «ya transferida» no siempre se ve en el mapa (el registro interno sí). **No** se provocó en Windows una Papelera que realmente rechace por tamaño.

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
11. **El borrado definitivo no se puede deshacer.** Por eso solo ocurre tras una confirmación explícita, después de verificar la copia por completo y volver a comprobar el origen y la copia; aun así, **si la copia verificada se daña después, ya no hay original**. Conviene verificar la copia tras reconectar el disco y tener un respaldo.

## Cómo se prueba

- Pruebas automáticas con carpetas temporales: copia feliz, corrupción de un byte, el origen que cambia durante la copia o antes de retirar, cancelación, disco lleno, disco que desaparece, FAT32 simulado, nombres inválidos, enlaces, Papelera simulada (éxito y fallo), borrado definitivo (feliz, sin confirmar, origen cambiado, copia incompleta, con enlaces, parcial), `eliminarDefinitivamente`, rutas reales (enlaces hacia zonas protegidas), carpetas independientes, `quitarCopiado` (incluido el intento de salir del lote a través de un enlace) y `verifyBatch`.
- **Pruebas de mutación** (`node scripts/mutaciones-transferencia.js`): se rompe el motor a propósito (saltar la huella, retirar sin verificar, sobrescribir, omitir la comprobación de que el origen no cambió, ignorar el límite de FAT32, retirar antes de verificar; y en la 3B: borrar sin verificar, sin confirmación, sin recomprobar el origen, sin recomprobar la copia, siguiendo enlaces, e ignorar `realpath`) y se comprueba que alguna prueba falle: 23 de 23 se detectan.
- **Windows real** en cada envío al repositorio: `npm run smoke:transfer` (el motor, con la Papelera de verdad; artefacto `transferencia.json`) y `npm run smoke` (la app entera: abre el asistente con ratón y teclado reales, copia, transfiere, borra definitivamente con y sin confirmación y verifica una copia anterior, con **capturas de cada paso** `asistente-*.png` en el artefacto).
- Falta, y debe hacerse a mano con datos de prueba, lo descrito en [`PRUEBAS-MANUALES.md`](PRUEBAS-MANUALES.md): USB reales en FAT32, exFAT y NTFS, desconexión real, etc.
