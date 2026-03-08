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
  indexCache: new Map(),
  pdfCache: new Map(),
};

const PREFERRED_BOARD_NAME = "IG Tramitacion Training";

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
  boardItemTpl: document.getElementById("boardItemTpl"),
  cardItemTpl: document.getElementById("cardItemTpl"),
};

function fmtDate(value) {
  if (!value) return "n/a";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function bytesLabel(n) {
  if (!Number.isFinite(n)) return "n/a";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / (1024 ** 2)).toFixed(1)} MB`;
  return `${(n / (1024 ** 3)).toFixed(1)} GB`;
}

async function apiGet(path) {
  const res = await fetch(path, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
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
      const alt = escapeHtml(imageMatch[1] || "image");
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
    if (["_No attachments_", "_No comments_", "_No image assets_", "_No checklists_"].includes(trimmed)) {
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
    btn.textContent = board.name || "(unnamed board)";
    if (state.selectedBoard?.id === board.id) btn.classList.add("active");
    btn.addEventListener("click", () => selectBoard(board));
    els.boardsList.appendChild(node);
  }

  if (!state.filteredBoards.length) els.boardsList.innerHTML = `<li class="meta-text" style="padding:0 24px;">No boards match.</li>`;
}

function selectBoard(board, { statusMessage = "Board selected. Load cards." } = {}) {
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
  els.selectedBoardMeta.textContent = `ID: ${board.id} • Activity: ${fmtDate(board.dateLastActivity)}`;
  els.cardBadge.textContent = "No Card Selected";
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
    btn.querySelector(".title").textContent = card.name || "(unnamed card)";
    const extra = [];
    if (card.labels?.length) extra.push(`${card.labels.length} lbls`);
    if (card.due) extra.push(`Due ${fmtDate(card.due)}`);
    extra.push(`Act ${fmtDate(card.dateLastActivity)}`);
    btn.querySelector(".sub").textContent = extra.join(" • ");
    if (state.selectedCard?.id === card.id) btn.classList.add("active");
    btn.addEventListener("click", () => loadCard(card));
    els.cardsList.appendChild(node);
  }
  
  if (!state.cards.length) els.cardsList.innerHTML = `<li class="meta-text" style="padding:0 24px;">No cards loaded.</li>`;
  else if (!visibleCards.length) els.cardsList.innerHTML = `<li class="meta-text" style="padding:0 24px;">No matches.</li>`;
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
    els.tokenEstimate.textContent = "No card selected.";
    return;
  }
  const est = state.tokenEstimate;
  if (!est) { els.tokenEstimate.textContent = "Not calculated."; return; }
  if (est.loading) { els.tokenEstimate.textContent = "Calculating..."; return; }
  
  const total = est.counts?.total_input_tokens;
  const docs = est.payload_stats?.evidence_documents ?? 0;
  const segs = est.payload_stats?.evidence_segments ?? 0;
  const items = est.payload_stats?.checklist_items ?? 0;
  
  if (Number.isFinite(total)) {
    const notes = Array.isArray(est.notes) && est.notes.length
      ? `<br/><br/><span class="meta-text">${escapeHtml(est.notes[0])}</span>`
      : "";
    els.tokenEstimate.innerHTML = `<strong>Total: ${total.toLocaleString()} tokens</strong><br/><br/>Evidence: ${docs} docs (${segs} segs)<br/>Items: ${items}${notes}`;
  } else {
    els.tokenEstimate.textContent = est.error ? `Error: ${est.error}` : "Unavailable";
  }
}

function indexStatusLabel(status) {
  return ({
    indexed: "Indexed",
    not_indexed: "Needs indexing",
    changed: "Changed",
    missing: "Stale",
  })[status] || "Unknown";
}

function indexStatusTone(status) {
  if (status === "indexed") return "ready";
  if (status === "missing") return "stale";
  return "pending";
}

function renderWorkspaceItem(item, kind) {
  const name = item.relativePath || item.name || item.fileName || item.attachmentId || "?";
  const primaryMeta = kind === "local" ? bytesLabel(item.size) : (item.mimeType || "unknown");
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
  const actions = Array.isArray(prep?.actions) && prep.actions.length
    ? `<div class="workspace-next"><strong>Next:</strong> ${escapeHtml(prep.actions.join(" "))}</div>`
    : "";
  const folder = ws?.attachmentsPath
    ? `<div><strong>Folder:</strong> ${escapeHtml(ws.attachmentsPath)}</div>`
    : "";
  return `
    <div class="workspace-status-line">
      <span class="data-item-status ${tone}">${escapeHtml(prep?.readyForRun ? "Ready" : "Needs Prep")}</span>
      <strong>${escapeHtml(prep?.summary || "Status unavailable.")}</strong>
    </div>
    <div>Evidence: ${counts.evidenceDocs ?? 0} indexed source(s)</div>
    <div>Local: ${counts.localIndexed ?? 0}/${counts.localTotal ?? 0} ready • Trello: ${counts.remoteIndexed ?? 0}/${counts.remoteTotal ?? 0} ready</div>
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
  els.runChecklistBtn.disabled = !state.workspaceStatus?.readyForRun;

  if (!hasCard) {
    els.workspaceMeta.textContent = "No card selected.";
    els.localFilesList.innerHTML = `<li class="data-item"><span class="meta-text" style="padding:0;">Select a card.</span></li>`;
    els.indexesList.innerHTML = `<li class="data-item"><span class="meta-text" style="padding:0;">Select a card.</span></li>`;
    return;
  }

  if (!state.workspaceStatus) {
    els.workspaceMeta.textContent = "Loading status...";
    els.localFilesList.innerHTML = `<li class="data-item"><span class="meta-text" style="padding:0;">Loading...</span></li>`;
    els.indexesList.innerHTML = `<li class="data-item"><span class="meta-text" style="padding:0;">Loading...</span></li>`;
    return;
  }

  const ws = state.workspace;
  const prep = state.workspaceStatus;
  els.workspaceMeta.innerHTML = renderPrepSummary(ws, prep);

  const localFiles = prep.local?.items || [];
  const staleLocal = prep.local?.stale || [];
  if (!localFiles.length) {
    const emptyLabel = hasWorkspace
      ? `No local files found${ws?.attachmentsPath ? ` in ${escapeHtml(ws.attachmentsPath)}` : ""}.`
      : "Prepare review to create the local folder.";
    els.localFilesList.innerHTML = `<li class="data-item"><span class="meta-text" style="padding:0;">${emptyLabel}</span></li>`;
  } else {
    els.localFilesList.innerHTML = localFiles.map((row) => renderWorkspaceItem(row, "local")).join("");
  }
  if (staleLocal.length) els.localFilesList.innerHTML += staleLocal.map((row) => renderWorkspaceItem(row, "local")).join("");

  const remoteItems = prep.remote?.items || [];
  const staleRemote = prep.remote?.stale || [];
  if (!remoteItems.length) {
    els.indexesList.innerHTML = `<li class="data-item"><span class="meta-text" style="padding:0;">No Trello attachments on this card.</span></li>`;
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
    name: String(seed.name || "Standard Review"),
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
          <label>Criterion Title</label>
          <input type="text" data-field="title" value="${escapeHtml(item.title || "")}" />
        </div>
        <div class="field-group full-width">
          <label>Description</label>
          <textarea rows="2" data-field="description">${escapeHtml(item.description || "")}</textarea>
        </div>
        <div class="field-group">
          <label>Pass Criteria</label>
          <textarea rows="2" data-field="pass_criteria">${escapeHtml(item.pass_criteria || "")}</textarea>
        </div>
        <div class="field-group">
          <label>Fail Criteria</label>
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

    const delBtn = document.createElement("button"); delBtn.className = "action-btn outline sm btn-danger"; delBtn.textContent = "Remove";
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
  draft.name = els.checklistNameInput.value.trim() || "Standard Review";
  draft.instructions = els.checklistInstructionsInput.value.trim();
  const seen = new Set();
  const items = draft.items.map((item, idx) => {
    const title = item.title || `Item ${idx+1}`;
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
    supports: "Supports",
    contradicts: "Contradicts",
    insufficient: "Insufficient",
  }[citationEffectClass(effect)];
}

function citationValidationLabel(citation) {
  const status = citation?.validation?.status || "unvalidated";
  const score = citation?.validation?.score;
  return Number.isFinite(Number(score)) ? `${status} (${Number(score).toFixed(2)})` : status;
}

function renderRunHistorySelect() {
  const runs = state.workspace?.runs || [];
  els.runHistorySelect.innerHTML = "";
  if (!runs.length) {
    els.runHistorySelect.innerHTML = `<option value="">No history</option>`;
    els.loadRunBtn.disabled = true;
    return;
  }
  for (const r of runs) {
    const opt = document.createElement("option");
    opt.value = r.run_id;
    opt.textContent = `${fmtDate(r.created_at)} • p:${r.counts?.pass||0} f:${r.counts?.fail||0}`;
    els.runHistorySelect.appendChild(opt);
  }
  els.loadRunBtn.disabled = false;
}

function renderResults() {
  const run = state.runResult;
  if (!run) {
    els.runSummary.textContent = "No run loaded.";
    els.resultsList.innerHTML = "";
    return;
  }

  els.runSummary.innerHTML = `Model: ${run.model || "?"} • Pass: ${run.summary?.counts?.pass||0} • Fail: ${run.summary?.counts?.fail||0}`;
  
  const items = run.result?.items || [];
  els.resultsList.innerHTML = items.length ? "" : `<div class="meta-text" style="padding:0;">No checklist items in run.</div>`;

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "result-row";
    const status = item.status || "needs_review";
    
    // Left Col
    const metaCol = document.createElement("div");
    metaCol.className = "result-meta-col";
    metaCol.innerHTML = `
      <div class="result-index">Item ${(item.item_number||"?").toString().padStart(2, '0')}</div>
      <div class="result-title">${escapeHtml(state.checklistParsed?.items?.find(i=>i.id===item.item_id)?.title || item.item_id)}</div>
      <span class="status-tag ${escapeHtml(status)}">${escapeHtml(status)}</span>
      <div class="mono-text muted mt-auto">Conf: ${Number.isFinite(Number(item.confidence)) ? Number(item.confidence).toFixed(2) : "n/a"}</div>
    `;

    // Right Col
    const dataCol = document.createElement("div");
    dataCol.className = "result-data-col";
    
    dataCol.innerHTML = `
      <div>
        <span class="rationale-label">Model Rationale</span>
        <div class="rationale-block">${escapeHtml(item.rationale || "No rationale provided.")}</div>
      </div>
    `;

    // Citations
    const citations = Array.isArray(item.citations) ? item.citations : [];
    if (citations.length > 0) {
      const citSection = document.createElement("div");
      citSection.innerHTML = `<span class="rationale-label">Evidence Citations</span>`;
      const grid = document.createElement("div");
      grid.className = "evidence-grid";
      
      for (const cit of citations) {
        const card = document.createElement("div");
        const effectClass = citationEffectClass(cit.effect);
        card.className = `evidence-card ${effectClass}`;
        card.innerHTML = `
          <div class="evidence-topline">
            <span class="evidence-effect ${effectClass}">${citationEffectLabel(cit.effect)}</span>
            <span class="evidence-meta">${escapeHtml(cit.source_key || "?")} -> ${escapeHtml(cit.anchor_id || "?")}</span>
          </div>
          <div class="evidence-quote">"${escapeHtml(cit.quote || "...")}"</div>
          <div class="evidence-reason">${escapeHtml(cit.reason || "N/A")}</div>
          <div class="evidence-meta">Validation: ${escapeHtml(citationValidationLabel(cit))}</div>
        `;
        const btn = document.createElement("button");
        btn.className = "action-btn outline sm evidence-action";
        btn.textContent = `Inspect Source: ${cit.source_key||"?"}`;
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
      missSection.innerHTML = `<span class="rationale-label">Missing Evidence</span><div style="display:flex;gap:8px;flex-wrap:wrap;">${missing.map(m=>`<span class="badge" style="background:var(--status-warn-bg);color:var(--status-warn-fg);border:none;">${escapeHtml(m)}</span>`).join("")}</div>`;
      dataCol.appendChild(missSection);
    }

    row.appendChild(metaCol);
    row.appendChild(dataCol);
    els.resultsList.appendChild(row);
  }
}

async function loadBoards() {
  els.refreshBoardsBtn.disabled = true;
  setViewerState("Fetching boards...");
  try {
    const data = await apiGet("/api/boards");
    state.boards = data.boards || [];
    els.identity.textContent = data.me?.fullName || data.me?.username || "Unknown";
    renderBoards();
    const selectedStillExists = !!state.selectedBoard && state.boards.some((board) => board.id === state.selectedBoard.id);
    if (!selectedStillExists) {
      const preferredBoard = state.boards.find((board) => (board.name || "").trim() === PREFERRED_BOARD_NAME);
      if (preferredBoard) {
        selectBoard(preferredBoard, { statusMessage: `Defaulted to ${PREFERRED_BOARD_NAME}. Loading cards...` });
        await loadCards();
      } else {
        state.selectedBoard = null;
        state.cards = [];
        renderBoards();
        renderCards();
        els.selectedBoardMeta.textContent = "No board selected.";
        setViewerState("Preferred board not found.");
      }
    } else {
      setViewerState("Boards loaded.");
    }
  } catch (err) {
    setViewerState(`Board fetch error: ${err.message}`);
  } finally {
    els.refreshBoardsBtn.disabled = false;
  }
}

async function loadCards() {
  if (!state.selectedBoard) return;
  els.loadCardsBtn.disabled = true;
  const q = els.cardSearch.value.trim();
  const limit = els.cardLimit.value;
  setViewerState(`Fetching cards...`);
  try {
    const data = await apiGet(`/api/boards/${state.selectedBoard.id}/cards?limit=${limit}&q=${encodeURIComponent(q)}`);
    state.cards = data.cards || [];
    renderCards();
    setViewerState(`Loaded ${state.cards.length} cards.`);
  } catch (err) {
    setViewerState(`Card fetch error: ${err.message}`);
  } finally {
    els.loadCardsBtn.disabled = false;
  }
}

async function loadCard(card) {
  state.selectedCard = card;
  state.workspaceStatus = null;
  state.tokenEstimate = { loading: true };
  renderCards();
  renderTokenEstimate();
  els.cardBadge.textContent = card.name || card.id;
  setViewerState("Fetching packet and review status...");
  try {
    const packet = await apiGet(`/api/cards/${card.id}/packet`);
    state.currentPacket = packet.packet;
    state.currentMarkdown = packet.markdown || "";
    const status = await apiPost(`/api/cards/${card.id}/workspace/status`, { cardPacket: state.currentPacket });
    state.workspace = status.workspace || null;
    state.workspaceStatus = status.prep || null;
    state.runResult = null;
    renderPacketViews();
    renderWorkspace();
    renderResults();
    setViewerState(state.workspaceStatus?.summary || "Card contextualized.");
    refreshTokenEstimate();
  } catch (err) {
    setViewerState(`Context error: ${err.message}`);
    state.tokenEstimate = { error: err.message };
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
    renderChecklistEditorStatus(`Loaded ${state.checklistDraft.items.length} criteria.`);
    refreshTokenEstimate();
  } catch (err) {
    renderChecklistEditorStatus(`Load failed: ${err.message}`);
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
    renderChecklistEditorStatus(`Saved successfully.`);
    refreshTokenEstimate();
  } catch (err) {
    renderChecklistEditorStatus(`Save failed: ${err.message}`);
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
    renderChecklistEditorStatus("Replaced with the app default checklist.");
    refreshTokenEstimate();
  } catch (err) {
    renderChecklistEditorStatus(`Reset failed: ${err.message}`);
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
    renderChecklistEditorStatus("Checklist exported.");
  } catch (err) {
    renderChecklistEditorStatus(`Export failed: ${err.message}`);
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
    renderChecklistEditorStatus(`Imported ${file.name}.`);
    refreshTokenEstimate();
  } catch (err) {
    renderChecklistEditorStatus(`Import failed: ${err.message}`);
  } finally {
    els.importChecklistBtn.disabled = false;
    if (els.importChecklistInput) els.importChecklistInput.value = "";
  }
}

async function loadWorkspaceStatus(cardPacket = state.currentPacket) {
  if (!state.selectedCard) return null;
  const status = await apiPost(`/api/cards/${state.selectedCard.id}/workspace/status`, { cardPacket });
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
    setViewerState("Review folder initialized.");
  } catch (err) { setViewerState(`Init failed: ${err.message}`); }
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
    setViewerState(`Imported ${payloadFiles.length} file(s). Click Prepare Review to index them.`);
  } catch (err) {
    setViewerState(`Upload failed: ${err.message}`);
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
    setViewerState(state.workspaceStatus?.summary || "Status refreshed.");
  } catch (err) { setViewerState(`Refresh failed: ${err.message}`); }
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
  if (!window.mammoth) throw new Error("Mammoth library not loaded");
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
  if (!window.XLSX) throw new Error("SheetJS library not loaded");
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
            text: `${anchor} = ${display}${formula ? ` (formula: ${formula})` : ""}`,
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

async function extractPdfIndex(arrayBuffer, meta) {
  if (!window.pdfjsLib) throw new Error("pdf.js library not loaded");
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const segments = [];
  const pages = [];
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
        ocr_status: text ? "text_available" : "image_only",
      },
    });
    pages.push({ page: pageNum, width: viewport.width, height: viewport.height, textLength: text.length, anchor_id: anchor });
  }
  return {
    version: 1,
    file_kind: "pdf",
    display_name: meta.displayName,
    file_name: meta.fileName,
    mime_type: meta.mimeType,
    content_hash: meta.contentHash,
    extracted_at: new Date().toISOString(),
    warnings: segments.some((s) => !s.text) ? ["Some pages appear scanned/image-only (no extractable text)."] : [],
    render: {
      type: "pdf",
      page_count: pdf.numPages,
      pages,
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
    warnings: ["Image indexing is metadata-only in MVP; add OCR/region anchors later for precise evidence."],
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
    warnings: ["Unsupported file type for structured extraction in MVP."],
    render: { type: "none" },
    segments: [],
  };
}

async function buildIndexRecord({ source, cardId, displayName, fileName, mimeType, arrayBuffer, sourceLocator, localFile, trelloAttachment }) {
  const contentHash = await sha256Hex(arrayBuffer);
  const fileKind = detectFileKind(fileName, mimeType);
  const meta = { source, cardId, displayName, fileName, mimeType, contentHash };
  let index;
  if (fileKind === "docx") index = await extractDocxIndex(arrayBuffer, meta);
  else if (fileKind === "xlsx") index = await extractXlsxIndex(arrayBuffer, meta);
  else if (fileKind === "pdf") index = await extractPdfIndex(arrayBuffer, meta);
  else if (fileKind === "text") index = await extractTextIndex(arrayBuffer, meta);
  else if (fileKind === "image") index = await extractImageIndex(arrayBuffer, meta);
  else index = await extractUnknownIndex(meta);

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
    index,
  };
}

async function fetchArrayBuffer(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = await res.arrayBuffer();
  return { buffer: buf, contentType: res.headers.get("Content-Type") || "application/octet-stream" };
}

function localContentUrl(cardId, relativePath) {
  return `/api/cards/${encodeURIComponent(cardId)}/workspace/files/content?path=${encodeURIComponent(relativePath)}`;
}

async function indexLocalAttachments(filesOverride = null) {
  if (!state.selectedCard) return;
  if (!state.workspace?.exists) {
    setViewerState("Create the workspace folder first.");
    return;
  }
  const files = filesOverride || state.workspaceStatus?.local?.items || state.workspace.localFiles || [];
  if (!files.length) {
    setViewerState("No local files found in attachments/. Copy files there first.");
    return;
  }
  els.indexLocalBtn.disabled = true;
  setViewerState(`Indexing ${files.length} local attachment(s)...`);
  try {
    const batch = [];
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      setViewerState(`Indexing local ${i + 1}/${files.length}: ${f.relativePath}`);
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
      batch.push(record);
    }
    await apiPost(`/api/cards/${state.selectedCard.id}/workspace/indexes`, { indexes: batch });
    await loadWorkspaceStatus(state.currentPacket);
    refreshTokenEstimate();
    setViewerState(`Indexed ${batch.length} local attachment(s).`);
  } catch (err) {
    setViewerState(`Local indexing failed: ${err.message}`);
  } finally {
    els.indexLocalBtn.disabled = false;
  }
}

async function indexTrelloAttachments(attachmentsOverride = null) {
  if (!state.selectedCard || !state.currentPacket) return;
  const attachments = attachmentsOverride || state.workspaceStatus?.remote?.items || state.currentPacket.attachments || [];
  if (!attachments.length) {
    setViewerState("Card has no Trello attachments to index.");
    return;
  }
  if (!state.workspace?.exists) {
    setViewerState("Create the workspace folder first.");
    return;
  }
  els.indexTrelloBtn.disabled = true;
  setViewerState(`Indexing ${attachments.length} Trello attachment(s)...`);
  try {
    const batch = [];
    for (let i = 0; i < attachments.length; i += 1) {
      const att = attachments[i];
      const attachmentId = att.id || att.attachmentId;
      const proxyUrl = att.proxyUrl;
      if (!proxyUrl) continue;
      const fileName = att.fileName || att.name || `attachment_${attachmentId}`;
      setViewerState(`Indexing Trello ${i + 1}/${attachments.length}: ${fileName}`);
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
      batch.push(record);
    }
    await apiPost(`/api/cards/${state.selectedCard.id}/workspace/indexes`, { indexes: batch });
    await loadWorkspaceStatus(state.currentPacket);
    refreshTokenEstimate();
    setViewerState(`Indexed ${batch.length} Trello attachment(s).`);
  } catch (err) {
    setViewerState(`Trello indexing failed: ${err.message}`);
  } finally {
    els.indexTrelloBtn.disabled = false;
  }
}

async function prepareReview() {
  if (!state.selectedCard) return;
  els.prepareReviewBtn.disabled = true;
  setViewerState("Preparing review...");
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
    if (pendingLocal.length) {
      await indexLocalAttachments(pendingLocal);
    }

    const pendingRemote = (state.workspaceStatus?.remote?.items || []).filter((row) =>
      row.indexStatus === "not_indexed"
    );
    if (pendingRemote.length) {
      await indexTrelloAttachments(pendingRemote);
    }

    await loadWorkspaceStatus(state.currentPacket);
    refreshTokenEstimate();
    if (state.workspaceStatus?.readyForRun) {
      setViewerState("Review is prepared and ready to run.");
    } else {
      setViewerState(state.workspaceStatus?.blockingMessage || state.workspaceStatus?.summary || "Preparation updated.");
    }
  } catch (err) {
    setViewerState(`Prepare failed: ${err.message}`);
  } finally {
    els.prepareReviewBtn.disabled = false;
  }
}

async function runChecklist() {
  if (!state.selectedCard || !state.workspaceStatus?.readyForRun) return;
  els.runChecklistBtn.disabled = true;
  setViewerState("Running review...");
  try {
    const data = await apiPost(`/api/cards/${state.selectedCard.id}/workspace/run`, {
      model: els.modelInput.value,
      reasoning_effort: els.reasoningEffortSelect.value,
    });
    state.runResult = data.run;
    if (state.workspace) state.workspace.runs = data.runs || state.workspace.runs || [];
    renderWorkspace();
    renderResults();
    if (state.runResult) setMainTab("results");
    setViewerState("Execution complete.");
  } catch (err) {
    setViewerState(`Execution failed: ${err.message}`);
  } finally {
    els.runChecklistBtn.disabled = false;
  }
}

async function refreshTokenEstimate() {
  if (!state.selectedCard || !state.currentPacket) return;
  state.tokenEstimate = { loading: true };
  renderTokenEstimate();
  try {
    const data = await apiPost(`/api/cards/${state.selectedCard.id}/workspace/token-estimate`, {
      model: els.modelInput.value,
      cardPacket: state.currentPacket,
    });
    state.tokenEstimate = data.estimate || { error: "Unknown error" };
    renderTokenEstimate();
  } catch (err) {
    state.tokenEstimate = { error: err.message };
    renderTokenEstimate();
  }
}

async function loadSelectedRun() {
  if (!state.selectedCard || !els.runHistorySelect.value) return;
  try {
    state.runResult = await apiGet(`/api/cards/${state.selectedCard.id}/workspace/runs/${encodeURIComponent(els.runHistorySelect.value)}`);
    renderResults();
    setViewerState("History loaded.");
  } catch (err) { setViewerState(`History load failed: ${err.message}`); }
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
    if (!citation?.source_key) throw new Error("Citation missing source_key");
    setViewerState(`Opening evidence ${citation.source_key} -> ${citation.anchor_id}...`);
    const indexResp = await getIndexBySourceKey(citation.source_key);
    els.modalCitationTitle.textContent = `${citation.source_key} → ${citation.anchor_id}`;
    els.modalCitationMeta.textContent = [
      `${citationEffectLabel(citation.effect)}`,
      `validation=${citationValidationLabel(citation)}`,
      citation.page ? `page=${citation.page}` : null,
      citation.sheet ? `sheet=${citation.sheet}` : null,
    ].filter(Boolean).join(" • ");
    await renderCitationDocument(indexResp, citation);
    els.citationModal.setAttribute("aria-hidden", "false");
    setViewerState(`Evidence opened (${citationValidationLabel(citation)}).`);
  } catch (err) {
    setViewerState(`Failed to open evidence: ${err.message}`);
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
  els.citationDocView.innerHTML = `<div class="json-box">Unsupported viewer for <code>${escapeHtml(fileKind)}</code>.</div>`;
}

function renderDocxCitation(index, citation) {
  const html = index?.render?.html || "";
  const box = document.createElement("div");
  box.className = "docx-html-box";
  box.innerHTML = html || "<p class='inline-meta'>No DOCX HTML preview stored.</p>";
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
    wrapper.textContent = "No workbook preview stored.";
    els.citationDocView.appendChild(wrapper);
    return;
  }

  const targetAnchor = citation.anchor_id || "";
  const sheetHint = citation.sheet || (targetAnchor.includes("!") ? targetAnchor.split("!")[0] : null);
  const activeSheet = wb.find((s) => s.sheet === sheetHint) || wb[0];

  const sheetPicker = document.createElement("div");
  sheetPicker.className = "pdf-toolbar";
  const label = document.createElement("span");
  label.textContent = `Sheet: ${activeSheet.sheet}`;
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
  rowHead.textContent = "Row";
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
        if (cell.formula) td.title = `formula: ${cell.formula}`;
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
  pre.textContent = index?.render?.text || "No text preview.";
  wrap.appendChild(pre);
  els.citationDocView.appendChild(wrap);

  const seg = (index.segments || []).find((s) => s.anchor_id === citation.anchor_id);
  if (seg) {
    const note = document.createElement("div");
    note.className = "inline-meta";
    note.textContent = `Anchor: ${seg.anchor_id} • Quote: ${citation.quote || ""}`;
    els.citationDocView.prepend(note);
  }
}

function renderImageCitation(indexResp, citation) {
  const summary = indexResp.summary || {};
  const fetchUrl = sourceLocatorToFetchUrl(summary);
  const wrap = document.createElement("div");
  wrap.className = "docx-html-box";
  if (!fetchUrl) {
    wrap.textContent = "Image source unavailable.";
    els.citationDocView.appendChild(wrap);
    return;
  }
  wrap.innerHTML = `
    <div class="inline-meta">Image citations are image-level in MVP (no OCR/region anchors yet).</div>
    <img src="${escapeHtml(fetchUrl)}" alt="cited image" style="max-width:100%; height:auto; margin-top:8px; border-radius:8px; border:1px solid rgba(33,31,28,0.08);" />
    <div class="inline-meta" style="margin-top:8px;">Reason: ${escapeHtml(citation.reason || "")}</div>
  `;
  els.citationDocView.appendChild(wrap);
}

async function getPdfDocForSource(indexResp) {
  const summary = indexResp.summary || {};
  const sourceKey = indexResp.sourceKey;
  if (state.pdfCache.has(sourceKey)) return state.pdfCache.get(sourceKey);
  const fetchUrl = sourceLocatorToFetchUrl(summary);
  if (!fetchUrl) throw new Error("PDF binary source unavailable");
  const { buffer } = await fetchArrayBuffer(fetchUrl);
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  state.pdfCache.set(sourceKey, { pdf, buffer });
  return { pdf, buffer };
}

async function renderPdfCitation(indexResp, citation) {
  if (!window.pdfjsLib) throw new Error("pdf.js library not loaded");
  const index = indexResp.index || {};
  const pageFromAnchor = Number(String(citation.anchor_id || "").replace("page_", ""));
  const pageNum = Number.isFinite(pageFromAnchor) && pageFromAnchor > 0 ? pageFromAnchor : Math.max(1, Number(citation.page) || 1);

  const wrap = document.createElement("div");
  wrap.className = "doc-canvas-wrap";
  const toolbar = document.createElement("div");
  toolbar.className = "pdf-toolbar";
  const pageLabel = document.createElement("span");
  pageLabel.textContent = `Page ${pageNum}`;
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
  textBox.innerHTML = `<div data-anchor-id="${escapeHtml(pageSeg?.anchor_id || `page_${pageNum}`)}">${escapeHtml(pageText || "(No extractable text on this page. Possibly scanned/image-only PDF.)")}</div>`;
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
    highlightMeta.textContent = `In-document highlight applied on PDF page (${nativeHighlightCount} text region${nativeHighlightCount === 1 ? "" : "s"}).`;
  } else {
    highlightMeta.textContent = "In-document highlight unavailable for this citation on the page text layer. Showing extracted-text highlight below.";
  }
  toolbar.appendChild(highlightMeta);
}

function bindEvents() {
  els.refreshBoardsBtn.onclick = loadBoards;
  els.boardSearch.oninput = renderBoards;
  els.loadCardsBtn.onclick = loadCards;
  els.cardSearch.onkeydown = (e) => { if (e.key === "Enter") loadCards(); };
  
  els.prepareReviewBtn.onclick = prepareReview;
  els.uploadWorkspaceFilesBtn.onclick = promptWorkspaceFilesImport;
  els.createWorkspaceBtn.onclick = createWorkspace;
  els.refreshWorkspaceBtn.onclick = refreshWorkspace;
  els.indexLocalBtn.onclick = () => indexLocalAttachments();
  els.indexTrelloBtn.onclick = () => indexTrelloAttachments();
  els.runChecklistBtn.onclick = runChecklist;
  els.loadRunBtn.onclick = loadSelectedRun;
  
  els.loadChecklistBtn.onclick = loadChecklist;
  els.resetChecklistBtn.onclick = resetChecklistToAppDefault;
  els.importChecklistBtn.onclick = promptChecklistImport;
  els.exportChecklistBtn.onclick = exportChecklist;
  els.importChecklistInput.onchange = (e) => importChecklistFile(e.target.files?.[0]);
  els.uploadWorkspaceFilesInput.onchange = (e) => importWorkspaceFiles(e.target.files);
  els.saveChecklistBtn.onclick = saveChecklist;
  els.addChecklistItemBtn.onclick = () => { ensureChecklistDraft().items.push(newChecklistItemDraft()); renderChecklistBuilder(); };
  
  els.modelInput.onchange = refreshTokenEstimate;
  els.reasoningEffortSelect.onchange = refreshTokenEstimate;

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
    setViewerState(`Some viewer/indexer libraries failed to load: ${missing.join(", ")}`);
  }
}

async function init() {
  bindEvents();
  configurePdfJs();
  verifyLibraries();
  renderChecklistBuilder();
  renderWorkspace();
  renderResults();
  await Promise.all([loadChecklist(), loadBoards()]);
}

init();
