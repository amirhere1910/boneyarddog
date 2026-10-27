# BoneYardDog

Analizador de discos para Windows 11: encuentra carpetas grandes que llevan mucho tiempo sin usarse, para que puedas moverlas a un disco externo o USB.

Gratis y de código abierto (licencia MIT). Hecho con Electron.

## Qué hace

Tiene dos vistas. El **mapa** dibuja las carpetas como cuadros: cuanto más grande el cuadro, más pesa la carpeta; en naranja y amarillo las que tuvieron movimiento reciente, en azul y plomo las que no. Con clic entras a una carpeta y con clic derecho ves sus opciones y detalles. La **lista de candidatas** muestra las **carpetas grandes que llevan tiempo sin usarse** (por defecto, más de 3 meses y más de 500 MB; ambos se pueden cambiar en la pantalla) para que puedas pasarlas a un disco externo o USB. Una carpeta está "sin uso" si **ningún archivo dentro** fue modificado ni creado o copiado en ese período. La fecha de "último acceso" se ignora porque antivirus y copias de seguridad la cambian solos. Cada carpeta muestra su archivo más reciente, y puedes ignorar las que no quieras ver.

> ⚠️ **Fase de desarrollo, aún no usar para borrar datos reales.**
> Por ahora la app solo analiza: no ejecuta ninguna acción de borrado ni de movimiento.

## Estado

El plan y el estado de cada fase están en [`docs/ALCANCE.md`](docs/ALCANCE.md).

## Pruebas

Requiere Node.js 22 o superior.

```
npm install        # instala Electron (solo hace falta para abrir la app y la prueba de humo)
npm test           # pruebas del motor, el servicio y la seguridad; no necesitan Electron
npm start          # abre la app
npm run smoke      # abre la app sola, escanea carpetas de ejemplo, usa los controles, revisa
                   # la ventana y guarda smoke-artifacts/ventana.png y resultado.json
```

`npm run smoke` se ejecuta automáticamente en Windows real en cada push (ver `.github/workflows/smoke-windows.yml`). En Linux sin pantalla usa `xvfb-run` si está instalado.

## Licencia

MIT. Ver [`LICENSE`](LICENSE).
