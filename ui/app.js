const state = {
  boards: [],
  filteredBoards: [],
  selectedBoard: null,
  cards: [],
  lastCardsQuery: "",
  cardSearchServerApplied: false,
  selectedCard: null,
  currentMarkdown: "",
  currentPacket: null,
  workspace: null,
  workspaceStatus: null,
  tokenEstimate: null,
  checklistParsed: null,
  checklistDraft: null,
  runResult: null,
  runHistory: [],
  reviewJobs: [],
  dismissedReviewJobIds: new Set(),
  reviewJobsPollTimer: null,
  cardLoadSeq: 0,
  collapsedSections: {},
  completedCardsById: new Map(),
  indexCache: new Map(),
  pdfCache: new Map(),
};

const PREFERRED_BOARD_NAME = "IG Tramitacion Training";
const DISMISSED_REVIEW_JOBS_KEY = "trelloReview.dismissedReviewJobs";
const COLLAPSED_SECTIONS_KEY = "trelloReview.collapsedSections";
const MULTIMODAL_LIMIT_MB_KEY = "trelloReview.multimodalLimitMb";
const SELECTED_MODEL_KEY = "trelloReview.selectedModel";
const REVIEW_JOBS_POLL_MS = 3000;
const DEFAULT_MODEL = "gpt-5.4";
const AVAILABLE_MODELS = ["gpt-5.4", "gpt-5.4-mini"];
const DEFAULT_MULTIMODAL_LIMIT_MB = 10;

const els = {
  refreshBoardsBtn: document.getElementById("refreshBoardsBtn"),
  copyMdBtn: document.getElementById("copyMdBtn"),
  boardSearch: document.getElementById("boardSearch"),
  boardsList: document.getElementById("boardsList"),
  identity: document.getElementById("identity"),
  cardLimit: document.getElementById("cardLimit"),
  cardSearch: document.getElementById("cardSearch"),
  loadCardsBtn: document.getElementById("loadCardsBtn"),
  selectedBoardMeta: document.getElementById("selectedBoardMeta"),
  cardsList: document.getElementById("cardsList"),
  completedCardsMeta: document.getElementById("completedCardsMeta"),
  completedCardsList: document.getElementById("completedCardsList"),
  recentJobsMeta: document.getElementById("recentJobsMeta"),
  recentJobsList: document.getElementById("recentJobsList"),
  cardBadge: document.getElementById("cardBadge"),
  viewerState: document.getElementById("viewerState"),

  prepareReviewBtn: document.getElementById("prepareReviewBtn"),
  uploadWorkspaceFilesBtn: document.getElementById("uploadWorkspaceFilesBtn"),
  createWorkspaceBtn: document.getElementById("createWorkspaceBtn"),
  refreshWorkspaceBtn: document.getElementById("refreshWorkspaceBtn"),
  indexLocalBtn: document.getElementById("indexLocalBtn"),
  indexTrelloBtn: document.getElementById("indexTrelloBtn"),
  runChecklistBtn: document.getElementById("runChecklistBtn"),
  modelInput: document.getElementById("modelInput"),
  reasoningEffortSelect: document.getElementById("reasoningEffortSelect"),
  multimodalLimitInput: document.getElementById("multimodalLimitInput"),
  tokenEstimate: document.getElementById("tokenEstimate"),
  workspaceMeta: document.getElementById("workspaceMeta"),
  localFilesList: document.getElementById("localFilesList"),
  indexesList: document.getElementById("indexesList"),

  checklistStatus: document.getElementById("checklistStatus"),
  checklistNameInput: document.getElementById("checklistNameInput"),
  checklistInstructionsInput: document.getElementById("checklistInstructionsInput"),
  checklistItemsList: document.getElementById("checklistItemsList"),
  loadChecklistBtn: document.getElementById("loadChecklistBtn"),
  resetChecklistBtn: document.getElementById("resetChecklistBtn"),
  importChecklistBtn: document.getElementById("importChecklistBtn"),
  exportChecklistBtn: document.getElementById("exportChecklistBtn"),
  importChecklistInput: document.getElementById("importChecklistInput"),
  uploadWorkspaceFilesInput: document.getElementById("uploadWorkspaceFilesInput"),
  saveChecklistBtn: document.getElementById("saveChecklistBtn"),
  addChecklistItemBtn: document.getElementById("addChecklistItemBtn"),

  runSummary: document.getElementById("runSummary"),
  resultsList: document.getElementById("resultsList"),
  runHistorySelect: document.getElementById("runHistorySelect"),
  loadRunBtn: document.getElementById("loadRunBtn"),

  packetRenderedView: document.getElementById("packetRenderedView"),
  packetMarkdownView: document.getElementById("packetMarkdownView"),
  packetJsonView: document.getElementById("packetJsonView"),
  
  citationModal: document.getElementById("citationModal"),
  closeModalBtn: document.getElementById("closeModalBtn"),
  modalCitationTitle: document.getElementById("modalCitationTitle"),
  modalCitationMeta: document.getElementById("modalCitationMeta"),
  citationDocView: document.getElementById("modalCitationDocView"),

  innerTabs: Array.from(document.querySelectorAll(".inner-tab")),
  ptabs: Array.from(document.querySelectorAll(".view-tab")),
  sectionToggles: Array.from(document.querySelectorAll("[data-section-toggle]")),
  boardItemTpl: document.getElementById("boardItemTpl"),
  cardItemTpl: document.getElementById("cardItemTpl"),
};

function fmtDate(value) {
  if (!value) return "n/d";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function bytesLabel(n) {
  if (!Number.isFinite(n)) return "n/d";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / (1024 ** 2)).toFixed(1)} MB`;
  return `${(n / (1024 ** 3)).toFixed(1)} GB`;
}

function skeletonLines(widths = ["100%"]) {
  return `<div class="skeleton-lines">${widths.map((width) => `<div class="skeleton-line" style="width:${width};"></div>`).join("")}</div>`;
}

async function apiGet(path) {
  const res = await fetch(path, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `La solicitud falló: ${res.status}`);
  return data;
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `La solicitud falló: ${res.status}`);
  return data;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function setViewerState(text) {
  els.viewerState.textContent = text;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setMainTab(tabId) {
  els.ptabs.forEach((b) => b.classList.toggle("active", b.dataset.ptab === tabId));
  document.querySelectorAll(".pane").forEach((p) => p.classList.remove("active"));
  document.getElementById(`ptab-${tabId}`)?.classList.add("active");
}

function setActiveInnerTab(tabId) {
  els.innerTabs.forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
  document.querySelectorAll(".tab-pane").forEach((pane) => pane.classList.remove("active"));
  const paneMap = {
    "packet-rendered": els.packetRenderedView,
    "packet-markdown": els.packetMarkdownView,
    "packet-json": els.packetJsonView,
  };
  paneMap[tabId]?.classList.add("active");
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
      const alt = escapeHtml(imageMatch[1] || "imagen");
      const src = escapeHtml(imageMatch[2] || "");
      html.push(`<figure><img loading="lazy" src="${src}" alt="${alt}" /><figcaption class="muted mono-text">${alt}</figcaption></figure>`);
      continue;
    }

    if (trimmed.startsWith("# ")) { closeList(); html.push(`<h1>${escapeHtml(trimmed.slice(2))}</h1>`); continue; }
    if (trimmed.startsWith("## ")) { closeList(); html.push(`<h2>${escapeHtml(trimmed.slice(3))}</h2>`); continue; }
    if (trimmed.startsWith("### ")) { closeList(); html.push(`<h3>${escapeHtml(trimmed.slice(4))}</h3>`); continue; }
    if (trimmed.startsWith("- ")) {
      if (!listOpen) { html.push("<ul>"); listOpen = true; }
      html.push(`<li>${escapeHtml(trimmed.slice(2))}</li>`);
      continue;
    }

    closeList();
    if (["_No hay adjuntos_", "_No hay comentarios_", "_No hay recursos de imagen_", "_No hay checklists_"].includes(trimmed)) {
      html.push(`<p class="muted mono-text">${escapeHtml(trimmed)}</p>`);
    } else if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const safe = escapeHtml(trimmed);
      html.push(`<p><a href="${safe}" target="_blank" rel="noreferrer" style="color:var(--accent); text-decoration:underline;">${safe}</a></p>`);
    } else {
      html.push(`<p>${escapeHtml(line)}</p>`);
    }
  }

  closeList();
  els.packetRenderedView.innerHTML = html.join("");
}

function renderBoards() {
  const q = els.boardSearch.value.trim().toLowerCase();
  state.filteredBoards = state.boards.filter((b) => (b.name || "").toLowerCase().includes(q));
  els.boardsList.innerHTML = "";

  for (const board of state.filteredBoards) {
    const node = els.boardItemTpl.content.firstElementChild.cloneNode(true);
    const btn = node.querySelector("button");
    btn.textContent = board.name || "(tablero sin nombre)";
    if (state.selectedBoard?.id === board.id) btn.classList.add("active");
    btn.addEventListener("click", () => selectBoard(board));
    els.boardsList.appendChild(node);
  }

  if (!state.filteredBoards.length) els.boardsList.innerHTML = `<li class="meta-text" style="padding:0 24px;">No hay tableros que coincidan.</li>`;
}

function selectBoard(board, { statusMessage = "Tablero seleccionado. Carga las tarjetas." } = {}) {
  state.selectedBoard = board;
  state.cards = [];
  state.selectedCard = null;
  state.workspaceStatus = null;
  state.tokenEstimate = null;
  state.currentPacket = null;
  state.currentMarkdown = "";
  state.workspace = null;
  state.indexCache.clear();
  state.runResult = null;
  renderBoards();
  renderCards();
  renderPacketViews();
  renderTokenEstimate();
  renderWorkspace();
  renderResults();
  els.loadCardsBtn.disabled = false;
  els.selectedBoardMeta.textContent = `ID: ${board.id} • Actividad: ${fmtDate(board.dateLastActivity)}`;
  els.cardBadge.textContent = "Ninguna tarjeta seleccionada";
  setViewerState(statusMessage);
}

function renderCards() {
  const q = (els.cardSearch?.value || "").trim().toLowerCase();
  const visibleCards = q
    ? state.cards.filter((c) => String(c.name || "").toLowerCase().includes(q) || String(c.desc || "").toLowerCase().includes(q))
    : state.cards;
  els.cardsList.innerHTML = "";
  
  for (const card of visibleCards) {
    const node = els.cardItemTpl.content.firstElementChild.cloneNode(true);
    const btn = node.querySelector("button");
    btn.querySelector(".title").textContent = card.name || "(tarjeta sin nombre)";
    const extra = [];
    if (card.labels?.length) extra.push(`${card.labels.length} etq.`);
    if (card.due) extra.push(`Vence ${fmtDate(card.due)}`);
    extra.push(`Act. ${fmtDate(card.dateLastActivity)}`);
    btn.querySelector(".sub").textContent = extra.join(" • ");
    if (state.selectedCard?.id === card.id) btn.classList.add("active");
    btn.addEventListener("click", () => loadCard(card));
    els.cardsList.appendChild(node);
  }
  
  if (!state.cards.length) els.cardsList.innerHTML = `<li class="meta-text" style="padding:0 24px;">No hay tarjetas cargadas.</li>`;
  else if (!visibleCards.length) els.cardsList.innerHTML = `<li class="meta-text" style="padding:0 24px;">No hay coincidencias.</li>`;
}

function syncFixedModelUi() {
  if (!els.modelInput) return;
  els.modelInput.value = loadSelectedModel();
}

function normalizeSelectedModel(raw) {
  const value = String(raw || "").trim();
  return AVAILABLE_MODELS.includes(value) ? value : DEFAULT_MODEL;
}

function loadSelectedModel() {
  try {
    return normalizeSelectedModel(window.localStorage.getItem(SELECTED_MODEL_KEY));
  } catch {
    return DEFAULT_MODEL;
  }
}

function persistSelectedModel() {
  const value = normalizeSelectedModel(els.modelInput?.value);
  if (els.modelInput) els.modelInput.value = value;
  try {
    window.localStorage.setItem(SELECTED_MODEL_KEY, value);
  } catch {
    // Ignore storage failures in desktop/webview environments.
  }
  return value;
}

function getSelectedModel() {
  return normalizeSelectedModel(els.modelInput?.value);
}

function loadCollapsedSections() {
  const defaults = { boards: false, recent: false, completed: false, cards: false };
  try {
    const raw = window.localStorage.getItem(COLLAPSED_SECTIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return defaults;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

function persistCollapsedSections() {
  try {
    window.localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify(state.collapsedSections));
  } catch {
    // Ignore storage failures in desktop/webview environments.
  }
}

function renderSidebarSections() {
  document.querySelectorAll(".section[data-section]").forEach((section) => {
    const sectionName = section.dataset.section;
    const collapsed = !!state.collapsedSections[sectionName];
    section.classList.toggle("collapsed", collapsed);
    const toggle = section.querySelector("[data-section-toggle]");
    if (toggle) toggle.setAttribute("aria-expanded", String(!collapsed));
  });
}

function toggleSidebarSection(sectionName) {
  if (!sectionName) return;
  state.collapsedSections[sectionName] = !state.collapsedSections[sectionName];
  persistCollapsedSections();
  renderSidebarSections();
}

function loadDismissedReviewJobIds() {
  try {
    const raw = window.localStorage.getItem(DISMISSED_REVIEW_JOBS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((value) => String(value || "")).filter(Boolean));
  } catch {
    return new Set();
  }
}

function persistDismissedReviewJobIds() {
  try {
    const ids = Array.from(state.dismissedReviewJobIds).slice(-200);
    window.localStorage.setItem(DISMISSED_REVIEW_JOBS_KEY, JSON.stringify(ids));
  } catch {
    // Ignore storage failures in desktop/webview environments.
  }
}

function normalizeMultimodalLimitMb(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_MULTIMODAL_LIMIT_MB;
  return Math.max(1, Math.min(100, Math.round(value)));
}

function loadMultimodalLimitMb() {
  try {
    return normalizeMultimodalLimitMb(window.localStorage.getItem(MULTIMODAL_LIMIT_MB_KEY));
  } catch {
    return DEFAULT_MULTIMODAL_LIMIT_MB;
  }
}

function persistMultimodalLimitMb() {
  const value = normalizeMultimodalLimitMb(els.multimodalLimitInput?.value);
  if (els.multimodalLimitInput) els.multimodalLimitInput.value = String(value);
  try {
    window.localStorage.setItem(MULTIMODAL_LIMIT_MB_KEY, String(value));
  } catch {
    // Ignore storage failures in desktop/webview environments.
  }
  return value;
}

function getConfiguredMultimodalLimitBytes() {
  const mb = normalizeMultimodalLimitMb(els.multimodalLimitInput?.value);
  return mb * 1024 * 1024;
}

async function handleMultimodalLimitChange() {
  const value = persistMultimodalLimitMb();
  if (!state.selectedCard) {
    if (els.multimodalLimitInput) els.multimodalLimitInput.value = String(value);
    return;
  }
  try {
    await loadWorkspaceStatus(state.currentPacket).catch(() => {});
    refreshTokenEstimate();
  } catch {
    // Keep the UI responsive even if the status refresh fails.
  }
}

function normalizeCompletedCardEntry(entry) {
  if (!entry?.card?.id || !entry?.run_id) return null;
  return {
    card: {
      id: entry.card.id,
      name: entry.card.name || entry.card.id,
      url: entry.card.url || "",
    },
    run_id: entry.run_id,
    finished_at: entry.finished_at || entry.created_at || null,
    run_summary: entry.run_summary || null,
    model: entry.model || DEFAULT_MODEL,
  };
}

function completedCardSortValue(entry) {
  const value = entry?.finished_at ? new Date(entry.finished_at).getTime() : 0;
  return Number.isFinite(value) ? value : 0;
}

function registerCompletedCard(entry) {
  const normalized = normalizeCompletedCardEntry(entry);
  if (!normalized) return;
  const existing = state.completedCardsById.get(normalized.card.id);
  if (existing && completedCardSortValue(existing) >= completedCardSortValue(normalized)) return;
  state.completedCardsById.set(normalized.card.id, normalized);
}

function syncCompletedCardsFromReviewJobs() {
  for (const job of state.reviewJobs) {
    if (job?.status !== "succeeded" || !job?.run_id) continue;
    registerCompletedCard({
      card: job.card,
      run_id: job.run_id,
      finished_at: job.finished_at,
      run_summary: job.run_summary,
      model: job.model,
    });
  }
}

function syncCompletedCardFromWorkspace(card = state.selectedCard, workspace = state.workspace) {
  const latest = workspace?.runs?.[0];
  if (!card?.id || !latest?.run_id) return;
  registerCompletedCard({
    card,
    run_id: latest.run_id,
    finished_at: latest.created_at,
    run_summary: latest.summary,
    model: latest.model || DEFAULT_MODEL,
  });
}

function completedCards() {
  return Array.from(state.completedCardsById.values()).sort((a, b) => completedCardSortValue(b) - completedCardSortValue(a));
}

async function loadCompletedCardsSnapshot() {
  try {
    const data = await apiGet("/api/completed-cards");
    for (const item of data.cards || []) {
      registerCompletedCard(item);
    }
    renderCompletedCards();
  } catch {
    // Ignore startup hydration failures; live session updates still populate the list.
  }
}

function visibleReviewJobs() {
  return state.reviewJobs.filter((job) => !state.dismissedReviewJobIds.has(job.job_id));
}

function isReviewJobActive(job) {
  return ["queued", "running"].includes(job?.status || "");
}

function hasActiveReviewJobForCard(cardId) {
  return !!cardId && state.reviewJobs.some((job) => job?.card?.id === cardId && isReviewJobActive(job));
}

function reviewJobStatusLabel(status) {
  return {
    queued: "En cola",
    running: "Analizando",
    succeeded: "Lista",
    failed: "Error",
  }[status] || "Desconocido";
}

function reviewJobStatusTone(status) {
  if (status === "succeeded") return "ready";
  if (status === "failed") return "stale";
  return "pending";
}

function reviewJobMeta(job) {
  const parts = [];
  if (job?.model) parts.push(job.model);
  if (job?.stage && job.status === "running") parts.push(`Etapa: ${job.stage}`);
  if (Number.isFinite(job?.progress_current) && Number.isFinite(job?.progress_total) && job.progress_total > 0) {
    parts.push(`${job.progress_current}/${job.progress_total}`);
  }
  if (job?.finished_at) parts.push(`Term. ${fmtDate(job.finished_at)}`);
  else if (job?.started_at) parts.push(`Inicio ${fmtDate(job.started_at)}`);
  else if (job?.created_at) parts.push(`Creada ${fmtDate(job.created_at)}`);
  return parts.join(" • ");
}

function reviewJobSummaryText(job) {
  const counts = job?.run_summary?.counts || {};
  if (job?.status === "succeeded") return `Cumple ${counts.pass || 0} • Falla ${counts.fail || 0} • Revisar ${counts.needs_review || 0}`;
  if (job?.status === "failed") return job?.error || job?.progress_message || "La ejecución falló.";
  return job?.progress_message || "La revisión sigue ejecutándose en segundo plano.";
}

function dismissReviewJob(jobId) {
  if (!jobId) return;
  state.dismissedReviewJobIds.add(jobId);
  persistDismissedReviewJobIds();
  renderRecentJobs();
  renderCompletedCards();
}

async function openReviewJob(job) {
  if (!job?.card?.id || !job?.run_id) return;
  const card = {
    id: job.card.id,
    name: job.card.name || job.card.id,
    url: job.card.url || "",
  };
  if (state.selectedCard?.id !== card.id) {
    await loadCard(card);
  }
  els.runHistorySelect.value = job.run_id;
  await loadRunById(card.id, job.run_id);
  setMainTab("results");
}

function renderCompletedCards() {
  const items = completedCards();
  els.completedCardsMeta.textContent = items.length ? `${items.length} tarjeta(s)` : "Sin ejecuciones.";
  els.completedCardsList.innerHTML = "";

  if (!items.length) {
    els.completedCardsList.innerHTML = `<li class="meta-text" style="padding:0 8px;">Las tarjetas con revisiones terminadas aparecerán aquí.</li>`;
    return;
  }

  for (const item of items) {
    const row = document.createElement("li");
    row.className = "recent-job-item completed-card-item";
    row.innerHTML = `
      <div class="recent-job-body">
        <div class="recent-job-top">
          <div class="recent-job-title-wrap">
            <span class="recent-job-title">${escapeHtml(item.card.name || item.card.id)}</span>
          </div>
          <span class="data-item-status ready">Lista</span>
        </div>
        <div class="recent-job-meta">${escapeHtml(item.model || DEFAULT_MODEL)} • ${escapeHtml(item.finished_at ? `Term. ${fmtDate(item.finished_at)}` : "Fecha desconocida")}</div>
        <div class="recent-job-summary">${escapeHtml(reviewJobSummaryText({ status: "succeeded", run_summary: item.run_summary }))}</div>
      </div>
    `;
    const actions = document.createElement("div");
    actions.className = "recent-job-actions";
    const openBtn = document.createElement("button");
    openBtn.className = "action-btn outline sm";
    openBtn.textContent = "Abrir";
    openBtn.onclick = () => openReviewJob(item).catch((err) => setViewerState(`No se pudo abrir la ejecución: ${err.message}`));
    actions.appendChild(openBtn);
    row.appendChild(actions);
    els.completedCardsList.appendChild(row);
  }
}

function renderRecentJobs() {
  const jobs = visibleReviewJobs();
  const activeCount = jobs.filter(isReviewJobActive).length;
  els.recentJobsMeta.textContent = jobs.length ? `${activeCount} en curso • ${jobs.length} total` : "Sin actividad.";
  els.recentJobsList.innerHTML = "";

  if (!jobs.length) {
    els.recentJobsList.innerHTML = `<li class="meta-text" style="padding:0 8px;">Las revisiones recientes aparecerán aquí.</li>`;
    return;
  }

  for (const job of jobs) {
    const item = document.createElement("li");
    item.className = "recent-job-item";

    const body = document.createElement("div");
    body.className = "recent-job-body";

    const top = document.createElement("div");
    top.className = "recent-job-top";
    top.innerHTML = `
      <div class="recent-job-title-wrap">
        ${isReviewJobActive(job) ? '<span class="recent-job-spinner" aria-hidden="true"></span>' : ""}
        <span class="recent-job-title">${escapeHtml(job.card?.name || job.card?.id || "Tarjeta")}</span>
      </div>
      <span class="data-item-status ${reviewJobStatusTone(job.status)}">${escapeHtml(reviewJobStatusLabel(job.status))}</span>
    `;

    const meta = document.createElement("div");
    meta.className = "recent-job-meta";
    meta.textContent = reviewJobMeta(job) || "Sin metadatos.";

    const summary = document.createElement("div");
    summary.className = `recent-job-summary ${job.status === "failed" ? "is-error" : ""}`;
    summary.textContent = reviewJobSummaryText(job);

    body.append(top, meta, summary);

    const actions = document.createElement("div");
    actions.className = "recent-job-actions";
    if (job.status === "succeeded" && job.run_id) {
      const openBtn = document.createElement("button");
      openBtn.className = "action-btn outline sm";
      openBtn.textContent = "Abrir";
      openBtn.onclick = () => openReviewJob(job).catch((err) => setViewerState(`No se pudo abrir la ejecución: ${err.message}`));
      actions.appendChild(openBtn);
    }
    const closeBtn = document.createElement("button");
    closeBtn.className = "icon-btn recent-job-close";
    closeBtn.title = "Cerrar";
    closeBtn.setAttribute("aria-label", `Cerrar ${job.card?.name || job.card?.id || "reciente"}`);
    closeBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    `;
    closeBtn.onclick = () => dismissReviewJob(job.job_id);
    actions.appendChild(closeBtn);

    item.append(body, actions);
    els.recentJobsList.appendChild(item);
  }
}

async function syncSelectedCardRunHistory() {
  if (!state.selectedCard?.id) return;
  try {
    state.workspace = await apiGet(`/api/cards/${state.selectedCard.id}/workspace`);
    syncCompletedCardFromWorkspace(state.selectedCard, state.workspace);
    renderCompletedCards();
    renderWorkspace();
  } catch {
    // Background sync failures should not interrupt the current task.
  }
}

function notifyReviewJobTransition(job) {
  if (job.status === "succeeded") {
    setViewerState(`La revisión de ${job.card?.name || job.card?.id || "la tarjeta"} terminó. Revisa Recientes para abrir el resultado.`);
    return;
  }
  if (job.status === "failed") {
    setViewerState(`Falló la revisión de ${job.card?.name || job.card?.id || "la tarjeta"}: ${job.error || job.progress_message || "Error desconocido"}`);
  }
}

function applyReviewJobs(jobs) {
  const previous = new Map((state.reviewJobs || []).map((job) => [job.job_id, job]));
  state.reviewJobs = Array.isArray(jobs) ? jobs : [];
  syncCompletedCardsFromReviewJobs();
  const activeSelectedJob = state.selectedCard?.id
    ? state.reviewJobs.find((job) => job?.card?.id === state.selectedCard.id && isReviewJobActive(job))
    : null;

  if (activeSelectedJob) {
    const before = previous.get(activeSelectedJob.job_id);
    if (
      !before
      || before.progress_message !== activeSelectedJob.progress_message
      || before.stage !== activeSelectedJob.stage
      || before.progress_current !== activeSelectedJob.progress_current
      || before.progress_total !== activeSelectedJob.progress_total
    ) {
      setViewerState(activeSelectedJob.progress_message || "La revisión sigue ejecutándose en segundo plano.");
    }
  }

  for (const job of visibleReviewJobs()) {
    const before = previous.get(job.job_id);
    if (!before || before.status === job.status) continue;
    if (["succeeded", "failed"].includes(job.status)) {
      notifyReviewJobTransition(job);
      if (job.status === "succeeded" && state.selectedCard?.id === job.card?.id) {
        syncSelectedCardRunHistory();
      }
    }
  }

  renderRecentJobs();
  renderCompletedCards();
  renderWorkspace();
}

async function refreshReviewJobs({ silent = true } = {}) {
  try {
    const data = await apiGet("/api/review-jobs");
    applyReviewJobs(data.jobs || []);
  } catch (err) {
    if (!silent) setViewerState(`No se pudieron cargar las revisiones recientes: ${err.message}`);
  }
}

function startReviewJobsPolling() {
  if (state.reviewJobsPollTimer) window.clearInterval(state.reviewJobsPollTimer);
  refreshReviewJobs({ silent: true });
  state.reviewJobsPollTimer = window.setInterval(() => {
    refreshReviewJobs({ silent: true });
  }, REVIEW_JOBS_POLL_MS);
}

function renderPacketViews() {
  els.packetMarkdownView.textContent = state.currentMarkdown || "";
  els.packetJsonView.textContent = state.currentPacket ? JSON.stringify(state.currentPacket, null, 2) : "";
  renderMarkdownPreview(state.currentMarkdown || "");
  els.copyMdBtn.disabled = !state.currentMarkdown;
}

function renderTokenEstimate() {
  if (!els.tokenEstimate) return;
  if (!state.selectedCard) {
    els.tokenEstimate.textContent = "No hay ninguna tarjeta seleccionada.";
    return;
  }
  const est = state.tokenEstimate;
  if (!est) { els.tokenEstimate.textContent = "Sin calcular."; return; }
  if (est.loading) {
    els.tokenEstimate.innerHTML = skeletonLines(["58%", "84%", "46%"]);
    return;
  }
  
  const total = est.counts?.total_input_tokens;
  const docs = est.payload_stats?.evidence_documents ?? 0;
  const segs = est.payload_stats?.evidence_segments ?? 0;
  const items = est.payload_stats?.checklist_items ?? 0;
  
  if (Number.isFinite(total)) {
    const notes = Array.isArray(est.notes) && est.notes.length
      ? `<br/><br/><span class="meta-text">${escapeHtml(est.notes[0])}</span>`
      : "";
    els.tokenEstimate.innerHTML = `<strong>Total: ${total.toLocaleString()} tokens</strong><br/><br/>Evidencia: ${docs} documentos (${segs} segmentos)<br/>Criterios: ${items}${notes}`;
  } else {
    els.tokenEstimate.textContent = est.error ? `Error: ${est.error}` : "No disponible";
  }
}

function indexStatusLabel(status) {
  return ({
    indexed: "Indexado",
    not_indexed: "Requiere indexación",
    changed: "Cambió",
    missing: "Obsoleto",
  })[status] || "Desconocido";
}

function indexStatusTone(status) {
  if (status === "indexed") return "ready";
  if (status === "missing") return "stale";
  return "pending";
}

function renderWorkspaceItem(item, kind) {
  const name = item.relativePath || item.name || item.fileName || item.attachmentId || "?";
  const primaryMeta = kind === "local" ? bytesLabel(item.size) : (item.mimeType || "desconocido");
  const indexedAt = item.lastIndexedAt ? ` • ${fmtDate(item.lastIndexedAt)}` : "";
  const warnings = Array.isArray(item.indexWarnings) && item.indexWarnings.length
    ? `<div class="data-item-note">${escapeHtml(item.indexWarnings[0])}</div>`
    : "";
  return `<li class="data-item">
    <div class="data-item-head">
      <div class="data-item-title">${escapeHtml(name)}</div>
      <span class="data-item-status ${indexStatusTone(item.indexStatus)}">${escapeHtml(indexStatusLabel(item.indexStatus))}</span>
    </div>
    <div class="data-item-meta">${escapeHtml(primaryMeta)}${indexedAt}</div>
    ${warnings}
  </li>`;
}

function renderPrepSummary(ws, prep) {
  const counts = prep?.counts || {};
  const tone = prep?.readyForRun ? "ready" : (prep?.state === "empty" ? "pending" : "stale");
  const mm = prep?.multimodal || {};
  const actions = Array.isArray(prep?.actions) && prep.actions.length
    ? `<div class="workspace-next"><strong>Siguiente:</strong> ${escapeHtml(prep.actions.join(" "))}</div>`
    : "";
  const folder = ws?.attachmentsPath
    ? `<div><strong>Carpeta:</strong> ${escapeHtml(ws.attachmentsPath)}</div>`
    : "";
  const multimodal = mm.assetCount
    ? `<div>OCR multimodal: ${mm.assetCount}/${mm.eligibleAssetCount ?? mm.assetCount} adjunto(s) (${escapeHtml(bytesLabel(mm.totalBytes || 0))}${mm.limitBytes ? ` / límite ${escapeHtml(bytesLabel(mm.limitBytes))}` : ""})</div>`
    : (Number.isFinite(mm.limitBytes) ? `<div>OCR multimodal: 0 adjuntos (${escapeHtml(bytesLabel(0))} / límite ${escapeHtml(bytesLabel(mm.limitBytes))})</div>` : "");
  const multimodalEligible = (mm.eligibleTotalBytes && mm.eligibleTotalBytes !== mm.totalBytes)
    ? `<div class="meta-text">Elegibles: ${escapeHtml(bytesLabel(mm.eligibleTotalBytes))}${mm.omittedCount ? ` • omitidos por límite: ${escapeHtml(String(mm.omittedCount))}` : ""}</div>`
    : (mm.omittedCount ? `<div class="meta-text">Omitidos por límite: ${escapeHtml(String(mm.omittedCount))}</div>` : "");
  const multimodalWarn = mm.overLimit
    ? `<div class="meta-text" style="color:#9a2f2f;">Advertencia: la carga multimodal supera el límite configurado y algunos adjuntos se omitirán.</div>`
    : (mm.nearLimit
      ? `<div class="meta-text" style="color:#8a5a00;">Advertencia: la carga multimodal está cerca del límite y la revisión puede volverse lenta.</div>`
      : "");
  return `
    <div class="workspace-status-line">
      <span class="data-item-status ${tone}">${escapeHtml(prep?.readyForRun ? "Listo" : "Requiere preparación")}</span>
      <strong>${escapeHtml(prep?.summary || "Estado no disponible.")}</strong>
    </div>
    <div>Evidencia: ${counts.evidenceDocs ?? 0} fuente(s) indexada(s)</div>
    <div>Local: ${counts.localIndexed ?? 0}/${counts.localTotal ?? 0} listas • Trello: ${counts.remoteIndexed ?? 0}/${counts.remoteTotal ?? 0} listas</div>
    ${multimodal}
    ${multimodalEligible}
    ${multimodalWarn}
    ${folder}
    ${actions}
  `;
}

function renderWorkspace() {
  const hasCard = !!state.selectedCard;
  els.prepareReviewBtn.disabled = !hasCard;
  els.uploadWorkspaceFilesBtn.disabled = !hasCard;
  els.createWorkspaceBtn.disabled = !hasCard;
  els.refreshWorkspaceBtn.disabled = !hasCard;
  
  const hasWorkspace = !!state.workspace?.exists;
  els.indexLocalBtn.disabled = !hasWorkspace;
  els.indexTrelloBtn.disabled = !hasWorkspace || !state.currentPacket;
  const runInFlight = hasActiveReviewJobForCard(state.selectedCard?.id);
  els.runChecklistBtn.disabled = !state.workspaceStatus?.readyForRun || runInFlight;
  els.runChecklistBtn.textContent = runInFlight ? "Revisión en curso..." : "Ejecutar revisión";

  if (!hasCard) {
    els.workspaceMeta.textContent = "No hay ninguna tarjeta seleccionada.";
    els.localFilesList.innerHTML = `<li class="data-item"><span class="meta-text" style="padding:0;">Selecciona una tarjeta.</span></li>`;
    els.indexesList.innerHTML = `<li class="data-item"><span class="meta-text" style="padding:0;">Selecciona una tarjeta.</span></li>`;
    return;
  }

  if (!state.workspaceStatus) {
    els.workspaceMeta.innerHTML = skeletonLines(["42%", "78%", "55%"]);
    els.localFilesList.innerHTML = `
      <li class="data-item is-skeleton">${skeletonLines(["72%", "34%"])}</li>
      <li class="data-item is-skeleton">${skeletonLines(["64%", "28%"])}</li>
    `;
    els.indexesList.innerHTML = `
      <li class="data-item is-skeleton">${skeletonLines(["70%", "30%"])}</li>
      <li class="data-item is-skeleton">${skeletonLines(["60%", "36%"])}</li>
    `;
    return;
  }

  const ws = state.workspace;
  const prep = state.workspaceStatus;
  els.workspaceMeta.innerHTML = renderPrepSummary(ws, prep);

  const localFiles = prep.local?.items || [];
  const staleLocal = prep.local?.stale || [];
  if (!localFiles.length) {
    const emptyLabel = hasWorkspace
      ? `No se encontraron archivos locales${ws?.attachmentsPath ? ` en ${escapeHtml(ws.attachmentsPath)}` : ""}.`
      : "Prepara la revisión para crear la carpeta local.";
    els.localFilesList.innerHTML = `<li class="data-item"><span class="meta-text" style="padding:0;">${emptyLabel}</span></li>`;
  } else {
    els.localFilesList.innerHTML = localFiles.map((row) => renderWorkspaceItem(row, "local")).join("");
  }
  if (staleLocal.length) els.localFilesList.innerHTML += staleLocal.map((row) => renderWorkspaceItem(row, "local")).join("");

  const remoteItems = prep.remote?.items || [];
  const staleRemote = prep.remote?.stale || [];
  if (!remoteItems.length) {
    els.indexesList.innerHTML = `<li class="data-item"><span class="meta-text" style="padding:0;">No hay adjuntos de Trello en esta tarjeta.</span></li>`;
  } else {
    els.indexesList.innerHTML = remoteItems.map((row) => renderWorkspaceItem(row, "remote")).join("");
  }
  if (staleRemote.length) els.indexesList.innerHTML += staleRemote.map((row) => renderWorkspaceItem(row, "remote")).join("");

  renderRunHistorySelect();
}

function renderChecklistEditorStatus(msg) {
  els.checklistStatus.textContent = msg;
}

function newChecklistItemDraft(seed = {}) {
  return {
    id: String(seed.id || "").trim(),
    title: String(seed.title || "").trim(),
    description: String(seed.description || "").trim(),
    pass_criteria: String(seed.pass_criteria || "").trim(),
    fail_criteria: String(seed.fail_criteria || "").trim(),
  };
}

function newChecklistDraft(seed = {}) {
  const items = Array.isArray(seed.items) && seed.items.length ? seed.items.map(newChecklistItemDraft) : [newChecklistItemDraft()];
  return {
    name: String(seed.name || "Revisión estándar"),
    instructions: String(seed.instructions || ""),
    items,
  };
}

function ensureChecklistDraft() {
  if (!state.checklistDraft) state.checklistDraft = newChecklistDraft(state.checklistParsed || {});
  return state.checklistDraft;
}

function renderChecklistBuilder() {
  const draft = ensureChecklistDraft();
  els.checklistNameInput.value = draft.name || "";
  els.checklistInstructionsInput.value = draft.instructions || "";
  els.checklistItemsList.innerHTML = "";

  if (!draft.items.length) draft.items.push(newChecklistItemDraft());

  draft.items.forEach((item, idx) => {
    const card = document.createElement("div");
    card.className = "criterion-block";
    card.innerHTML = `
      <div class="criterion-number">#${(idx + 1).toString().padStart(2, '0')}</div>
      <div class="criterion-fields">
        <div class="field-group full-width">
          <label>Título del criterio</label>
          <input type="text" data-field="title" value="${escapeHtml(item.title || "")}" />
        </div>
        <div class="field-group full-width">
          <label>Descripción</label>
          <textarea rows="2" data-field="description">${escapeHtml(item.description || "")}</textarea>
        </div>
        <div class="field-group">
          <label>Criterios de cumplimiento</label>
          <textarea rows="2" data-field="pass_criteria">${escapeHtml(item.pass_criteria || "")}</textarea>
        </div>
        <div class="field-group">
          <label>Criterios de incumplimiento</label>
          <textarea rows="2" data-field="fail_criteria">${escapeHtml(item.fail_criteria || "")}</textarea>
        </div>
        <div class="criterion-actions"></div>
      </div>
    `;

    const actions = card.querySelector(".criterion-actions");
    const upBtn = document.createElement("button"); upBtn.className = "action-btn outline sm"; upBtn.textContent = "↑";
    upBtn.disabled = idx === 0;
    upBtn.onclick = () => { const a = draft.items[idx-1]; draft.items[idx-1] = draft.items[idx]; draft.items[idx] = a; renderChecklistBuilder(); };
    
    const downBtn = document.createElement("button"); downBtn.className = "action-btn outline sm"; downBtn.textContent = "↓";
    downBtn.disabled = idx === draft.items.length - 1;
    downBtn.onclick = () => { const a = draft.items[idx+1]; draft.items[idx+1] = draft.items[idx]; draft.items[idx] = a; renderChecklistBuilder(); };

    const delBtn = document.createElement("button"); delBtn.className = "action-btn outline sm btn-danger"; delBtn.textContent = "Eliminar";
    delBtn.disabled = draft.items.length <= 1;
    delBtn.onclick = () => { draft.items.splice(idx, 1); renderChecklistBuilder(); };

    actions.append(upBtn, downBtn, delBtn);

    card.querySelectorAll("[data-field]").forEach(input => {
      input.oninput = () => draft.items[idx][input.dataset.field] = input.value.trim();
    });

    els.checklistItemsList.appendChild(card);
  });
}

function slugify(text) { return String(text||"").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48); }

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function buildChecklistPayload() {
  const draft = ensureChecklistDraft();
  draft.name = els.checklistNameInput.value.trim() || "Revisión estándar";
  draft.instructions = els.checklistInstructionsInput.value.trim();
  const seen = new Set();
  const items = draft.items.map((item, idx) => {
    const title = item.title || `Criterio ${idx+1}`;
    let id = item.id || `item_${slugify(title) || idx+1}`;
    let cand = id; let n = 2;
    while(seen.has(cand)) cand = `${id}_${n++}`;
    seen.add(cand);
    return { ...item, id: cand, title };
  });
  return { version: 1, name: draft.name, instructions: draft.instructions, items };
}

function citationEffectClass(effect) {
  return ["supports", "contradicts", "insufficient"].includes(effect) ? effect : "insufficient";
}

function citationEffectLabel(effect) {
  return {
    supports: "Respalda",
    contradicts: "Contradice",
    insufficient: "Insuficiente",
  }[citationEffectClass(effect)];
}

function validationStatusLabel(status) {
  return {
    ok: "válida",
    weak_match: "coincidencia débil",
    missing_anchor: "ancla faltante",
    unvalidated: "sin validar",
  }[status] || status;
}

function citationValidationLabel(citation) {
  const status = citation?.validation?.status || "unvalidated";
  const score = citation?.validation?.score;
  const label = validationStatusLabel(status);
  return Number.isFinite(Number(score)) ? `${label} (${Number(score).toFixed(2)})` : label;
}

function runItemStatusLabel(status) {
  return {
    pass: "cumple",
    fail: "falla",
    needs_review: "requiere revisión",
  }[status] || status;
}

function renderRunHistorySelect() {
  const runs = state.workspace?.runs || [];
  const preferredRunId = state.runResult?.run_id || els.runHistorySelect.value || "";
  els.runHistorySelect.innerHTML = "";
  if (!runs.length) {
    els.runHistorySelect.innerHTML = `<option value="">Sin historial</option>`;
    els.loadRunBtn.disabled = true;
    return;
  }
  for (const r of runs) {
    const opt = document.createElement("option");
    opt.value = r.run_id;
    opt.textContent = `${fmtDate(r.created_at)} • cumple:${r.counts?.pass||0} falla:${r.counts?.fail||0}`;
    els.runHistorySelect.appendChild(opt);
  }
  if (preferredRunId && runs.some((r) => r.run_id === preferredRunId)) {
    els.runHistorySelect.value = preferredRunId;
  } else if (runs[0]?.run_id) {
    els.runHistorySelect.value = runs[0].run_id;
  }
  els.loadRunBtn.disabled = false;
}

function renderResults() {
  const run = state.runResult;
  if (!run) {
    els.runSummary.textContent = "No hay ninguna ejecución cargada.";
    els.resultsList.innerHTML = "";
    return;
  }

  const timing = run.diagnostics?.timings || {};
  const timingBits = [];
  if (Number.isFinite(timing.ocr_total_seconds)) timingBits.push(`OCR ${Number(timing.ocr_total_seconds).toFixed(1)}s`);
  if (Number.isFinite(timing.checklist_request_seconds)) timingBits.push(`Checklist ${Number(timing.checklist_request_seconds).toFixed(1)}s`);
  if (Number.isFinite(timing.total_seconds)) timingBits.push(`Total ${Number(timing.total_seconds).toFixed(1)}s`);
  const timingSuffix = timingBits.length ? ` • ${timingBits.join(" • ")}` : "";
  els.runSummary.innerHTML = `Modelo: ${run.model || "?"} • Cumple: ${run.summary?.counts?.pass||0} • Falla: ${run.summary?.counts?.fail||0}${timingSuffix}`;
  
  const items = run.result?.items || [];
  els.resultsList.innerHTML = items.length ? "" : `<div class="meta-text" style="padding:0;">No hay criterios del Checklist en la ejecución.</div>`;

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "result-row";
    const status = item.status || "needs_review";
    
    // Left Col
    const metaCol = document.createElement("div");
    metaCol.className = "result-meta-col";
    metaCol.innerHTML = `
      <div class="result-index">Criterio ${(item.item_number||"?").toString().padStart(2, '0')}</div>
      <div class="result-title">${escapeHtml(state.checklistParsed?.items?.find(i=>i.id===item.item_id)?.title || item.item_id)}</div>
      <span class="status-tag ${escapeHtml(status)}">${escapeHtml(runItemStatusLabel(status))}</span>
      <div class="mono-text muted mt-auto">Conf.: ${Number.isFinite(Number(item.confidence)) ? Number(item.confidence).toFixed(2) : "n/d"}</div>
    `;

    // Right Col
    const dataCol = document.createElement("div");
    dataCol.className = "result-data-col";
    
    dataCol.innerHTML = `
      <div>
        <span class="rationale-label">Fundamentación del modelo</span>
        <div class="rationale-block">${escapeHtml(item.rationale || "No se proporcionó fundamentación.")}</div>
      </div>
    `;

    // Citations
    const citations = Array.isArray(item.citations) ? item.citations : [];
    if (citations.length > 0) {
      const citSection = document.createElement("div");
      citSection.innerHTML = `<span class="rationale-label">Citas de evidencia</span>`;
      const grid = document.createElement("div");
      grid.className = "evidence-grid";
      
      for (const cit of citations) {
        const card = document.createElement("div");
        const effectClass = citationEffectClass(cit.effect);
        card.className = `evidence-card ${effectClass}`;
        card.innerHTML = `
          <div class="evidence-topline">
            <span class="evidence-effect ${effectClass}">${citationEffectLabel(cit.effect)}</span>
            <span class="evidence-meta">${escapeHtml(cit.source_key || "?")} → ${escapeHtml(cit.anchor_id || "?")}</span>
          </div>
          <div class="evidence-quote">"${escapeHtml(cit.quote || "...")}"</div>
          <div class="evidence-reason">${escapeHtml(cit.reason || "N/D")}</div>
          <div class="evidence-meta">Validación: ${escapeHtml(citationValidationLabel(cit))}</div>
        `;
        const btn = document.createElement("button");
        btn.className = "action-btn outline sm evidence-action";
        btn.textContent = `Inspeccionar fuente: ${cit.source_key||"?"}`;
        btn.onclick = () => openCitation(cit);
        card.appendChild(btn);
        grid.appendChild(card);
      }
      citSection.appendChild(grid);
      dataCol.appendChild(citSection);
    }

    // Missing
    const missing = Array.isArray(item.missing_evidence) ? item.missing_evidence : [];
    if (missing.length > 0) {
      const missSection = document.createElement("div");
      missSection.innerHTML = `<span class="rationale-label">Evidencia faltante</span><div style="display:flex;gap:8px;flex-wrap:wrap;">${missing.map(m=>`<span class="badge" style="background:var(--status-warn-bg);color:var(--status-warn-fg);border:none;">${escapeHtml(m)}</span>`).join("")}</div>`;
      dataCol.appendChild(missSection);
    }

    row.appendChild(metaCol);
    row.appendChild(dataCol);
    els.resultsList.appendChild(row);
  }
}

async function loadBoards() {
  els.refreshBoardsBtn.disabled = true;
  setViewerState("Cargando tableros...");
  try {
    const data = await apiGet("/api/boards");
    state.boards = data.boards || [];
    els.identity.textContent = data.me?.fullName || data.me?.username || "Desconocido";
    renderBoards();
    const selectedStillExists = !!state.selectedBoard && state.boards.some((board) => board.id === state.selectedBoard.id);
    if (!selectedStillExists) {
      const preferredBoard = state.boards.find((board) => (board.name || "").trim() === PREFERRED_BOARD_NAME);
      if (preferredBoard) {
        selectBoard(preferredBoard, { statusMessage: `Se seleccionó por defecto ${PREFERRED_BOARD_NAME}. Cargando tarjetas...` });
        await loadCards();
      } else {
        state.selectedBoard = null;
        state.cards = [];
        renderBoards();
        renderCards();
        els.selectedBoardMeta.textContent = "No hay ningún tablero seleccionado.";
        setViewerState("No se encontró el tablero preferido.");
      }
    } else {
      setViewerState("Tableros cargados.");
    }
  } catch (err) {
    setViewerState(`Error al cargar tableros: ${err.message}`);
  } finally {
    els.refreshBoardsBtn.disabled = false;
  }
}

async function loadCards() {
  if (!state.selectedBoard) return;
  els.loadCardsBtn.disabled = true;
  const q = els.cardSearch.value.trim();
  const limit = els.cardLimit.value;
  setViewerState("Cargando tarjetas...");
  try {
    const data = await apiGet(`/api/boards/${state.selectedBoard.id}/cards?limit=${limit}&q=${encodeURIComponent(q)}`);
    state.cards = data.cards || [];
    renderCards();
    setViewerState(`Se cargaron ${state.cards.length} tarjetas.`);
  } catch (err) {
    setViewerState(`Error al cargar tarjetas: ${err.message}`);
  } finally {
    els.loadCardsBtn.disabled = false;
  }
}

async function loadCard(card) {
  const loadSeq = ++state.cardLoadSeq;
  state.selectedCard = card;
  state.workspace = null;
  state.workspaceStatus = null;
  state.currentPacket = null;
  state.currentMarkdown = "";
  state.runResult = null;
  state.tokenEstimate = { loading: true };
  renderCards();
  renderPacketViews();
  renderWorkspace();
  renderResults();
  renderTokenEstimate();
  els.cardBadge.textContent = card.name || card.id;
  setViewerState("Cargando paquete y estado de la revisión...");
  try {
    const packet = await apiGet(`/api/cards/${card.id}/packet`);
    if (loadSeq !== state.cardLoadSeq || state.selectedCard?.id !== card.id) return;
    state.currentPacket = packet.packet;
    state.currentMarkdown = packet.markdown || "";
    renderPacketViews();
    const statusPromise = apiPost(`/api/cards/${card.id}/workspace/status`, {
      cardPacket: state.currentPacket,
      multimodal_limit_bytes: getConfiguredMultimodalLimitBytes(),
    });
    refreshTokenEstimate();
    const status = await statusPromise;
    if (loadSeq !== state.cardLoadSeq || state.selectedCard?.id !== card.id) return;
    state.workspace = status.workspace || null;
    state.workspaceStatus = status.prep || null;
    syncCompletedCardFromWorkspace(card, state.workspace);
    renderWorkspace();
    renderCompletedCards();
    renderResults();
    setViewerState(state.workspaceStatus?.summary || "Tarjeta contextualizada.");
  } catch (err) {
    if (loadSeq !== state.cardLoadSeq || state.selectedCard?.id !== card.id) return;
    setViewerState(`Error de contexto: ${err.message}`);
    state.tokenEstimate = { error: err.message };
    state.workspaceStatus = {
      readyForRun: false,
      local: { items: [], stale: [] },
      remote: { items: [], stale: [] },
      summary: "No se pudo cargar el estado del espacio de trabajo.",
      state: "error",
      counts: {},
      actions: [],
    };
    renderWorkspace();
    renderCompletedCards();
    renderTokenEstimate();
  }
}

async function loadChecklist() {
  els.loadChecklistBtn.disabled = true;
  try {
    const data = await apiGet("/api/checklist");
    state.checklistParsed = data.parsed || null;
    state.checklistDraft = newChecklistDraft(state.checklistParsed);
    renderChecklistBuilder();
    renderChecklistEditorStatus(`Se cargaron ${state.checklistDraft.items.length} criterios.`);
    refreshTokenEstimate();
  } catch (err) {
    renderChecklistEditorStatus(`Falló la carga: ${err.message}`);
  } finally {
    els.loadChecklistBtn.disabled = false;
  }
}

async function saveChecklist() {
  els.saveChecklistBtn.disabled = true;
  try {
    const checklist = buildChecklistPayload();
    const data = await apiPost("/api/checklist", { checklist });
    state.checklistParsed = data.parsed || null;
    state.checklistDraft = newChecklistDraft(state.checklistParsed);
    renderChecklistBuilder();
    renderChecklistEditorStatus("Guardado correctamente.");
    refreshTokenEstimate();
  } catch (err) {
    renderChecklistEditorStatus(`Falló el guardado: ${err.message}`);
  } finally {
    els.saveChecklistBtn.disabled = false;
  }
}

async function resetChecklistToAppDefault() {
  els.resetChecklistBtn.disabled = true;
  try {
    const data = await apiPost("/api/checklist/reset", {});
    state.checklistParsed = data.parsed || null;
    state.checklistDraft = newChecklistDraft(state.checklistParsed);
    renderChecklistBuilder();
    renderChecklistEditorStatus("Se reemplazó por el Checklist predeterminado de la app.");
    refreshTokenEstimate();
  } catch (err) {
    renderChecklistEditorStatus(`Falló el restablecimiento: ${err.message}`);
  } finally {
    els.resetChecklistBtn.disabled = false;
  }
}

async function exportChecklist() {
  els.exportChecklistBtn.disabled = true;
  try {
    const data = await apiGet("/api/checklist");
    const name = slugify(data.parsed?.name || "checklist") || "checklist";
    downloadTextFile(`${name}.json`, data.text || JSON.stringify(data.parsed || {}, null, 2));
    renderChecklistEditorStatus("Checklist exportado.");
  } catch (err) {
    renderChecklistEditorStatus(`Falló la exportación: ${err.message}`);
  } finally {
    els.exportChecklistBtn.disabled = false;
  }
}

function promptChecklistImport() {
  if (!els.importChecklistInput) return;
  els.importChecklistInput.value = "";
  els.importChecklistInput.click();
}

async function importChecklistFile(file) {
  if (!file) return;
  els.importChecklistBtn.disabled = true;
  try {
    const text = await file.text();
    const data = await apiPost("/api/checklist", { text });
    state.checklistParsed = data.parsed || null;
    state.checklistDraft = newChecklistDraft(state.checklistParsed);
    renderChecklistBuilder();
    renderChecklistEditorStatus(`Se importó ${file.name}.`);
    refreshTokenEstimate();
  } catch (err) {
    renderChecklistEditorStatus(`Falló la importación: ${err.message}`);
  } finally {
    els.importChecklistBtn.disabled = false;
    if (els.importChecklistInput) els.importChecklistInput.value = "";
  }
}

async function loadWorkspaceStatus(cardPacket = state.currentPacket) {
  if (!state.selectedCard) return null;
  const status = await apiPost(`/api/cards/${state.selectedCard.id}/workspace/status`, {
    cardPacket,
    multimodal_limit_bytes: getConfiguredMultimodalLimitBytes(),
  });
  state.workspace = status.workspace || null;
  state.workspaceStatus = status.prep || null;
  renderWorkspace();
  return status;
}

async function createWorkspace() {
  if (!state.selectedCard) return;
  els.createWorkspaceBtn.disabled = true;
  try {
    state.workspace = await apiPost(`/api/cards/${state.selectedCard.id}/workspace/create`);
    await loadWorkspaceStatus();
    setViewerState("Carpeta de revisión inicializada.");
  } catch (err) { setViewerState(`Falló la inicialización: ${err.message}`); }
  finally { els.createWorkspaceBtn.disabled = false; }
}

function promptWorkspaceFilesImport() {
  if (!state.selectedCard || !els.uploadWorkspaceFilesInput) return;
  els.uploadWorkspaceFilesInput.value = "";
  els.uploadWorkspaceFilesInput.click();
}

async function importWorkspaceFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!state.selectedCard || !files.length) return;
  els.uploadWorkspaceFilesBtn.disabled = true;
  try {
    if (!state.workspace?.exists) {
      state.workspace = await apiPost(`/api/cards/${state.selectedCard.id}/workspace/create`);
    }
    const payloadFiles = [];
    for (const file of files) {
      const buffer = await file.arrayBuffer();
      payloadFiles.push({
        name: file.name,
        contentBase64: arrayBufferToBase64(buffer),
      });
    }
    await apiPost(`/api/cards/${state.selectedCard.id}/workspace/files/import`, { files: payloadFiles });
    await loadWorkspaceStatus(state.currentPacket);
    setViewerState(`Se importaron ${payloadFiles.length} archivo(s). Haz clic en Preparar revisión para indexarlos.`);
  } catch (err) {
    setViewerState(`Falló la carga: ${err.message}`);
  } finally {
    els.uploadWorkspaceFilesBtn.disabled = false;
    if (els.uploadWorkspaceFilesInput) els.uploadWorkspaceFilesInput.value = "";
  }
}

async function refreshWorkspace() {
  if (!state.selectedCard) return;
  try {
    const packet = await apiGet(`/api/cards/${state.selectedCard.id}/packet`);
    state.currentPacket = packet.packet;
    state.currentMarkdown = packet.markdown || "";
    renderPacketViews();
    await loadWorkspaceStatus(state.currentPacket);
    refreshTokenEstimate();
    setViewerState(state.workspaceStatus?.summary || "Estado actualizado.");
  } catch (err) { setViewerState(`Falló la actualización: ${err.message}`); }
}

function getExt(name) {
  const i = String(name || "").lastIndexOf(".");
  return i >= 0 ? String(name).slice(i).toLowerCase() : "";
}

function detectFileKind(name, mimeType = "") {
  const ext = getExt(name);
  const mime = (mimeType || "").toLowerCase();
  if (ext === ".docx" || mime.includes("wordprocessingml")) return "docx";
  if (ext === ".xlsx" || ext === ".xlsm" || mime.includes("spreadsheetml") || mime.includes("excel")) return "xlsx";
  if (ext === ".pdf" || mime === "application/pdf") return "pdf";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".heic"].includes(ext) || mime.startsWith("image/")) return "image";
  if ([".txt", ".md", ".csv", ".tsv"].includes(ext) || mime.startsWith("text/")) return "text";
  return "unknown";
}

async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function buildTextSegments(blocks, baseKind) {
  let n = 0;
  const segments = [];
  for (const block of blocks) {
    const text = normalizeWhitespace(block.text || "");
    if (!text) continue;
    n += 1;
    segments.push({
      anchor_id: block.anchor_id || `${baseKind}_${n}`,
      kind: block.kind || baseKind,
      text,
      page: block.page ?? null,
      sheet: block.sheet ?? null,
      meta: block.meta || {},
    });
  }
  return segments;
}

async function extractDocxIndex(arrayBuffer, meta) {
  if (!window.mammoth) throw new Error("La biblioteca Mammoth no se cargó");
  const result = await window.mammoth.convertToHtml({ arrayBuffer });
  const html = result.value || "";
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<body>${html}</body>`, "text/html");
  const body = doc.body;
  const selectors = "h1,h2,h3,h4,h5,h6,p,li,tr,blockquote";
  const blocks = [];
  let i = 0;
  body.querySelectorAll(selectors).forEach((el) => {
    const text = normalizeWhitespace(el.textContent || "");
    if (!text) return;
    i += 1;
    const anchorId = `block_${i}`;
    el.setAttribute("data-anchor-id", anchorId);
    blocks.push({
      anchor_id: anchorId,
      kind: "docx_block",
      text,
      meta: { tag: el.tagName.toLowerCase() },
    });
  });
  return {
    version: 1,
    file_kind: "docx",
    display_name: meta.displayName,
    file_name: meta.fileName,
    mime_type: meta.mimeType,
    content_hash: meta.contentHash,
    extracted_at: new Date().toISOString(),
    warnings: (result.messages || []).map((m) => `${m.type || "info"}: ${m.message || ""}`),
    render: {
      type: "html",
      html: body.innerHTML,
    },
    segments: buildTextSegments(blocks, "docx_block"),
  };
}

function decodeCellValue(cell) {
  if (!cell) return "";
  if (cell.w != null) return String(cell.w);
  if (cell.v == null) return "";
  return String(cell.v);
}

async function extractXlsxIndex(arrayBuffer, meta) {
  if (!window.XLSX) throw new Error("La biblioteca SheetJS no se cargó");
  const wb = window.XLSX.read(arrayBuffer, { type: "array", cellFormula: true, cellDates: true });
  const workbookPreview = [];
  const segments = [];
  let segCount = 0;

  for (const sheetName of wb.SheetNames || []) {
    const ws = wb.Sheets[sheetName];
    const ref = ws?.["!ref"];
    const sheetPreview = { sheet: sheetName, ref: ref || null, rows: [] };
    if (!ref) {
      workbookPreview.push(sheetPreview);
      continue;
    }
    const range = window.XLSX.utils.decode_range(ref);
    const maxRows = Math.min(range.e.r, range.s.r + 79);
    const maxCols = Math.min(range.e.c, range.s.c + 19);

    for (let r = range.s.r; r <= range.e.r; r += 1) {
      const rowCells = [];
      for (let c = range.s.c; c <= range.e.c; c += 1) {
        const addr = window.XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr];
        if (!cell) continue;
        const display = decodeCellValue(cell);
        const formula = cell.f ? String(cell.f) : null;
        if (display === "" && !formula) continue;

        const anchor = `${sheetName}!${addr}`;
        if (segCount < 6000) {
          segments.push({
            anchor_id: anchor,
            kind: "xlsx_cell",
            text: `${anchor} = ${display}${formula ? ` (fórmula: ${formula})` : ""}`,
            page: null,
            sheet: sheetName,
            meta: { cell: addr, formula },
          });
          segCount += 1;
        }

        if (r <= maxRows && c <= maxCols) {
          rowCells.push({ c, addr, display, formula });
        }
      }
      if (r <= maxRows) {
        sheetPreview.rows.push({ r, cells: rowCells });
      }
    }

    workbookPreview.push(sheetPreview);
  }

  return {
    version: 1,
    file_kind: "xlsx",
    display_name: meta.displayName,
    file_name: meta.fileName,
    mime_type: meta.mimeType,
    content_hash: meta.contentHash,
    extracted_at: new Date().toISOString(),
    warnings: [],
    render: {
      type: "xlsx_preview",
      workbook: workbookPreview,
      sheet_names: wb.SheetNames || [],
    },
    segments,
  };
}

function groupPdfItemsToPageText(items) {
  return items
    .map((it) => String(it.str || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

const PDF_OCR_MIN_TEXT_CHARS_PER_PAGE = 80;
const PDF_OCR_MIN_TEXT_ITEMS_PER_PAGE = 20;
const PDF_OCR_MIN_AVG_TEXT_CHARS_PER_PAGE = 120;

async function extractPdfIndex(arrayBuffer, meta) {
  if (!window.pdfjsLib) throw new Error("La biblioteca pdf.js no se cargó");
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const segments = [];
  const pages = [];
  let zeroTextPages = 0;
  let lowTextPages = 0;
  let totalTextChars = 0;
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    let text = "";
    let itemCount = 0;
    try {
      const tc = await page.getTextContent();
      itemCount = (tc.items || []).length;
      text = groupPdfItemsToPageText(tc.items || []);
    } catch {
      text = "";
    }
    const textLength = text.length;
    totalTextChars += textLength;
    const isZeroTextPage = textLength === 0;
    const isLowTextPage = textLength < PDF_OCR_MIN_TEXT_CHARS_PER_PAGE || itemCount < PDF_OCR_MIN_TEXT_ITEMS_PER_PAGE;
    if (isZeroTextPage) zeroTextPages += 1;
    if (isLowTextPage) lowTextPages += 1;
    const anchor = `page_${pageNum}`;
    segments.push({
      anchor_id: anchor,
      kind: "pdf_page",
      text,
      page: pageNum,
      sheet: null,
      meta: {
        width: viewport.width,
        height: viewport.height,
        text_item_count: itemCount,
        text_length: textLength,
        ocr_status: isZeroTextPage ? "image_only" : (isLowTextPage ? "low_text" : "text_available"),
      },
    });
    pages.push({ page: pageNum, width: viewport.width, height: viewport.height, textLength, anchor_id: anchor });
  }
  const pageCount = Math.max(pdf.numPages, 1);
  const avgTextCharsPerPage = totalTextChars / pageCount;
  const mostlyLowText = lowTextPages >= Math.ceil(pageCount / 2);
  const needsOcr = zeroTextPages > 0 || mostlyLowText || avgTextCharsPerPage < PDF_OCR_MIN_AVG_TEXT_CHARS_PER_PAGE;
  const warnings = [];
  if (zeroTextPages > 0) {
    warnings.push(`Hay ${zeroTextPages} página(s) sin texto extraíble; el PDF parece escaneado o basado en imágenes.`);
  }
  if (mostlyLowText && zeroTextPages === 0) {
    warnings.push(
      `El PDF tiene texto extraíble muy escaso en ${lowTextPages}/${pageCount} página(s); se tratará como candidato a OCR.`
    );
  } else if (avgTextCharsPerPage < PDF_OCR_MIN_AVG_TEXT_CHARS_PER_PAGE && warnings.length === 0) {
    warnings.push(
      `El PDF tiene poco texto extraíble en promedio (${Math.round(avgTextCharsPerPage)} caracteres por página); se tratará como candidato a OCR.`
    );
  }
  return {
    version: 1,
    file_kind: "pdf",
    display_name: meta.displayName,
    file_name: meta.fileName,
    mime_type: meta.mimeType,
    content_hash: meta.contentHash,
    extracted_at: new Date().toISOString(),
    warnings,
    render: {
      type: "pdf",
      page_count: pdf.numPages,
      pages,
      ocr_candidate: needsOcr,
      avg_text_chars_per_page: avgTextCharsPerPage,
      low_text_pages: lowTextPages,
      zero_text_pages: zeroTextPages,
    },
    segments,
  };
}

async function extractTextIndex(arrayBuffer, meta) {
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(arrayBuffer);
  } catch {
    text = new TextDecoder().decode(arrayBuffer);
  }
  const lines = String(text).split(/\r?\n/);
  const blocks = [];
  let buf = [];
  let n = 0;
  const flush = () => {
    const joined = normalizeWhitespace(buf.join("\n"));
    if (!joined) {
      buf = [];
      return;
    }
    n += 1;
    blocks.push({ anchor_id: `text_${n}`, kind: "text_block", text: joined, meta: {} });
    buf = [];
  };
  for (const line of lines) {
    if (!line.trim()) {
      flush();
    } else {
      buf.push(line);
    }
  }
  flush();
  return {
    version: 1,
    file_kind: "text",
    display_name: meta.displayName,
    file_name: meta.fileName,
    mime_type: meta.mimeType,
    content_hash: meta.contentHash,
    extracted_at: new Date().toISOString(),
    warnings: [],
    render: { type: "text", text: String(text).slice(0, 500000) },
    segments: buildTextSegments(blocks, "text_block"),
  };
}

async function imageDimensionsFromBuffer(arrayBuffer, mimeType) {
  return new Promise((resolve) => {
    const blob = new Blob([arrayBuffer], { type: mimeType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ width: null, height: null });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

async function extractImageIndex(arrayBuffer, meta) {
  const dims = await imageDimensionsFromBuffer(arrayBuffer, meta.mimeType);
  return {
    version: 1,
    file_kind: "image",
    display_name: meta.displayName,
    file_name: meta.fileName,
    mime_type: meta.mimeType,
    content_hash: meta.contentHash,
    extracted_at: new Date().toISOString(),
    warnings: ["Las citas de imagen siguen siendo a nivel de imagen completa; agrega OCR o anclas por región después para evidencia más precisa."],
    render: { type: "image", ...dims },
    segments: [
      {
        anchor_id: "image_full",
        kind: "image",
        text: "",
        page: null,
        sheet: null,
        meta: { ...dims },
      },
    ],
  };
}

async function extractUnknownIndex(meta) {
  return {
    version: 1,
    file_kind: "unknown",
    display_name: meta.displayName,
    file_name: meta.fileName,
    mime_type: meta.mimeType,
    content_hash: meta.contentHash,
    extracted_at: new Date().toISOString(),
    warnings: ["Tipo de archivo no compatible para extracción estructurada en este MVP."],
    render: { type: "none" },
    segments: [],
  };
}

async function buildIndexRecord({ source, cardId, displayName, fileName, mimeType, arrayBuffer, sourceLocator, localFile, trelloAttachment }) {
  const contentHash = await sha256Hex(arrayBuffer);
  const fileKind = detectFileKind(fileName, mimeType);
  const meta = { source, cardId, displayName, fileName, mimeType, contentHash };
  const contentBase64 = source === "trello" && ["image", "pdf"].includes(fileKind)
    ? arrayBufferToBase64(arrayBuffer.slice(0))
    : undefined;
  let index;
  try {
    if (fileKind === "docx") index = await extractDocxIndex(arrayBuffer, meta);
    else if (fileKind === "xlsx") index = await extractXlsxIndex(arrayBuffer, meta);
    else if (fileKind === "pdf") index = await extractPdfIndex(arrayBuffer, meta);
    else if (fileKind === "text") index = await extractTextIndex(arrayBuffer, meta);
    else if (fileKind === "image") index = await extractImageIndex(arrayBuffer, meta);
    else index = await extractUnknownIndex(meta);
  } catch (err) {
    index = await extractUnknownIndex(meta);
    const detail = err?.message || String(err || "error desconocido");
    index.warnings = [
      ...(Array.isArray(index.warnings) ? index.warnings : []),
      `No se pudo extraer como ${fileKind}; se guardó como índice genérico. ${detail}`,
    ];
  }

  return {
    source,
    sourceKey: source === "local" ? `local:${localFile.relativePath}` : `trello:${trelloAttachment.attachmentId}`,
    cardId,
    displayName,
    fileName,
    mimeType,
    contentHash,
    sourceLocator,
    localFile,
    trelloAttachment,
    contentBase64,
    index,
  };
}

async function fetchArrayBuffer(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} para ${url}`);
  const buf = await res.arrayBuffer();
  return { buffer: buf, contentType: res.headers.get("Content-Type") || "application/octet-stream" };
}

function localContentUrl(cardId, relativePath) {
  return `/api/cards/${encodeURIComponent(cardId)}/workspace/files/content?path=${encodeURIComponent(relativePath)}`;
}

function summarizeIndexFailures(failures) {
  if (!Array.isArray(failures) || !failures.length) return "";
  const preview = failures.slice(0, 3).map((item) => item.message).join(" | ");
  const suffix = failures.length > 3 ? ` | +${failures.length - 3} más` : "";
  return `${preview}${suffix}`;
}

async function indexLocalAttachments(filesOverride = null) {
  if (!state.selectedCard) return { savedCount: 0, failures: [] };
  if (!state.workspace?.exists) {
    setViewerState("Primero crea la carpeta del espacio de trabajo.");
    return { savedCount: 0, failures: [{ message: "No existe el espacio de trabajo." }] };
  }
  const files = filesOverride || state.workspaceStatus?.local?.items || state.workspace.localFiles || [];
  if (!files.length) {
    setViewerState("No se encontraron archivos locales en attachments/. Cópialos allí primero.");
    return { savedCount: 0, failures: [] };
  }
  els.indexLocalBtn.disabled = true;
  setViewerState(`Indexando ${files.length} archivo(s) local(es)...`);
  let savedCount = 0;
  const failures = [];
  try {
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      try {
        setViewerState(`Indexando local ${i + 1}/${files.length}: ${f.relativePath}`);
        const url = localContentUrl(state.selectedCard.id, f.relativePath);
        const { buffer, contentType } = await fetchArrayBuffer(url);
        const fileName = f.relativePath.split("/").pop() || f.relativePath;
        const record = await buildIndexRecord({
          source: "local",
          cardId: state.selectedCard.id,
          displayName: fileName,
          fileName,
          mimeType: contentType.split(";")[0] || "application/octet-stream",
          arrayBuffer: buffer,
          sourceLocator: { type: "local_file", relativePath: f.relativePath, url },
          localFile: { relativePath: f.relativePath },
        });
        await apiPost(`/api/cards/${state.selectedCard.id}/workspace/indexes`, { indexes: [record] });
        savedCount += 1;
      } catch (err) {
        failures.push({ message: `${f.relativePath}: ${err.message}` });
      }
    }
    await loadWorkspaceStatus(state.currentPacket);
    refreshTokenEstimate();
    if (failures.length) {
      setViewerState(`Se indexaron ${savedCount} archivo(s) local(es). Fallaron ${failures.length}: ${summarizeIndexFailures(failures)}`);
    } else {
      setViewerState(`Se indexaron ${savedCount} archivo(s) local(es).`);
    }
  } catch (err) {
    await loadWorkspaceStatus(state.currentPacket).catch(() => {});
    refreshTokenEstimate();
    setViewerState(`Falló la indexación local: ${err.message}`);
    failures.push({ message: err.message });
  } finally {
    els.indexLocalBtn.disabled = false;
  }
  return { savedCount, failures };
}

async function indexTrelloAttachments(attachmentsOverride = null) {
  if (!state.selectedCard || !state.currentPacket) return { savedCount: 0, failures: [] };
  const attachments = attachmentsOverride || state.workspaceStatus?.remote?.items || state.currentPacket.attachments || [];
  if (!attachments.length) {
    setViewerState("La tarjeta no tiene adjuntos de Trello para indexar.");
    return { savedCount: 0, failures: [] };
  }
  if (!state.workspace?.exists) {
    setViewerState("Primero crea la carpeta del espacio de trabajo.");
    return { savedCount: 0, failures: [{ message: "No existe el espacio de trabajo." }] };
  }
  els.indexTrelloBtn.disabled = true;
  setViewerState(`Indexando ${attachments.length} adjunto(s) de Trello...`);
  let savedCount = 0;
  const failures = [];
  try {
    for (let i = 0; i < attachments.length; i += 1) {
      const att = attachments[i];
      const attachmentId = att.id || att.attachmentId;
      const proxyUrl = att.proxyUrl;
      const fileName = att.fileName || att.name || `attachment_${attachmentId}`;
      if (!proxyUrl) {
        failures.push({ message: `${fileName}: falta proxyUrl` });
        continue;
      }
      try {
        setViewerState(`Indexando Trello ${i + 1}/${attachments.length}: ${fileName}`);
        const { buffer, contentType } = await fetchArrayBuffer(proxyUrl);
        const record = await buildIndexRecord({
          source: "trello",
          cardId: state.selectedCard.id,
          displayName: att.name || fileName,
          fileName,
          mimeType: (att.mimeType || contentType || "").split(";")[0],
          arrayBuffer: buffer,
          sourceLocator: { type: "trello_attachment", proxyUrl, sourceUrl: att.sourceUrl || att.url || null },
          trelloAttachment: {
            attachmentId,
            name: att.name || fileName,
            mimeType: att.mimeType || contentType,
            proxyUrl,
            sourceUrl: att.sourceUrl || att.url || null,
          },
        });
        await apiPost(`/api/cards/${state.selectedCard.id}/workspace/indexes`, { indexes: [record] });
        savedCount += 1;
      } catch (err) {
        failures.push({ message: `${fileName}: ${err.message}` });
      }
    }
    await loadWorkspaceStatus(state.currentPacket);
    refreshTokenEstimate();
    if (failures.length) {
      setViewerState(`Se indexaron ${savedCount} adjunto(s) de Trello. Fallaron ${failures.length}: ${summarizeIndexFailures(failures)}`);
    } else {
      setViewerState(`Se indexaron ${savedCount} adjunto(s) de Trello.`);
    }
  } catch (err) {
    await loadWorkspaceStatus(state.currentPacket).catch(() => {});
    refreshTokenEstimate();
    setViewerState(`Falló la indexación de Trello: ${err.message}`);
    failures.push({ message: err.message });
  } finally {
    els.indexTrelloBtn.disabled = false;
  }
  return { savedCount, failures };
}

async function prepareReview() {
  if (!state.selectedCard) return;
  els.prepareReviewBtn.disabled = true;
  setViewerState("Preparando revisión...");
  try {
    const packet = await apiGet(`/api/cards/${state.selectedCard.id}/packet`);
    state.currentPacket = packet.packet;
    state.currentMarkdown = packet.markdown || "";
    renderPacketViews();

    await loadWorkspaceStatus(state.currentPacket);
    if (!state.workspace?.exists) {
      state.workspace = await apiPost(`/api/cards/${state.selectedCard.id}/workspace/create`);
      await loadWorkspaceStatus(state.currentPacket);
    }

    const staleSourceKeys = [
      ...(state.workspaceStatus?.local?.stale || []).map((row) => row.sourceKey),
      ...(state.workspaceStatus?.remote?.stale || []).map((row) => row.sourceKey),
    ].filter(Boolean);
    if (staleSourceKeys.length) {
      await apiPost(`/api/cards/${state.selectedCard.id}/workspace/indexes/prune`, { sourceKeys: staleSourceKeys });
      await loadWorkspaceStatus(state.currentPacket);
    }

    const pendingLocal = (state.workspaceStatus?.local?.items || []).filter((row) =>
      ["not_indexed", "changed"].includes(row.indexStatus)
    );
    const localIndexResult = pendingLocal.length
      ? await indexLocalAttachments(pendingLocal)
      : { savedCount: 0, failures: [] };

    const pendingRemote = (state.workspaceStatus?.remote?.items || []).filter((row) =>
      ["not_indexed", "changed"].includes(row.indexStatus)
    );
    const remoteIndexResult = pendingRemote.length
      ? await indexTrelloAttachments(pendingRemote)
      : { savedCount: 0, failures: [] };

    await loadWorkspaceStatus(state.currentPacket);
    refreshTokenEstimate();
    const prepFailures = [
      ...(localIndexResult.failures || []),
      ...(remoteIndexResult.failures || []),
    ];
    if (prepFailures.length) {
      setViewerState(`Preparación incompleta. Fallaron ${prepFailures.length} archivo(s): ${summarizeIndexFailures(prepFailures)}`);
      return;
    }
    if (state.workspaceStatus?.readyForRun) {
      setViewerState("La revisión está preparada y lista para ejecutarse.");
    } else {
      setViewerState(state.workspaceStatus?.blockingMessage || state.workspaceStatus?.summary || "Se actualizó la preparación.");
    }
  } catch (err) {
    setViewerState(`Falló la preparación: ${err.message}`);
  } finally {
    els.prepareReviewBtn.disabled = false;
  }
}

async function runChecklist() {
  if (!state.selectedCard || !state.workspaceStatus?.readyForRun) return;
  if (hasActiveReviewJobForCard(state.selectedCard.id)) {
    setViewerState("Ya hay una revisión en curso para esta tarjeta. Sigue su estado en Recientes.");
    return;
  }
  els.runChecklistBtn.disabled = true;
  setViewerState("Encolando revisión...");
  try {
    const data = await apiPost(`/api/cards/${state.selectedCard.id}/workspace/run-async`, {
      model: getSelectedModel(),
      reasoning_effort: els.reasoningEffortSelect.value,
      cardPacket: state.currentPacket,
      multimodal_limit_bytes: getConfiguredMultimodalLimitBytes(),
    });
    if (data.job?.job_id) {
      state.dismissedReviewJobIds.delete(data.job.job_id);
      persistDismissedReviewJobIds();
    }
    await refreshReviewJobs({ silent: true });
    setViewerState(
      data.existing
        ? "La revisión ya estaba en curso. Sigue el progreso en Recientes."
        : "La revisión sigue ejecutándose en segundo plano. Puedes cambiar de tarjeta sin perder el resultado."
    );
  } catch (err) {
    setViewerState(`Falló la ejecución: ${err.message}`);
  } finally {
    renderWorkspace();
  }
}

async function refreshTokenEstimate() {
  const selectedCardId = state.selectedCard?.id;
  const cardPacket = state.currentPacket;
  if (!selectedCardId || !cardPacket) return;
  state.tokenEstimate = { loading: true };
  renderTokenEstimate();
  try {
    const data = await apiPost(`/api/cards/${selectedCardId}/workspace/token-estimate`, {
      model: getSelectedModel(),
      cardPacket,
      multimodal_limit_bytes: getConfiguredMultimodalLimitBytes(),
    });
    if (selectedCardId !== state.selectedCard?.id || cardPacket !== state.currentPacket) return;
    state.tokenEstimate = data.estimate || { error: "Error desconocido" };
    renderTokenEstimate();
  } catch (err) {
    if (selectedCardId !== state.selectedCard?.id || cardPacket !== state.currentPacket) return;
    state.tokenEstimate = { error: err.message };
    renderTokenEstimate();
  }
}

async function loadRunById(cardId, runId) {
  state.runResult = await apiGet(`/api/cards/${cardId}/workspace/runs/${encodeURIComponent(runId)}`);
  renderResults();
}

async function loadSelectedRun() {
  if (!state.selectedCard || !els.runHistorySelect.value) return;
  try {
    await loadRunById(state.selectedCard.id, els.runHistorySelect.value);
    setViewerState("Historial cargado.");
  } catch (err) { setViewerState(`Falló la carga del historial: ${err.message}`); }
}

/* Modals & Citations */
async function getIndexBySourceKey(sourceKey) {
  if (state.indexCache.has(sourceKey)) return state.indexCache.get(sourceKey);
  const data = await apiGet(`/api/cards/${state.selectedCard.id}/workspace/index?sourceKey=${encodeURIComponent(sourceKey)}`);
  state.indexCache.set(sourceKey, data);
  return data;
}

function clearCitationHighlights(root) {
  root?.querySelectorAll?.(".cited-anchor").forEach((el) => el.classList.remove("cited-anchor"));
  root?.querySelectorAll?.(".quote-highlight").forEach((el) => {
    el.replaceWith(document.createTextNode(el.textContent || ""));
  });
  root?.querySelectorAll?.(".pdf-highlight-rect").forEach((el) => el.remove());
}

function highlightQuoteInElement(el, quote) {
  const q = String(quote || "").trim();
  if (!q || !el) return;
  const text = el.textContent || "";
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let pos = 0;
  const targets = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const len = node.nodeValue?.length || 0;
    const start = pos;
    const end = pos + len;
    const qStart = idx;
    const qEnd = idx + q.length;
    if (qStart < end && qEnd > start) {
      targets.push({ node, start: Math.max(0, qStart - start), end: Math.min(len, qEnd - start) });
    }
    pos = end;
    if (pos >= qEnd) break;
  }
  for (const t of targets.reverse()) {
    const value = t.node.nodeValue || "";
    const before = value.slice(0, t.start);
    const middle = value.slice(t.start, t.end);
    const after = value.slice(t.end);
    const frag = document.createDocumentFragment();
    if (before) frag.append(document.createTextNode(before));
    const mark = document.createElement("mark");
    mark.className = "quote-highlight";
    mark.textContent = middle;
    frag.append(mark);
    if (after) frag.append(document.createTextNode(after));
    t.node.parentNode?.replaceChild(frag, t.node);
  }
}

function normalizeLoosePdfMatchText(text) {
  return String(text || "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildPdfItemMatchIndex(textItems) {
  const parts = [];
  const itemRanges = [];
  let cursor = 0;
  for (let i = 0; i < textItems.length; i += 1) {
    const item = textItems[i];
    const raw = String(item?.str || "");
    const norm = normalizeLoosePdfMatchText(raw);
    if (!norm) continue;
    if (parts.length) {
      parts.push(" ");
      cursor += 1;
    }
    const start = cursor;
    parts.push(norm);
    cursor += norm.length;
    itemRanges.push({ itemIndex: i, start, end: cursor });
  }
  return {
    normalizedText: parts.join(""),
    itemRanges,
  };
}

function findPdfQuoteItemIndices(textItems, quote, opts = {}) {
  const q = normalizeLoosePdfMatchText(quote);
  if (!q) return [];
  const { normalizedText, itemRanges } = buildPdfItemMatchIndex(textItems);
  if (!normalizedText) return [];

  const matchStart = normalizedText.indexOf(q);
  if (matchStart >= 0) {
    const matchEnd = matchStart + q.length;
    return itemRanges
      .filter((r) => r.start < matchEnd && r.end > matchStart)
      .map((r) => r.itemIndex);
  }

  if (!opts.allowTokenFallback) return [];

  const qTokens = q.split(/\s+/).filter((t) => t.length >= 3);
  if (qTokens.length < 4) return [];
  const matched = [];
  for (let i = 0; i < textItems.length; i += 1) {
    const norm = normalizeLoosePdfMatchText(textItems[i]?.str || "");
    if (!norm) continue;
    const hits = qTokens.filter((t) => norm.includes(t)).length;
    if (hits > 0) matched.push({ i, hits, len: norm.length });
  }
  matched.sort((a, b) => b.hits - a.hits || a.len - b.len);
  const best = matched
    .slice(0, Math.min(6, matched.length))
    .filter((m) => m.hits >= Math.max(2, Math.floor(qTokens.length / 3)));
  return best.map((m) => m.i);
}

function pdfItemToViewportRect(pdfjsLib, viewport, item) {
  if (!item?.transform) return null;
  const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
  const x = tx[4];
  const y = tx[5];
  const width = Math.max(1, (Number(item.width) || 0) * viewport.scale);
  const height = Math.max(1, (Number(item.height) || 0) * viewport.scale);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { x, y: y - height, width, height };
}

function renderPdfHighlightRects(layer, rects) {
  if (!layer || !Array.isArray(rects)) return 0;
  let count = 0;
  for (const rect of rects) {
    if (!rect) continue;
    const el = document.createElement("div");
    el.className = "pdf-highlight-rect";
    el.style.left = `${Math.max(0, rect.x)}px`;
    el.style.top = `${Math.max(0, rect.y)}px`;
    el.style.width = `${Math.max(1, rect.width)}px`;
    el.style.height = `${Math.max(1, rect.height)}px`;
    layer.appendChild(el);
    count += 1;
  }
  return count;
}

async function openCitation(citation) {
  try {
    if (!citation?.source_key) throw new Error("La cita no incluye source_key");
    setViewerState(`Abriendo evidencia ${citation.source_key} → ${citation.anchor_id}...`);
    const indexResp = await getIndexBySourceKey(citation.source_key);
    els.modalCitationTitle.textContent = `${citation.source_key} → ${citation.anchor_id}`;
    els.modalCitationMeta.textContent = [
      `${citationEffectLabel(citation.effect)}`,
      `validación=${citationValidationLabel(citation)}`,
      citation.page ? `página=${citation.page}` : null,
      citation.sheet ? `hoja=${citation.sheet}` : null,
    ].filter(Boolean).join(" • ");
    await renderCitationDocument(indexResp, citation);
    els.citationModal.setAttribute("aria-hidden", "false");
    setViewerState(`Evidencia abierta (${citationValidationLabel(citation)}).`);
  } catch (err) {
    setViewerState(`No se pudo abrir la evidencia: ${err.message}`);
  }
}

function sourceLocatorToFetchUrl(summary) {
  const loc = summary?.source_locator || summary?.sourceLocator || {};
  if (loc.type === "local_file" && loc.relativePath && state.selectedCard) {
    return localContentUrl(state.selectedCard.id, loc.relativePath);
  }
  if (loc.type === "trello_attachment" && loc.proxyUrl) {
    return loc.proxyUrl;
  }
  return null;
}

async function renderCitationDocument(indexResp, citation) {
  const summary = indexResp.summary || {};
  const index = indexResp.index || {};
  const fileKind = index.file_kind || summary.file_kind || "unknown";
  els.citationDocView.innerHTML = "";
  clearCitationHighlights(els.citationDocView);

  if (fileKind === "docx") {
    renderDocxCitation(index, citation);
    return;
  }
  if (fileKind === "xlsx") {
    renderXlsxCitation(index, citation);
    return;
  }
  if (fileKind === "pdf") {
    await renderPdfCitation(indexResp, citation);
    return;
  }
  if (fileKind === "image") {
    renderImageCitation(indexResp, citation);
    return;
  }
  if (fileKind === "text") {
    renderTextCitation(index, citation);
    return;
  }
  els.citationDocView.innerHTML = `<div class="json-box">No hay visor compatible para <code>${escapeHtml(fileKind)}</code>.</div>`;
}

function renderDocxCitation(index, citation) {
  const html = index?.render?.html || "";
  const box = document.createElement("div");
  box.className = "docx-html-box";
  box.innerHTML = html || "<p class='inline-meta'>No hay una vista previa HTML de DOCX almacenada.</p>";
  els.citationDocView.appendChild(box);
  const target = box.querySelector(`[data-anchor-id="${CSS.escape(citation.anchor_id || "")}"]`);
  if (target) {
    target.classList.add("cited-anchor");
    highlightQuoteInElement(target, citation.quote || "");
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function colIndexToName(index) {
  let n = Number(index) + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function renderXlsxCitation(index, citation) {
  const wrapper = document.createElement("div");
  wrapper.className = "xlsx-box";
  const wb = index?.render?.workbook || [];
  if (!wb.length) {
    wrapper.textContent = "No hay una vista previa del libro almacenada.";
    els.citationDocView.appendChild(wrapper);
    return;
  }

  const targetAnchor = citation.anchor_id || "";
  const sheetHint = citation.sheet || (targetAnchor.includes("!") ? targetAnchor.split("!")[0] : null);
  const activeSheet = wb.find((s) => s.sheet === sheetHint) || wb[0];

  const sheetPicker = document.createElement("div");
  sheetPicker.className = "pdf-toolbar";
  const label = document.createElement("span");
  label.textContent = `Hoja: ${activeSheet.sheet}`;
  sheetPicker.appendChild(label);
  wrapper.appendChild(sheetPicker);

  const table = document.createElement("table");
  table.className = "xlsx-table";
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  table.appendChild(thead);
  table.appendChild(tbody);

  const rows = activeSheet.rows || [];
  const colSet = new Set();
  for (const row of rows) {
    for (const cell of row.cells || []) colSet.add(cell.c);
  }
  const cols = Array.from(colSet).sort((a, b) => a - b).slice(0, 20);

  const headTr = document.createElement("tr");
  const rowHead = document.createElement("th");
  rowHead.textContent = "Fila";
  headTr.appendChild(rowHead);
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = colIndexToName(c);
    headTr.appendChild(th);
  }
  thead.appendChild(headTr);

  for (const row of rows.slice(0, 80)) {
    const tr = document.createElement("tr");
    const rowLabel = document.createElement("th");
    rowLabel.textContent = String((row.r || 0) + 1);
    tr.appendChild(rowLabel);
    const cellsByCol = new Map((row.cells || []).map((c) => [c.c, c]));
    for (const c of cols) {
      const td = document.createElement("td");
      const cell = cellsByCol.get(c);
      if (cell) {
        td.setAttribute("data-cell-anchor", `${activeSheet.sheet}!${cell.addr}`);
        td.textContent = cell.display || "";
        if (cell.formula) td.title = `fórmula: ${cell.formula}`;
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  wrapper.appendChild(table);
  els.citationDocView.appendChild(wrapper);

  const target = wrapper.querySelector(`[data-cell-anchor="${CSS.escape(targetAnchor)}"]`);
  if (target) {
    target.classList.add("cited-anchor");
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function renderTextCitation(index, citation) {
  const wrap = document.createElement("div");
  wrap.className = "json-box";
  const pre = document.createElement("pre");
  pre.style.margin = "0";
  pre.textContent = index?.render?.text || "No hay vista previa de texto.";
  wrap.appendChild(pre);
  els.citationDocView.appendChild(wrap);

  const seg = (index.segments || []).find((s) => s.anchor_id === citation.anchor_id);
  if (seg) {
    const note = document.createElement("div");
    note.className = "inline-meta";
    note.textContent = `Ancla: ${seg.anchor_id} • Cita: ${citation.quote || ""}`;
    els.citationDocView.prepend(note);
  }
}

function renderImageCitation(indexResp, citation) {
  const summary = indexResp.summary || {};
  const fetchUrl = sourceLocatorToFetchUrl(summary);
  const wrap = document.createElement("div");
  wrap.className = "docx-html-box";
  if (!fetchUrl) {
    wrap.textContent = "La fuente de la imagen no está disponible.";
    els.citationDocView.appendChild(wrap);
    return;
  }
  wrap.innerHTML = `
    <div class="inline-meta">Las citas de imagen son a nivel de imagen completa en este MVP (todavía sin anclas por región).</div>
    <img src="${escapeHtml(fetchUrl)}" alt="imagen citada" style="max-width:100%; height:auto; margin-top:8px; border-radius:8px; border:1px solid rgba(33,31,28,0.08);" />
    <div class="inline-meta" style="margin-top:8px;">Motivo: ${escapeHtml(citation.reason || "")}</div>
  `;
  els.citationDocView.appendChild(wrap);
}

async function getPdfDocForSource(indexResp) {
  const summary = indexResp.summary || {};
  const sourceKey = indexResp.sourceKey;
  if (state.pdfCache.has(sourceKey)) return state.pdfCache.get(sourceKey);
  const fetchUrl = sourceLocatorToFetchUrl(summary);
  if (!fetchUrl) throw new Error("La fuente binaria del PDF no está disponible");
  const { buffer } = await fetchArrayBuffer(fetchUrl);
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  state.pdfCache.set(sourceKey, { pdf, buffer });
  return { pdf, buffer };
}

async function renderPdfCitation(indexResp, citation) {
  if (!window.pdfjsLib) throw new Error("La biblioteca pdf.js no se cargó");
  const index = indexResp.index || {};
  const pageFromAnchor = Number(String(citation.anchor_id || "").replace("page_", ""));
  const pageNum = Number.isFinite(pageFromAnchor) && pageFromAnchor > 0 ? pageFromAnchor : Math.max(1, Number(citation.page) || 1);

  const wrap = document.createElement("div");
  wrap.className = "doc-canvas-wrap";
  const toolbar = document.createElement("div");
  toolbar.className = "pdf-toolbar";
  const pageLabel = document.createElement("span");
  pageLabel.textContent = `Página ${pageNum}`;
  toolbar.appendChild(pageLabel);
  wrap.appendChild(toolbar);

  const canvasBox = document.createElement("div");
  canvasBox.className = "pdf-canvas-box";
  const stage = document.createElement("div");
  stage.className = "pdf-page-stage";
  const canvas = document.createElement("canvas");
  canvas.className = "pdf-page-canvas";
  const highlightLayer = document.createElement("div");
  highlightLayer.className = "pdf-highlight-layer";
  stage.appendChild(canvas);
  stage.appendChild(highlightLayer);
  canvasBox.appendChild(stage);
  wrap.appendChild(canvasBox);

  const textBox = document.createElement("div");
  textBox.className = "pdf-text-box";
  const pageSeg = (index.segments || []).find((s) => s.anchor_id === (citation.anchor_id || `page_${pageNum}`));
  const pageText = pageSeg?.text || "";
  textBox.innerHTML = `<div data-anchor-id="${escapeHtml(pageSeg?.anchor_id || `page_${pageNum}`)}">${escapeHtml(pageText || "(No hay texto extraíble en esta página. Posiblemente es un PDF escaneado o solo de imagen.)")}</div>`;
  wrap.appendChild(textBox);

  els.citationDocView.appendChild(wrap);

  const { pdf } = await getPdfDocForSource(indexResp);
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1.2 });
  const ctx = canvas.getContext("2d");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  stage.style.width = `${viewport.width}px`;
  stage.style.height = `${viewport.height}px`;
  await page.render({ canvasContext: ctx, viewport }).promise;

  let nativeHighlightCount = 0;
  try {
    const textContent = await page.getTextContent();
    const textItems = Array.isArray(textContent?.items) ? textContent.items : [];
    const matchIndices = findPdfQuoteItemIndices(textItems, citation.quote || "", { allowTokenFallback: true });
    if (matchIndices.length) {
      const rects = matchIndices
        .map((i) => pdfItemToViewportRect(window.pdfjsLib, viewport, textItems[i]))
        .filter(Boolean);
      nativeHighlightCount = renderPdfHighlightRects(highlightLayer, rects);
    }
  } catch {
    nativeHighlightCount = 0;
  }

  const anchorEl = textBox.querySelector(`[data-anchor-id="${CSS.escape(pageSeg?.anchor_id || `page_${pageNum}`)}"]`);
  if (anchorEl) {
    anchorEl.classList.add("cited-anchor");
    highlightQuoteInElement(anchorEl, citation.quote || "");
  }

  const highlightMeta = document.createElement("div");
  highlightMeta.className = "inline-meta";
  if (nativeHighlightCount > 0) {
    highlightMeta.textContent = `Se aplicó resaltado dentro del documento en la página PDF (${nativeHighlightCount} región${nativeHighlightCount === 1 ? "" : "es"} de texto).`;
  } else {
    highlightMeta.textContent = "No hay resaltado dentro del documento disponible para esta cita en la capa de texto de la página. Se muestra abajo el resaltado del texto extraído.";
  }
  toolbar.appendChild(highlightMeta);
}

function bindEvents() {
  els.refreshBoardsBtn.onclick = loadBoards;
  els.boardSearch.oninput = renderBoards;
  els.loadCardsBtn.onclick = loadCards;
  els.cardSearch.onkeydown = (e) => { if (e.key === "Enter") loadCards(); };
  els.sectionToggles.forEach((toggle) => {
    toggle.onclick = () => toggleSidebarSection(toggle.dataset.sectionToggle);
  });
  
  els.prepareReviewBtn.onclick = prepareReview;
  els.uploadWorkspaceFilesBtn.onclick = promptWorkspaceFilesImport;
  els.createWorkspaceBtn.onclick = createWorkspace;
  els.refreshWorkspaceBtn.onclick = refreshWorkspace;
  els.indexLocalBtn.onclick = () => indexLocalAttachments();
  els.indexTrelloBtn.onclick = () => indexTrelloAttachments();
  els.runChecklistBtn.onclick = runChecklist;
  els.loadRunBtn.onclick = loadSelectedRun;
  els.runHistorySelect.onchange = loadSelectedRun;
  
  els.loadChecklistBtn.onclick = loadChecklist;
  els.resetChecklistBtn.onclick = resetChecklistToAppDefault;
  els.importChecklistBtn.onclick = promptChecklistImport;
  els.exportChecklistBtn.onclick = exportChecklist;
  els.importChecklistInput.onchange = (e) => importChecklistFile(e.target.files?.[0]);
  els.uploadWorkspaceFilesInput.onchange = (e) => importWorkspaceFiles(e.target.files);
  els.saveChecklistBtn.onclick = saveChecklist;
  els.addChecklistItemBtn.onclick = () => { ensureChecklistDraft().items.push(newChecklistItemDraft()); renderChecklistBuilder(); };
  
  els.reasoningEffortSelect.onchange = refreshTokenEstimate;
  els.modelInput.onchange = () => {
    persistSelectedModel();
    refreshTokenEstimate();
  };
  els.multimodalLimitInput.onchange = handleMultimodalLimitChange;

  // Tabs
  els.ptabs.forEach(b => b.onclick = () => setMainTab(b.dataset.ptab));
  els.innerTabs.forEach(b => b.onclick = () => setActiveInnerTab(b.dataset.tab));

  // Modal Close
  els.closeModalBtn.onclick = () => els.citationModal.setAttribute("aria-hidden", "true");
  els.citationModal.onclick = (e) => { if(e.target === els.citationModal) els.citationModal.setAttribute("aria-hidden", "true"); };
}

function configurePdfJs() {
  if (!window.pdfjsLib) return;
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

function verifyLibraries() {
  const missing = [];
  if (!window.mammoth) missing.push("mammoth");
  if (!window.XLSX) missing.push("xlsx");
  if (!window.pdfjsLib) missing.push("pdf.js");
  if (missing.length) {
    setViewerState(`No se pudieron cargar algunas bibliotecas del visor o indexador: ${missing.join(", ")}`);
  }
}

async function init() {
  state.dismissedReviewJobIds = loadDismissedReviewJobIds();
  state.collapsedSections = loadCollapsedSections();
  if (els.multimodalLimitInput) {
    els.multimodalLimitInput.value = String(loadMultimodalLimitMb());
  }
  bindEvents();
  syncFixedModelUi();
  renderSidebarSections();
  configurePdfJs();
  verifyLibraries();
  renderChecklistBuilder();
  renderCompletedCards();
  renderRecentJobs();
  renderWorkspace();
  renderResults();
  startReviewJobsPolling();
  await Promise.all([loadChecklist(), loadBoards(), loadCompletedCardsSnapshot()]);
}

init();
