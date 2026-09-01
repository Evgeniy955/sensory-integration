(function () {
  const $ = (id) => document.getElementById(id);
  let profile = null;
  let anketas = [];
  let specialists = [];
  let subscriptions = [];
  let selectedChildId = "";
  const SUBSCRIPTION_DURATION_DAYS = 45;

  function escapeHtml(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c])); }
  function isoDate(date) { return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0"); }
  function formatDate(value) { return value ? new Date(value + "T00:00:00").toLocaleDateString("uk-UA") : "—"; }
  function setStatus(message, error) { $("form-status").textContent = message || ""; $("form-status").classList.toggle("is-error", !!error); }
  function addDays(value, days) { const date = new Date(value + "T00:00:00"); date.setDate(date.getDate() + days); return isoDate(date); }
  function remainingSessions(row) { return Math.max(0, Number(row.sessions_total || 0) - Number(row.sessions_used || 0)); }
  function uniqueUsedSessions(rows) { return new Set(rows.filter((item) => item.status !== "transferred").map((item) => item.schedule_cell_key)).size; }
  function latestDate(rows, field) { return rows.reduce((latest, row) => row[field] && (!latest || row[field] > latest) ? row[field] : latest, ""); }
  function effectiveEndDate(row, rows) {
    const baseEnd = row.base_ends_on || row.ends_on;
    const frozenEnd = addDays(baseEnd, Number(row.freeze_days || 0));
    const transferEnd = latestDate(rows.filter((item) => item.status === "transferred"), "transferred_to_date");
    return transferEnd && transferEnd > frozenEnd ? transferEnd : frozenEnd;
  }

  function calendarChildren(entry) {
    return Array.isArray(entry.children) && entry.children.length ? entry.children : (entry.anketaId ? [{ anketaId: entry.anketaId, childName: entry.childName || "", subscriptionId: entry.subscriptionId || null }] : []);
  }

  function calendarAttendanceRows(boardData, existingRows) {
    const today = isoDate(new Date());
    const cells = boardData && boardData.cells && typeof boardData.cells === "object" ? boardData.cells : {};
    const existingByCalendarSlot = new Map((existingRows || []).map((row) => [row.schedule_cell_key + "|" + normalizeName(row.child_name), row]));
    return Object.entries(cells).flatMap(([scheduleCellKey, entry]) => {
      const parts = scheduleCellKey.split("|");
      if (parts.length !== 3 || !entry || !/^\d{4}-\d{2}-\d{2}$/.test(parts[1])) return [];
      const sessionDate = parts[1];
      return calendarChildren(entry).flatMap((child) => {
        const previous = existingByCalendarSlot.get(scheduleCellKey + "|" + normalizeName(child.childName));
        const subscriptionId = child.subscriptionId || entry.subscriptionId || (previous && previous.subscription_id);
        const status = entry.isGroup ? (child.status || "attended") : (entry.attendanceStatus || (entry.noShow ? "no_show" : "attended"));
        const transferredToDate = entry.isGroup ? child.transferDate : entry.transferDate;
        const transferredToHour = entry.isGroup ? child.transferHour : entry.transferHour;
        // A future slot is a booking, not an attendance. The original
        // transfer remains in history as "Перенос" and carries its target.
        if (!subscriptionId || !child.childName || (sessionDate > today && status !== "transferred")) return [];
        const transferHour = Number(transferredToHour);
        const validTransferHour = Number.isInteger(transferHour) && transferHour >= 8 && transferHour <= 18 ? transferHour : null;
        return [{ subscription_id: subscriptionId, child_name: child.childName, schedule_cell_key: scheduleCellKey, session_date: sessionDate, status, transferred_to_date: transferredToDate || null, transferred_to_hour: validTransferHour, created_by: profile.id, updated_at: new Date().toISOString() }];
      });
    });
  }

  function attendanceKey(row) { return [row.subscription_id, normalizeName(row.child_name), row.schedule_cell_key].join("|"); }
  function normalizeName(value) { return String(value || "").trim().replace(/\s+/g, " ").toLowerCase(); }

  async function syncAttendanceWithCalendar() {
    const [boardResult, attendanceResult] = await Promise.all([
      window.sbClient.from("schedule_boards").select("data").eq("id", "main").maybeSingle(),
      window.sbClient.from("subscription_attendance").select("id, subscription_id, child_name, schedule_cell_key"),
    ]);
    if (boardResult.error) throw boardResult.error;
    if (attendanceResult.error) throw attendanceResult.error;
    if (!boardResult.data || !boardResult.data.data) return;
    const expected = calendarAttendanceRows(boardResult.data && boardResult.data.data, attendanceResult.data || []);
    const expectedByKey = new Map(expected.map((row) => [attendanceKey(row), row]));
    const staleIds = (attendanceResult.data || []).filter((row) => !expectedByKey.has(attendanceKey(row))).map((row) => row.id);
    if (staleIds.length) {
      const deleted = await Promise.all(staleIds.map((id) => window.sbClient.from("subscription_attendance").delete().eq("id", id)));
      const failed = deleted.find((result) => result.error);
      if (failed) throw failed.error;
    }
    if (expected.length) {
      const saved = await window.sbClient.from("subscription_attendance").upsert(expected, { onConflict: "subscription_id,child_name,schedule_cell_key" });
      if (saved.error) throw saved.error;
    }
  }

  async function reconcileSubscriptions(rows, attendanceRows) {
    const attendanceBySubscription = (attendanceRows || []).reduce((result, row) => {
      (result[row.subscription_id] ||= []).push(row);
      return result;
    }, {});
    const today = isoDate(new Date());
    const changes = rows.map(async (row) => {
      const visits = attendanceBySubscription[row.id] || [];
      const actualUsed = Math.min(uniqueUsedSessions(visits), Number(row.sessions_total));
      const endsOn = effectiveEndDate(row, visits);
      const hasExpired = actualUsed < Number(row.sessions_total) && endsOn < today;
      const burned = hasExpired ? Number(row.sessions_total) - actualUsed : 0;
      const used = actualUsed + burned;
      const lastUsedDate = latestDate(visits.filter((item) => item.status !== "transferred"), "session_date");
      const reason = hasExpired ? "expired" : (actualUsed >= Number(row.sessions_total) && lastUsedDate && today > lastUsedDate && lastUsedDate < endsOn ? "early" : null);
      const update = { ends_on: endsOn, sessions_used: used, burned_sessions: burned, closed_reason: reason, closed_at: reason ? (row.closed_reason === reason && row.closed_at ? row.closed_at : new Date().toISOString()) : null };
      const differs = Object.keys(update).some((key) => String(row[key] == null ? "" : row[key]) !== String(update[key] == null ? "" : update[key]));
      if (!differs) return false;
      const result = await window.sbClient.from("subscriptions").update(update).eq("id", row.id);
      if (result.error) throw result.error;
      return true;
    });
    return (await Promise.all(changes)).some(Boolean);
  }

  async function loadReferenceData() {
    const [anketaResult, boardResult] = await Promise.all([
      window.sbClient.from("anketas").select("id, child_full_name").eq("is_active", true).order("child_full_name"),
      window.sbClient.from("schedule_boards").select("data").eq("id", "main").maybeSingle(),
    ]);
    if (anketaResult.error) throw anketaResult.error;
    anketas = anketaResult.data || [];
    specialists = (boardResult.data && boardResult.data.data && boardResult.data.data.specialists) || [];
    const specialistOptions = specialists.map((row) => '<option value="' + escapeHtml(row.id) + '">' + escapeHtml(row.name || "Без імені") + "</option>").join("");
    $("regular-specialist").innerHTML = '<option value="">— оберіть спеціаліста —</option>' + specialistOptions;
  }

  function hideChildResults() { $("subscription-child-results").hidden = true; $("subscription-child-results").innerHTML = ""; }
  function renderChildResults(query) {
    const normalized = query.trim().toLowerCase();
    const matches = normalized.length < 2 ? [] : anketas.filter((row) => (row.child_full_name || "").toLowerCase().includes(normalized)).slice(0, 8);
    $("subscription-child-results").innerHTML = matches.length ? matches.map((row) => '<button type="button" class="accounting-child-results__item" data-child-id="' + escapeHtml(row.id) + '" data-child-name="' + escapeHtml(row.child_full_name) + '">' + escapeHtml(row.child_full_name) + '</button>').join("") : '<div class="accounting-table__muted" style="padding:.6rem .7rem;">Дитину не знайдено.</div>';
    $("subscription-child-results").hidden = false;
  }

  async function loadSubscriptions() {
    let result = await window.sbClient.from("subscriptions").select("*, subscription_children(*), subscription_specialists(*)").order("created_at", { ascending: false });
    if (result.error) throw result.error;
    const attendance = await window.sbClient.from("subscription_attendance").select("subscription_id, schedule_cell_key, status, session_date, transferred_to_date");
    if (attendance.error) throw attendance.error;
    if (await reconcileSubscriptions(result.data || [], attendance.data || [])) {
      result = await window.sbClient.from("subscriptions").select("*, subscription_children(*), subscription_specialists(*)").order("created_at", { ascending: false });
      if (result.error) throw result.error;
    }
    subscriptions = result.data || [];
    $("subscriptions-body").innerHTML = subscriptions.length ? subscriptions.map(renderSubscription).join("") : '<tr><td colspan="7" class="anketa-table-empty">Абонементів ще немає.</td></tr>';
  }

  async function loadAttendance() {
    const result = await window.sbClient.from("subscription_attendance").select("id, child_name, session_date, status, schedule_cell_key, transferred_to_date, transferred_to_hour").order("session_date", { ascending: false }).limit(100);
    if (result.error) throw result.error;
    const labels = { attended: "Відвідав", no_show: "Не прийшов", transferred: "Перенос" };
    $("attendance-body").innerHTML = result.data && result.data.length ? result.data.map((row) => { const target = row.status === "transferred" && row.transferred_to_date ? " → " + formatDate(row.transferred_to_date) + (row.transferred_to_hour != null ? " · " + String(row.transferred_to_hour).padStart(2, "0") + ":00" : "") : ""; return '<tr><td>' + formatDate(row.session_date) + '</td><td>' + escapeHtml(row.child_name) + '</td><td><span class="accounting-status-badge">' + labels[row.status] + '</span><div class="accounting-table__muted">' + target + '</div></td><td class="accounting-table__muted">' + escapeHtml(row.schedule_cell_key) + '</td></tr>'; }).join("") : '<tr><td colspan="4" class="anketa-table-empty">Статусів відвідування ще немає.</td></tr>';
  }

  function renderSubscription(row) {
    const children = (row.subscription_children || []).map((child) => child.child_name).join(", ");
    const people = (row.subscription_specialists || []).map((item) => item.specialist_name).join(", ") || "—";
    const today = isoDate(new Date());
    const remaining = remainingSessions(row);
    const closed = row.closed_reason || row.ends_on < today;
    const fullyScheduled = !row.closed_reason && remaining === 0;
    const status = row.is_frozen ? '<span class="accounting-status-badge accounting-status-badge--frozen">Заморожений' + (row.frozen_until ? " до " + formatDate(row.frozen_until) : "") + '</span>' : (row.closed_reason === "early" ? '<span class="accounting-status-badge">✓ Достроково</span>' : (row.closed_reason === "expired" ? '<span class="accounting-status-badge accounting-status-badge--expired">Згоріло: ' + Number(row.burned_sessions || 0) + '</span>' : (closed ? '<span class="accounting-status-badge accounting-status-badge--expired">Завершений</span>' : (fullyScheduled ? '<span class="accounting-status-badge">Заплановано</span>' : '<span class="accounting-status-badge">Активний</span>'))));
    const action = closed ? "" : (row.is_frozen ? '<button type="button" class="anketa-btn" data-unfreeze="' + row.id + '">Розморозити</button>' : '<button type="button" class="anketa-btn" data-freeze="' + row.id + '">Заморозити</button>');
    return '<tr><td>' + escapeHtml(children) + (row.is_group ? '<div class="accounting-table__muted">Група</div>' : "") + '</td><td>' + escapeHtml(row.direction) + '<div class="accounting-table__muted">' + escapeHtml(people) + '</div></td><td>' + row.sessions_used + " / " + row.sessions_total + '</td><td><strong>' + remaining + '</strong></td><td>' + formatDate(row.starts_on) + " — " + formatDate(row.ends_on) + '</td><td>' + status + '</td><td><div class="accounting-row-actions">' + action + '<button type="button" class="anketa-btn anketa-btn--danger" data-delete="' + row.id + '">Видалити</button></div></td></tr>';
  }

  async function createSubscription(event) {
    event.preventDefault(); setStatus("Зберігаємо…");
    const direction = $("direction").value;
    const specialistId = direction === "Групове" ? null : $("regular-specialist").value;
    if (!selectedChildId || (!specialistId && direction !== "Групове")) { setStatus(direction === "Групове" ? "Оберіть дитину зі списку." : "Оберіть дитину та спеціаліста.", true); return; }
    const payload = { sessions_total: Number($("sessions-total").value), direction, specialist_id: specialistId, starts_on: $("starts-on").value, ends_on: $("ends-on").value, base_ends_on: $("ends-on").value, freeze_days: 0, burned_sessions: 0, is_group: false, created_by: profile.id };
    const created = await window.sbClient.from("subscriptions").insert(payload).select("id").single();
    if (created.error) { setStatus(created.error.message, true); return; }
    const child = anketas.find((item) => item.id === selectedChildId);
    const childrenResult = await window.sbClient.from("subscription_children").insert({ subscription_id: created.data.id, anketa_id: selectedChildId, child_name: child ? child.child_full_name : "" });
    if (childrenResult.error) { setStatus(childrenResult.error.message, true); return; }
    if (specialistId) {
      const spec = specialists.find((item) => item.id === specialistId);
      const specsResult = await window.sbClient.from("subscription_specialists").insert({ subscription_id: created.data.id, specialist_id: specialistId, specialist_name: spec ? (spec.name || "Без імені") : "" });
      if (specsResult.error) { setStatus(specsResult.error.message, true); return; }
    }
    setStatus("Абонемент створено."); event.target.reset(); selectedChildId = ""; $("subscription-child-id").value = ""; hideChildResults(); updateDirectionFields(); setDefaultDates(); await refresh();
  }

  function setEndDateFromStart() {
    const startValue = $("starts-on").value;
    if (!startValue) return;
    $("ends-on").value = Number($("sessions-total").value) === 1 ? startValue : addDays(startValue, SUBSCRIPTION_DURATION_DAYS);
  }
  function setDefaultDates() { $("starts-on").value = isoDate(new Date()); setEndDateFromStart(); }
  function updateDirectionFields() { const isGroupDirection = $("direction").value === "Групове"; $("specialist-field").hidden = isGroupDirection; $("regular-specialist").required = !isGroupDirection; if (isGroupDirection) $("regular-specialist").value = ""; }

  async function changeFreeze(id, frozen) {
    let days = 14;
    if (frozen) { const input = window.prompt("На скільки днів заморозити абонемент? Від 7 до 21.", "14"); if (input === null) return; days = Math.min(21, Math.max(7, Number(input) || 14)); }
    const row = subscriptions.find((item) => item.id === id); if (!row) return;
    const attendance = await window.sbClient.from("subscription_attendance").select("status, transferred_to_date").eq("subscription_id", id);
    if (attendance.error) { window.alert(attendance.error.message); return; }
    const freezeDays = frozen ? Number(row.freeze_days || 0) + days : Number(row.freeze_days || 0);
    const withFreeze = { ...row, freeze_days: freezeDays };
    const update = frozen ? { is_frozen: true, frozen_until: addDays(isoDate(new Date()), days), freeze_days: freezeDays, ends_on: effectiveEndDate(withFreeze, attendance.data || []) } : { is_frozen: false, frozen_until: null };
    const result = await window.sbClient.from("subscriptions").update(update).eq("id", id); if (result.error) window.alert(result.error.message); else await refresh();
  }
  async function deleteSubscription(id) { if (!window.confirm("Видалити абонемент і його статуси відвідування?")) return; const result = await window.sbClient.from("subscriptions").delete().eq("id", id); if (result.error) window.alert(result.error.message); else await refresh(); }
  async function refresh() { try { await syncAttendanceWithCalendar(); await Promise.all([loadSubscriptions(), loadAttendance()]); } catch (error) { setStatus(error.message, true); } }

  $("subscription-child-search").addEventListener("input", (event) => { selectedChildId = ""; $("subscription-child-id").value = ""; renderChildResults(event.target.value); });
  $("subscription-child-results").addEventListener("click", (event) => { const option = event.target.closest("[data-child-id]"); if (!option) return; selectedChildId = option.dataset.childId; $("subscription-child-id").value = selectedChildId; $("subscription-child-search").value = option.dataset.childName || ""; hideChildResults(); });
  $("direction").addEventListener("change", updateDirectionFields); $("starts-on").addEventListener("change", setEndDateFromStart); $("sessions-total").addEventListener("change", setEndDateFromStart); $("subscription-form").addEventListener("submit", createSubscription); $("refresh-btn").addEventListener("click", refresh); $("subscriptions-body").addEventListener("click", (event) => { const freeze = event.target.closest("[data-freeze]"), unfreeze = event.target.closest("[data-unfreeze]"), remove = event.target.closest("[data-delete]"); if (freeze) changeFreeze(freeze.dataset.freeze, true); if (unfreeze) changeFreeze(unfreeze.dataset.unfreeze, false); if (remove) deleteSubscription(remove.dataset.delete); });
  (async function init() { profile = await window.requireAuth(); if (!profile) return; $("whoami").textContent = (profile.full_name || profile.email) + " · Супер адмін"; if (profile.role !== "super_admin") { $("accounting-denied").hidden = false; return; } $("accounting-content").hidden = false; setDefaultDates(); updateDirectionFields(); await loadReferenceData(); await refresh(); })();
})();
