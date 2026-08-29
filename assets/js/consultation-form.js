// Wires up the public "Записатися на консультацію" form (index.html,
// #cta section) to the submit-consultation-request Edge Function. Plain
// fetch() — no supabase-js SDK needed for a single POST, just the project
// URL + anon key from supabase-config.js (loaded right before this file).
//
// The anon key is sent as both `apikey` and `Authorization: Bearer` — that's
// what satisfies Supabase's platform-level gateway check for Edge Functions
// (it accepts any valid JWT, and the anon key is one); the function itself
// doesn't require or check any auth beyond that, since anyone visiting the
// site is a legitimate caller here.
(function () {
  const form = document.getElementById("consultation-form");
  if (!form) return;

  const cfg = window.SUPABASE_CONFIG || {};
  const statusEl = document.getElementById("consultation-form-status");
  const submitBtn = form.querySelector('button[type="submit"]');

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = "form-status" + (kind ? " form-status--" + kind : "");
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();

    if (!cfg.url || !cfg.anonKey) {
      setStatus("Форма тимчасово недоступна. Зателефонуйте нам напряму.", "err");
      return;
    }

    const name = (form.elements["name"].value || "").trim();
    const phone = (form.elements["phone"].value || "").trim();
    const childAge = (form.elements["age"].value || "").trim();
    const website = (form.elements["website"].value || "").trim(); // honeypot

    if (!name || !phone) {
      setStatus("Вкажіть ім'я та телефон.", "err");
      return;
    }

    submitBtn.disabled = true;
    setStatus("Надсилаємо…", null);

    try {
      const res = await fetch(cfg.url.replace(/\/$/, "") + "/functions/v1/submit-consultation-request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": cfg.anonKey,
          "Authorization": "Bearer " + cfg.anonKey,
        },
        body: JSON.stringify({ name: name, phone: phone, child_age: childAge, website: website }),
      });

      let data = null;
      try { data = await res.json(); } catch (e2) { /* non-JSON error body, ignore */ }

      if (!res.ok || !data || !data.success) {
        setStatus((data && data.error) || "Не вдалося надіслати заявку. Спробуйте пізніше або зателефонуйте нам.", "err");
        submitBtn.disabled = false;
        return;
      }

      setStatus("Дякуємо! Зателефонуємо протягом дня.", "ok");
      form.reset();
      submitBtn.disabled = false;
    } catch (err) {
      setStatus("Не вдалося надіслати заявку — перевірте інтернет-з'єднання.", "err");
      submitBtn.disabled = false;
    }
  });
})();
