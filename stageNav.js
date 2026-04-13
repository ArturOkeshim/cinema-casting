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
        background: rgba(11, 16, 32, 0.94);
        border-bottom: 1px solid #2a355f;
        backdrop-filter: blur(8px);
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
      .stage-nav-load {
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
      .stage-nav-load:hover {
        background: rgba(79, 124, 255, 0.22);
        border-color: #4f7cff;
        color: #fff;
      }
      .stage-nav-save:disabled,
      .stage-nav-load:disabled {
        opacity: 0.5;
        cursor: not-allowed;
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
        .stage-nav-reset {
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
        .stage-nav-reset::before {
          font-size: 16px;
        }
        .stage-nav-save::before {
          content: "💾";
        }
        .stage-nav-load::before {
          content: "📂";
        }
        .stage-nav-reset::before {
          content: "🗑";
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

  

  row.appendChild(inner);
  row.appendChild(saveBtn);
  row.appendChild(loadBtn);
  row.appendChild(resetBtn);
  nav.appendChild(row);

  nav.classList.add('stage-nav--full')

  const target = opts.prependTo ?? document.querySelector('main');
  if (target) {
    target.insertBefore(nav, target.firstChild);
  } else {
    document.body.insertBefore(nav, document.body.firstChild);
  }
}
