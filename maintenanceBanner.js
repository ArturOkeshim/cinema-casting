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
    <div class="maintenance-banner__title">Сервис в разработке</div>
    <div class="maintenance-banner__text">
      Если что-то не работает или есть пожелания по функционалу, напишите:
    </div>
    <div class="maintenance-banner__contacts">
      <a href="mailto:artem.mishchenko16@gmail.com">email: artem.mishchenko16@gmail.com</a>
      <a href="https://t.me/artemmish" target="_blank" rel="noopener noreferrer">tg: @artemmish</a>
    </div>
  `;

  const toggleBtn = document.createElement('button');
  toggleBtn.id = TOGGLE_ID;
  toggleBtn.type = 'button';
  toggleBtn.setAttribute('aria-label', 'Показать контакты');
  toggleBtn.textContent = '✉';

  const style = document.createElement('style');
  style.textContent = `
    #${BANNER_ID} {
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 3000;
      width: min(360px, calc(100vw - 24px));
      border: 1px solid rgba(103, 132, 209, 0.55);
      border-radius: 12px;
      background: rgba(15, 22, 51, 0.92);
      color: #dbe7ff;
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.38);
      backdrop-filter: blur(4px);
      padding: 10px 12px;
      font-family: Inter, Segoe UI, Roboto, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.35;
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
      font-weight: 700;
      margin-bottom: 4px;
      color: #eef4ff;
      padding-right: 20px;
    }

    #${BANNER_ID} .maintenance-banner__text {
      color: #bfcef8;
      margin-bottom: 6px;
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
      color: #dbe7ff;
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.38);
      backdrop-filter: blur(4px);
      cursor: pointer;
      display: none;
      font-size: 18px;
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
