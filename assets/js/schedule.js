// Schedule board (admin/schedule.html): specialists × day-of-week grid,
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
//   - board.cells — room assignments keyed by "rowId|dayKey" (NOT by
//     specialist), so a row's schedule survives reassigning it to a
//     different specialist.

(function () {
  const DAYS = [
    { key: "mon", label: "Пн" },
    { key: "tue", label: "Вт" },
    { key: "wed", label: "Ср" },
    { key: "thu", label: "Чт" },
    { key: "fri", label: "Пт" },
    { key: "sat", label: "Сб" },
  ];

  // Cycled across rooms in creation order. Bold/saturated on purpose (see
  // the "Room tint" comment in schedule.css) rather than the public
  // site's pastel tokens — legibility across a crowded staff table
  // matters more here than the sensory-gentle palette the landing page
  // uses. Five hues before a 6th room repeats a color.
  const ROOM_COLORS = ["blue", "yellow", "green", "orange", "purple"];

  const BOARD_ROW_ID = "main";

  let board = null;
  let currentProfileId = null;
  let saveTimer = null;
  let managedRoomId = null; // room targeted by the toolbar's rename/delete controls
  let managedSpecialistId = null; // specialist targeted by the toolbar's rename/delete controls

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

  function cellKey(rowId, dayKey) {
    return rowId + "|" + dayKey;
  }

  function defaultBoard() {
    return {
      rooms: [
        { id: uid(), name: "Зал 1", color: "blue" },
        { id: uid(), name: "Зал 2", color: "yellow" },
        { id: uid(), name: "Зал 3", color: "green" },
      ],
      specialists: [],
      rows: [],
      cells: {},
    };
  }

  // Maps the old pastel palette (sage/sky/apricot) to its closest new
  // bright hue, so boards saved before this change keep each room
  // visually distinct instead of every legacy room collapsing to the
  // same fallback color.
  const LEGACY_ROOM_COLORS = { sage: "green", sky: "blue", apricot: "yellow" };

  function normalizeRoomColor(color) {
    if (ROOM_COLORS.includes(color)) return color;
    if (LEGACY_ROOM_COLORS[color]) return LEGACY_ROOM_COLORS[color];
    return ROOM_COLORS[0];
  }

  function normalizeBoard(raw) {
    const fallback = defaultBoard();
    if (!raw || typeof raw !== "object") return fallback;

    const rooms = Array.isArray(raw.rooms) && raw.rooms.length
      ? raw.rooms.filter((r) => r && r.id && r.name != null).map((r) => ({
          id: String(r.id), name: String(r.name), color: normalizeRoomColor(r.color),
        }))
      : fallback.rooms;

    const specialists = Array.isArray(raw.specialists)
      ? raw.specialists.filter((s) => s && s.id).map((s) => ({ id: String(s.id), name: String(s.name || "") }))
      : [];

    // Boards saved before `rows` existed had one row per specialist,
    // keyed the same way — reuse each specialist's id as its row id so
    // old board.cells entries ("specialistId|day") still resolve
    // correctly without a separate migration step.
    const rows = Array.isArray(raw.rows)
      ? raw.rows.filter((r) => r && r.id).map((r) => ({
          id: String(r.id), specialistId: r.specialistId ? String(r.specialistId) : null,
        }))
      : specialists.map((s) => ({ id: s.id, specialistId: s.id }));

    const cells = (raw.cells && typeof raw.cells === "object") ? raw.cells : {};
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

  function renderThead() {
    const thead = document.getElementById("schedule-thead");
    thead.innerHTML = "<tr>" +
      '<th class="schedule-col-specialist">Спеціаліст</th>' +
      DAYS.map((day) => '<th class="schedule-day-th">' + day.label + "</th>").join("") +
      "</tr>";
  }

  function cellSelectHtml(row, day) {
    const key = cellKey(row.id, day.key);
    const roomId = board.cells[key] || "";
    const room = board.rooms.find((r) => r.id === roomId) || null;
    const colorClass = room ? "schedule-cell--" + room.color : "";
    const options = '<option value="">—</option>' + board.rooms.map((r) =>
      '<option value="' + r.id + '"' + (r.id === roomId ? " selected" : "") + ">" + escapeHtml(r.name) + "</option>"
    ).join("");
    return '<td class="' + colorClass + '">' +
      '<select class="schedule-cell-select" data-cell="' + key + '" data-empty="' + (roomId ? "false" : "true") + '" aria-label="Зал: ' + escapeHtml(specialistName(row.specialistId)) + ", " + day.label + '">' +
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

  function rowHtml(row) {
    const cells = DAYS.map((day) => cellSelectHtml(row, day)).join("");
    return '<tr data-row="' + row.id + '">' +
      '<td class="schedule-col-specialist"><div class="schedule-row-header">' +
      rowSpecialistSelectHtml(row) +
      '<button type="button" class="schedule-remove-btn" data-remove-row="' + row.id + '" title="Видалити рядок" aria-label="Видалити рядок">×</button>' +
      "</div></td>" + cells + "</tr>";
  }

  function renderTbody() {
    const tbody = document.getElementById("schedule-tbody");
    if (!board.rows.length) {
      const span = 1 + DAYS.length;
      tbody.innerHTML = '<tr><td colspan="' + span + '" class="schedule-empty-hint">' +
        "Ще немає жодного рядка. Натисніть «Додати спеціаліста» вище." + "</td></tr>";
      return;
    }
    tbody.innerHTML = board.rows.map(rowHtml).join("");
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

  function render() {
    renderThead();
    renderTbody();
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
          sel.setAttribute("aria-label", "Зал: " + specialistName(row.specialistId) + ", " + DAYS[i].label);
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
