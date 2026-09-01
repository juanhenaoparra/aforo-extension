// Pruebas del núcleo con chrome.* y fetch simulados. Ejecutar: node test/store.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

// ------------------------------------------------------------------ simulacros
const mem = new Map();
const listeners = [];
let calls = [];
let serverFails = false;
const server = { events: new Map(), resetAt: 0 };

globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => (mem.has(key) ? { [key]: structuredClone(mem.get(key)) } : {}),
      set: async (obj) => {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) { mem.set(k, structuredClone(v)); changes[k] = { newValue: v }; }
        listeners.forEach((l) => l(changes, 'local'));
      },
    },
    onChanged: { addListener: (l) => listeners.push(l), removeListener: () => {} },
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
};

function state() {
  const live = [...server.events.values()].filter((e) => e.ts >= server.resetAt);
  return {
    venue_id: 'v1', code: 'TEST', name: 'Test', capacity: null,
    since: new Date(server.resetAt).toISOString(),
    count: live.length,
  };
}

globalThis.fetch = async (url, init) => {
  const fn = url.split('/').pop();
  const body = JSON.parse(init.body);
  calls.push(fn);
  if (serverFails) return { ok: false, status: 503, text: async () => 'offline' };

  if (fn === 'pc_push') {
    for (const e of body.p_events ?? []) {                       // idempotente por id
      if (!server.events.has(e.id)) server.events.set(e.id, { ts: e.ts });
    }
  } else if (fn === 'pc_reset') {
    server.resetAt = Date.now();
  } else if (fn === 'pc_undo') {
    const live = [...server.events.entries()].filter(([, e]) => e.ts >= server.resetAt)
      .sort((a, b) => a[1].ts - b[1].ts);
    if (live.length) server.events.delete(live.at(-1)[0]);
  }
  return { ok: true, status: 200, json: async () => state() };
};

const store = await import('../src/store.js');

const reset = async (cloud) => {
  mem.clear(); calls = []; serverFails = false;
  server.events.clear(); server.resetAt = 0;
  await store.setConfig(cloud
    ? { supabaseUrl: 'https://x.supabase.co', supabaseKey: 'k', venueCode: 'TEST', venueName: 'Test', capacity: 0 }
    : { supabaseUrl: '', supabaseKey: '', venueCode: '', venueName: 'Test', capacity: 0 });
};

// -------------------------------------------------------------------- pruebas
test('modo local: cuenta sin tocar la red', async () => {
  await reset(false);
  for (let i = 0; i < 3; i++) await store.record();
  const s = await store.readState();
  assert.equal(s.count, 3);
  assert.equal(s.connection, 'local');
  assert.equal(calls.length, 0, 'sin nube no se hace ninguna petición');
});

test('deshacer retira el último registro y nunca baja de cero', async () => {
  await reset(false);
  await store.record();
  await store.record();
  await store.undo();
  assert.equal((await store.readState()).count, 1);

  await store.undo();
  await store.undo();                       // de más: no debe romper nada
  assert.equal((await store.readState()).count, 0);
});

test('poner a cero limpia el contador', async () => {
  await reset(false);
  await store.record();
  await store.record();
  const s = await store.resetCounter();
  assert.equal(s.count, 0);
  assert.ok(s.since, 'queda registrado el inicio de jornada');
});

test('nube: se envía y el servidor manda', async () => {
  await reset(true);
  await store.record();
  await store.record();
  await store.flush();
  const s = await store.readState();
  assert.equal(s.count, 2);
  assert.equal(s.pending, 0);
  assert.equal(s.connection, 'synced');
});

test('sin red: se acumula en la cola y se envía entero al volver', async () => {
  await reset(true);
  serverFails = true;
  for (let i = 0; i < 4; i++) await store.record().catch(() => {});
  let s = await store.readState();
  assert.equal(s.count, 4, 'el mostrador sigue correcto sin conexión');
  assert.equal(s.pending, 4);
  assert.equal(s.connection, 'error');

  serverFails = false;
  s = await store.flush();
  assert.equal(s.pending, 0);
  assert.equal(s.count, 4, 'el servidor llega al mismo total');
  assert.equal(s.connection, 'synced');
});

test('reenviar la misma cola no duplica (idempotencia por client_id)', async () => {
  await reset(true);
  await store.record();
  const queue = await store.getQueue();
  const config = await store.getConfig();
  // Simula un envío que llega al servidor pero cuya respuesta se pierde.
  await fetch(`${config.supabaseUrl}/rest/v1/rpc/pc_push`, {
    body: JSON.stringify({ p_code: 'TEST', p_events: queue }),
  });
  const s = await store.flush();
  assert.equal(s.count, 1, 'un solo registro pese al doble envío');
});

test('clics concurrentes no se pisan entre sí', async () => {
  await reset(false);
  await Promise.all(Array.from({ length: 25 }, () => store.record()));
  assert.equal((await store.readState()).count, 25, 'no se pierde ningún clic');
});
