import { initMetrika } from './analytics.js';

initMetrika();

const BANNER_ID = 'maintenanceBanner';
const TOGGLE_ID = 'maintenanceBannerToggle';
const LS_HIDDEN_KEY = 'maintenanceBannerHidden';

if (!document.getElementById(BANNER_ID)) {
  const banner = document.createElement('aside');
  banner.id = BANNER_ID;
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.innerHTML = `
    <button type="button" class="maintenance-banner__close" aria-label="Скрыть плашку">×</button>
    <div class="maintenance-banner__title">
      <span class="maintenance-banner__badge">Beta</span>
      Cinema Casting — закрытое тестирование
    </div>
    <div class="maintenance-banner__text">
      Ищем первых актёров для бета-теста. Сервис бесплатный, без регистрации.
      Авто-переход между репликами может работать нестабильно — используйте кнопку «Дальше» или пробел.
    </div>
    <div class="maintenance-banner__text maintenance-banner__text--compact">
      Нашли баг или есть идея? Напишите:
    </div>
    <div class="maintenance-banner__contacts">
      <a href="https://t.me/artemmish" target="_blank" rel="noopener noreferrer">Telegram: @artemmish</a>
      <a href="mailto:artem.mishchenko16@gmail.com">artem.mishchenko16@gmail.com</a>
    </div>
  `;

  const toggleBtn = document.createElement('button');
  toggleBtn.id = TOGGLE_ID;
  toggleBtn.type = 'button';
  toggleBtn.setAttribute('aria-label', 'Показать информацию о бете');
  toggleBtn.textContent = 'β';

  const style = document.createElement('style');
  style.textContent = `
    #${BANNER_ID} {
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 3000;
      width: min(380px, calc(100vw - 24px));
      border: 1px solid rgba(103, 132, 209, 0.55);
      border-radius: 12px;
      background: rgba(15, 22, 51, 0.94);
      color: #dbe7ff;
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.38);
      backdrop-filter: blur(4px);
      padding: 12px 14px;
      font-family: Inter, Segoe UI, Roboto, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.4;
    }

    #${BANNER_ID}.is-hidden {
      display: none;
    }

    #${BANNER_ID} .maintenance-banner__close {
      position: absolute;
      top: 6px;
      right: 8px;
      border: none;
      background: transparent;
      color: #a7bae8;
      font-size: 17px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 4px;
    }

    #${BANNER_ID} .maintenance-banner__close:hover {
      color: #dbe7ff;
    }

    #${BANNER_ID} .maintenance-banner__title {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      font-weight: 700;
      margin-bottom: 6px;
      color: #eef4ff;
      padding-right: 20px;
    }

    #${BANNER_ID} .maintenance-banner__badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(79, 124, 255, 0.25);
      border: 1px solid rgba(143, 179, 255, 0.45);
      color: #b8d1ff;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    #${BANNER_ID} .maintenance-banner__text {
      color: #bfcef8;
      margin-bottom: 6px;
    }

    #${BANNER_ID} .maintenance-banner__text--compact {
      margin-bottom: 4px;
      font-size: 12px;
    }

    #${BANNER_ID} .maintenance-banner__contacts {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    #${BANNER_ID} a {
      color: #8fb3ff;
      text-decoration: none;
      word-break: break-word;
    }

    #${BANNER_ID} a:hover {
      color: #b8d1ff;
      text-decoration: underline;
    }

    #${TOGGLE_ID} {
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 3001;
      width: 42px;
      height: 42px;
      border: 1px solid rgba(103, 132, 209, 0.55);
      border-radius: 999px;
      background: rgba(15, 22, 51, 0.92);
      color: #b8d1ff;
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.38);
      backdrop-filter: blur(4px);
      cursor: pointer;
      display: none;
      font-size: 16px;
      font-weight: 800;
      line-height: 1;
    }

    #${TOGGLE_ID}.is-visible {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
  `;

  const setHidden = (hidden) => {
    banner.classList.toggle('is-hidden', hidden);
    toggleBtn.classList.toggle('is-visible', hidden);
    localStorage.setItem(LS_HIDDEN_KEY, hidden ? '1' : '0');
  };

  banner.querySelector('.maintenance-banner__close')?.addEventListener('click', () => setHidden(true));
  toggleBtn.addEventListener('click', () => setHidden(false));

  const savedHidden = localStorage.getItem(LS_HIDDEN_KEY) === '1';
  if (savedHidden) setHidden(true);

  document.head.appendChild(style);
  document.body.appendChild(banner);
  document.body.appendChild(toggleBtn);
}
