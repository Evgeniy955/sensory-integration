// Parent questionnaire ("Анкета для батьків") — field definitions + rendering + submit.
// Field labels/options are taken verbatim from the source Google Form export
// ("Анкета для батьків (Ответы) - Ответы на форму.csv"). Do not reword them
// without an explicit request — the wording is what parents already fill in.
//
// Backend note: this is a client-side draft (per current project stage).
// The submit handler validates + collects the answers and shows a success
// state; wiring it to a Supabase table is a follow-up task.

(function () {
  const YES_NO = ["Так", "Ні"];
  const YES_NO_RARE = ["Так", "Ні", "Рідко"];
  const YES_NO_UNSURE = ["Так", "Ні", "Не знаю"];
  const GADGET_TIME = ["Не використовує", "1-2 години", "3-6 годин", "7-10 годин"];

  // Each section groups questions the way they appear in the original form.
  window.ANKETA_SECTIONS = [
    {
      title: "Дані про дитину та батьків",
      icon: "family",
      fields: [
        { name: "child_full_name", label: "ПІБ дитини", type: "text", required: true },
        { name: "child_birth_date", label: "Дата народження дитини", type: "date" },
        { name: "parent_name", label: "Ім'я одного з батьків (опікунів)", type: "text" },
        { name: "parent_phone", label: "Контактний телефон батьків", type: "tel" },
        { name: "comm_language", label: "Мова спілкування з дитиною (переважно)", type: "text" },
        { name: "attends_school", label: "Чи відвідує Ваша дитина дитячий садок або школу?", type: "radio", options: YES_NO },
      ],
    },
    {
      title: "Медична інформація",
      icon: "medical",
      fields: [
        { name: "diagnoses", label: "Чи є у Вашої дитини медичні / психіатричні діагнози (вкажіть)", type: "textarea" },
        {
          name: "medical_precautions",
          label: "Медична інформація. ВАЖЛИВО! Якщо у Вашої дитини захворювання, яке може вимагати негайного чи невідкладного догляду та лікування (судоми, алергія, поведінкові проблеми та інше) вкажіть цю інформацію. Чи є якісь міри обережності, про які ми повинні знати?",
          type: "textarea",
        },
        { name: "medications", label: "Чи приймає Ваша дитина лікарські засоби? Якщо так, вкажіть які саме:", type: "textarea" },
        { name: "vision", label: "Чи перевіряли у Вашої дитини зір? Якщо так, коли та які були результати?", type: "textarea" },
        { name: "hearing", label: "Чи перевіряли у Вашої дитини слух? Якщо так, коли та які були результати?", type: "textarea" },
      ],
    },
    {
      title: "Про дитину загалом",
      icon: "star",
      fields: [
        { name: "strengths", label: "Які сильні сторони Вашої дитини і його особливі таланти?", type: "textarea" },
        { name: "concerns", label: "Що хвилює найбільше Вас у Вашій дитині?", type: "textarea" },
        { name: "goals_6m", label: "Яких навичок Ви б хотіли, щоб набула Ваша дитина в наступні 6 місяців?", type: "textarea" },
      ],
    },
    {
      title: "Вагітність та пологи",
      icon: "moon",
      fields: [
        { name: "pregnancy_infections", label: "Чи були якісь інфекції, захворювання, сильні стреси під час вагітності?", type: "radio", options: YES_NO },
        { name: "pregnancy_infections_desc", label: "Якщо були якісь інфекції, захворювання, сильні стреси під час вагітності опишіть їх", type: "textarea" },
        { name: "birth_complications", label: "Чи були якісь ускладнення під час пологів?", type: "radio", options: YES_NO },
        { name: "birth_complications_desc", label: "Якщо були якісь ускладнення під час пологів опишіть їх", type: "textarea" },
        { name: "full_term", label: "Чи була дитина доношена? Якщо ні — вкажіть скільки тижнів вагітності", type: "text" },
      ],
    },
    {
      title: "Етапи розвитку",
      icon: "rocket",
      fields: [
        { name: "rollover_age", label: "Коли Ваша дитина почала перевертатися?", type: "text" },
        { name: "walk_age", label: "Коли Ваша дитина почала ходити?", type: "text" },
        { name: "cup_age", label: "Коли Ваша дитина почала пити з чашки самостійно?", type: "text" },
        { name: "words_age", label: "Коли Ваша дитина почала говорити слова?", type: "text" },
        { name: "sentences_age", label: "Коли Ваша дитина почала говорити речення?", type: "text" },
        { name: "crawl_age", label: "Коли Ваша дитина почала повзати?", type: "text" },
        { name: "sit_age", label: "Коли Ваша дитина почала сидіти?", type: "text" },
        { name: "solid_food_age", label: "Коли Ваша дитина почала їсти звичайну їжу?", type: "text" },
        { name: "birth_weight", label: "Вага дитини при народженні", type: "text" },
      ],
    },
    {
      title: "Побутові навички",
      icon: "home",
      fields: [
        { name: "sleep_problems", label: "Чи є проблеми зі сном?", type: "radio", options: YES_NO_RARE },
        { name: "sleep_problems_desc", label: "Якщо є проблеми зі сном — опишіть", type: "textarea" },
        { name: "toilet_problems", label: "Чи є проблеми з туалетом?", type: "radio", options: YES_NO },
        { name: "toilet_problems_desc", label: "Якщо є проблеми з туалетом опишіть які саме", type: "textarea" },
        { name: "eating_problems", label: "Чи є проблеми з прийомом їжі, харчуванням?", type: "radio", options: YES_NO_RARE },
        { name: "eating_problems_desc", label: "Якщо є проблеми з прийомом їжі, харчуванням опишіть", type: "textarea" },
        { name: "dressing_problems", label: "Чи є проблема з одяганням / роздяганням / взуванням?", type: "radio", options: YES_NO_RARE },
        { name: "dressing_problems_desc", label: "Якщо є проблема з одяганням / роздяганням / взуванням опишіть", type: "textarea" },
        { name: "hygiene_problems", label: "Чи є проблема з виконанням гігієнічних задач?", type: "radio", options: YES_NO_RARE },
        { name: "hygiene_problems_desc", label: "Якщо є проблема з виконанням гігієнічних задач опишіть", type: "textarea" },
      ],
    },
    {
      title: "Соціальні та ігрові навички",
      icon: "orbit",
      fields: [
        { name: "social_concerns", label: "Чи хвилюєтесь Ви з приводу соціальних навичок Вашої дитини? Опишіть, які є складнощі", type: "textarea" },
        { name: "play_concerns", label: "Чи хвилюєтесь Ви з приводу ігрових навичок Вашої дитини? Опишіть, які є складнощі", type: "textarea" },
        { name: "gadget_time", label: "Скільки часу в день Ваша дитина в середньому проводить з гаджетом?", type: "select", options: GADGET_TIME },
      ],
    },
    {
      title: "Увага та поведінка",
      icon: "compass",
      fields: [
        { name: "follows_instructions", label: "Чи є проблеми у дитини з виконанням інструкцій?", type: "radio", options: YES_NO_UNSURE },
        { name: "completes_tasks", label: "Чи є проблеми у дитини з завершенням задачі / вимоги?", type: "radio", options: YES_NO_UNSURE },
        { name: "attention_span", label: "Чи є проблеми у дитини з утриманням уваги?", type: "radio", options: YES_NO_UNSURE },
        { name: "hyperactivity", label: "Чи є проблеми у дитини з надмірною руховою активністю?", type: "radio", options: YES_NO_UNSURE },
        { name: "organizing_ability", label: "Чи є проблеми у дитини зі здатністю організувати свою роботу?", type: "radio", options: YES_NO_UNSURE },
        { name: "memory_problems", label: "Чи є проблеми у дитини з пам'яттю?", type: "radio", options: YES_NO_UNSURE },
        { name: "other_problems", label: "Інші проблеми. Опишіть", type: "textarea" },
      ],
    },
    {
      title: "Додатково",
      icon: "note",
      fields: [
        { name: "additional_info", label: "Що Ви хотіли б розказати ще про свою дитину?", type: "textarea" },
        { name: "main_request", label: "Опишіть основний запит до спеціаліста?", type: "textarea" },
        { name: "form_fill_date", label: "Дата заповнення анкети", type: "date" },
      ],
    },
  ];

  // Small line-icon set for the section badges (24x24, stroke currentColor).
  // Purely decorative — kept minimal/consistent so new icons are easy to add.
  const ICONS = {
    family: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="3"/><circle cx="17" cy="8.5" r="2.3"/><path d="M3.5 20c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5"/><path d="M14.8 14.9c2.4.3 4.2 2.2 4.2 5.1"/></svg>',
    medical: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.35-9.5-8.8C.7 8.6 2.4 5 6 5c2 0 3.3 1.1 4 2.2C10.7 6.1 12 5 14 5c3.6 0 5.3 3.6 3.5 7.2C19 16.65 12 21 12 21Z"/><path d="M9 12h2l1-2 2 4 1-2h1"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.4 5.9 6.1.5-4.6 4.1 1.5 6-5.4-3.4L6.6 19.5l1.5-6-4.6-4.1 6.1-.5L12 3Z"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.2A8.5 8.5 0 1 1 9.8 4a7 7 0 0 0 10.2 10.2Z"/></svg>',
    rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5c2.8 1.8 4.5 5 4.5 8.7 0 1.7-.4 3.2-1 4.3l-3.5 3-3.5-3c-.6-1.1-1-2.6-1-4.3 0-3.7 1.7-6.9 4.5-8.7Z"/><circle cx="12" cy="10.5" r="1.6"/><path d="M9 16.5 6.5 19M15 16.5 17.5 19M10 20.5h4"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9.5h12V10"/><path d="M10 19.5v-5h4v5"/></svg>',
    orbit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.3"/><ellipse cx="12" cy="12" rx="9.5" ry="4.2"/><ellipse cx="12" cy="12" rx="4.2" ry="9.5" transform="rotate(35 12 12)"/></svg>',
    compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5 13.4 13.4 8.5 15.5 10.6 10.6 15.5 8.5Z"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h8l3 3v14H7z"/><path d="M15 3.5v3h3M9.5 12h5M9.5 15.5h5"/></svg>',
  };

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function renderField(f) {
    const reqAttr = f.required ? " required" : "";
    const reqMark = f.required ? ' <span class="anketa-req">*</span>' : "";
    let control = "";

    if (f.type === "textarea") {
      control = `<textarea id="${f.name}" name="${f.name}" rows="3" autocomplete="off"${reqAttr}></textarea>`;
    } else if (f.type === "select") {
      const opts = f.options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
      control = `<select id="${f.name}" name="${f.name}" autocomplete="off"${reqAttr}><option value="">— оберіть —</option>${opts}</select>`;
    } else if (f.type === "radio") {
      control = `<div class="anketa-radio-group" role="radiogroup" aria-label="${escapeHtml(f.label)}">` +
        f.options.map((o, i) => {
          const id = `${f.name}_${i}`;
          return `<label class="anketa-radio" for="${id}">` +
            `<input type="radio" id="${id}" name="${f.name}" value="${escapeHtml(o)}" autocomplete="off"${reqAttr}>` +
            `<span>${escapeHtml(o)}</span></label>`;
        }).join("") + `</div>`;
    } else {
      const type = f.type === "date" ? "date" : f.type === "tel" ? "tel" : "text";
      control = `<input type="${type}" id="${f.name}" name="${f.name}" autocomplete="off"${reqAttr}>`;
    }

    const labelTag = f.type === "radio"
      ? `<span class="anketa-field__label" id="${f.name}_label">${escapeHtml(f.label)}${reqMark}</span>`
      : `<label class="anketa-field__label" for="${f.name}">${escapeHtml(f.label)}${reqMark}</label>`;

    return `<div class="anketa-field" data-type="${f.type}">${labelTag}${control}</div>`;
  }

  window.renderAnketaForm = function (mountEl) {
    const total = window.ANKETA_SECTIONS.length;
    const html = window.ANKETA_SECTIONS.map((section, idx) => {
      return `
        <fieldset class="anketa-section">
          <legend class="anketa-section__title">
            <span class="anketa-section__icon">${ICONS[section.icon] || ""}</span>
            <span class="anketa-section__text">
              <span class="anketa-section__step">Крок ${idx + 1} з ${total}</span>
              <span class="anketa-section__name">${escapeHtml(section.title)}</span>
            </span>
          </legend>
          <div class="anketa-field-grid">
            ${section.fields.map(renderField).join("")}
          </div>
        </fieldset>`;
    }).join("");

    mountEl.innerHTML = html;
  };

  // A native <input type="date"> silently ignores (resets to blank) any
  // value that isn't exactly YYYY-MM-DD — so a date stored in another
  // format (e.g. a CSV import from the old Google Form, "05.03.2020")
  // would look fine in the read-only view (plain text there) but come up
  // empty the moment that same anketa is opened for editing. Converts the
  // common alternate day-first formats; anything else is left as-is
  // (unparseable strings are rare and better surfaced than silently
  // dropped by a "fix" that guesses wrong).
  function toDateInputValue(raw) {
    const s = String(raw || "").trim();
    if (!s || /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/.exec(s);
    if (!m) return s;
    return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
  }

  // Fills a form already rendered by renderAnketaForm with existing
  // answers — the reverse of collectAnketaData, used by the "Редагувати"
  // flow to prefill a previously saved anketa. Missing/unknown fields are
  // left as-is (untouched, empty) rather than throwing.
  window.fillAnketaForm = function (formEl, data) {
    if (!data) return;
    window.ANKETA_SECTIONS.forEach((section) => {
      section.fields.forEach((f) => {
        const value = data[f.name];
        if (value === undefined || value === null) return;
        if (f.type === "radio") {
          formEl.querySelectorAll(`input[name="${f.name}"]`).forEach((input) => {
            input.checked = input.value === value;
          });
        } else {
          const el = formEl.querySelector(`[name="${f.name}"]`);
          if (el) el.value = f.type === "date" ? toDateInputValue(value) : value;
        }
      });
    });
  };

  // Collects all answers from the rendered form into a plain object.
  window.collectAnketaData = function (formEl) {
    const data = {};
    window.ANKETA_SECTIONS.forEach((section) => {
      section.fields.forEach((f) => {
        if (f.type === "radio") {
          const checked = formEl.querySelector(`input[name="${f.name}"]:checked`);
          data[f.name] = checked ? checked.value : "";
        } else {
          const el = formEl.querySelector(`[name="${f.name}"]`);
          data[f.name] = el ? el.value : "";
        }
      });
    });
    return data;
  };
})();
