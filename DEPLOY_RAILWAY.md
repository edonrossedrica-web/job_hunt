# Deploy to Railway (recommended for this project)

This project is a simple Node.js server + static site with a SQLite database file.
For a public website (employer and seeker on different devices/regions), you need to deploy the server to a host with a public URL.

## 1) Push to GitHub

1. Create a GitHub repo and push this folder.
2. Make sure `server-data/` is **not** committed (it is ignored by `.gitignore`).

## 2) Create a Railway project

1. In Railway: **New Project** → **Deploy from GitHub repo**.
2. Select your repository.
3. Railway should detect Node automatically because `package.json` exists.
4. The included `railway.json` starts the app with `npm start`.

## 3) Add a persistent Volume (important for SQLite)

SQLite is a single file (`db.sqlite`). If the filesystem is ephemeral, your data can be lost on redeploy/restart.

1. In your service settings, add a **Volume**.
2. Mount it at: `/data`

## 4) Set an environment variable for the DB location

In Railway service variables, add:

- `SMART_HUNT_DATA_DIR=/data`

This makes the server store the SQLite DB at:

- `/data/db.sqlite`

## 5) Deploy + open your public URL

1. Deploy the service.
2. Use Railway’s generated domain (public URL) and share it with employer/seeker.

## 6) Feedback / Customer Service emails

The app sends both **Feedback** and **Customer Service** messages to your inbox via SMTP (Nodemailer).

Set these environment variables in Railway.
You can use `.env.example` in this repo as a safe template:

- `SMTP_HOST` (e.g. `smtp.gmail.com`)
- `SMTP_PORT` (usually `587` for TLS, or `465` for SSL)
- `SMTP_USER` (your email / SMTP username)
- `SMTP_PASS` (SMTP password or app password)
- `SMTP_SECURE` (`true` for port `465`, otherwise omit / set `false`)
- `FEEDBACK_TO` (the inbox you want to receive messages at; defaults to `SMTP_USER` if not set)
- `FEEDBACK_FROM` (optional; defaults to `SMTP_USER`)
- `FEEDBACK_SUBJECT_PREFIX` (optional; defaults to `HireUp`)

Notes:

- If email isn’t configured, messages are still saved on the server to `server-data/feedback.jsonl`.
- When users include an email, the message is sent with `Reply-To` set to that email so you can reply directly.

## 7) OAuth (Google / LinkedIn buttons)

If you want the **Google** and **LinkedIn** buttons to perform real OAuth (instead of the demo fallback used for `file://`), set these variables in Railway:

- `GOOGLE_CLIENT_ID` (Google OAuth Web Client ID)
- `LINKEDIN_CLIENT_ID`
- `LINKEDIN_CLIENT_SECRET`

For LinkedIn, you also need a redirect URI. You can either:

- Set `LINKEDIN_REDIRECT_URI` explicitly (recommended), or
- Set `PUBLIC_ORIGIN` (or `PUBLIC_URL` / `BASE_URL`) so the server can build the correct `https://.../auth/linkedin/callback` URL behind Railway’s proxy.

Notes:

- Make sure your OAuth app settings allow your Railway domain (and `http://localhost:3000` for local dev).
- LinkedIn redirect URIs must match exactly (including `https` and path).

## Notes

- The server listens on `process.env.PORT` (Railway provides this automatically).
- Health check after deploy: `/api/health`
- To reset the DB locally you can run: `powershell -ExecutionPolicy Bypass -File .\\reset-system.ps1`
