# BoneYardDog

Analizador de discos para Windows 11: encuentra archivos y carpetas grandes y, sobre todo, los que llevan mucho tiempo sin usarse, para que puedas enviarlos a la papelera o moverlos a un disco externo.

Gratis y de código abierto (licencia MIT). Hecho con Electron.

> ⚠️ **Fase de desarrollo, aún no usar para borrar datos reales.**
> Por ahora la app solo analiza (motor + una pantalla de prueba): no ejecuta ninguna acción de borrado ni de movimiento.

## Estado

El plan y el estado de cada fase están en [`docs/ALCANCE.md`](docs/ALCANCE.md).

## Pruebas

Requiere Node.js 22 o superior.

```
npm install        # instala Electron (solo hace falta para abrir la app y la prueba de humo)
npm test           # pruebas del motor, el servicio y la seguridad; no necesitan Electron
npm start          # abre la app (pantalla de prueba)
npm run smoke      # abre la app sola, escanea una carpeta de ejemplo, revisa la ventana
                   # y guarda smoke-artifacts/ventana.png y resultado.json
```

`npm run smoke` se ejecuta automáticamente en Windows real en cada push (ver `.github/workflows/smoke-windows.yml`). En Linux sin pantalla usa `xvfb-run` si está instalado.

## Licencia

MIT. Ver [`LICENSE`](LICENSE).
