// Núcleo compartido: configuración, estado del contador, cola offline y sincronización.
// Lo usan el popup, la ventana flotante y el service worker.
//
// Modelo: `base` es el último snapshot autoritativo del servidor y `queue` son los
// eventos que aún no ha confirmado. Lo que se muestra es siempre base + queue, así
// que el clic se ve al instante aunque no haya red. Sin nube configurada, `queue`
// es directamente el libro mayor local de la jornada.

const KEYS = { config: 'pc.config', base: 'pc.base', queue: 'pc.queue', error: 'pc.error' };

export const DEFAULT_CONFIG = {
  supabaseUrl: '',
  supabaseKey: '',
  venueCode: '',
  venueName: 'Mi local',
  capacity: 0,        // 0 = sin límite de aforo
  deviceId: '',
  soundOn: true,
};

const EMPTY_BASE = {
  occupancy: 0, entries: 0, exits: 0, peak: 0,
  since: null, venueId: null, syncedAt: null,
};

const area = chrome.storage.local;
const get = async (key, fallback) => (await area.get(key))[key] ?? fallback;

// La cola se lee y se reescribe entera, así que dos mutaciones a la vez podrían
// perder un clic. Se encadenan para que se apliquen de una en una. Entre ventanas
// distintas lo garantiza el service worker, que es el único que las ejecuta.
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

export const getConfig = async () => ({ ...DEFAULT_CONFIG, ...(await get(KEYS.config, {})) });
export const getBase   = async () => ({ ...EMPTY_BASE, ...(await get(KEYS.base, {})) });
export const getQueue  = async () => await get(KEYS.queue, []);

export async function setConfig(patch) {
  const config = { ...(await getConfig()), ...patch };
  if (!config.deviceId) config.deviceId = crypto.randomUUID();
  await area.set({ [KEYS.config]: config });
  await refreshBadge();
  return config;
}

export const isCloudEnabled = (c) => Boolean(c.supabaseUrl && c.supabaseKey && c.venueCode);

/** Pliega los eventos pendientes sobre el snapshot: eso es lo que ve el usuario. */
export function fold(base, queue) {
  const s = { ...base, pending: queue.length };
  for (const ev of queue) {
    if (ev.kind === 'in') { s.occupancy += 1; s.entries += 1; }
    else if (ev.kind === 'out') { s.occupancy -= 1; s.exits += 1; }
    s.occupancy = Math.max(0, s.occupancy);
    s.peak = Math.max(s.peak, s.occupancy);
  }
  s.occupancy = Math.max(0, s.occupancy);
  return s;
}

/** Estado visible ahora mismo. */
export async function readState() {
  const [base, queue, config, error] = await Promise.all([
    getBase(), getQueue(), getConfig(), get(KEYS.error, null),
  ]);
  const cloud = isCloudEnabled(config);
  const s = fold(base, queue);
  return {
    ...s,
    config,
    cloud,
    error,
    since: s.since ?? null,
    connection: !cloud ? 'local' : error ? 'error' : s.pending ? 'pending' : 'synced',
  };
}

/** Registra un evento: se aplica en local al instante y se envía en segundo plano. */
export const record = (kind) => withLock(() => recordNow(kind));

async function recordNow(kind) {
  const queue = await getQueue();
  queue.push({ id: crypto.randomUUID(), kind, ts: Date.now() });
  await area.set({ [KEYS.queue]: queue });
  await refreshBadge();

  if (isCloudEnabled(await getConfig())) queueMicrotask(() => flush().catch(() => {}));
  return readState();
}

/** Deshace el último evento: de la cola si sigue pendiente, del servidor si ya viajó. */
export const undo = () => withLock(undoNow);

async function undoNow() {
  const queue = await getQueue();
  if (queue.length) {
    queue.pop();
    await area.set({ [KEYS.queue]: queue });
    await refreshBadge();
    return readState();
  }
  const config = await getConfig();
  if (isCloudEnabled(config)) {
    const remote = await rpc(config, 'pc_undo', {
      p_code: config.venueCode, p_device: config.deviceId,
    });
    await area.set({ [KEYS.base]: toBase(remote) });
    await refreshBadge();
  }
  return readState();
}

/** Pone el contador a cero: empieza una jornada nueva. */
export const resetCounter = () => withLock(resetNow);

async function resetNow() {
  const config = await getConfig();
  if (isCloudEnabled(config)) {
    const remote = await rpc(config, 'pc_reset', {
      p_code: config.venueCode, p_device: config.deviceId,
    });
    await area.set({ [KEYS.base]: toBase(remote), [KEYS.queue]: [] });
  } else {
    await area.set({
      [KEYS.base]: { ...EMPTY_BASE, since: Date.now(), syncedAt: Date.now() },
      [KEYS.queue]: [],
    });
  }
  await refreshBadge();
  return readState();
}

// ---------------------------------------------------------------- Supabase

async function rpc(config, fn, body) {
  const url = `${config.supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: config.supabaseKey,
      Authorization: `Bearer ${config.supabaseKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${fn} → ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

function toBase(remote) {
  return {
    occupancy: Math.max(0, remote.occupancy ?? 0),
    entries: remote.entries ?? 0,
    exits: remote.exits ?? 0,
    peak: remote.peak ?? 0,
    since: remote.since ? Date.parse(remote.since) : null,
    venueId: remote.venue_id ?? null,
    syncedAt: Date.now(),
  };
}

const setError = (msg) => area.set({ [KEYS.error]: msg });

/** Envía lo pendiente y adopta el estado que devuelve el servidor. */
export const flush = () => withLock(flushNow);

async function flushNow() {
  const config = await getConfig();
  if (!isCloudEnabled(config)) return readState();

  const sending = await getQueue();
  try {
    const remote = sending.length
      ? await rpc(config, 'pc_push', {
          p_code: config.venueCode, p_device: config.deviceId,
          p_name: config.venueName, p_capacity: config.capacity || null,
          p_events: sending,
        })
      : await rpc(config, 'pc_state', { p_code: config.venueCode });

    // Sólo se descartan los eventos de este envío: los que llegaron mientras la
    // petición estaba en vuelo siguen pendientes para la siguiente vuelta.
    const sent = new Set(sending.map((e) => e.id));
    const rest = (await getQueue()).filter((e) => !sent.has(e.id));
    await area.set({ [KEYS.base]: toBase(remote), [KEYS.queue]: rest, [KEYS.error]: null });
  } catch (err) {
    await setError(String(err.message || err));
    throw err;
  }
  await refreshBadge();
  return readState();
}

/** Sondeo: trae el estado del servidor (y de paso empuja lo pendiente). */
export async function pull() {
  const config = await getConfig();
  if (!isCloudEnabled(config)) return readState();
  return flush();
}

/** Historial por horas, para el CSV. */
export async function history(days = 7) {
  const config = await getConfig();
  if (!isCloudEnabled(config)) return [];
  return rpc(config, 'pc_history', { p_code: config.venueCode, p_days: days });
}

/** Comprueba credenciales y da de alta el local si no existía. */
export async function testConnection(config) {
  return rpc(config, 'pc_push', {
    p_code: config.venueCode, p_device: config.deviceId || 'setup',
    p_name: config.venueName, p_capacity: config.capacity || null,
    p_events: [],
  });
}

// ---------------------------------------------------------------- badge

export async function refreshBadge() {
  try {
    const s = await readState();
    const full = s.config.capacity > 0 && s.occupancy >= s.config.capacity;
    await chrome.action.setBadgeText({ text: String(s.occupancy) });
    await chrome.action.setBadgeBackgroundColor({ color: full ? '#dc2626' : '#0f766e' });
  } catch { /* chrome.action no existe en todos los contextos */ }
}

/** Avisa a cualquier ventana abierta cuando cambia el estado compartido. */
export function onChange(cb) {
  const listener = (changes, areaName) => {
    if (areaName === 'local' && Object.keys(changes).some((k) => Object.values(KEYS).includes(k))) cb();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
