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
  tokenEstimate: null,
  checklistParsed: null,
  checklistDraft: null,
  runResult: null,
  runHistory: [],
  indexCache: new Map(),
  pdfCache: new Map(),
};

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

  createWorkspaceBtn: document.getElementById("createWorkspaceBtn"),
  refreshWorkspaceBtn: document.getElementById("refreshWorkspaceBtn"),
  indexLocalBtn: document.getElementById("indexLocalBtn"),
  indexTrelloBtn: document.getElementById("indexTrelloBtn"),
  runChecklistBtn: document.getElementById("runChecklistBtn"),
  modelInput: document.getElementById("modelInput"),
  tokenEstimate: document.getElementById("tokenEstimate"),
  workspaceMeta: document.getElementById("workspaceMeta"),
  localFilesList: document.getElementById("localFilesList"),
  indexesList: document.getElementById("indexesList"),

  checklistStatus: document.getElementById("checklistStatus"),
  checklistNameInput: document.getElementById("checklistNameInput"),
  checklistInstructionsInput: document.getElementById("checklistInstructionsInput"),
  checklistItemsList: document.getElementById("checklistItemsList"),
  loadChecklistBtn: document.getElementById("loadChecklistBtn"),
  saveChecklistBtn: document.getElementById("saveChecklistBtn"),
  addChecklistItemBtn: document.getElementById("addChecklistItemBtn"),

  runSummary: document.getElementById("runSummary"),
  resultsList: document.getElementById("resultsList"),
  runHistorySelect: document.getElementById("runHistorySelect"),
  loadRunBtn: document.getElementById("loadRunBtn"),

  packetRenderedView: document.getElementById("packetRenderedView"),
  packetMarkdownView: document.getElementById("packetMarkdownView"),
  packetJsonView: document.getElementById("packetJsonView"),
  citationDocView: document.getElementById("citationDocView"),
  citationJsonView: document.getElementById("citationJsonView"),
  citationBadge: document.getElementById("citationBadge"),

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

function setBodyLoading(on) {
  document.body.classList.toggle("loading", !!on);
}

function setActiveTab(tabId) {
  els.tabs.forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
  document.querySelectorAll(".tab-pane").forEach((pane) => pane.classList.remove("active"));
  const paneMap = {
    "packet-rendered": els.packetRenderedView,
    "packet-markdown": els.packetMarkdownView,
    "packet-json": els.packetJsonView,
    "citation-doc": els.citationDocView,
    "citation-json": els.citationJsonView,
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
      html.push(`<figure><img loading="lazy" src="${src}" alt="${alt}" /><figcaption>${alt}</figcaption></figure>`);
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
    if (
      trimmed === "_No attachments_" ||
      trimmed === "_No comments_" ||
      trimmed === "_No image assets_" ||
      trimmed === "_No checklists_"
    ) {
      html.push(`<p class="md-muted">${escapeHtml(trimmed)}</p>`);
    } else if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const safe = escapeHtml(trimmed);
      html.push(`<p><a href="${safe}" target="_blank" rel="noreferrer">${safe}</a></p>`);
    } else {
      html.push(`<p class="md-line">${escapeHtml(line)}</p>`);
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
    btn.title = `${board.name || ""}\n${board.id}`;
    if (state.selectedBoard?.id === board.id) btn.classList.add("active");
    btn.addEventListener("click", () => {
      state.selectedBoard = board;
      state.cards = [];
      state.selectedCard = null;
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
      els.selectedBoardMeta.textContent = `Board: ${board.name}\nID: ${board.id}\nLast Activity: ${fmtDate(board.dateLastActivity)}`;
      els.cardBadge.textContent = "No card selected";
      setViewerState("Board selected. Load cards to continue.");
    });
    els.boardsList.appendChild(node);
  }

  if (!state.filteredBoards.length) {
    els.boardsList.innerHTML = `<li class="meta-block muted">No boards match filter.</li>`;
  }
}

function renderCards() {
  const q = (els.cardSearch?.value || "").trim().toLowerCase();
  const visibleCards = q
    ? state.cards.filter((card) => {
        const name = String(card.name || "").toLowerCase();
        const desc = String(card.desc || "").toLowerCase();
        return name.includes(q) || desc.includes(q);
      })
    : state.cards;
  els.cardsList.innerHTML = "";
  for (const card of visibleCards) {
    const node = els.cardItemTpl.content.firstElementChild.cloneNode(true);
    const btn = node.querySelector("button");
    btn.querySelector(".title").textContent = card.name || "(unnamed card)";
    const extra = [];
    if (card.labels?.length) extra.push(`${card.labels.length} label(s)`);
    if (card.due) extra.push(`Due ${fmtDate(card.due)}`);
    extra.push(`Activity ${fmtDate(card.dateLastActivity)}`);
    btn.querySelector(".sub").textContent = extra.join(" • ");
    if (state.selectedCard?.id === card.id) btn.classList.add("active");
    btn.addEventListener("click", () => loadCard(card));
    els.cardsList.appendChild(node);
  }
  if (!state.cards.length) {
    els.cardsList.innerHTML = `<li class="meta-block muted">No cards loaded yet. Click Load Cards.</li>`;
  } else if (!visibleCards.length) {
    els.cardsList.innerHTML = `<li class="meta-block muted">No loaded cards match this search. Click Load Cards to search the full board.</li>`;
  }
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
    els.tokenEstimate.textContent = "Token estimate: no card selected.";
    els.tokenEstimate.classList.add("muted");
    return;
  }
  const est = state.tokenEstimate;
  if (!est) {
    els.tokenEstimate.textContent = "Token estimate: not calculated yet.";
    els.tokenEstimate.classList.add("muted");
    return;
  }
  if (est.loading) {
    els.tokenEstimate.textContent = "Token estimate: calculating...";
    els.tokenEstimate.classList.add("muted");
    return;
  }
  const model = est.model || (els.modelInput?.value || "gpt-5.2");
  const total = est.counts?.total_input_tokens;
  const docs = est.payload_stats?.evidence_documents ?? 0;
  const segs = est.payload_stats?.evidence_segments ?? 0;
  const checklistItems = est.payload_stats?.checklist_items ?? 0;
  const commentsCount = est.payload_stats?.comments_count ?? 0;
  const commentsChars = est.payload_stats?.comments_text_chars ?? 0;
  const descChars = est.payload_stats?.card_description_chars ?? 0;
  const encoding = est.tiktoken?.encoding || "n/a";
  const notes = Array.isArray(est.notes) ? est.notes.filter(Boolean) : [];
  const headline = Number.isFinite(total)
    ? `Token estimate (${model}): ${total.toLocaleString()} input tokens`
    : `Token estimate (${model}): unavailable`;
  const detail = `Checklist: ${checklistItems} item(s) • Comments: ${commentsCount} (${commentsChars.toLocaleString()} chars) • Desc: ${descChars.toLocaleString()} chars • Evidence: ${docs} doc(s), ${segs} segment(s) • Encoder: ${encoding}`;
  const extra = est.error ? `\n${est.error}` : notes.length ? `\n${notes[0]}` : "";
  els.tokenEstimate.textContent = `${headline}\n${detail}${extra}`;
  els.tokenEstimate.classList.toggle("muted", !Number.isFinite(total));
}

function renderWorkspace() {
  const hasCard = !!state.selectedCard;
  els.createWorkspaceBtn.disabled = !hasCard;
  els.refreshWorkspaceBtn.disabled = !hasCard;
  const hasWorkspace = !!state.workspace?.exists;
  els.indexLocalBtn.disabled = !hasWorkspace;
  els.indexTrelloBtn.disabled = !hasWorkspace || !state.currentPacket;
  els.runChecklistBtn.disabled = !hasWorkspace;

  if (!hasCard) {
    els.workspaceMeta.textContent = "No card selected.";
    els.localFilesList.innerHTML = `<li class="meta-block muted">Select a card.</li>`;
    els.indexesList.innerHTML = `<li class="meta-block muted">Select a card.</li>`;
    return;
  }

  if (!hasWorkspace) {
    els.workspaceMeta.textContent = "Workspace not created yet. Create folder to start indexing local attachments.";
    els.localFilesList.innerHTML = `<li class="meta-block muted">No workspace folder yet.</li>`;
    els.indexesList.innerHTML = `<li class="meta-block muted">No indexes yet.</li>`;
    return;
  }

  const ws = state.workspace;
  els.workspaceMeta.textContent = `Folder: ${ws.workspaceFolder}\nPath: ${ws.workspacePath}\nAttachments: ${ws.attachmentsPath}\nRuns: ${ws.runs?.length || 0}`;

  const localFiles = ws.localFiles || [];
  if (!localFiles.length) {
    els.localFilesList.innerHTML = `<li class="meta-block muted">Copy files into attachments/ then click Index Local Attachments.</li>`;
  } else {
    els.localFilesList.innerHTML = localFiles
      .map((f) => {
        const status = f.indexStatus || "not_indexed";
        const kind = f.indexFileKind ? ` • ${escapeHtml(f.indexFileKind)}` : "";
        return `<li class="file-row"><div><code>${escapeHtml(f.relativePath)}</code></div><div class="inline-meta">${bytesLabel(f.size)} • ${fmtDate(Number(f.mtimeNs) / 1e6)} • ${escapeHtml(status)}${kind}</div></li>`;
      })
      .join("");
  }

  const idxs = Object.entries(ws.manifest?.indexes || {});
  if (!idxs.length) {
    els.indexesList.innerHTML = `<li class="meta-block muted">No sources indexed yet.</li>`;
  } else {
    els.indexesList.innerHTML = idxs
      .map(([sourceKey, row]) => {
        const source = row.source || "?";
        const fileKind = row.file_kind || row.fileKind || "?";
        const display = row.display_name || row.displayName || sourceKey;
        const segs = row.segment_count ?? "?";
        return `<li class="index-row"><div><strong>${escapeHtml(display)}</strong></div><div class="inline-meta"><code>${escapeHtml(sourceKey)}</code></div><div class="inline-meta">${escapeHtml(source)} • ${escapeHtml(fileKind)} • ${segs} segment(s)</div></li>`;
      })
      .join("");
  }

  renderRunHistorySelect();
}

function renderChecklistEditorStatus(ok, msg) {
  els.checklistStatus.textContent = msg;
  els.checklistStatus.classList.toggle("muted", !!ok);
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
    version: Number(seed.version) || 1,
    name: String(seed.name || "Review Checklist"),
    instructions: String(seed.instructions || ""),
    items,
  };
}

function checklistDraftFromParsed(parsed) {
  return newChecklistDraft(parsed || {});
}

function ensureChecklistDraft() {
  if (!state.checklistDraft) state.checklistDraft = newChecklistDraft();
  return state.checklistDraft;
}

function checklistFieldValue(input) {
  return String(input?.value || "").trim();
}

function renderChecklistBuilder() {
  const draft = ensureChecklistDraft();
  els.checklistNameInput.value = draft.name || "";
  els.checklistInstructionsInput.value = draft.instructions || "";
  els.checklistItemsList.innerHTML = "";

  if (!draft.items.length) {
    draft.items.push(newChecklistItemDraft());
  }

  draft.items.forEach((item, idx) => {
    const card = document.createElement("div");
    card.className = "checklist-item-card";
    card.innerHTML = `
      <div class="checklist-item-head">
        <div class="checklist-item-number">#${idx + 1}</div>
        <div class="checklist-item-id">ID: <code>${escapeHtml(item.id || "(auto-generated on save)")}</code></div>
        <div class="checklist-item-actions"></div>
      </div>
      <div class="field-block">
        <label>Item Title</label>
        <input type="text" data-field="title" value="${escapeHtml(item.title || "")}" placeholder="What should be checked?" />
      </div>
      <div class="field-block">
        <label>Description</label>
        <textarea class="input-multiline" rows="3" data-field="description" placeholder="Explain what this checklist item means.">${escapeHtml(item.description || "")}</textarea>
      </div>
      <div class="field-block">
        <label>Pass Criteria</label>
        <textarea class="input-multiline" rows="2" data-field="pass_criteria" placeholder="What counts as pass?">${escapeHtml(item.pass_criteria || "")}</textarea>
      </div>
      <div class="field-block">
        <label>Fail Criteria</label>
        <textarea class="input-multiline" rows="2" data-field="fail_criteria" placeholder="What counts as fail?">${escapeHtml(item.fail_criteria || "")}</textarea>
      </div>
    `;

    const actions = card.querySelector(".checklist-item-actions");
    const upBtn = document.createElement("button");
    upBtn.className = "small-btn";
    upBtn.type = "button";
    upBtn.textContent = "Up";
    upBtn.disabled = idx === 0;
    upBtn.addEventListener("click", () => {
      const a = draft.items[idx - 1];
      draft.items[idx - 1] = draft.items[idx];
      draft.items[idx] = a;
      renderChecklistBuilder();
    });
    actions.appendChild(upBtn);

    const downBtn = document.createElement("button");
    downBtn.className = "small-btn";
    downBtn.type = "button";
    downBtn.textContent = "Down";
    downBtn.disabled = idx === draft.items.length - 1;
    downBtn.addEventListener("click", () => {
      const a = draft.items[idx + 1];
      draft.items[idx + 1] = draft.items[idx];
      draft.items[idx] = a;
      renderChecklistBuilder();
    });
    actions.appendChild(downBtn);

    const removeBtn = document.createElement("button");
    removeBtn.className = "small-btn danger-btn";
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";
    removeBtn.disabled = draft.items.length <= 1;
    removeBtn.addEventListener("click", () => {
      draft.items.splice(idx, 1);
      renderChecklistBuilder();
    });
    actions.appendChild(removeBtn);

    card.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("input", () => {
        const field = input.dataset.field;
        if (!field) return;
        draft.items[idx][field] = checklistFieldValue(input);
        if (field === "title") {
          const idNode = card.querySelector(".checklist-item-id code");
          if (idNode && !draft.items[idx].id) {
            idNode.textContent = "(auto-generated on save)";
          }
        }
      });
    });

    els.checklistItemsList.appendChild(card);
  });
}

function slugifyChecklistToken(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function buildChecklistPayloadFromForm() {
  const draft = ensureChecklistDraft();
  draft.name = checklistFieldValue(els.checklistNameInput) || "Review Checklist";
  draft.instructions = checklistFieldValue(els.checklistInstructionsInput);

  const seen = new Set();
  const items = draft.items.map((item, idx) => {
    const title = String(item.title || "").trim();
    if (!title) {
      throw new Error(`Checklist item #${idx + 1} is missing a title`);
    }
    let itemId = String(item.id || "").trim();
    if (!itemId) {
      const token = slugifyChecklistToken(title);
      itemId = token ? `item_${token}` : `item_${String(idx + 1).padStart(3, "0")}`;
    }
    let candidate = itemId;
    let n = 2;
    while (seen.has(candidate)) {
      candidate = `${itemId}_${n}`;
      n += 1;
    }
    seen.add(candidate);
    item.id = candidate;
    return {
      id: candidate,
      title,
      description: String(item.description || "").trim(),
      pass_criteria: String(item.pass_criteria || "").trim(),
      fail_criteria: String(item.fail_criteria || "").trim(),
    };
  });

  return {
    version: 1,
    name: draft.name,
    instructions: draft.instructions,
    items,
  };
}

function renderRunHistorySelect() {
  const runs = state.workspace?.runs || [];
  els.runHistorySelect.innerHTML = "";
  if (!runs.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No runs";
    els.runHistorySelect.appendChild(opt);
    els.loadRunBtn.disabled = true;
    return;
  }
  for (const r of runs) {
    const opt = document.createElement("option");
    opt.value = r.run_id;
    const counts = r.counts || {};
    opt.textContent = `${r.run_id} • p:${counts.pass || 0} f:${counts.fail || 0} r:${counts.needs_review || 0}`;
    els.runHistorySelect.appendChild(opt);
  }
  els.loadRunBtn.disabled = false;
}

function renderResults() {
  const run = state.runResult;
  if (!run) {
    els.runSummary.textContent = "No run yet.";
    els.runSummary.classList.add("muted");
    els.resultsList.innerHTML = "";
    return;
  }

  const summary = run.summary || {};
  const counts = summary.counts || {};
  els.runSummary.textContent = `Run: ${run.run_id || "(loaded)"}\nCreated: ${fmtDate(run.created_at)}\nModel: ${run.model || "n/a"}\nStatus: ${summary.status || "n/a"}\nCounts: pass=${counts.pass || 0}, fail=${counts.fail || 0}, needs_review=${counts.needs_review || 0}`;
  els.runSummary.classList.remove("muted");

  const result = run.result || {};
  const items = result.items || [];
  if (!items.length) {
    els.resultsList.innerHTML = `<div class="meta-block muted">Run has no checklist items.</div>`;
    return;
  }

  els.resultsList.innerHTML = "";
  for (const item of items) {
    const wrap = document.createElement("div");
    wrap.className = "result-item";
    const status = item.status || "needs_review";
    const conf = Number(item.confidence);
    wrap.innerHTML = `
      <div class="head">
        <div>
          <div><strong>Item ${Number(item.item_number) || "?"}</strong> <span class="inline-meta">(${escapeHtml(item.item_id || "missing id")})</span></div>
          <div class="result-meta">${escapeHtml(findChecklistMeta(item.item_id)?.title || "")}</div>
        </div>
        <span class="status-chip ${escapeHtml(status)}">${escapeHtml(status)}</span>
      </div>
      <div class="result-meta">Confidence: ${Number.isFinite(conf) ? conf.toFixed(2) : "n/a"}</div>
      <div class="result-rationale">${escapeHtml(item.rationale || "")}</div>
      <div class="result-meta">Citations</div>
      <div class="citation-list"></div>
      <div class="result-meta" style="margin-top:8px;">Missing evidence</div>
      <div class="missing-list"></div>
    `;

    const citationsNode = wrap.querySelector(".citation-list");
    const missingNode = wrap.querySelector(".missing-list");
    const citations = Array.isArray(item.citations) ? item.citations : [];
    const missing = Array.isArray(item.missing_evidence) ? item.missing_evidence : [];

    if (!citations.length) {
      citationsNode.innerHTML = `<span class="missing-chip">No citations returned</span>`;
    } else {
      for (const cit of citations) {
        const btn = document.createElement("button");
        btn.className = "citation-btn";
        const score = cit.validation?.score;
        const scoreLabel = Number.isFinite(score) ? ` ${score.toFixed(2)}` : "";
        btn.textContent = `${cit.source_key || "?"} → ${cit.anchor_id || "?"}${scoreLabel}`;
        btn.title = `${cit.reason || ""}\n${cit.quote || ""}`.trim();
        btn.addEventListener("click", () => openCitation(cit));
        citationsNode.appendChild(btn);
      }
    }

    if (!missing.length) {
      missingNode.innerHTML = `<span class="missing-chip">None</span>`;
    } else {
      for (const m of missing) {
        const span = document.createElement("span");
        span.className = "missing-chip";
        span.textContent = m;
        missingNode.appendChild(span);
      }
    }

    els.resultsList.appendChild(wrap);
  }
}

function findChecklistMeta(itemId) {
  const items = state.checklistParsed?.items || [];
  return items.find((i) => i.id === itemId) || null;
}

async function loadBoards() {
  els.refreshBoardsBtn.disabled = true;
  setBodyLoading(true);
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
    setBodyLoading(false);
  }
}

async function loadCards() {
  if (!state.selectedBoard) return;
  const limit = Math.min(Math.max(Number(els.cardLimit.value || 100), 1), 500);
  const query = (els.cardSearch?.value || "").trim();
  els.loadCardsBtn.disabled = true;
  els.cardsList.innerHTML = `<li class="meta-block muted">Loading cards...</li>`;
  try {
    setViewerState(query ? `Searching cards in ${state.selectedBoard.name}...` : `Loading cards for ${state.selectedBoard.name}...`);
    const data = await apiGet(
      `/api/boards/${state.selectedBoard.id}/cards?limit=${limit}${query ? `&q=${encodeURIComponent(query)}` : ""}`
    );
    state.cards = data.cards || [];
    state.lastCardsQuery = String(data.query || query || "");
    state.cardSearchServerApplied = !!state.lastCardsQuery;
    renderCards();
    const board = data.board || state.selectedBoard;
    const totalOpen = Number(data.total_open_cards);
    const matched = Number(data.matched_cards);
    const returned = Number(data.returned_cards);
    const countLine = Number.isFinite(totalOpen) && Number.isFinite(matched) && Number.isFinite(returned)
      ? `Cards: returned ${returned} / matched ${matched} / open ${totalOpen}`
      : `Cards loaded: ${state.cards.length}`;
    const queryLine = state.lastCardsQuery ? `Search: ${state.lastCardsQuery}` : "Search: (none)";
    els.selectedBoardMeta.textContent = `Board: ${board.name}\nID: ${board.id}\n${countLine}\n${queryLine}\nLast Activity: ${fmtDate(board.dateLastActivity)}`;
    setViewerState("Select a card to inspect packet/workspace and run checklist.");
  } catch (err) {
    els.cardsList.innerHTML = `<li class="meta-block">Failed to load cards: ${err.message}</li>`;
    setViewerState(`Failed to load cards: ${err.message}`, false);
  } finally {
    els.loadCardsBtn.disabled = false;
  }
}

async function loadCard(card) {
  state.selectedCard = card;
  state.tokenEstimate = { loading: true, model: (els.modelInput.value || "gpt-5.2").trim() };
  state.indexCache.clear();
  renderCards();
  renderTokenEstimate();
  els.cardBadge.textContent = `Loading ${card.name || card.id}...`;
  setViewerState("Fetching card packet and workspace state...");
  try {
    const [packetRes, workspaceRes] = await Promise.all([
      apiGet(`/api/cards/${card.id}/packet`),
      apiGet(`/api/cards/${card.id}/workspace`),
    ]);
    state.currentPacket = packetRes.packet;
    state.currentMarkdown = packetRes.markdown || "";
    state.workspace = workspaceRes;
    state.runResult = null;
    renderPacketViews();
    renderWorkspace();
    renderResults();
    const comments = state.currentPacket?.comments?.length || 0;
    const attachments = state.currentPacket?.attachments?.length || 0;
    const imageAssets = (state.currentPacket?.llm_assets || []).filter((a) => a.isImage).length;
    els.cardBadge.textContent = `${card.name || card.id} • ${comments} comments • ${attachments} attachments • ${imageAssets} images`;
    setViewerState("Card loaded. Create folder, index sources, then run checklist.");
    refreshTokenEstimate();
  } catch (err) {
    els.cardBadge.textContent = "Load failed";
    state.tokenEstimate = { error: err.message || String(err) };
    renderTokenEstimate();
    setViewerState(`Failed to load card/workspace: ${err.message}`, false);
  }
}

async function loadChecklist() {
  els.loadChecklistBtn.disabled = true;
  try {
    const data = await apiGet("/api/checklist");
    state.checklistParsed = data.parsed || null;
    state.checklistDraft = checklistDraftFromParsed(state.checklistParsed);
    renderChecklistBuilder();
    renderChecklistEditorStatus(true, `Checklist loaded (${(state.checklistParsed?.items || []).length} item(s)).`);
    refreshTokenEstimate();
  } catch (err) {
    renderChecklistEditorStatus(false, `Failed to load checklist: ${err.message}`);
  } finally {
    els.loadChecklistBtn.disabled = false;
  }
}

async function saveChecklist() {
  els.saveChecklistBtn.disabled = true;
  try {
    const checklist = buildChecklistPayloadFromForm();
    const data = await apiPost("/api/checklist", { checklist });
    state.checklistParsed = data.parsed || null;
    state.checklistDraft = checklistDraftFromParsed(state.checklistParsed);
    renderChecklistBuilder();
    renderChecklistEditorStatus(true, `Checklist saved (${(state.checklistParsed?.items || []).length} item(s)).`);
    renderResults();
    refreshTokenEstimate();
  } catch (err) {
    renderChecklistEditorStatus(false, `Checklist save failed: ${err.message}`);
  } finally {
    els.saveChecklistBtn.disabled = false;
  }
}

async function createWorkspace() {
  if (!state.selectedCard) return;
  els.createWorkspaceBtn.disabled = true;
  try {
    setViewerState("Creating workspace folder...");
    state.workspace = await apiPost(`/api/cards/${state.selectedCard.id}/workspace/create`, {});
    renderWorkspace();
    refreshTokenEstimate();
    setViewerState("Workspace ready. Copy supplemental files into attachments/ then index.");
  } catch (err) {
    setViewerState(`Failed to create workspace: ${err.message}`, false);
  } finally {
    els.createWorkspaceBtn.disabled = false;
  }
}

async function refreshWorkspace() {
  if (!state.selectedCard) return;
  try {
    state.workspace = await apiGet(`/api/cards/${state.selectedCard.id}/workspace`);
    renderWorkspace();
    refreshTokenEstimate();
  } catch (err) {
    setViewerState(`Failed to refresh workspace: ${err.message}`, false);
  }
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

async function indexLocalAttachments() {
  if (!state.selectedCard) return;
  if (!state.workspace?.exists) {
    setViewerState("Create the workspace folder first.", false);
    return;
  }
  const files = state.workspace.localFiles || [];
  if (!files.length) {
    setViewerState("No local files found in attachments/. Copy files there first.", false);
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
    await refreshWorkspace();
    setViewerState(`Indexed ${batch.length} local attachment(s).`);
  } catch (err) {
    setViewerState(`Local indexing failed: ${err.message}`, false);
  } finally {
    els.indexLocalBtn.disabled = false;
  }
}

async function indexTrelloAttachments() {
  if (!state.selectedCard || !state.currentPacket) return;
  const attachments = state.currentPacket.attachments || [];
  if (!attachments.length) {
    setViewerState("Card has no Trello attachments to index.", false);
    return;
  }
  if (!state.workspace?.exists) {
    setViewerState("Create the workspace folder first.", false);
    return;
  }
  els.indexTrelloBtn.disabled = true;
  setViewerState(`Indexing ${attachments.length} Trello attachment(s)...`);
  try {
    const batch = [];
    for (let i = 0; i < attachments.length; i += 1) {
      const att = attachments[i];
      const proxyUrl = att.proxyUrl;
      if (!proxyUrl) continue;
      const fileName = att.fileName || att.name || `attachment_${att.id}`;
      setViewerState(`Indexing Trello ${i + 1}/${attachments.length}: ${fileName}`);
      const { buffer, contentType } = await fetchArrayBuffer(proxyUrl);
      const record = await buildIndexRecord({
        source: "trello",
        cardId: state.selectedCard.id,
        displayName: att.name || fileName,
        fileName,
        mimeType: (att.mimeType || contentType || "").split(";")[0],
        arrayBuffer: buffer,
        sourceLocator: { type: "trello_attachment", proxyUrl, sourceUrl: att.url || null },
        trelloAttachment: {
          attachmentId: att.id,
          name: att.name || fileName,
          mimeType: att.mimeType || contentType,
          proxyUrl,
          sourceUrl: att.url || null,
        },
      });
      batch.push(record);
    }
    await apiPost(`/api/cards/${state.selectedCard.id}/workspace/indexes`, { indexes: batch });
    await refreshWorkspace();
    setViewerState(`Indexed ${batch.length} Trello attachment(s).`);
  } catch (err) {
    setViewerState(`Trello indexing failed: ${err.message}`, false);
  } finally {
    els.indexTrelloBtn.disabled = false;
  }
}

async function runChecklist() {
  if (!state.selectedCard) return;
  if (!state.workspace?.exists) {
    setViewerState("Create and index a workspace before running.", false);
    return;
  }
  els.runChecklistBtn.disabled = true;
  setViewerState("Running checklist with OpenAI Responses API (reasoning=high)...", false);
  try {
    const model = (els.modelInput.value || "gpt-5.2").trim();
    const data = await apiPost(`/api/cards/${state.selectedCard.id}/workspace/run`, { model });
    state.runResult = data.run || null;
    if (state.workspace) state.workspace.runs = data.runs || state.workspace.runs || [];
    renderWorkspace();
    renderResults();
    if (state.runResult) {
      setViewerState(`Run complete: ${state.runResult.summary?.status || "ok"}`);
    } else {
      setViewerState("Run completed but no result payload returned.", false);
    }
  } catch (err) {
    setViewerState(`Checklist run failed: ${err.message}`, false);
  } finally {
    els.runChecklistBtn.disabled = !state.workspace?.exists;
  }
}

async function refreshTokenEstimate() {
  if (!state.selectedCard || !state.currentPacket) {
    state.tokenEstimate = null;
    renderTokenEstimate();
    return;
  }
  const cardId = state.selectedCard.id;
  const model = (els.modelInput.value || "gpt-5.2").trim();
  state.tokenEstimate = { loading: true, model };
  renderTokenEstimate();
  try {
    const data = await apiPost(`/api/cards/${cardId}/workspace/token-estimate`, {
      model,
      cardPacket: state.currentPacket,
    });
    if (state.selectedCard?.id !== cardId) return;
    state.tokenEstimate = data.estimate || { error: "Missing estimate payload", model };
    renderTokenEstimate();
  } catch (err) {
    if (state.selectedCard?.id !== cardId) return;
    state.tokenEstimate = { error: err.message || String(err), model };
    renderTokenEstimate();
  }
}

async function loadSelectedRun() {
  if (!state.selectedCard) return;
  const runId = els.runHistorySelect.value;
  if (!runId) return;
  try {
    const data = await apiGet(`/api/cards/${state.selectedCard.id}/workspace/runs/${encodeURIComponent(runId)}`);
    state.runResult = data;
    renderResults();
    setViewerState(`Loaded run ${runId}.`);
  } catch (err) {
    setViewerState(`Failed to load run ${runId}: ${err.message}`, false);
  }
}

async function getIndexBySourceKey(sourceKey) {
  if (state.indexCache.has(sourceKey)) return state.indexCache.get(sourceKey);
  if (!state.selectedCard) throw new Error("No selected card");
  const data = await apiGet(`/api/cards/${state.selectedCard.id}/workspace/index?sourceKey=${encodeURIComponent(sourceKey)}`);
  state.indexCache.set(sourceKey, data);
  return data;
}

function clearCitationHighlights(root) {
  root?.querySelectorAll?.(".cited-anchor").forEach((el) => el.classList.remove("cited-anchor"));
  root?.querySelectorAll?.(".quote-highlight").forEach((el) => {
    el.replaceWith(document.createTextNode(el.textContent || ""));
  });
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

async function openCitation(citation) {
  try {
    if (!citation?.source_key) throw new Error("Citation missing source_key");
    setViewerState(`Loading citation ${citation.source_key} → ${citation.anchor_id}...`);
    const indexResp = await getIndexBySourceKey(citation.source_key);
    els.citationJsonView.textContent = JSON.stringify(indexResp, null, 2);
    els.citationBadge.textContent = `${citation.source_key} → ${citation.anchor_id || "?"}`;
    els.citationBadge.classList.remove("muted");
    await renderCitationDocument(indexResp, citation);
    setActiveTab("citation-doc");
    setViewerState(`Citation opened (${citation.validation?.status || "unvalidated"}).`);
  } catch (err) {
    setViewerState(`Failed to open citation: ${err.message}`, false);
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
    note.className = "meta-block";
    note.textContent = `Anchor: ${seg.anchor_id}\nQuote: ${citation.quote || ""}`;
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
  const canvas = document.createElement("canvas");
  canvasBox.appendChild(canvas);
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
  await page.render({ canvasContext: ctx, viewport }).promise;

  const anchorEl = textBox.querySelector(`[data-anchor-id="${CSS.escape(pageSeg?.anchor_id || `page_${pageNum}`)}"]`);
  if (anchorEl) {
    anchorEl.classList.add("cited-anchor");
    highlightQuoteInElement(anchorEl, citation.quote || "");
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

function initTabs() {
  els.tabs.forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => setActiveTab(tabBtn.dataset.tab));
  });
}

function bindEvents() {
  els.refreshBoardsBtn.addEventListener("click", loadBoards);
  els.loadCardsBtn.addEventListener("click", loadCards);
  els.cardSearch.addEventListener("input", () => {
    renderCards();
  });
  els.cardSearch.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      loadCards();
    }
  });
  els.boardSearch.addEventListener("input", renderBoards);
  els.copyMdBtn.addEventListener("click", copyMarkdown);

  els.loadChecklistBtn.addEventListener("click", loadChecklist);
  els.saveChecklistBtn.addEventListener("click", saveChecklist);
  els.addChecklistItemBtn.addEventListener("click", () => {
    const draft = ensureChecklistDraft();
    draft.items.push(newChecklistItemDraft());
    renderChecklistBuilder();
  });
  els.checklistNameInput.addEventListener("input", () => {
    ensureChecklistDraft().name = String(els.checklistNameInput.value || "");
  });
  els.checklistInstructionsInput.addEventListener("input", () => {
    ensureChecklistDraft().instructions = String(els.checklistInstructionsInput.value || "");
  });

  els.createWorkspaceBtn.addEventListener("click", createWorkspace);
  els.refreshWorkspaceBtn.addEventListener("click", refreshWorkspace);
  els.indexLocalBtn.addEventListener("click", indexLocalAttachments);
  els.indexTrelloBtn.addEventListener("click", indexTrelloAttachments);
  els.runChecklistBtn.addEventListener("click", runChecklist);
  els.modelInput.addEventListener("change", refreshTokenEstimate);

  els.loadRunBtn.addEventListener("click", loadSelectedRun);
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
    setViewerState(`Some viewer/indexer libraries failed to load: ${missing.join(", ")}`, false);
  }
}

async function init() {
  initTabs();
  bindEvents();
  configurePdfJs();
  verifyLibraries();
  renderChecklistBuilder();
  renderWorkspace();
  renderResults();
  renderPacketViews();
  renderTokenEstimate();
  await Promise.all([loadChecklist(), loadBoards()]);
}

init();
