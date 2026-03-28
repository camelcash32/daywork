# ⚡ DAYWORK — Server

Real-time Node.js server. Zero npm dependencies — uses only built-in Node.js modules.

## Requirements
- Node.js 16 or higher (download at nodejs.org)

## Setup

1. Unzip this folder
2. Put `poster.html` and `worker.html` in the same folder as `server.js`
3. Open a terminal / command prompt in that folder
4. Run:

```
node server.js
```

5. Open your browser:
   - **Poster app:** http://localhost:3000/poster
   - **Worker app:** http://localhost:3000/worker

## How it works

- All data (jobs, ratings, users) is stored in `data.json` in the same folder
- Both browser tabs connect via WebSocket and sync in real-time
- Any browser on your local network can connect using your IP address:
  - Find your IP: run `ipconfig` (Windows) or `ifconfig` (Mac/Linux)
  - Example: http://192.168.1.50:3000/poster

## Demo accounts (all use password123)

| Email | Password |
|-------|----------|
| demo@daywork.com | password123 |
| worker@daywork.com | password123 |
| marcus@daywork.com | password123 |

## Files

| File | Purpose |
|------|---------|
| server.js | The server (run this) |
| poster.html | Poster app (served at /poster) |
| worker.html | Worker app (served at /worker) |
| data.json | Auto-created, stores all app data |
