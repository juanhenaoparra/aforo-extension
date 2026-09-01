# Aforo — contador de personas

Extensión de Chrome (Manifest V3) para contar personas en un local físico: un solo
botón grande que se pulsa por cada persona, pensado para vivir en una **ventana
flotante siempre encima** del resto de aplicaciones.

El contador es acumulativo: mide **cuántas personas han pasado** durante la jornada,
no cuántas hay dentro en un momento dado.

## Qué hace

- **Un botón**, grande y con respuesta inmediata (destello y pitido opcional).
- **Ventana flotante** independiente (`⧉ Flotante`) y modo **siempre encima**
  (`📌 Encima`, vía Document Picture-in-Picture — Chrome 116+).
- **Atajos**: `Alt+Shift+↑` cuenta una persona aunque Chrome esté en segundo plano y
  `Alt+Shift+A` abre la ventana flotante. Dentro del panel, `↑` / `+` / `espacio` /
  `Enter` cuentan y `Ctrl+Z` deshace.
- **Objetivo de personas** opcional: barra de progreso que se pone en rojo al llegar.
- **Deshacer** el último registro y **poner a cero** la jornada.
- **Contador en el icono** de la barra de Chrome, siempre a la vista.
- **Funciona sin conexión**: los clics se guardan en una cola local y se envían solos
  cuando vuelve la red. El mostrador nunca se queda esperando.
- **Sincronización entre dispositivos** (opcional, con Supabase): varios móviles,
  tablets u ordenadores con el mismo código de local suman al mismo contador.
- **Exportación a CSV** del histórico de personas por hora.

## Instalación

1. Abre `chrome://extensions` y activa **Modo de desarrollador**.
2. **Cargar descomprimida** → selecciona esta carpeta.
3. Ancla el icono a la barra y púlsalo. Ya cuenta (en modo local).
4. `⧉ Flotante` abre la ventana pequeña; dentro de ella, `📌 Encima` la fija sobre
   todas las demás aplicaciones.

Para repartirla: `npm run zip`.

## Sincronizar entre dispositivos (opcional)

Sin esto la extensión funciona igual, pero el contador vive sólo en ese navegador.

1. Aplica la migración `supabase/migrations/20260901120000_aforo_init.sql` al proyecto,
   con `supabase db push` o pegándola en el **SQL Editor**.
2. Da de alta el local, una sola vez, en el mismo **SQL Editor**:

   ```sql
   select public.pc_create_venue('TIENDA-7F3A2B', 'Tienda Centro', 500);
   ```

   Usa un código largo y aleatorio: el botón *Generar código nuevo* de los ajustes
   te da uno. Este paso es a propósito el único que no se puede hacer desde la
   extensión — ver más abajo.
3. Abre los **ajustes** de la extensión (⚙) y rellena:
   - **URL del proyecto** — `https://xxxxxxxx.supabase.co`
   - **Clave publishable / anon** — la de *Project Settings → API Keys*
   - **Código del local** — pulsa *Generar código nuevo*
4. **Probar conexión**. Confirma que el proyecto responde y que el local existe;
   si no existe, la propia pantalla te da la línea SQL exacta que falta ejecutar.
5. En los demás dispositivos, repite el paso 3 con **exactamente el mismo código**.

Los dispositivos se sincronizan cada 4 segundos mientras la ventana está a la vista,
y cada minuto en segundo plano.

### Sobre la seguridad

La extensión usa **únicamente la clave anon / publishable**. La service key no aparece
en el código, ni en la configuración, ni en la migración: nunca sale del panel de
Supabase. Eso importa porque la clave que va dentro de una extensión es pública de
hecho — cualquiera que la instale puede extraerla.

El diseño parte de ahí: **la clave anon, por sí sola, no sirve para nada**.

| Con la clave anon y sin el código del local | |
|---|---|
| Leer las tablas `pc_venues` / `pc_events` | ❌ RLS activo, sin políticas y sin permisos |
| Escribir en las tablas directamente | ❌ |
| Leer o escribir el contador de un local | ❌ hace falta el código |
| Dar de alta locales o llenar la base de datos | ❌ `pc_create_venue` está revocada para `anon` |

Por eso los locales se crean desde el SQL Editor y no desde la extensión: si `pc_push`
diera de alta el local que no existe — como hacía en la primera versión — cualquiera
con la clave podría crear locales sin límite e inflar la base de datos. Además `pc_push`
rechaza envíos de más de 1000 registros e ignora los que traen fecha absurda.

Lo que sí puede hacer quien consiga la clave **y** el código es sumar en ese local, así
que el código es una contraseña: largo, aleatorio y no publicado. Si necesitas garantías
más fuertes (cada empleado con su cuenta, auditoría por persona), el paso siguiente es
Supabase Auth con políticas RLS por usuario.

## Estructura

```
manifest.json           Manifest V3, permisos y atajos
src/store.js            Núcleo: configuración, estado, cola offline, RPC a Supabase
src/panel.js            Interfaz del contador, compartida por popup y ventana flotante
src/panel.css           Estilos
src/popup.html/.js      Panel compacto al pulsar el icono
src/floating.html/.js   Ventana flotante + Document Picture-in-Picture
src/options.html/.js    Ajustes, prueba de conexión y exportación CSV
src/background.js       Service worker: atajos, ventana flotante, sincronización
supabase/migrations/    Migración con tablas, RLS y funciones de acceso
test/store.test.mjs     Pruebas del núcleo (`npm test`)
```

### Cómo se mantiene el contador correcto

`base` es el último total confirmado por el servidor y `queue` son los clics que aún no
ha confirmado; lo que se muestra es siempre `base + queue`. Por eso el número reacciona
al instante aunque no haya red, y por eso reenviar la cola no duplica nada: cada registro
lleva un `client_id` único y el servidor ignora los repetidos. Sin nube configurada, la
propia cola hace de libro mayor de la jornada.

Todas las escrituras pasan por el service worker, que es el único escritor de la cola:
así el popup y la ventana flotante pueden estar abiertos a la vez sin pisarse.

Al dar de alta un local, la jornada arranca en el clic más antiguo del primer envío, no
en el instante del alta: si el dispositivo llevaba un rato sin red, esos clics cuentan.
En cambio, los que quedaron pendientes *antes* de un «poner a cero» ya no se suman al
volver la conexión — pertenecen a la jornada anterior — pero sí quedan en el histórico.
