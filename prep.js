const BLOCKS_STORAGE_KEY = "cinemaCasting.roleBlocks";
const SELECTED_ROLE_KEY = "cinemaCasting.selectedRole";

const segmentsContainer = document.getElementById("segmentsContainer");
const actorRoleLabel = document.getElementById("actorRoleLabel");
const proceedBtn = document.getElementById("proceedBtn");
const progressLabel = document.getElementById("progressLabel");

// Map<segmentId, { blob: Blob, url: string, source: 'recorded' | 'uploaded' }>
const audioStore = new Map();

// Active MediaRecorder instance.
let activeRecorder = null;

function readSession() {
  try {
    const blocks = JSON.parse(sessionStorage.getItem(BLOCKS_STORAGE_KEY) || "[]");
    const role = sessionStorage.getItem(SELECTED_ROLE_KEY) || "";
    return { blocks: Array.isArray(blocks) ? blocks : [], role };
  } catch {
    return { blocks: [], role: "" };
  }
}

function extractSpeakableText(text) {
  return text.replace(/\[\[.*?\]\]/g, "").replace(/\s+/g, " ").trim();
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInlineAnnotations(text) {
  return escapeHtml(text).replace(
    /\[\[(.*?)\]\]/g,
    '<span class="inline-annotation">[$1]</span>'
  );
}

// Groups consecutive non-actor dialogue blocks between actor turns into segments.
function buildSegments(blocks, actorRole) {
  const segments = [];
  let currentLines = [];

  for (const block of blocks) {
    if (block.role === "annotation") continue;

    if (block.role === actorRole) {
      if (currentLines.length > 0) {
        segments.push({ id: segments.length, lines: [...currentLines] });
        currentLines = [];
      }
    } else {
      currentLines.push(block);
    }
  }

  if (currentLines.length > 0) {
    segments.push({ id: segments.length, lines: [...currentLines] });
  }

  return segments;
}

function updateProgress(total) {
  const ready = audioStore.size;
  progressLabel.textContent = `Записано: ${ready} из ${total}`;
  proceedBtn.disabled = ready < total;
}

function setSegmentReady(segmentId, total) {
  const header = document.querySelector(`.segment[data-id="${segmentId}"] .segment-status`);
  if (header) {
    header.textContent = "Готово ✓";
    header.className = "segment-status ready";
  }
  updateProgress(total);
}

function storeAudio(segmentId, blob, source, total) {
  const prev = audioStore.get(segmentId);
  if (prev?.url) URL.revokeObjectURL(prev.url);
  const url = URL.createObjectURL(blob);
  audioStore.set(segmentId, { blob, url, source });
  setSegmentReady(segmentId, total);
  return url;
}

function renderAudioPlayer(segmentId, url, source, controlsEl, total) {
  const label = source === "uploaded" ? '<span class="file-name">Файл загружен</span>' : "";
  controlsEl.innerHTML = `
    <div class="audio-player">
      ${label}
      <audio controls src="${url}"></audio>
      <button class="btn btn-rerecord" data-rerecord="${segmentId}">Перезаписать</button>
    </div>
  `;
  controlsEl.querySelector("[data-rerecord]").addEventListener("click", () => {
    renderRecordControls(segmentId, controlsEl, total);
  });
}

async function startRecording(segmentId, controlsEl, total) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    alert("Нет доступа к микрофону. Разреши доступ и попробуй снова.");
    return;
  }

  const recorder = new MediaRecorder(stream);
  activeRecorder = recorder;
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    activeRecorder = null;
    const blob = new Blob(chunks, { type: "audio/webm" });
    const url = storeAudio(segmentId, blob, "recorded", total);
    renderAudioPlayer(segmentId, url, "recorded", controlsEl, total);
  };

  recorder.start();

  const recordBtn = controlsEl.querySelector("[data-record]");
  if (recordBtn) {
    recordBtn.textContent = "● Запись...";
    recordBtn.classList.add("recording");
    recordBtn.disabled = true;
  }

  const stopBtn = document.createElement("button");
  stopBtn.className = "btn btn-stop";
  stopBtn.textContent = "Стоп";
  stopBtn.addEventListener("click", () => recorder.stop());
  controlsEl.appendChild(stopBtn);
}

function renderRecordControls(segmentId, controlsEl, total) {
  controlsEl.innerHTML = `
    <button class="btn btn-record" data-record="${segmentId}">🎙 Записать</button>
    <label class="upload-label">
      Загрузить файл
      <input class="upload-input" type="file" accept="audio/*" data-upload="${segmentId}">
    </label>
  `;

  controlsEl.querySelector("[data-record]").addEventListener("click", () => {
    startRecording(segmentId, controlsEl, total);
  });

  controlsEl.querySelector("[data-upload]").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = storeAudio(segmentId, file, "uploaded", total);
    renderAudioPlayer(segmentId, url, "uploaded", controlsEl, total);
  });
}

function renderSegments(segments) {
  if (segments.length === 0) {
    segmentsContainer.innerHTML = `<div class="empty">Для выбранной роли нет партнёрских реплик — все реплики сцены твои.</div>`;
    proceedBtn.disabled = false;
    progressLabel.textContent = "";
    return;
  }

  updateProgress(segments.length);

  const html = segments
    .map(
      (seg) => `
      <div class="segment" data-id="${seg.id}">
        <div class="segment-header">
          <span class="segment-number">Сегмент ${seg.id + 1} · ${seg.lines.length} ${seg.lines.length === 1 ? "реплика" : "реплики"}</span>
          <span class="segment-status pending">Ожидает записи</span>
        </div>
        <div class="lines">
          ${seg.lines
            .map(
              (line) => `
            <div class="line-row">
              <span class="line-role">${escapeHtml(line.role)}</span>
              <span class="line-text">${renderInlineAnnotations(line.text)}</span>
            </div>
          `
            )
            .join("")}
        </div>
        <div class="controls" id="controls-${seg.id}"></div>
      </div>
    `
    )
    .join("");

  segmentsContainer.innerHTML = html;

  for (const seg of segments) {
    const controlsEl = document.getElementById(`controls-${seg.id}`);
    renderRecordControls(seg.id, controlsEl, segments.length);
  }
}

const { blocks, role } = readSession();

if (!role) {
  segmentsContainer.innerHTML = `<div class="empty">Роль не выбрана. <a href="./blocks.html" style="color:#9fc0ff">Вернись назад</a> и выбери роль.</div>`;
} else {
  actorRoleLabel.innerHTML = `<span class="actor-role">Ты читаешь за: ${escapeHtml(role)}</span>`;
  const segments = buildSegments(blocks, role);
  renderSegments(segments);
}
