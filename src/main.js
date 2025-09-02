import './style.css';
import data from './data.json';
import { shuffle } from 'lodash-es';

console.log('shuffle test', shuffle([1, 2, 3, 4]));

export function render() {
  document.querySelector('#app').innerHTML = `
    <pre>data.json = ${JSON.stringify(data, null, 2)}</pre>
    <p>hello</p>
  `;
}

render();

if (import.meta && import.meta.hot) {
  import.meta.hot.accept(mod => {
    if (mod && typeof mod.render === 'function') {
      console.log('[mini-vite] main.js hot accepted');
      mod.render();
    } else {
      console.log(
        '[mini-vite] render() not found on new module, fallback reload'
      );
      location.reload();
    }
  });
}
