# Aforo — contador de personas

Extensión de Chrome (Manifest V3) para contar personas en un local físico: se pulsa
**entrada** o **salida** y la extensión lleva el aforo actual, las entradas y salidas
del día y el pico máximo. Pensada para vivir en una **ventana flotante siempre encima**
del resto de aplicaciones.

## Qué hace

- **Contador manual** con dos botones grandes, pensados para pulsarse con prisa.
- **Ventana flotante** independiente (`⧉ Flotante`) y modo **siempre encima**
  (`📌 Encima`, vía Document Picture-in-Picture — Chrome 116+).
- **Atajos globales**, funcionan aunque Chrome esté en segundo plano:
  `Alt+Shift+↑` entrada · `Alt+Shift+↓` salida · `Alt+Shift+A` abrir la ventana flotante.
  Dentro del panel: `↑`/`↓`/`espacio` y `Ctrl+Z` para deshacer.
- **Aforo máximo** opcional: la ficha se pone en rojo al alcanzarlo.
- **Deshacer** el último registro y **poner a cero** la jornada.
- **Contador en el icono** de la barra de Chrome, siempre a la vista.
- **Funciona sin conexión**: los clics se guardan en una cola local y se envían solos
  cuando vuelve la red. El mostrador nunca se queda esperando.
- **Sincronización entre dispositivos** (opcional, con Supabase): varios móviles,
  tablets u ordenadores con el mismo código de local comparten el mismo contador.
- **Exportación a CSV** del historial por horas.

## Instalación

1. Abre `chrome://extensions` y activa **Modo de desarrollador**.
2. **Cargar descomprimida** → selecciona esta carpeta.
3. Ancla el icono a la barra y púlsalo. Ya cuenta (en modo local).
4. `⧉ Flotante` abre la ventana pequeña; dentro de ella, `📌 Encima` la fija sobre
   todas las demás aplicaciones.

Para publicarla o repartirla: `npm run zip`.

## Sincronizar entre dispositivos (opcional)

Sin esto la extensión funciona igual, pero el contador vive sólo en ese navegador.

1. En un proyecto de Supabase, ejecuta `sql/schema.sql` en el **SQL Editor**.
2. Abre los **ajustes** de la extensión (⚙) y rellena:
   - **URL del proyecto** — `https://xxxxxxxx.supabase.co`
   - **Clave publishable / anon** — la de *Project Settings → API Keys*
   - **Código del local** — pulsa *Generar código nuevo*
3. **Probar conexión**. Da de alta el local y confirma que responde.
4. En los demás dispositivos, repite con **exactamente el mismo código de local**.

Los dispositivos se sincronizan cada 4 segundos mientras la ventana está a la vista,
y cada minuto en segundo plano.

### Sobre la seguridad

Las tablas quedan cerradas con RLS y sin políticas: la clave publishable **no** permite
leer ni escribir directamente. Todo pasa por funciones `SECURITY DEFINER` que exigen el
código del local, que actúa como secreto compartido. Quien tenga la clave *y* el código
puede sumar y restar en ese local, así que genera un código largo y aleatorio y no lo
publiques. Si necesitas garantías más fuertes (cada empleado con su cuenta, auditoría
por persona), el paso siguiente es Supabase Auth con políticas RLS por usuario.

## Estructura

```
manifest.json        Manifest V3, permisos y atajos
src/store.js         Núcleo: configuración, estado, cola offline, RPC a Supabase
src/panel.js         Interfaz del contador, compartida por popup y ventana flotante
src/panel.css        Estilos
src/popup.html/.js   Panel compacto al pulsar el icono
src/floating.html/.js Ventana flotante + Document Picture-in-Picture
src/options.html/.js Ajustes, prueba de conexión y exportación CSV
src/background.js    Service worker: atajos, ventana flotante, sincronización
sql/schema.sql       Tablas y funciones de Supabase
test/store.test.mjs  Pruebas del núcleo (`npm test`)
```

### Cómo se mantiene el contador correcto

`base` es el último estado confirmado por el servidor y `queue` son los clics que aún
no ha confirmado; lo que se muestra es siempre `base + queue`. Por eso el número reacciona
al instante aunque no haya red, y por eso reenviar la cola no duplica nada: cada evento
lleva un `client_id` único y el servidor ignora los repetidos. Sin nube configurada, la
propia cola hace de libro mayor de la jornada.

Todas las escrituras pasan por el service worker, que es el único escritor de la cola:
así el popup y la ventana flotante pueden estar abiertos a la vez sin pisarse.

Al dar de alta un local, la jornada arranca en el clic más antiguo del primer envío, no
en el instante del alta: si el dispositivo llevaba un rato sin red, esos clics cuentan.
En cambio, los que quedaron pendientes *antes* de un «poner a cero» ya no se suman al
volver la conexión — pertenecen a la jornada anterior — pero sí quedan en el histórico.
