# HireUp System Flowchart

```mermaid
flowchart TD
    U[User Browser] --> P[Static Pages<br/>index.html<br/>seeker_profile.html<br/>employer_profile.html]
    P --> JS[script.js / page scripts]

    JS -->|GET static assets| S[Node HTTP Server<br/>server.js]
    JS -->|POST /api/signup| S
    JS -->|POST /api/login| S
    JS -->|POST /api/auth/google| S
    JS -->|GET /auth/facebook/start| S
    JS -->|GET /api/me / profile / jobs / applications / messages| S
    JS -->|POST or PATCH job, application, message, profile updates| S
    JS -->|GET /api/events| SSE[Server-Sent Events]
    SSE --> JS

    S --> CFG[Config + Env Resolution<br/>PORT, PUBLIC_ORIGIN, storage provider,<br/>OAuth keys, email keys]
    S --> AUTH[Authentication Layer<br/>password login + Google + Facebook<br/>token issuance + session lookup]
    S --> API[API Handlers]
    S --> STATIC[Static File Serving]
    S --> LIVE[Broadcast live updates<br/>jobs_updated<br/>applications_updated<br/>messages_updated]

    API --> FEED[Feedback + Support]
    API --> PROF[Profile Management]
    API --> JOBS[Jobs Management]
    API --> APPS[Applications Management]
    API --> MSG[Application Chat Messages]
    API --> ADMIN[Admin User Utilities]
    API --> NOTIF[Notifications + Me]

    FEED --> DB[(App State Database)]
    PROF --> DB
    JOBS --> DB
    APPS --> DB
    MSG --> DB
    ADMIN --> DB
    NOTIF --> DB
    AUTH --> DB

    DB --> STORE{Storage Provider}
    STORE -->|Default| SQLITE[SQLite db.sqlite<br/>kv table stores full JSON blob<br/>mirror tables for inspection]
    STORE -->|If SUPABASE_URL + SERVICE_ROLE_KEY| SUPA[Supabase app_state row<br/>JSON value is source of truth]

    SQLITE --> BACKUP[Local server-data directory]
    S --> WATCH[Dev file watcher]
    WATCH --> LIVE
```

## Reset / Maintenance Flow

```mermaid
flowchart TD
    A[node tools/reset-db.js] --> B[Parse CLI args<br/>--role all|employer|seeker<br/>--accounts-only]
    B --> C[Resolve storage path<br/>server-data/db.sqlite]
    C --> D[Ensure SQLite + kv table exist]
    D --> E[Read JSON app-state from kv row]
    E --> F[Create backups<br/>timestamped JSON + SQLite copy]
    F --> G{Reset scope}
    G -->|accounts-only| H[Clear users + sessions]
    G -->|role=all| I[Clear users, sessions, jobs,<br/>applications, feedback]
    G -->|role=employer| J[Remove employer users,<br/>their sessions, jobs, applications]
    G -->|role=seeker| K[Remove seeker users,<br/>their sessions, applications]
    H --> L[Write updated JSON blob back to kv]
    I --> L
    J --> L
    K --> L
    L --> M[Rebuild readable mirror tables]
    M --> N[Print backup and reset summary]
```

## High-Level Reading

- Frontend is mostly static HTML + large client-side JS.
- `server.js` is the single backend entry point for static hosting, auth, APIs, and SSE.
- The real database is one JSON document stored in SQLite or Supabase.
- SQLite mirror tables exist mainly for inspection and maintenance tooling.
- `tools/reset-db.js` safely backs up state before clearing selected records.
