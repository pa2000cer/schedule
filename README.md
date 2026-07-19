# Personal Calendar

A single-user personal calendar app. The browser front end shows one day at a
time (appointments + tasks); the server hosts an HTTP API plus a Calendar MCP
server that talks to Google Calendar and routes actions to Claude models. It
deploys as a container to Google Cloud Run.

This repo is currently a minimal scaffold: a buildable/runnable server skeleton
with a placeholder health route, and an empty-shell frontend. Auth, the
Google Calendar module, the MCP server, and the real UI land in later tasks.

## Project layout

```
server/           Node.js + TypeScript HTTP API (and, later, the MCP server)
  src/
    index.ts      Entry point — Express app, mounts routes
    routes/
      health.ts    GET /health -> { status: "ok" }
frontend/         Browser UI (placeholder static page for now)
Dockerfile        Multi-stage build for Cloud Run deployment
.env.example      Template for local environment variables
```

## Requirements

- Node.js >= 20
- npm

## Setup

```bash
npm install
cp .env.example .env   # optional for now; no required values yet
```

## Build

```bash
npm run build
```

Compiles `server/src` (TypeScript) to `dist/` via `tsc`.

## Run

```bash
npm start
```

Starts the compiled server (default port `8080`, or `$PORT`). Verify it's up:

```bash
curl http://localhost:8080/health
# {"status":"ok"}
```

## Develop

```bash
npm run dev
```

Runs the server directly from TypeScript source with `tsx` in watch mode
(auto-restarts on file changes).

## Docker

```bash
docker build -t personal-calendar .
docker run -p 8080:8080 personal-calendar
curl http://localhost:8080/health
```
