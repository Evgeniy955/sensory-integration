// Schedule board (admin/schedule.html): rooms × hourly-slot grid for one
// working day (08:00–19:00), stored as a single JSONB row in
// public.schedule_boards (id='main'). Loaded after supabase-config.js +
// admin-auth.js (needs window.sbClient).
//
// The whole board lives in one in-memory object (`board`) that's
// re-rendered top to bottom on every change and pushed to Supabase
// shortly after:
//   - board.rooms — the columns (add/rename/delete from the "Керування
//     залом" panel), same as before.
//   - board.specialists — the saved roster (managed from "Керування
//     спеціалістом"), offered as a dropdown when filling a slot.
//   - board.cells — keyed "roomId|YYYY-MM-DD|HH" (a specific room, date
//     *and* hour), value { specialistId, anketaId, childName, noShow } for
//     regular bookings, or the same legacy fields plus specialistIds,
//     children and isGroup for group bookings.
//     Only one day is shown at a time; `currentDate` (module state, not
//     saved) tracks which one, moved by the ◀ / ▶ buttons or the
//     calendar picker.
//
// A slot's child is picked from the existing anketas (parent
// questionnaires) table via search-as-you-type — never free text.
// `anketaId` records which specific anketa row was on file at booking
// time, but attendance itself is looked up by (normalized) `childName`,
// not `anketaId` — editing an anketa (admin/anketa-form.html) always
// saves a new row with a new id, so matching on anketaId would silently
// lose a child's attendance history the moment their anketa is edited.
// `noShow` exists because a past slot counts as an attended visit by
// default (nobody confirms attendance one by one) — marking it lets that
// same anketa-page count exclude days the child was booked but didn't
// actually come.

(function () {
  const WEEKDAY_FULL = ["неділя", "понеділок", "вівторок", "середа", "четвер", "п'ятниця", "субота"];

  const MONTHS_GENITIVE = [
    "січня", "лютого", "березня", "квітня", "травня", "червня",
    "липня", "серпня", "вересня", "жовтня", "листопада", "грудня",
  ];

  // One row per hour of the 08:00–19:00 working day (last slot starts at
  // 18:00, ends 19:00) — 11 rows total.
  const START_HOUR = 8;
  const END_HOUR = 19;
  const HOURS = [];
  for (let h = START_HOUR; h < END_HOUR; h++) HOURS.push(h);

  // Cycled across rooms in creation order. Bold/saturated on purpose (see
  // the "Room tint" comment in schedule.css) rather than the public
  // site's pastel tokens — legibility across a crowded staff table
  // matters more here than the sensory-gentle palette the landing page
  // uses. Three hues before a 4th room repeats a color.
  const ROOM_COLORS = ["yellow", "red", "blue"];

  // A wider cycle than rooms — there are usually more specialists than
  // rooms, and the point here is telling *people* apart across the grid
  // (a booked cell is tinted by whoever's in it, not by which room it's
  // in), so more distinct hues before repeating matters more.
  const SPECIALIST_COLORS = ["teal", "violet", "orange", "lime", "cyan", "rose", "amber", "slate"];

  const BOARD_ROW_ID = "main";
  const CHILD_SEARCH_MIN_LEN = 2;
  const CHILD_SEARCH_DEBOUNCE_MS = 250;

  let board = null;
  let currentProfileId = null;
  let canEdit = true; // false for instructors — view the grid, cannot change it
  let saveTimer = null;
  let managedRoomId = null; // room targeted by the toolbar's rename/delete controls
  let managedSpecialistId = null; // specialist targeted by the toolbar's rename/delete controls
  let currentDate = new Date(); // the day currently shown; normalized to midnight below
  currentDate.setHours(0, 0, 0, 0);

  // Cell modal state — which slot is being edited, and what the child
  // autocomplete currently has selected (only a *selected* anketa can be
  // saved, never arbitrary typed text).
  let editingKey = null;
  let editingRoomId = null;
  let editingHour = null;
  let selectedAnketaId = null;
  let selectedChildName = "";
  let editingGroup = false;
  let groupChildren = [];
  let editingNoShow = false;
  let editingTransferred = false;
  let editingTransferDate = "";
  let editingTransferHour = "";
  let cellSubscriptions = [];
  let childSearchTimer = null;
  let childSearchToken = 0; // discards stale async results if a newer search started

  function uid() {
    return (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // Same normalization admin/anketa.html uses to group a child's anketa
  // versions — used here so attendance matches by child, not by whichever
  // specific anketa row happened to be selected when the slot was booked.
  function normalizeChildName(s) {
    return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  // ---------- Date helpers (no library — just plain Date math) ----------
  function pad2(n) { return String(n).padStart(2, "0"); }

  function toISODate(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function parseISODate(s) {
    const parts = String(s).split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }

  function addIsoDays(value, days) { return toISODate(addDays(parseISODate(value), days)); }
  function remainingSessions(subscription) { return Math.max(0, Number(subscription.sessions_total || 0) - Number(subscription.sessions_used || 0)); }
  function uniqueUsedSessions(rows) { return new Set(rows.filter((row) => row.status !== "transferred").map((row) => row.schedule_cell_key)).size; }
  function latestDate(rows, field) { return rows.reduce((latest, row) => row[field] && (!latest || row[field] > latest) ? row[field] : latest, ""); }
  function effectiveSubscriptionEnd(subscription, attendance) {
    const frozenEnd = addIsoDays(subscription.base_ends_on || subscription.ends_on, Number(subscription.freeze_days || 0));
    const transferredEnd = latestDate(attendance.filter((row) => row.status === "transferred"), "transferred_to_date");
    return transferredEnd && transferredEnd > frozenEnd ? transferredEnd : frozenEnd;
  }

  async function updateSubscriptionLifecycle(subscriptionId) {
    const [subscriptionResult, attendanceResult] = await Promise.all([
      window.sbClient.from("subscriptions").select("id, sessions_total, sessions_used, ends_on, base_ends_on, freeze_days, burned_sessions, closed_reason, closed_at").eq("id", subscriptionId).single(),
      window.sbClient.from("subscription_attendance").select("schedule_cell_key, status, session_date, transferred_to_date").eq("subscription_id", subscriptionId),
    ]);
    if (subscriptionResult.error || attendanceResult.error) return;
    const subscription = subscriptionResult.data;
    const attendance = attendanceResult.data || [];
    const actualUsed = Math.min(uniqueUsedSessions(attendance), Number(subscription.sessions_total));
    const endsOn = effectiveSubscriptionEnd(subscription, attendance);
    const expired = actualUsed < Number(subscription.sessions_total) && endsOn < toISODate(new Date());
    const burned = expired ? Number(subscription.sessions_total) - actualUsed : 0;
    const lastUsedDate = latestDate(attendance.filter((row) => row.status !== "transferred"), "session_date");
    const reason = expired ? "expired" : (actualUsed >= Number(subscription.sessions_total) && lastUsedDate && lastUsedDate < endsOn ? "early" : null);
    const update = { ends_on: endsOn, sessions_used: actualUsed + burned, burned_sessions: burned, closed_reason: reason, closed_at: reason ? (subscription.closed_reason === reason && subscription.closed_at ? subscription.closed_at : new Date().toISOString()) : null };
    const differs = Object.keys(update).some((key) => String(subscription[key] == null ? "" : subscription[key]) !== String(update[key] == null ? "" : update[key]));
    if (differs) await window.sbClient.from("subscriptions").update(update).eq("id", subscriptionId);
  }

  function formatDayLabel(d) {
    const weekday = WEEKDAY_FULL[d.getDay()];
    const capitalized = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    return capitalized + ", " + d.getDate() + " " + MONTHS_GENITIVE[d.getMonth()] + " " + d.getFullYear();
  }

  function hourLabel(h) { return pad2(h) + ":00–" + pad2(h + 1) + ":00"; }

  function cellKey(roomId, dateIso, hour) {
    return roomId + "|" + dateIso + "|" + pad2(hour);
  }

  function defaultBoard() {
    return {
      rooms: [
        { id: uid(), name: "Зал 1", color: "yellow" },
        { id: uid(), name: "Зал 2", color: "red" },
        { id: uid(), name: "Зал 3", color: "blue" },
      ],
      specialists: [],
      cells: {},
    };
  }

  // Older boards keyed cells "rowId|date" (whole-day, specialist-per-row)
  // or "rowId|weekday" (before dates existed at all) — neither carries an
  // hour or a child, so there is nothing meaningful to carry forward into
  // the new room×hour×child shape. Anything not already in the current
  // "roomId|date|HH" → {specialistId, anketaId, childName} shape is
  // dropped rather than guessed at.
  function normalizeBoard(raw) {
    const fallback = defaultBoard();
    if (!raw || typeof raw !== "object") return fallback;

    // Color is always re-derived from a room's position, not whatever was
    // last saved — see the schedule-slots-attendance branch history for
    // why (no manual color picker exists, so a stored value is only ever
    // a leftover from a previous palette version).
    const rooms = Array.isArray(raw.rooms) && raw.rooms.length
      ? raw.rooms.filter((r) => r && r.id && r.name != null).map((r, i) => ({
          id: String(r.id), name: String(r.name), color: ROOM_COLORS[i % ROOM_COLORS.length],
        }))
      : fallback.rooms;

    // Same index-derived-color reasoning as rooms above.
    const specialists = Array.isArray(raw.specialists)
      ? raw.specialists.filter((s) => s && s.id).map((s, i) => ({
          id: String(s.id), name: String(s.name || ""), color: SPECIALIST_COLORS[i % SPECIALIST_COLORS.length],
        }))
      : [];

    const roomIds = new Set(rooms.map((r) => r.id));
    const cells = {};
    if (raw.cells && typeof raw.cells === "object") {
      Object.keys(raw.cells).forEach((key) => {
        const parts = key.split("|");
        const value = raw.cells[key];
        if (parts.length !== 3 || !value || typeof value !== "object") return;
        const [roomId, dateIso, hour] = parts;
        if (!roomIds.has(roomId) || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso) || !/^\d{2}$/.test(hour)) return;
        cells[key] = {
          specialistId: value.specialistId ? String(value.specialistId) : null,
          specialistIds: Array.isArray(value.specialistIds) ? value.specialistIds.filter(Boolean).map(String) : (value.specialistId ? [String(value.specialistId)] : []),
          anketaId: value.anketaId ? String(value.anketaId) : null,
          childName: value.childName ? String(value.childName) : "",
          children: Array.isArray(value.children) ? value.children.filter((c) => c && c.anketaId).map((c) => ({ anketaId: String(c.anketaId), childName: String(c.childName || ""), status: c.status === "transferred" ? "transferred" : (c.status === "no_show" ? "no_show" : "attended"), subscriptionId: c.subscriptionId ? String(c.subscriptionId) : null, transferDate: /^\d{4}-\d{2}-\d{2}$/.test(c.transferDate || "") ? c.transferDate : "", transferHour: Number.isInteger(Number(c.transferHour)) ? Number(c.transferHour) : null })) : (value.anketaId ? [{ anketaId: String(value.anketaId), childName: String(value.childName || ""), status: value.noShow ? "no_show" : "attended", subscriptionId: value.subscriptionId ? String(value.subscriptionId) : null, transferDate: value.transferDate || "", transferHour: value.transferHour || null }] : []),
          isGroup: !!value.isGroup,
          subscriptionId: value.subscriptionId ? String(value.subscriptionId) : null,
          attendanceStatus: value.attendanceStatus === "transferred" ? "transferred" : (value.noShow ? "no_show" : "attended"),
          transferDate: /^\d{4}-\d{2}-\d{2}$/.test(value.transferDate || "") ? value.transferDate : "",
          transferHour: Number.isInteger(Number(value.transferHour)) ? Number(value.transferHour) : null,
          noShow: !!value.noShow,
        };
      });
    }

    return { rooms, specialists, cells };
  }

  function setStatus(state, detail) {
    const el = document.getElementById("save-status");
    if (!el) return;
    el.dataset.state = state;
    if (state === "saving") el.textContent = "Зберігаємо…";
    else if (state === "saved") {
      el.textContent = "Збережено " + new Date().toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
    } else if (state === "error") el.textContent = "Помилка збереження" + (detail ? ": " + detail : "");
    else el.textContent = "";
  }

  async function loadBoard() {
    const { data, error } = await window.sbClient
      .from("schedule_boards")
      .select("data")
      .eq("id", BOARD_ROW_ID)
      .maybeSingle();

    if (error) {
      setStatus("error", error.message);
      return defaultBoard();
    }
    return normalizeBoard(data && data.data);
  }

  async function saveBoard() {
    setStatus("saving");
    const { error } = await window.sbClient.from("schedule_boards").upsert({
      id: BOARD_ROW_ID,
      data: board,
      updated_by: currentProfileId,
      updated_at: new Date().toISOString(),
    });
    if (error) { setStatus("error", error.message); return; }
    setStatus("saved");
  }

  // Typed text edits (renaming a room/specialist) debounce so we don't
  // fire a write per keystroke; discrete actions (saving/clearing a slot,
  // adding/removing a room or specialist) call saveBoard() directly since
  // those are already one-click, infrequent actions.
  function scheduleSave() {
    setStatus("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBoard, 700);
  }
  function flushSave() {
    clearTimeout(saveTimer);
    saveBoard();
  }

  function getManagedRoom() {
    return board.rooms.find((r) => r.id === managedRoomId) || null;
  }

  function getManagedSpecialist() {
    return board.specialists.find((s) => s.id === managedSpecialistId) || null;
  }

  function specialistName(id) {
    if (!id) return "Без спеціаліста";
    const spec = board.specialists.find((s) => s.id === id);
    return spec ? (spec.name || "Без імені") : "спеціаліст видалений";
  }

  function entrySpecialistIds(entry) {
    return entry && Array.isArray(entry.specialistIds) && entry.specialistIds.length
      ? entry.specialistIds : (entry && entry.specialistId ? [entry.specialistId] : []);
  }

  function entryChildren(entry) {
    return entry && Array.isArray(entry.children) && entry.children.length
      ? entry.children : (entry && entry.anketaId ? [{ anketaId: entry.anketaId, childName: entry.childName || "" }] : []);
  }

  function findConcurrentConflicts(entry, dateIso, hour, excludedKeys) {
    const excluded = new Set(excludedKeys || []);
    const candidateSpecialists = new Set(entrySpecialistIds(entry).filter(Boolean));
    const candidateChildren = new Set(entryChildren(entry).map((child) => normalizeChildName(child.childName)).filter(Boolean));
    const specialistConflicts = new Set();
    const childConflicts = new Set();
    Object.keys(board.cells).forEach((key) => {
      if (excluded.has(key)) return;
      const parts = key.split("|");
      if (parts.length !== 3 || parts[1] !== dateIso || Number(parts[2]) !== Number(hour)) return;
      const scheduled = board.cells[key];
      entrySpecialistIds(scheduled).forEach((id) => { if (candidateSpecialists.has(id)) specialistConflicts.add(specialistName(id)); });
      entryChildren(scheduled).forEach((child) => {
        const name = normalizeChildName(child.childName);
        if (candidateChildren.has(name)) childConflicts.add(child.childName);
      });
    });
    return { specialists: [...specialistConflicts], children: [...childConflicts] };
  }

  function conflictMessage(conflicts, dateIso, hour) {
    const parts = [];
    if (conflicts.specialists.length) parts.push("спеціаліст: " + conflicts.specialists.join(", "));
    if (conflicts.children.length) parts.push("дитина: " + conflicts.children.join(", "));
    return "На " + dateIso + " о " + pad2(hour) + ":00 уже є запис (" + parts.join("; ") + "). Оберіть інший час або зал.";
  }

  // Slot backgrounds are tinted by *specialist*, not room — the room is
  // already identified by which column a cell sits in (headers carry the
  // room color), so using the cell's own background to carry the
  // specialist's identity instead is what actually lets you spot "where
  // is this person today" across every room at a glance. Falls back to a
  // neutral, uncolored tint if the specialist was removed from the
  // roster since this slot was booked.
  function specialistColor(id) {
    if (!id) return null;
    const spec = board.specialists.find((s) => s.id === id);
    return spec ? spec.color : null;
  }

  // ---------- Grid rendering ----------
  function renderThead() {
    const thead = document.getElementById("schedule-thead");
    thead.innerHTML = "<tr>" +
      '<th class="schedule-col-time">Час</th>' +
      board.rooms.map((r) =>
        '<th class="schedule-room-th schedule-cell--' + r.color + '">' + escapeHtml(r.name) + "</th>"
      ).join("") +
      "</tr>";
  }

  function slotCellHtml(room, hour, dateIso) {
    const key = cellKey(room.id, dateIso, hour);
    const entry = board.cells[key];
    const specColor = entry ? specialistColor(entry.specialistId) : null;
    const colorClass = entry ? "schedule-specialist--" + (specColor || "none") : "";
    const label = hourLabel(hour);
    // Only the child's name reads as "didn't happen" — the specialist
    // still gets paid for a no-show, so their name stays normal.
    const noShowClass = entry && entry.noShow ? " schedule-slot-text--noshow" : "";
    const specChipClass = "schedule-slot-specialist--" + (specColor || "none");
    const specialists = entry ? entrySpecialistIds(entry) : [];
    const children = entry ? entryChildren(entry) : [];
    const inner = entry
      ? '<span class="schedule-slot-specialist ' + specChipClass + '">' + escapeHtml(specialists.map(specialistName).join(", ")) + "</span>" +
        '<span class="schedule-slot-child' + noShowClass + '">' + escapeHtml(children.map((c) => c.childName).join(", ")) + "</span>" +
        (entry.attendanceStatus === "transferred" ? '<span class="schedule-slot-noshow-badge schedule-slot-transfer-badge">перенос</span>' : (entry.noShow ? '<span class="schedule-slot-noshow-badge">не прийшов</span>' : ""))
      : '<span class="schedule-slot-add" aria-hidden="true">+</span>';
    const ariaLabel = room.name + ", " + label +
      (entry ? ": " + specialists.map(specialistName).join(", ") + ", " + children.map((c) => c.childName).join(", ") + (entry.noShow ? ", дитина не прийшла" : "") : ": вільно");
    return '<td class="schedule-slot-cell ' + colorClass + '">' +
      '<button type="button" class="schedule-slot-btn" data-cell="' + key + '" data-room="' + room.id +
      '" data-hour="' + hour + '" aria-label="' + escapeHtml(ariaLabel) + '">' + inner + "</button></td>";
  }

  function renderTbody(dateIso) {
    const tbody = document.getElementById("schedule-tbody");
    if (!board.rooms.length) {
      tbody.innerHTML = '<tr><td class="anketa-table-empty">Ще немає жодного залу. Натисніть «Управління» → «Додати зал».</td></tr>';
      return;
    }
    tbody.innerHTML = HOURS.map((h) =>
      '<tr><td class="schedule-col-time">' + hourLabel(h) + "</td>" +
      board.rooms.map((room) => slotCellHtml(room, h, dateIso)).join("") + "</tr>"
    ).join("");
  }

  function populateRoomSelect() {
    const select = document.getElementById("room-select");
    select.innerHTML = board.rooms.map((r) =>
      '<option value="' + r.id + '"' + (r.id === managedRoomId ? " selected" : "") + ">" + escapeHtml(r.name) + "</option>"
    ).join("");
  }

  function updateRoomNameField() {
    const room = getManagedRoom();
    document.getElementById("room-name-input").value = room ? room.name : "";
  }

  function syncRoomControls() {
    if (!board.rooms.some((r) => r.id === managedRoomId)) {
      managedRoomId = board.rooms.length ? board.rooms[0].id : null;
    }
    populateRoomSelect();
    updateRoomNameField();
    render();
  }

  function populateSpecialistSelect() {
    const select = document.getElementById("specialist-select");
    select.innerHTML = board.specialists.map((s) =>
      '<option value="' + s.id + '"' + (s.id === managedSpecialistId ? " selected" : "") + ">" + escapeHtml(s.name || "Без імені") + "</option>"
    ).join("");
  }

  function updateSpecialistNameField() {
    const spec = getManagedSpecialist();
    document.getElementById("specialist-name-input").value = spec ? spec.name : "";
  }

  function syncSpecialistControls() {
    if (!board.specialists.some((s) => s.id === managedSpecialistId)) {
      managedSpecialistId = board.specialists.length ? board.specialists[0].id : null;
    }
    populateSpecialistSelect();
    updateSpecialistNameField();
    render(); // slot labels show specialist names — refresh them too
  }

  function updateDayControls() {
    document.getElementById("day-label").textContent = formatDayLabel(currentDate);
    const dateInput = document.getElementById("calendar-date-input");
    if (dateInput) dateInput.value = toISODate(currentDate);
  }

  function goToDay(newDate) {
    currentDate = newDate;
    updateDayControls();
    render();
  }

  function render() {
    renderThead();
    renderTbody(toISODate(currentDate));
  }

  // ---------- Rooms ----------
  function addRoom() {
    const color = ROOM_COLORS[board.rooms.length % ROOM_COLORS.length];
    const room = { id: uid(), name: "Зал " + (board.rooms.length + 1), color };
    board.rooms.push(room);
    managedRoomId = room.id;
    syncRoomControls();
    flushSave();
  }

  function removeRoom(id) {
    if (!id) return;
    if (board.rooms.length <= 1) {
      window.alert("Має залишитися хоча б один зал.");
      return;
    }
    const room = board.rooms.find((r) => r.id === id);
    if (!room) return;
    const confirmed = window.confirm('Видалити зал «' + room.name + '»? Усі записи в ньому також буде очищено.');
    if (!confirmed) return;
    board.rooms = board.rooms.filter((r) => r.id !== id);
    Object.keys(board.cells).forEach((key) => { if (key.startsWith(id + "|")) delete board.cells[key]; });
    syncRoomControls();
    flushSave();
  }

  // ---------- Specialists ----------
  function addSpecialist() {
    const color = SPECIALIST_COLORS[board.specialists.length % SPECIALIST_COLORS.length];
    const spec = { id: uid(), name: "", color };
    board.specialists.push(spec);
    managedSpecialistId = spec.id;
    syncSpecialistControls();
    flushSave();
    document.getElementById("specialist-name-input").focus();
  }

  // Removes a specialist from the saved roster. Slots that had them
  // assigned keep their child but lose the specialist ("Без спеціаліста")
  // rather than being cleared outright — the booking itself isn't lost.
  function removeSpecialist(id) {
    if (!id) return;
    const spec = board.specialists.find((s) => s.id === id);
    if (!spec) return;
    const confirmed = window.confirm(
      "Видалити спеціаліста" + (spec.name ? " «" + spec.name + "»" : "") + " зі списку? У записах розкладу він стане «Без спеціаліста» (сама клітинка збережеться)."
    );
    if (!confirmed) return;
    board.specialists = board.specialists.filter((s) => s.id !== id);
    Object.values(board.cells).forEach((entry) => {
      if (entry.specialistId === id) entry.specialistId = null;
      if (Array.isArray(entry.specialistIds)) entry.specialistIds = entry.specialistIds.filter((specialistId) => specialistId !== id);
    });
    syncSpecialistControls();
    flushSave();
  }

  // ---------- Child autocomplete (search-only, no free text) ----------
  function childResultsEl() { return document.getElementById("cell-child-results"); }

  function hideChildResults() {
    const el = childResultsEl();
    el.hidden = true;
    el.innerHTML = "";
  }

  async function searchAnketas(query) {
    const { data, error } = await window.sbClient
      .from("anketas")
      .select("id, child_full_name")
      .ilike("child_full_name", "%" + query + "%")
      .order("child_full_name")
      .limit(8);
    if (error) return [];
    return data || [];
  }

  function renderChildResults(results) {
    const el = childResultsEl();
    if (!results.length) {
      el.innerHTML = '<div class="schedule-child-results__empty">Нікого не знайдено — переконайтесь, що анкета дитини вже додана.</div>';
      el.hidden = false;
      return;
    }
    el.innerHTML = results.map((r) =>
      '<button type="button" class="schedule-child-results__item" data-anketa-id="' + r.id +
      '" data-child-name="' + escapeHtml(r.child_full_name || "") + '">' + escapeHtml(r.child_full_name || "(без імені)") + "</button>"
    ).join("");
    el.hidden = false;
  }

  function onChildInput(e) {
    // Any manual edit invalidates a previous selection — must re-pick
    // from the list, never save arbitrary typed text as the child.
    selectedAnketaId = null;
    selectedChildName = "";
    const query = e.target.value.trim();
    clearTimeout(childSearchTimer);
    if (query.length < CHILD_SEARCH_MIN_LEN) { hideChildResults(); return; }
    const token = ++childSearchToken;
    childSearchTimer = setTimeout(async () => {
      const results = await searchAnketas(query);
      if (token !== childSearchToken) return; // a newer search superseded this one
      renderChildResults(results);
    }, CHILD_SEARCH_DEBOUNCE_MS);
  }

  function onChildResultsClick(e) {
    const btn = e.target.closest("[data-anketa-id]");
    if (!btn) return;
    selectedAnketaId = btn.getAttribute("data-anketa-id");
    selectedChildName = btn.getAttribute("data-child-name") || "";
    document.getElementById("cell-child-input").value = selectedChildName;
    hideChildResults();
    loadCellSubscriptions();
  }

  // ---------- Cell (slot) modal ----------
  function populateCellSpecialistSelect(currentId) {
    const select = document.getElementById("cell-specialist-select");
    select.innerHTML = '<option value="">— оберіть спеціаліста —</option>' + board.specialists.map((s) =>
      '<option value="' + s.id + '"' + (s.id === currentId ? " selected" : "") + ">" + escapeHtml(s.name || "Без імені") + "</option>"
    ).join("");
  }

  function renderGroupSpecialists(selectedIds) {
    const el = document.getElementById("cell-group-specialists");
    el.innerHTML = board.specialists.map((s) => '<label class="schedule-option"><input type="checkbox" value="' + escapeHtml(s.id) + '"' + (selectedIds.includes(s.id) ? " checked" : "") + "><span>" + escapeHtml(s.name || "Без імені") + "</span></label>").join("") || '<span class="schedule-empty-option">Спочатку додайте спеціалістів у «Керування».</span>';
  }

  function subscriptionsForChild(child) {
    const childName = normalizeChildName(child.childName);
    return cellSubscriptions.filter((subscription) => (subscription.subscription_children || []).some((item) => normalizeChildName(item.child_name) === childName));
  }

  function entrySubscriptionIds(entry) {
    if (!entry) return [];
    return [...new Set(entryChildren(entry).map((child) => child.subscriptionId || entry.subscriptionId).filter(Boolean))];
  }

  function attachSubscriptionToEntry(entry, childName, subscriptionId) {
    if (!entry || !subscriptionId) return false;
    const normalizedName = normalizeChildName(childName);
    let changed = false;
    if (Array.isArray(entry.children)) {
      entry.children.forEach((child) => {
        if (!child.subscriptionId && normalizeChildName(child.childName) === normalizedName) { child.subscriptionId = subscriptionId; changed = true; }
      });
    }
    if (!entry.subscriptionId && normalizeChildName(entry.childName) === normalizedName) { entry.subscriptionId = subscriptionId; changed = true; }
    return changed;
  }

  async function restoreSubscriptionLinks(entry) {
    if (!entry || !entryChildren(entry).some((child) => !(child.subscriptionId || entry.subscriptionId))) return;
    const result = await window.sbClient.from("subscription_attendance").select("subscription_id, child_name").eq("schedule_cell_key", editingKey);
    if (result.error || !(result.data || []).length) return;
    let restored = false;
    (result.data || []).forEach((row) => { restored = attachSubscriptionToEntry(entry, row.child_name, row.subscription_id) || restored; });
    if (!restored) return;
    entryChildren(entry).forEach((child) => {
      const transferDate = child.transferDate || entry.transferDate;
      const transferHour = child.transferHour == null ? entry.transferHour : child.transferHour;
      const subscriptionId = child.subscriptionId || entry.subscriptionId;
      if (!transferDate || !Number.isInteger(Number(transferHour)) || !subscriptionId) return;
      attachSubscriptionToEntry(board.cells[cellKey(editingRoomId, transferDate, Number(transferHour))], child.childName, subscriptionId);
    });
    flushSave();
    await saveSubscriptionAttendance(entry);
  }

  function hourOptions(selectedHour) {
    return HOURS.map((hour) => '<option value="' + hour + '"' + (Number(selectedHour) === hour ? " selected" : "") + '>' + hourLabel(hour) + "</option>").join("");
  }

  function renderGroupChildren() {
    const el = document.getElementById("cell-group-children");
    el.innerHTML = groupChildren.map((child, index) => {
      const status = child.status || "attended";
      const subscriptions = subscriptionsForChild(child);
      const selectedSubscription = subscriptions.find((subscription) => subscription.id === child.subscriptionId);
      const subscriptionSelect = child.anketaId ? '<select class="schedule-child-subscription" data-group-subscription-index="' + index + '"><option value="">Без абонемента</option>' + subscriptions.map((subscription) => '<option value="' + subscription.id + '"' + (subscription.id === child.subscriptionId ? " selected" : "") + '>' + escapeHtml(subscription.direction) + " · залишилось " + remainingSessions(subscription) + " · до " + subscription.ends_on + "</option>").join("") + '</select>' : "";
      const transfer = status === "transferred" ? '<div class="schedule-group-child-transfer"><input type="date" value="' + escapeHtml(child.transferDate || "") + '" data-group-transfer-date-index="' + index + '"><select data-group-transfer-hour-index="' + index + '">' + hourOptions(child.transferHour) + '</select></div>' : "";
      const freeze = selectedSubscription ? '<button type="button" class="anketa-btn schedule-group-child-freeze' + (selectedSubscription.is_frozen ? " is-frozen" : "") + '" data-group-freeze-index="' + index + '">' + (selectedSubscription.is_frozen ? "Розморозити" : "Заморозити") + '</button>' : "";
      return '<div class="schedule-group-child-row"><div class="schedule-child-autocomplete"><input type="text" data-group-child-index="' + index + '" value="' + escapeHtml(child.childName || "") + '" autocomplete="off" placeholder="Почніть вводити ПІБ дитини…"><div class="schedule-child-results" data-group-results-index="' + index + '" hidden></div>' + subscriptionSelect + transfer + freeze + '</div><div class="schedule-child-status-actions"><button type="button" class="schedule-child-status-btn' + (status === "no_show" ? " is-active" : "") + '" data-group-status="no_show" data-group-status-index="' + index + '">Не прийшов</button><button type="button" class="schedule-child-status-btn' + (status === "transferred" ? " is-active" : "") + '" data-group-status="transferred" data-group-status-index="' + index + '">Перенос</button></div>' + (groupChildren.length > 1 ? '<button type="button" class="schedule-remove-child" data-remove-child-index="' + index + '" aria-label="Видалити дитину">×</button>' : "") + '</div>';
    }).join("");
  }

  function syncGroupFields() {
    document.getElementById("cell-regular-specialist-field").hidden = editingGroup;
    document.getElementById("cell-regular-child-field").hidden = editingGroup;
    document.getElementById("cell-group-fields").hidden = !editingGroup;
    document.getElementById("cell-subscription-field").hidden = editingGroup;
    document.getElementById("cell-group-toggle").checked = editingGroup;
  }

  async function loadCellSubscriptions() {
    const select = document.getElementById("cell-subscription-select");
    const hint = document.getElementById("cell-subscription-hint");
    const currentEntry = board.cells[editingKey] || null;
    const linkedIds = new Set(entrySubscriptionIds(currentEntry));
    const childNames = (editingGroup ? groupChildren : [{ childName: selectedChildName }]).map((child) => normalizeChildName(child.childName)).filter(Boolean);
    if (!childNames.length) { select.innerHTML = '<option value="">Без прив\'язки</option>'; hint.textContent = "Оберіть дитину, щоб побачити доступні абонементи."; return; }
    const result = await window.sbClient.from("subscriptions").select("id, direction, starts_on, ends_on, base_ends_on, freeze_days, sessions_used, sessions_total, burned_sessions, closed_reason, is_group, is_frozen, subscription_children(child_name), subscription_specialists(specialist_id)").lte("starts_on", toISODate(currentDate));
    if (result.error) return;
    cellSubscriptions = (result.data || []).filter((subscription) => {
      const names = (subscription.subscription_children || []).map((child) => normalizeChildName(child.child_name));
      const linked = linkedIds.has(subscription.id);
      const available = subscription.ends_on >= toISODate(currentDate) && remainingSessions(subscription) > 0 && !subscription.closed_reason;
      return childNames.some((name) => names.includes(name)) && (linked || available) && (editingGroup ? subscription.direction === "Групове" : subscription.direction !== "Групове");
    });
    if (editingGroup) { renderGroupChildren(); return; }
    select.innerHTML = '<option value="">Без прив\'язки</option>' + cellSubscriptions.map((subscription) => '<option value="' + subscription.id + '"' + (linkedIds.has(subscription.id) ? " selected" : "") + '>' + escapeHtml(subscription.direction) + " · залишилось " + remainingSessions(subscription) + " з " + subscription.sessions_total + " · до " + escapeHtml(subscription.ends_on) + (linkedIds.has(subscription.id) && subscription.closed_reason ? " · поточна прив'язка" : "") + (subscription.is_frozen ? " · заморожений" : "") + "</option>").join("");
    hint.textContent = cellSubscriptions.length ? "Лічильник показує доступні заняття на обрану дату." : "Активного абонемента для цієї дитини на цю дату не знайдено.";
    updateFreezeButtonUI();
  }

  function updateFreezeButtonUI() {
    const button = document.getElementById("cell-freeze-btn");
    const subscription = cellSubscriptions.find((item) => item.id === document.getElementById("cell-subscription-select").value);
    if (!subscription) { button.hidden = true; return; }
    button.hidden = false;
    button.textContent = subscription.is_frozen ? "Розморозити абонемент" : "Заморозити абонемент";
    button.classList.toggle("schedule-freeze-btn--active", !!subscription.is_frozen);
  }

  async function toggleSubscriptionFreeze(id) {
    id = id || document.getElementById("cell-subscription-select").value;
    const subscription = cellSubscriptions.find((item) => item.id === id);
    if (!subscription) return;
    if (subscription.is_frozen) {
      const result = await window.sbClient.from("subscriptions").update({ is_frozen: false, frozen_until: null }).eq("id", id);
      if (result.error) window.alert(result.error.message); else { subscription.is_frozen = false; updateFreezeButtonUI(); renderGroupChildren(); }
      return;
    }
    const answer = window.prompt("На скільки днів заморозити? Від 7 до 21.", "14");
    if (answer === null) return;
    const days = Math.min(21, Math.max(7, Number(answer) || 14));
    const attendance = await window.sbClient.from("subscription_attendance").select("status, transferred_to_date").eq("subscription_id", id);
    if (attendance.error) { window.alert(attendance.error.message); return; }
    const freezeDays = Number(subscription.freeze_days || 0) + days;
    const end = effectiveSubscriptionEnd({ ...subscription, freeze_days: freezeDays }, attendance.data || []);
    const frozenUntil = new Date(); frozenUntil.setDate(frozenUntil.getDate() + days);
    const result = await window.sbClient.from("subscriptions").update({ is_frozen: true, frozen_until: toISODate(frozenUntil), freeze_days: freezeDays, ends_on: end }).eq("id", id);
    if (result.error) window.alert(result.error.message); else { subscription.is_frozen = true; subscription.freeze_days = freezeDays; subscription.ends_on = end; updateFreezeButtonUI(); renderGroupChildren(); }
  }

  function updateNoShowToggleUI() {
    const btn = document.getElementById("cell-noshow-toggle");
    btn.setAttribute("aria-pressed", String(editingNoShow));
    btn.classList.toggle("schedule-noshow-btn--active", editingNoShow);
    btn.textContent = editingNoShow ? "✕ Дитина не прийшла" : "Позначити «Не прийшов»";
  }

  async function openCellModal(room, hour) {
    const dateIso = toISODate(currentDate);
    editingKey = cellKey(room.id, dateIso, hour);
    editingRoomId = room.id;
    editingHour = hour;

    const entry = board.cells[editingKey] || null;
    await restoreSubscriptionLinks(entry);
    editingGroup = !!(entry && entry.isGroup);
    selectedAnketaId = entry ? entry.anketaId : null;
    selectedChildName = entry ? (entry.childName || "") : "";
    editingNoShow = entry ? !!entry.noShow : false;
    editingTransferred = entry ? entry.attendanceStatus === "transferred" : false;
    editingTransferDate = entry ? (entry.transferDate || "") : "";
    editingTransferHour = entry ? (entry.transferHour || "") : "";
    groupChildren = entryChildren(entry).map((c) => ({ anketaId: c.anketaId, childName: c.childName, status: c.status || (entry.noShow ? "no_show" : "attended"), subscriptionId: c.subscriptionId || null, transferDate: c.transferDate || "", transferHour: c.transferHour || "" }));
    if (!groupChildren.length) groupChildren = [{ anketaId: null, childName: "" }, { anketaId: null, childName: "" }];

    document.getElementById("cell-modal-title").textContent = room.name + " · " + hourLabel(hour);
    document.getElementById("cell-modal-meta").textContent = formatDayLabel(currentDate);
    populateCellSpecialistSelect(entry ? entry.specialistId : null);
    renderGroupSpecialists(entrySpecialistIds(entry));
    renderGroupChildren();
    syncGroupFields();
    document.getElementById("cell-child-input").value = selectedChildName;
    hideChildResults();
    document.getElementById("cell-clear-btn").hidden = !entry;
    // Marking a no-show, or looking up attendance, only makes sense for a
    // slot that already has someone booked — a brand-new, empty slot has
    // nobody to not show up, and no history to look up yet either.
    document.getElementById("cell-noshow-toggle").hidden = !entry;
    document.getElementById("cell-attendance-btn").hidden = !entry;
    document.getElementById("cell-transfer-btn").hidden = !entry;
    updateNoShowToggleUI();
    document.getElementById("cell-transfer-btn").classList.toggle("schedule-transfer-btn--active", editingTransferred);
    document.getElementById("cell-transfer-btn").setAttribute("aria-pressed", String(editingTransferred));
    document.getElementById("cell-transfer-date").value = editingTransferDate || dateIso;
    document.getElementById("cell-transfer-hour").innerHTML = hourOptions(editingTransferHour || hour);
    document.getElementById("cell-transfer-fields").hidden = !editingTransferred;
    await loadCellSubscriptions();

    document.getElementById("cell-modal-overlay").hidden = false;
    document.getElementById("cell-child-input").focus();
  }

  function closeCellModal() {
    document.getElementById("cell-modal-overlay").hidden = true;
    editingKey = null;
    editingRoomId = null;
    editingHour = null;
    selectedAnketaId = null;
    selectedChildName = "";
    editingNoShow = false;
    editingTransferred = false;
    editingTransferDate = "";
    editingTransferHour = "";
    cellSubscriptions = [];
    editingGroup = false;
    groupChildren = [];
    hideChildResults();
  }

  async function saveSubscriptionAttendance(entry, scheduleKey, sessionDate) {
    if (!entry) return;
    const status = entry.attendanceStatus || (entry.noShow ? "no_show" : "attended");
    const dateIso = sessionDate || toISODate(currentDate);
    const rows = entryChildren(entry).filter((child) => child.childName && (child.subscriptionId || entry.subscriptionId)).map((child) => ({
      subscription_id: child.subscriptionId || entry.subscriptionId,
      child_name: child.childName,
      schedule_cell_key: scheduleKey || editingKey,
      session_date: dateIso,
      status: entry.isGroup ? (child.status || "attended") : status,
      transferred_to_date: entry.isGroup ? (child.transferDate || null) : (entry.transferDate || null),
      transferred_to_hour: entry.isGroup ? (child.transferHour || null) : (entry.transferHour || null),
      created_by: currentProfileId,
      updated_at: new Date().toISOString(),
    }));
    if (!rows.length) return;
    const result = await window.sbClient.from("subscription_attendance").upsert(rows, { onConflict: "subscription_id,child_name,schedule_cell_key" });
    if (result.error) { setStatus("Статус не збережено: " + result.error.message, true); return; }
    const subscriptionIds = [...new Set(rows.map((row) => row.subscription_id))];
    await Promise.all(subscriptionIds.map(updateSubscriptionLifecycle));
  }

  function buildTransferBookings(entry) {
    const transferredChildren = entry.isGroup
      ? entryChildren(entry).filter((child) => child.status === "transferred")
      : (entry.attendanceStatus === "transferred" ? entryChildren(entry) : []);
    if (!transferredChildren.length) return [];
    const groups = {};
    transferredChildren.forEach((child) => {
      const date = entry.isGroup ? child.transferDate : entry.transferDate;
      const hour = entry.isGroup ? child.transferHour : entry.transferHour;
      if (!date || !Number.isInteger(Number(hour))) return;
      const key = date + "|" + Number(hour);
      if (!groups[key]) groups[key] = { date, hour: Number(hour), children: [] };
      groups[key].children.push({ ...child, status: "attended", transferDate: "", transferHour: null });
    });
    const bookings = Object.values(groups).map((group) => {
      const key = cellKey(editingRoomId, group.date, group.hour);
      if (key === editingKey) return { error: "Оберіть для переносу іншу дату або час." };
      if (board.cells[key]) return { error: "На " + group.date + " о " + pad2(group.hour) + ":00 у цьому залі вже є запис." };
      const isGroup = entry.isGroup && group.children.length > 1;
      const firstChild = group.children[0];
      const targetEntry = {
        isGroup,
        specialistId: entry.specialistId,
        specialistIds: entrySpecialistIds(entry),
        anketaId: firstChild.anketaId,
        childName: firstChild.childName,
        children: group.children,
        subscriptionId: isGroup ? null : (firstChild.subscriptionId || entry.subscriptionId || null),
        attendanceStatus: "attended",
        transferDate: "",
        transferHour: null,
        noShow: false,
      };
      const conflicts = findConcurrentConflicts(targetEntry, group.date, group.hour, [editingKey]);
      if (conflicts.specialists.length || conflicts.children.length) return { error: conflictMessage(conflicts, group.date, group.hour) };
      return {
        key,
        entry: targetEntry,
      };
    });
    const failure = bookings.find((booking) => booking.error);
    if (failure) { window.alert(failure.error); return null; }
    return bookings;
  }

  function saveCellFromModal() {
    if (!editingKey) return;
    const previousEntry = board.cells[editingKey] || null;
    const specialistId = document.getElementById("cell-specialist-select").value || null;
    if (editingGroup) {
      const specialistIds = Array.from(document.querySelectorAll("#cell-group-specialists input:checked")).map((input) => input.value);
      if (specialistIds.length < 1 || groupChildren.length < 2 || groupChildren.some((c) => !c.anketaId)) {
        window.alert("Для групового заняття оберіть щонайменше одного спеціаліста та двох дітей зі списку.");
        return;
      }
      const savedChildren = groupChildren.map((child) => ({ ...child, status: editingTransferred ? "transferred" : (editingNoShow ? "no_show" : (child.status || "attended")), transferDate: editingTransferred ? document.getElementById("cell-transfer-date").value : child.transferDate, transferHour: editingTransferred ? Number(document.getElementById("cell-transfer-hour").value) : child.transferHour }));
      if (savedChildren.some((child) => child.status === "transferred" && (!child.transferDate || !child.transferHour))) { window.alert("Для переносу оберіть нову дату та час."); return; }
      board.cells[editingKey] = { isGroup: true, specialistId: specialistIds[0], specialistIds, anketaId: savedChildren[0].anketaId, childName: savedChildren[0].childName, children: savedChildren, subscriptionId: null, attendanceStatus: editingTransferred ? "transferred" : (editingNoShow ? "no_show" : "attended"), noShow: editingNoShow };
    } else if (!specialistId || !selectedAnketaId) {
      window.alert("Оберіть спеціаліста і дитину зі списку (дитину — саме зі списку підказок, не просто текстом).");
      return;
    } else {
      editingTransferDate = document.getElementById("cell-transfer-date").value;
      editingTransferHour = Number(document.getElementById("cell-transfer-hour").value);
      if (editingTransferred && (!editingTransferDate || !editingTransferHour)) { window.alert("Для переносу оберіть нову дату та час."); return; }
      const previousChild = entryChildren(previousEntry)[0];
      const preservedSubscriptionId = previousChild && previousChild.anketaId === selectedAnketaId ? (previousChild.subscriptionId || previousEntry.subscriptionId || null) : null;
      const subscriptionId = document.getElementById("cell-subscription-select").value || preservedSubscriptionId;
      board.cells[editingKey] = { specialistId, specialistIds: [specialistId], anketaId: selectedAnketaId, childName: selectedChildName, children: [{ anketaId: selectedAnketaId, childName: selectedChildName, subscriptionId, transferDate: editingTransferred ? editingTransferDate : "", transferHour: editingTransferred ? editingTransferHour : null }], isGroup: false, subscriptionId, attendanceStatus: editingTransferred ? "transferred" : (editingNoShow ? "no_show" : "attended"), transferDate: editingTransferred ? editingTransferDate : "", transferHour: editingTransferred ? editingTransferHour : null, noShow: editingNoShow };
    }
    const savedEntry = board.cells[editingKey];
    const conflicts = findConcurrentConflicts(savedEntry, toISODate(currentDate), editingHour, [editingKey]);
    if (conflicts.specialists.length || conflicts.children.length) {
      if (previousEntry) board.cells[editingKey] = previousEntry;
      else delete board.cells[editingKey];
      window.alert(conflictMessage(conflicts, toISODate(currentDate), editingHour));
      return;
    }
    const transferBookings = buildTransferBookings(savedEntry);
    if (transferBookings === null) return;
    transferBookings.forEach((booking) => { board.cells[booking.key] = booking.entry; });
    render();
    flushSave();
    saveSubscriptionAttendance(savedEntry);
    closeCellModal();
  }

  function clearCellFromModal() {
    if (!editingKey) return;
    delete board.cells[editingKey];
    render();
    flushSave();
    closeCellModal();
  }

  // ---------- Copy a completed day ----------
  function yesterdayISO() {
    const yesterday = new Date();
    yesterday.setHours(0, 0, 0, 0);
    yesterday.setDate(yesterday.getDate() - 1);
    return toISODate(yesterday);
  }

  function populateCopySpecialistSelect() {
    const select = document.getElementById("copy-schedule-specialist");
    select.innerHTML = '<option value="">Усі спеціалісти</option>' + board.specialists.map((s) =>
      '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.name || "Без імені") + "</option>"
    ).join("");
  }

  function countCopyableEntries(sourceDate, specialistId) {
    return Object.keys(board.cells).filter((key) => {
      const parts = key.split("|");
      if (parts.length !== 3 || parts[1] !== sourceDate || !board.cells[key]) return false;
      return !specialistId || board.cells[key].specialistId === specialistId;
    }).length;
  }

  function updateCopyScheduleSummary() {
    const sourceDate = document.getElementById("copy-schedule-source-date").value;
    const specialistId = document.getElementById("copy-schedule-specialist").value;
    const count = sourceDate ? countCopyableEntries(sourceDate, specialistId) : 0;
    document.getElementById("copy-schedule-summary").textContent = sourceDate
      ? (count ? "Буде скопійовано записів: " + count + "." : "За цей день немає записів для копіювання.")
      : "Оберіть день і спеціаліста.";
  }

  function openCopyScheduleModal() {
    const sourceInput = document.getElementById("copy-schedule-source-date");
    const yesterday = yesterdayISO();
    sourceInput.max = yesterday;
    const suggested = toISODate(currentDate) === yesterday ? toISODate(addDays(parseISODate(yesterday), -1)) : yesterday;
    sourceInput.value = suggested;
    document.getElementById("copy-schedule-target-label").textContent = formatDayLabel(currentDate);
    populateCopySpecialistSelect();
    updateCopyScheduleSummary();
    document.getElementById("copy-schedule-modal-overlay").hidden = false;
    sourceInput.focus();
  }

  function closeCopyScheduleModal() {
    document.getElementById("copy-schedule-modal-overlay").hidden = true;
  }

  function copyScheduleFromPastDay() {
    const sourceDate = document.getElementById("copy-schedule-source-date").value;
    const specialistId = document.getElementById("copy-schedule-specialist").value;
    const targetDate = toISODate(currentDate);
    if (!sourceDate || sourceDate >= toISODate(new Date()) || sourceDate === targetDate) {
      window.alert("Оберіть інший день у минулому.");
      return;
    }

    const sourceEntries = Object.keys(board.cells).filter((key) => {
      const parts = key.split("|");
      const entry = board.cells[key];
      return parts.length === 3 && parts[1] === sourceDate && entry && (!specialistId || entrySpecialistIds(entry).includes(specialistId));
    });
    if (!sourceEntries.length) {
      window.alert("За обраний день немає записів для копіювання.");
      return;
    }

    const scopeLabel = specialistId ? specialistName(specialistId) : "усіх спеціалістів";
    const overwritten = sourceEntries.filter((key) => {
      const parts = key.split("|");
      return !!board.cells[cellKey(parts[0], targetDate, Number(parts[2]))];
    }).length;
    const overwriteNote = overwritten ? " Існуючих записів буде замінено: " + overwritten + "." : "";
    if (!window.confirm("Скопіювати розклад " + scopeLabel + " з " + formatDayLabel(parseISODate(sourceDate)) + " на " + formatDayLabel(currentDate) + "?" + overwriteNote)) return;

    sourceEntries.forEach((key) => {
      const parts = key.split("|");
      const targetKey = cellKey(parts[0], targetDate, Number(parts[2]));
      const entry = board.cells[key];
      board.cells[targetKey] = {
        specialistId: entry.specialistId || (entrySpecialistIds(entry)[0] || null),
        specialistIds: entrySpecialistIds(entry),
        anketaId: entry.anketaId || null,
        childName: entry.childName || "",
        children: entryChildren(entry),
        isGroup: !!entry.isGroup,
        subscriptionId: entry.subscriptionId || null,
        attendanceStatus: "attended",
        noShow: false,
      };
    });
    render();
    closeCopyScheduleModal();
    flushSave();
  }

  // ---------- Attendance (same computation as admin/anketa.html's, just
  // reading board.cells straight from memory instead of re-fetching —
  // this page already has the whole board loaded). ----------
  function closeAttendanceModal() {
    document.getElementById("attendance-modal-overlay").hidden = true;
  }

  function openAttendanceModal(anketaId, childName) {
    // Matched by (normalized) child name, not anketaId — see
    // normalizeChildName above. anketaId is still accepted/ignored so
    // existing call sites don't need to change what they pass.
    const key = normalizeChildName(childName);
    if (!key) return;
    const overlay = document.getElementById("attendance-modal-overlay");
    const countEl = document.getElementById("attendance-modal-count");
    const bodyEl = document.getElementById("attendance-modal-body");
    document.getElementById("attendance-modal-title").textContent = "Відвідування" + (childName ? " — " + childName : "");
    overlay.hidden = false;

    const today = toISODate(new Date());
    // Per date, not per slot: a date only counts as a no-show if every
    // slot that day was marked as one — if the child had two bookings the
    // same day and showed up for at least one, the day still counts as a
    // visit. Today and future dates don't count yet either way — a
    // schedule entry is a plan, not confirmed attendance.
    const dateStatus = {};
    Object.keys(board.cells).forEach((cellKey) => {
      const parts = cellKey.split("|");
      if (parts.length !== 3) return;
      const dateIso = parts[1];
      const entry = board.cells[cellKey];
      if (!entry || dateIso >= today) return;
      const hasChild = entryChildren(entry).some((child) => normalizeChildName(child.childName) === key);
      if (!hasChild) return;
      if (entry.noShow) {
        if (dateStatus[dateIso] !== "attended") dateStatus[dateIso] = "noshow";
      } else {
        dateStatus[dateIso] = "attended";
      }
    });

    const formatDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("uk-UA", { day: "2-digit", month: "long", year: "numeric" });
    const listHtml = (dates) => "<ul style=\"list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.4rem;\">" +
      dates.map((iso) => "<li>" + formatDate(iso) + "</li>").join("") + "</ul>";

    const attended = Object.keys(dateStatus).filter((d) => dateStatus[d] === "attended").sort().reverse();
    const noShow = Object.keys(dateStatus).filter((d) => dateStatus[d] === "noshow").sort().reverse();

    countEl.textContent = "Відвідувань: " + attended.length + (noShow.length ? " · Не з'явився: " + noShow.length : "");
    let html = attended.length
      ? listHtml(attended)
      : "<p class=\"anketa-modal__hint\" style=\"margin:0;\">Ще немає жодного завершеного заняття за розкладом.</p>";
    if (noShow.length) {
      html += "<h3 style=\"margin:1.2rem 0 .4rem;font-size:.9rem;color:var(--color-destructive);\">Не з'явився</h3>" + listHtml(noShow);
    }
    bodyEl.innerHTML = html;
  }

  function wireEvents() {
    const table = document.getElementById("schedule-table");

    document.getElementById("toggle-management-btn").addEventListener("click", () => {
      const btn = document.getElementById("toggle-management-btn");
      const panel = document.getElementById("management-panel");
      const expanded = btn.getAttribute("aria-expanded") === "true";
      panel.hidden = expanded;
      btn.setAttribute("aria-expanded", String(!expanded));
    });

    document.getElementById("prev-day-btn").addEventListener("click", () => goToDay(addDays(currentDate, -1)));
    document.getElementById("next-day-btn").addEventListener("click", () => goToDay(addDays(currentDate, 1)));
    document.getElementById("today-btn").addEventListener("click", () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      goToDay(today);
    });

    document.getElementById("open-calendar-btn").addEventListener("click", () => {
      const input = document.getElementById("calendar-date-input");
      try { input.showPicker(); } catch (e) { input.focus(); input.click(); }
    });
    document.getElementById("calendar-date-input").addEventListener("change", (e) => {
      if (!e.target.value) return;
      goToDay(parseISODate(e.target.value));
    });

    const copyOverlay = document.getElementById("copy-schedule-modal-overlay");
    document.getElementById("copy-schedule-btn").addEventListener("click", openCopyScheduleModal);
    document.getElementById("copy-schedule-modal-close").addEventListener("click", closeCopyScheduleModal);
    document.getElementById("copy-schedule-cancel-btn").addEventListener("click", closeCopyScheduleModal);
    document.getElementById("copy-schedule-confirm-btn").addEventListener("click", copyScheduleFromPastDay);
    document.getElementById("copy-schedule-source-date").addEventListener("change", updateCopyScheduleSummary);
    document.getElementById("copy-schedule-specialist").addEventListener("change", updateCopyScheduleSummary);
    copyOverlay.addEventListener("click", (e) => { if (e.target === copyOverlay) closeCopyScheduleModal(); });

    table.addEventListener("click", (e) => {
      if (!canEdit) return; // instructors: view the grid, nothing opens on click
      const btn = e.target.closest("[data-cell]");
      if (!btn) return;
      const room = board.rooms.find((r) => r.id === btn.getAttribute("data-room"));
      if (!room) return;
      openCellModal(room, Number(btn.getAttribute("data-hour")));
    });

    document.getElementById("add-room-btn").addEventListener("click", addRoom);
    document.getElementById("remove-room-btn").addEventListener("click", () => removeRoom(managedRoomId));

    document.getElementById("room-select").addEventListener("change", (e) => {
      managedRoomId = e.target.value;
      updateRoomNameField();
    });

    const roomNameInput = document.getElementById("room-name-input");
    roomNameInput.addEventListener("input", (e) => {
      const room = getManagedRoom();
      if (!room) return;
      room.name = e.target.value;
      document.querySelectorAll('#room-select option[value="' + room.id + '"]').forEach((opt) => { opt.textContent = room.name; });
      // Room names live only in <th> text (several rooms can share a
      // color, so there's no unique selector to patch in place) — a
      // thead-only re-render is cheap and keeps focus in the input.
      renderThead();
      scheduleSave();
    });
    roomNameInput.addEventListener("focusout", flushSave);

    document.getElementById("add-specialist-btn").addEventListener("click", addSpecialist);
    document.getElementById("remove-specialist-btn").addEventListener("click", () => removeSpecialist(managedSpecialistId));

    document.getElementById("specialist-select").addEventListener("change", (e) => {
      managedSpecialistId = e.target.value;
      updateSpecialistNameField();
    });

    const specialistNameInput = document.getElementById("specialist-name-input");
    specialistNameInput.addEventListener("input", (e) => {
      const spec = getManagedSpecialist();
      if (!spec) return;
      spec.name = e.target.value;
      const label = spec.name || "Без імені";
      document.querySelectorAll('#specialist-select option[value="' + spec.id + '"]').forEach((opt) => { opt.textContent = label; });
      // Slot buttons show the specialist's name in already-rendered cells
      // — cheapest correct way to keep those in sync while typing is a
      // full render() rather than hunting down every matching cell.
      render();
      scheduleSave();
    });
    specialistNameInput.addEventListener("focusout", flushSave);

    // ---------- Cell modal ----------
    const cellOverlay = document.getElementById("cell-modal-overlay");
    document.getElementById("cell-modal-close").addEventListener("click", closeCellModal);
    cellOverlay.addEventListener("click", (e) => { if (e.target === cellOverlay) closeCellModal(); });
    document.getElementById("cell-save-btn").addEventListener("click", saveCellFromModal);
    document.getElementById("cell-clear-btn").addEventListener("click", clearCellFromModal);
    document.getElementById("cell-child-input").addEventListener("input", onChildInput);
    document.getElementById("cell-child-results").addEventListener("click", onChildResultsClick);
    document.getElementById("cell-group-toggle").addEventListener("change", (e) => { editingGroup = e.target.checked; syncGroupFields(); });
    document.getElementById("cell-add-child-btn").addEventListener("click", () => { groupChildren.push({ anketaId: null, childName: "", status: "attended", subscriptionId: null, transferDate: "", transferHour: null }); renderGroupChildren(); document.querySelector('[data-group-child-index="' + (groupChildren.length - 1) + '"]').focus(); });
    document.getElementById("cell-group-children").addEventListener("input", (e) => {
      const indexAttr = e.target.getAttribute("data-group-child-index");
      if (indexAttr === null) return;
      const index = Number(indexAttr);
      if (!Number.isInteger(index)) return;
      groupChildren[index] = { anketaId: null, childName: "", status: "attended", subscriptionId: null, transferDate: "", transferHour: null };
      const query = e.target.value.trim();
      if (query.length < CHILD_SEARCH_MIN_LEN) { e.target.nextElementSibling.hidden = true; return; }
      const token = ++childSearchToken;
      clearTimeout(childSearchTimer);
      childSearchTimer = setTimeout(async () => {
        const results = await searchAnketas(query);
        if (token !== childSearchToken) return;
        const resultsEl = e.target.nextElementSibling;
        resultsEl.innerHTML = results.length ? results.map((r) => '<button type="button" class="schedule-child-results__item" data-group-result-index="' + index + '" data-anketa-id="' + r.id + '" data-child-name="' + escapeHtml(r.child_full_name || "") + '">' + escapeHtml(r.child_full_name || "(без імені)") + '</button>').join("") : '<div class="schedule-child-results__empty">Нікого не знайдено.</div>';
        resultsEl.hidden = false;
      }, CHILD_SEARCH_DEBOUNCE_MS);
    });
    document.getElementById("cell-group-children").addEventListener("click", (e) => {
      const remove = e.target.closest("[data-remove-child-index]");
      if (remove) { groupChildren.splice(Number(remove.dataset.removeChildIndex), 1); renderGroupChildren(); return; }
      const result = e.target.closest("[data-group-result-index]");
      if (!result) return;
      const index = Number(result.dataset.groupResultIndex);
      groupChildren[index] = { anketaId: result.dataset.anketaId, childName: result.dataset.childName || "", status: "attended", subscriptionId: null, transferDate: "", transferHour: null };
      renderGroupChildren();
      loadCellSubscriptions();
    });
    document.getElementById("cell-group-children").addEventListener("click", (e) => {
      const statusButton = e.target.closest("[data-group-status-index]");
      if (!statusButton) return;
      const index = Number(statusButton.dataset.groupStatusIndex);
      if (!Number.isInteger(index) || !groupChildren[index]) return;
      groupChildren[index].status = statusButton.dataset.groupStatus;
      if (groupChildren[index].status === "transferred" && !groupChildren[index].transferDate) { groupChildren[index].transferDate = toISODate(currentDate); groupChildren[index].transferHour = editingHour; }
      renderGroupChildren();
    });
    document.getElementById("cell-group-children").addEventListener("change", (e) => {
      const subscriptionIndex = e.target.getAttribute("data-group-subscription-index");
      const dateIndex = e.target.getAttribute("data-group-transfer-date-index");
      const hourIndex = e.target.getAttribute("data-group-transfer-hour-index");
      if (subscriptionIndex !== null && groupChildren[Number(subscriptionIndex)]) { groupChildren[Number(subscriptionIndex)].subscriptionId = e.target.value || null; renderGroupChildren(); }
      if (dateIndex !== null && groupChildren[Number(dateIndex)]) groupChildren[Number(dateIndex)].transferDate = e.target.value;
      if (hourIndex !== null && groupChildren[Number(hourIndex)]) groupChildren[Number(hourIndex)].transferHour = Number(e.target.value);
    });
    document.getElementById("cell-group-children").addEventListener("click", (e) => {
      const freezeButton = e.target.closest("[data-group-freeze-index]");
      if (!freezeButton) return;
      const child = groupChildren[Number(freezeButton.dataset.groupFreezeIndex)];
      if (child && child.subscriptionId) toggleSubscriptionFreeze(child.subscriptionId);
    });
    document.getElementById("cell-noshow-toggle").addEventListener("click", () => {
      editingNoShow = !editingNoShow;
      if (editingNoShow) { editingTransferred = false; document.getElementById("cell-transfer-btn").classList.remove("schedule-transfer-btn--active"); document.getElementById("cell-transfer-btn").setAttribute("aria-pressed", "false"); document.getElementById("cell-transfer-fields").hidden = true; }
      updateNoShowToggleUI();
    });
    document.getElementById("cell-transfer-btn").addEventListener("click", () => {
      editingTransferred = !editingTransferred;
      if (editingTransferred) { editingNoShow = false; updateNoShowToggleUI(); }
      if (editingTransferred && !document.getElementById("cell-transfer-date").value) document.getElementById("cell-transfer-date").value = toISODate(currentDate);
      document.getElementById("cell-transfer-btn").classList.toggle("schedule-transfer-btn--active", editingTransferred);
      document.getElementById("cell-transfer-btn").setAttribute("aria-pressed", String(editingTransferred));
      document.getElementById("cell-transfer-fields").hidden = !editingTransferred;
    });
    document.getElementById("cell-subscription-select").addEventListener("change", updateFreezeButtonUI);
    document.getElementById("cell-freeze-btn").addEventListener("click", toggleSubscriptionFreeze);

    // ---------- Attendance modal (opened from inside the cell modal) ----------
    const attendanceOverlay = document.getElementById("attendance-modal-overlay");
    document.getElementById("cell-attendance-btn").addEventListener("click", () => {
      openAttendanceModal(selectedAnketaId, selectedChildName);
    });
    document.getElementById("attendance-modal-close").addEventListener("click", closeAttendanceModal);
    attendanceOverlay.addEventListener("click", (e) => { if (e.target === attendanceOverlay) closeAttendanceModal(); });

    // Shared Escape handler for both modals — the attendance modal opens
    // on top of the cell modal, so Escape should close whichever is
    // actually on top first instead of both reacting to the same keypress.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!copyOverlay.hidden) { closeCopyScheduleModal(); return; }
      if (!attendanceOverlay.hidden) { closeAttendanceModal(); return; }
      if (!cellOverlay.hidden) closeCellModal();
    });
  }

  window.ScheduleBoard = {
    async init(profileId, canEditFlag) {
      currentProfileId = profileId;
      canEdit = canEditFlag !== false;
      document.getElementById("schedule-table").classList.toggle("schedule-table--readonly", !canEdit);
      // Instructors never see the management panel at all — there's
      // nothing in it they're allowed to touch, so the toggle button
      // itself would just be dead weight.
      if (!canEdit) {
        document.getElementById("toggle-management-btn").hidden = true;
        document.getElementById("copy-schedule-btn").hidden = true;
      }
      wireEvents();
      updateDayControls();
      board = await loadBoard();
      managedRoomId = board.rooms.length ? board.rooms[0].id : null;
      managedSpecialistId = board.specialists.length ? board.specialists[0].id : null;
      populateRoomSelect();
      updateRoomNameField();
      populateSpecialistSelect();
      updateSpecialistNameField();
      render();
      if (canEdit) {
        if (document.getElementById("save-status").dataset.state !== "error") setStatus("idle");
      } else {
        // Nothing ever gets saved in read-only mode - no point implying
        // otherwise with a lingering "idle"/blank save-status slot.
        document.getElementById("save-status").hidden = true;
      }
    },
  };
})();
