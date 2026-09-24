# ClickDown

A read-only ClickUp browser: a Rust (axum) backend holds the token and calls ClickUp with GET only; an Angular UI
in the browser talks only to that backend at http://127.0.0.1:4280 and never sees the token.

- `src/ClickDown/`: Rust backend. `src/config.rs` (load and validate config.toml, self-masking `Token`),
  `src/api.rs` (ClickUp client with one `get()`, which also remembers ClickUp's latest `X-RateLimit-*` numbers,
  plus response models), `src/main.rs` (entry point: logging, GET-only local server that passes those numbers
  on as response headers, markdown → HTML), `tests/read_only.rs` (read-only tripwire), `build.rs` (records the
  rustc/axum/tokio/Angular versions for the startup log).
- `src/ClickDown.Angular/`: UI, styled after `demo.html` (the design reference; its harness is a mock and never
  part of the app). `src/app/` holds `app.ts` + `app.html` (shell: rail, views, status bar, help, and the
  one key handler), `navigator.ts` (the descent's state and the address after the `#` it follows, the rail,
  and the search and sort of the rows already loaded: ClickUp's API can't search text), `backend.ts`,
  `models.ts`, `format.ts` (dates, counts, search matching, safe colors), `item-list.ts` (the one listbox, also
  used for subtasks), `task-detail.ts`.
  All CSS lives in `src/styles.css`; its fonts (Atkinson Hyperlegible, SIL OFL) are in `public/fonts/`. Every
  ClickUp color reaching CSS goes through `format.ts`'s `color()`.
- `Dockerfile`, `.github/workflows/package.yml`: the container image for amd64 and arm64, pushed to ghcr.io by
  GitHub Actions. The workflow compiles the binary and builds the UI in /opt/clickdown (their paths are fixed
  at compile time, and the image runs them from there); the Dockerfile only copies those two in. No source
  code, and no `config.toml`, ever reaches Docker. The same rules hold, but one: built with the `container`
  feature, the binary listens on 0.0.0.0:4280 inside its container, and runs with `-p 127.0.0.1:4280:4280`
  (never `--network host`, a bare `-p 4280:4280`, or an `EXPOSE`; on Linux that needs Docker Engine 28.0+).
  `config.toml` is mounted at run time.

## Non-negotiable rules

1. **Read-only.** `api.rs`'s ClickUp client has exactly one `get()`. The local server registers only GET routes.
   `backend.ts` is the only `HttpClient` user and only calls `get`. `tests/read_only.rs` enforces all of this
   across both codebases. Never add POST/PUT/PATCH/DELETE, `fetch`, forms, or any editing UI; to change
   something the user edits it in ClickUp.
2. **Config file only.** `src/ClickDown/config.toml` is the single settings source, read once at startup. No env
   vars, `.env`, CLI flags, keychain or secret stores. Keep library env reads disabled: reqwest `.no_proxy()`; a
   hand-built current-thread tokio runtime with an explicit thread stack size; the tracing builder without the
   `ansi` feature; a custom panic hook that doesn't chain the default one. `env::var` may appear only in
   `build.rs` (compile-time version info).
3. **Standard logging.** `tracing` writes to the configured log file at the configured level; stdout is only for
   the few startup lines. Log startup versions, every ClickUp call (method, path, status, duration), rate-limit
   waits, and errors with backtraces.
4. **Never log the token.** Keep it in `config::Token`, which masks itself (`pk_12…9xyz`); call `expose()` only
   in `api.rs`. Config parse errors must never echo the file's contents.
5. **Simple architecture.** Four pieces: `config.rs`, `api.rs`, the Angular UI, and `main.rs` (entry point and
   wiring); `config.rs` and `api.rs` know nothing about serving or the UI. No extra layers, DI containers
   (beyond what Angular itself requires), single-implementation traits/interfaces, databases or disk caches.
   Justify every new dependency. The whole codebase must stay readable in about 15 minutes; since the demo.html
   redesign it is ~4,000 lines including tests (the plan aimed for ~1,300), so shrink rather than grow it.
   All CSS in `styles.css`. Animations are native (CSS plus `animate.enter`/`animate.leave`, not
   `@angular/animations`) and obey the `animations` config switch.

Also keep: binding to 127.0.0.1 only (0.0.0.0 only in the `container` build), the Host-header guard (only 127.0.0.1:4280, localhost:4280 and config's `allowed_hosts`, which is for a reverse proxy), the `/api` path character check, hash routing (the server serves the UI only at `/`), descriptions
rendering raw HTML as text and images as links, attachments shown only as links (never thumbnails), and `only_lists` enforced by the backend (browsing routes not
registered; lists, tasks and comments outside it refused), never just hidden in the UI. Tests use fixtures, never the real ClickUp API (under `cfg(test)`,
`api.rs`'s `BASE_URL` is a closed local port). Never commit
`config.toml` or put it in the container image.

## Commands

```sh
# backend, in src/ClickDown
cargo build
cargo fmt --check            # rustfmt.toml: use_small_heuristics = "Max"
cargo clippy --all-targets -- -D warnings
cargo test
cargo run                   # http://127.0.0.1:4280

# UI, in src/ClickDown.Angular
npm ci
npm run build               # zero warnings (extended diagnostics are errors)
npx ng test --watch=false
npx ng serve                # http://localhost:4200, proxies /api to the backend
```

The global npm 10 crashes resolving new dependencies (`reading 'edgesOut'`). For dependency changes use
`npx -y npm@11 install <pkg>` (or `uninstall`), then check that `npm ci` still works.
