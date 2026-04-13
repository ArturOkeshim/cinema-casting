import { initStageNav } from "./stageNav.js";
import { saveBlocks, saveScriptText, loadScriptText, clearRehearsalCursor, saveRole, savePartnerAudioReady } from "./flowState.js";
import { clearAllSessionAudio } from "./audioDb.js";

const scriptInput = document.getElementById("scriptInput");
const processBtn = document.getElementById("processBtn");
const status = document.getElementById("status");
const loadingScreen = document.getElementById("loadingScreen");

initStageNav("script");

const savedScript = loadScriptText();
if (savedScript) {
  scriptInput.value = savedScript;
}

let scriptPersistTimer = null;
scriptInput.addEventListener("input", () => {
  if (scriptPersistTimer) clearTimeout(scriptPersistTimer);
  scriptPersistTimer = setTimeout(() => saveScriptText(scriptInput.value), 400);
});
window.addEventListener("beforeunload", () => saveScriptText(scriptInput.value));

function setStatus(text) {
  if (!status) {
    console.info("[status]", text);
    return;
  }
  status.textContent = text;
}

function showLoadingOverlay() {
  if (!loadingScreen) return;
  loadingScreen.classList.add("is-visible");
  loadingScreen.setAttribute("aria-hidden", "false");
}

function hideLoadingOverlay() {
  if (!loadingScreen) return;
  loadingScreen.classList.remove("is-visible");
  loadingScreen.setAttribute("aria-hidden", "true");
}

function buildPrompt(sceneText) {
  return [
    "Ты помощник для разбора текста кинопроб.",
    "Твоя задача: разбить сцену на последовательные блоки в порядке исходного текста.",
    "Верни ТОЛЬКО JSON-массив, без markdown, без пояснений, без дополнительного текста.",
    "Каждый элемент массива — один из двух типов:",
    "",
    "1) Реплика актёра:",
    '   {"role":"Имя персонажа","text":"Текст реплики"}',
    "   — используй для всего, что персонаж произносит вслух.",
    "   — если роль не указана явно, используй role='Неизвестно'.",
    "   — ремарки в скобках внутри реплики (шутит), (Обращается к X), (кивает) и т.п. —",
    "     оставляй в тексте реплики, но оборачивай двойными квадратными скобками: [[шутит]]",
    "     Пример: '[[шутит]] Так вам точно не поверит.'",
    "     Пример: '[[Обращается к МАРИНЕ]] А тот который с вами сидел случайно не ваш?'",
    "     Важно: [[...]] ставь только вокруг ремарок/указаний, но НЕ вокруг слов, которые актёр произносит.",
    "",
    "2) Аннотация (ремарка, описание действия, заголовок сцены):",
    '   {"role":"annotation","text":"Текст ремарки или описания"}',
    "   — используй для всего, что НЕ является прямой репликой: действия персонажей,",
    "     описания обстановки, заголовки сцен, авторские ремарки.",
    "",
    "Правила:",
    "1) Сохраняй исходный порядок блоков.",
    "2) Не объединяй реплики одной роли из разных мест сцены.",
    "3) Не меняй формулировки, только нормализуй лишние пробелы.",
    "",
    "Пример (вход):",
    "1.1 НАТ. УЛИЦА. ДЕНЬ",
    "Алексей идёт по улице и видит Петруху.",
    "АЛЕКСЕЙ",
    "Привет!",
    "ПЕТРУХА",
    "(удивлённо)",
    "Привет, брат! Сколько лет не виделись.",
    "АЛЕКСЕЙ",
    "(Обращается к прохожему)",
    "Не верите? Мы в школе дружили!",
    "Они обнимаются.",
    "",
    "Пример (выход):",
    '[{"role":"annotation","text":"1.1 НАТ. УЛИЦА. ДЕНЬ"},{"role":"annotation","text":"Алексей идёт по улице и видит Петруху."},{"role":"Алексей","text":"Привет!"},{"role":"Петруха","text":"[[удивлённо]] Привет, брат! Сколько лет не виделись."},{"role":"Алексей","text":"[[Обращается к прохожему]] Не верите? Мы в школе дружили!"},{"role":"annotation","text":"Они обнимаются."}]',
    "",
    "Теперь обработай этот текст:",
    sceneText,
  ].join("\n");
}

function stripMarkdownCodeFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  return trimmed
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
}

function extractJsonArrayText(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return text.trim();
  }
  return text.slice(start, end + 1).trim();
}

function repairLikelyJson(text) {
  const normalized = text
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\r\n/g, "\n")
    .trim();

  let out = "";
  let inString = false;
  let escaping = false;

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];

    if (!inString) {
      if (ch === '"') {
        inString = true;
      }
      out += ch;
      continue;
    }

    // Inside JSON string value/key.
    if (escaping) {
      out += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      out += ch;
      escaping = true;
      continue;
    }

    if (ch === "\n") {
      // Raw newline is invalid inside JSON strings.
      out += "\\n";
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < normalized.length && /\s/.test(normalized[j])) {
        j += 1;
      }
      const next = normalized[j] || "";

      // Valid closing quote only before JSON separators.
      if (next === "," || next === "}" || next === "]" || next === ":") {
        inString = false;
        out += ch;
      } else {
        // Likely unescaped quote inside phrase.
        out += '\\"';
      }
      continue;
    }

    out += ch;
  }

  if (inString) {
    out += '"';
  }

  // Remove trailing commas before closing brace/bracket.
  return out.replace(/,\s*([}\]])/g, "$1");
}

function parseJsonWithRecovery(rawOutput) {
  const text = extractJsonArrayText(stripMarkdownCodeFence(rawOutput));
  try {
    return JSON.parse(text);
  } catch {
    const repaired = repairLikelyJson(text);
    return JSON.parse(repaired);
  }
}

function parseRoleBlocks(rawOutput) {
  const parsed = parseJsonWithRecovery(rawOutput);

  if (!Array.isArray(parsed)) {
    throw new Error("LLM вернул не JSON-массив блоков.");
  }

  const cleaned = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const role = typeof item.role === "string" ? item.role.trim() : "";
    const text = typeof item.text === "string" ? item.text.trim() : "";

    if (!role || !text) {
      continue;
    }

    cleaned.push({ role, text });
  }

  if (cleaned.length === 0) {
    throw new Error("В JSON нет валидных блоков формата {role, text}.");
  }

  return cleaned;
}

async function callLLM(userPrompt) {
  const response = await fetch("/api/llm", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: userPrompt }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const apiError = data?.error || data?.message || "Ошибка вызова LLM API.";
    throw new Error(`LLM API error (${response.status}): ${apiError}`);
  }

  const content = data?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("LLM вернул пустой ответ.");
  }

  return content;
}

async function requestRoleSplit({ sceneText }) {
  const prompt = buildPrompt(sceneText);
  const rawOutput = await callLLM(prompt);
  return parseRoleBlocks(rawOutput);
}

async function processScriptText(sceneText) {
  const blocks = await requestRoleSplit({ sceneText });
  await clearAllSessionAudio();
  clearRehearsalCursor();
  savePartnerAudioReady(false);
  saveRole("");
  saveBlocks(blocks);
  console.log("Role blocks:", blocks);
  return blocks;
}

processBtn.addEventListener("click", async () => {
  const text = scriptInput.value.trim();
  if (!text) {
    setStatus("Добавь текст перед обработкой.");
    scriptInput.focus();
    return;
  }

  processBtn.disabled = true;
  setStatus("Обрабатываем текст...");
  showLoadingOverlay();

  try {
    saveScriptText(text);
    const blocks = await processScriptText(text);
    setStatus(`Готово: найдено блоков — ${blocks.length}.`);
    window.location.href = "./blocks.html";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Неизвестная ошибка.";
    setStatus(`Ошибка: ${message}`);
    console.error(error);
  } finally {
    hideLoadingOverlay();
    processBtn.disabled = false;
  }
});
