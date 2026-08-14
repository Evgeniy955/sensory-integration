// Supabase Edge Function: cleanup-unauthorized-signin
//
// Called by admin-auth.js (getCurrentProfile) the moment it finds a valid
// session with no matching profiles row — i.e. someone completed a sign-in
// (mainly "Увійти через Google" on login.html) without ever being invited
// by a super_admin.
//
// Supabase Auth creates the auth.users row itself as a side effect of a
// successful OAuth handshake, before any of our own app code runs — we
// can reject the *session* client-side, but that leaves the auth.users
// row behind. Left alone, those pile up in Supabase's own user list and,
// worse, block a super_admin from later inviting that same email
// ("A user with this email address has already been registered") once it
// legitimately should have access. This function removes that row
// outright — self-service, but only for the caller's own account, and
// only if it truly has no profiles row (never lets an actual admin/
// instructor delete themselves through this).
//
// SECURITY: this function uses the service_role key, which must be set
// only as an Edge Function secret (Supabase Dashboard → Edge Functions →
// cleanup-unauthorized-signin → Secrets, or `supabase secrets set`). It
// must never be shipped to the browser or committed to this repo.
//
// Deploy with: supabase functions deploy cleanup-unauthorized-signin

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing authorization" }, 401);
  }

  // Client bound to the caller's own (still-valid) JWT — used only to
  // find out who is calling and confirm they really have no profile.
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userError } = await callerClient.auth.getUser();
  if (userError || !user) {
    return json({ error: "Not authenticated" }, 401);
  }

  const { data: profile } = await callerClient
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  if (profile) {
    // Has real access — never delete a real account through this endpoint.
    return json({ error: "This account has access; refusing to delete it" }, 403);
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { error: deleteError } = await adminClient.auth.admin.deleteUser(user.id);
  if (deleteError) {
    return json({ error: deleteError.message }, 400);
  }

  return json({ success: true });
});
