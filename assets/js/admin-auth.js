// Shared Supabase client + auth helpers for admin/*.html pages.
// Loaded after supabase-config.js and the Supabase JS CDN script.

(function () {
  const cfg = window.SUPABASE_CONFIG || {};

  if (!cfg.url || !cfg.anonKey) {
    document.addEventListener("DOMContentLoaded", () => {
      const el = document.querySelector("[data-admin-status]") || document.body;
      el.innerHTML =
        '<div class="admin-notice admin-notice--error">' +
        "Supabase ще не підключено. Заповніть <code>assets/js/supabase-config.js</code> " +
        "значеннями url і anonKey з налаштувань вашого проєкту Supabase." +
        "</div>";
    });
    throw new Error("Supabase config missing (assets/js/supabase-config.js)");
  }

  const client = window.supabase.createClient(cfg.url, cfg.anonKey);
  window.sbClient = client;

  // Returns the current session's user + profile row, or null if signed
  // out *or* if signed in but nobody invited them (no matching profiles
  // row — only a super_admin creating a user from "Керування
  // користувачами" writes one; see schema.sql section 5). That second
  // case is treated the same as "not logged in": the stray auth session
  // is signed out right here so it doesn't linger, rather than leaving
  // someone in an authenticated-but-permissionless limbo.
  window.getCurrentProfile = async function () {
    const { data: { session } } = await client.auth.getSession();
    if (!session) return null;

    // maybeSingle(), not single() — zero rows is an expected, valid
    // outcome now (an uninvited account), not an error to log.
    const { data: profile, error } = await client
      .from("profiles")
      .select("id, email, full_name, role, created_at")
      .eq("id", session.user.id)
      .maybeSingle();

    if (error) {
      console.error("Не вдалося завантажити профіль:", error.message);
      return null;
    }
    if (!profile) {
      await client.auth.signOut();
      return null;
    }
    return profile;
  };

  // Redirects to login.html if there is no active session (or no access —
  // see getCurrentProfile above). Call at the top of any page that
  // requires authentication. Returns the profile.
  window.requireAuth = async function () {
    const profile = await window.getCurrentProfile();
    if (!profile) {
      window.location.href = "login.html?noaccess=1";
      return null;
    }
    return profile;
  };

  window.signOut = async function () {
    await client.auth.signOut();
    window.location.href = "login.html";
  };
})();
