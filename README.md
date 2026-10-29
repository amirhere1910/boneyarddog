# BoneYardDog

Analizador de discos para Windows 11: encuentra carpetas grandes que llevan mucho tiempo sin usarse, para que puedas moverlas a un disco externo o USB.

Gratis y de código abierto (licencia MIT). Hecho con Electron.

## Qué hace

Tiene dos vistas. El **mapa** dibuja las carpetas como cuadros: cuanto más grande el cuadro, más pesa la carpeta; en naranja y amarillo las que tuvieron movimiento reciente, en azul y plomo las que no. Con clic entras a una carpeta y con clic derecho ves sus opciones y detalles. La **lista de candidatas** muestra las **carpetas grandes que llevan tiempo sin usarse** (por defecto, más de 3 meses y más de 500 MB; ambos se pueden cambiar en la pantalla) para que puedas pasarlas a un disco externo o USB. Una carpeta está "sin uso" si **ningún archivo dentro** fue modificado ni creado o copiado en ese período. La fecha de "último acceso" se ignora porque antivirus y copias de seguridad la cambian solos. Cada carpeta muestra su archivo más reciente, y puedes ignorar las que no quieras ver.

## Copiar y transferir

Desde el mapa o la lista, con clic derecho o con la barra de selección:

- **Copiar a otro disco**: copia la carpeta a un USB, disco duro o SSD (NTFS, exFAT o FAT32), la **verifica** y deja el original donde estaba.
- **Transferir a otro disco (mover)**: copia, verifica **por completo** (huella SHA-256 de cada archivo) y envía el original a la **Papelera**. Si no cabe en la Papelera (o el disco de origen no tiene), te pregunta si prefieres **borrarlo definitivamente** (con una confirmación aparte) o dejar el original.
- **Verificar una copia anterior**: vuelve a comprobar una copia ya hecha (conviene después de expulsar y reconectar el disco).

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
```

`npm run smoke` se ejecuta automáticamente en Windows real en cada push (ver `.github/workflows/smoke-windows.yml`). En Linux sin pantalla usa `xvfb-run` si está instalado.

## Licencia

MIT. Ver [`LICENSE`](LICENSE).
