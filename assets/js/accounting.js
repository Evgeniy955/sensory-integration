(function () {
  const $ = (id) => document.getElementById(id);
  let profile = null;
  let anketas = [];
  let specialists = [];
  let subscriptions = [];

  function escapeHtml(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c])); }
  function isoDate(date) { return date.toISOString().slice(0, 10); }
  function formatDate(value) { return value ? new Date(value + "T00:00:00").toLocaleDateString("uk-UA") : "—"; }
  function setStatus(message, error) { $("form-status").textContent = message || ""; $("form-status").classList.toggle("is-error", !!error); }
  function selectedValues(id) { return Array.from($(id).selectedOptions).map((option) => option.value); }

  async function loadReferenceData() {
    const [anketaResult, boardResult] = await Promise.all([
      window.sbClient.from("anketas").select("id, child_full_name").eq("is_active", true).order("child_full_name"),
      window.sbClient.from("schedule_boards").select("data").eq("id", "main").maybeSingle(),
    ]);
    if (anketaResult.error) throw anketaResult.error;
    anketas = anketaResult.data || [];
    specialists = (boardResult.data && boardResult.data.data && boardResult.data.data.specialists) || [];
    const childOptions = anketas.map((row) => '<option value="' + escapeHtml(row.id) + '">' + escapeHtml(row.child_full_name) + "</option>").join("");
    const specialistOptions = specialists.map((row) => '<option value="' + escapeHtml(row.id) + '">' + escapeHtml(row.name || "Без імені") + "</option>").join("");
    $("regular-child").innerHTML = '<option value="">— оберіть дитину —</option>' + childOptions;
    $("group-children").innerHTML = childOptions;
    $("regular-specialist").innerHTML = '<option value="">— оберіть спеціаліста —</option>' + specialistOptions;
    $("group-specialists").innerHTML = specialistOptions;
  }

  async function loadSubscriptions() {
    const result = await window.sbClient.from("subscriptions").select("*, subscription_children(*), subscription_specialists(*)").order("created_at", { ascending: false });
    if (result.error) throw result.error;
    subscriptions = result.data || [];
    $("subscriptions-body").innerHTML = subscriptions.length ? subscriptions.map(renderSubscription).join("") : '<tr><td colspan="6" class="anketa-table-empty">Абонементів ще немає.</td></tr>';
  }

  async function loadAttendance() {
    const result = await window.sbClient.from("subscription_attendance").select("id, child_name, session_date, status, schedule_cell_key").order("session_date", { ascending: false }).limit(100);
    if (result.error) throw result.error;
    const labels = { attended: "Відвідав", no_show: "Не прийшов", transferred: "Перенос" };
    $("attendance-body").innerHTML = result.data && result.data.length ? result.data.map((row) => '<tr><td>' + formatDate(row.session_date) + '</td><td>' + escapeHtml(row.child_name) + '</td><td><span class="accounting-status-badge">' + labels[row.status] + '</span></td><td class="accounting-table__muted">' + escapeHtml(row.schedule_cell_key) + '</td></tr>').join("") : '<tr><td colspan="4" class="anketa-table-empty">Статусів відвідування ще немає.</td></tr>';
  }

  function renderSubscription(row) {
    const children = (row.subscription_children || []).map((child) => child.child_name).join(", ");
    const people = (row.subscription_specialists || []).map((item) => item.specialist_name).join(", ") || "—";
    const today = isoDate(new Date());
    const expired = row.ends_on < today || row.sessions_used >= row.sessions_total;
    const status = row.is_frozen ? '<span class="accounting-status-badge accounting-status-badge--frozen">Заморожений' + (row.frozen_until ? " до " + formatDate(row.frozen_until) : "") + '</span>' : (expired ? '<span class="accounting-status-badge accounting-status-badge--expired">Завершений</span>' : '<span class="accounting-status-badge">Активний</span>');
    const action = row.is_frozen ? '<button type="button" class="anketa-btn" data-unfreeze="' + row.id + '">Розморозити</button>' : '<button type="button" class="anketa-btn" data-freeze="' + row.id + '">Заморозити</button>';
    return '<tr><td>' + escapeHtml(children) + (row.is_group ? '<div class="accounting-table__muted">Група</div>' : "") + '</td><td>' + escapeHtml(row.direction) + '<div class="accounting-table__muted">' + escapeHtml(people) + '</div></td><td>' + row.sessions_used + " / " + row.sessions_total + '</td><td>' + formatDate(row.starts_on) + " — " + formatDate(row.ends_on) + '</td><td>' + status + '</td><td><div class="accounting-row-actions">' + action + '<button type="button" class="anketa-btn anketa-btn--danger" data-delete="' + row.id + '">Видалити</button></div></td></tr>';
  }

  async function createSubscription(event) {
    event.preventDefault(); setStatus("Зберігаємо…");
    const group = $("is-group").checked;
    const childIds = group ? selectedValues("group-children") : [$("regular-child").value];
    const specialistIds = group ? selectedValues("group-specialists") : [$("regular-specialist").value];
    if (childIds.filter(Boolean).length < (group ? 2 : 1) || specialistIds.filter(Boolean).length < 1) { setStatus(group ? "Оберіть щонайменше двох дітей і одного спеціаліста." : "Оберіть дитину та спеціаліста.", true); return; }
    const payload = { sessions_total: Number($("sessions-total").value), direction: $("direction").value, specialist_id: specialistIds[0] || null, starts_on: $("starts-on").value, ends_on: $("ends-on").value, is_group: group, created_by: profile.id };
    const created = await window.sbClient.from("subscriptions").insert(payload).select("id").single();
    if (created.error) { setStatus(created.error.message, true); return; }
    const childRows = childIds.filter(Boolean).map((id) => { const child = anketas.find((item) => item.id === id); return { subscription_id: created.data.id, anketa_id: id, child_name: child ? child.child_full_name : "" }; });
    const specRows = specialistIds.filter(Boolean).map((id) => { const spec = specialists.find((item) => item.id === id); return { subscription_id: created.data.id, specialist_id: id, specialist_name: spec ? (spec.name || "Без імені") : "" }; });
    const [childrenResult, specsResult] = await Promise.all([window.sbClient.from("subscription_children").insert(childRows), window.sbClient.from("subscription_specialists").insert(specRows)]);
    if (childrenResult.error || specsResult.error) { setStatus((childrenResult.error || specsResult.error).message, true); return; }
    setStatus("Абонемент створено."); event.target.reset(); toggleGroupFields(); setDefaultDates(); await refresh();
  }

  const SUBSCRIPTION_DURATION_DAYS = 45;
  function setEndDateFromStart() {
    const startValue = $("starts-on").value;
    if (!startValue) return;
    const end = new Date(startValue + "T00:00:00");
    end.setDate(end.getDate() + SUBSCRIPTION_DURATION_DAYS);
    $("ends-on").value = isoDate(end);
  }
  function setDefaultDates() { $("starts-on").value = isoDate(new Date()); setEndDateFromStart(); }
  function toggleGroupFields() { const group = $("is-group").checked; $("regular-fields").hidden = group; $("group-fields").hidden = !group; $("regular-child").required = !group; $("regular-specialist").required = !group; }

  async function changeFreeze(id, frozen) {
    let days = 14;
    if (frozen) { const input = window.prompt("На скільки днів заморозити абонемент? Від 7 до 21.", "14"); if (input === null) return; days = Math.min(21, Math.max(7, Number(input) || 14)); }
    const row = subscriptions.find((item) => item.id === id); if (!row) return;
    const update = frozen ? { is_frozen: true, frozen_until: isoDate(new Date(Date.now() + days * 86400000)), ends_on: isoDate(new Date(new Date(row.ends_on + "T00:00:00").getTime() + days * 86400000)) } : { is_frozen: false, frozen_until: null };
    const result = await window.sbClient.from("subscriptions").update(update).eq("id", id); if (result.error) window.alert(result.error.message); else await refresh();
  }
  async function deleteSubscription(id) { if (!window.confirm("Видалити абонемент і його статуси відвідування?")) return; const result = await window.sbClient.from("subscriptions").delete().eq("id", id); if (result.error) window.alert(result.error.message); else await refresh(); }
  async function refresh() { try { await Promise.all([loadSubscriptions(), loadAttendance()]); } catch (error) { setStatus(error.message, true); } }

  $("is-group").addEventListener("change", toggleGroupFields); $("starts-on").addEventListener("change", setEndDateFromStart); $("subscription-form").addEventListener("submit", createSubscription); $("refresh-btn").addEventListener("click", refresh); $("subscriptions-body").addEventListener("click", (event) => { const freeze = event.target.closest("[data-freeze]"), unfreeze = event.target.closest("[data-unfreeze]"), remove = event.target.closest("[data-delete]"); if (freeze) changeFreeze(freeze.dataset.freeze, true); if (unfreeze) changeFreeze(unfreeze.dataset.unfreeze, false); if (remove) deleteSubscription(remove.dataset.delete); });
  (async function init() { profile = await window.requireAuth(); if (!profile) return; $("whoami").textContent = (profile.full_name || profile.email) + " · Супер адмін"; if (profile.role !== "super_admin") { $("accounting-denied").hidden = false; return; } $("accounting-content").hidden = false; setDefaultDates(); await loadReferenceData(); await refresh(); })();
})();
