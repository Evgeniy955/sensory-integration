# sensory-integration
sensory integration

## Адмінпанель

Керування ролями та користувачами (`super_admin`, `admin`, `instructor`) працює через Supabase.

**Доступ:**
- Якщо сайт розгорнутий на хостингу/домені — заходь на `https://твій-домен/admin/login.html`. Після входу він сам перенаправить на `dashboard.html`.
- Якщо тестуєш локально — відкрий не файл напряму (`file://`), а через локальний сервер:
  ```
  cd sensory-integration
  python3 -m http.server 8080
  ```
  і відкрий `http://localhost:8080/admin/login.html`.

**Налаштування (один раз):**
1. Виконати `supabase/schema.sql` в Supabase SQL Editor.
2. Задеплоїти Edge Function `supabase/functions/admin-create-user` (через Dashboard → Edge Functions → Deploy a new function → Via Editor, або CLI).
3. Вписати Project URL і `anon public` key в `assets/js/supabase-config.js`.
4. Зареєструвати свій акаунт через `admin/login.html`, потім в SQL Editor виконати:
   ```sql
   update public.profiles set role = 'super_admin' where email = 'твій@email';
   ```

**Вхід через Google (опційно):**
1. Google Cloud Console → створити OAuth-клієнт (тип "Web application").
   Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`
   (сам `<project-ref>` видно в Supabase Dashboard → Project Settings → API, в Project URL).
2. Скопіювати Client ID і Client Secret.
3. Supabase Dashboard → Authentication → Providers → Google → увімкнути, вставити Client ID/Secret → Save.
4. Supabase Dashboard → Authentication → URL Configuration → додати в Redirect URLs адресу твого `admin/dashboard.html` (наприклад `https://твій-домен/admin/dashboard.html`, для локальних тестів — `http://localhost:8080/admin/dashboard.html`).
5. Готово — на сторінці входу з'явиться кнопка "Увійти через Google". Новий користувач через Google так само отримує роль `instructor` за замовчуванням (тригер той самий), роль потім міняє супер-адмін.
