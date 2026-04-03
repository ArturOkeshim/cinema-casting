import { mountScriptView } from "./app.js";
import { mountBlocksView } from "./blocks.js";
import { mountPrepView } from "./prep.js";
import { mountRehearsalView } from "./rehearsal.js";
import { releaseSharedMic } from "./micSession.js";

const views = {
  home: document.getElementById("viewHome"),
  blocks: document.getElementById("viewBlocks"),
  prep: document.getElementById("viewPrep"),
  rehearsal: document.getElementById("viewRehearsal"),
};

function showView(name) {
  Object.entries(views).forEach(([key, el]) => {
    if (!el) return;
    el.classList.toggle("is-active", key === name);
  });
}

function navigateToPrep() {
  showView("prep");
  mountPrepView({
    onAfterSave: async () => {
      showView("rehearsal");
      await mountRehearsalView({
        onNavigateHome: () => {
          releaseSharedMic();
          showView("home");
        },
        onNavigateBlocks: () => {
          releaseSharedMic();
          showView("blocks");
          mountBlocksView({ onNavigateToPrep: navigateToPrep });
        },
      });
    },
    onBackToBlocks: () => {
      releaseSharedMic();
      showView("blocks");
      mountBlocksView({ onNavigateToPrep: navigateToPrep });
    },
  });
}

document.getElementById("spaBlocksBack")?.addEventListener("click", (e) => {
  e.preventDefault();
  releaseSharedMic();
  showView("home");
});

document.getElementById("spaPrepBack")?.addEventListener("click", (e) => {
  e.preventDefault();
  releaseSharedMic();
  showView("blocks");
  mountBlocksView({ onNavigateToPrep: navigateToPrep });
});

showView("home");

mountScriptView({
  onProcessed: () => {
    showView("blocks");
    mountBlocksView({ onNavigateToPrep: navigateToPrep });
  },
});
