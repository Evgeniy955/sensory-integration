// Schedule board (admin/schedule.html): specialists × week-of-dates grid,
// stored as a single JSONB row in public.schedule_boards (id='main').
// Loaded after supabase-config.js + admin-auth.js (needs window.sbClient).
//
// The whole board lives in one in-memory object (`board`) that's
// re-rendered top to bottom on every change and pushed to Supabase
// shortly after:
//   - board.specialists — the saved roster (managed from the toolbar,
//     add/rename/delete), independent of which rows currently exist.
//   - board.rows — the table's visible rows, each { id, specialistId }.
//     The first cell of a row is a dropdown over board.specialists, so
//     which saved specialist sits in a row can be changed at any time
//     without retyping a name or losing that row's room assignments.
//   - board.cells — room assignments keyed by "rowId|YYYY-MM-DD" (an
//     actual calendar date, not just a weekday name), so every week can
//     hold its own, different assignments. Only one week (Mon–Sat) is
//     shown at a time; `weekStart` (module state, not saved) tracks
//     which one, moved by the ◀ / ▶ buttons or the calendar picker.

(function () {
  // Mon..Sat labels for the currently displayed week — see getWeekDays().
  const DAY_LABELS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

  const MONTHS_GENITIVE = [
    "січня", "лютого", "березня", "квітня", "травня", "червня",
    "липня", "серпня", "вересня", "жовтня", "листопада", "грудня",
  ];

  // Cycled across rooms in creation order. Bold/saturated on purpose (see
  // the "Room tint" comment in schedule.css) rather than the public
  // site's pastel tokens — legibility across a crowded staff table
  // matters more here than the sensory-gentle palette the landing page
  // uses. Three hues before a 4th room repeats a color.
  const ROOM_COLORS = ["yellow", "red", "blue"];

  const BOARD_ROW_ID = "main";

  let board = null;
  let currentProfileId = null;
  let saveTimer = null;
  let managedRoomId = null; // room targeted by the toolbar's rename/delete controls
  let managedSpecialistId = null; // specialist targeted by the toolbar's rename/delete controls
  let weekStart = startOfWeek(new Date()); // Monday of the currently displayed week
  let currentWeekDays = []; // refreshed by render(); used outside render() for aria-label updates

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

  // Monday-based week start, midnight local time.
  function startOfWeek(d) {
    const day = d.getDay(); // 0 = Sun, 1 = Mon, ... 6 = Sat
    const diff = day === 0 ? -6 : 1 - day;
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
    monday.setHours(0, 0, 0, 0);
    return monday;
  }

  // Six {iso, label, dateLabel, isToday} entries — Monday through
  // Saturday of the given week start.
  function getWeekDays(weekStartDate) {
    const todayIso = toISODate(new Date());
    return DAY_LABELS.map((label, i) => {
      const date = addDays(weekStartDate, i);
      const iso = toISODate(date);
      return { iso, label, dateLabel: pad2(date.getDate()) + "." + pad2(date.getMonth() + 1), isToday: iso === todayIso };
    });
  }

  function formatWeekRange(weekStartDate) {
    const weekEnd = addDays(weekStartDate, 5); // Saturday
    const d1 = weekStartDate.getDate(), d2 = weekEnd.getDate();
    const m1 = weekStartDate.getMonth(), m2 = weekEnd.getMonth();
    const y1 = weekStartDate.getFullYear(), y2 = weekEnd.getFullYear();
    if (y1 !== y2) return d1 + " " + MONTHS_GENITIVE[m1] + " " + y1 + " – " + d2 + " " + MONTHS_GENITIVE[m2] + " " + y2;
    if (m1 !== m2) return d1 + " " + MONTHS_GENITIVE[m1] + " – " + d2 + " " + MONTHS_GENITIVE[m2] + " " + y1;
    return d1 + "–" + d2 + " " + MONTHS_GENITIVE[m1] + " " + y1;
  }

  function cellKey(rowId, dateIso) {
    return rowId + "|" + dateIso;
  }

  function defaultBoard() {
    return {
      rooms: [
        { id: uid(), name: "Зал 1", color: "yellow" },
        { id: uid(), name: "Зал 2", color: "red" },
        { id: uid(), name: "Зал 3", color: "blue" },
      ],
      specialists: [],
      rows: [],
      cells: {},
    };
  }

  // Boards saved before the calendar existed keyed cells as
  // "rowId|mon".."rowId|sat" (a recurring template, no real date). Those
  // get copied onto the matching weekday of the *current* real week —
  // one-time, best-effort — so existing assignments aren't silently
  // dropped; anything already date-keyed passes through unchanged.
  const LEGACY_DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat"];

  function migrateLegacyCells(rawCells) {
    const out = {};
    const thisWeek = getWeekDays(startOfWeek(new Date()));
    Object.keys(rawCells || {}).forEach((key) => {
      const idx = key.lastIndexOf("|");
      if (idx === -1) return;
      const rowId = key.slice(0, idx);
      const suffix = key.slice(idx + 1);
      const legacyIndex = LEGACY_DAY_KEYS.indexOf(suffix);
      if (legacyIndex !== -1) {
        out[cellKey(rowId, thisWeek[legacyIndex].iso)] = rawCells[key];
      } else {
        out[key] = rawCells[key];
      }
    });
    return out;
  }

  function normalizeBoard(raw) {
    const fallback = defaultBoard();
    if (!raw || typeof raw !== "object") return fallback;

    // Color is always re-derived from a room's position (not whatever was
    // last saved): there's no manual color picker anywhere in the UI, so
    // the stored value is only ever a leftover from a previous palette
    // version. Deriving it fresh here is what actually guarantees every
    // existing board shows today's yellow/red/blue cycle after a palette
    // change, instead of silently keeping an old hex that happens to
    // share a name ("blue") with a color in the new set too.
    const rooms = Array.isArray(raw.rooms) && raw.rooms.length
      ? raw.rooms.filter((r) => r && r.id && r.name != null).map((r, i) => ({
          id: String(r.id), name: String(r.name), color: ROOM_COLORS[i % ROOM_COLORS.length],
        }))
      : fallback.rooms;

    const specialists = Array.isArray(raw.specialists)
      ? raw.specialists.filter((s) => s && s.id).map((s) => ({ id: String(s.id), name: String(s.name || "") }))
      : [];

    // Boards saved before `rows` existed had one row per specialist,
    // keyed the same way — reuse each specialist's id as its row id so
    // old board.cells entries keep resolving correctly.
    const rows = Array.isArray(raw.rows)
      ? raw.rows.filter((r) => r && r.id).map((r) => ({
          id: String(r.id), specialistId: r.specialistId ? String(r.specialistId) : null,
        }))
      : specialists.map((s) => ({ id: s.id, specialistId: s.id }));

    const cells = migrateLegacyCells((raw.cells && typeof raw.cells === "object") ? raw.cells : {});
    return { rooms, specialists, rows, cells };
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
  // fire a write per keystroke; discrete actions (add/remove a row,
  // picking a room or specialist in a dropdown) call saveBoard() directly
  // since those are already one-click, infrequent actions.
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
    const spec = board.specialists.find((s) => s.id === id);
    return spec ? (spec.name || "Без імені") : "спеціаліст";
  }

  function renderThead(days) {
    const thead = document.getElementById("schedule-thead");
    thead.innerHTML = "<tr>" +
      '<th class="schedule-col-specialist">Спеціаліст</th>' +
      days.map((day) => '<th class="schedule-day-th' + (day.isToday ? " schedule-day-th--today" : "") + '">' +
        '<div class="schedule-day-th__inner">' +
        '<span class="schedule-day-th__date">' + day.dateLabel + "</span>" +
        '<span class="schedule-day-th__weekday">' + day.label + "</span>" +
        "</div></th>").join("") +
      "</tr>";
  }

  function cellSelectHtml(row, day) {
    const key = cellKey(row.id, day.iso);
    const roomId = board.cells[key] || "";
    const room = board.rooms.find((r) => r.id === roomId) || null;
    const colorClass = room ? "schedule-cell--" + room.color : "";
    const options = '<option value="">—</option>' + board.rooms.map((r) =>
      '<option value="' + r.id + '"' + (r.id === roomId ? " selected" : "") + ">" + escapeHtml(r.name) + "</option>"
    ).join("");
    return '<td class="' + colorClass + '">' +
      '<select class="schedule-cell-select" data-cell="' + key + '" data-empty="' + (roomId ? "false" : "true") + '" aria-label="Зал: ' + escapeHtml(specialistName(row.specialistId)) + ", " + day.label + " " + day.dateLabel + '">' +
      options + "</select></td>";
  }

  // The row's own specialist dropdown — picks from the saved roster
  // (board.specialists), independent of which row this is.
  function rowSpecialistSelectHtml(row) {
    const options = '<option value="">— оберіть спеціаліста —</option>' + board.specialists.map((s) =>
      '<option value="' + s.id + '"' + (s.id === row.specialistId ? " selected" : "") + ">" + escapeHtml(s.name || "Без імені") + "</option>"
    ).join("");
    return '<select class="schedule-row-specialist-select" data-row-specialist="' + row.id + '" aria-label="Спеціаліст у цьому рядку">' + options + "</select>";
  }

  function rowHtml(row, days) {
    const cells = days.map((day) => cellSelectHtml(row, day)).join("");
    return '<tr data-row="' + row.id + '">' +
      '<td class="schedule-col-specialist"><div class="schedule-row-header">' +
      rowSpecialistSelectHtml(row) +
      '<button type="button" class="schedule-remove-btn" data-remove-row="' + row.id + '" title="Видалити рядок" aria-label="Видалити рядок">×</button>' +
      "</div></td>" + cells + "</tr>";
  }

  function renderTbody(days) {
    const tbody = document.getElementById("schedule-tbody");
    if (!board.rows.length) {
      const span = 1 + days.length;
      tbody.innerHTML = '<tr><td colspan="' + span + '" class="schedule-empty-hint">' +
        "Ще немає жодного рядка. Натисніть «Додати спеціаліста» вище." + "</td></tr>";
      return;
    }
    tbody.innerHTML = board.rows.map((row) => rowHtml(row, days)).join("");
  }

  // Rebuilds the toolbar's room-management <option> list, keeping it
  // pointed at managedRoomId. Only called after rooms are added/removed —
  // renaming updates existing <option> text in place instead (see
  // wireEvents' room-name-input listener) so nothing loses focus
  // mid-keystroke.
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

  // Called after any add/remove of a room: makes sure managedRoomId still
  // points at a real room (falling back to the first one), then
  // refreshes the toolbar controls and the table (cell dropdowns need
  // their <option> list rebuilt whenever the room list changes).
  function syncRoomControls() {
    if (!board.rooms.some((r) => r.id === managedRoomId)) {
      managedRoomId = board.rooms.length ? board.rooms[0].id : null;
    }
    populateRoomSelect();
    updateRoomNameField();
    render();
  }

  // Mirrors populateRoomSelect()/updateRoomNameField() for the
  // specialists toolbar group.
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

  // Mirrors syncRoomControls(): called after add/remove of a specialist.
  function syncSpecialistControls() {
    if (!board.specialists.some((s) => s.id === managedSpecialistId)) {
      managedSpecialistId = board.specialists.length ? board.specialists[0].id : null;
    }
    populateSpecialistSelect();
    updateSpecialistNameField();
    render();
  }

  function updateWeekControls() {
    document.getElementById("week-label").textContent = formatWeekRange(weekStart);
    const dateInput = document.getElementById("calendar-date-input");
    if (dateInput) dateInput.value = toISODate(weekStart);
  }

  function goToWeek(newWeekStart) {
    weekStart = newWeekStart;
    updateWeekControls();
    render();
  }

  function render() {
    currentWeekDays = getWeekDays(weekStart);
    renderThead(currentWeekDays);
    renderTbody(currentWeekDays);
  }

  // Adds a new saved specialist to the roster *and* a table row already
  // pointing at them — the common case (someone new joins) still takes
  // one click. The row can be reassigned to a different saved specialist
  // later via its own dropdown, or removed independently of the roster.
  function addSpecialist() {
    const spec = { id: uid(), name: "" };
    board.specialists.push(spec);
    board.rows.push({ id: uid(), specialistId: spec.id });
    managedSpecialistId = spec.id;
    syncSpecialistControls();
    flushSave();
    document.getElementById("specialist-name-input").focus();
  }

  // Removes a specialist from the saved roster. Rows that pointed at
  // them become unassigned ("— оберіть спеціаліста —") rather than being
  // deleted, so their room schedule isn't lost — reassign or remove the
  // row separately if it's no longer needed.
  function removeSpecialist(id) {
    if (!id) return;
    const spec = board.specialists.find((s) => s.id === id);
    if (!spec) return;
    const confirmed = window.confirm(
      "Видалити спеціаліста" + (spec.name ? " «" + spec.name + "»" : "") + " зі списку? Рядки з ним стануть непризначеними (дані розкладу збережуться)."
    );
    if (!confirmed) return;
    board.specialists = board.specialists.filter((s) => s.id !== id);
    board.rows.forEach((r) => { if (r.specialistId === id) r.specialistId = null; });
    syncSpecialistControls();
    flushSave();
  }

  function removeRow(id) {
    if (!id) return;
    const confirmed = window.confirm("Видалити цей рядок розкладу разом з усіма призначеннями в ньому?");
    if (!confirmed) return;
    board.rows = board.rows.filter((r) => r.id !== id);
    Object.keys(board.cells).forEach((key) => { if (key.startsWith(id + "|")) delete board.cells[key]; });
    render();
    flushSave();
  }

  function addRoom() {
    const color = ROOM_COLORS[board.rooms.length % ROOM_COLORS.length];
    const room = { id: uid(), name: "Зал " + (board.rooms.length + 1), color };
    board.rooms.push(room);
    managedRoomId = room.id; // jump the toolbar straight to the newly added room
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
    const confirmed = window.confirm('Видалити зал «' + room.name + '»? Усі призначення на нього також буде очищено.');
    if (!confirmed) return;
    board.rooms = board.rooms.filter((r) => r.id !== id);
    Object.keys(board.cells).forEach((key) => { if (board.cells[key] === id) delete board.cells[key]; });
    syncRoomControls();
    flushSave();
  }

  function wireEvents() {
    const table = document.getElementById("schedule-table");

    // The "Керування залом"/"Керування спеціалістом" groups are tucked
    // behind this toggle by default — they're edited rarely compared to
    // just picking rooms in the grid, so keeping them collapsed keeps
    // the toolbar from looking cluttered.
    document.getElementById("toggle-management-btn").addEventListener("click", () => {
      const btn = document.getElementById("toggle-management-btn");
      const panel = document.getElementById("management-panel");
      const expanded = btn.getAttribute("aria-expanded") === "true";
      panel.hidden = expanded;
      btn.setAttribute("aria-expanded", String(!expanded));
    });

    document.getElementById("prev-week-btn").addEventListener("click", () => goToWeek(addDays(weekStart, -7)));
    document.getElementById("next-week-btn").addEventListener("click", () => goToWeek(addDays(weekStart, 7)));

    // A real <input type="date"> gives us a full native calendar picker
    // for free — the button just opens it instead of showing the input
    // itself (see .schedule-calendar-input in schedule.css).
    document.getElementById("open-calendar-btn").addEventListener("click", () => {
      const input = document.getElementById("calendar-date-input");
      try { input.showPicker(); } catch (e) { input.focus(); input.click(); }
    });
    document.getElementById("calendar-date-input").addEventListener("change", (e) => {
      if (!e.target.value) return;
      goToWeek(startOfWeek(parseISODate(e.target.value)));
    });

    // Room cells and each row's specialist dropdown are both rebuilt on
    // every render() — handled via delegation on the table rather than
    // per-element listeners that would be lost on the next render.
    table.addEventListener("change", (e) => {
      const cellSelect = e.target.closest("[data-cell]");
      if (cellSelect) {
        const key = cellSelect.getAttribute("data-cell");
        const roomId = cellSelect.value;
        if (roomId) board.cells[key] = roomId; else delete board.cells[key];

        // Update just this cell's tint in place instead of a full
        // render() — keeps scroll position and avoids rebuilding every
        // other select.
        const room = board.rooms.find((r) => r.id === roomId) || null;
        const td = cellSelect.closest("td");
        td.className = room ? "schedule-cell--" + room.color : "";
        cellSelect.dataset.empty = String(!roomId);

        flushSave();
        return;
      }

      const rowSelect = e.target.closest("[data-row-specialist]");
      if (rowSelect) {
        const row = board.rows.find((r) => r.id === rowSelect.getAttribute("data-row-specialist"));
        if (!row) return;
        row.specialistId = rowSelect.value || null;
        // Keep that row's day-cell aria-labels (which name the current
        // specialist) accurate without a full re-render.
        table.querySelectorAll('tr[data-row="' + row.id + '"] [data-cell]').forEach((sel, i) => {
          const day = currentWeekDays[i];
          sel.setAttribute("aria-label", "Зал: " + specialistName(row.specialistId) + ", " + (day ? day.label + " " + day.dateLabel : ""));
        });
        flushSave();
      }
    });

    table.addEventListener("click", (e) => {
      const removeBtn = e.target.closest("[data-remove-row]");
      if (removeBtn) removeRow(removeBtn.getAttribute("data-remove-row"));
    });

    document.getElementById("add-room-btn").addEventListener("click", addRoom);
    document.getElementById("remove-room-btn").addEventListener("click", () => removeRoom(managedRoomId));

    document.getElementById("room-select").addEventListener("change", (e) => {
      managedRoomId = e.target.value;
      updateRoomNameField();
    });

    // Renaming updates every matching <option> in place — the toolbar's
    // own select plus that room's option inside every specialist × day
    // cell dropdown — instead of going through populateRoomSelect() /
    // render(), so nothing loses focus mid-keystroke.
    const roomNameInput = document.getElementById("room-name-input");
    roomNameInput.addEventListener("input", (e) => {
      const room = getManagedRoom();
      if (!room) return;
      room.name = e.target.value;
      document.querySelectorAll('option[value="' + room.id + '"]').forEach((opt) => { opt.textContent = room.name; });
      scheduleSave();
    });
    roomNameInput.addEventListener("focusout", flushSave);

    document.getElementById("add-specialist-btn").addEventListener("click", addSpecialist);
    document.getElementById("remove-specialist-btn").addEventListener("click", () => removeSpecialist(managedSpecialistId));

    document.getElementById("specialist-select").addEventListener("change", (e) => {
      managedSpecialistId = e.target.value;
      updateSpecialistNameField();
    });

    // Renaming updates the toolbar's own <option> plus that specialist's
    // <option> inside every row's dropdown (there can be several, or
    // zero) instead of going through populateSpecialistSelect() /
    // render(), so nothing loses focus mid-keystroke.
    const specialistNameInput = document.getElementById("specialist-name-input");
    specialistNameInput.addEventListener("input", (e) => {
      const spec = getManagedSpecialist();
      if (!spec) return;
      spec.name = e.target.value;
      const label = spec.name || "Без імені";
      document.querySelectorAll(
        '#specialist-select option[value="' + spec.id + '"], [data-row-specialist] option[value="' + spec.id + '"]'
      ).forEach((opt) => { opt.textContent = label; });
      scheduleSave();
    });
    specialistNameInput.addEventListener("focusout", flushSave);
  }

  window.ScheduleBoard = {
    async init(profileId) {
      currentProfileId = profileId;
      wireEvents();
      updateWeekControls();
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
