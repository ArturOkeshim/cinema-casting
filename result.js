import { initStageNav } from './stageNav.js';
import { loadBlocks, loadRole, loadRehearsalCursor } from './flowState.js';
import { getPartnerAudio, getActorRecording } from './audioDb.js';
import { buildSequence, extractSpeakable, escapeHtml } from './rehearsalSequence.js';

initStageNav('result');

const playAllBtn = document.getElementById('playAllBtn');
const resultListEl = document.getElementById('resultList');

document.querySelector('.result-footer')?.addEventListener('click', (e) => {
  if (e.target.closest('#rehearseAgainBtn')) {
    e.preventDefault();
    window.location.assign('./rehearsal.html');
    return;
  }
  if (e.target.closest('#rerecordPartnersBtn')) {
    e.preventDefault();
    window.location.href = './prep.html';
  }
});

async function init() {
  const blocks = loadBlocks();
  const role = loadRole();

  if (!role || !blocks.length) {
    playAllBtn.hidden = true;
    resultListEl.innerHTML =
      '<p class="result-empty">Данные не найдены. <a href="./index.html" style="color:#9fc0ff">Начни заново</a></p>';
    return;
  }

  const sequence = buildSequence(blocks, role);
  if (!sequence.length) {
    playAllBtn.hidden = true;
    resultListEl.innerHTML = '<p class="result-empty">В сцене нет реплик.</p>';
    return;
  }

  const cursor = loadRehearsalCursor();
  if (cursor < sequence.length) {
    playAllBtn.hidden = true;
    resultListEl.innerHTML =
      '<p class="result-empty">Репетиция ещё не завершена. <a href="./rehearsal.html" style="color:#9fc0ff">Продолжить репетицию</a></p>';
    return;
  }

  const items = [];
  for (let i = 0; i < sequence.length; i++) {
    const step = sequence[i];
    if (step.type === 'partner') {
      const blob = await getPartnerAudio(step.segId);
      if (blob) {
        const label = step.lines
          .map((l) => `${l.role}: ${extractSpeakable(l.text).slice(0, 40)}`)
          .join(' / ');
        items.push({ blob, label, type: 'partner' });
      }
    } else {
      const blob = await getActorRecording(i);
      if (blob && blob.size > 0) {
        items.push({
          blob,
          label: `${step.line.role}: ${extractSpeakable(step.line.text).slice(0, 50)}`,
          type: 'actor',
        });
      }
    }
  }

  if (!items.length) {
    playAllBtn.hidden = true;
    resultListEl.innerHTML =
      '<p class="result-empty">Нет аудио для воспроизведения. <a href="./rehearsal.html" style="color:#9fc0ff">Записать пробы</a></p>';
    return;
  }

  const urls = items.map((item) => URL.createObjectURL(item.blob));

  resultListEl.innerHTML = items
    .map(
      (item, idx) => `
      <div class="result-item result-item--${item.type}">
        <span class="result-label">${escapeHtml(item.label)}</span>
        <audio controls src="${urls[idx]}"></audio>
      </div>`
    )
    .join('');

  const audios = [...resultListEl.querySelectorAll('audio')];

  audios.forEach((audio, idx) => {
    audio.onended = () => {
      if (idx + 1 < audios.length) audios[idx + 1].play();
    };
  });

  playAllBtn.onclick = () => {
    audios.forEach((a) => {
      a.pause();
      a.currentTime = 0;
    });
    if (audios.length > 0) audios[0].play();
  };
}

init();
