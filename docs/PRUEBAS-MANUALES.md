# Pruebas manuales de las transferencias

Guía paso a paso para comprobar, **con una persona delante y datos de prueba**, lo que las pruebas automáticas no pueden: discos reales y desconexiones reales.

> ⚠️ **Usa SOLO datos de prueba.** Nunca fotos, documentos ni nada que no puedas perder. Mientras esta versión no tenga pantallas de transferencia (Fase 3B), estas pruebas se hacen con el motor desde una consola; pídele a quien desarrolla la app el comando exacto o espera a la Fase 3B.

## Antes de empezar

1. Crea una carpeta de prueba, por ejemplo `C:\PruebaBYD\Origen`, con:
   - unos 20 archivos pequeños (texto, imágenes), algunos con nombres con tildes, `ñ`, espacios y un emoji;
   - una subcarpeta con otra dentro, y una carpeta vacía;
   - **un archivo grande** de unos 200 MB (puedes copiar un video cualquiera) para poder cancelar a mitad;
   - anota cuántos archivos y cuántos bytes son en total (clic derecho → Propiedades).
2. Ten a mano los discos de prueba: un **USB/pendrive** que puedas formatear (en **FAT32**, **exFAT** y **NTFS**: se cambia con clic derecho → Formatear; **se borra todo lo que tenga**), un **disco duro** externo y un **SSD** externo o interno.
3. Para ver el formato de un disco: clic derecho en la unidad → Propiedades → "Sistema de archivos".

## Prueba 1 — Copia pequeña (en cada disco y formato)

Repite para: USB en FAT32, USB en exFAT, USB en NTFS, disco duro, SSD.

1. Elige `C:\PruebaBYD\Origen` como origen y la unidad como destino. Modo **copiar**, verificación **completa**.
2. Revisa el resultado: debe decir que se copió y verificó. En el destino existe `BoneYardDog\<fecha>\` con `ESTADO.json`, `MANIFIESTO.json`, `LEEME.txt` y tu carpeta dentro de una carpeta con la letra de la unidad.
3. **Comprueba a ojo:** misma cantidad de archivos y de bytes (Propiedades), los nombres con tildes/ñ/emoji se ven bien, la carpeta vacía existe, y las fechas de modificación coinciden.
4. El original sigue en `C:\PruebaBYD\Origen`, intacto.

**Esperado:** todo igual. **Anota** cualquier diferencia (nombres, fechas, tiempo que tardó).

## Prueba 2 — Archivo de más de 4 GB hacia FAT32 (debe BLOQUEAR)

1. Pon en el origen un archivo de **más de 4 GB** (por ejemplo, junta varios videos o usa una imagen de disco de prueba).
2. Elige como destino el USB en **FAT32**.
3. **Esperado:** la revisión previa dice que **no se puede continuar** y explica que FAT32 no admite archivos de más de 4 GB, sugiriendo otro destino o reformatear a exFAT/NTFS. **No** debe haberse copiado nada ni creado ninguna carpeta `BoneYardDog` en el USB.
4. Repite con el USB en **exFAT** o **NTFS**: ahora sí debe dejar continuar.

## Prueba 3 — Desconectar el USB a mitad (debe ABORTAR sin tocar el original)

1. Origen: la carpeta de prueba con el archivo grande (~200 MB). Destino: un USB (cualquier formato). Modo **transferir (mover)**, verificación completa, original a la **Papelera**.
2. Empieza la operación y, **mientras copia**, **desconecta el USB a la fuerza** (sácalo sin expulsar).
3. **Esperado:**
   - la operación **se detiene** con un mensaje de que el disco se desconectó o falló;
   - el **original sigue completo** en su sitio y **no** está en la Papelera (revísala);
   - no aparece ningún mensaje de "terminado con éxito".
4. Vuelve a conectar el USB: puede haber una copia incompleta con `ESTADO.json` marcando el problema. Bórrala a mano.

## Prueba 4 — Carpeta muy grande hacia la Papelera (debe AVISAR)

1. Elige como origen una carpeta de prueba **grande en comparación con el disco** (más del 5 % del tamaño del disco de origen; por ejemplo, 10 GB en un disco de 128 GB). Destino: un disco con espacio. Modo **transferir (mover)**, disposición **Papelera**.
2. **Esperado:** la revisión previa **rechaza la Papelera** ("puede no caber") y propone la **cuarentena** o aceptar el riesgo explícitamente.
3. Si aceptas el riesgo, observa **con cuidado** qué hace Windows: ¿pide eliminar de forma definitiva? ¿el original queda en su sitio? **Anota exactamente** lo que ocurre; es información que la documentación todavía no tiene. (Solo con datos de prueba.)
4. Repite con la disposición **cuarentena**: debe terminar al instante y dejar la carpeta en `BoneYardDog-Cuarentena\<fecha>\…` del mismo disco, con su `LEEME.txt`.

## Prueba 5 — Verificar un lote después de reconectar

1. Haz una copia completa a un USB (Prueba 1).
2. **Expulsa** el USB desde "Quitar hardware de forma segura" y **desconéctalo**. Vuelve a **conectarlo**.
3. Usa «Verificar un lote» sobre `BoneYardDog\<fecha>` del USB.
4. **Esperado:** "verificado: todo igual".
5. Ahora **estropea a propósito** el lote: abre uno de los archivos de texto copiados con el Bloc de notas, cambia una letra y guarda; **borra** otro archivo; **agrega** un archivo nuevo.
6. Vuelve a verificar. **Esperado:** detecta los tres problemas (un archivo alterado, uno faltante y uno sobrante).

## Prueba 6 — Cancelar

1. Origen con el archivo grande, destino un USB, modo **transferir**.
2. Pulsa **Cancelar** a mitad.
3. **Esperado:** se detiene; el original sigue completo; `ESTADO.json` dice "cancelado"; el archivo que estaba a medias no queda en el destino.

## Qué hacer con lo que encuentres

Anota: qué disco y formato, qué hiciste, qué esperabas y qué pasó (con el texto exacto de los mensajes y, si puedes, una captura). Ese reporte es lo más valioso para mejorar la app.
