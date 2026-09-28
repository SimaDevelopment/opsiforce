# Backend tests are grouped by area under `test/`, and test-only code never lives under `src/`

The backend suite is keyed to *boundary* rather than to module ([testing.md](../backend/testing.md)): almost every test boots a Nest testing module over a real Postgres and enters at a route or a service that reaches several `src` areas. NestJS's own advice, "keep your test files located near the classes they test", does not fit: a test that enters at a public route and lands in `src/project`, `src/project-environment` and `src/pod` has no single home beside its source. A layout keyed to source-file location would describe the wrong thing.

**Tests are grouped by area under `test/`, one level deep.** An area with several test files gets a directory — `test/public-api/`, `test/store/`, `test/delivery/` and `test/agent-update/` — and a file drops the area prefix when it moves in. Areas with a single file stay flat at `test/`. Helpers follow the same rule one level down: `test/<area>/support/` holds helpers reachable only from that area's tests (`test/public-api/support/`, `test/store/support/`), and `test/support/` holds the ones that are genuinely cross-area. Fan-in decides membership, not taste, and it is **transitive**: `proxy-identity` stays central even though most direct importers are public-API tests, because `project-fixtures` imports it and tests outside the area import that. A helper belongs to an area only if nothing outside the area can reach it.

**Test-only code never lives under `src/`.** A colocated `*.test.ts` would be safe — `tsconfig.build.json` excludes it by the `**/*.test.ts` *pattern* — but helpers are excluded only by the `"test"` *directory* entry, and they import `vitest`, `@testcontainers/postgresql` and `@nestjs/testing`, all devDependencies that the production install (`yarn workspaces focus --production`) drops. An in-`src` helper would compile into `dist/` and ship in the image. Keeping the exclusion a one-word directory entry means it cannot be sidestepped by a filename, and it keeps the oxlint relaxation of `no-explicit-any` and `no-console` geographically visible instead of fenced only by glob. When a test really is one-module-scoped, colocation beside its source file is permitted; its helpers still are not.

Naming stays `*.test.ts`, against the ecosystem's near-universal `.spec.ts`, because the repo already diverged and both are blessed by Nest. `nest-cli.json` sets `generateOptions.spec: false` so `nest g` cannot seed a `.spec.ts` sibling. **Fast and container-backed tests are not split.** The container-free files spend nearly all their time importing and transforming the Nest module graph, and the Testcontainers Postgres costs about three seconds whether a few files run or all of them. A Docker-free lane would buy those three seconds.

## Considered options

- **Colocate every test beside a `src` module** (the framework's own advice). Rejected: for most files the "module it tests" is two to four modules, and for some it is none.
- **Mirror `src/` as a deep tree** (`test/public-api/projects/write.test.ts`). Rejected: `../../../src/…` imports, and a directory per file for the singletons.
- **Path aliases (`@test/*`) to hide the depth.** Rejected: the repo has no `paths` anywhere, adding one means editing `tsconfig.json` and `vitest.config.mts` in step, and Nest documents the drift hazard. Two dots is not a problem.
- **Rename `support/` to `helpers/`, or split it into `harness/`/`fakes/`/`fixtures/`.** Rejected: "helpers" misdescribes a fake HTTP server and a Nest testing-module factory; a split by kind gives several directories for a handful of central files, several of which straddle two kinds, and re-deepens the imports that aliases were declined for. `support/` is vague because the set is heterogeneous, which is the argument for it.
- **Split fast from container-backed via Vitest projects.** Rejected on measurement, not difficulty: `initializeGlobalSetup` only initialises projects owning a queued spec, so a non-root `integration` project's container start would be once-only and conditional with no rewrite of the `setup/env.ts` seam. It still saves only three seconds.

## Consequences

- Moving a test between areas needs no configuration change: `include: ['test/**/*.test.ts']` is recursive, `globalSetup`/`setupFiles` point at `test/setup/`, oxlint's test override is keyed on filename glob, and every helper filesystem path is a cwd-relative literal.
- The rule binds the whole opsiforce backend. It does not bind the frontend.
- `test/support/` means "used by more than one area". An import reading `../../support/…` versus `../support/…` says which kind of helper was reached for.
- Revisit the no-split decision when CI needs a Docker-free lane, or when the container-free set passes about ten files.
- Suite speed is a separate concern with a different lever: files run in parallel forks, each on its own database cloned from one Postgres container.
