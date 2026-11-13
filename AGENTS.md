# Repository Guidelines

## Project Overview

dsh-superagent is a **research prototype** (not production software — see README disclaimer): a proactive coding agent for a single GitHub repository, packaged as a bundle for DeepSeek Harness (DSH). It listens to GitHub and optionally Feishu and Jira, evaluates incoming requests under a Policy, turns authorized ones into Tickets, and executes each in its own DSH Session and working directory. A web management panel shows what needs a person.

Design goal: take as little human attention as possible. The agent acts only when asked or when a team-written rule allows it. Read `docs/000-philosophy.md` through `docs/008-cookbook.md` in order — they are numbered and build on each other; `docs/007-architecture.md` is the authoritative module map.
> ⚠️ **AGENTS.md is runtime input**: worker agents read the repo's `AGENTS.md` (`prompts/work.md`, `prompts/worker.md`). Keep it operational and secret-free; never contradict `src/policy.ts` or the tool checks.

## Architecture & Data Flow

Layered architecture with strict dependency rules (`docs/007-architecture.md`):

```
Source plugins (github / feishu / jira)
  → Triggers → Engine (src/core, pure domain, no I/O)
    → Evals (admission gate) → Decisions → Tickets → Assignments
      → DshExecutor (one DSH Session + directory per Ticket)
  → Outbox → Source Channel (replies back to the conversation)
  → HTTP routes + views → web panel (src/client)
```

- `Runtime` (`src/app/runtime.ts`) is the composition root: locks the state dir, opens the `Store` (SQLite), builds all components, owns startup/shutdown. No domain rules live here.
- `Engine` (`src/core/engine.ts`) is the only writer of Triggers, Threads, Decisions, Tickets, Assignments. All methods synchronous; each command mutates aggregates in one transaction. Delegates to five parts: `Intake`, `Evals`, `Tickets`, `Assignments`, `Replies` (`src/core/*.ts`).
- Ports in `src/core/ports.ts`: `Repositories`, `Policy`, `SourceScope`, `Assessor`, `Executor`, `Outbox`. Callers get a role-scoped `Pick` of Engine (`EngineForSources`, `EngineForMainSession`, `EngineForPeople`, `EngineForSettings`, `EngineForExecutor`).
- `Effects` (`src/app/effects.ts`): durable side-effect queue; `enqueue` inside a transaction, execution after commit, exponential-backoff retry.
- `Outbox` (`src/app/outbox.ts`): sole writer of message receipts; sends replies via `SourceRegistry.send`.
- Sources implement `SourceKind` (`src/sources/kind.ts`); `SourceRegistry` owns kinds/instances; plugins see only `SourceHost`/`SourceContext`.

## Key Directories

| Path | Purpose |
| --- | --- |
| `src/core/` | Domain model, Engine + 5 parts, ports, errors, reasons. **No imports outside itself except Node hashing; no I/O.** |
| `src/app/` | Adapters/glue: Runtime, Store, Effects, Outbox, HTTP API, views, sessions, prompts, settings, tools |
| `src/sources/` | Source plugins: `github*`, `feishu*`, `jira*`, `kind.ts`, `registry.ts`, `poll.ts`. **May not import from `src/app`.** |
| `src/executor/` | `DshExecutor` (Session/directory per Ticket) and worker background-job management |
| `src/infra/` | CLI transport (`commands.ts`), worker env (`environment.ts`), paths, health board, text utils |
| `src/client/` | Web panel (React, built separately as CJS) — imports only types from host side plus a small allowlist (see doc 007) |
| `prompts/` | Model-facing system-prompt text loaded from disk at import time (`src/app/context.ts` via `promptFile`); one sentence per line. Renaming a file needs synchronized edits in `context.ts`, `prompts.ts` (`PART_KEYS`), and `docs/004-prompts.md` |
| `skills/` | Bundled agent skills (`dsh-superagent-github`, `dsh-superagent-feishu`); strict `SKILL.md` frontmatter (name + description) enforced at startup |
| `tests/` | Vitest specs; `tests/fixtures/` has shared fakes (simulated DSH host, panel server, deployment, git env, async) |
| `docs/` | Numbered docs 000–008; `docs.spec.ts` enforces link ordering and table completeness |
| `scripts/dsh-superagent` | Python service manager for a local DSH profile (status/start/restart; exit codes 0–3) |
| `locale/` | Bundle metadata i18n only (`meta.title`/`description`); **panel copy lives in `src/client/locales.ts` — edit that, not these files** |
| `.artifacts/` | Local runtime state/logs — never commit, never edit |
| `cordis.patch.yml` | Bundle patch: inserts main + `github-watch`, `feishu-watch`, `jira-watch` plugins (Feishu/Jira disabled) + worker/router agent presets; validated by `tests/bundle-patch.spec.ts` |

## Development Commands

| Command | Does |
| --- | --- |
| `pnpm check` | Full gate: typecheck + tests + build — run before finishing |
| `pnpm typecheck` | `tsc --noEmit` (strict, NodeNext) |
| `pnpm test` | `vitest run` (`tests/**/*.spec.{ts,tsx}`) |
| `pnpm exec vitest run tests/core-engine.spec.ts` | Single spec (no build needed; tests run on TS directly) |
| `pnpm exec vitest run -t "name"` | One test by name |
| `pnpm build` | `tsdown` → `lib/` (ESM + `.d.ts` for host; CJS bundle for client) |
| `python3 scripts/dsh-superagent start\|stop\|restart\|status [--profile superagent]` | Manage local service; exit codes: 0 running, 1 stopped/broken, 2 component error, 3 waiting for setup |

## Code Conventions & Common Patterns
- **Naming**: imperative verbs for commands that may be refused (`stopTicket`, `bindThread`); past tense for adapter-reported facts (`assignmentStarted`, `deliveryFailed`); noun for queries (`candidate`).
- **Every class needs a JSDoc block** — `tests/class-docs.spec.ts` enforces it.
- **Errors**: user/agent-caused refusals are `UserError(code, values)` from `USER_ERRORS` (`src/core/errors.ts`); HTTP maps `missing` → 404, others → 400. Setup problems are `SetupError` codes (`src/setup.ts`); health texts are fixed `HealthCode`s (`src/sources/host.ts`).
- **Imports use explicit `.ts`/`.tsx` extensions** everywhere, including tests (`from '../src/app/store.ts'`); tsdown rewrites them to `.js` on build.
- **Style**: no semicolons (except SQL/`for` headers), single quotes, 2-space indent; kebab-case files, PascalCase classes, `*Host`/`*Schema`/`*View`/`*Code` suffixes, snake_case only in wire/tool payloads. No formatter — match the file.
- **One writer per state** — Engine writes aggregates; Outbox writes receipts; Settings writes settings; each health entry has one claimant. Never write another part's state.
- **Dependency injection**: narrow `Pick`-typed host interfaces (`ExecutorHost`, `AssessorHost`, `SessionsHost`, `SettingsHost`, `HttpHost`, `MainToolsHost`, `SourceContextDeps`, …). Runtime passes itself only behind such interfaces.
- **Side effects**: enqueue `Effects` inside the transaction; adapters execute after commit (`Store.afterCommit`). `Later` defers without counting a failure.
- **Async**: Engine methods are synchronous; all I/O lives in `src/app`, `src/sources`, `src/infra`.
- **Doc comments**: prose explains *why* and invariants, often in the doc's own terminology (Trigger, Thread, Ticket, Assignment, Eval, Decision, Mandate — see glossary in `docs/001-domain.md`).
- **Docs**: when adding/renaming a module or test file, update the Modules/Tests tables in `docs/007-architecture.md` in the same commit — `tests/docs.spec.ts` checks they list every `src/**` file and every spec (both directions).
- **Adding a Source** is one contract across five places: `src/sources/<k>.ts`, a tsdown entry, `"./<k>-watch"` in `exports`, an insert row in `cordis.patch.yml`, and 007 table rows (`docs/008-cookbook.md` is the recipe).
- **Model-facing text is budgeted**: `tests/model-surface.spec.ts` caps prompt+tool surface (~59k orchestrator / ~40.5k worker chars) and bans retired terms (`member`, `topic`, `task/`…).
- **i18n**: all panel copy keyed in `src/client/locales.ts` (zh/en/vi triples); reason codes worded by `reason.<code>`.

## Important Files

- `src/index.ts` — main plugin entry (cordis `apply`, `inject` list, mounts Runtime)
- `src/deployment.ts` — plugin `Config`/`Machine`, deployment resolution
- `src/policy.ts` — settings schemas, admission gate, Mandate revalidation
- `src/kv.ts` — every `kv` record family, key, value type, owner
- `src/core/engine.ts` + `src/core/ports.ts` — domain entry point and ports
- `src/app/runtime.ts` — composition root; `src/app/store.ts` — SQLite Store + migrations (`migration.ts`, schema 11)
- `src/app/api.ts` — typed management API consumed by panel and `src/client/api.ts`
- `src/sources/{github,feishu,jira}.ts` — Source plugin entries (also bundle exports `./github-watch` etc.)
- `src/client/index.tsx` — panel plugin entry
- `tsdown.config.ts` — two builds: node ESM for host, browser CJS for client with `?raw` plugin
- `cordis.patch.yml` — bundle wiring; `examples/profile.cordis.patch.yml` — example

## Runtime/Tooling Preferences

- **Node `^22.19.0 || >=24.0.0`**, DSH `^0.2.1-alpha.2`, **pnpm 11.7.0** (packageManager field; use pnpm, not npm/yarn).
- TypeScript strict + `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `NodeNext`, `allowImportingTsExtensions` — **imports use `.ts` extensions** (`import { Runtime } from './app/runtime.ts'`).
- ESM (`"type": "module"`); client bundle is CJS wrapped for DSH's `__ModuleLoader__`.
- `@deepseek-ai/*` packages are peers — never bundle them (`neverBundle` in tsdown).
- Only runtime deps: `zod`, `proper-lockfile`. Keep it that way.
- No linter/formatter configured; match the existing dense, comment-heavy style. Use `pnpm typecheck` as the style gate.

## Testing & QA

- Framework: **Vitest 4**, node env by default; jsdom is opted in per file with a first-line `// @vitest-environment jsdom` (all `panel-*`/`client`/`controls`/`navigation` specs). `vitest.config.ts` dedupes react/react-dom (React 18).
- Specs live in `tests/*.spec.ts(x)`, ~one per src domain. Flat top-level `it`s are the norm (`describe` in only 12 files); names are full behavioral sentences; `it.each` for matrices. No snapshots.
- Filter a file with `pnpm test tests/policy.spec.ts` (args forwarded); subprocess-heavy suites raise timeout via `vi.setConfig({ testTimeout: 30_000 })`.
- Shared fakes in `tests/fixtures/`: `host.ts` (`startRuntime()` — full app on a simulated DSH host, `Commands.prototype`/`subprocess.spawn` stubbed), `panel-server.ts`/`panel.tsx` (typed fake management API + mounted page; undeclared request params fail the test), `deployment.ts`, `git.ts` (`gitEnv()` isolates nested git), `async.ts`. Reuse them rather than writing new mocks.
- Domain tests run on `MemoryRepositories` (`src/core/memory.ts`) — same interface as the SQLite Store, no I/O. Panel tests select by `zh` copy from `src/client/locales.ts` and always `await settle()` after interactions.
- Structural guardrails: `docs.spec.ts` (docs tables complete, links ordered), `class-docs.spec.ts` (JSDoc on every class), `model-surface.spec.ts` (model-visible surface within size budget), `locales.spec.ts`/`styles.spec.ts`.
- No coverage threshold configured; `pnpm check` (typecheck + test + build) is the definition of green.

## Quy tắc làm việc (Working Rules)

- Không dùng tiếng Trung; mọi description và comment viết bằng tiếng Việt.
- Không comment trong code; chỉ giữ một dòng ngắn nếu thật sự quan trọng hoặc được reuse ở nhiều nơi.
- Tuân thủ tuyệt đối kiến trúc và code style hiện tại của repo.
- Sau khi hoàn thành mỗi task: đề xuất việc nên làm tiếp theo, nên sửa gì, hoặc gọi advisor để tư vấn thay vì tự quyết.
