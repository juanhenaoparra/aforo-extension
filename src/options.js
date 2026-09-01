import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['venueName', 'capacity', 'venueCode', 'supabaseUrl', 'supabaseKey'];
const msg = $('msg');

const say = (text, kind = 'ok') => { msg.className = `msg ${kind}`; msg.textContent = text; };

function readForm() {
  return {
    venueName: $('venueName').value.trim() || 'Mi local',
    capacity: Math.max(0, parseInt($('capacity').value, 10) || 0),
    venueCode: $('venueCode').value.trim().toUpperCase(),
    supabaseUrl: $('supabaseUrl').value.trim(),
    supabaseKey: $('supabaseKey').value.trim(),
    soundOn: $('soundOn').checked,
  };
}

async function load() {
  const c = await store.getConfig();
  for (const f of FIELDS) $(f).value = c[f] ?? '';
  if (!c.capacity) $('capacity').value = 0;
  $('soundOn').checked = c.soundOn;
}

$('genCode').addEventListener('click', (e) => {
  e.preventDefault();
  const rand = [...crypto.getRandomValues(new Uint8Array(5))]
    .map((b) => b.toString(36).toUpperCase().padStart(2, '0')).join('').slice(0, 8);
  const slug = ($('venueName').value.trim() || 'LOCAL')
    .toUpperCase().normalize('NFD').replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'LOCAL';
  $('venueCode').value = `${slug}-${rand}`;
});

$('save').addEventListener('click', async () => {
  await store.setConfig(readForm());
  say('Ajustes guardados.');
});

$('test').addEventListener('click', async () => {
  const form = readForm();
  await store.setConfig(form);
  if (!store.isCloudEnabled(form)) {
    return say('Faltan datos: hacen falta URL, clave y código del local.', 'bad');
  }
  say('Conectando…');
  try {
    const config = await store.getConfig();
    const remote = await store.testConnection(config);
    await chrome.runtime.sendMessage({ type: 'sync' });
    say(`Conectado. Local «${remote.name ?? config.venueName}» con ${remote.count ?? 0} persona(s) contadas.`);
  } catch (err) {
    say(`No se pudo conectar.\n\n${err.message || err}\n\n` +
        '¿Has aplicado la migración de supabase/migrations/ en el proyecto?', 'bad');
  }
});

$('export').addEventListener('click', async () => {
  try {
    const rows = await store.history(30);
    if (!rows?.length) return say('No hay historial que exportar todavía.', 'bad');
    const csv = ['hora,personas']
      .concat(rows.map((r) => [r.hour, r.people].join(',')))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `aforo-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    say(`Exportadas ${rows.length} horas de historial.`);
  } catch (err) {
    say(`No se pudo exportar.\n\n${err.message || err}`, 'bad');
  }
});

load();
