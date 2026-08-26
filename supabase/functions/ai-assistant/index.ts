// Supabase Edge Function: ai-assistant
//
// Backs the "AI помічник" button on admin/anketa.html. Lets an admin /
// super_admin / instructor ask natural-language questions about the saved
// anketas (parent questionnaires) and get an answer from Gemini, grounded
// only in the actual stored data.
//
// ARCHITECTURE: Gemini is given *tools* (function calling), not a dump of
// every anketa up front. It decides what it needs and the function runs a
// real, fresh query against Postgres for it — search by name, a full list
// of who has an anketa, or one field's value across everyone. This avoids
// the earlier design (cramming every anketa into one big prompt), which
// silently dropped older anketas once the total got too large for the
// context-size caps and could miss a specific child entirely.
//
// SECURITY / PRIVACY:
// - This function only ever reads data through a Supabase client bound to
//   the *caller's own* JWT (not service_role), so normal RLS applies —
//   the same "admin/super_admin/instructor can select anketas" policy from
//   schema.sql. No service_role key is used or needed here.
// - The anketas table holds sensitive information about children (medical
//   history, developmental details). Answering a question means sending
//   the relevant slice of that data to Google's Gemini API over HTTPS so
//   it can reason over it — that's inherent to "ask questions about this
//   data in natural language" and is why this runs server-side (so the
//   Gemini API key never reaches the browser) rather than eliminating the
//   call entirely. Make sure this trade-off is acceptable before deploying.
//
// SETUP:
//   supabase functions deploy ai-assistant
//   supabase secrets set GEMINI_API_KEY=<your Gemini API key>
//   (optional) supabase secrets set GEMINI_MODEL=gemini-3.6-flash
//
// Get a Gemini API key at https://aistudio.google.com/apikey

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-3.6-flash";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Short Ukrainian labels for the anketa fields (assets/js/anketa.js has the
// full question text used in the form itself — deliberately shortened here
// since these get repeated in tool output/descriptions).
const FIELD_LABELS: Record<string, string> = {
  child_full_name: "ПІБ дитини",
  child_birth_date: "Дата народження",
  parent_name: "Ім'я батька/матері",
  parent_phone: "Телефон батьків",
  respondent_email: "Email відправника анкети",
  comm_language: "Мова спілкування",
  attends_school: "Відвідує садок/школу",
  diagnoses: "Діагнози",
  medical_precautions: "Медичні застереження",
  medications: "Ліки",
  vision: "Зір",
  hearing: "Слух",
  strengths: "Сильні сторони",
  concerns: "Що турбує батьків",
  goals_6m: "Цілі на 6 місяців",
  pregnancy_infections: "Інфекції під час вагітності",
  pregnancy_infections_desc: "Деталі інфекцій під час вагітності",
  birth_complications: "Ускладнення під час пологів",
  birth_complications_desc: "Деталі ускладнень під час пологів",
  full_term: "Доношеність",
  rollover_age: "Вік: перевертання",
  walk_age: "Вік: ходьба",
  cup_age: "Вік: чашка самостійно",
  words_age: "Вік: перші слова",
  sentences_age: "Вік: речення",
  crawl_age: "Вік: повзання",
  sit_age: "Вік: сидіння",
  solid_food_age: "Вік: тверда їжа",
  birth_weight: "Вага при народженні",
  sleep_problems: "Проблеми зі сном",
  sleep_problems_desc: "Деталі проблем зі сном",
  toilet_problems: "Проблеми з туалетом",
  toilet_problems_desc: "Деталі проблем з туалетом",
  eating_problems: "Проблеми з харчуванням",
  eating_problems_desc: "Деталі проблем з харчуванням",
  dressing_problems: "Проблеми з одяганням",
  dressing_problems_desc: "Деталі проблем з одяганням",
  hygiene_problems: "Проблеми з гігієною",
  hygiene_problems_desc: "Деталі проблем з гігієною",
  social_concerns: "Соціальні навички — складнощі",
  play_concerns: "Ігрові навички — складнощі",
  gadget_time: "Час з гаджетом",
  follows_instructions: "Виконання інструкцій",
  completes_tasks: "Завершення завдань",
  attention_span: "Утримання уваги",
  hyperactivity: "Рухова активність",
  organizing_ability: "Організація роботи",
  memory_problems: "Проблеми з пам'яттю",
  other_problems: "Інші проблеми",
  additional_info: "Додаткова інформація",
  main_request: "Основний запит до спеціаліста",
  form_fill_date: "Дата заповнення анкети",
};

const MAX_FIELD_CHARS = 400;
const MAX_HISTORY_TURNS = 8;
const MAX_TOOL_ITERATIONS = 6; // hard cap so a confused model can't loop forever
const MAX_SEARCH_RESULTS = 15;
const MAX_ROWS_PER_SCAN = 2000; // covers this project's realistic scale comfortably

type AnketaRow = {
  id?: string;
  child_full_name: string;
  parent_name: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function formatAnketaBlock(row: AnketaRow): string {
  const data = row.data || {};
  const date = new Date(row.created_at).toLocaleDateString("uk-UA");
  const lines = [`--- Анкета: ${row.child_full_name || "(без імені)"} (додано ${date}) ---`];
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    const raw = data[key];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (!value) continue;
    lines.push(`${label}: ${truncate(value, MAX_FIELD_CHARS)}`);
  }
  return lines.join("\n");
}

// ---------- Tool implementations (each runs a fresh query — nothing cached) ----------

async function searchAnketas(client: SupabaseClient, query: string): Promise<string> {
  const q = query.trim();
  if (!q) return "Помилка: порожній запит для пошуку.";
  const pattern = `%${q}%`;

  const [byChild, byParent] = await Promise.all([
    client.from("anketas").select("id, child_full_name, parent_name, data, created_at")
      .ilike("child_full_name", pattern).limit(MAX_SEARCH_RESULTS),
    client.from("anketas").select("id, child_full_name, parent_name, data, created_at")
      .ilike("parent_name", pattern).limit(MAX_SEARCH_RESULTS),
  ]);

  if (byChild.error) return "Помилка пошуку: " + byChild.error.message;
  if (byParent.error) return "Помилка пошуку: " + byParent.error.message;

  const byId = new Map<string, AnketaRow>();
  for (const r of [...(byChild.data || []), ...(byParent.data || [])]) {
    byId.set(r.id, r as AnketaRow);
  }
  const rows = Array.from(byId.values()).slice(0, MAX_SEARCH_RESULTS);

  if (!rows.length) {
    return `Нічого не знайдено за запитом "${q}". Спробуй get_anketas_overview, щоб перевірити точне написання імені.`;
  }
  return rows.map(formatAnketaBlock).join("\n\n");
}

async function getAnketasOverview(client: SupabaseClient): Promise<string> {
  const { data, error } = await client
    .from("anketas")
    .select("child_full_name, parent_name, created_at")
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS_PER_SCAN);

  if (error) return "Помилка завантаження переліку: " + error.message;
  if (!data || !data.length) return "Анкет у базі ще немає.";

  const lines = data.map((r) =>
    `${r.child_full_name || "(без імені)"} — батько/мати: ${r.parent_name || "—"} (додано ${new Date(r.created_at).toLocaleDateString("uk-UA")})`
  );
  return `Усього анкет: ${data.length}${data.length >= MAX_ROWS_PER_SCAN ? "+" : ""}\n` + lines.join("\n");
}

async function getFieldValues(client: SupabaseClient, field: string): Promise<string> {
  if (!(field in FIELD_LABELS)) {
    return `Помилка: невідоме поле "${field}". Доступні поля: ${Object.keys(FIELD_LABELS).join(", ")}.`;
  }
  const { data, error } = await client
    .from("anketas")
    .select("child_full_name, data, created_at")
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS_PER_SCAN);

  if (error) return "Помилка завантаження даних: " + error.message;

  const lines: string[] = [];
  for (const r of data || []) {
    const raw = (r.data || {})[field];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (!value) continue;
    lines.push(`${r.child_full_name || "(без імені)"}: ${truncate(value, 300)}`);
  }
  if (!lines.length) return `Жодна анкета не має заповненого поля "${FIELD_LABELS[field]}".`;
  return `Поле "${FIELD_LABELS[field]}" (${lines.length} анкет із заповненим значенням):\n` + lines.join("\n");
}

// ---------- Gemini tool declarations ----------

const TOOLS = [{
  functionDeclarations: [
    {
      name: "search_anketas",
      description:
        "Знайти анкету(и) за іменем дитини або одного з батьків (пошук за частиною імені, регістр не важливий). " +
        "Повертає повні дані знайдених анкет. Використовуй це першим, коли питання стосується конкретної дитини.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "Ім'я або частина імені дитини чи батька/матері для пошуку" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_anketas_overview",
      description:
        "Отримати повний перелік усіх дітей, на яких є анкета (ім'я дитини, ім'я батьків, дата додавання). " +
        "Використовуй, якщо search_anketas нічого не знайшов (можливо, ім'я записано інакше — перевір написання за цим списком), " +
        "а також для запитань типу «скільки всього анкет» або «перелічи дітей».",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "get_field_values",
      description:
        "Отримати значення ОДНОГО конкретного поля анкети для ВСІХ дітей одразу — використовуй для " +
        "статистичних/групових запитань (наприклад «у яких дітей є проблеми зі сном» → field=\"sleep_problems\", " +
        "«кому не перевіряли зір» → field=\"vision\"). Доступні поля (ключ — назва): " +
        Object.entries(FIELD_LABELS).map(([k, l]) => `${k} (${l})`).join(", "),
      parameters: {
        type: "OBJECT",
        properties: {
          field: { type: "STRING", description: "Ключ поля анкети, наприклад sleep_problems" },
        },
        required: ["field"],
      },
    },
  ],
}];

async function runTool(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    if (name === "search_anketas") return await searchAnketas(client, String(args.query ?? ""));
    if (name === "get_anketas_overview") return await getAnketasOverview(client);
    if (name === "get_field_values") return await getFieldValues(client, String(args.field ?? ""));
    return `Невідома функція: ${name}`;
  } catch (e) {
    return "Помилка виконання функції: " + String(e);
  }
}

// ---------- Gemini call ----------

type GeminiPart = { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; functionResponse?: { name: string; response: Record<string, unknown> } };
type GeminiContent = { role: string; parts: GeminiPart[] };

async function callGemini(systemInstruction: string, contents: GeminiContent[]): Promise<{ ok: true; candidate: { content?: GeminiContent; finishReason?: string } } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents,
          tools: TOOLS,
          generationConfig: { temperature: 0.2, maxOutputTokens: 1536 },
        }),
      },
    );
  } catch (e) {
    return { ok: false, error: "Не вдалося звʼязатися з Gemini API: " + String(e) };
  }

  if (!res.ok) {
    let message = `Gemini API повернув помилку (${res.status})`;
    try {
      const errBody = await res.json();
      if (errBody?.error?.message) message += ": " + errBody.error.message;
    } catch { /* ignore unparsable error body */ }
    return { ok: false, error: message };
  }

  const resJson = await res.json();
  const candidate = resJson?.candidates?.[0];
  if (!candidate) {
    const blockReason = resJson?.promptFeedback?.blockReason;
    return { ok: false, error: "Gemini не повернув відповіді" + (blockReason ? ` (${blockReason})` : "") };
  }
  return { ok: true, candidate };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!GEMINI_API_KEY) {
    return json({ error: "AI помічник не налаштований: відсутній секрет GEMINI_API_KEY на сервері." }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing authorization" }, 401);
  }

  // Bound to the caller's own JWT — both for verifying who's asking and
  // for reading anketas, so normal RLS decides what they can see.
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userError } = await callerClient.auth.getUser();
  if (userError || !user) {
    return json({ error: "Not authenticated" }, 401);
  }

  const { data: callerProfile, error: profileError } = await callerClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const allowedRoles = ["admin", "super_admin", "instructor"];
  if (profileError || !callerProfile || !allowedRoles.includes(callerProfile.role)) {
    return json({ error: "Forbidden" }, 403);
  }

  let body: { question?: string; history?: { role?: string; text?: string }[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const question = (body.question || "").trim();
  if (!question) {
    return json({ error: "question is required" }, 400);
  }
  if (question.length > 2000) {
    return json({ error: "Питання занадто довге." }, 400);
  }

  const systemInstruction = `# SYSTEM INSTRUCTIONS: AI CONSULTANT FOR CHILDREN'S REHABILITATION CENTER

## 1. System Role & Context
You are an AI Assistant integrated into the Center for Sensory Integration administrative panel and a personal scientific consulting assistant. Your expertise strictly covers:
* Sensory Integration
* Applied Behavior Analysis (ABA)
* Speech Therapy (Logopedics)
* Child Psychology

Your focus is exclusively on evidence-based medicine, peer-reviewed scientific approaches, and modern rehabilitation methodologies for children with complex developmental needs (e.g., ASD, ADHD, Cerebral Palsy).

---

## 2. Mandatory Rules & Operational Constraints

### Factuality & Data Sources
* **Strict Evidence Basis:** Rely ONLY on real facts retrieved from system functions and validated evidence-based medical methods.
* **No Speculation:** NEVER invent, hallucinate, or assume facts about children or clinical methods. If information is missing from the database, explicitly state that it is unavailable.
* **Domain Lock:** Respond ONLY to queries related to complex child rehabilitation, sensory integration, ABA therapy, and logopedics. Reject non-relevant topics.

### Database Access & Function Calling Protocol
You do NOT have direct access to parent questionnaires or medical records. You must query the database dynamically via functions (\`search_anketas\`, \`get_anketas_overview\`, \`get_field_values\`).
* **Triggering Rules:** Before analyzing any child's profile or responding to questions about a specific child, ALWAYS execute a function call first.
* **Search Fallback:** If \`search_anketas\` returns no results by the child's name, call \`get_anketas_overview\` to verify alternative name spellings or word order (e.g., Last Name First).
* **Data Sensitivity:** Always specify the child's full name in outputs. Maintain an ethical, highly professional tone when handling sensitive medical and personal data.

### Language & Communication Style
* **Response Language:** Always respond to the user strictly in **Ukrainian**.
* **Tone:** Professional, evidence-based, yet explaining complex neurological/psychiatric mechanisms in clear, accessible language.

---

## 3. Workflow & Specialization Handling

### Specialization Options
Tailor all analytical insights, lesson structures, and clinical recommendations to the chosen specialization:
1. **Сенсорна інтеграція** (Sensory Integration Specialist)
2. **АВА-терапія** (ABA Specialist)
3. **Логопедія** (Speech Therapist / Logopedist)
4. **Загальні рекомендації** (Multi-disciplinary Overview for all specialists)

### Session & Questionnaire Analysis Protocol
* **Questionnaire Analysis:** When requested to analyze a child's questionnaire, fetch data via functions, analyze the profile, and output recommendations formatted specifically for the selected specialization (or option 4).
* **Lesson Planning Structure:** Structure lesson plans using the standard sequence:
  1. Initial acquaintance (for new clients).
  2. Assessment of current physical and emotional state.
  3. Individualized evidence-based activities targeted at the child's sensory, behavioral, and speech profile.
* **Recommendation Format:** Provide actionable advice for parents or allied specialists strictly as concise bullet points or practical checklists.
* **Templates:** Output full intake questionnaire templates ONLY upon explicit user request.

---

## 4. Initial Activation Message

Upon session initialization, display **STRICTLY** the following formatted text in Ukrainian and do not repeat it later in the conversation:

> Вітаю! Я готовий працювати як ваш науковий асистент-консультант на основі методів доказової медицини.
>
> Будь ласка, оберіть вашу спеціалізацію для налаштування аналізу та рекомендацій:
> * **1. Сенсорна інтеграція**
> * **2. АВА-терапія**
> * **3. Логопедія**
> * **4. Загальні рекомендації** (комплексний огляд для всіх фахівців)
>
> Вкажіть номер спеціалізації та ПІБ дитини (або ваше запитання), щоб ми розпочали роботу.`;

  const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY_TURNS) : [];
  const contents: GeminiContent[] = [
    ...history
      .filter((h) => h && typeof h.text === "string" && h.text.trim())
      .map((h) => ({
        role: h!.role === "model" ? "model" : "user",
        parts: [{ text: truncate(h!.text!.trim(), 4000) }],
      })),
    { role: "user", parts: [{ text: question }] },
  ];

  let finalAnswer: string | null = null;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const result = await callGemini(systemInstruction, contents);
    if (!result.ok) return json({ error: result.error }, 502);

    const parts = result.candidate.content?.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall);

    if (!functionCalls.length) {
      finalAnswer = parts.map((p) => p.text || "").join("");
      break;
    }

    // Echo the model's own function-call turn back, then answer each call.
    contents.push({ role: "model", parts });

    const responseParts: GeminiPart[] = [];
    for (const fc of functionCalls) {
      const name = fc.functionCall!.name;
      const args = fc.functionCall!.args || {};
      const toolResult = await runTool(callerClient, name, args);
      responseParts.push({ functionResponse: { name, response: { result: toolResult } } });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  if (!finalAnswer) {
    return json({ error: "Не вдалося отримати відповідь — забагато кроків пошуку. Спробуй сформулювати запитання конкретніше." }, 502);
  }

  return json({ answer: finalAnswer });
});
