import { resetAllAppData } from './resetAll.js';
import { downloadSessionBackupZip, pickAndImportSessionBackup } from './sessionBackup.js';

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

  for (const s of stages) {
    const a = document.createElement('a');
    a.href = s.href;
    a.textContent = s.label;
    if (s.id === current) {
      a.classList.add('current');
      a.setAttribute('aria-current', 'step');
    }
    inner.appendChild(a);
  }

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'stage-nav-save';
  saveBtn.textContent = 'Сохранить пробу';
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

  const target = opts.prependTo ?? document.querySelector('main');
  if (target) {
    target.insertBefore(nav, target.firstChild);
  } else {
    document.body.insertBefore(nav, document.body.firstChild);
  }
}
