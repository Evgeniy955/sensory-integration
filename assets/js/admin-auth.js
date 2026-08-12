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

  // Returns the current session's user + profile row, or null if signed out.
  window.getCurrentProfile = async function () {
    const { data: { session } } = await client.auth.getSession();
    if (!session) return null;

    const { data: profile, error } = await client
      .from("profiles")
      .select("id, email, full_name, role, created_at")
      .eq("id", session.user.id)
      .single();

    if (error) {
      console.error("Не вдалося завантажити профіль:", error.message);
      return null;
    }
    return profile;
  };

  // Redirects to login.html if there is no active session. Call at the
  // top of any page that requires authentication. Returns the profile.
  window.requireAuth = async function () {
    const profile = await window.getCurrentProfile();
    if (!profile) {
      window.location.href = "login.html";
      return null;
    }
    return profile;
  };

  window.signOut = async function () {
    await client.auth.signOut();
    window.location.href = "login.html";
  };
})();
