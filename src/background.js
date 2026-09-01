// Service worker: atajos de teclado, ventana flotante y sincronización de fondo.
import * as store from './store.js';

const FLOATING_URL = chrome.runtime.getURL('src/floating.html');
const SYNC_ALARM = 'pc.sync';

/** Abre la ventana flotante, o la trae al frente si ya está abierta. */
async function openFloating() {
  const existing = (await chrome.windows.getAll({ populate: true }))
    .find((w) => w.tabs?.some((t) => t.url === FLOATING_URL));

  if (existing) {
    await chrome.windows.update(existing.id, { focused: true, drawAttention: true });
    return existing;
  }
  return chrome.windows.create({
    url: FLOATING_URL,
    type: 'popup',
    width: 320,
    height: 470,
    top: 80,
    left: 80,
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await store.setConfig({});               // asegura que exista un deviceId
  await store.refreshBadge();
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  store.refreshBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) store.pull().catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'count-in') await store.record();
  else if (command === 'open-floating') await openFloating();
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  (async () => {
    switch (msg?.type) {
      case 'open-floating': await openFloating(); respond({ ok: true }); break;
      case 'record':        respond(await store.record()); break;
      case 'undo':          respond(await store.undo()); break;
      case 'reset':         respond(await store.resetCounter()); break;
      case 'sync':          respond(await store.pull()); break;
      default:              respond({ ok: false, error: `mensaje desconocido: ${msg?.type}` });
    }
  })().catch((err) => respond({ ok: false, error: String(err) }));
  return true;   // respuesta asíncrona
});
