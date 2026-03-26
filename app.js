const scriptInput = document.getElementById("scriptInput");
const processBtn = document.getElementById("processBtn");
const status = document.getElementById("status");

const runtimeConfig = window.APP_CONFIG || {};

const LLM_CONFIG = {
  apiKey: runtimeConfig.VSEGPT_API_KEY || "",
  baseUrl: runtimeConfig.VSEGPT_BASE_URL || "https://api.vsegpt.ru/v1",
  model: runtimeConfig.VSEGPT_MODEL || "anthropic/claude-3-haiku",
  temperature: Number(runtimeConfig.VSEGPT_TEMPERATURE ?? 0.2),
  maxTokens: Number(runtimeConfig.VSEGPT_MAX_TOKENS ?? 3000),
  appTitle: runtimeConfig.APP_TITLE || "Cinema Casting",
};

function setStatus(text) {
  status.textContent = text;
}

function buildPrompt(sceneText) {
  return [
    "Ты помощник для разбора текста кинопроб.",
    "Раздели входной текст на роли.",
    "Верни только JSON-объект без пояснений и без markdown.",
    "Формат строго такой:",
    '{"Роль 1":"текст реплик роли 1","Роль 2":"текст реплик роли 2"}',
    "Если роль одна, верни один ключ.",
    "Сохраняй исходный язык и формулировки.",
    "",
    "Текст для разбора:",
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

function parseRoleMap(rawOutput) {
  const jsonText = stripMarkdownCodeFence(rawOutput);
  const parsed = JSON.parse(jsonText);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM вернул не JSON-объект.");
  }

  const cleaned = {};
  for (const [role, roleText] of Object.entries(parsed)) {
    if (typeof role !== "string" || !role.trim()) {
      continue;
    }
    if (typeof roleText !== "string") {
      continue;
    }
    cleaned[role.trim()] = roleText.trim();
  }

  if (Object.keys(cleaned).length === 0) {
    throw new Error("В JSON нет валидных пар роль -> текст.");
  }

  return cleaned;
}

async function callLLM(userPrompt) {
  if (!LLM_CONFIG.apiKey) {
    throw new Error("Не найден VSEGPT_API_KEY. Сгенерируй public-config.js из .env.");
  }

  const url = `${LLM_CONFIG.baseUrl}/chat/completions`;
  const body = {
    model: LLM_CONFIG.model,
    messages: [{ role: "user", content: userPrompt }],
    temperature: LLM_CONFIG.temperature,
    n: 1,
    max_tokens: LLM_CONFIG.maxTokens,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_CONFIG.apiKey}`,
      "X-Title": LLM_CONFIG.appTitle,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const apiError = data?.error?.message || data?.message || "Ошибка вызова LLM API.";
    throw new Error(`LLM API error (${response.status}): ${apiError}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("LLM вернул пустой ответ.");
  }

  return content;
}

async function requestRoleSplit({ sceneText }) {
  const prompt = buildPrompt(sceneText);
  const rawOutput = await callLLM(prompt);
  return parseRoleMap(rawOutput);
}

async function processScriptText(sceneText) {
  const roleMap = await requestRoleSplit({ sceneText });

  // Здесь будет следующий шаг пайплайна (UI, сохранение, настройка ролей и т.д.).
  console.log("Role map:", roleMap);
  return roleMap;
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

  try {
    const roleMap = await processScriptText(text);
    setStatus(`Готово: найдено ролей — ${Object.keys(roleMap).length}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Неизвестная ошибка.";
    setStatus(`Ошибка: ${message}`);
    console.error(error);
  } finally {
    processBtn.disabled = false;
  }
});
