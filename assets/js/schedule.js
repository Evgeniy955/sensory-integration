// Schedule board (admin/schedule.html): specialists × day-of-week grid for
// one room at a time, stored as a single JSONB row in
// public.schedule_boards (id='main'). Loaded after supabase-config.js +
// admin-auth.js (needs window.sbClient).
//
// The whole board — room list, specialist list, and every cell's text —
// lives in one in-memory object (`board`) that's re-rendered top to
// bottom on every change and pushed to Supabase shortly after. The room
// dropdown in the toolbar just changes which room's cells the table
// currently shows (`selectedRoomId`); it doesn't change what's stored.

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
  let selectedRoomId = null;

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

  function cellKey(specialistId, dayKey, roomId) {
    return specialistId + "|" + dayKey + "|" + roomId;
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

  // Text edits (cell content, renaming a room/specialist) debounce so we
  // don't fire a write per keystroke; structural edits (add/remove a row
  // or column) call saveBoard() directly since those are already
  // one-click, infrequent actions.
  function scheduleSave() {
    setStatus("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBoard, 700);
  }
  function flushSave() {
    clearTimeout(saveTimer);
    saveBoard();
  }

  function getSelectedRoom() {
    return board.rooms.find((r) => r.id === selectedRoomId) || null;
  }

  function renderThead() {
    const thead = document.getElementById("schedule-thead");
    const room = getSelectedRoom();
    const colorClass = room ? "schedule-room-th--" + room.color : "";
    thead.innerHTML = "<tr>" +
      '<th class="schedule-col-specialist">Спеціаліст</th>' +
      DAYS.map((day) => '<th class="schedule-day-th ' + colorClass + '">' + day.label + "</th>").join("") +
      "</tr>";
  }

  function specialistRowHtml(spec, colorClass) {
    const room = getSelectedRoom();
    const cells = DAYS.map((day) => {
      const key = room ? cellKey(spec.id, day.key, room.id) : null;
      const val = key ? (board.cells[key] || "") : "";
      return '<td class="' + colorClass + '">' +
        '<input class="schedule-cell-input" data-cell="' + (key || "") + '" value="' + escapeHtml(val) + '" placeholder="—"' + (key ? "" : " disabled") + ">" +
        "</td>";
    }).join("");

    return '<tr data-specialist-row="' + spec.id + '">' +
      '<td class="schedule-col-specialist"><div class="schedule-specialist-row">' +
      '<input class="schedule-name-input" data-specialist-name="' + spec.id + '" value="' + escapeHtml(spec.name) + '" placeholder="Ім\'я спеціаліста">' +
      '<button type="button" class="schedule-remove-btn" data-remove-specialist="' + spec.id + '" title="Видалити спеціаліста" aria-label="Видалити спеціаліста ' + escapeHtml(spec.name) + '">×</button>' +
      "</div></td>" + cells + "</tr>";
  }

  function renderTbody() {
    const tbody = document.getElementById("schedule-tbody");
    const room = getSelectedRoom();
    const colorClass = room ? "schedule-cell--" + room.color : "";
    if (!board.specialists.length) {
      const span = 1 + DAYS.length;
      tbody.innerHTML = '<tr><td colspan="' + span + '" class="schedule-empty-hint">' +
        "Ще немає жодного спеціаліста. Натисніть «Додати спеціаліста» вище." + "</td></tr>";
      return;
    }
    tbody.innerHTML = board.specialists.map((spec) => specialistRowHtml(spec, colorClass)).join("");
  }

  // Rebuilds the <option> list from board.rooms and keeps it pointed at
  // selectedRoomId. Only called after rooms are added/removed — renaming
  // updates the existing <option>'s text in place instead (see
  // wireEvents' room-name-input listener) so the dropdown doesn't lose
  // focus mid-keystroke.
  function populateRoomSelect() {
    const select = document.getElementById("room-select");
    select.innerHTML = board.rooms.map((r) =>
      '<option value="' + r.id + '"' + (r.id === selectedRoomId ? " selected" : "") + ">" + escapeHtml(r.name) + "</option>"
    ).join("");
  }

  function updateRoomNameField() {
    const room = getSelectedRoom();
    document.getElementById("room-name-input").value = room ? room.name : "";
  }

  // Called after any add/remove of a room: makes sure selectedRoomId still
  // points at a real room (falling back to the first one), then refreshes
  // the dropdown, the rename field, and the table.
  function syncRoomControls() {
    if (!board.rooms.some((r) => r.id === selectedRoomId)) {
      selectedRoomId = board.rooms.length ? board.rooms[0].id : null;
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
    selectedRoomId = room.id; // jump straight to the newly added room
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
    const confirmed = window.confirm('Видалити зал «' + room.name + '»? Усі записи в ньому також буде видалено.');
    if (!confirmed) return;
    board.rooms = board.rooms.filter((r) => r.id !== id);
    Object.keys(board.cells).forEach((key) => { if (key.split("|")[2] === id) delete board.cells[key]; });
    syncRoomControls();
    flushSave();
  }

  function wireEvents() {
    const table = document.getElementById("schedule-table");

    table.addEventListener("input", (e) => {
      const cellInput = e.target.closest("[data-cell]");
      if (cellInput) {
        const key = cellInput.getAttribute("data-cell");
        if (key) { board.cells[key] = cellInput.value; scheduleSave(); }
        return;
      }
      const specName = e.target.closest("[data-specialist-name]");
      if (specName) {
        const s = board.specialists.find((s) => s.id === specName.getAttribute("data-specialist-name"));
        if (s) { s.name = specName.value; scheduleSave(); }
      }
    });

    // Flush on blur too, so a quick edit-then-close-tab isn't silently
    // lost while the 700ms debounce is still pending.
    table.addEventListener("focusout", (e) => {
      if (e.target.closest("[data-cell], [data-specialist-name]")) flushSave();
    });

    table.addEventListener("click", (e) => {
      const removeSpec = e.target.closest("[data-remove-specialist]");
      if (removeSpec) removeSpecialist(removeSpec.getAttribute("data-remove-specialist"));
    });

    document.getElementById("add-specialist-btn").addEventListener("click", addSpecialist);
    document.getElementById("add-room-btn").addEventListener("click", addRoom);
    document.getElementById("remove-room-btn").addEventListener("click", () => removeRoom(selectedRoomId));

    document.getElementById("room-select").addEventListener("change", (e) => {
      selectedRoomId = e.target.value;
      updateRoomNameField();
      render();
    });

    // Renaming updates the matching <option> text directly instead of
    // going through populateRoomSelect(), so the <select> isn't rebuilt
    // (and the input doesn't lose focus) on every keystroke.
    const roomNameInput = document.getElementById("room-name-input");
    roomNameInput.addEventListener("input", (e) => {
      const room = getSelectedRoom();
      if (!room) return;
      room.name = e.target.value;
      const option = document.querySelector('#room-select option[value="' + room.id + '"]');
      if (option) option.textContent = room.name;
      scheduleSave();
    });
    roomNameInput.addEventListener("focusout", flushSave);
  }

  window.ScheduleBoard = {
    async init(profileId) {
      currentProfileId = profileId;
      wireEvents();
      board = await loadBoard();
      selectedRoomId = board.rooms.length ? board.rooms[0].id : null;
      populateRoomSelect();
      updateRoomNameField();
      render();
      if (document.getElementById("save-status").dataset.state !== "error") setStatus("idle");
    },
  };
})();
