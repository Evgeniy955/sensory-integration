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
//     *and* hour), value { specialistId, anketaId, childName }. Only one
//     day is shown at a time; `currentDate` (module state, not saved)
//     tracks which one, moved by the ◀ / ▶ buttons or the calendar
//     picker.
//
// A slot's child is picked from the existing anketas (parent
// questionnaires) table via search-as-you-type — never free text — so a
// schedule entry always points at a real anketa row (anketaId), which is
// what lets the anketa page compute "visited on these dates" later by
// scanning this same board.

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
          anketaId: value.anketaId ? String(value.anketaId) : null,
          childName: value.childName ? String(value.childName) : "",
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
    const inner = entry
      ? '<span class="schedule-slot-specialist">' + escapeHtml(specialistName(entry.specialistId)) + "</span>" +
        '<span class="schedule-slot-child">' + escapeHtml(entry.childName || "") + "</span>"
      : '<span class="schedule-slot-add" aria-hidden="true">+</span>';
    const ariaLabel = room.name + ", " + label +
      (entry ? ": " + specialistName(entry.specialistId) + ", " + (entry.childName || "") : ": вільно");
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
    Object.values(board.cells).forEach((entry) => { if (entry.specialistId === id) entry.specialistId = null; });
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
  }

  // ---------- Cell (slot) modal ----------
  function populateCellSpecialistSelect(currentId) {
    const select = document.getElementById("cell-specialist-select");
    select.innerHTML = '<option value="">— оберіть спеціаліста —</option>' + board.specialists.map((s) =>
      '<option value="' + s.id + '"' + (s.id === currentId ? " selected" : "") + ">" + escapeHtml(s.name || "Без імені") + "</option>"
    ).join("");
  }

  function openCellModal(room, hour) {
    const dateIso = toISODate(currentDate);
    editingKey = cellKey(room.id, dateIso, hour);
    editingRoomId = room.id;
    editingHour = hour;

    const entry = board.cells[editingKey] || null;
    selectedAnketaId = entry ? entry.anketaId : null;
    selectedChildName = entry ? (entry.childName || "") : "";

    document.getElementById("cell-modal-title").textContent = room.name + " · " + hourLabel(hour);
    document.getElementById("cell-modal-meta").textContent = formatDayLabel(currentDate);
    populateCellSpecialistSelect(entry ? entry.specialistId : null);
    document.getElementById("cell-child-input").value = selectedChildName;
    hideChildResults();
    document.getElementById("cell-clear-btn").hidden = !entry;

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
    hideChildResults();
  }

  function saveCellFromModal() {
    if (!editingKey) return;
    const specialistId = document.getElementById("cell-specialist-select").value || null;
    if (!specialistId || !selectedAnketaId) {
      window.alert("Оберіть спеціаліста і дитину зі списку (дитину — саме зі списку підказок, не просто текстом).");
      return;
    }
    board.cells[editingKey] = { specialistId, anketaId: selectedAnketaId, childName: selectedChildName };
    render();
    flushSave();
    closeCellModal();
  }

  function clearCellFromModal() {
    if (!editingKey) return;
    delete board.cells[editingKey];
    render();
    flushSave();
    closeCellModal();
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

    table.addEventListener("click", (e) => {
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
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !cellOverlay.hidden) closeCellModal();
    });
    document.getElementById("cell-save-btn").addEventListener("click", saveCellFromModal);
    document.getElementById("cell-clear-btn").addEventListener("click", clearCellFromModal);
    document.getElementById("cell-child-input").addEventListener("input", onChildInput);
    document.getElementById("cell-child-results").addEventListener("click", onChildResultsClick);
  }

  window.ScheduleBoard = {
    async init(profileId) {
      currentProfileId = profileId;
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
      if (document.getElementById("save-status").dataset.state !== "error") setStatus("idle");
    },
  };
})();
