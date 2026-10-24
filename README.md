# bolos-system

Bolos Alley table timers and IFTTT lights.

## Run locally

```
npm install
cp .env.example .env   # fill in IFTTT_KEY, STAFF_PIN, ADMIN_PASSWORD
npm start              # http://localhost:3000
```

Without `SUPABASE_URL` / `SUPABASE_SECRET_KEY`, data is saved in `data/`.

## Deploy on Vercel

Vercel deploys automatically on every push to `main`. Set these in
Project Settings → Environment Variables:

| Variable | |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Supabase → Project Settings → API Keys → Secret key |
| `STAFF_PIN` | staff login PIN |
| `ADMIN_PASSWORD` | master reset password |
| `IFTTT_KEY` | IFTTT Webhooks key |
| `SESSION_SECRET` | optional, long random string for signing staff logins |

How it works on Vercel: there is no always-on server, so pages poll
`/api/state` every 2 seconds. A timed table that runs out is closed (and its
lights blink) on the first request after it ends — so keep at least one
screen open at the venue for the end-of-time lights to fire on time.
