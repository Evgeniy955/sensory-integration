// Supabase Edge Function: ai-assistant
//
// Backs the "AI помічник" button on admin/anketa.html. Lets an admin /
// super_admin / instructor ask natural-language questions about the saved
// anketas (parent questionnaires) and get an answer from Gemini, grounded
// only in the actual stored data.
//
// SECURITY / PRIVACY:
// - This function only ever reads data through a Supabase client bound to
//   the *caller's own* JWT (not service_role), so normal RLS applies —
//   the same "admin/super_admin/instructor can select anketas" policy from
//   schema.sql. No service_role key is used or needed here.
// - The anketas table holds sensitive information about children (medical
//   history, developmental details). Building the answer means sending a
//   compact summary of that data to Google's Gemini API over HTTPS so it
//   can reason over it — that's inherent to "ask questions about this data
//   in natural language" and is why this runs server-side (so the Gemini
//   API key never reaches the browser) rather than eliminating the call
//   entirely. Make sure this trade-off is acceptable before deploying.
//
// SETUP:
//   supabase functions deploy ai-assistant
//   supabase secrets set GEMINI_API_KEY=<your Gemini API key>
//   (optional) supabase secrets set GEMINI_MODEL=gemini-3.6-flash
//
// Get a Gemini API key at https://aistudio.google.com/apikey

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
// since this map gets repeated once per stored anketa, and the full
// question sentences would multiply the size of every request to Gemini.
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

// Per-field cap so one very long free-text answer can't blow up the whole
// request; per-anketa and total caps below so the overall prompt sent to
// Gemini stays bounded even with a large number of stored anketas.
const MAX_FIELD_CHARS = 400;
const MAX_ANKETAS_IN_CONTEXT = 300;
const MAX_CONTEXT_CHARS = 120_000;
const MAX_HISTORY_TURNS = 8;

type AnketaRow = {
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

function buildContext(rows: AnketaRow[]): { text: string; includedCount: number; totalCount: number } {
  const limited = rows.slice(0, MAX_ANKETAS_IN_CONTEXT);
  const blocks: string[] = [];
  let total = 0;
  for (const row of limited) {
    const block = formatAnketaBlock(row);
    if (total + block.length > MAX_CONTEXT_CHARS) break;
    blocks.push(block);
    total += block.length;
  }
  return { text: blocks.join("\n\n"), includedCount: blocks.length, totalCount: rows.length };
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

  const { data: anketas, error: anketasError } = await callerClient
    .from("anketas")
    .select("child_full_name, parent_name, data, created_at")
    .order("created_at", { ascending: false });

  if (anketasError) {
    return json({ error: "Не вдалося завантажити анкети: " + anketasError.message }, 500);
  }

  const { text: contextText, includedCount, totalCount } = buildContext((anketas as AnketaRow[]) || []);

  const truncationNote = includedCount < totalCount
    ? `\n\n(Показано ${includedCount} з ${totalCount} анкет — найновіші; решта не увійшли через обмеження розміру запиту.)`
    : "";

  const systemInstruction =
    "Ти — AI-помічник адміністративної панелі Центру сенсорної інтеграції. " +
    "Тобі надано дані анкет батьків, заповнених перед першим заняттям дитини. " +
    "Відповідай адміністратору українською мовою, стисло і по суті, спираючись ТІЛЬКИ на надані дані нижче. " +
    "Якщо потрібної інформації в даних немає — прямо скажи, що не знайшов її, і не вигадуй фактів. " +
    "Коли йдеться про конкретну дитину — вказуй її ПІБ. " +
    "Це чутлива інформація про дітей (зокрема медична) — тримайся коректного, професійного тону.\n\n" +
    "Дані анкет:\n" + (contextText || "(анкет ще немає)") + truncationNote;

  const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY_TURNS) : [];
  const contents = [
    ...history
      .filter((h) => h && typeof h.text === "string" && h.text.trim())
      .map((h) => ({
        role: h.role === "model" ? "model" : "user",
        parts: [{ text: truncate(h.text!.trim(), 4000) }],
      })),
    { role: "user", parts: [{ text: question }] },
  ];

  let geminiRes: Response;
  try {
    geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents,
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
        }),
      },
    );
  } catch (e) {
    return json({ error: "Не вдалося звʼязатися з Gemini API: " + String(e) }, 502);
  }

  if (!geminiRes.ok) {
    let message = `Gemini API повернув помилку (${geminiRes.status})`;
    try {
      const errBody = await geminiRes.json();
      if (errBody?.error?.message) message += ": " + errBody.error.message;
    } catch { /* ignore unparsable error body */ }
    return json({ error: message }, 502);
  }

  const geminiJson = await geminiRes.json();
  const answer = geminiJson?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("") ?? "";

  if (!answer) {
    const blockReason = geminiJson?.candidates?.[0]?.finishReason;
    return json({ error: "Gemini не повернув відповіді" + (blockReason ? ` (${blockReason})` : "") }, 502);
  }

  return json({ answer, meta: { includedAnketas: includedCount, totalAnketas: totalCount } });
});
