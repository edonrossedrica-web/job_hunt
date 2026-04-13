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
- After deploy, verify the server with `/api/health`

See `DEPLOY_RAILWAY.md` for the full checklist.

## Live reload (no manual refresh)

When running the Node server, the browser auto-updates on file edits:

- `styles.css` changes hot-reload CSS
- `*.js` / `*.html` changes trigger a page reload

Disable with `SMART_HUNT_LIVE_RELOAD=0`.
