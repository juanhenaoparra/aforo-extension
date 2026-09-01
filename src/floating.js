// Ventana flotante. Además puede saltar a Document Picture-in-Picture, que es la
// única forma en Chrome de tener una ventana realmente siempre encima del resto.
import { mount } from './panel.js';

const root = document.getElementById('root');
const canPin = 'documentPictureInPicture' in window;
let panel = null;
let pipWindow = null;

function mountIn(container, doc) {
  panel?.destroy();
  panel = mount(container, {
    canFloat: false,
    canPin: canPin && doc === document,
    onPin: openPip,
  });
}

async function openPip() {
  try {
    pipWindow = await documentPictureInPicture.requestWindow({ width: 300, height: 430 });
  } catch (err) {
    alert('Chrome no ha permitido abrir la ventana “siempre encima”.\n\n' +
          'Necesitas Chrome 116 o superior. La ventana normal sigue funcionando.\n\n' + err);
    return;
  }

  // La ventana PiP arranca con un documento vacío: hay que llevarle los estilos.
  for (const sheet of document.styleSheets) {
    try {
      const css = [...sheet.cssRules].map((r) => r.cssText).join('\n');
      const style = pipWindow.document.createElement('style');
      style.textContent = css;
      pipWindow.document.head.append(style);
    } catch {
      const link = pipWindow.document.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      pipWindow.document.head.append(link);
    }
  }

  const container = pipWindow.document.createElement('div');
  pipWindow.document.body.append(container);
  root.hidden = true;
  mountIn(container, pipWindow.document);

  pipWindow.addEventListener('pagehide', () => {
    pipWindow = null;
    root.hidden = false;
    mountIn(root, document);
  });
}

mountIn(root, document);

// Sondeo del servidor: rápido mientras la ventana está a la vista, lento si no.
let timer = null;
function schedule() {
  clearInterval(timer);
  const visible = document.visibilityState === 'visible' || pipWindow;
  timer = setInterval(() => chrome.runtime.sendMessage({ type: 'sync' }).catch(() => {}), visible ? 4000 : 30000);
}
document.addEventListener('visibilitychange', schedule);
schedule();
chrome.runtime.sendMessage({ type: 'sync' }).catch(() => {});
