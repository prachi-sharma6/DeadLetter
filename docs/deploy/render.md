# Deploying without a card (Render + Supabase + Redis Cloud)

Current production setup; see [ADR 0009](../adr/0009-no-card-hosting.md). The Northflank guide
([northflank.md](northflank.md)) applies only once a card can be used for verification.

**Golden rule for secrets:** paste connection strings and passwords **only into the Render dashboard**, never into chat,
issues, commits or screenshots.

| Piece                  | Service          | Region                     |
| ---------------------- | ---------------- | -------------------------- |
| API + web app + worker | Render Free      | Singapore                  |
| PostgreSQL             | Supabase Free    | Singapore (ap-southeast-1) |
| Redis                  | Redis Cloud Free | Singapore (ap-southeast-1) |
| Keep-awake ping        | cron-job.org     | n/a                        |

---

## 1. Supabase (database)

1. Sign up at <https://supabase.com> (GitHub sign-in is fine). No card needed.
2. **New project:** name `deadletter`, region **Southeast Asia (Singapore)**, generate a strong database password and
   store it in a password manager.
3. When the project is ready, click **Connect** (top bar) and copy the **Session pooler** connection string. It looks
   like `postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-…-ap-southeast-1.pooler.supabase.com:5432/postgres`.
   Replace `[YOUR-PASSWORD]` with your password. Do **not** add `?sslmode=…`.
   - Use the Session pooler, not "Direct connection": the direct one is IPv6-only on the free plan.
4. **CA certificate:** Project Settings → Database → **SSL Configuration → Download certificate**. Open the downloaded
   `.crt` file in a text editor; you will paste its whole content (from `-----BEGIN CERTIFICATE-----` to
   `-----END CERTIFICATE-----`) into Render. It is public, not a secret.

## 2. Redis Cloud

1. In the Redis Cloud console, create (or recreate) the **Free** database in **AWS ap-southeast-1 (Singapore)**.
2. Build the URL `redis://default:<PASSWORD>@<PUBLIC-ENDPOINT-HOST>:<PORT>` (use `rediss://` only if TLS is enabled on
   the database).

## 3. Render (app)

1. Sign up at <https://render.com> with **GitHub**; when installing the GitHub app, grant access to **only**
   `DeadLetter`.
2. **New → Blueprint** → choose the `DeadLetter` repository, branch `main`. Render reads `render.yaml` and shows one
   free web service named `deadletter`.
3. Fill in the values it asks for:
   - `DATABASE_URL`: the Supabase Session pooler URL from step 1.3
   - `DATABASE_CA_CERT`: the whole certificate text from step 1.4
   - `REDIS_URL`: the URL from step 2.2
   - `APP_ORIGIN`: `https://deadletter.onrender.com` (corrected in step 3.5 if Render picks a different URL)
4. **Apply.** The first Docker build takes a few minutes.
5. Open the service; if its URL differs from what you entered, update `APP_ORIGIN` under **Environment** (no trailing
   slash) and save.

The service redeploys automatically after every push to `main` once GitHub CI passes.

## 4. cron-job.org (keeps the free service awake)

1. Sign up at <https://cron-job.org> (free, no card).
2. **Create cronjob:** URL `https://<your-app>.onrender.com/api/health`, schedule **every 1 minute**, notifications on
   failure enabled.

## 5. Verify

- `https://<your-app>.onrender.com/api/health` → `"status":"ok"`, `database.ok` and `redis.ok` true, `"workers": 1`.
- `https://<your-app>.onrender.com/` shows the DeadLetter status page.

## Troubleshooting

| Symptom (in Render → Logs)                               | Fix                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Invalid environment configuration` + names              | Fix the listed variables under Environment.                                          |
| `self-signed certificate in certificate chain`           | `DATABASE_CA_CERT` is missing or incomplete; paste the full certificate text.        |
| `password authentication failed`                         | Wrong password in `DATABASE_URL`, or the username lacks the `.<project-ref>` suffix. |
| `ENOTFOUND` / `ENETUNREACH` for a `db.…supabase.co` host | You used the Direct connection string; use the Session pooler string.                |
| `redis: ok: false`                                       | Wrong password/host in `REDIS_URL`, or `rediss://` vs `redis://` mismatch.           |
| First request after a while takes ~1 minute              | The service was asleep; check that the cron job is running every minute.             |
