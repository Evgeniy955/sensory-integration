// Supabase Edge Function: submit-consultation-request
//
// Backs the public "Записатися на консультацію" form on index.html
// (section #cta). Anonymous site visitors — there's no signed-in user at
// this point — so this is the ONLY way a row ever gets into
// public.consultation_requests: the table itself has no anon insert
// policy (see supabase/schema.sql, section 10), specifically so nobody can
// write junk directly to it and skip the validation/honeypot check below.
//
// On a valid submission this does two things:
// 1. Saves the request in Supabase (so it shows up in the admin panel's
//    notification badge / consultation-requests.html even if step 2 below
//    fails for any reason — a lead should never be lost just because an
//    email didn't go out).
// 2. Emails a notification via Resend (https://resend.com) — a paid
//    Telegram-style push wasn't wanted; Resend's free tier (~3k/month) is
//    plenty for this volume, and the sender address is a fixed string
//    (see FROM_ADDRESS below) since there's no verified custom domain yet.
//
// SETUP:
//   supabase functions deploy submit-consultation-request
//   supabase secrets set RESEND_API_KEY=<your Resend API key>
//   (optional) supabase secrets set NOTIFY_EMAIL=<where requests should land>
//
// Get a Resend API key at https://resend.com/api-keys (no domain needed —
// the default onboarding@resend.dev sender works immediately).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const NOTIFY_EMAIL = Deno.env.get("NOTIFY_EMAIL") || "vladelis2026@gmail.com";

// Static on purpose (per request) — always the same sender regardless of
// who's calling or what domain the site is on. onboarding@resend.dev works
// out of the box with no domain verification; swap this for a verified
// "from" address later if a custom domain gets set up in Resend.
const FROM_ADDRESS = "Центр сенсорної інтеграції <onboarding@resend.dev>";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function clean(value: unknown, maxLen: number): string {
  return String(value ?? "").trim().slice(0, maxLen);
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // Honeypot: a real visitor never sees or fills this field (hidden via
  // CSS in index.html) — a filled-in value means a bot blindly filling
  // every input it finds. Pretend success so the bot doesn't learn to
  // adapt, but skip the DB write and the email entirely.
  if (clean(body.website, 200)) {
    return json({ success: true });
  }

  const name = clean(body.name, 200);
  const phone = clean(body.phone, 50);
  const childAge = clean(body.child_age, 50) || null;

  if (!name || !phone) {
    return json({ error: "Вкажіть ім'я та телефон." }, 400);
  }

  // service_role — there's no caller JWT to bind to (anonymous visitor),
  // and this table has no anon insert policy at all (see schema.sql).
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: inserted, error: insertError } = await adminClient
    .from("consultation_requests")
    .insert({ name, phone, child_age: childAge })
    .select("id")
    .single();

  if (insertError) {
    return json({ error: "Не вдалося зберегти заявку: " + insertError.message }, 500);
  }

  // Email is best-effort: the request is already saved above, so a Resend
  // hiccup (rate limit, network blip, bad API key) shouldn't turn into an
  // error shown to the site visitor — it would just make them think their
  // request wasn't received when it actually was. Log it for whoever reads
  // the function's logs, but still answer success to the client.
  if (RESEND_API_KEY) {
    try {
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: [NOTIFY_EMAIL],
          subject: `Нова заявка на консультацію — ${name}`,
          html:
            `<p><strong>Ім'я:</strong> ${escapeHtml(name)}</p>` +
            `<p><strong>Телефон:</strong> ${escapeHtml(phone)}</p>` +
            (childAge ? `<p><strong>Вік дитини:</strong> ${escapeHtml(childAge)}</p>` : "") +
            `<p style="color:#888;font-size:.85em;">Заявка №${inserted?.id ?? "—"}, надіслана з сайту.</p>`,
        }),
      });
      if (!emailRes.ok) {
        console.error("Resend send failed:", emailRes.status, await emailRes.text());
      }
    } catch (e) {
      console.error("Resend request threw:", e);
    }
  } else {
    console.error("RESEND_API_KEY not set — skipping email, request was still saved.");
  }

  return json({ success: true });
});
