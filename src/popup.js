import { mount } from './panel.js';

mount(document.getElementById('root'), {
  compact: true,
  canFloat: true,
  onFloat: async () => {
    await chrome.runtime.sendMessage({ type: 'open-floating' });
    window.close();
  },
});
