# AGENTS.md

## Project overview

This repository is a lightweight warehouse/MySQL connectivity tool built with React on the frontend and Express/MySQL2 on the backend.

- Frontend app: [client/src/main.jsx](client/src/main.jsx)
- Backend API: [server/index.js](server/index.js)
- Project instructions: [README.md](README.md)

## Working conventions

- Keep the stack simple: React + Vite on the client, Express + MySQL2 on the server.
- Do not introduce new frameworks or large architectural rewrites unless explicitly requested.
- Prefer small, focused changes that match the existing code style and naming patterns.
- When changing MySQL connection logic, update both the connection string parser and the final connection configuration in [server/index.js](server/index.js).

## Local development

Use these commands from the repo root:

```bash
npm install --prefix server
npm install --prefix client
npm run dev
```

Expected runtime:

- Frontend: http://localhost:5173
- Backend: http://localhost:3005/api/health

## Architecture notes

- The root package script runs the backend and frontend together with concurrently.
- The frontend is a single-page React app that submits connection requests and SQL queries to the backend.
- The backend exposes endpoints such as `/api/health`, `/api/test-connection`, and `/api/query`.
- MySQL SSL handling is implemented in the server and should remain compatible with Aiven-style connection strings.

## Common pitfalls

- Connection strings may be provided as a full MySQL URL such as `mysql://user:password@host:port/database?ssl-mode=REQUIRED`.
- Keep `ssl` and `allowPublicKeyRetrieval` handling intact when editing database connection settings.
- Do not assume a local MySQL server is present; the app is meant to test remote Aiven/MySQL connectivity.

## Preferred workflow for changes

1. Read the existing relevant file before editing.
2. Make the smallest fix or feature addition possible.
3. Validate with the nearest available script or runtime smoke check.
4. Keep the UI and API behavior consistent with the current warehouse/inbound workflow.

## Useful references

- [README.md](README.md) for setup and environment details.
- [server/index.js](server/index.js) for API and database behavior.
- [client/src/main.jsx](client/src/main.jsx) for React UI structure and state.
