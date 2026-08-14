// Schedule board (admin/schedule.html): specialists × day-of-week grid,
// stored as a single JSONB row in public.schedule_boards (id='main').
// Loaded after supabase-config.js + admin-auth.js (needs window.sbClient).
//
// The whole board — room list, specialist list, and which room (if any)
// each specialist × day cell is assigned to — lives in one in-memory
// object (`board`) that's re-rendered top to bottom on every change and
// pushed to Supabase shortly after. Each cell is its own room dropdown
// (board.cells["specialistId|dayKey"] = roomId), so any specialist can
// be in a different room on any given day.

(function () {
  const DAYS = [
    { key: "mon", label: "Пн" },
    { key: "tue", label: "Вт" },
    { key: "wed", label: "Ср" },
    { key: "thu", label: "Чт" },
    { key: "fri", label: "Пт" },
    { key: "sat", label: "Сб" },
  ];

  // Cycled across rooms in creation order — three existing pastel design
  // tokens (see assets/css/styles.css), reused rather than inventing new
  // colors so a 4th/5th room still matches the site's palette.
  const ROOM_COLORS = ["sage", "sky", "apricot"];

  const BOARD_ROW_ID = "main";

  let board = null;
  let currentProfileId = null;
  let saveTimer = null;
  let managedRoomId = null; // room targeted by the toolbar's rename/delete controls

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

  function cellKey(specialistId, dayKey) {
    return specialistId + "|" + dayKey;
  }

  function defaultBoard() {
    return {
      rooms: [
        { id: uid(), name: "Зал 1", color: "sage" },
        { id: uid(), name: "Зал 2", color: "sky" },
        { id: uid(), name: "Зал 3", color: "apricot" },
      ],
      specialists: [],
      cells: {},
    };
  }

  function normalizeBoard(raw) {
    const fallback = defaultBoard();
    if (!raw || typeof raw !== "object") return fallback;
    const rooms = Array.isArray(raw.rooms) && raw.rooms.length
      ? raw.rooms.filter((r) => r && r.id && r.name != null).map((r) => ({
          id: String(r.id), name: String(r.name), color: ROOM_COLORS.includes(r.color) ? r.color : "sage",
        }))
      : fallback.rooms;
    const specialists = Array.isArray(raw.specialists)
      ? raw.specialists.filter((s) => s && s.id).map((s) => ({ id: String(s.id), name: String(s.name || "") }))
      : [];
    const cells = (raw.cells && typeof raw.cells === "object") ? raw.cells : {};
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
  // fire a write per keystroke; discrete actions (add/remove a row,
  // picking a room in a cell's dropdown) call saveBoard() directly since
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

  function renderThead() {
    const thead = document.getElementById("schedule-thead");
    thead.innerHTML = "<tr>" +
      '<th class="schedule-col-specialist">Спеціаліст</th>' +
      DAYS.map((day) => '<th class="schedule-day-th">' + day.label + "</th>").join("") +
      "</tr>";
  }

  function cellSelectHtml(spec, day) {
    const key = cellKey(spec.id, day.key);
    const roomId = board.cells[key] || "";
    const room = board.rooms.find((r) => r.id === roomId) || null;
    const colorClass = room ? "schedule-cell--" + room.color : "";
    const options = '<option value="">—</option>' + board.rooms.map((r) =>
      '<option value="' + r.id + '"' + (r.id === roomId ? " selected" : "") + ">" + escapeHtml(r.name) + "</option>"
    ).join("");
    return '<td class="' + colorClass + '">' +
      '<select class="schedule-cell-select" data-cell="' + key + '" data-empty="' + (roomId ? "false" : "true") + '" aria-label="Зал: ' + escapeHtml(spec.name || "спеціаліст") + ", " + day.label + '">' +
      options + "</select></td>";
  }

  function specialistRowHtml(spec) {
    const cells = DAYS.map((day) => cellSelectHtml(spec, day)).join("");
    return '<tr data-specialist-row="' + spec.id + '">' +
      '<td class="schedule-col-specialist"><div class="schedule-specialist-row">' +
      '<input class="schedule-name-input" data-specialist-name="' + spec.id + '" value="' + escapeHtml(spec.name) + '" placeholder="Ім\'я спеціаліста">' +
      '<button type="button" class="schedule-remove-btn" data-remove-specialist="' + spec.id + '" title="Видалити спеціаліста" aria-label="Видалити спеціаліста ' + escapeHtml(spec.name) + '">×</button>' +
      "</div></td>" + cells + "</tr>";
  }

  function renderTbody() {
    const tbody = document.getElementById("schedule-tbody");
    if (!board.specialists.length) {
      const span = 1 + DAYS.length;
      tbody.innerHTML = '<tr><td colspan="' + span + '" class="schedule-empty-hint">' +
        "Ще немає жодного спеціаліста. Натисніть «Додати спеціаліста» вище." + "</td></tr>";
      return;
    }
    tbody.innerHTML = board.specialists.map(specialistRowHtml).join("");
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

  function render() {
    renderThead();
    renderTbody();
  }

  function addSpecialist() {
    board.specialists.push({ id: uid(), name: "" });
    render();
    flushSave();
    const input = document.querySelector('.schedule-name-input[data-specialist-name="' + board.specialists[board.specialists.length - 1].id + '"]');
    if (input) input.focus();
  }

  function removeSpecialist(id) {
    const spec = board.specialists.find((s) => s.id === id);
    if (!spec) return;
    const confirmed = window.confirm("Видалити спеціаліста" + (spec.name ? " «" + spec.name + "»" : "") + " з розкладу?");
    if (!confirmed) return;
    board.specialists = board.specialists.filter((s) => s.id !== id);
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

    table.addEventListener("input", (e) => {
      const specName = e.target.closest("[data-specialist-name]");
      if (specName) {
        const s = board.specialists.find((s) => s.id === specName.getAttribute("data-specialist-name"));
        if (s) { s.name = specName.value; scheduleSave(); }
      }
    });

    // Flush on blur too, so a quick edit-then-close-tab isn't silently
    // lost while the 700ms debounce is still pending.
    table.addEventListener("focusout", (e) => {
      if (e.target.closest("[data-specialist-name]")) flushSave();
    });

    table.addEventListener("click", (e) => {
      const removeSpec = e.target.closest("[data-remove-specialist]");
      if (removeSpec) removeSpecialist(removeSpec.getAttribute("data-remove-specialist"));
    });

    // Each specialist × day cell is its own room dropdown (rebuilt on
    // every render), so — same as the specialist-name inputs — it's
    // handled via delegation on the table rather than per-element
    // listeners that would be lost on the next render.
    table.addEventListener("change", (e) => {
      const cellSelect = e.target.closest("[data-cell]");
      if (!cellSelect) return;
      const key = cellSelect.getAttribute("data-cell");
      const roomId = cellSelect.value;
      if (roomId) board.cells[key] = roomId; else delete board.cells[key];

      // Update just this cell's tint in place instead of a full render()
      // — keeps scroll position and avoids rebuilding every other select.
      const room = board.rooms.find((r) => r.id === roomId) || null;
      const td = cellSelect.closest("td");
      td.className = room ? "schedule-cell--" + room.color : "";
      cellSelect.dataset.empty = String(!roomId);

      flushSave();
    });

    document.getElementById("add-specialist-btn").addEventListener("click", addSpecialist);
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
  }

  window.ScheduleBoard = {
    async init(profileId) {
      currentProfileId = profileId;
      wireEvents();
      board = await loadBoard();
      managedRoomId = board.rooms.length ? board.rooms[0].id : null;
      populateRoomSelect();
      updateRoomNameField();
      render();
      if (document.getElementById("save-status").dataset.state !== "error") setStatus("idle");
    },
  };
})();
