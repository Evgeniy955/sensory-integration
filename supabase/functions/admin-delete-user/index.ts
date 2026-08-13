// Supabase Edge Function: admin-delete-user
//
// Called only from the admin dashboard by a logged-in super_admin.
// Deletes the auth user outright; the profiles row is removed automatically
// via its `on delete cascade` foreign key to auth.users.
//
// SECURITY: this function uses the service_role key, which must be set
// only as an Edge Function secret (Supabase Dashboard → Edge Functions →
// admin-delete-user → Secrets, or `supabase secrets set`). It must never
// be shipped to the browser or committed to this repo.
//
// Deploy with: supabase functions deploy admin-delete-user

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

  let body: { user_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { user_id } = body;
  if (!user_id) {
    return json({ error: "user_id is required" }, 400);
  }

  if (user_id === user.id) {
    return json({ error: "Не можна видалити власний обліковий запис" }, 400);
  }

  // Admin client with service_role — bypasses RLS, can manage auth users.
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { error: deleteError } = await adminClient.auth.admin.deleteUser(user_id);
  if (deleteError) {
    return json({ error: deleteError.message }, 400);
  }

  return json({ success: true });
});
