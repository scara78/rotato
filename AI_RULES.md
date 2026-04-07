# AI_RULES.md

## Tech Stack

- **Runtime**: Node.js (no TypeScript) — all source files use CommonJS (`require`/`module.exports`)
- **Zero external dependencies**: The entire project runs with no npm packages — no Express, no Axios, no dotenv, nothing. Use only Node.js built-in modules.
- **HTTP server**: Use the built-in `http` module for the proxy server (`src/server.js`)
- **HTTPS requests**: Use the built-in `https` module for outbound API calls (`src/geminiClient.js`, `src/openaiClient.js`)
- **Configuration**: Environment variables are loaded manually from a `.env` file using a custom parser in `src/config.js` — never use the `dotenv` package
- **Admin UI**: A single self-contained HTML file at `public/admin.html` — uses Tailwind CSS via CDN, vanilla JavaScript only, no frontend frameworks
- **Persistence**: No database — all state is stored in the `.env` file on disk; in-memory buffers are used for logs and response storage (last 100 entries)
- **Crypto**: Use the built-in `crypto` module for session token generation
- **File system**: Use the built-in `fs` and `path` modules for reading/writing `.env` and serving static files

## Rules

### General
- **Never add npm dependencies.** If a feature can be built with a Node.js built-in, use that. The `package.json` must remain dependency-free.
- All new server-side modules go in `src/` and use CommonJS (`require`/`module.exports`).
- Do not introduce TypeScript, ESM (`import`/`export`), or any build step.

### Server & Routing
- All HTTP routing is handled manually in `src/server.js` — do not introduce a routing library.
- Admin API routes must be prefixed with `/admin/api/`.
- All admin API routes (except `/admin/login`, `/admin/api/auth`, `/admin/api/login-status`) must check `isAdminAuthenticated()` before proceeding.
- CORS headers must be set on every response.

### Configuration & Environment
- Read and write `.env` exclusively through `src/config.js` and the `writeEnvFile()` helper in `src/server.js`.
- Never use `process.env` directly — always parse the `.env` file via `config.parseEnvFile()`.
- The `ADMIN_PASSWORD` key must never be exposed through any API response.

### Admin UI (`public/admin.html`)
- The admin panel is a **single HTML file** — do not split it into multiple files or introduce a bundler.
- Use **vanilla JavaScript only** — no React, Vue, jQuery, or other frontend libraries.
- Use **Tailwind CSS via CDN** for styling — do not add a separate CSS file or PostCSS pipeline.
- Use CSS custom properties (`var(--background)`, etc.) for theming — dark/light mode is toggled by adding/removing the `dark` class on `<body>`.
- All API calls from the admin UI go to `/admin/api/*` endpoints using `fetch()`.

### API Clients
- `src/geminiClient.js` handles all Gemini-compatible API calls.
- `src/openaiClient.js` handles all OpenAI-compatible API calls.
- Both clients must support streaming (SSE) by piping the raw response stream — never buffer a streaming response.
- Key rotation logic lives exclusively in `src/keyRotator.js` — do not duplicate rotation logic in clients or the server.

### Logging
- Logs are kept **in memory only** (the `logBuffer` array in `ProxyServer`) — never write logs to disk.
- Keep a maximum of 100 log entries in the buffer at any time.
- Response data for the "View Details" feature is stored in `responseStorage` (also capped at 100 entries).