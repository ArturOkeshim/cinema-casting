/** Подставь ID счётчика из Яндекс.Метрики. Пока пусто — скрипт не грузится. */
export const YANDEX_METRIKA_ID = '109741782';

let metrikaReady = false;

export function initMetrika() {
  const id = String(YANDEX_METRIKA_ID || '').trim();
  if (!id || document.getElementById('yandex-metrika')) return;

  window.ym =
    window.ym ||
    function ym(...args) {
      (window.ym.a = window.ym.a || []).push(args);
    };
  window.ym.l = Date.now();

  const script = document.createElement('script');
  script.id = 'yandex-metrika';
  script.async = true;
  script.src = `https://mc.yandex.ru/metrika/tag.js`;
  document.head.appendChild(script);

  window.ym(id, 'init', {
    clickmap: true,
    trackLinks: true,
    accurateTrackBounce: true,
    webvisor: false,
  });
  metrikaReady = true;
}

export function reachGoal(goalName, params = {}) {
  const id = String(YANDEX_METRIKA_ID || '').trim();
  if (!id || !goalName || typeof window.ym !== 'function') return;
  window.ym(id, 'reachGoal', goalName, params);
}

export function isMetrikaEnabled() {
  return metrikaReady && Boolean(String(YANDEX_METRIKA_ID || '').trim());
}
