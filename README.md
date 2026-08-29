# sensory-integration
sensory integration

## Адмінпанель

Подробная инструкция для сотрудников: [admin/ADMIN-GUIDE.md](admin/ADMIN-GUIDE.md).

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

**AI помічник (Анкети, опційно):**

Кнопка «AI помічник» на сторінці `admin/anketa.html` дозволяє ставити запитання про збережені анкети природною мовою — відповідає Gemini (Google), спираючись лише на дані анкет. Gemini сам вирішує, які дані йому потрібні, і функція виконує для нього свіжий запит до бази (пошук за іменем, повний перелік дітей або значення одного поля для всіх анкет) — це надійніше за одноразове «вивантаження» всіх анкет у запит, бо не залежить від того, скільки їх у базі.

1. Отримати API-ключ на https://aistudio.google.com/apikey.
2. Задеплоїти Edge Function: `supabase functions deploy ai-assistant`.
3. Задати секрет (тільки через CLI/Dashboard, ніколи в код):
   ```
   supabase secrets set GEMINI_API_KEY=<твій ключ>
   ```
   За потреби можна задати іншу модель (за замовчуванням `gemini-3.6-flash`):
   ```
   supabase secrets set GEMINI_MODEL=gemini-3.6-flash
   ```
4. Готово — кнопка працює для ролей `admin`, `super_admin`, `instructor` (ті самі, що бачать «Анкети»).

Важливо: анкети містять чутливу інформацію про дітей (медичні дані). Кожен запит до AI помічника надсилає стислий зведений опис збережених анкет у Gemini API для обробки — переконайся, що це прийнятно з точки зору політики конфіденційності центру, перш ніж вмикати функцію.

Розмови НЕ зберігаються автоматично — лише коли фахівець сам натисне «Зберегти чат», вона потрапляє в таблицю `public.ai_chats` (створюється тим самим `schema.sql`), прив'язана до нього (`owner_id`/`owner_email`). RLS дозволяє кожному бачити й редагувати лише власні збережені чати («Історія чатів» біля заголовка), тож вони доступні з будь-якого пристрою під тим самим акаунтом і не плутаються між різними спеціалістами.

**Заявки на консультацію (форма на головній сторінці):**

Форма «Готові зробити перший крок?» на `index.html` зберігає заявку в таблицю `public.consultation_requests` і надсилає email-сповіщення через Resend. У всіх сторінках адмінки є яскравий дзвіночок з лічильником нових заявок (топбар) і окрема сторінка `admin/consultation-requests.html`.

1. Отримати API-ключ на https://resend.com/api-keys (домен не потрібен — лист іде з дефолтного `onboarding@resend.dev`, поки свій домен не підключено й не верифіковано в Resend).
2. Задеплоїти Edge Function: `supabase functions deploy submit-consultation-request`.
3. Задати секрет:
   ```
   supabase secrets set RESEND_API_KEY=<твій ключ>
   ```
   За потреби — інша адреса для сповіщень (за замовчуванням `vladelis2026@gmail.com`):
   ```
   supabase secrets set NOTIFY_EMAIL=твій@email
   ```
4. Готово — заявка зберігається в базі навіть якщо лист із будь-якої причини не надійшов (RESEND_API_KEY не задано, Resend недоступний тощо), так що жодна заявка не губиться.

Побачити заявки й позначити їх опрацьованими можуть ролі `admin`, `super_admin`, `instructor` (перегляд); позначати опрацьованими — лише `admin`/`super_admin`.

**Вхід через Google (опційно):**
1. Google Cloud Console → створити OAuth-клієнт (тип "Web application").
   Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`
   (сам `<project-ref>` видно в Supabase Dashboard → Project Settings → API, в Project URL).
2. Скопіювати Client ID і Client Secret.
3. Supabase Dashboard → Authentication → Providers → Google → увімкнути, вставити Client ID/Secret → Save.
4. Supabase Dashboard → Authentication → URL Configuration → додати в Redirect URLs адресу твого `admin/dashboard.html` (наприклад `https://твій-домен/admin/dashboard.html`, для локальних тестів — `http://localhost:8080/admin/dashboard.html`).
5. Готово — на сторінці входу з'явиться кнопка "Увійти через Google". Новий користувач через Google так само отримує роль `instructor` за замовчуванням (тригер той самий), роль потім міняє супер-адмін.
