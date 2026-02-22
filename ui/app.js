const state = {
  boards: [],
  filteredBoards: [],
  selectedBoard: null,
  cards: [],
  selectedCardId: null,
  currentMarkdown: "",
  currentPacket: null,
};

const els = {
  refreshBoardsBtn: document.getElementById("refreshBoardsBtn"),
  copyMdBtn: document.getElementById("copyMdBtn"),
  boardSearch: document.getElementById("boardSearch"),
  boardsList: document.getElementById("boardsList"),
  identity: document.getElementById("identity"),
  cardLimit: document.getElementById("cardLimit"),
  loadCardsBtn: document.getElementById("loadCardsBtn"),
  selectedBoardMeta: document.getElementById("selectedBoardMeta"),
  cardsList: document.getElementById("cardsList"),
  cardBadge: document.getElementById("cardBadge"),
  viewerState: document.getElementById("viewerState"),
  markdownView: document.getElementById("markdownView"),
  renderedView: document.getElementById("renderedView"),
  jsonView: document.getElementById("jsonView"),
  tabs: Array.from(document.querySelectorAll(".tab")),
  boardItemTpl: document.getElementById("boardItemTpl"),
  cardItemTpl: document.getElementById("cardItemTpl"),
};

function fmtDate(value) {
  if (!value) return "n/a";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

async function apiGet(path) {
  const res = await fetch(path, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

function setViewerState(text, isMuted = true) {
  els.viewerState.textContent = text;
  els.viewerState.classList.toggle("muted", isMuted);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMarkdownPreview(markdown) {
  const lines = String(markdown || "").split("\n");
  const html = [];
  let listOpen = false;

  const closeList = () => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      continue;
    }

    const imageMatch = trimmed.match(/^!\[(.*?)\]\((.*?)\)$/);
    if (imageMatch) {
      closeList();
      const alt = escapeHtml(imageMatch[1] || "image");
      const src = escapeHtml(imageMatch[2] || "");
      html.push(
        `<figure><img loading="lazy" src="${src}" alt="${alt}" /><figcaption>${alt}</figcaption></figure>`,
      );
      continue;
    }

    if (trimmed.startsWith("# ")) {
      closeList();
      html.push(`<h1>${escapeHtml(trimmed.slice(2))}</h1>`);
      continue;
    }
    if (trimmed.startsWith("## ")) {
      closeList();
      html.push(`<h2>${escapeHtml(trimmed.slice(3))}</h2>`);
      continue;
    }
    if (trimmed.startsWith("### ")) {
      closeList();
      html.push(`<h3>${escapeHtml(trimmed.slice(4))}</h3>`);
      continue;
    }

    if (trimmed.startsWith("- ")) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${escapeHtml(trimmed.slice(2))}</li>`);
      continue;
    }

    closeList();
    if (trimmed === "_No attachments_" || trimmed === "_No comments_" || trimmed === "_No image assets_") {
      html.push(`<p class="md-muted">${escapeHtml(trimmed)}</p>`);
    } else if (trimmed.startsWith("[http") || trimmed.startsWith("[20")) {
      html.push(`<p class="md-line">${escapeHtml(line)}</p>`);
    } else if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const safe = escapeHtml(trimmed);
      html.push(`<p><a href="${safe}" target="_blank" rel="noreferrer">${safe}</a></p>`);
    } else {
      html.push(`<p class="md-line">${escapeHtml(line)}</p>`);
    }
  }

  closeList();
  els.renderedView.innerHTML = html.join("");
}

function renderBoards() {
  const q = els.boardSearch.value.trim().toLowerCase();
  state.filteredBoards = state.boards.filter((b) => (b.name || "").toLowerCase().includes(q));

  els.boardsList.innerHTML = "";
  for (const board of state.filteredBoards) {
    const node = els.boardItemTpl.content.firstElementChild.cloneNode(true);
    const btn = node.querySelector("button");
    btn.textContent = board.name || "(unnamed board)";
    btn.title = `${board.name}\n${board.id}`;
    if (state.selectedBoard?.id === board.id) btn.classList.add("active");
    btn.addEventListener("click", () => {
      state.selectedBoard = board;
      state.cards = [];
      state.selectedCardId = null;
      renderBoards();
      renderCards();
      els.loadCardsBtn.disabled = false;
      els.selectedBoardMeta.textContent =
        `Board: ${board.name}\nID: ${board.id}\nLast Activity: ${fmtDate(board.dateLastActivity)}`;
      els.cardBadge.textContent = "No card selected";
      els.copyMdBtn.disabled = true;
      els.markdownView.textContent = "";
      els.renderedView.innerHTML = "";
      els.jsonView.textContent = "";
      setViewerState("Board selected. Load cards to inspect a card packet.");
    });
    els.boardsList.appendChild(node);
  }

  if (!state.filteredBoards.length) {
    els.boardsList.innerHTML = `<li class="meta-block muted">No boards match filter.</li>`;
  }
}

function renderCards() {
  els.cardsList.innerHTML = "";
  for (const card of state.cards) {
    const node = els.cardItemTpl.content.firstElementChild.cloneNode(true);
    const btn = node.querySelector("button");
    btn.querySelector(".title").textContent = card.name || "(unnamed card)";
    const extra = [];
    if (card.labels?.length) extra.push(`${card.labels.length} label(s)`);
    if (card.due) extra.push(`Due ${fmtDate(card.due)}`);
    extra.push(`Activity ${fmtDate(card.dateLastActivity)}`);
    btn.querySelector(".sub").textContent = extra.join(" • ");
    if (state.selectedCardId === card.id) btn.classList.add("active");
    btn.addEventListener("click", () => loadCardPacket(card));
    els.cardsList.appendChild(node);
  }

  if (!state.cards.length) {
    els.cardsList.innerHTML = `<li class="meta-block muted">No cards loaded yet.</li>`;
  }
}

async function loadBoards() {
  els.refreshBoardsBtn.disabled = true;
  document.body.classList.add("loading");
  try {
    setViewerState("Loading boards...");
    const data = await apiGet("/api/boards");
    state.boards = data.boards || [];
    const me = data.me || {};
    els.identity.textContent = `${me.fullName || me.username || "Unknown"} • ${state.boards.length} boards`;
    renderBoards();
    setViewerState("Select a board to load cards.");
  } catch (err) {
    setViewerState(`Failed to load boards: ${err.message}`, false);
    els.identity.textContent = "Error";
  } finally {
    els.refreshBoardsBtn.disabled = false;
    document.body.classList.remove("loading");
  }
}

async function loadCards() {
  if (!state.selectedBoard) return;
  const limit = Math.min(Math.max(Number(els.cardLimit.value || 100), 1), 500);
  els.loadCardsBtn.disabled = true;
  els.cardsList.innerHTML = `<li class="meta-block muted">Loading cards...</li>`;
  try {
    setViewerState(`Loading cards for ${state.selectedBoard.name}...`);
    const data = await apiGet(`/api/boards/${state.selectedBoard.id}/cards?limit=${limit}`);
    state.cards = data.cards || [];
    renderCards();
    const board = data.board || state.selectedBoard;
    els.selectedBoardMeta.textContent =
      `Board: ${board.name}\nID: ${board.id}\nCards loaded: ${state.cards.length}\nLast Activity: ${fmtDate(board.dateLastActivity)}`;
    setViewerState("Select a card to generate the LLM packet preview.");
  } catch (err) {
    els.cardsList.innerHTML = `<li class="meta-block">Failed to load cards: ${err.message}</li>`;
    setViewerState(`Failed to load cards: ${err.message}`, false);
  } finally {
    els.loadCardsBtn.disabled = false;
  }
}

async function loadCardPacket(card) {
  state.selectedCardId = card.id;
  renderCards();
  els.cardBadge.textContent = `Loading ${card.name || card.id}...`;
  els.copyMdBtn.disabled = true;
  els.markdownView.textContent = "";
  els.renderedView.innerHTML = "";
  els.jsonView.textContent = "";
  setViewerState("Fetching comments, checklists, and attachments...");
  try {
    const data = await apiGet(`/api/cards/${card.id}/packet`);
    state.currentPacket = data.packet;
    state.currentMarkdown = data.markdown || "";

    els.markdownView.textContent = state.currentMarkdown;
    renderMarkdownPreview(state.currentMarkdown);
    els.jsonView.textContent = JSON.stringify(state.currentPacket, null, 2);

    const comments = state.currentPacket?.comments?.length || 0;
    const attachments = state.currentPacket?.attachments?.length || 0;
    const checklists = state.currentPacket?.checklists?.length || 0;
    const imageAssets = (state.currentPacket?.llm_assets || []).filter((a) => a.isImage).length;
    els.cardBadge.textContent =
      `${card.name || card.id} • ${comments} comments • ${attachments} attachments • ${imageAssets} image(s) • ${checklists} checklist(s)`;
    els.copyMdBtn.disabled = !state.currentMarkdown;
    setViewerState("Packet loaded. Rendered transcript includes inline images; use llm_assets for multimodal LLM inputs.");
  } catch (err) {
    els.cardBadge.textContent = "Load failed";
    setViewerState(`Failed to load packet: ${err.message}`, false);
  }
}

function initTabs() {
  els.tabs.forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      els.tabs.forEach((b) => b.classList.remove("active"));
      tabBtn.classList.add("active");
      const tab = tabBtn.dataset.tab;
      document.querySelectorAll(".tab-pane").forEach((pane) => pane.classList.remove("active"));
      if (tab === "json") {
        els.jsonView.classList.add("active");
      } else if (tab === "rendered") {
        els.renderedView.classList.add("active");
      } else {
        els.markdownView.classList.add("active");
      }
    });
  });
}

async function copyMarkdown() {
  if (!state.currentMarkdown) return;
  try {
    await navigator.clipboard.writeText(state.currentMarkdown);
    const prev = els.copyMdBtn.textContent;
    els.copyMdBtn.textContent = "Copied";
    setTimeout(() => {
      els.copyMdBtn.textContent = prev;
    }, 900);
  } catch {
    setViewerState("Clipboard copy failed. You can still select/copy from the viewer.", false);
  }
}

function bindEvents() {
  els.refreshBoardsBtn.addEventListener("click", loadBoards);
  els.loadCardsBtn.addEventListener("click", loadCards);
  els.boardSearch.addEventListener("input", renderBoards);
  els.copyMdBtn.addEventListener("click", copyMarkdown);
}

function init() {
  bindEvents();
  initTabs();
  loadBoards();
}

init();
