import { resetAllAppData } from './resetAll.js';
import { downloadSessionBackupZip, pickAndImportSessionBackup } from './sessionBackup.js';
import { loadBlocks, loadRole, loadRehearsalCursor, loadPartnerAudioReady } from './flowState.js';
import { buildSequence } from './rehearsalSequence.js';

/**
 * Общая панель этапов: Сценарий → Роль → Запись → Репетиция → Итог.
 * @param {'script'|'role'|'record'|'rehearsal'|'result'} current
 * @param {{ prependTo?: ParentNode }} [opts] — например document.body, если на странице несколько <main> и одни скрываются
 */
export function initStageNav(current, opts = {}) {
  if (document.getElementById('stageNavBar')) return;

  const stages = [
    { id: 'script', label: 'Сценарий', href: './index.html' },
    { id: 'role', label: 'Выбор роли', href: './blocks.html' },
    { id: 'record', label: 'Запись реплик', href: './prep.html' },
    { id: 'rehearsal', label: 'Репетиция', href: './rehearsal.html' },
    { id: 'result', label: 'Итог', href: './result.html' },
  ];

  const styleId = 'stageNavStyles';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .stage-nav-wrap {
        position: sticky;
        top: 0;
        z-index: 100;
        margin: 0 0 18px;
        padding: 10px 0 12px;
        background: transparent;
        border-bottom: none;
        backdrop-filter: none;
      }
      .stage-nav {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        max-width: 1200px;
        margin: 0 auto;
        justify-content: center;
      }
      .stage-nav a {
        display: inline-block;
        padding: 8px 14px;
        border-radius: 999px;
        font-size: 13px;
        font-weight: 600;
        text-decoration: none;
        color: #b9c5f5;
        background: #1a2240;
        border: 1px solid #2a355f;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
      }
      .stage-nav a:hover {
        color: #e7ecff;
        border-color: #4f7cff;
        background: #162043;
      }
      .stage-nav a.current {
        background: #4f7cff;
        border-color: #4f7cff;
        color: #fff;
      }
      .stage-nav a.locked {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .stage-nav a.locked:hover {
        color: #b9c5f5;
        border-color: #2a355f;
        background: #1a2240;
      }
      .stage-nav-row {
        max-width: 1200px;
        margin: 0 auto;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        gap: 12px 20px;
        width: 100%;
      }
      .stage-nav-reset {
        border: 1px solid #7f1d1d;
        border-radius: 999px;
        padding: 7px 14px;
        font-size: 12px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        background: rgba(127, 29, 29, 0.25);
        color: #fecaca;
        flex-shrink: 0;
      }
      .stage-nav-reset:hover {
        background: rgba(127, 29, 29, 0.45);
        color: #fff;
      }
      .stage-nav-reset:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .stage-nav-save,
      .stage-nav-load,
      .stage-nav-help {
        border: 1px solid #3d4d8a;
        border-radius: 999px;
        padding: 7px 14px;
        font-size: 12px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        background: rgba(79, 124, 255, 0.12);
        color: #c7d4ff;
        flex-shrink: 0;
      }
      .stage-nav-save:hover,
      .stage-nav-load:hover,
      .stage-nav-help:hover {
        background: rgba(79, 124, 255, 0.22);
        border-color: #4f7cff;
        color: #fff;
      }
      .stage-nav-save:disabled,
      .stage-nav-load:disabled,
      .stage-nav-help:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .stage-nav-help {
        width: 30px;
        height: 30px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 15px;
        font-weight: 800;
      }
      .stage-nav-help-modal {
        position: fixed;
        inset: 0;
        z-index: 2100;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 16px;
        background: rgba(2, 8, 24, 0.72);
      }
      .stage-nav-help-modal.is-open {
        display: flex;
      }
      .stage-nav-help-modal__panel {
        width: min(520px, 100%);
        border-radius: 14px;
        border: 1px solid #2a355f;
        background: #151b31;
        color: #e7ecff;
        box-shadow: 0 14px 40px rgba(0, 0, 0, 0.35);
      }
      .stage-nav-help-modal__header {
        padding: 14px 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        border-bottom: 1px solid #2a355f;
      }
      .stage-nav-help-modal__title {
        margin: 0;
        font-size: 18px;
      }
      .stage-nav-help-modal__close {
        border: 1px solid #3d4d8a;
        border-radius: 8px;
        width: 30px;
        height: 30px;
        padding: 0;
        background: #1a2240;
        color: #e7ecff;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
      }
      .stage-nav-help-modal__content {
        padding: 14px 16px 16px;
        color: #c7d0f6;
        font-size: 14px;
        line-height: 1.55;
      }
      .stage-nav-help-modal__content p {
        margin: 0 0 10px;
      }
      .stage-nav-help-modal__content p:last-child {
        margin-bottom: 0;
      }
      .stage-nav-help-modal__content strong {
        color: #e7ecff;
      }
      .auth-modal-root[hidden] {
        display: none !important;
      }
      .auth-modal-overlay {
        position: fixed;
        inset: 0;
        z-index: 4000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        background: rgba(2, 8, 24, 0.72);
      }
      .auth-modal-panel {
        width: min(460px, 100%);
        border-radius: 14px;
        border: 1px solid #2a355f;
        background: #151b31;
        color: #e7ecff;
        box-shadow: 0 14px 40px rgba(0, 0, 0, 0.35);
        padding: 16px;
      }
      .auth-modal-header {
        margin: 0 0 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .auth-modal-header h1 {
        margin: 0;
        font-size: 20px;
      }
      .auth-close-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 1px solid #3d4d8a;
        border-radius: 8px;
        width: 24px;
        height: 24px;
        background: #1a2240;
        color: #e7ecff;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
      }
      .auth-label {
        display: block;
        margin: 0 0 6px;
        font-size: 13px;
        color: #c7d0f6;
      }
      .auth-input {
        width: 100%;
        margin: 0 0 10px;
        border: 1px solid #3d4d8a;
        border-radius: 10px;
        background: #0f1633;
        color: #e7ecff;
        padding: 10px 12px;
        font-size: 14px;
      }
      .auth-password-hint {
        margin: -4px 0 10px;
        color: #9aa6d6;
        font-size: 12px;
      }
      .auth-password-hint[hidden] {
        display: none !important;
      }
      .auth-submit-btn {
        border: 1px solid #4f7cff;
        border-radius: 10px;
        background: #4f7cff;
        color: #fff;
        padding: 10px 14px;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
      }
      .auth-register-hint {
        margin: 12px 0 6px;
        color: #c7d0f6;
        font-size: 13px;
      }
      .auth-register-btn {
        border: 1px solid #3d4d8a;
        border-radius: 10px;
        background: rgba(79, 124, 255, 0.12);
        color: #c7d4ff;
        padding: 9px 12px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
      }
      .auth-error[hidden] {
        display: none !important;
      }
      .auth-error {
        margin: 10px 0 0;
        color: #fca5a5;
        font-size: 13px;
      }
      .stage-nav-login {
        border: 1px solid #16a34a;
        border-radius: 999px;
        padding: 7px 14px;
        font-size: 12px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        background: #16a34a;
        color: #ffffff;
        flex-shrink: 0;
        max-width: 260px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .stage-nav-login:hover {
        background: #15803d;
        border-color: #15803d;
        color: #fff;
      }
      .stage-nav-mobile {
        display: none;
      }
      .stage-nav-mobile__arrow[hidden] {
        display: block;
        visibility: hidden;
      }
      @media (max-width: 768px) {
        .stage-nav {
          display: none;
        }
        .stage-nav-wrap {
          padding: 8px 0;
        }
        .stage-nav-mobile {
          display: grid;
          grid-template-columns: 34px 1fr 34px;
          align-items: center;
          gap: 6px;
          width: auto;
          max-width: calc(100vw - 140px);
          flex: 1 1 auto;
          min-width: 0;
        }
        .stage-nav-mobile__arrow {
          width: 34px;
          height: 34px;
          border: 1px solid #2a355f;
          border-radius: 9px;
          background: #1a2240;
          color: #e7ecff;
          font-size: 17px;
          font-weight: 700;
          line-height: 1;
          cursor: pointer;
          padding: 0;
        }
        .stage-nav-mobile__current {
          text-align: center;
          font-size: 12px;
          font-weight: 700;
          color: #e7ecff;
          background: #1a2240;
          border: 1px solid #2a355f;
          border-radius: 9px;
          padding: 8px 6px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          min-width: 0;
        }
        .stage-nav-row {
          flex-wrap: nowrap;
          justify-content: space-between;
          gap: 6px;
          width: 100%;
          padding-right: 6px;
        }
        .stage-nav-save,
        .stage-nav-load,
        .stage-nav-login,
        .stage-nav-reset,
        .stage-nav-help {
          width: 32px;
          height: 32px;
          padding: 0;
          border-radius: 9px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 0;
          line-height: 1;
        }
        .stage-nav-save::before,
        .stage-nav-load::before,
        .stage-nav-login::before,
        .stage-nav-reset::before {
          font-size: 16px;
        }
        .stage-nav-save::before {
          content: "💾";
        }
        .stage-nav-load::before {
          content: "📂";
        }
        .stage-nav-login::before {
          content: "👤";
        }
        .stage-nav-reset::before {
          content: "🗑";
        }
        .stage-nav-help {
          font-size: 16px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  const nav = document.createElement('div');
  nav.className = 'stage-nav-wrap';
  nav.id = 'stageNavBar';
  const row = document.createElement('div');
  row.className = 'stage-nav-row';

  const inner = document.createElement('nav');
  inner.className = 'stage-nav';
  inner.setAttribute('aria-label', 'Этапы пробы');


  const blocks = loadBlocks();
  const role = loadRole();
  const hasBlocks = Array.isArray(blocks) && blocks.length > 0;
  const hasRole = Boolean(role && role.trim());
  const isPartnerAudioReady = loadPartnerAudioReady();
  const sequence = hasBlocks && hasRole ? buildSequence(blocks, role) : [];
  const cursor = loadRehearsalCursor();
  const isRehearsalDone = sequence.length > 0 && cursor >= sequence.length;
  const resolveLastAvailableHref = () => {
    const latestBlocks = loadBlocks();
    const latestRole = loadRole();
    const latestHasBlocks = Array.isArray(latestBlocks) && latestBlocks.length > 0;
    const latestHasRole = Boolean(latestRole && latestRole.trim());
    const latestPartnerAudioReady = loadPartnerAudioReady();
    const latestSequence =
      latestHasBlocks && latestHasRole ? buildSequence(latestBlocks, latestRole) : [];
    const latestCursor = loadRehearsalCursor();
    const latestRehearsalDone =
      latestSequence.length > 0 && latestCursor >= latestSequence.length;

    if (!latestHasBlocks) return './index.html';
    if (!latestHasRole) return './blocks.html';
    if (!latestPartnerAudioReady) return './prep.html';
    if (!latestRehearsalDone) return './rehearsal.html';
    return './result.html';
  };
  const stageStates = []

  for (const s of stages) {
    const a = document.createElement('a');
    a.href = s.href;
    a.textContent = s.label;

    let isLocked = false;
    if (s.id === 'role') {
      isLocked = !hasBlocks;
    } else if (s.id === 'record') {
      isLocked = !hasBlocks || !hasRole;
    } else if (s.id === 'rehearsal') {
      isLocked = !hasBlocks || !hasRole || !isPartnerAudioReady;
    } else if (s.id === 'result') {
      isLocked = !isRehearsalDone;
    }

    if (isLocked) {
      a.classList.add('locked');
      a.setAttribute('aria-disabled', 'true');
      a.setAttribute('tabindex', '-1');
      a.addEventListener('click', (e) => e.preventDefault());
    }

    if (s.id === current) {
      a.classList.add('current');
      a.setAttribute('aria-current', 'step');
    }

    stageStates.push({
      id: s.id,
      label: s.label,
      href: s.href,
      isLocked,
      isCurrent: s.id === current
    });

    inner.appendChild(a);
  }
  

  /*
  Создаем мобильную версию навигации
  */
  const mobileNav = document.createElement('div');
  mobileNav.className = 'stage-nav-mobile';

  const prevBtn = document.createElement('button');
  prevBtn.type='button';
  prevBtn.className='stage-nav-mobile__arrow';
  prevBtn.textContent = '←';
  const nextBtn = document.createElement('button');
  nextBtn.type='button';
  nextBtn.className='stage-nav-mobile__arrow';
  nextBtn.textContent='→';

  const currentLabel = document.createElement('span');
  currentLabel.className='stage-nav-mobile__current';
  

  const currentIndex = stageStates.findIndex((x)=> x.isCurrent);
  const currentStage = currentIndex >= 0 ? stageStates[currentIndex] : null;
  currentLabel.textContent = currentStage ? currentStage.label : 'Этап';

  const prevStage = (currentIndex-1) >= 0 ? stageStates[(currentIndex-1)] : null;
  if (!prevStage || prevStage.isLocked) {
    prevBtn.hidden = true;
  } else {
    prevBtn.addEventListener('click', ()=> {
      window.location.href= prevStage.href;
    })
  }
  const nextStage = (currentIndex+1) < stageStates.length ? stageStates[(currentIndex+1)] : null;
  if (!nextStage || nextStage.isLocked) {
    nextBtn.hidden = true;
  } else {
    nextBtn.addEventListener('click', ()=> {
      window.location.href= nextStage.href;
    })
  };

  mobileNav.appendChild(prevBtn);
  mobileNav.appendChild(currentLabel);
  mobileNav.appendChild(nextBtn)
  row.appendChild(mobileNav);

  /*
  Здесь создадим кнопки для логина
  */
  function createAuthModal() {
    const authModal = document.createElement('div');
    authModal.className = 'auth-modal-root';
    authModal.hidden = true;
    authModal.innerHTML =
    ` <div class="auth-modal-overlay">
        <div class="auth-modal-panel">
          <header class="auth-modal-header">
            <h1 class="auth-modal-title">Войти</h1>
            <button type="button" class="auth-close-btn" aria-label="Закрыть">×</button>
          </header>
          <label class="auth-label" for="authEmailInput">Email</label>
          <input id="authEmailInput" type="email" class="auth-input" autocomplete="email" />
          <label class="auth-label" for="authPasswordInput">Пароль</label>
          <input id="authPasswordInput" type="password" class="auth-input" autocomplete="current-password" />
          <p class="auth-password-hint" hidden>Минимум 8 символов и хотя бы одна цифра.</p>
          <button type="button" class="auth-submit-btn">Войти</button>
          <p class="auth-register-hint">Нет аккаунта?</p>
          <button type="button" class="auth-register-btn">Перейти к регистрации</button>
          <p class="auth-error" hidden></p>
        </div>
      </div>
    `;

    const overlay = authModal.querySelector('.auth-modal-overlay');
    const closeBtn = authModal.querySelector('.auth-close-btn');
    const closeAuthModal = () => {
      authModal.hidden = true;
    };

    closeBtn?.addEventListener('click', closeAuthModal);
    overlay?.addEventListener('click', (event) => {
      if (event.target === overlay) closeAuthModal();
    });

    return authModal;
  }
  
  const authModal = createAuthModal();
  const authTitleEl = authModal.querySelector('.auth-modal-title');
  const authEmailInput = authModal.querySelector('#authEmailInput');
  const authPasswordInput = authModal.querySelector('#authPasswordInput');
  const authSubmitBtn = authModal.querySelector('.auth-submit-btn');
  const authHintEl = authModal.querySelector('.auth-register-hint');
  const authRegisterBtn = authModal.querySelector('.auth-register-btn');
  const authPasswordHintEl = authModal.querySelector('.auth-password-hint');
  const authErrorEl = authModal.querySelector('.auth-error');
  let authMode = 'login';
  const setAuthMode = (mode) => {
    authMode = mode === 'register' ? 'register' : 'login';
    const isRegister = authMode === 'register';
    if (authTitleEl) authTitleEl.textContent = isRegister ? 'Регистрация' : 'Войти';
    if (authSubmitBtn) authSubmitBtn.textContent = isRegister ? 'Зарегистрироваться' : 'Войти';
    if (authHintEl) authHintEl.textContent = isRegister ? 'Уже есть аккаунт?' : 'Нет аккаунта?';
    if (authRegisterBtn) authRegisterBtn.textContent = isRegister ? 'Перейти ко входу' : 'Перейти к регистрации';
    if (authPasswordInput) {
      // ЗАМЕТКА ДЛЯ ОБУЧЕНИЯ: autocomplete подсказывает браузеру, какой пароль предлагать.
      // new-password — придумать новый, current-password — подставить уже сохранённый.
      authPasswordInput.autocomplete = isRegister ? 'new-password' : 'current-password';
    }
    if (authPasswordHintEl) authPasswordHintEl.hidden = !isRegister;
    if (authErrorEl) {
      authErrorEl.hidden = true;
      authErrorEl.textContent = '';
    }
  };
  const openAuthModal = () => {
    setAuthMode('login');
    if (authErrorEl) {
      authErrorEl.hidden = true;
      authErrorEl.textContent = '';
    }
    authModal.hidden = false;
    authEmailInput?.focus();
  };
  const closeAuthModal = () => {
    authModal.hidden = true;
  };

  const AUTH_TOKEN_KEY = 'cc_auth_token';
  const AUTH_EMAIL_KEY = 'cc_auth_email';
  const AUTH_API_BASE_STORAGE_KEY = 'AUTH_API_BASE';
  const DEFAULT_API_BASE = 'http://127.0.0.1:8000';
  const storedApiBase = String(window.localStorage.getItem(AUTH_API_BASE_STORAGE_KEY) || '').trim();
  const AUTH_API_BASE = storedApiBase || DEFAULT_API_BASE;
  const getAuthUrl = (path) => `${AUTH_API_BASE}${path}`;

  const loginBtn = document.createElement('button');
  loginBtn.type = 'button';
  loginBtn.className = 'stage-nav-login';
  loginBtn.textContent = 'Войти';

  let isAuthorized = false;
  let currentEmail = '';
  const getStoredToken = () => window.localStorage.getItem(AUTH_TOKEN_KEY) || '';
  const setStoredAuth = (token, email) => {
    window.localStorage.setItem(AUTH_TOKEN_KEY, token);
    window.localStorage.setItem(AUTH_EMAIL_KEY, email);
  };
  const clearStoredAuth = () => {
    window.localStorage.removeItem(AUTH_TOKEN_KEY);
    window.localStorage.removeItem(AUTH_EMAIL_KEY);
  };
  const setAuthUiState = (authorized, email = '') => {
    isAuthorized = authorized;
    currentEmail = email;
    loginBtn.textContent = authorized ? `${email} · Выйти` : 'Войти';
    loginBtn.title = authorized ? 'Выйти из аккаунта' : 'Войти в аккаунт';
  };
  const showAuthError = (message) => {
    if (!authErrorEl) return;
    authErrorEl.hidden = false;
    authErrorEl.textContent = message;
  };
  const getValidationMessage = (payload) => {
    const details = Array.isArray(payload?.detail) ? payload.detail : [];
    if (!details.length) return 'Проверьте введенные данные.';
    const first = details[0];
    let message = String(first?.msg || first?.message || 'Проверьте введенные данные.');
    // Pydantic добавляет этот префикс к тексту из ValueError. Пользователю он не нужен.
    const pydanticPrefix = 'Value error, ';
    if (message.startsWith(pydanticPrefix)) {
      message = message.slice(pydanticPrefix.length);
    }
    if (message.toLowerCase().includes('email')) {
      return 'Введите корректный email.';
    }
    return message;
  };
  const getEmailProblem = (email) => {
    const atIndex = email.indexOf('@');
    if (atIndex <= 0) return 'Введите корректный email.';
    const domainPart = email.slice(atIndex + 1);
    if (!domainPart.includes('.')) return 'Введите корректный email.';
    if (domainPart.startsWith('.') || domainPart.endsWith('.')) {
      return 'Введите корректный email.';
    }
    return '';
  };
  const getRegisterPasswordError = (password) => {
    if (password.length < 8) {
      return 'Пароль должен быть не короче 8 символов.';
    }
    if (password.length > 72) {
      return 'Пароль должен быть не длиннее 72 символов.';
    }
    let hasDigit = false;
    for (const character of password) {
      if (character >= '0' && character <= '9') {
        hasDigit = true;
        break;
      }
    }
    if (!hasDigit) {
      return 'Пароль должен содержать хотя бы одну цифру.';
    }
    return '';
  };
  const fetchCurrentUserEmail = async (token) => {
    const response = await fetch(getAuthUrl('/me'), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    return String(data?.email || '').trim();
  };
  const handleLogout = async () => {
    const token = getStoredToken();
    if (token) {
      try {
        await fetch(getAuthUrl('/logout'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        /* ignore network errors on logout */
      }
    }
    clearStoredAuth();
    setAuthUiState(false, '');
  };
  const handleLogin = async () => {
    const email = String(authEmailInput?.value || '').trim().toLowerCase();
    const password = String(authPasswordInput?.value || '');
    if (!email || !password) {
      showAuthError('Введите email и пароль.');
      return false;
    }
    if (authErrorEl) {
      authErrorEl.hidden = true;
      authErrorEl.textContent = '';
    }
    if (authSubmitBtn) authSubmitBtn.disabled = true;
    try {
      const loginResponse = await fetch(getAuthUrl('/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!loginResponse.ok) {
        if (loginResponse.status === 401) {
          throw new Error('Неверный email или пароль.');
        }
        if (loginResponse.status === 429) {
          throw new Error('Слишком много попыток входа. Попробуйте позже.');
        }
        throw new Error(`Ошибка входа: HTTP ${loginResponse.status}`);
      }
      const loginData = await loginResponse.json();
      const token = String(loginData?.access_token || '').trim();
      if (!token) throw new Error('Сервер не вернул токен.');
      const userEmail = await fetchCurrentUserEmail(token);
      if (!userEmail) throw new Error('Не удалось получить профиль пользователя.');
      setStoredAuth(token, userEmail);
      setAuthUiState(true, userEmail);
      if (authPasswordInput) authPasswordInput.value = '';
      closeAuthModal();
      return true;
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : '';
      if (rawMessage === 'Failed to fetch') {
        showAuthError('Нет связи с сервером. Проверьте, что он запущен.');
      } else {
        showAuthError(rawMessage || 'Ошибка входа.');
      }
      return false;
    } finally {
      if (authSubmitBtn) authSubmitBtn.disabled = false;
    }
  };
  const handleRegister = async () => {
    const email = String(authEmailInput?.value || '').trim().toLowerCase();
    const password = String(authPasswordInput?.value || '');
    if (!email || !password) {
      showAuthError('Введите email и пароль.');
      return;
    }
    const emailProblem = getEmailProblem(email);
    if (emailProblem) {
      showAuthError(emailProblem);
      return;
    }
    const passwordError = getRegisterPasswordError(password);
    if (passwordError) {
      showAuthError(passwordError);
      return;
    }
    if (authErrorEl) {
      authErrorEl.hidden = true;
      authErrorEl.textContent = '';
    }
    if (authSubmitBtn) authSubmitBtn.disabled = true;
    try {
      const registerResponse = await fetch(getAuthUrl('/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!registerResponse.ok) {
        if (registerResponse.status === 409) {
          throw new Error('Email уже зарегистрирован.');
        }
        if (registerResponse.status === 422) {
          let payload = null;
          try {
            payload = await registerResponse.json();
          } catch {
            payload = null;
          }
          throw new Error(getValidationMessage(payload));
        }
        throw new Error(`Ошибка регистрации: HTTP ${registerResponse.status}`);
      }
      // Аккаунт уже в базе. Входим теми же данными, чтобы не просить пароль второй раз.
      const loggedIn = await handleLogin();
      if (loggedIn) return;
      const loginErrorText = String(authErrorEl?.textContent || '').trim();
      setAuthMode('login');
      if (loginErrorText) {
        showAuthError(`Аккаунт создан. ${loginErrorText}`);
      } else {
        showAuthError('Аккаунт создан, но войти не удалось. Нажмите «Войти».');
      }
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : '';
      if (rawMessage === 'Failed to fetch') {
        showAuthError('Нет связи с сервером. Проверьте, что он запущен.');
      } else {
        showAuthError(rawMessage || 'Ошибка регистрации.');
      }
    } finally {
      if (authSubmitBtn) authSubmitBtn.disabled = false;
    }
  };
  const bootstrapAuthUi = async () => {
    const token = getStoredToken();
    const cachedEmail = String(window.localStorage.getItem(AUTH_EMAIL_KEY) || '').trim();
    if (!token) {
      setAuthUiState(false, '');
      return;
    }
    if (cachedEmail) {
      setAuthUiState(true, cachedEmail);
    }
    try {
      const userEmail = await fetchCurrentUserEmail(token);
      if (!userEmail) throw new Error('Empty email');
      setStoredAuth(token, userEmail);
      setAuthUiState(true, userEmail);
    } catch {
      clearStoredAuth();
      setAuthUiState(false, '');
    }
  };

  authSubmitBtn?.addEventListener('click', () => {
    if (authMode === 'register') {
      handleRegister();
      return;
    }
    handleLogin();
  });
  authPasswordInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      if (authMode === 'register') {
        handleRegister();
        return;
      }
      handleLogin();
    }
  });
  authRegisterBtn?.addEventListener('click', () => {
    setAuthMode(authMode === 'login' ? 'register' : 'login');
  });
  loginBtn.addEventListener('click', () => {
    if (isAuthorized) {
      handleLogout();
      return;
    }
    openAuthModal();
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'stage-nav-save';
  saveBtn.textContent = 'Сохранить пробу';
  saveBtn.setAttribute('aria-label', 'Сохранить пробу');
  saveBtn.title =
    'Скачать ZIP: session.json (сценарий, блоки, роль, прогресс) и папка audio с записями';
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await downloadSessionBackupZip();
    } catch (e) {
      console.error(e);
      window.alert('Не удалось сохранить архив. Попробуйте ещё раз.');
    } finally {
      saveBtn.disabled = false;
    }
  });

  const loadBtn = document.createElement('button');
  loadBtn.type = 'button';
  loadBtn.className = 'stage-nav-load';
  loadBtn.textContent = 'Загрузить пробу';
  loadBtn.setAttribute('aria-label', 'Загрузить пробу');
  loadBtn.title = 'Восстановить из ZIP (или старого JSON с вложенным audio). Текущие данные будут заменены.';
  loadBtn.addEventListener('click', () => {
    const ok = window.confirm(
      'Заменить текущие данные пробы содержимым файла?\n\n' +
        'Подойдёт архив .zip (session.json + audio/) или одиночный .json из старого экспорта.'
    );
    if (!ok) return;
    pickAndImportSessionBackup({
      onSuccess() {
        window.location.href = resolveLastAvailableHref();
      },
      onError(msg) {
        window.alert(`Не удалось загрузить пробу: ${msg}`);
      },
    });
  });

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'stage-nav-reset';
  resetBtn.textContent = 'Сбросить всё';
  resetBtn.setAttribute('aria-label', 'Сбросить всё');
  resetBtn.title = 'Очистить текст сценария, разбор, роль и все аудиозаписи';
  resetBtn.addEventListener('click', async () => {
    const ok = window.confirm(
      'Удалить все данные этой пробы?\n\n' +
        'Очистятся текст сцены, разбор на блоки, выбранная роль, записи партнёров и ваших реплик. ' +
        'Действие нельзя отменить.'
    );
    if (!ok) return;
    resetBtn.disabled = true;
    try {
      await resetAllAppData();
      window.location.href = './index.html';
    } catch (e) {
      console.error(e);
      resetBtn.disabled = false;
      window.alert('Не удалось выполнить сброс. Попробуйте ещё раз.');
    }
  });

  const helpBtn = document.createElement('button');
  helpBtn.type = 'button';
  helpBtn.className = 'stage-nav-help';
  helpBtn.textContent = '?';
  helpBtn.setAttribute('aria-label', 'Пояснение по кнопкам');
  helpBtn.title = 'Как работают кнопки сохранения и загрузки';

  const helpModal = document.createElement('div');
  helpModal.className = 'stage-nav-help-modal';
  helpModal.setAttribute('aria-hidden', 'true');
  helpModal.innerHTML = `
    <div class="stage-nav-help-modal__panel" role="dialog" aria-modal="true" aria-labelledby="stageNavHelpTitle">
      <div class="stage-nav-help-modal__header">
        <h2 id="stageNavHelpTitle" class="stage-nav-help-modal__title">Как пользоваться кнопками</h2>
        <button type="button" class="stage-nav-help-modal__close" aria-label="Закрыть окно">×</button>
      </div>
      <div class="stage-nav-help-modal__content">
        <p><strong>Сохранить пробу:</strong> сохраняет текущие данные пробы zip-файл, чтобы продолжить позже на этом или другом устройстве.</p>
        <p><strong>Загрузить пробу:</strong> загружает ранее сохранённый zip-файл пробы и заменяет им текущие данные.</p>
        <p><strong>Сбросить всё:</strong> удаляет текущие данные пробы. Используйте, если хотите быстро начать заново.</p>
      </div>
    </div>
  `;

  const closeHelpModal = () => {
    helpModal.classList.remove('is-open');
    helpModal.setAttribute('aria-hidden', 'true');
  };

  helpBtn.addEventListener('click', () => {
    helpModal.classList.add('is-open');
    helpModal.setAttribute('aria-hidden', 'false');
  });

  const helpModalCloseBtn = helpModal.querySelector('.stage-nav-help-modal__close');
  if (helpModalCloseBtn) {
    helpModalCloseBtn.addEventListener('click', closeHelpModal);
  }

  helpModal.addEventListener('click', (event) => {
    if (event.target === helpModal) {
      closeHelpModal();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && helpModal.classList.contains('is-open')) {
      closeHelpModal();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !authModal.hidden) {
      authModal.hidden = true;
    }
  });
  

  row.appendChild(inner);
  row.appendChild(loginBtn);
  row.appendChild(helpBtn);
  row.appendChild(saveBtn);
  row.appendChild(loadBtn);
  row.appendChild(resetBtn);
  nav.appendChild(row);
  nav.appendChild(helpModal);

  nav.classList.add('stage-nav--full')

  const target = opts.prependTo ?? document.querySelector('main');
  if (target) {
    target.insertBefore(nav, target.firstChild);
  } else {
    document.body.insertBefore(nav, document.body.firstChild);
  }
  document.body.appendChild(authModal);
  bootstrapAuthUi();
}
