/* ══════════════════════════════════════════════════════════════
   주소록 (Android Web / PWA) — app.js
   원본 AddressBook_v5_11.py 의 기능을 브라우저 환경으로 이식
   데이터는 이 기기의 localStorage 에만 저장됩니다 (서버 전송 없음)
══════════════════════════════════════════════════════════════ */
'use strict';

const COLUMNS = ["팀명", "직책", "성명", "아이디", "전화번호", "휴대전화번호"];
const FIELD_LABELS = { 팀명: "팀명", 직책: "직책", 성명: "성명", 아이디: "아이디", 전화번호: "전화번호", 휴대전화번호: "휴대전화" };
const SEARCH_FIELDS = ["전체", ...COLUMNS];
const RECENT_MAX = 20;
const SEARCH_HISTORY_MAX = 10;
const LS = {
  contacts: "ab_contacts_v1",
  favorites: "ab_favorites_v1",
  recent: "ab_recent_v1",
  config: "ab_config_v1",
};
const JOB_COLOR_ORDER = ["대표이사", "공장장", "이사", "팀장", "부팀장", "부장", "차장", "과장", "대리", "주임", "기장", "부기장", "조기장", "기사"];
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

/* ── 유틸리티 ─────────────────────────────────────────────── */
function formatPhone(num) {
  const digits = String(num || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("010")) return `${digits.slice(0,3)}-${digits.slice(3,7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`;
  if (digits.length === 9) return `${digits.slice(0,2)}-${digits.slice(2,5)}-${digits.slice(5)}`;
  return num || "";
}

function extractChosung(text) {
  let out = "";
  for (const ch of String(text || "")) {
    const code = ch.codePointAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) out += CHO[Math.floor((code - 0xAC00) / 588)];
    else out += ch;
  }
  return out;
}
const CHO_ONLY_RE = /^[ㄱ-ㅎ]+$/;

function smartSortKey(value) {
  const s = String(value || "");
  const digitsOnly = s.replace(/\D/g, "");
  if (digitsOnly && digitsOnly.length >= s.length * 0.7) {
    return [0, digitsOnly.padStart(20, "0"), ""];
  }
  return [1, "", s.toLowerCase()];
}
function compareSortKey(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[0] === 0) return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
}

const TOKEN_RE = /"([^"]+)"|(\S+)/g;
function parseQuery(query) {
  const include = [], exclude = [], exact = [], orGroups = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(query)) !== null) {
    const quoted = m[1], word = m[2];
    if (quoted) exact.push(quoted.toLowerCase());
    else if (word) {
      if (word.startsWith("-") && word.length > 1) exclude.push(word.slice(1).toLowerCase());
      else if (word.includes("|")) {
        const parts = word.split("|").map(p => p.toLowerCase()).filter(Boolean);
        if (parts.length >= 2) orGroups.push(parts);
        else include.push(word.toLowerCase());
      } else include.push(word.toLowerCase());
    }
  }
  return { include, exclude, exact, orGroups };
}

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
function extractEmailAddress(contact, domain) {
  const uid = (contact.아이디 || "").trim();
  if (!uid) return "";
  if (EMAIL_RE.test(uid)) return uid;
  return `${uid}${domain || ""}`;
}

function contactUid(c) {
  if (c.아이디) return c.아이디;
  return "noid:" + COLUMNS.map(k => c[k] || "").join("|");
}

function blobOf(c) {
  return COLUMNS.map(k => String(c[k] || "")).join(" ").toLowerCase();
}
function choBlobOf(c) {
  return extractChosung(COLUMNS.map(k => String(c[k] || "")).join(" ")).toLowerCase();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function highlightHtml(text, terms) {
  const raw = escapeHtml(text);
  if (!text || !terms || !terms.length) return raw;
  let result = raw;
  const uniq = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const t of uniq) {
    if (!t) continue;
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      result = result.replace(new RegExp(`(${esc})`, "ig"), "<mark>$1</mark>");
    } catch (e) { /* ignore bad pattern */ }
  }
  return result;
}

/* ── 저장소 ───────────────────────────────────────────────── */
const Store = {
  loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  },
  saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { toast("저장 실패: 저장공간이 가득 찼을 수 있습니다"); }
  },
};

/* ── 앱 상태 ──────────────────────────────────────────────── */
const state = {
  contacts: Store.loadJSON(LS.contacts, []),
  favorites: Store.loadJSON(LS.favorites, {}),        // uid -> contact dict
  recent: Store.loadJSON(LS.recent, []),               // [uid,...]
  config: Store.loadJSON(LS.config, { theme: "light", mailDomain: "@company.com", searchHistory: [] }),
  currentDisplay: [],
  highlightTerms: [],
  filterMode: "all",       // all | favorites | recent
  sortField: null,
  sortReverse: false,
  selectionMode: false,
  selectedIds: new Set(),
  editingUid: null,
};

function persistContacts() { Store.saveJSON(LS.contacts, state.contacts); }
function persistFavorites() { Store.saveJSON(LS.favorites, state.favorites); }
function persistRecent() { Store.saveJSON(LS.recent, state.recent); }
function persistConfig() { Store.saveJSON(LS.config, state.config); }

/* ── DOM 참조 ─────────────────────────────────────────────── */
const $ = sel => document.querySelector(sel);
const el = {
  countPill: $("#countPill"),
  scopeSelect: $("#scopeSelect"),
  searchInput: $("#searchInput"),
  clearSearchBtn: $("#clearSearchBtn"),
  chipRow: $("#chipRow"),
  statusText: $("#statusText"),
  statusExtra: $("#statusExtra"),
  listContainer: $("#listContainer"),
  toast: $("#toast"),
};

/* ── 초기화 ───────────────────────────────────────────────── */
function init() {
  document.documentElement.setAttribute("data-theme", state.config.theme || "light");
  SEARCH_FIELDS.forEach(f => {
    const opt = document.createElement("option");
    opt.value = f; opt.textContent = f;
    el.scopeSelect.appendChild(opt);
  });
  setupSearchHistoryList();
  bindEvents();
  refreshView();
  registerServiceWorker();
}

function setupSearchHistoryList() {
  let dl = document.getElementById("searchHistoryList");
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = "searchHistoryList";
    document.body.appendChild(dl);
    el.searchInput.setAttribute("list", "searchHistoryList");
  }
  dl.innerHTML = (state.config.searchHistory || []).map(q => `<option value="${escapeHtml(q)}">`).join("");
}

/* ── 검색 / 필터 / 정렬 ───────────────────────────────────── */
function currentBaseList() {
  if (state.filterMode === "favorites") return Object.values(state.favorites);
  if (state.filterMode === "recent") {
    const idx = new Map(state.recent.map((id, i) => [id, i]));
    return state.contacts.filter(c => idx.has(contactUid(c))).sort((a, b) => idx.get(contactUid(a)) - idx.get(contactUid(b)));
  }
  return state.contacts;
}

function runSearch(query, field) {
  const pq = parseQuery(query);
  const terms = [...pq.include, ...pq.exact, ...pq.orGroups.flat()];
  const base = currentBaseList();

  const results = base.filter(c => {
    const blob = blobOf(c);
    const cho = choBlobOf(c);
    const targetBlob = field === "전체" ? blob : String(c[field] || "").toLowerCase();
    const targetCho = field === "전체" ? cho : extractChosung(String(c[field] || "")).toLowerCase();

    const matchTerm = t => targetBlob.includes(t) || (CHO_ONLY_RE.test(t) && targetCho.includes(t));

    if (pq.include.some(t => !matchTerm(t))) return false;
    if (pq.exclude.some(t => matchTerm(t))) return false;
    if (pq.exact.some(t => !matchTerm(t))) return false;
    if (pq.orGroups.some(grp => grp.every(p => !matchTerm(p)))) return false;
    return true;
  });
  return { results, terms };
}

function applySort(list) {
  if (!state.sortField) return list;
  const field = state.sortField;
  const sorted = [...list].sort((a, b) => compareSortKey(smartSortKey(a[field]), smartSortKey(b[field])));
  if (state.sortReverse) sorted.reverse();
  return sorted;
}

function refreshView() {
  const query = el.searchInput.value.trim();
  let results, terms = [];
  if (!query) {
    results = currentBaseList();
  } else {
    const r = runSearch(query, el.scopeSelect.value);
    results = r.results; terms = r.terms;
  }
  state.highlightTerms = terms;
  state.currentDisplay = applySort(results);
  renderList(state.currentDisplay);
  updateStatus(query);
  updateCountPill();
  el.clearSearchBtn.classList.toggle("show", !!query);
}

function updateCountPill() {
  el.countPill.textContent = `${state.contacts.length}건`;
}
function updateStatus(query) {
  const n = state.currentDisplay.length;
  if (state.filterMode === "favorites") el.statusText.textContent = `⭐ 즐겨찾기 ${n}건`;
  else if (state.filterMode === "recent") el.statusText.textContent = `🕐 최근 열람 ${n}건`;
  else if (query) el.statusText.textContent = `'${query}' 검색결과 ${n}건`;
  else el.statusText.textContent = `전체 ${n}건 표시`;
  el.statusExtra.textContent = state.sortField ? `정렬: ${FIELD_LABELS[state.sortField]} ${state.sortReverse ? "↓" : "↑"}` : "";
}

/* ── 리스트 렌더링 (배치) ─────────────────────────────────── */
function jobBadgeVar(job) {
  if (!job) return null;
  let idx = JOB_COLOR_ORDER.findIndex(base => job.includes(base));
  if (idx === -1) return null;
  return `var(--job-${idx + 1})`;
}

function renderList(list) {
  const container = el.listContainer;
  container.innerHTML = "";
  if (!list.length) {
    container.innerHTML = state.contacts.length === 0 ? emptyStateNoData() : emptyStateNoResult();
    return;
  }
  const BATCH = 40;
  let idx = 0;
  function step() {
    const end = Math.min(idx + BATCH, list.length);
    const f = document.createDocumentFragment();
    for (; idx < end; idx++) f.appendChild(buildCard(list[idx]));
    container.appendChild(f);
    if (end < list.length) requestAnimationFrame(step);
  }
  step();
}

function emptyStateNoData() {
  return `<div class="empty-state">
    <div class="emoji">📇</div>
    <h3>연락처가 없습니다</h3>
    <p>파일을 가져오거나 직접 추가해서<br>주소록을 시작해보세요.</p>
    <button onclick="Sheets.open('data')">📂 가져오기</button>
  </div>`;
}
function emptyStateNoResult() {
  return `<div class="empty-state">
    <div class="emoji">🔍</div>
    <h3>검색 결과가 없습니다</h3>
    <p>다른 검색어를 시도해보세요.<br>예: 팀장 -홍  /  "홍길동"  /  홍|김</p>
  </div>`;
}

function buildCard(c) {
  const uid = contactUid(c);
  const isFav = !!state.favorites[uid];
  const isRecent = state.recent.includes(uid);
  const card = document.createElement("div");
  card.className = "card" + (isRecent ? " recent" : "");
  card.dataset.uid = uid;
  const jobColor = jobBadgeVar(c.직책);
  if (jobColor) card.style.borderLeftColor = jobColor;

  const initial = (c.성명 || "?").trim().slice(-1) || "?";
  const phone = c.휴대전화번호 || c.전화번호 || "";
  const selected = state.selectedIds.has(uid);

  card.innerHTML = `
    <div class="avatar" style="${jobColor ? `background:${jobColor};color:var(--fg);` : ""}">${selected ? "✅" : escapeHtml(initial)}</div>
    <div class="body">
      <div class="name-row">
        <span class="name${isFav ? " favorite" : ""}">${highlightHtml(c.성명, state.highlightTerms)}</span>
        ${isFav ? '<span class="star">⭐</span>' : ""}
        ${c.직책 ? `<span class="badge">${highlightHtml(c.직책, state.highlightTerms)}</span>` : ""}
      </div>
      <div class="meta">${highlightHtml(c.팀명, state.highlightTerms) || "&nbsp;"}</div>
      ${phone ? `<div class="phone">📱 ${highlightHtml(formatPhone(phone), state.highlightTerms)}</div>` : ""}
    </div>
    <div class="actions">
      ${phone ? `<button data-act="call" title="전화">📞</button>` : ""}
    </div>
  `;

  let pressTimer = null, longPressed = false;
  const startPress = () => {
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      toggleSelection(uid, true);
      if (navigator.vibrate) navigator.vibrate(12);
    }, 480);
  };
  const cancelPress = () => { clearTimeout(pressTimer); };
  card.addEventListener("touchstart", startPress, { passive: true });
  card.addEventListener("touchend", cancelPress);
  card.addEventListener("touchmove", cancelPress);
  card.addEventListener("mousedown", startPress);
  card.addEventListener("mouseup", cancelPress);
  card.addEventListener("mouseleave", cancelPress);

  card.addEventListener("click", (e) => {
    if (longPressed) { longPressed = false; return; }
    if (e.target.closest('[data-act="call"]')) {
      e.stopPropagation();
      window.location.href = `tel:${phone.replace(/\D/g, "")}`;
      return;
    }
    if (state.selectionMode) { toggleSelection(uid, false); return; }
    openDetail(uid);
  });

  return card;
}

function toggleSelection(uid, forceOn) {
  if (forceOn) state.selectionMode = true;
  if (state.selectedIds.has(uid)) state.selectedIds.delete(uid);
  else state.selectedIds.add(uid);
  if (state.selectedIds.size === 0) state.selectionMode = false;
  updateSelectionBar();
  renderList(state.currentDisplay);
}

function exitSelection() {
  state.selectionMode = false;
  state.selectedIds.clear();
  updateSelectionBar();
  renderList(state.currentDisplay);
}

/* ── 선택 모드 툴바 ───────────────────────────────────────── */
let selectionBar;
function ensureSelectionBar() {
  if (selectionBar) return selectionBar;
  selectionBar = document.createElement("div");
  selectionBar.style.cssText = "position:fixed;left:10px;right:10px;bottom:calc(66px + var(--safe-bottom));background:var(--accent);color:var(--accent-fg);border-radius:14px;padding:10px 14px;display:none;align-items:center;gap:10px;box-shadow:var(--shadow);z-index:30;font-weight:700;font-size:13.5px;";
  selectionBar.innerHTML = `
    <span id="selCount" style="flex:1;">0명 선택됨</span>
    <button id="selMore" style="border:none;background:rgba(255,255,255,.2);color:inherit;padding:8px 12px;border-radius:9px;font-weight:700;">작업</button>
    <button id="selCancel" style="border:none;background:transparent;color:inherit;font-size:16px;">✕</button>
  `;
  document.body.appendChild(selectionBar);
  selectionBar.querySelector("#selCancel").onclick = exitSelection;
  selectionBar.querySelector("#selMore").onclick = () => Sheets.open("bulk");
  return selectionBar;
}
function updateSelectionBar() {
  const bar = ensureSelectionBar();
  bar.style.display = state.selectionMode ? "flex" : "none";
  bar.querySelector("#selCount").textContent = `${state.selectedIds.size}명 선택됨`;
}

/* ── 즐겨찾기 / 최근 ──────────────────────────────────────── */
function isFavorite(uid) { return !!state.favorites[uid]; }
function addFavorite(c) {
  const uid = contactUid(c);
  if (!state.favorites[uid]) { state.favorites[uid] = c; persistFavorites(); return true; }
  return false;
}
function removeFavorite(uid) {
  if (state.favorites[uid]) { delete state.favorites[uid]; persistFavorites(); return true; }
  return false;
}
function toggleFavorite(c) {
  const uid = contactUid(c);
  if (isFavorite(uid)) { removeFavorite(uid); toast("🗑 즐겨찾기 제거"); }
  else { addFavorite(c); toast("⭐ 즐겨찾기 추가"); }
  refreshView();
}
function recordRecent(uid) {
  if (!uid) return;
  const i = state.recent.indexOf(uid);
  if (i !== -1) state.recent.splice(i, 1);
  state.recent.unshift(uid);
  state.recent = state.recent.slice(0, RECENT_MAX);
  persistRecent();
}

/* ── 상세 시트 ────────────────────────────────────────────── */
function findByUid(uid) { return state.contacts.find(c => contactUid(c) === uid); }

function openDetail(uid) {
  const c = findByUid(uid) || state.favorites[uid];
  if (!c) return;
  recordRecent(uid);
  renderList(state.currentDisplay);

  $("#detailName").textContent = c.성명 || "(이름 없음)";
  $("#detailSub").textContent = [c.팀명, c.직책].filter(Boolean).join(" · ") || "소속 정보 없음";

  const fields = $("#detailFields");
  fields.innerHTML = COLUMNS.map(k => {
    const val = k.includes("전화번호") ? formatPhone(c[k]) : (c[k] || "");
    return `<div class="field-row">
      <div class="flabel">${FIELD_LABELS[k]}</div>
      <div class="fvalue">${escapeHtml(val) || "<span style=\"color:var(--fg-dim);font-weight:400;\">-</span>"}</div>
      ${val ? `<button class="fbtn" data-copy="${escapeHtml(val)}">📋</button>` : ""}
    </div>`;
  }).join("");

  const email = extractEmailAddress(c, state.config.mailDomain);
  if (email) {
    fields.innerHTML += `<div class="field-row">
      <div class="flabel">이메일</div>
      <div class="fvalue">${escapeHtml(email)}</div>
      <button class="fbtn" data-copy="${escapeHtml(email)}">📋</button>
    </div>`;
  }

  fields.querySelectorAll("[data-copy]").forEach(btn => {
    btn.onclick = () => copyText(btn.dataset.copy);
  });

  const mobile = c.휴대전화번호, office = c.전화번호;
  const favNow = isFavorite(uid);
  const actions = $("#detailActions");
  actions.innerHTML = `
    ${mobile ? `<button data-a="callm"><span class="ic">📞</span>휴대전화</button>` : ""}
    ${mobile ? `<button data-a="sms"><span class="ic">💬</span>문자</button>` : ""}
    ${office ? `<button data-a="callo"><span class="ic">☎️</span>사무전화</button>` : ""}
    ${email ? `<button data-a="mail"><span class="ic">📧</span>메일</button>` : ""}
    <button data-a="fav" class="${favNow ? "on" : ""}"><span class="ic">${favNow ? "⭐" : "☆"}</span>즐겨찾기</button>
    <button data-a="copyall"><span class="ic">📄</span>정보복사</button>
    <button data-a="edit"><span class="ic">✏️</span>수정</button>
    <button data-a="delete"><span class="ic">🗑️</span>삭제</button>
  `;
  actions.querySelectorAll("[data-a]").forEach(btn => {
    btn.onclick = () => handleDetailAction(btn.dataset.a, c, uid);
  });

  Sheets.open("detail");
}

function handleDetailAction(action, c, uid) {
  switch (action) {
    case "callm": window.location.href = `tel:${(c.휴대전화번호 || "").replace(/\D/g, "")}`; break;
    case "callo": window.location.href = `tel:${(c.전화번호 || "").replace(/\D/g, "")}`; break;
    case "sms": window.location.href = `sms:${(c.휴대전화번호 || "").replace(/\D/g, "")}`; break;
    case "mail": {
      const email = extractEmailAddress(c, state.config.mailDomain);
      if (email) { window.location.href = `mailto:${email}`; recordRecent(uid); }
      break;
    }
    case "fav": toggleFavorite(c); openDetail(uid); break;
    case "copyall": copyText(COLUMNS.map(k => `${FIELD_LABELS[k]}: ${c[k] || ""}`).join("\n")); break;
    case "edit": Sheets.close("detail"); openForm(c); break;
    case "delete":
      if (confirm(`'${c.성명 || "이 연락처"}'를 삭제하시겠습니까?`)) {
        deleteContact(uid);
        Sheets.close("detail");
        toast("삭제되었습니다");
      }
      break;
  }
}

function copyText(text) {
  if (!text) return;
  const done = () => toast("📋 복사되었습니다");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, cb) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); cb(); } catch (e) { toast("복사 실패"); }
  document.body.removeChild(ta);
}

/* ── 추가 / 수정 폼 ───────────────────────────────────────── */
function openForm(existing) {
  state.editingUid = existing ? contactUid(existing) : null;
  $("#formTitle").textContent = existing ? "연락처 수정" : "연락처 추가";
  $("#formDeleteBtn").style.display = existing ? "block" : "none";
  const fields = $("#formFields");
  fields.innerHTML = COLUMNS.map(k => `
    <div class="formfield">
      <label>${FIELD_LABELS[k]}${k === "휴대전화번호" || k === "전화번호" ? " (숫자만 입력 가능)" : ""}</label>
      <input type="${k.includes("전화번호") ? "tel" : "text"}" data-field="${k}" value="${escapeHtml(existing ? (existing[k] || "") : "")}">
    </div>
  `).join("");
  Sheets.open("form");
  setTimeout(() => fields.querySelector('[data-field="성명"]').focus(), 200);
}

function saveForm() {
  const data = {};
  document.querySelectorAll("#formFields [data-field]").forEach(inp => {
    data[inp.dataset.field] = inp.value.trim();
  });
  if (!COLUMNS.some(k => data[k])) { toast("입력된 정보가 없습니다"); return; }

  if (state.editingUid) {
    const idx = state.contacts.findIndex(c => contactUid(c) === state.editingUid);
    if (idx !== -1) {
      const oldUid = state.editingUid;
      state.contacts[idx] = data;
      const newUid = contactUid(data);
      if (state.favorites[oldUid] && oldUid !== newUid) {
        state.favorites[newUid] = data; delete state.favorites[oldUid]; persistFavorites();
      } else if (state.favorites[oldUid]) {
        state.favorites[oldUid] = data; persistFavorites();
      }
      const ri = state.recent.indexOf(oldUid);
      if (ri !== -1 && oldUid !== newUid) { state.recent[ri] = newUid; persistRecent(); }
    }
  } else {
    state.contacts.push(data);
  }
  persistContacts();
  Sheets.close("form");
  refreshView();
  toast("저장되었습니다");
}

function deleteContact(uid) {
  state.contacts = state.contacts.filter(c => contactUid(c) !== uid);
  persistContacts();
  if (state.favorites[uid]) { delete state.favorites[uid]; persistFavorites(); }
  const ri = state.recent.indexOf(uid);
  if (ri !== -1) { state.recent.splice(ri, 1); persistRecent(); }
  refreshView();
}

/* ── 대량 작업 ────────────────────────────────────────────── */
function selectedContacts() {
  return [...state.selectedIds].map(findByUid).filter(Boolean);
}
function bindBulkActions() {
  $("#bulkFav").onclick = () => {
    let n = 0;
    selectedContacts().forEach(c => { if (addFavorite(c)) n++; });
    toast(`⭐ ${n}건 즐겨찾기 추가`); exitSelection(); refreshView(); Sheets.close("bulk");
  };
  $("#bulkUnfav").onclick = () => {
    let n = 0;
    [...state.selectedIds].forEach(uid => { if (removeFavorite(uid)) n++; });
    toast(`🗑 ${n}건 즐겨찾기 제거`); exitSelection(); refreshView(); Sheets.close("bulk");
  };
  $("#bulkMail").onclick = () => {
    const emails = selectedContacts().map(c => extractEmailAddress(c, state.config.mailDomain)).filter(Boolean);
    if (!emails.length) { toast("유효한 이메일이 없습니다"); return; }
    window.location.href = `mailto:${emails.join(";")}`;
    Sheets.close("bulk"); exitSelection();
  };
  $("#bulkCopy").onclick = () => {
    const text = selectedContacts().map(c => COLUMNS.map(k => `${FIELD_LABELS[k]}: ${c[k] || ""}`).join("\n")).join("\n\n---\n\n");
    copyText(text);
    Sheets.close("bulk");
  };
  $("#bulkDelete").onclick = () => {
    const n = state.selectedIds.size;
    if (confirm(`선택한 ${n}건을 삭제하시겠습니까?`)) {
      const ids = new Set(state.selectedIds);
      state.contacts = state.contacts.filter(c => !ids.has(contactUid(c)));
      persistContacts();
      ids.forEach(uid => { delete state.favorites[uid]; });
      persistFavorites();
      state.recent = state.recent.filter(uid => !ids.has(uid));
      persistRecent();
      toast(`${n}건 삭제되었습니다`);
      exitSelection(); refreshView(); Sheets.close("bulk");
    }
  };
}

/* ── 통계 ─────────────────────────────────────────────────── */
function computeCounts(field) {
  const counts = {};
  state.contacts.forEach(c => {
    const key = c[field] || "미분류";
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}
function renderStats(kind) {
  const counts = computeCounts(kind === "team" ? "팀명" : "직책");
  const total = state.contacts.length;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  $("#statsSub").textContent = `전체 ${total}명 · ${entries.length}개 그룹`;
  $("#statsBody").innerHTML = entries.map(([k, v]) => {
    const pct = total ? (v / total * 100) : 0;
    return `<div class="stat-row">
      <div class="sname" title="${escapeHtml(k)}">${escapeHtml(k)}</div>
      <div class="sbar-wrap"><div class="sbar" style="width:${pct}%"></div></div>
      <div class="scount">${v}명 (${pct.toFixed(1)}%)</div>
    </div>`;
  }).join("") || `<div class="empty-state"><p>데이터가 없습니다</p></div>`;
}

/* ── 가져오기 ─────────────────────────────────────────────── */
async function handleFileImport(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  const progWrap = $("#importProgressWrap"), prog = $("#importProgress");
  progWrap.style.display = "block"; prog.style.width = "10%";

  try {
    let rows;
    if (ext === "csv") rows = await parseCsvFile(file);
    else if (ext === "xlsx" || ext === "xls") rows = await parseXlsxFile(file);
    else if (ext === "json") rows = await parseJsonFile(file);
    else { toast("지원하지 않는 파일 형식입니다"); progWrap.style.display = "none"; return; }

    prog.style.width = "60%";
    const cleaned = rows
      .map(r => {
        const c = {};
        COLUMNS.forEach(k => { c[k] = String(r[k] ?? "").trim(); });
        return c;
      })
      .filter(c => COLUMNS.some(k => c[k]));

    if (!cleaned.length) { toast("가져올 데이터가 없습니다"); progWrap.style.display = "none"; return; }

    let replace = true;
    if (state.contacts.length > 0) {
      replace = confirm(
        `현재 ${state.contacts.length}건의 데이터가 있습니다.\n\n` +
        `[확인] 기존 데이터를 삭제하고 새로 가져오기\n[취소] 기존 데이터 뒤에 추가하기`
      );
    }
    if (replace) state.contacts = cleaned;
    else state.contacts = state.contacts.concat(cleaned);

    prog.style.width = "100%";
    persistContacts();
    setTimeout(() => { progWrap.style.display = "none"; prog.style.width = "0%"; }, 400);
    toast(`✅ ${cleaned.length}건 가져오기 완료 (${replace ? "덮어쓰기" : "추가"})`);
    Sheets.close("data");
    refreshView();
  } catch (e) {
    console.error(e);
    progWrap.style.display = "none";
    toast("가져오기 실패: " + e.message);
  }
}

function parseCsvFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(reader.result);
      } catch (e) {
        try { text = new TextDecoder("euc-kr").decode(reader.result); }
        catch (e2) { text = new TextDecoder("utf-8").decode(reader.result); }
      }
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      resolve(parseCsvText(text));
    };
    reader.onerror = () => reject(new Error("파일 읽기 실패"));
    reader.readAsArrayBuffer(file);
  });
}
function parseCsvText(text) {
  const rows = [];
  let field = "", row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (ch === "\r") { /* skip */ }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.some(v => v && v.trim())).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] ?? ""; });
    return obj;
  });
}
function parseXlsxFile(file) {
  return new Promise((resolve, reject) => {
    if (typeof XLSX === "undefined") { reject(new Error("엑셀 파서를 불러오지 못했습니다. 인터넷 연결을 확인해주세요.")); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const wb = XLSX.read(reader.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
        resolve(json);
      } catch (e) { reject(e); }
    };
    reader.onerror = () => reject(new Error("파일 읽기 실패"));
    reader.readAsArrayBuffer(file);
  });
}
function parseJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        resolve(Array.isArray(data) ? data : (data.contacts || []));
      } catch (e) { reject(new Error("JSON 파싱 실패")); }
    };
    reader.onerror = () => reject(new Error("파일 읽기 실패"));
    reader.readAsText(file, "utf-8");
  });
}

/* ── 내보내기 ─────────────────────────────────────────────── */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
}
function exportCsv() {
  if (!state.contacts.length) { toast("내보낼 데이터가 없습니다"); return; }
  const lines = [COLUMNS.join(",")];
  state.contacts.forEach(c => {
    lines.push(COLUMNS.map(k => csvEscape(c[k] || "")).join(","));
  });
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `주소록_${todayStr()}.csv`);
  toast("CSV로 내보냈습니다");
}
function csvEscape(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function exportJson() {
  if (!state.contacts.length) { toast("내보낼 데이터가 없습니다"); return; }
  const blob = new Blob([JSON.stringify(state.contacts, null, 2)], { type: "application/json" });
  downloadBlob(blob, `주소록_${todayStr()}.json`);
  toast("JSON으로 내보냈습니다");
}
function exportXlsx() {
  if (!state.contacts.length) { toast("내보낼 데이터가 없습니다"); return; }
  if (typeof XLSX === "undefined") { toast("엑셀 파서를 불러오지 못했습니다"); return; }
  const ws = XLSX.utils.json_to_sheet(state.contacts, { header: COLUMNS });
  ws["!cols"] = COLUMNS.map(k => ({ wch: Math.max(k.length + 4, 14) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "연락처");
  XLSX.writeFile(wb, `주소록_${todayStr()}.xlsx`);
  toast("Excel로 내보냈습니다");
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
}

/* ── 시트(모달) 관리 ──────────────────────────────────────── */
const Sheets = {
  map: { detail: "overlayDetail", form: "overlayForm", stats: "overlayStats", data: "overlayData", settings: "overlaySettings", bulk: "overlayBulk" },
  open(name) {
    const overlay = document.getElementById(this.map[name]);
    if (!overlay) return;
    overlay.classList.add("show");
    if (name === "stats") renderStats("team");
    if (name === "bulk") $("#bulkTitle").textContent = `${state.selectedIds.size}명 선택됨`;
    if (name === "settings") {
      $("#mailDomainInput").value = state.config.mailDomain || "";
      $("#themeStateDesc").textContent = `현재: ${state.config.theme === "dark" ? "다크" : "라이트"}`;
    }
  },
  close(name) {
    const overlay = document.getElementById(this.map[name]);
    if (overlay) overlay.classList.remove("show");
  },
  closeAll() { Object.values(this.map).forEach(id => document.getElementById(id).classList.remove("show")); },
};
window.Sheets = Sheets;

/* ── 토스트 ───────────────────────────────────────────────── */
let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2200);
}

/* ── 이벤트 바인딩 ────────────────────────────────────────── */
function bindEvents() {
  let searchTimer;
  el.searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refreshView, 140);
  });
  el.searchInput.addEventListener("change", () => {
    const q = el.searchInput.value.trim();
    if (q) recordSearchHistory(q);
  });
  el.scopeSelect.addEventListener("change", refreshView);
  el.clearSearchBtn.addEventListener("click", () => {
    el.searchInput.value = ""; refreshView(); el.searchInput.focus();
  });

  el.chipRow.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    if (chip.dataset.filter) {
      state.filterMode = chip.dataset.filter;
      el.chipRow.querySelectorAll("[data-filter]").forEach(c => c.classList.toggle("active", c === chip));
      refreshView();
    } else if (chip.dataset.sort) {
      const field = chip.dataset.sort === "team" ? "팀명" : chip.dataset.sort === "name" ? "성명" : "직책";
      if (state.sortField === field) state.sortReverse = !state.sortReverse;
      else { state.sortField = field; state.sortReverse = false; }
      refreshView();
    }
  });

  document.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const overlay = e.target.closest(".overlay");
      if (overlay) overlay.classList.remove("show");
    });
  });
  document.querySelectorAll(".overlay").forEach(ov => {
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.classList.remove("show"); });
  });

  $("#btnTheme").addEventListener("click", toggleTheme);
  $("#btnToggleThemeSettings").addEventListener("click", toggleTheme);

  document.querySelector('[data-nav="stats"]').addEventListener("click", () => Sheets.open("stats"));
  document.querySelector('[data-nav="data"]').addEventListener("click", () => Sheets.open("data"));
  document.querySelector('[data-nav="settings"]').addEventListener("click", () => Sheets.open("settings"));
  $("#navAddBtn").addEventListener("click", () => openForm(null));
  document.querySelector('[data-nav="list"]').addEventListener("click", () => Sheets.closeAll());

  document.querySelectorAll(".stat-tabs [data-stat]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".stat-tabs [data-stat]").forEach(b => b.classList.toggle("active", b === btn));
      renderStats(btn.dataset.stat);
    });
  });

  $("#formSaveBtn").addEventListener("click", saveForm);
  $("#formDeleteBtn").addEventListener("click", () => {
    if (state.editingUid && confirm("이 연락처를 삭제하시겠습니까?")) {
      deleteContact(state.editingUid);
      Sheets.close("form");
      toast("삭제되었습니다");
    }
  });

  $("#btnPickFile").addEventListener("click", () => $("#fileInput").click());
  $("#importDrop").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", (e) => {
    if (e.target.files[0]) handleFileImport(e.target.files[0]);
    e.target.value = "";
  });
  $("#btnExportCsv").addEventListener("click", exportCsv);
  $("#btnExportXlsx").addEventListener("click", exportXlsx);
  $("#btnExportJson").addEventListener("click", exportJson);

  $("#mailDomainInput").addEventListener("change", (e) => {
    state.config.mailDomain = e.target.value.trim();
    persistConfig();
    toast("메일 도메인이 저장되었습니다");
  });
  $("#btnClearSearchHistory").addEventListener("click", () => {
    state.config.searchHistory = []; persistConfig(); setupSearchHistoryList();
    toast("검색 기록이 삭제되었습니다");
  });
  $("#btnClearAll").addEventListener("click", () => {
    if (confirm("정말 모든 연락처, 즐겨찾기, 최근 기록을 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.")) {
      state.contacts = []; state.favorites = {}; state.recent = [];
      persistContacts(); persistFavorites(); persistRecent();
      refreshView(); Sheets.close("settings");
      toast("모든 데이터가 삭제되었습니다");
    }
  });

  bindBulkActions();

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") Sheets.closeAll();
  });
}

function recordSearchHistory(q) {
  const hist = state.config.searchHistory || [];
  const i = hist.indexOf(q);
  if (i !== -1) hist.splice(i, 1);
  hist.unshift(q);
  state.config.searchHistory = hist.slice(0, SEARCH_HISTORY_MAX);
  persistConfig();
  setupSearchHistoryList();
}

function toggleTheme() {
  state.config.theme = state.config.theme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", state.config.theme);
  persistConfig();
  const desc = document.getElementById("themeStateDesc");
  if (desc) desc.textContent = `현재: ${state.config.theme === "dark" ? "다크" : "라이트"}`;
  toast(`테마: ${state.config.theme === "dark" ? "다크" : "라이트"}`);
}

/* ── 서비스 워커 (오프라인/설치) ──────────────────────────── */
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
}

init();
