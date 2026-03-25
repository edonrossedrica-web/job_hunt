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

## Notes

- The server listens on `process.env.PORT` (Railway provides this automatically).
- To reset the DB locally you can run: `powershell -ExecutionPolicy Bypass -File .\\reset-system.ps1`

