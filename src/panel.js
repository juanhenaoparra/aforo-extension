// Panel del contador. Lo montan tanto el popup como la ventana flotante.
import * as store from './store.js';

const MARKUP = `
  <div class="bar">
    <div class="venue" data-ref="venue">Aforo</div>
    <div class="status"><i class="dot" data-ref="dot"></i><span data-ref="statusText">local</span></div>
  </div>

  <div class="score" data-ref="score">
    <div class="score-label">Personas dentro</div>
    <div class="score-value" data-ref="occupancy">0</div>
    <div class="score-capacity" data-ref="capacity"></div>
    <div class="gauge" data-ref="gauge"><i data-ref="gaugeFill"></i></div>
  </div>

  <div class="actions">
    <button class="tally in" data-ref="btnIn" title="Registrar entrada (Alt+Shift+↑)">
      <span class="sign">+</span><span class="word">Entrada</span>
    </button>
    <button class="tally out" data-ref="btnOut" title="Registrar salida (Alt+Shift+↓)">
      <span class="sign">−</span><span class="word">Salida</span>
    </button>
  </div>

  <div class="stats">
    <div class="stat"><b data-ref="entries">0</b><span>Entradas</span></div>
    <div class="stat"><b data-ref="exits">0</b><span>Salidas</span></div>
    <div class="stat"><b data-ref="peak">0</b><span>Pico</span></div>
  </div>

  <div class="tools">
    <button class="tool" data-ref="btnUndo" title="Deshacer el último registro">↶ Deshacer</button>
    <button class="tool" data-ref="btnFloat" title="Abrir en ventana flotante">⧉ Flotante</button>
    <button class="tool" data-ref="btnPin" title="Fijar siempre encima" hidden>📌 Encima</button>
    <button class="tool" data-ref="btnSettings" title="Ajustes">⚙</button>
    <button class="tool danger" data-ref="btnReset" title="Poner a cero la jornada">⟲</button>
  </div>

  <div class="hint" data-ref="hint"></div>
`;

/** Toda escritura pasa por el service worker: así hay un único escritor de la cola. */
const ask = async (type, payload = {}) => {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (res?.error) throw new Error(res.error);
  return res;
};

const refs = (root) =>
  Object.fromEntries([...root.querySelectorAll('[data-ref]')].map((el) => [el.dataset.ref, el]));

const beep = (freq) => {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.13);
    setTimeout(() => ctx.close(), 300);
  } catch { /* sin audio disponible */ }
};

const timeAgo = (ts) => {
  if (!ts) return '';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'hace un momento';
  if (mins < 60) return `hace ${mins} min`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d`;
};

const STATUS_TEXT = {
  synced: 'sincronizado',
  pending: (n) => `${n} sin enviar`,
  error: 'sin conexión',
  local: 'sólo local',
};

/**
 * Monta el panel dentro de `root`.
 * @param {object} opts
 * @param {boolean} opts.compact      variante estrecha para el popup del icono
 * @param {boolean} opts.canFloat     mostrar el botón de ventana flotante
 * @param {boolean} opts.canPin       mostrar el botón "siempre encima" (Document PiP)
 * @param {Function} opts.onFloat     al pulsar "flotante"
 * @param {Function} opts.onPin       al pulsar "encima"
 */
export function mount(root, opts = {}) {
  root.classList.add('panel');
  root.innerHTML = MARKUP;
  const el = refs(root);
  let state = null;
  let soundOn = true;

  el.btnFloat.hidden = !opts.canFloat;
  el.btnPin.hidden = !opts.canPin;

  function paint(s) {
    state = s;
    soundOn = s.config.soundOn;
    const cap = s.config.capacity || 0;
    const full = cap > 0 && s.occupancy >= cap;

    el.venue.textContent = s.config.venueName || 'Aforo';
    el.occupancy.textContent = s.occupancy;
    el.entries.textContent = s.entries;
    el.exits.textContent = s.exits;
    el.peak.textContent = s.peak;

    el.capacity.textContent = cap ? `de ${cap} · ${Math.round((s.occupancy / cap) * 100)}%` : '';
    el.score.classList.toggle('full', full);
    el.gauge.classList.toggle('full', full);
    el.gauge.hidden = !cap;
    el.gaugeFill.style.width = cap ? `${Math.min(100, (s.occupancy / cap) * 100)}%` : '0%';

    el.dot.dataset.state = s.connection;
    const label = STATUS_TEXT[s.connection];
    el.statusText.textContent = typeof label === 'function' ? label(s.pending) : label;
    el.dot.title = s.error || '';

    el.btnUndo.disabled = s.occupancy === 0 && s.entries === 0 && s.exits === 0;
    el.hint.innerHTML = s.since
      ? `Jornada iniciada ${timeAgo(s.since)}`
      : '<kbd>Alt</kbd>+<kbd>⇧</kbd>+<kbd>↑</kbd> entrada · <kbd>↓</kbd> salida';
  }

  async function act(fn, button, freq) {
    if (button) {
      button.classList.remove('flash');
      void button.offsetWidth;      // reinicia la animación
      button.classList.add('flash');
    }
    if (freq && soundOn) beep(freq);
    try { paint(await fn()); } catch (err) { console.error(err); refresh(); }
  }

  const refresh = async () => paint(await store.readState());

  el.btnIn.addEventListener('click', () => act(() => ask('record', { kind: 'in' }), el.btnIn, 880));
  el.btnOut.addEventListener('click', () => act(() => ask('record', { kind: 'out' }), el.btnOut, 520));
  el.btnUndo.addEventListener('click', () => act(() => ask('undo'), null, 300));
  el.btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
  el.btnFloat.addEventListener('click', () => opts.onFloat?.());
  el.btnPin.addEventListener('click', () => opts.onPin?.());
  el.btnReset.addEventListener('click', () => {
    const n = state?.occupancy ?? 0;
    // La ventana PiP tiene su propio `window`: hay que pedirle a ella el diálogo.
    const view = root.ownerDocument.defaultView ?? window;
    if (view.confirm(`¿Poner el contador a cero?\n\nAhora mismo hay ${n} persona${n === 1 ? '' : 's'} dentro.`)) {
      act(() => ask('reset'));
    }
  });

  root.ownerDocument.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    const key = e.key;
    if (key === 'ArrowUp' || key === '+' || key === ' ') { e.preventDefault(); el.btnIn.click(); }
    else if (key === 'ArrowDown' || key === '-') { e.preventDefault(); el.btnOut.click(); }
    else if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'z') { e.preventDefault(); el.btnUndo.click(); }
  });

  const stop = store.onChange(refresh);
  refresh();

  return { refresh, paint, destroy: stop, elements: el };
}
