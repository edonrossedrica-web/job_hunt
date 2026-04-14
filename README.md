# Smart Hunt (HireUp)

## Run locally

- Install deps: `npm install`
- Start dev server (auto restarts on `server.js` changes): `npm run dev`
- Open: `http://localhost:3000`

## Host it online

- Recommended host: Railway
- Copy `.env.example` to your host's environment variables panel
- Set `SMART_HUNT_DATA_DIR=/data` and mount a persistent volume at `/data`
- Set `PUBLIC_ORIGIN` to your live URL so OAuth callbacks resolve correctly
- Optional OAuth vars: `GOOGLE_CLIENT_ID`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`
- For feedback/support email on hosted deploys, prefer `BREVO_API_KEY` with `FEEDBACK_FROM` and `FEEDBACK_TO`
- After deploy, verify the server with `/api/health`

See `DEPLOY_RAILWAY.md` for the full checklist.

## Live reload (no manual refresh)

When running the Node server, the browser auto-updates on file edits:

- `styles.css` changes hot-reload CSS
- `*.js` / `*.html` changes trigger a page reload

Disable with `SMART_HUNT_LIVE_RELOAD=0`.
