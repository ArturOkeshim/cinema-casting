const BLOCKS_STORAGE_KEY = "cinemaCasting.roleBlocks";
const SELECTED_ROLE_KEY = "cinemaCasting.selectedRole";
const container = document.getElementById("blocksContainer");
const rolePicker = document.getElementById("rolePicker");
const roleChips = document.getElementById("roleChips");
const confirmRoleBtn = document.getElementById("confirmRoleBtn");

let selectedRole = null;

function renderEmpty(message) {
  container.innerHTML = `<div class="empty">${message}</div>`;
}

function readBlocksFromSession() {
  const raw = sessionStorage.getItem(BLOCKS_STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item) => item && typeof item.role === "string" && typeof item.text === "string");
  } catch {
    return [];
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Extracts only the speakable text (strips [[...]] and [...] markers).
export function extractSpeakableText(text) {
  return text
    .replace(/\[\[.*?\]\]/g, "")
    .replace(/\[(?!\[).*?\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Renders [[...]] markers as greyed-out inline spans.
function renderInlineAnnotations(text) {
  return escapeHtml(text).replace(
    /\[\[(.*?)\]\]/g,
    '<span class="inline-annotation">[$1]</span>'
  );
}

function getUniqueRoles(blocks) {
  const seen = new Set();
  return blocks
    .map((b) => b.role)
    .filter((r) => r !== "annotation" && !seen.has(r) && seen.add(r));
}

function applyRoleHighlight(role) {
  const articleBlocks = container.querySelectorAll(".block");
  articleBlocks.forEach((el) => {
    const blockRole = el.querySelector(".role")?.textContent;
    if (!role) {
      el.classList.remove("mine", "dimmed");
    } else if (blockRole === role) {
      el.classList.add("mine");
      el.classList.remove("dimmed");
    } else {
      el.classList.add("dimmed");
      el.classList.remove("mine");
    }
  });
}

function renderRolePicker(roles) {
  if (roles.length === 0) {
    return;
  }

  roleChips.innerHTML = roles
    .map((r) => `<button class="chip" data-role="${escapeHtml(r)}">${escapeHtml(r)}</button>`)
    .join("");

  roleChips.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) {
      return;
    }

    const role = btn.dataset.role;

    if (selectedRole === role) {
      selectedRole = null;
      btn.classList.remove("active");
    } else {
      selectedRole = role;
      roleChips.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
    }

    applyRoleHighlight(selectedRole);
    confirmRoleBtn.hidden = !selectedRole;
  });

  confirmRoleBtn.addEventListener("click", () => {
    if (!selectedRole) return;
    sessionStorage.setItem(SELECTED_ROLE_KEY, selectedRole);
    window.location.href = "./prep.html";
  });

  rolePicker.hidden = false;
}

function renderBlocks(blocks) {
  if (blocks.length === 0) {
    renderEmpty("Нет данных для отображения. Вернись на страницу ввода и нажми 'Обработать'.");
    return;
  }

  const html = blocks
    .map((block, idx) => {
      if (block.role === "annotation") {
        return `<p class="annotation" data-index="${idx}">${escapeHtml(block.text)}</p>`;
      }
      return `
        <article class="block" data-index="${idx}" data-role="${escapeHtml(block.role)}">
          <h2 class="role">${escapeHtml(block.role)}</h2>
          <p class="text">${renderInlineAnnotations(block.text)}</p>
        </article>
      `;
    })
    .join("");

  container.innerHTML = html;
}

const blocks = readBlocksFromSession();
renderBlocks(blocks);
renderRolePicker(getUniqueRoles(blocks));
