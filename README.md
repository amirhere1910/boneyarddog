# BoneYardDog

Analizador de discos para Windows 11: encuentra carpetas grandes que llevan mucho tiempo sin usarse, para que puedas moverlas a un disco externo o USB.

Gratis y de código abierto (licencia MIT). Hecho con Electron.

## Qué hace

Tiene dos vistas. El **mapa** dibuja las carpetas como cuadros: cuanto más grande el cuadro, más pesa la carpeta; en naranja y amarillo las que tuvieron movimiento reciente, en azul y plomo las que no. Con clic entras a una carpeta y con clic derecho ves sus opciones y detalles. La **lista de candidatas** muestra las **carpetas grandes que llevan tiempo sin usarse** (por defecto, más de 3 meses y más de 500 MB; ambos se pueden cambiar en la pantalla) para que puedas pasarlas a un disco externo o USB. Una carpeta está "sin uso" si **ningún archivo dentro** fue modificado ni creado o copiado en ese período. La fecha de "último acceso" se ignora porque antivirus y copias de seguridad la cambian solos. Cada carpeta muestra su archivo más reciente, y puedes ignorar las que no quieras ver.

## Cómo obtener el programa (sin instalar nada más)

No hace falta Node ni PowerShell. Descarga el **instalador** desde GitHub:

1. Entra en la página del proyecto → **Releases** y baja `BoneYardDog-<versión>-instalador.exe`. Si todavía no hay una versión publicada: pestaña **Actions** → «Construir instalador» → última ejecución con ✔ → **Artifacts** → `BoneYardDog-<versión>` (un .zip con el instalador, la versión portátil y las huellas `SHA256SUMS.txt`). También puedes pulsar **Run workflow** para construir uno nuevo.
2. Ábrelo. Windows dirá «Windows protegió su PC» porque el programa **no está firmado** (no hay certificado de firma de código): pulsa **Más información** → **Ejecutar de todas formas**.
3. Se instala solo para tu usuario (no pide administrador). También hay una **versión portátil** (`.zip`): descomprímela y abre `BoneYardDog.exe`.
4. Dentro del programa: **Ayuda y pruebas** → **Crear datos de prueba** para probarlo sin arriesgar nada tuyo. Guía de 5 minutos: [`docs/PRUEBAS-MANUALES.md`](docs/PRUEBAS-MANUALES.md).

## Copiar y transferir

Desde el mapa o la lista, con clic derecho o con la barra de selección:

- **Copiar a otro disco**: copia la carpeta a un USB, disco duro o SSD (NTFS, exFAT o FAT32), la **verifica** y deja el original donde estaba.
- **Transferir a otro disco (mover)**: copia, verifica **por completo** (huella SHA-256 de cada archivo) y envía el original a la **Papelera**. Si no cabe en la Papelera (o el disco de origen no tiene), te pregunta si prefieres **borrarlo definitivamente** (con una confirmación aparte) o dejar el original.
- **Copias anteriores** (barra lateral): BoneYardDog recuerda en tu PC las copias que hizo y las vuelve a comprobar cuando quieras (conviene después de expulsar y reconectar el disco).
- La copia queda **tal cual**: `<destino>\<nombre de la carpeta>`, sin carpetas de fecha ni archivos extra. Puedes elegir la raíz de un USB (`E:\`) como destino. Si cancelas o algo falla, la copia incompleta se quita sola (solo lo que esa operación creó).
- **Volver a escanear** (cabecera, pestaña Lista o F5): vuelve a leer la misma carpeta o unidad sin elegirla otra vez.
- Si algo se queda esperando, **Ayuda y pruebas → Guardar registro de diagnóstico…** guarda los tiempos de cada etapa (incluye rutas, no contenido).

> ⚠️ **Prueba primero con datos de prueba, nunca con datos que no tengas respaldados.** El borrado definitivo no se puede deshacer. Qué garantiza la app y qué no: [`docs/SEGURIDAD-TRANSFERENCIAS.md`](docs/SEGURIDAD-TRANSFERENCIAS.md). Cómo probarla a mano con discos reales: [`docs/PRUEBAS-MANUALES.md`](docs/PRUEBAS-MANUALES.md).

## Estado

El plan y el estado de cada fase están en [`docs/ALCANCE.md`](docs/ALCANCE.md).

## Pruebas

Requiere Node.js 22 o superior.

```
npm install        # instala Electron (solo hace falta para abrir la app y la prueba de humo)
npm test           # pruebas del motor, el servicio y la seguridad; no necesitan Electron
npm start          # abre la app
npm run smoke      # abre la app sola, escanea carpetas de ejemplo, usa los controles, recorre el asistente
                   # de copiar y transferir, revisa la ventana y guarda capturas (mapa.png, lista.png,
                   # asistente-*.png) y resultado.json
npm run smoke:transfer  # prueba el motor de transferencia en un sistema real (con la Papelera de verdad)
                        # y guarda smoke-artifacts/transferencia.json
npm run smoke:discos    # (solo Windows, como administrador) crea discos virtuales NTFS, exFAT y FAT32 con diskpart
                        # y prueba el motor contra ellos (raíz como destino, archivo grande con tiempos y eventos);
                        # guarda smoke-artifacts/discos.json y los diagnostico-*.log
npm run empaquetar      # construye el instalador en dist/ (en Windows; normalmente lo hace GitHub)
```

`npm run smoke` se ejecuta automáticamente en Windows real en cada push (ver `.github/workflows/smoke-windows.yml`). En Linux sin pantalla usa `xvfb-run` si está instalado.

## Licencia

MIT. Ver [`LICENSE`](LICENSE).
