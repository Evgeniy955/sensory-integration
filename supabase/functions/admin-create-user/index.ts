// Supabase Edge Function: admin-create-user
//
// Called only from the admin dashboard by a logged-in super_admin.
// Creates a new auth user (sent an email invite to set their password)
// and writes their profiles row with the chosen role.
//
// SECURITY: this function uses the service_role key, which must be set
// only as an Edge Function secret (Supabase Dashboard → Edge Functions →
// admin-create-user → Secrets, or `supabase secrets set`). It must never
// be shipped to the browser or committed to this repo.
//
// Deploy with: supabase functions deploy admin-create-user

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

  // Client bound to the caller's own JWT — used only to verify who is calling.
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

  if (profileError || callerProfile?.role !== "super_admin") {
    return json({ error: "Forbidden — super_admin only" }, 403);
  }

  let body: { email?: string; role?: string; full_name?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { email, role, full_name } = body;
  const allowedRoles = ["super_admin", "admin", "instructor"];
  if (!email || !role || !allowedRoles.includes(role)) {
    return json({ error: "email and a valid role are required" }, 400);
  }

  // Admin client with service_role — bypasses RLS, can manage auth users.
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email);
  if (inviteError || !invited?.user) {
    return json({ error: inviteError?.message ?? "Could not create user" }, 400);
  }

  const { error: upsertError } = await adminClient
    .from("profiles")
    .upsert({ id: invited.user.id, email, role, full_name: full_name || null });

  if (upsertError) {
    return json({ error: upsertError.message }, 500);
  }

  return json({ success: true, user_id: invited.user.id });
});
