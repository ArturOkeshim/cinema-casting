import { initStageNav } from "./stageNav.js";
import { loadBlocks, saveBlocks, saveRole, loadRole, clearRehearsalCursor, savePartnerAudioReady } from "./flowState.js";
import { clearActorClips, clearPartnerClips } from "./audioDb.js";

initStageNav("role");

const container = document.getElementById("blocksContainer");
const rolePicker = document.getElementById("rolePicker");
const roleChips = document.getElementById("roleChips");
const confirmRoleBtn = document.getElementById("confirmRoleBtn");

let blocksState = [];
let selectedRole = null;
let rolePickerBound = false;

function readBlocksFromStorage() {
  return loadBlocks().filter(
    (item) => item && typeof item.role === "string" && typeof item.text === "string"
  );
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function extractSpeakableText(text) {
  return text
    .replace(/\[\[.*?\]\]/g, "")
    .replace(/\[(?!\[).*?\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

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

function persistBlocks() {
  saveBlocks(blocksState);
}

function renderViewBlock(block, idx) {
  if (block.role === "annotation") {
    return `
      <div class="block block--annotation" data-index="${idx}">
        <div class="block-actions">
          <button type="button" class="block-edit-btn" data-action="edit">Изменить</button>
        </div>
        <p class="annotation" data-index="${idx}">${renderInlineAnnotations(block.text)}</p>
      </div>`;
  }
  return `
    <article class="block" data-index="${idx}" data-role="${escapeHtml(block.role)}">
      <div class="block-actions">
        <button type="button" class="block-edit-btn" data-action="edit">Изменить</button>
      </div>
      <h2 class="role">${escapeHtml(block.role)}</h2>
      <p class="text">${renderInlineAnnotations(block.text)}</p>
    </article>`;
}

function renderEditForm(block, idx) {
  if (block.role === "annotation") {
    return `
      <div class="block block--annotation block--editing" data-index="${idx}">
        <form class="block-edit-form" data-index="${idx}">
          <label>Текст ремарки / описания
            <textarea class="block-text-input" name="text" rows="5" required>${escapeHtml(block.text)}</textarea>
          </label>
          <div class="block-edit-actions">
            <button type="submit" class="block-save-btn">Сохранить</button>
            <button type="button" class="block-cancel-btn" data-action="cancel">Отмена</button>
          </div>
        </form>
      </div>`;
  }
  return `
    <article class="block block--editing" data-index="${idx}">
      <form class="block-edit-form" data-index="${idx}">
        <label>Роль
          <input class="block-role-input" name="role" type="text" value="${escapeHtml(block.role)}" required />
        </label>
        <label>Текст
          <textarea class="block-text-input" name="text" rows="6" required>${escapeHtml(block.text)}</textarea>
        </label>
        <div class="block-edit-actions">
          <button type="submit" class="block-save-btn">Сохранить</button>
          <button type="button" class="block-cancel-btn" data-action="cancel">Отмена</button>
        </div>
      </form>
    </article>`;
}

/** @param {number | null} editingIndex */
function renderBlockList(editingIndex = null) {
  if (blocksState.length === 0) {
    container.innerHTML =
      '<div class="empty">Нет данных для отображения. Вернись на страницу ввода и нажми «Обработать».</div>';
    return;
  }
  container.innerHTML = blocksState
    .map((block, idx) =>
      editingIndex === idx ? renderEditForm(block, idx) : renderViewBlock(block, idx)
    )
    .join("");
}

function syncRoleChips(roles) {
  if (roles.length === 0) {
    rolePicker.hidden = true;
    return;
  }

  roleChips.innerHTML = roles
    .map((r) => `<button type="button" class="chip" data-role="${escapeHtml(r)}">${escapeHtml(r)}</button>`)
    .join("");

  if (selectedRole && roles.includes(selectedRole)) {
    roleChips.querySelectorAll(".chip").forEach((c) => {
      c.classList.toggle("active", c.dataset.role === selectedRole);
    });
    confirmRoleBtn.hidden = false;
  } else {
    selectedRole = null;
    confirmRoleBtn.hidden = true;
  }

  applyRoleHighlight(selectedRole);
  rolePicker.hidden = false;
}

function bindRolePicker() {
  if (rolePickerBound) return;
  rolePickerBound = true;

  roleChips.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;

    const role = btn.dataset.role;
    if (!role) return;

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

  confirmRoleBtn.addEventListener("click", async () => {
    if (!selectedRole) return;
    const prev = loadRole();
    if (prev && prev !== selectedRole) {
      await clearActorClips();
      await clearPartnerClips();
    }
    clearRehearsalCursor();
    savePartnerAudioReady(false);
    saveRole(selectedRole);
    window.location.href = "./prep.html";
  });
}

function saveBlockFromForm(idx, form) {
  const block = blocksState[idx];
  if (!block) return;

  const fd = new FormData(form);
  const text = String(fd.get("text") ?? "").trim();

  if (block.role === "annotation") {
    blocksState[idx] = { role: "annotation", text };
  } else {
    const role = String(fd.get("role") ?? "").trim();
    if (!role) {
      window.alert("Укажите имя роли.");
      return;
    }
    blocksState[idx] = { role, text };
  }

  persistBlocks();
  renderBlockList(null);
  syncRoleChips(getUniqueRoles(blocksState));
}

let editingIndex = null;

container.addEventListener("click", (e) => {
  const cancel = e.target.closest(".block-cancel-btn");
  if (cancel) {
    e.preventDefault();
    editingIndex = null;
    renderBlockList(null);
    syncRoleChips(getUniqueRoles(blocksState));
    return;
  }

  const edit = e.target.closest(".block-edit-btn");
  if (edit && edit.dataset.action === "edit") {
    const wrap = edit.closest("[data-index]");
    if (!wrap) return;
    editingIndex = Number(wrap.dataset.index);
    if (!Number.isFinite(editingIndex)) return;
    renderBlockList(editingIndex);
    const ta = container.querySelector(".block-text-input");
    if (ta) ta.focus();
    return;
  }
});

container.addEventListener("submit", (e) => {
  const form = e.target.closest(".block-edit-form");
  if (!form) return;
  e.preventDefault();
  const idx = Number(form.dataset.index);
  if (!Number.isFinite(idx)) return;
  saveBlockFromForm(idx, form);
  editingIndex = null;
});

function init() {
  blocksState = readBlocksFromStorage();
  renderBlockList(null);

  const roles = getUniqueRoles(blocksState);
  bindRolePicker();
  syncRoleChips(roles);

  const savedRole = loadRole();
  if (savedRole && roles.includes(savedRole)) {
    selectedRole = savedRole;
    roleChips.querySelectorAll(".chip").forEach((c) => {
      if (c.dataset.role === savedRole) c.classList.add("active");
    });
    applyRoleHighlight(selectedRole);
    confirmRoleBtn.hidden = false;
  }
}

init();
