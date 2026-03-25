# Reset (fresh system)

This project stores data in two places:

1) **Backend (Node server)**: `server-data/db.sqlite` (SQLite)
2) **Browser (frontend demo state)**: `localStorage` (login/session + saved jobs)

If you deploy to a host (Railway, etc.), set `SMART_HUNT_DATA_DIR` to your persistent volume mount path
so the SQLite file is not lost on restart/redeploy.

## Clear all backend accounts/data

Run:

`powershell -ExecutionPolicy Bypass -File .\\reset-system.ps1`

This clears `users`, `sessions`, `jobs`, and `applications` in `server-data/db.sqlite`.

## Clear only employer (or seeker) accounts

Run one of:

- `powershell -ExecutionPolicy Bypass -File .\\reset-system.ps1 -Role employer`
- `powershell -ExecutionPolicy Bypass -File .\\reset-system.ps1 -Role seeker`

This removes users of that role and also clears related sessions (and related jobs/applications where applicable).

## Clear browser login/demo data

Open the site, then open DevTools Console and run:

`smartHuntFactoryReset()`

(It logs you out, removes demo users, removes saved jobs, then reloads the page.)
