# Contributing

The code and the tests are the specification. A behaviour is defined by what the packages' sources do and what
`test/` checks against PostgreSQL. A change that alters a documented behaviour changes the test that pins it in the same
commit. A consumer takes four packages, `@bjornpagen/grizzle`, `@bjornpagen/grizzle-engine`, `@bjornpagen/grizzle-openapi`
and `@bjornpagen/grizzle-text`, from the repository itself; none is published.

## Layout

The repository is a pnpm workspace of the four packages a consumer takes, a text package, an engine, the OpenAPI
document's package and a shell, the local cluster's package, the dev tools and the testing library, with the tests, benches and scripts at its root:

- **`packages/text`** (`@bjornpagen/grizzle-text`) is grizzle's text primitives and its one regex engine,
  dependency-free and browser-safe: code point order, UTF-8, XML's whiteSpace collapse and replace, the regex IR, its
  parsers, automata and printer, and the base they stand on. The engine and the shell depend on it.

- **`packages/engine`** (`@bjornpagen/grizzle-engine`) is the pure engine: the authoring API, checking, analysis,
  lowering, the installation and the migrations it plans. It has no runtime Effect: it imports from `effect` only with
  `import type`, loads no Node module but `node:crypto`, and reads no clock, randomness, environment or I/O, and nothing
  in it is async. Absence is `T | undefined`, or a named variant where the absence means something; never a sentinel.
  A pass's expected failure is the engine's Result (`packages/engine/src/core/result.ts`), and the public builders
  throw the one plain `CompileError`.
- **`packages/openapi`** (`@bjornpagen/grizzle-openapi`) is a login's OpenAPI 3.2 document, the one owner of its
  format: its writer (`src/openapi.ts`), which reads the login's served file and whose text `grizzle generate` writes
  as `openapi/<login>.json` and `grizzle check` compares, and its reader (`src/document.ts`), the client's reading of
  the login's wire back from the document's `x-grizzle-wire`, browser-safe. It reads the engine through the engine's
  facades, `plan/openapi.ts` and `plan/client.ts`, holds to the engine's rules (no runtime Effect, no Node module), and
  the shell depends on it; the engine imports nothing of it.
- **`packages/grizzle`** (`@bjornpagen/grizzle`) is the Effect shell: the adapter (`src/adapter`: the Db, the
  DbLayer, which compiles the login's workloads once at startup and checks their access paths against the snapshot,
  the wire, admission, the migration runner), the command line (`src/cli`), and `src/index.ts`, which
  re-exports the engine's authoring API so an application imports from one place. Its `skills/grizzle/SKILL.md` is the
  agent skill a consumer copies from its submodule.
- **`packages/cli-generator`** (`@bjornpagen/grizzle-cli-generator`) is the CLI generator: an OpenAPI 3.0, 3.1 or 3.2
  document, a login's `openapi/<login>.json` among them, to the source of a standalone Effect CLI. It is a package of
  its own that nothing imports (`.fallowrc.json`'s `cli-generator` zones), held to every rule of grizzle's; its pipeline
  stages, its generated runtime (`src/runtime-src`, which it writes verbatim into each package it emits, and which
  therefore imports no grizzle package) and its tests are its README's. Its code keeps its MIT license.
- **`vendor/toolchain`** is the [toolchain](https://github.com/bjornpagen/toolchain), every repository's one copy of
  the dev tools and the testing library, a git submodule pinned by commit (`git submodule update --init` after a clone
  or a pull that moves it). Its two packages join the workspace and run from source: `@bjornpagen/devtools`
  (the oxlint preset and plugin, each rule reading syntax alone, the workspace gate, the hooks' gate and the typecheck
  and oxlint commands, each rule's fixtures) and `@bjornpagen/testing`, the
  choice-stream testing library every test runs on (generators, properties, `commands`, the shrinker, the runner
  `toolchain-test`, the test rules' oxlint plugin and the source-mutation tester). Their own
  suites, fixtures and checks are the toolchain's gate, not grizzle's. grizzle's decisions for them are
  `toolchain.config.ts` at the root: its rejected rules and diagnostics, the workspace gate's exceptions, its
  Effect-free package and its packs; the plugin's names for grizzle, and every lint rule's exceptions, are
  `oxlint.config.ts`'s. A fix to either goes to the toolchain repository, and grizzle takes it by moving the
  submodule.
- **`test/`, `bench/` and `scripts/`** reach the engine's and the shell's modules through the root's `#` subpath
  imports: `#compiler/*` is the engine's `src`, `#adapter/*` and `#cli/*` the shell's, `#index.ts` the shell's entry
  point; the text package and the OpenAPI document's package they import by their names.
- **Test layering.** The test tiers, `test/unit`, `test/pg`, `test/types` and `test/schedules`, each import their own
  tier and the shared layer alone: `test/support`, and bench's shared harness, the modules a test reads beside a bench
  (`oxlint.config.ts` SHARED_BENCH), which measure time, as bench's own code does and test scope's lint refuses, so
  they stay under `bench/`. `test/support`, `bench/` and `scripts/` import no tier, and a test imports no other bench
  module. A test directory, `test/<tier>/<directory>`, reads its own modules and the shared layer's: a module two
  directories or two tiers read is shared test code, and lives in `test/support`, under its tier's name when it came
  from one (`test/support/unit/compute/support.ts`, `test/support/pg/cli/support.ts`). The root lint holds the
  tiers (`oxlint.config.ts` TEST_TIERS, `tierLayering`: an import of another tier's module, or of a bench module
  outside SHARED_BENCH, is `no-restricted-imports`).

  The root's typecheck is one program, checked by one checker (the toolchain's ONE_CHECKER), so each type it needs is
  built once: `pnpm types` took 97 s at 2.5 GB where 7 checkers took 54 to 63 s at 3.1 GB, with the same CPU, 88 s
  against 90 (TYPECOST, 2026-11-27). Its wall time would come back by programs checked side by side, one for each group
  of test directories, each reading `test/support` as declarations, which no program would then check again; but
  `test/support` emits no declarations today. Built as a composite project it refused 126 of them: 102 TS4023, an
  inferred type naming an engine type that is not exported (ArrayMember 22, Attachment 17, ParamValue 15, Fixed 15,
  UnionArm 11, NodeInspectSymbol 6, and about 20 more names once each: the scalar descriptors' `*Type` and
  `*Descriptor`, Lost, KeyNeeds, HeadEntry, Dep, DescTypes, LiteralRefusal, Migrated); 7 TS5088, an inferred type of
  cyclic structure (batch.ts checkedBatch, measured.ts measuredEach, cli/support.ts memberAt, fixtures/api/queue.ts
  queueQueries, substrate.ts lentLayer and isolatedLayer); 5 TS7056, an inferred type longer than the compiler
  serializes (fixtures/api/platform.ts's schema and programs); 2 TS4026; 2 TS6307 (env.ts reads `pg.config.ts` and
  `packages/pg/src/pin.ts`, outside the project); and 8 others (TS2305, TS2527). Without declarations each program
  checks again the support it reads: a split by tier made 39.5 million instantiations where the one program makes
  23.7 million, about 73 s and 4.3 GB side by side. The fix is grizzle's exported type surface, a design item after
  PIN 3: no inferred type that names an unexported internal (TS4023), and named level and program types where an
  inferred one cannot be written (TS7056, TS5088). It is a consumer's fix too: a package such as qti-pie's pantry could
  then emit declarations, so the ledger reads its level chain once rather than deriving it again in every program.
- **`.agents/skills/`** is the one agent skills folder: `.claude/skills` and `.cursor/skills` link to it, its `grizzle`
  links the shell's shipped skill, its `indefensible-numbers` the toolchain's
  (`vendor/toolchain/packages/devtools/skills/indefensible-numbers`), pnpm links approved dependencies' skills into it (`skills.dirs` and `permissions` in
  `pnpm-workspace.yaml`) behind its own `.gitignore` there, and a personal skill is `local-<name>`, ignored.

## Development environment

Everything runs natively on one Linux machine, Ubuntu. There is no Docker, no container image and no hosted CI, and no
git hook: a lane lands on the repository's hub behind the thin gate (the jj-lanes skill: the formatter, the lockfile,
`pnpm types` and the test files it changes), and the release check (`pnpm release`, `scripts/release.sh`) searches
both test tiers at once under the seed the release gates on before grizzle main pushes upstream. The kill census
(`pnpm kills`, `scripts/kills.sh`), every declared kill judged, runs on each pin candidate beside or after it: the
release check proves the product right, the census that each test still catches the bug it declares. A car joins a
train only once `pnpm check` passes at its own commit: the train's intake (`pnpm intake <commit>...`,
`scripts/intake.sh`) runs it at every car's commit before the train is assembled, and sends a failing car back to its
owner with its errors, so the train's gate never meets a lint, format or type error. A train's gate holds its tip to
its consumers' generates as to its tests (`scripts/consumer-leg.sh <tip> qti-pie@trunk metis=<car checkout>`), and
proves each red it judges by its replay at the tree it names (`scripts/replay-set.sh <tokens file>`, every token its
own process, each verdict with the HEAD and clean status it ran at).

- **Toolchain:** `apt install build-essential meson ninja-build pkg-config bison flex libssl-dev liblz4-dev libzstd-dev
  libreadline-dev zlib1g-dev python3 git`. You need Node 26 or later, and pnpm at the version `packageManager`
  pins; `pnpm install` patches TypeScript 7.1 beta for `@effect/tsgo` (the `prepare` script). There is no build step
  and no package: Node runs each package's `src/*.ts` directly through type stripping, and every package's `exports`
  and `bin` name its `src/` modules, so the repository, its tests and scripts, and every consumer resolve
  `@bjornpagen/grizzle` and its subpaths to the source, under no condition. grizzle is not published: a consumer takes
  the repository as a git submodule and adds `packages/engine`, `packages/grizzle`, `packages/openapi` and `packages/text` to its pnpm workspace, so each
  module's real path lies outside `node_modules`, where Node strips types, and pnpm links the `grizzle` bin to
  `src/cli/bin.ts`. A package's `tsconfig.json` extends only the repository's own `tsconfig.base.json`, by relative
  path, because a consumer's Vite reads the nearest tsconfig of every module it transforms, and a consumer installs
  none of the repository's dev tools. test/unit/dev/package.test.ts typechecks the README's programs as such a
  consumer's. Never add a bundler or a build.
- **Dependencies** are plain: no patch, no vendored fork. The runtime's one driver is node-postgres (`pg`) in pipeline
  mode, a peer dependency of the shell that the application passes in as each connection's `driver`, and
  `pnpm install --frozen-lockfile` installs everything.
- **`pnpm pg:build`** builds the pinned PostgreSQL, the official 19.0 release, unpatched, as hosted providers build it.
  grizzle carries no patch to PostgreSQL (the owner, 2026-11-20): a cost or defect of PostgreSQL's own is a known issue
  (docs/operations.md "PostgreSQL known issues") that grizzle's representation answers, and a fix for PostgreSQL goes upstream (`upstream/`). The pin is in
  `scripts/pg/pin.env`, which every script reads: the release's version, its tarball's address and the SHA-256
  postgresql.org publishes beside it, and the tag and commit the tarball is made from. The build takes its source from
  `pnpm pg:source`, runs PostgreSQL's own regression suites, and builds pgvector at its pinned tag. The installation
  goes under `~/.local/opt/postgresql/<version>/`, and every build product beside it: the tarball `<version>.tar.bz2`,
  the source `<version>.src/`, the build directory `<version>.build/`, and a staging tree in which the build is
  installed and which one rename puts in the installation's place only once it is complete, so a failed build leaves
  the previous installation as it was. An installation that already holds the pin, its stamp
  `.grizzle-build-<the tarball's SHA-256>`, is kept unless `--force` is given. While any postmaster runs from the
  installation, found by its executable wherever its data directory is, the rename is refused unless `--force` is
  given, since it would replace that postmaster's binaries under it: before the build, and again just before the
  rename. End what holds them first (a run's workers, a `pg-held` command), since a cluster runs only while it is
  held and the workbench starts none unheld (beefy da1e9fc); the next holder starts it on the new binaries.
- **`pnpm pg:source`** puts the pin's source beside the installation, extracted from the release's tarball, and the
  build directory beside it, configured to install there, each made anew. `pnpm pg:build` runs it first. The tarball is
  fetched once, kept as `<version>.tar.bz2` only once its SHA-256 is the pin's, and verified again before every
  extraction, so no other source is ever built. Nothing is ever built in the source.
- **`pg.config.ts`** states the one local cluster, which the testing library settles and reads
  (`@bjornpagen/testing/pg`): its members are the workbench's PostgreSQL units `postgres@grizzle-test-<i>`
  (~/Documents/beefy-workspace/workbench/parts/postgres), the machine's PostgreSQL 19.0, which systemd makes on a
  member's first start. A member runs only while a process holds its family: a run's worker brings up the member it
  reaches and holds it to its end, a bench or a script holds the first member for its life (`test/support/cluster.ts`),
  and the last holder's end, however it ends, stops each member (the testing library's leases and holds). A member's
  settle gives it the spec; `pnpm pg settle` (`toolchain-pg settle`) settles the family and checks its first member,
  leaving nothing running:
    - a family of members, member i listening on localhost at 5442 + i besides its socket
      (`$XDG_RUNTIME_DIR/postgresql-grizzle-test-<i>`), each serving at most 16 of a run's workers (`workersPerMember`,
      measured: SSI's LWLocks and the checkpointer are a member's own), verify-full TLS only for TCP with the workbench's
      server certificate, whose CA `$PGSSLROOTCERT` names, and the owner's password, PostgreSQL's default `wal_level`,
      replica, at which a live source's slot turns logical decoding on by itself, as production's will,
      `max_pred_locks_per_transaction = 2048`, production's, whose relation promotion PostgreSQL derives at 1023, and
      `timezone` and `log_timezone` at UTC whatever the machine's zone;
    - each member sized by `pg.config.ts` `sizing`: `max_connections` as many backends as the machine's memory holds of
      a busy one (`busyBackendBytes`, measured), shared among the members, a replication slot and a WAL sender for each,
      and `shared_buffers` each worker's largest database, no more, since PostgreSQL scans every shared buffer at each
      commit that drops a relation. Nothing admits or queues a connection: a member past its capacity refuses one
      (53300), and the measurement is taken again;
    - the same on every member whatever the machine (the testing library's settings): `client_connection_check_interval
      = 1000`, so a backend whose client died mid-statement (a test process ended by its hang guard or a SIGKILL) ends
      at its next poll of the client and lets go of its transaction id, which every logical slot's creation on the member
      waits behind, and `fsync = off`, a throwaway cluster's;
    - an unrelated CA for the refusal tests;
    - the role `grizzle_dev` (the migration identity and owner, not a superuser, with CREATEROLE to create the logins
      and world roles a migration declares, and REPLICATION), with SET on `deadlock_timeout` and on
      `session_replication_role`, which the settle grants (`pg.config.ts` `ownerParameters`);
    - `grizzle_template`, carrying pgvector in `vector_ext`, from which every test database is cloned and which accepts no
      connections. A test database runs `deadlock_timeout = 10ms` and `default_transaction_isolation = serializable` as
      its own defaults, and commits synchronously, PostgreSQL's default, so a VACUUM after a load settles the visibility
      map (`test/support/pg.ts` `testDatabaseSettings`).
- **`pnpm pg <command>`** runs the testing library's `toolchain-pg` on it: `settle`; `check`, which reads every member
  as a run does and writes nothing; `psql`, verify-full as `grizzle_dev`; `admin`, as the bootstrap superuser over the
  socket; and `run -- <command>`, the command with the first member's facts in its environment (`TOOLCHAIN_PG_*`), each
  holding the first member up while it runs.
- **`packages/pg`** (`@bjornpagen/grizzle-pg`) is the TypeScript `pnpm pg:build` runs (the postmasters that run from
  the installed build) and the pin as a typed value, a workspace member so a consumer's
  install, never one inside its submodule, gives it its dependencies; its `grizzle-pg` bin runs `build` and `source`.

Every TCP connection to the cluster, the tests' included, is verify-full TLS. The bootstrap superuser, the account's
own user, alone connects over the local socket, which trusts it: `pnpm pg admin` and the tests' superuser sessions
(`test/support/substrate/substrate.ts`). Nothing keeps a PID file: child processes are owned by an `AbortSignal`,
`await using` or a `DisposableStack`.

## How changes land

Everyone commits and pushes straight to `main`. There are no branches and no integrator; the hooks are the gate.

- A commit holds only its author's files, named by pathspec: `git commit -- <files>`. Never `git add -A`, `git add .`
  or `git commit -a`: other people's work in progress shares the tree.
- If `.git/index.lock` exists, another commit is in flight: wait until it is gone and commit again. Never delete it.
- After every edit, run `pnpm types`, the typecheck: from scratch for each project whose inputs changed, replayed for
  the rest. The pre-commit hook runs
  it again, beside oxfmt's check of the files the commit holds and the AST-only oxlint on them (the full configuration
  without its type-aware rules, so no lint program is built), and stays within seconds, since git holds
  `.git/index.lock` for as long as it runs. Both hooks check a snapshot of what they let through, never the working
  tree (`vendor/toolchain/packages/devtools/bin/gate.sh`, its snapshots under `~/.cache/toolchain-gate`), so unfinished
  files beside a commit neither fail nor pass it. A rebase skips pre-commit, so the pre-push hook runs `pnpm types` on
  HEAD. Never `--no-verify`. The full typecheck and lint, `pnpm check`, runs by hand before a release: it takes
  minutes and main moves every few, so no push waits for it. `sh vendor/toolchain/packages/devtools/bin/gate.sh run
  index pnpm check` runs it on exactly what the index holds. Tests need not
  be green to push; their failures are tracked and fixed.
- There is no changelog. The commit message is the record: one plain sentence that says what is now true, and a short
  body.

## Commands

| Command                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm types`                     | The typecheck to run after every edit, which the hooks run too: `turbo run typecheck` over each package's project and the root's, each checked from scratch in the order their references set (`pnpm typecheck` below), reading no build info (toolchain-typecheck: TypeScript 7.1.0-beta's incremental check passed an unused import over an earlier version's build info), so a run after an edit re-checks each project the edit reaches, whole, and a run after none replays from turbo's cache. It covers the pin's package too, which `pnpm typecheck` at the root does not. |
| `pnpm typecheck`                 | `toolchain-typecheck -p tsconfig.json`: tsrs, the Rust TypeScript 7.1 checker, Effect-patched by `@effect/tsgo`, over three projects joined by project references: `packages/engine/tsconfig.json`, the engine, which emits its declarations into `packages/engine/types`; `packages/grizzle/tsconfig.json`, the shell, against the engine's declarations, emitting its own into `packages/grizzle/types`; and `tsconfig.json`, test, bench, scripts and `oxlint.config.ts`, against both packages' declarations, the tooling project's own alone. Each package's `typecheck` task removes its `types/` and runs `toolchain-typecheck -p tsconfig.json` on its own project, after the projects it references. The declarations are gitignored. The three tsconfigs extend the root's `tsconfig.base.json` alone, by relative path: grizzle's module settings and the compiler's strictness. The engine's project names no plugin, so the Effect language service never compiles the engine; the shell's project and `tsconfig.json` state the plugin with their per-file `overrides`, and the workspace gate holds each to the dev tools' `tsconfig.base.json`, which lists every diagnostic the service does not deprecate, `missingConcurrencyOption` off, as the toolchain drops it for every repository. Every Effect diagnostic fails it, suggestions included. Every project is checked from scratch: toolchain-typecheck reads no build info, giving tsrs a build info file of its own run's, so a composite package, which TypeScript keeps incremental, reads none either, and refuses build mode (`-b`). Every typecheck (these three projects and the pin package's) runs `toolchain-typecheck`, the toolchain's `effect-tsgo tsrs` with the caller's arguments. The toolchain's packages are checked by the toolchain's own gate; the modules of theirs grizzle imports compile in `tsconfig.json`'s project. |
| `pnpm format`                    | oxfmt's check over the repository, with `.oxfmtrc.json`, whose ignore list leaves markdown alone. `pnpm format:write` rewrites the files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm workspace-gate`            | The toolchain's repository-wide checks (`workspace-gate`), which read the tree's JSON and git's file list and open no TypeScript program: every tsconfig that states the Effect plugin lists every diagnostic the installed service ships at the shared base's severity but those `toolchain.config.ts` rejects (`rejected-diagnostics`, `diagnostic-roster`, `effect-plugin-block`), the Effect-free package's tsconfig and manifest (`effect-free-packages`), and no JavaScript file (`ts-only-extensions`, but the one reproduction `toolchain.config.ts`'s `exceptions` names). |
| `pnpm oxlint`                    | `toolchain-oxlint`, oxlint, type-aware through tsgolint, over `test`, `bench`, `scripts`, `oxlint.config.ts`, `oxlint.ast.config.ts` and `toolchain.config.ts`; each package's `oxlint` task lints that package. `oxlint.config.ts` is the dev tools' `lintConfig` with grizzle's lists: its restrictions (the imports, globals and properties each set of paths is held to beside the preset's shared bans, a later restriction's lists whole on the files it names), the library that reads no environment and its readers, its Effect-free files (`packages/engine/**`), the plugin's names (the import doors, the naming door's brands, the tuple-returning functions a spread may take, the searches and generators `no-case-list` reads, the test helpers, the naming rule's markers) and its per-file exceptions, each with its reason. Every rule of the toolchain's plugin reads syntax alone. `oxlint.ast.config.ts` is the same configuration without its type-aware rules, which the pre-commit hook runs on a commit's files. The test rules hold in the preset's test files, `*.test.ts`, and the testing plugin's every-file rules, a clamped count and an implicit weight, in every file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm dead-code`                 | fallow (`.fallowrc.json`): unused files, exports and dependencies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm architecture`              | fallow (`.fallowrc.json`): the layering of `src` as `boundaries` zones and the zones each may import, and import cycles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm test`                      | The tests that need no network, the `unit` and `types` tiers: `toolchain-test run test/unit test/types` on the toolchain's runner (`test.config.ts`). |
| `pnpm test:network`              | The tests that talk to the local cluster, the `pg` and `schedules` tiers: `toolchain-test run test/pg test/schedules`. |
| `pnpm release`                   | The release check (`scripts/release.sh`, on `scripts/tiers.sh`): every property of both tiers searched, `toolchain-test run`, the unit and types tier (`test/unit test/types`) and, once `toolchain-pg settle` has settled the checkout's cluster family, the database tier (`test/pg test/schedules`), started together under `TEST_SEED=2219874524`, each a systemd unit of its own in `priority.slice`; each tier's lines print as they land, after its name, then its verdict and wall time; exit 1 when either tier fails. It proves the product right at its commit, and judges no kill. ||
| `pnpm kills`                     | The kill census (`scripts/kills.sh`, on `scripts/tiers.sh`): every kill each property of both tiers declares judged, `toolchain-test kills`, the two tiers at once as the release check runs them (logs under `~/.local/state/grizzle-kills/`); a kill whose red the verdict cache holds at its property's closure is answered from it. It proves each test still catches the bug it declares: a survivor, a stale kill or an unjudged one is printed under its property's line and fails it. grizzle main runs it on each pin candidate, beside or after the release check; a survivor says a test got weak, never that the product is wrong. |
| `pnpm intake <commit>...`        | The train's intake (`scripts/intake.sh`): `pnpm check` at each commit named, every commit at once, each in a detached git worktree of its own under `~/.cache/grizzle-intake/` with its submodule and dependencies installed offline, each check a systemd unit of its own in `grizzle.slice` (`grizzle-intake-<the commit's first 12 hex digits>`), every tree sharing one turbo cache, so a package no car changes is checked once (logs under `~/.local/state/grizzle-intake/`). Each verdict prints as it lands: pass, or FAIL followed by every line each failed task wrote; exit 1 when any commit fails. A car joins a train only once it passes. |
| `scripts/consumer-leg.sh <commit> <consumer>@<rev>\|<consumer>=<checkout>...` | The train's consumer leg: each consumer copied fresh (from its local hub at the commit named, or a car's checkout), the commit's grizzle laid over its vendored grizzle, the copy checked current (consumer-check.sh), and `grizzle generate` run for each of its configs as a fresh draft, each consumer a Type=exec unit of 24G in `grizzle.slice`; a verdict a config, exit 1 when any fails. |
| `scripts/replay-set.sh <tokens file> [<tsv>]` | A set of replays: each token `toolchain-test replay`ed as its own process, one after another, its row in a TSV the HEAD and dirty count it ran at, its exit and its log; a token whose tree moved or was dirty is refused, never judged; exit 1 when any failed. |
| `pnpm test:cli-generator`        | The CLI generator's property modules (`packages/cli-generator/test/support/roster.ts`), `toolchain-test run packages/cli-generator/test` on the same runner: its grizzle tier (`packages/cli-generator/test/grizzle`) alone reaches the local cluster. Its suites not yet converted to properties run on Vitest, `pnpm --filter @bjornpagen/grizzle-cli-generator test` (its `vitest.config.ts`, which leaves the roster's modules out), until the last is converted and Vitest goes. |
| `pnpm test:properties`           | `toolchain-test run [paths | property ids]`: every test module, or the paths and properties named, each property's searches; `toolchain-test kills` over the same paths judges their kills. ||
| `pnpm fuzz <fuzztime> [paths | ids]` | `toolchain-test fuzz`: fresh seeds round after round for the fuzz time (`30s`, `5m`, `1000x`) or until a case fails, as `go test -fuzz` does. |
| `pnpm check`                     | The full typecheck and lint, run by hand before a release (`sh vendor/toolchain/packages/devtools/bin/gate.sh run index pnpm check` runs it on exactly what the index holds): `turbo run` over each package's tasks and the root's, at `"concurrency": "100%"` (`turbo.json`), ordered by turbo's graph and cached, so a warm run replays what did not change. The root takes its workspace packages (`@bjornpagen/grizzle` and the toolchain's two) by `link:`, never `workspace:`: turbo hashes the source of every package the root takes by `workspace:` into every task's hash, so an edit to one package re-ran all of them, where now it re-runs that package's tasks, its dependents' and the root's, whose inputs are the whole repository. Each of grizzle's packages' `typecheck:full` and `oxlint` (`--filter=./packages/*`: the toolchain's packages are its own gate's); the CLI generator's `runtime-gate` and `benchmark` (its README); and the root's `typecheck:full`, `workspace-gate`, `oxlint`, `format`, `dead-code`, `architecture` and `dedupe` (`pnpm dedupe --check`). `typecheck:full` checks every project from nothing, never from build info, since an incremental build can keep a diagnostic or a declaration a clean one would not (microsoft/TypeScript#64386, #64591): each package removes its `types/` and builds its own project alone (`tsrs -p`), after the projects it references, and the root's checks the tooling project with `--incremental false` and writes nothing. Tests are not in it: `pnpm test` runs them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm mutate`                    | `toolchain-test mutate <file>... [--against <path or id>]... [--operator <name>]... [--sample N --seed S] [--mutant <id>]...`: operator mutation of the named source files by the testing library's operators and grizzle's two families (`test.config.ts`), each mutant run against the properties that ran its place, a measurement and never a gate. With no `--against`, every property of the repository faces it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm bench`                     | The performance gates in `bench/`, a measurement apart from `pnpm check` and from every test tier; `--quick` runs each at quick scale. `pnpm bench:full` runs them at full scale, for a quiet machine, and writes the gate listing to `bench/results/GATES.md`. `pnpm bench cold` measures cold starts, `pnpm bench dfa` the text analysis's subset construction under its two limits, `pnpm bench bytes` a 256 MiB bytes value's delivered read at each candidate chunk length, `pnpm bench bulk` one served `insertAll` call of a release the size of Learning Commons' standards core (1.1M rows: an owner with its ordered family nested in it, a plain relation, a tree over 266 roots) by its wall time, CPU, collections and peak heap (`--quick` for a small one), and `pnpm bench compile` a generated large schema's builders, generate, check, migrate's work before it connects and DbLayer.make, at a scale and at twice it (`--quick` for a small one), both with no database.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

The toolchain's runner (`test.config.ts`) runs every property's cases on one queue over one worker a core (the testing
library's `testWorkers`), never through Vite's module runner: Node runs the modules as it runs the code, by type
stripping. A case that reaches the cluster `pg.config.ts` states takes its database through a need over a template
(Substrate.fresh, freshOf, seat, rolledBack, transaction, installing: `test/support/substrate/substrate.ts`), each
worker on one member under one connection budget (`test/support/runner.ts`). Every process of a run and every child a
case spawns run under the hardened flags (`test/support/process.ts` `hardenedNode`):
`--disable-proto=delete`, `--disable-sigusr1`, `--throw-deprecation`, `--pending-deprecation`, `--force-context-aware`,
`--no-global-search-paths` and `--unhandled-rejections=strict`. V8's JIT and code generation from strings stay on: never `--jitless`,
`--disallow-code-generation-from-strings`, `--frozen-intrinsics` or `--no-addons`. Every case runs beside every other,
and all of them share one cluster's SSI state. PostgreSQL keeps a finished SERIALIZABLE transaction until every
transaction that overlapped it ends, in a pool of ten per backend the cluster admits (REL_19_0 predicate.c:
`max_serializable_xacts = (MaxBackends + max_prepared_xacts) * 10`), and once the pool is full it summarizes the
oldest, which every case's transactions then pay for. So one SERIALIZABLE transaction kept open while the cluster
commits that many, seconds at one worker per core, makes every case slower and its conflicts coarser. No case holds one
open past its own work, and roles are cluster-wide, so every case allocates unique schema and role names. The type
tier's properties check their cases a batch at a time, one
tsgo program per batch written into the batch's own directory (`test/support/types/batch/batch.ts`).

Every generated suite draws from one run seed, `TEST_SEED`. The run prints the seed first, and setting it reproduces
a run; `TEST_REPLAY='<suite>:<steering>:<tape>'` replays one case as its failure printed it, under the steering it was drawn with. Each search runs, in order
(`@bjornpagen/testing/explore`):

1. its kept cases: values promoted from failure reports into the suite's source, each replayed by value with the draws
   it records and required to still reach the situations it names;
2. a floor stream whose seed derives from the suite's label, a quarter of its cases;
3. for a suite that requires situations, a steered phase on a stream its label fixes, which grows the floor's finds
   until every required situation is reached;
4. a rotating stream drawn fresh from the run seed.

The floor stream and the steered phase are the suite's witnesses: the same cases on every run seed, so whether a suite
reaches what it requires, or stalls, depends on its label and its code alone, and a coverage failure fails every seed
alike. The rotating stream is the run's fresh sample: it finds what a fixed baseline cannot, feeds the residual
estimate, and never meets or misses a requirement.

A failure shrinks by editing its tape, to its end or for a bounded count of candidates, never for a span of wall time,
so `TEST_SEED` reproduces the shrunk case on any machine. A run never writes into the tree: the report ends with a
kept-case literal (`keep it: { … }`) to paste into the suite's `kept`. At the end of a run the reporter prints each
suite's residual risk. A longer search is a fuzz run, `pnpm fuzz <suite>`.

## Drafts and their key

`grizzle draft-key` and the draft's determinism rest on one roster of inputs, which `test/unit/cli/draft-key.test.ts`
holds this section to, member by member:

- **A draft is a function of its inputs, and `grizzle draft-key` prints their key.** `grizzle generate <config>
  [flags]` leaves the migrations directory byte for byte the same, folder names included, wherever and whenever it
  runs, given the same inputs, which grizzle names in one roster (`packages/grizzle/src/cli/draft-inputs.ts`) and reads
  and digests by one code:
  1. the command line's flags: `--name`, `--custom`, `--schema`, and each `--rename` and `--drop` in order, as
     generate reads them, never the configuration file's path or `--phases`, which writes to stderr alone;
  2. the configuration: the configuration file's bytes, and every module its import loads but grizzle's and a
     package's, each by its path from the configuration file's directory and its bytes;
  3. the lockfile: the `pnpm-lock.yaml` nearest above the configuration file, by its bytes, which names every package
     a module loads through `node_modules`, grizzle's dependencies among them;
  4. the committed migrations directory: every visible entry of the directory the configuration's `migrations` names,
     by its path there and a file's bytes; an entry whose name starts with `.`, an editor's or the scratch a write
     passes through, is none;
  5. grizzle: each of its packages' `package.json` and every file under its `src/` (text, engine, openapi and
     grizzle), by its path in the checkout and its bytes, which a commit of grizzle names;
  6. Node: the version of the Node that runs it; the variables its own code reads (`NODE_COMPILE_CACHE`,
     `NODE_COMPILE_CACHE_PORTABLE`, `NODE_COMPILE_CACHE_READONLY`, `NODE_V8_COVERAGE`, `WATCH_REPORT_DEPENDENCIES`)
     configure the runtime, never what a draft holds.

  `grizzle draft-key <config> [generate's flags]` prints the SHA-256 of exactly these, in hex on one line, each input
  by what names it in its member, never by an absolute path: a cache of generate's output keys by it and keeps no list
  of its own, so a change of the roster reaches every cache in grizzle's own commit. Nothing else reaches a draft: no
  clock, no time zone, locale or other environment variable but the ones Node reads of its own, no directory it runs
  in, no host, CPU count or randomness, and no order a file system lists a directory in (every listing is sorted). A
  configuration module that reads a file, a variable or a clock as it loads makes an input no key sees: keep the
  configuration a function of its modules. `test/unit/cli/draft-determinism.test.ts` holds the draft to its inputs:
  one source drafted from nothing and then on its committed chain by two real processes at two absolute paths, from
  three directories, in two time zones and two locales, one after the other, writes one tree byte for byte.
  `test/unit/cli/draft-key.test.ts` holds the key to them: twin projects give one key, a change of any one input moves
  it while a change of nothing the roster names leaves it, and a real `generate` under a read trace loads, reads and
  consults nothing outside the roster, and no clock.

## Code rules

- **Fully type-safe.** Both packages' `src`, `test/`, `scripts/` and `bench/` follow these rules, and the dev tools
  enforce them: oxlint (type-aware, with the toolchain's preset and plugin, `@bjornpagen/devtools`) and Effect's
  diagnostics:
    - no type assertion except `as const`;
    - no `any`, explicit, implicit or through an alias, so no `JSON.parse` and no read of a Context's `mapUnsafe`,
      whose results are `any`;
    - no non-null assertion `!`;
    - no overload signatures, a Function.dual's two call signatures included, but `withLayer`'s in
      `test/support/with-layer.ts`, which pipes call data-last;
    - no `@ts-ignore` or `@ts-nocheck`;
    - `@ts-expect-error` only in negative type tests under `test/types/`, each stating exactly the contract of its line
      (test/support/types/batch/directives.ts):
      - `// @ts-expect-error -- refused: why` where the contract is that the line does not compile;
      - `// @ts-expect-error -- refusal: <message>` for a refusal grizzle's types name;
      - `// @ts-expect-error -- twin <label>: why` for one probe written at two places, which must raise the same
        diagnostics;
      - `// @ts-expect-error -- TSnnnn: why` only where the code itself is the contract, as TS2590 is of TypeScript's
        union limit;
    - no written type at a property, parameter or return that holds both `null` and `undefined`; optional plus `| null`
      counts as both (the plugin's `no-null-undefined-union`, reading written types through the file's own aliases);
    - no absence check (`=== undefined`, `== null`, `??`, `?.`) on a value whose type admits neither `undefined` nor
      `null`;
    - no `default` in a switch whose cases already cover every member of its union;
    - no list compared by reference where its elements are its meaning: no `===`, `!==`, `==` or `!=` between two
      lists of values (arrays or tuples of texts, numbers, bigints, booleans, their brands, or lists of those), and no
      builtin `Map`, `Set`, `WeakMap` or `WeakSet` keyed by any list, since both compare references and an equal list
      built elsewhere never matches; a list is keyed by `TupleMap` or `TupleSet`
      (`packages/engine/src/core/tuple-map.ts`). Review holds this: no lint reads it but oxlint's
      `oxc/bad-object-literal-comparison`, which refuses a comparison with a written literal. Comparing two lists of
      objects by reference, to see whether a rewrite returned the list it was given, stays allowed;
    - internal modules only through `#` subpath imports with their file extension, never a relative import.

    The exceptions to the assertion ban are the assertion in `packages/engine/src/schema/record.ts` and the trust door
    `packages/engine/src/core/trusted.ts` (`trusted`, `trustedJson`), which their overrides in `oxlint.config.ts`
    allow (`typescript/consistent-type-assertions`), with their reasons. Review also rejects these loopholes:
    - a type predicate that doesn't check what it claims;
    - `unknown` narrowed without a check;
    - foreign input admitted without a narrowing reader of its own that fails closed with a typed error;
    - a value trusted anywhere but through `#compiler/core/trusted.ts`, or before its integrity is checked;
    - widening to `object` or `{}`;
    - shadow declarations.

    Brands are type-only and unchecked, each minted by one function. If TypeScript cannot prove a type claim, use the
    plainer type it can check rather than adding machinery to keep the claim alive.

- **Total records.** No optional or default parameter: absence is a variant, an `Option`, or `T | undefined` for
  "nothing found". The plugin's `no-optional-parameter` and `no-default-parameter` hold every file to it, except the
  type layer (`packages/engine/src/types/**`) and the type tests. A public input has no optional property either: a
  caller who leaves a key out states nothing, so absence is a variant the type names. Public is what a package's
  `exports` map publishes, but its `./internal/` subpaths; an input is any type a caller hands it through those
  modules, as a parameter of an exported function or constructor, of a method of what one returns, or a callback's
  return. Review holds it: no lint reads it.
- **The engine is pure.** It is the Effect-free code of `oxlint.config.ts`. Its `no-restricted-imports` refuses a
  runtime load of `effect` or `@effect/*` in `packages/engine` (an `import type` passes, through `allowTypeImports`),
  any Node module there but `node:crypto`, the driver and a platform's SDK. Its `no-restricted-globals` refuses its
  clock, timers, randomness, `Promise`, `process`, `fetch` and `WebSocket`. Because the Effect language service never
  runs there, the bans Effect owns elsewhere hold on it: no `try` (but the three files that hold its catch doors), no
  `new Error`, no `async`, strict boolean conditions, no console, no `process.env` and no `Math.random`. The engine
  validates its own API inputs natively. Effect Schema never runs in `packages/*/src` (owner, 2026-11-04; the
  `no-restricted-imports` ban passes only `import type`): what PostgreSQL answers grizzle's own statements is trusted
  through `#compiler/core/trusted.ts`, snapshot.json and meta.json are trusted once their fingerprint and seal hold where grizzle drafts, checks or migrates
  from them, an application's DbLayer trusting snapshot.json's recorded fingerprint as it stands, and every
  foreign input (the environment, CLI arguments, a DbConfig, claims) is narrowed by a reader of its own.
- **Effect, in the shell, the tests, the scripts and the benches.** Every Effect language-service diagnostic is an
  error, except the ones `toolchain.config.ts`'s `rejected.diagnostics` rejects and the per-file exceptions in the
  `overrides` of the plugin that `packages/grizzle/tsconfig.json` and `tsconfig.json` restate: the entry points that
  provide their layers, the shell's per-row hot paths, which read text, arrays and records natively, and the tests that
  play an environment or a socket. The service runs there and never on the engine. Tests and scripts read and write
  files through `FileSystem` under `NodeServices.layer`. An error is a `Data.TaggedError` whose classified case is its
  `reason`, a union of reason classes, each itself a `Data.TaggedError` rendering its own `message`, so
  `Effect.catchReason`, `catchReasons` and `unwrapReason` reach every case. What follows from a reason, such as a stage,
  is a getter, never a stored field, and `cause` holds only a foreign value wrapped. No `.match` member call in
  `packages/*/src`: the dependency audit (`test/unit/deps`) reads any as a regular expression's; read an Option with
  `Option.isSome` and `.value`.
- **Hardened Node.** grizzle works under `--disable-proto=delete` and `--disable-sigusr1`, and every test runs under
  the hardened flags (`hardenedNode`), which add that a deprecation throws and an unhandled rejection is fatal. Never
  read or write the `__proto__` accessor: a null-prototype object is the `{ __proto__: null }` literal or
  `Object.create(null)`, a key from outside is read with `Object.hasOwn`, and a record of such keys is a Map or a
  null-prototype object (oxlint `no-proto`). Nothing sends SIGUSR1.
- **A test's ids are named.** grizzle mints no ids and refuses a bare uuid column, so a test relation keyed by a uuid
  names it by `Id` (`test/support/ids.ts`), one contract every such relation shares, its values `Id(uuid)`; a
  relation that needs no uuid is keyed by its natural fields.
- **Names come from the naming door.** `packages/engine/src/core/identity.ts` is the one module that mints the
  installed identifiers' brands (oxlint `brands-sole-mint`, whose options in `oxlint.config.ts` name each brand's doors);
  elsewhere a name is admitted from text only at a decode
  boundary, the IR and snapshot decoders and the server's error reader. A test or a bench names a production
  identifier through the door, never by spelling it (oxlint `test-no-spelled-names`).
- **SQL is printed, never written.** Every SQL text grizzle sends is the engine printer's print of an AST
  (`EmittedText`, minted by `sql/emit.ts` alone) or a reviewed migration file's statement (`MigrationText`, minted by
  `adapter/migrate/input.ts`), and the printer names every type, function and relation by its schema, so no
  search_path changes what a statement means. The printer prints no statement that reads a name where nothing binds it
  (`sql/scope.ts`, an internal compiler error), and no statement another statement composes is printed apart: its text
  is its name map alone (`UnprintedSql`), by its type. The shell's catalog reads are catalog-read ASTs (`sql/catalog.ts`). A
  test's SQL that neither AST expresses is minted in `test/support/sql.ts`.
- **Tests go through the doors.** Assertions come from the testing library's door, `@bjornpagen/testing/assert`
  (`assert`, the matchers, the collection checks, the narrowers, failureOf), whose equalities type the expected value by
  the actual one, and grizzle's own, which read grizzle's types, from `#test/support/assert.ts` (succeeded, refused and
  the rest); oxlint's `import-doors` refuses `node:assert` and `isDeepStrictEqual` everywhere. Emitted SQL
  is asserted by its structure, never its text, except the migration DDL a person reviews. A member of one of `src`'s
  closed vocabularies is written where the compiler checks it. Review holds both: no lint reads them. A test asserts
  an error's tag, reason and fields, never its prose, never compares two values by their JSON text, and declares its
  features as a closed union: the library's `features` refuses `string` as its vocabulary.
- **Every test case is a search.** A test module exports properties alone (test-module-shape), each a search of the
  runner's (`property.explore`, `property.exhaust`, `property.interleave`, `property.stateful`): a case of one is a
  value of its space, never a hand-picked example. A commands program is searched by its property, and a hand schedule
  runs as an exhaustion of every interleaving. The
  performance gates are no test: `pnpm bench` runs them, apart from every tier. The mutation tester's own config
  allows examples: the tiers refuse them,
  and a mutant is judged by its tests' verdicts. The plugin's `no-case-list` refuses a search whose space is a list
  of cases: the `generator` of an `exhaust` or the `draw` of an `explore` that is `element` over a list written in the
  tests (an array literal of a test file or of `test/`, held by a constant or computed from one by a call, read from
  syntax: a list another module exports is a roster or dictionary that module declares), `constant`'s one value, a
  `map`, `span`, `drawn` or `sketched` of one, or a choice among them alone. It knows the searches and generators by
  the module the code imports them from (`oxlint.config.ts`). Whether a drawn record's field is the verdict a case
  asserts takes the drawn value's flow through the generators and the property's branches, which no syntactic reading
  decides, so the rule refuses the written list itself: a space is a box its bounds define, a dictionary or a roster
  the source declares.
- **No module state.** The plugin's `no-module-state` refuses, from what is written, a module-level `let` or `var`, a
  constant holding an array literal, an object literal with a writable property, a `new Map` or `new Set`, or a
  regular expression with a cursor, unless a readonly type, `as const` or `Object.freeze` says otherwise, and a write
  to the global object, in every file, test files included: cases of one file
  share its module, so a fixture one case can write is state the next one reads. A WeakMap or WeakSet keyed by a handle
  is a registry and allowed, and so are the stateless codecs; a cache of a derived fact is never module state, it is
  deleted. Its exceptions are overrides with their reasons, the query builder's running build
  (`packages/engine/src/query/build/scope.ts`) among them.
- **A bound is a constant with its evidence, or the caller's input.** grizzle chooses no number on its caller's
  behalf: what is a choice is an input, and what is not is a constant in the module that uses it (one every reader may
  import, where several read it), its evidence in its JSDoc: `@limitKind` `published`, `measured`, `derived` or
  `provisional`, with `@owner`, `@unit`, `@scope` and the kind's tags. The indefensible-numbers skill
  (`.agents/skills/indefensible-numbers`) is the policy; its first question is whether the cap should exist at all,
  and a cap on grizzle's own data or a caller's trusted input is deleted. PostgreSQL's page layout is
  `packages/engine/src/core/page.ts`, its protocol's message bounds `core/wire.ts`. Review holds it, a bound in a
  comparison or a clamp, in SQL text, or passed through a function included.
- **The library reads no environment.** The preset's environment bans (`environment` in `oxlint.config.ts`) hold the
  engine's and the shell's `src`: `node/no-process-env`, and no import of `node:process`'s environment or its default
  export, of any value of `node:os` but its `constants` table (the platform's numbers, which read no environment), of
  `node:v8`'s heap readings or of Effect's `Config` and `ConfigProvider` (an `import type` passes), no read of a
  `process` property that is the environment (`env`, `argv`, `cwd`, `platform`, and the rest), of `globalThis.process`
  or of `navigator`, however it is spelled; an imported value is refused at its import. The engine's own lists hold
  more beside them (its `process` global, every Node module but `node:crypto`). What the library needs is its caller's
  input. Its readers are `packages/grizzle/src/adapter/connection/environment.ts`, which refuses the variables
  node-postgres would send at a session's startup, `PGOPTIONS` and `PGREPLICATION`, and the `grizzle` command's module,
  `packages/grizzle/src/cli/main.ts`, which its bin loads, and which reads its own `argv` and `cwd` and passes them on;
  run as the program itself, it runs nothing and exits 2 naming the bin, the one entry point.
  `packages/grizzle/src/adapter/live/call-error.ts` reads the platform's errno names from `node:os`'s `constants`.
- **Regular expressions are arkregex's `regex()`**, which types a pattern's captures, everywhere, tests included (the
  plugin's `no-raw-regexp`). The exceptions are the ECMAScript oracle of the regex tests, the README mirrors and the
  dependency audit's planted controls, each an override with its reason.
- **Heavy type-level programming lives only in the query layer** (`packages/engine/src/types/query` and its neighbours).
  Elsewhere, types are plain. Type-checking cost is never budgeted: never trade precision for checker speed.
- **Representation first.** When a new case shows up, change the data so the case stops being special or stops being
  expressible, instead of adding a branch, flag, guard or sentinel. Parse at the boundary, dispatch exhaustively, and
  make invalid states unrepresentable. See `.agents/skills/representation-first/SKILL.md`.
- **Closed by default is pinned.** A relation is closed, its facts inserted and never changed or deleted, unless
  declared `mutable(R)` inside a unit its primary key leads with. Code follows the same default: readonly data, values
  rather than mutable builders.
- **Layering.** Each area of `src` imports only the areas its rule in `.fallowrc.json`'s `boundaries` allows, a DAG;
  fallow requires every `src` module to lie in a zone, and `src` never imports `test`, `scripts` or `bench`. The
  packages an area loads are `oxlint.config.ts`'s `no-restricted-imports`: `packages/engine/` loads only the types of
  `effect`, no Node module but `node:crypto`, and no driver; and no module of `src` loads a platform's SDK (Vercel,
  AWS): the caller wires a platform's credentials through `password`.
- **Tabs**, counted two columns wide in a 100-column line, in TypeScript, JSON and shell. oxfmt formats.
- **Comments state rules in plain words.** Say what the code guarantees and why. Never cite a document, a line number,
  a review, a work item or a commit, and never narrate what the code used to do. Only JSDoc on a declaration survives:
  the plugin's `no-comment` refuses every other comment but a tool's directive, and its fixer deletes them.
- **Correctness over performance.** When in doubt, pick the stronger semantics and the least surprising behaviour.
  Optimize later, behind the differential oracle.

### Settled decisions (do not reopen)

- **No silent hashing: keys at PostgreSQL's natural limits, explicit SHA-256 digests, never md5 (2026-11-20,
  2026-11-21).** grizzle holds every key, UNIQUE, family axis, reference target and drafted lookup column as itself: it
  never installs a column over a digest of its own (no SHA-256 image of a key's text or numeric, no `md5` lookup
  expression), and never rewrites a statement to compare digests. A key whose widest entry, in any order of its
  columns, could pass PostgreSQL's B-tree limit (2,704 bytes), or that holds a text of no byte bound, is refused at
  compile as `UnrepresentableKey`, naming the relation, the key, the field and the fix. A drafted lookup leaves a bounded
  column that cannot fit out of its index, a filter beside it; one that binds a text of no byte bound by equality seeks
  by the digest its relation declares, or is refused as `UnrepresentableKey` (`undigestedText`) unless its other
  equalities bind a key. The rule is docs/limits.md "Keys and indexes". A schema sizes its keys
  from its data:
  - **Key texts are bounded at PostgreSQL's natural limits.** A key's text takes the byte bound its key's B-tree entry
    leaves it (`str.bytes(keyTextBytes(fields))`), checked against the longest value the real data holds, so almost
    every table keys by its texts as themselves.
  - **Only a field whose real data does not fit spills to an explicit digest**: a field the author declares beside it,
    `generated(sha256, Crypto.sha256(row.text))`, SHA-256's raw 32 bytes, which the key holds like any other field.
    grizzle states the digest's equality wherever a read states the text's (check/checker.ts `#stateDigests`), so the
    read seeks by the digest and rechecks the text, and a query whose head copies the text carries the declared digest
    beside it, by lineage, wherever its reader equates the text (check/carry.ts): the carried column is the relation's
    own digest field, never one grizzle computes. The digest's cost stands in the schema, where its author chose it;
    grizzle never derives one.
  - **Never md5.** Every digest grizzle and its tests compute is SHA-256. md5 stands only where an outside system
    defines the digest (an integration's own, such as Timeback's), never in grizzle.

  Bjorn, verbatim, 2026-11-20: "yes, if no one requires automatic hashing, and if it's spooky action, hard revert it,
  get grizzle green, and tell all the subagents to repin. huge keys are almost certainly a bug anyways, we should never
  be getting anywhere near the hash limit for grizzle right? can we please pin and document this so this never gets
  overturned again". 2026-11-21: "my problem was never hashes, it was SILENT hashes, TRANSPARENT hashes. zig
  philosophy, costs should be EXPLICIT, not implicit. hard refactor it everywhere"; "and never md5. lmfao. sha256";
  "hard cull all md5 … except when we integrate with timeback or externally"; and on the bounds: "so, data driven.
  postgres natural limits, for any fields that don't fit we spill over to explicit digests." Why:
  - **Costs are explicit.** A digest costs a column, a computation on every write and a read that states it. A schema
    that pays them says so; a hidden one changed what every statement over the key cost at a size no one wrote down.
  - **Action at a distance.** A key that crossed an invisible width moved to a hidden column, every statement over it
    changed shape, and a reference listing the same columns in another order could decide differently from the key it
    lands on.
  - **No consumer used it.** edullm's qti, pantry and learning-commons drafts and metis's qti held no key over a digest;
    the only images were md5 lookups beside one unbounded text, which a filter serves.
  - **Its bugs.** On 2026-11-20 alone it shipped six: a first write over an imaged text key compared bytea with text; a
    numeric key's write target bound the raw field; the installed-catalog checker refused the digest function's shape;
    one text carried two images, a key's SHA-256 and a read's md5, so a read by the key scanned its table; a migration
    adding a family's image copy left stored members NULL (23502), then broke the family's CHECK (23514); and a reference deciding images at its
    own column order referenced a column no unique constraint held.
  - **Big keys are a modelling bug.** An identity is a short name, a path or a digest, never a document. A schema that
    needs a long text's identity declares its digest as a field and keys by it, in plain sight.

- **Migration bankruptcy: no installation crosses a format; purge and regenerate (2026-11-26).** grizzle reads exactly
  its own format (core/format.ts) and carries nothing of another forward: no command reads, converts or rebases another
  format's snapshot, manifest, meta.json or ledger, and no code cleans up what an older format left in a database.
  An artifact or installation of another format is refused, with one remedy: drop the installation (`grizzle
  uninstall`), empty its migrations directory, and regenerate, `grizzle generate` drafting the schema afresh as one
  init migration that `grizzle migrate` installs. A format change ships no converter, no rebase and no tolerance of the
  format before it. `grizzle generate` and `grizzle migrate` between versions of a consumer's own schema (the diff, data
  steps, renames, drift, the ledger of applied folders) are the product and stay. This replaces the 2026-11-21 ruling
  that a format change reaches a live installation by rebasing (`grizzle upgrade`, deleted with its readers). Bjorn,
  verbatim, 2026-11-26: "no need to keep migration backwards compat btw. there is too much defensive migration logic,
  let's just declare migration bankruptcy, sweep all the code to remove and purge all branches that are now moot, and
  for all of our apps like qti-pie, qti app in edullm, metis, just fully purge and regen all the schemas." Why:
  - **No app has a student**, so no installation holds rows a purge would lose.
  - **Every compatibility path is code that never runs again**: a rebase, a converter or a leftover's cleanup serves
    one crossing and then stands, tested and maintained, against states no installation of this format reaches.

### Rejected rules

The rules rejected on purpose live in `toolchain.config.ts`: `rejected.rules` for oxlint, and `rejected.diagnostics` for
Effect's diagnostics, each with its reason. A rejected rule is off in every block `lintConfig` builds, naming one in a block of
`oxlint.config.ts` is a type error (`active`), and the workspace gate refuses a tsconfig whose Effect offs differ from
`rejected.diagnostics` and the toolchain's dropped diagnostics. A rule that forces worse code is rejected in the
preset, never kept with an allow-list or worked around. A rule off for some files
only is an override in `oxlint.config.ts`, with its reason beside it. There is no inline suppression (the plugin's
`no-inline-suppression`): an exception to an oxlint rule is a per-file override in `oxlint.config.ts`, an exception to
a workspace gate rule an entry in `toolchain.config.ts`'s `exceptions`, and an exception to an Effect diagnostic a
per-file entry in the plugin's `overrides` of the tsconfig whose project holds the file.

## Tests

The suite tests the correctness, lowering and performance of grizzle's own code.

**In scope:**

- the compiler: checking, analysis, lowering and every rewrite;
- the SQL grizzle emits and the catalog objects it installs, including laws, write outcomes, witnesses, transient
  failures, migrations, admission and drift;
- worlds: what each role reads and writes, as Db.open and as a direct SQL writer that has taken it on, its claims,
  and that no error carries a value outside its world;
- the concurrency semantics of that SQL under concurrent SERIALIZABLE writers, and the refusal of every writer below
  SERIALIZABLE;
- the runtime's handling of PostgreSQL's documented results: SQLSTATE classification, transient failures, decoding,
  sessions, and cancellation a caller requests;
- the runtime's answer to a session that reports a FATAL error, loses its connection or refuses BEGIN, which the
  flight fuzzer (`test/unit/adapter/batch.test.ts`) draws on a scripted session: these are results the protocol
  documents, so how the runtime reports them is in scope, though injecting them into a real server or network is not;
- the public types, both positive inference and negative fixtures;
- performance: the bench gates, compile cost, and the plans grizzle's SQL produces.

**Out of scope**, because they are other systems' responsibility:

- network faults;
- PostgreSQL restarts, crashes or killed backends;
- operator-set server timeouts, resource exhaustion and read-only standbys;
- clock jumps;
- a host process killed or stopped.

Tests that inject such faults are not written.

**Doctrine:**

1. **Every test is significantly valuable.** A test exists only if it catches a class of bugs that nothing else
   catches. Merge or delete near-duplicates. No test at all beats a ceremonial one.
2. **An oracle, then search; never an example.** A test is an example when a person chose its inputs and wrote its
   verdict, and examples are banned (owner, 2026-11-06): a hand list run through `exhaust`, `explore` or `element` is
   one. The test run refuses a case that runs no search (the reporter's `examples`), and `pnpm check` a search whose
   space is a written list of cases (`no-case-list`). What stays:
   - a search against an oracle, over generated inputs;
   - a box exhausted, each axis drawn on its own from its bounds, its values or a roster the source declares, the
     verdict the oracle's;
   - kept cases, the shrunk failures a search left, replayed through its own property;
   - dictionaries of the values the code branches on, never of verdicts;
   - the README and SKILL mirrors, which hold the documentation to checked code.

   A module that runs no search exports no property, so the runner runs nothing of it (see "Every test case is a
   search" above).
3. **Small, tricky inputs from explicit distributions.** Generators draw few rows and short values, valid by
   construction, from a randomly chosen subset of features (swarm testing), with dictionaries of the values the code
   branches on. Plan diversity comes from perturbing the planner and drawing the thresholds a deciding function takes
   as its own parameter, not from large data.
4. **An escaped bug is a bug in the generator.** Fix the generator so it finds the bug and its relatives, then fix the
   code, then keep the shrunk case.
5. **Assert exactly the contract:** agreement with the oracle modulo what the contract leaves open, the law outcome and
   its witness, one plan per statement. Never assert SQL text, statement counts or line numbers unless the text is the
   contract, as for migration DDL a person reviews.
6. **Waits observe facts, never sleep, and no verdict depends on the clock.** A wait, such as the lock-wait barrier
   (`test/support/substrate/barrier.ts`) or the concurrency driver's, observes a fact (a lock wait in pg_locks, a
   backend gone from pg_stat_activity, a message on the wire) with no deadline; a wait that never ends is a hang, which
   the case's hang guard (`caseHang`) reports.

**A synchronous runaway ends its test process.** Node 26 cannot stop synchronous JavaScript inside a thread without
aborting the process. Termination, by a `vm` timeout or by the inspector's `Runtime.terminateExecution`, skips the
`finally` of every async scope it unwinds, and every Effect fiber resume enters one, so Node then finds its async-hook
stack corrupted. So a case is terminable only with its process. A case that yields is its hang guard's to stop, with
CaseHung. A case that holds the main thread past the moment its guard would stop it (its hang limit, or its search's cut
if that comes first) and the watchdog's grace (`watchdogGraceMillis`, vendor/toolchain/packages/testing/src/live.ts) ends its process.
The watchdog prints the case's hang report, with its replay token, on stderr; the toolchain's packages/testing/src/blocking.test.ts
holds it to that. Replay the token to reproduce the case alone.

**The testing library** (`vendor/toolchain/packages/testing`, `@bjornpagen/testing`) holds the generic testing primitives on Effect and
its runner: a choice-stream engine, where every case is a tape of bounded choices that one generator searches at random,
enumerates exhaustively, replays, mutates and shrinks. grizzle's own primitives, which know its engine and PostgreSQL, live in `test/support`. Use one
primitive per job; a suite never grows its own runner, coverage counter, seed parser, PRNG, fixed-seed sample or SQL
text match. A type agreement's requirements are its property's situations, which the runner's witnesses must reach.

| Job | Primitive |
| --- | --- |
| Search: kept cases, floor, steered and rotating streams, shrinking bounded by a count of candidates, one failure report with its replay token and kept-case literal | `@bjornpagen/testing/explore`: `explore` (`drawn`, `sketched`), `exhaust` |
| Generators on the choice stream: bounded whole numbers, elements, weighted and proportional choices, collections that state their bounds, recursion, patterns, Unicode scalars, doubles and their special values | `@bjornpagen/testing/gen`, `pattern`, `values` |
| What the cases reached: required situations and pairs, judged on the label-fixed witnesses; the Good–Turing residual over independent cases | `@bjornpagen/testing/features` |
| A state machine judged by a pure model, its programs shrunk step by step | `@bjornpagen/testing/commands` |
| Schedules: every order under sleep sets, PCT, drawn and scripted, over a driver of the system | `@bjornpagen/testing/interleave` |
| Steering by a suite's notes or by V8 block coverage | `@bjornpagen/testing/sense` |
| Choosing features and options with a floor for every choice; Live, Stale and Wild values at a public boundary | `@bjornpagen/testing/swarm`, `lsw` |
| A wait that observes a fact | `@bjornpagen/testing/fact` |
| N implementations agreeing modulo a declared equivalence (exact, order, a set that fails on a repeated item, a projection) | `@bjornpagen/testing/oracle` |
| grizzle's delivered values compared exactly: a Numeric by `equals`, its one form | `test/support/equivalence.ts` |
| Picks over 0..0xffff, a choice's floor among options | `test/support/pick.ts` |
| Identifier and literal dictionaries, admitted by the production validators | `test/support/kernel/dict.ts` |
| Emitted SQL by structure: `shapeOf` | `test/support/kernel/shape.ts` |
| EXPLAIN plans, through the one reader the tests and the benches share: node types, edges, the indexes read | `bench/harness/explain.ts` |
| SQL generated through the typed AST, and the one-hole walker over `sql/transform.ts` | `test/support/kernel/sqlgen.ts` |
| Object names through the naming door (`core/identity.ts`), and law ids and constraint names read from the engine's law model and installation (`lawIdOf`, `constraintOf`, `namesOf`) | `test/support/kernel/naming.ts` |
| The strict readers of PostgreSQL's output texts, which the trusting decoders must agree with | `test/support/kernel/strict.ts` |
| The connection-leak check: a test's roles have no session left when it ends | `test/support/kernel/sanitize.ts` |
| A schema's full world (`fullWorld`), a login's DbLayer (`loginLayer`), test tokens (`tokenOf`, `testVerify`), the oracle's one world of a script-installed schema (`oracleWorld`) | `test/support/worlds.ts` |

- **Features are semantic:** rules fired, shapes chosen, refusal reasons, plan node kinds, state-machine states, and
  pairs of them. Never SQL text, allocated names, costs or parameter values. A suite declares the features its
  population must reach, and fails when its witnesses stop reaching one.
- **Residual risk** is counted over the rotating stream, the only one that samples the generator afresh, and the
  library's reporter prints it, one line per suite.
- **Coverage steering** is part of a requirement: `coverage: required(situations, { cases, sense })`, or
  `noCoverage`, and `requiredInSpace(situations)` for an exhaustion. Every suite that requires situations states its
  steered phase, which runs only while one is unreached, on a stream its label fixes. The generator of a floor or
  steered case sees what is pending and may draw a case aimed at it: `aimed(gen, aims)` for a table of situations and
  the generators that reach them, `steered((steering) => gen, resolve)` otherwise. A property never sees steering, so
  the case an aim drew is the one the search runs, prints, shrinks, keeps and replays. Rotating cases are plain draws
  and a kept case is its sketch: they never meet a requirement, and only the rotating stream's independent cases enter
  the residual-risk estimate, whose Good-Turing assumption needs them; a witness's notes never reach that tally, by its
  type. An exhaustion steers nothing: every case of its box runs. Never raise `runs` to reach coverage: give the
  generator an arm, aim it, or give the steered phase more cases.
- **The connection-leak check runs everywhere:** a role's release waits until its backends are gone from
  pg_stat_activity. A closed session's backend always goes; a session the test never closed holds the release, its
  backends named on stderr, until the hang guard reports the test.
- **Worlds in tests:** every installation states its logins (`installMigrated(S, { label, logins, extensions })`,
  `test/support/install-migrate.ts`), each over the declared schema, and a test opens a role's Db through its login's
  layer. A fixture gets full roles, which hold every relation whole, so its programs over the base run unchanged; a
  fixture that needs more than one role states its own factory over the named schema (`test/support/fixtures/api`).
  `Installed.as`, `role` and `world` take the login or role value, never a spelled name, and a direct SQL writer is a
  session of the login that has taken on its role (`worldSession`, `worldPsql`). A schedule's direct actors take on
  their role through a login of their own, so a grizzle writer's actor is the one backend of its login.
- **The connection budget:** every connection test support opens on the cluster draws one permit of its holder's
  budget for its life (`test/support/substrate/budget.ts`): a runner worker's on its member (`test/support/runner.ts`
  `WorkerBudgets`), a bench's or a Vitest file's in a database of its own (`Substrate.isolatedLayer`), each of
  `connectionsPerWorker` permits, a test's pool, one connection per core, and the two sessions its substrate holds
  (`test/support/substrate/connections.ts`), and a child a case spawns draws from the permits the case lends it. Past
  its width an open is refused at once with `ConnectionBudgetExhausted`, a defect of the test that asked, and nothing
  ever waits its turn for the cluster: no lease, no lock and no queue stand between a process and its connections.

**The oracles:**

- **The differential oracle** (`test/pg/oracle`, `test/support/oracle`): generated schemas, data and queries run
  through three implementations on PostgreSQL, which must agree. They are the conservative lowering, the optimized
  lowering, and the reference evaluator.
- **The write oracle** (`test/pg/write/oracle`, `test/support/oracle/write`): each run draws a schema (pure sets,
  candidate keys, mutable relations, deferred and immediate foreign keys, references into candidate keys, numerics at
  typmods that round onto each other, and texts of two lengths), planner statistics and a perturbation. Its ChangeSets
  draw Stream members, bound parameters (`ChangeSet.bind`) and compiled handles (`db.compile`). Each ChangeSet runs
  through `db.apply` and through the conservative realization of the same program, and both must give the add-wins
  model's outcome, including the host's refusals, which write nothing, and a domain's refusal of a value its field
  does not admit, such as a longer text read into a shorter field. Every artifact is held to its position invariants,
  and no statement updates an immutable relation's rows in place. A TransientFailure is legitimate only where the
  model's collisions allow one, and every flight must begin SERIALIZABLE.
- **The NULL search** (`test/pg/null`): every scalar operation over operands that are each NULL or one of two values,
  exhausted (`operators.test.ts`), and drawn expressions in every position a rule or a query reads one: row checks,
  containments, keys, generated fields, folds, filters, aggregates and heads (`positions.test.ts`). The oracle is
  PostgreSQL evaluating each expression written in plain SQL from its meaning alone; grizzle's host evaluator, the
  scalar language's model, and what grizzle stores and returns must agree with it.
- **The comparison rewrites** (`test/pg/closed/null-rewrites.test.ts`): every form the lowering decides a comparison
  by, such as a concatenation's equation by its lengths or `ends_with` by `right`, in a row check, a generated field, a
  containment, a key and a query's filter. The oracle is the comparison's plain meaning restated over the drawn values:
  NULL at a NULL operand, and Kleene's AND, OR and NOT.
- **The history checker** (`test/support/history`): generated concurrent writers, run in an order a PCT schedule
  chooses, so a history is seeded, shrinkable and replayable. It's checked after the fact:
    - every law must hold on the committed state;
    - the state must be one some real-time-respecting serial order reaches;
    - every `invariant-rejected` must name a law the operation really violates there;
    - every abort, and every discarded transient, must have a cause the history explains: an overlapping operation, the
      touched participant of the law.
- **The concurrency driver** (`test/support/schedules/interleave.ts`): the one driver for every concurrent test. Its
  strategies are every order of the sessions' steps, reduced by sleep sets; one PCT order for larger races; and a
  script, which runs a hand schedule (`runner.ts` compiles the schedule DSL into one). Each run records what the
  database did at every decision point. A replay that meets something else, such as another deadlock victim, is a
  branch of its own, judged by the model and never a failure. Before every decision with a blocked step, the driver
  waits on the server until each blocked step's deadlock check is past. Law races are generated per family
  (`test/schedules/laws/races.ts`).
- **The law families** (`test/pg/laws/families`, and the native projection families in `test/pg/laws/projections`):
  each family (the law-family box of selected-source containments, containments into a selected target, mirrors,
  alternatives and span coverage; alternatives over a single and a composite key; a work queue; span coverage, also
  into a target whose fields are named apart and declared in another heading order; timekeeping) draws schemas from
  its whole parameter space and judges writes against a host model of the laws (`test/support/laws/model.ts`),
  including span keys, span coverage and row checks. Every law is native, so a refusal names its law's constraint. The
  same schemas drive concurrent histories, generated races and a direct SQL writer (`direct-*.test.ts`).
- **The families and trees** (`test/pg/fin`, `test/support/families`): the fin lemmas per direction, ordered and
  counted families, folds, the plans and edits grizzle's apply sends, and the tree theorem over an exhaustive box of
  forests over two root values, all on PostgreSQL. The oracle is the families model, the theorem a family's
  constraints hold (`theorem.ts`) with the moment PostgreSQL checks each one, and for trees a direct pre-order
  numbering (`tree.ts`). `capacity-table.test.ts` holds each capacity shape (at most, at least or exactly one, a count
  in a range or at least a field, a weight, a duration, a counted selection, a source equal to its target) to its native
  law over a box of states.
- **The fill order** (`test/unit/write/fill-order.test.ts`, `test/pg/write/fill-order`): drawn schemas of trees,
  ordered and counted families nested in each other, folds and copies. A schema compiles exactly where the reference
  model (`test/support/families/fill.ts` `verdictOf`) admits it, refused for the cause it names, and on PostgreSQL its
  first insert and a drawn follow-up store exactly the reference writer's rows (`writtenRows`).
- **The family swarm** (`test/pg/write/swarm/families.test.ts`): schemas of up to 24 relations with every family kind,
  cycles of families, copies of copies and fold ends, and ChangeSets of up to three strata and 150 facts and more, run
  through `db.apply`. Its oracle (`oracle.ts`) never consults grizzle's writer: the stored rows are the reference
  writer's, a refusal names only laws the law model finds broken, and a compile refusal is one the reference justifies.
- **The entry-owner box** (`test/support/families/entry-owner.ts`): a family's owner written through a role's query
  entry, over every head, filter, op and fact. Without PostgreSQL (`test/unit/write/entry-owner.test.ts`) the box's
  specification is the oracle: a role is refused exactly when its entry's filter reads a family field, and every other
  write compiles and binds.
- **The law model** (`test/unit/laws`): the native constraints mean what the laws mean, so over every state of the
  boxes the installation accepts a state exactly when the host model finds every law holds (`native.test.ts`); each
  law shape's model in `model/`; and an installation's objects, its total and its snapshot grow at most linearly in
  every schema dimension, compared at n and 2n as AST node counts (`scaling.test.ts`). The catalog verifier
  (`test/support/catalog/verify.ts`) holds that no law trigger exists, every law being native.
- **The worlds model** (`test/support/worlds`): a model of installations, sessions, actions and observations,
  independent of grizzle's source (laws are judged by the host law model), checked against the real system
  (`execute`), which installs a drawn installation through its first migration and performs each action as grizzle's
  caller or as a direct SQL writer would. Each action's observation must be one the model allows, no value hidden from
  the acting session may appear in anything grizzle answered, every stored relation must hold exactly the model's facts
  and every open session's connection probe as the model expects, and the model's state keeps every invariant. Its
  suites: programs over a documents base, each suite's aimed at what its area must reach (isolation, rules, least
  privilege), and inductive single steps from drawn states (`test/pg/world-model`); concurrent races (`test/schedules/worlds`); and the school system's
  installation (`test/pg/education`). The rules suite (`test/pg/world-model/rules.test.ts`) meets every law family the
  docs/schema.md "Rules" lists with writes through partial worlds, and holds every shown witness to values the writer
  submitted or holds whole.
- **The protocol tap** (`test/support/wire-tap.ts`): a session whose every message, both ways, a test reads off the
  wire, on grizzle's public transport: its sockets are in memory, its server end answers the SSLRequest and terminates
  verify-full TLS with the tap's own CA (`test/support/memory-tls.ts`), and the tap carries the plaintext over its own
  verified TLS to the cluster. The scripted-session suite (`test/pg/adapter/flight.test.ts`) holds what a flight's
  session observes, interrupted anywhere, to what the server observed.
- **Startup work** (`test/unit/startup`): the calls a schema's build, `grizzle generate`, `check`, `migrate`, `drift`
  and DbLayer.make make to the schema's encoding and compilation, read off V8's call counts
  (`test/support/kernel/calls.ts`) and never timed. Each whole-schema pass runs once, migrate and drift compile nothing
  before they connect, and every count grows at most linearly from n to 2n. `pnpm bench compile` times the same work
  over a large generated schema; its record is information, never a verdict.
- **The mutation tester** (`pnpm mutate`, the toolchain's `toolchain-test mutate`): it breaks rewrites, proofs, guards,
  runtime decisions and, with grizzle's operator families (`test/support/mutation/families.ts`, given to it by
  `test.config.ts`), a bag read as a set (`set-semantics`) and the SQL that installs and enters a world (`sql-world`),
  in the source files it is named, and runs each mutant against the properties whose cases ran its place, by the
  runner's coverage map, in process or, for a property that needs `Checkout.dir`, in a tree of its own. It measures
  whether the properties kill the mutants of the code they target, and gates nothing: a survivor becomes a generator
  feature and, where it names a bug a property must catch, a kill on that property, which the kill census
  (`pnpm kills`) judges on each pin.
- **Type tests** (`test/types`): properties on the toolchain's runner whose cases are entries of a generated program.
  A batch of cases is one program (`test/support/types/batch/batch.ts`), checked once by tsgo in the batch's own directory,
  armed or disarmed: disarmed, every `@ts-expect-error` must fail with exactly the diagnostic it names, printing
  `Refusal<"<message>">` exactly where the directive names that refusal, and no other line may fail. Each diagnostic
  belongs to whoever answers for its line, one case or the batch, so each case's verdict is its own lines' and a
  failing case prints, shrinks and replays alone. A drawn population is an `agreement` (a batched search of its
  generator); a box of the source's own rosters is a `boxAgreement` (an exhaustion of its cells); a type cost gate is an
  exhaustion of its dimensions, each checked at three sizes under the growth law (`test/support/growth.ts`). The
  README's and `packages/grizzle/skills/grizzle/SKILL.md`'s `ts` blocks are checked code: each is mirrored line for
  line in one fixture of `test/types/examples/fixtures`, the README's in `readme.ts` (what grizzle compiles: schemas,
  roles, logins, workloads, programs, the configuration) or `readme.app.ts` (the application, which reads the served
  files), SKILL.md's in `skill.ts`, which `pnpm typecheck` checks; the README's refusals are a box of their own;
  `test/types/examples/blocks.test.ts` holds every block to its fixture, so an edit to a block alone fails; and
  `test/types/examples/generates.test.ts` runs `grizzle generate` over every login `readme.ts` exports, each program
  it exports served by one of them, and holds every `sql` block of the README to the SQL that run drafts. Every tsgo check is under a stall guard (test/support/types/batch/compiler.ts): a check whose process tree
  makes no CPU progress for `stallWindow` fails with CompilerStalled, carrying the goroutine dump tsgo prints on
  SIGQUIT, never hangs.
- **The type/engine agreements** (`test/support/agreement`): drawn schemas, ChangeSets, workloads, roles' access,
  computations, recursion and configurations, each case rendered as a block of a TypeScript program a batch checks,
  and built through the engine. The engine is the oracle (for a configuration, the reader DbLayer.make runs):
  a program typechecks exactly when the engine admits it, each refusal under a directive naming its diagnostic, and
  every type the program infers equals what the engine describes. A generated program imports every repository name
  through its prelude (`test/support/programs`, read by `test/support/prelude.ts`), real export statements fallow
  reads as an entry, so fallow counts each name a population reads as used, and the compiler checks that each one
  exists.
