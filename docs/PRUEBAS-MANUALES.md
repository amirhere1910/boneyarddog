# Pruebas manuales de copiar y transferir

Guía para comprobar, **con una persona delante y datos de prueba**, lo que las pruebas automáticas no pueden: discos USB físicos, desconexiones reales y cómo se ve todo en tu equipo.

> ⚠️ **Prueba primero con datos de prueba, nunca con datos que no tengas respaldados.** El borrado definitivo **no se puede deshacer**.

## Prueba rápida (5 minutos, sin instalar Node ni usar PowerShell)

Necesitas: un equipo con Windows 11, un USB o disco externo (cualquier formato) y unos 2 GB libres.

### 1. Conseguir el instalador
1. Abre la página del proyecto en GitHub: `https://github.com/amirhere1910/boneyarddog`.
2. **Si hay una versión publicada:** entra en **Releases** (a la derecha) y descarga `BoneYardDog-<versión>-instalador.exe`.
3. **Si no:** entra en la pestaña **Actions** → «Construir instalador» → elige la última ejecución con la marca verde ✔ (si no hay ninguna, pulsa **Run workflow** y espera unos 10 minutos) → baja hasta **Artifacts** y descarga `BoneYardDog-<versión>`. Es un .zip que contiene el instalador, la versión portátil y `SHA256SUMS.txt`; descomprímelo.
4. *(Opcional)* Para comprobar que el archivo es el original, compara su huella: en una ventana de PowerShell, `Get-FileHash .\BoneYardDog-<versión>-instalador.exe` debe dar lo mismo que dice `SHA256SUMS.txt`.

**Debes ver:** un archivo `.exe` de unos 80–110 MB. **Anota** si el navegador o el antivirus lo bloquea (nombre del antivirus y el mensaje).

### 2. Pasar el aviso de Windows (SmartScreen)
El programa **no está firmado** (no hay certificado de firma de código), así que Windows muestra «Windows protegió su PC». Es normal en programas gratuitos nuevos.
1. Pulsa **Más información**.
2. Pulsa **Ejecutar de todas formas**.

### 3. Instalar
1. Elige la carpeta (o deja la que propone) y pulsa **Instalar**. No pide administrador: se instala solo para tu usuario.
2. Elige si quieres un acceso directo en el escritorio. El del menú Inicio se crea siempre.
3. Abre **BoneYardDog** desde el menú Inicio.

*(Alternativa sin instalar: descomprime `BoneYardDog-<versión>-portatil.zip` donde quieras y abre `BoneYardDog.exe`.)*

**Debes ver:** la ventana «BoneYardDog», el aviso «Prueba primero con datos de prueba, nunca con datos que no tengas respaldados» y, abajo, «BoneYardDog versión …».

### 4. Crear los datos de prueba
1. Abre **Ayuda y pruebas** → **Crear datos de prueba**.
2. Espera a que la barra termine (unos 750 MB; entre 10 segundos y un par de minutos).

**Debes ver:** «Listo: 5 carpetas, … archivos, 750 MB, en …\Documentos\BoneYardDog-Prueba». En el Explorador, esa carpeta tiene 5 carpetas con nombres con tildes, ñ y emoji. **Anota** si no hay espacio, si tarda mucho o si da error (texto exacto).

### 5. Escanear
1. Con la casilla «Para esta prueba, ignorar la fecha de creación» marcada, pulsa **Escanear esa carpeta ahora**.
2. Mira el **mapa** y la pestaña **Lista de candidatas**.

**Debes ver:** 5 cuadros en el mapa; en la lista, **3 carpetas sin uso** (las de hace 400, 200 y 100 días). Las de 30 y 2 días no salen.

### 6. Copiar a un USB
1. Clic derecho en una carpeta del mapa → **Copiar a otro disco…**.
2. Elige tu USB en la lista (verás letra, tipo, formato y espacio libre) → **Siguiente**.
3. Lee la revisión previa → **Empezar**. Espera al resultado.

**Debes ver:** «Listo: 1 carpeta copiada y verificada». En el USB: `BoneYardDog\<fecha>\…` con tu carpeta, `ESTADO.json`, `MANIFIESTO.json` y `LEEME.txt`. La carpeta original **sigue** en Documentos. Si el USB es FAT32 verás una línea sobre los 4 GB.

### 7. Transferir con la Papelera
1. Clic derecho en **otra** carpeta (por ejemplo «Música y canciones ñandú») → **Transferir a otro disco (mover)…** → tu USB → **Siguiente** → **Empezar**.
2. Cuando termine, abre la **Papelera de Windows**.

**Debes ver:** «Copiada y verificada · original enviado a la Papelera». La carpeta ya no está en Documentos; sí está en la Papelera (se puede restaurar) y en el USB. En el mapa queda marcada «ya transferida». **No** aparece «Quitar la copia» (la copia es lo único que queda). Si sale la pregunta «Esto probablemente no cabe en la Papelera…», elige «Dejar el original (solo copiar)».

### 8. Verificar una copia anterior (con el USB expulsado y reconectado)
1. **Expulsa** el USB (icono de la barra de tareas → «Expulsar») y quítalo. Vuelve a conectarlo.
2. En la barra superior: **Verificar una copia anterior…** → «Elegir la carpeta de la copia…» → entra en `BoneYardDog` del USB y elige la carpeta con la fecha → **Verificar**.

**Debes ver:** «La copia está bien: N archivos verificados». *(Opcional: cambia una letra de un archivo de texto de la copia, borra otro y vuelve a verificar: debe decir «La copia tiene 2 problemas».)*

### 9. Limpiar
1. **Ayuda y pruebas** → **Borrar datos de prueba** → **Sí, borrar los datos de prueba**. Solo borra `Documentos\BoneYardDog-Prueba`.
2. Borra a mano, desde el Explorador, la carpeta `BoneYardDog` del USB (y vacía la Papelera si quieres).

### Si algo se ve raro
Anota: **qué hiciste** (paso), **qué esperabas**, **qué pasó** (texto exacto del mensaje) y una **captura de pantalla**. Añade tu versión de Windows, el tipo de disco (USB/HDD/SSD) y su formato. Es lo más valioso para mejorar la app.

---

# Pruebas opcionales avanzadas

Para cuando necesites algo más: USB reales con distintos formatos, un archivo de más de 4 GB, desconectar a mitad, etc. Las marcadas con 🤖 ya las cubre el CI con discos virtuales (ver [`SEGURIDAD-TRANSFERENCIAS.md`](SEGURIDAD-TRANSFERENCIAS.md)); las marcadas con ⚠️ **solo se pueden probar a mano**.

## Cómo se usa la pantalla (resumen)

1. Abre la app (`npm start`), elige una carpeta o unidad para revisar y espera a que termine el mapa.
2. Clic derecho en una carpeta del mapa → **«Copiar a otro disco…»** o **«Transferir a otro disco (mover)…»**. También puedes marcar varias carpetas (Ctrl+clic o la casilla «Seleccionar» en la lista) y usar los botones de la barra de abajo.
3. **Paso 1 – Destino:** elige una unidad de la lista (verás letra, tipo USB / disco duro o SSD, formato y espacio libre) o «Elegir otra carpeta…». Elige la verificación (la rápida solo existe al copiar).
4. **Paso 2 – Revisión previa:** lee los **impedimentos** (rojo: no se puede continuar) y los **avisos** (amarillo). Si es transferir y probablemente no cabe en la Papelera, tendrás que **elegir** entre borrar definitivamente o dejar el original.
5. **Paso 3 – Progreso**, y después el **resultado** por carpeta. No se puede cerrar a mitad: usa «Cancelar la operación» (los originales no se tocan).
6. En la barra superior, **«Verificar una copia anterior…»** comprueba una copia que ya hiciste (elige la carpeta del lote, la que tiene la fecha y contiene `MANIFIESTO.json`).

## Antes de empezar: datos de prueba (a mano)

> Si solo quieres datos de prueba, usa «Ayuda y pruebas» > «Crear datos de prueba» (ver la prueba rápida). Lo que sigue es para cuando necesitas algo específico (por ejemplo un archivo de más de 4 GB).

1. Crea una carpeta de prueba, por ejemplo `C:\PruebaBYD\Origen`, con:
   - unos 20 archivos pequeños (texto, imágenes), algunos con nombres con tildes, `ñ`, espacios y un emoji;
   - una subcarpeta con otra dentro, y una carpeta vacía;
   - **un archivo grande** de unos 200 MB (puedes copiar un video cualquiera) para poder cancelar a mitad;
   - anota cuántos archivos y cuántos bytes son en total (clic derecho → Propiedades).
   Para que la app la ofrezca en la lista, ponle fechas viejas o simplemente úsala desde el mapa (aparece aunque sea reciente).
2. Ten a mano los discos de prueba: un **USB/pendrive** que puedas formatear (en **FAT32**, **exFAT** y **NTFS**: clic derecho → Formatear; **se borra todo lo que tenga**), un **disco duro** externo y un **SSD** externo o interno.
3. Para ver el formato de un disco: clic derecho en la unidad → Propiedades → «Sistema de archivos». La app también lo muestra en el paso 1.

## Prueba 1 — Copia pequeña (en cada disco y formato)

> 🤖 **Ya lo cubre el CI con discos virtuales** NTFS, exFAT y FAT32 reales (`npm run smoke:discos`, artefacto `discos`). Lo que **no** cubre: un USB físico de verdad, su velocidad y sus rarezas.

Repite para: USB en FAT32, USB en exFAT, USB en NTFS, disco duro, SSD.

1. Clic derecho en `Origen` → «Copiar a otro disco…», destino la unidad, verificación **completa**.
2. En el paso 1 comprueba que la unidad aparece con su tipo, formato y espacio libre correctos (en FAT32 debe haber una línea sobre los 4 GB).
3. Revisa el resultado: «Listo: 1 carpeta copiada y verificada». En el destino existe `BoneYardDog\<fecha>\` con `ESTADO.json`, `MANIFIESTO.json`, `LEEME.txt` y tu carpeta dentro de una carpeta con la letra de la unidad. Prueba «Abrir la copia en el Explorador».
4. **Comprueba a ojo:** misma cantidad de archivos y de bytes (Propiedades), nombres con tildes/ñ/emoji bien, carpeta vacía presente y fechas de modificación iguales.
5. El original sigue en `C:\PruebaBYD\Origen`, intacto.

**Esperado:** todo igual. **Anota** cualquier diferencia (nombres, fechas, tiempo).

## Prueba 2 — Archivo de más de 4 GB hacia FAT32 (debe BLOQUEAR)

> 🤖 **Ya lo cubre el CI**: un archivo (disperso) de 4 GiB hacia un FAT32 virtual se bloquea sin escribir nada, y uno de 4 GiB − 1 byte no se bloquea por tamaño. Aquí solo falta comprobarlo con un USB físico.

1. Pon en el origen un archivo de **más de 4 GB** (junta varios videos, o usa una imagen de disco de prueba).
2. Destino: el USB en **FAT32**.
3. **Esperado:** el paso 2 muestra un impedimento en rojo («FAT32 … no admite archivos de más de 4 GB») con «Qué hacer: elige exFAT o NTFS…»; el botón «Empezar» no se puede pulsar. **No** se creó nada en el USB.
4. Repite con el USB en **exFAT** o **NTFS**: ahora sí debe dejar continuar.

## Prueba 3 — Desconectar el USB a mitad (debe ABORTAR sin tocar el original)

> ⚠️ **NO la cubre el CI** (no se puede desconectar un USB de verdad). El CI sí prueba el disco lleno a mitad de copia.

1. Origen con el archivo grande (~200 MB). Destino: un USB. **Transferir (mover)**.
2. Empieza y, **mientras copia**, **desconecta el USB a la fuerza** (sácalo sin expulsar).
3. **Esperado:** la operación se detiene con un mensaje en lenguaje llano («El disco dejó de responder (¿se desconectó?)…»); el **original sigue completo** y **no** está en la Papelera; **no** aparece «Listo».
4. Vuelve a conectar el USB: puede haber una copia incompleta. Bórrala a mano.

## Prueba 4 — Transferir con la Papelera (carpeta pequeña)

1. Transferir `Origen` a un disco con espacio. Verificación completa (no hay otra).
2. **Esperado:** el resultado dice «Copiada y verificada · original enviado a la Papelera». Abre la **Papelera de Windows**: el original está ahí y se puede restaurar. La carpeta desaparece del mapa (queda marcada «ya transferida») y de la selección.
3. Comprueba que **no** aparece «Quitar la copia» (la copia es lo único que queda).

## Prueba 5 — Carpeta muy grande hacia la Papelera (debe PREGUNTAR)

> ⚠️ **NO la cubre el CI**: la cuota real de la Papelera de Windows no se puede provocar sin crear varios GB.

1. Origen: una carpeta de prueba **grande frente al disco** (más del 5 % del disco de origen; por ejemplo 10 GB en un disco de 128 GB), o una carpeta de un **USB** como origen (los discos extraíbles no tienen Papelera). Destino: un disco con espacio. **Transferir**.
2. **Esperado:** en el paso 2 aparece «Esto probablemente no cabe en la Papelera (o este disco no tiene Papelera). ¿Qué quieres hacer?», con dos opciones y **ninguna marcada**; «Empezar» está desactivado.
3. Elige **«Dejar el original (solo copiar)»**: se copia y verifica y el original no se toca.
4. Repite y elige **«Borrar definitivamente…»**: aparece un recuadro rojo con cuántas carpetas y bytes se borrarán; «Empezar» sigue desactivado hasta marcar «Entiendo que no se podrá recuperar». Con datos de prueba, continúa: el original desaparece **sin pasar por la Papelera** y la copia queda verificada.
5. **Si el original sí cabía en la Papelera y Windows la rechaza**, anota exactamente qué dijo la pantalla («No se pudo enviar a la Papelera…») y qué ofreció. Es información que la documentación todavía no tiene.

## Prueba 6 — Verificar una copia anterior (después de reconectar)

> 🤖 El CI ya lo hace con un disco virtual desmontado y montado de nuevo; con un USB físico la diferencia es la caché real de Windows.

1. Haz una copia completa a un USB (Prueba 1).
2. **Expulsa** el USB («Quitar hardware de forma segura») y **desconéctalo**; vuelve a **conectarlo**.
3. «Verificar una copia anterior…» → elige `BoneYardDog\<fecha>` del USB → «Verificar». **Esperado:** «La copia está bien».
4. **Estropea a propósito** la copia: cambia una letra de un archivo de texto, **borra** otro archivo y **agrega** uno nuevo. Vuelve a verificar. **Esperado:** «La copia tiene 3 problemas», con cada uno explicado (alterado, falta, sobra).
5. Elige una carpeta que **no** tenga `MANIFIESTO.json`: debe rechazarla con un mensaje claro.

## Prueba 7 — Cancelar

1. Origen con el archivo grande, destino un USB, **transferir**. Pulsa **«Cancelar la operación»** a mitad.
2. **Esperado:** se detiene; el original sigue completo; `ESTADO.json` dice «cancelado»; el archivo a medias no queda en el destino. En el resultado puedes pulsar **«Quitar la copia»** (pide confirmación) y borra solo lo que BoneYardDog copió.

## Prueba 8 — Cerrar la ventana con una copia en curso

Empieza una copia grande y cierra la ventana de la app. **Esperado:** pregunta «Hay una copia en curso»; «Seguir esperando» no cierra nada; «Cancelar la operación y cerrar» cancela (el original no se toca).

## Prueba 9 — Carpetas con enlaces y OneDrive

1. Crea dentro de la carpeta de prueba un acceso directo simbólico (`mklink /D enlace C:\OtraCarpeta`, en una consola de administrador). Transferir: el paso 2 avisa que el enlace **no se copia** y que **el original no se retirará**; al terminar el original sigue donde estaba.
2. Con una carpeta dentro de OneDrive: debe avisar que los archivos «solo en la nube» se descargarían.

## Qué hacer con lo que encuentres

Anota: qué disco y formato, qué hiciste, qué esperabas y qué pasó (con el texto exacto de los mensajes y, si puedes, una captura). Ese reporte es lo más valioso para mejorar la app.
