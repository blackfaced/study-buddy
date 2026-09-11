# Integration testing

## Scope and entry points

Use an isolated worktree for changes. The maintained commands are in the
[root package](../../package.json), [server package](../../server/package.json),
[MCP package](../../mcp-server/package.json), and [CI](../../.github/workflows/ci.yml).
Deployment commands live in [deploy.md](../deploy.md); this guide does not start,
restart, or update either shared Mac instance.

**3000 is production; 3002 is a shared test service.** Both serve the main checkout,
not necessarily your candidate. A health response alone does not establish which
commit is running. Neither service is needed for the isolated checks below.

## Fresh-checkout setup

Working directory: the root of the checkout/worktree being verified. Record
`git rev-parse HEAD` and `git status --short` with the results: uncommitted changes
are part of the candidate, not part of the reported commit.

Use Node 24 to match CI. Node 22.23.1 is also verified locally. Install the locked
root dependencies (Playwright belongs here) and server dependencies (the isolated
fixtures reuse Express). Native server dependencies may require build tools if
prebuilt binaries are unavailable.

```bash
npm ci --no-audit --no-fund
npm ci --prefix server --no-audit --no-fund
npx playwright install webkit
npm run test:shared-app
```

On Linux, use `npx playwright install --with-deps webkit` as CI does. This may
install system packages. Do not use a system Chrome path, `NODE_PATH`, an npm
download-cache path, or globally installed Playwright. Browser downloads require
network access; the verification itself requires no remote service.

No `.env`, child account, PIN, API key, mkcert certificate, or database is needed
for these isolated checks. Do not copy production credentials into the worktree.

## Isolated browser checks

From the same checkout root:

```bash
npm run test:shared-app
node --test e2e/write-layout.test.js
```

[shared-app.test.js](../../e2e/shared-app.test.js) binds a run-owned HTTP server to
`127.0.0.1` on an OS-assigned port and waits for its listening callback. It serves
this checkout's real `web/` files, supplies deterministic API responses, and invokes
the real [verifier CLI](../../scripts/verify-shared-app.js) in a separate process.
An inherited `TEST_URL` is overridden by the fixture address. The verifier uses
Playwright-managed WebKit and blocks requests to other origins.

The verifier checks shared-helper presence on buddy, write, and candy; a silent
TTS warm-up at the browser speech boundary; parsed JSON; and an error status on a
failed fetch. TTS is stubbed: this does not prove audible speech on an iPad.
Camera helper presence is checked, not physical-camera behavior. Domain API
responses are simulated, not backend acceptance evidence. Other page-console
errors remain diagnostic output; shared-helper assertion failures are fatal.

Success: exit 0 and all Node test cases pass. Failure: nonzero exit and the failed
assertion/browser diagnostic. Save the terminal output with candidate identity.
Browser assertions wait at most 5 seconds, navigation 15 seconds; each CLI test
has a 10- or 45-second subprocess deadline. The fixture closes its server, and the
CLI closes pages/browser in `finally`, including assertion failures. No database,
account, downloaded child media, or live API writes are created. Installed npm
dependencies and Playwright's browser cache remain intentionally available.

## Related suites

```bash
npm run typecheck --prefix server
npm run lint --prefix server
npm test --prefix server
npm ci --prefix mcp-server --no-audit --no-fund
npm run typecheck --prefix mcp-server
npm test --prefix mcp-server
```

The server test command includes the shared/client logic suites. These are
separate from the isolated browser checks. `npm run test:e2e` also selects the
**live** iPad smoke tests; it is not an isolated-only command. Those tests need
the 3002 test instance and test PIN described in [AGENTS.md](../../AGENTS.md).
Do not run the complete E2E glob against production.

## Explicit live verification — not a default

Only after verifying ownership and candidate identity of an approved test service:

```bash
TEST_URL=https://localhost:3002 node scripts/verify-shared-app.js
```

This is an example, **UNVERIFIED for the current candidate**. Supply an HTTP(S)
origin without credentials, path, query, or fragment. Missing/invalid `TEST_URL`
fails before browser startup. Local HTTPS certificate errors are ignored by this
browser-only diagnostic; it does not verify TLS trust. Page startup may call
same-origin APIs, so this live mode is not guaranteed read-only. Real iPad,
camera, microphone, model calls, Feishu delivery, and persisted learning data
require separate, explicitly scoped acceptance and cleanup.

## Verification record

Setup and issue-specific results from the 2026-09-12 home-Mac trial are recorded in
[issue-75-acceptance.md](issue-75-acceptance.md). Issue status remains authoritative
in [GitHub #75](https://github.com/blackfaced/study-buddy/issues/75).
