# Contributing

The code and the tests are the specification. A behaviour is defined by what the packages' sources do and what
`test/` checks against PostgreSQL. A change that alters a documented behaviour changes the test that pins it in the same
commit. The two packages are published to npm as `@bjornpagen/grizzle-engine` and `@bjornpagen/grizzle`.

## Layout

The repository is a pnpm workspace of two published packages, an engine and a shell, the dev tools and the testing
library, with the tests, benches and scripts at its root:

- **`packages/engine`** (`@bjornpagen/grizzle-engine`) is the pure engine: the authoring API, checking, analysis,
  lowering, the installation and the migrations it plans. It has no runtime Effect: it imports from `effect` only with
  `import type`, loads no Node module but `node:crypto`, and reads no clock, randomness, environment or I/O, and nothing
  in it is async. Absence is `T | undefined`, or a named variant where the absence means something; never a sentinel.
  A pass's expected failure is the engine's Result (`packages/engine/src/core/result.ts`), and the public builders
  throw the one plain `CompileError`.
- **`packages/grizzle`** (`@bjornpagen/grizzle`) is the Effect shell: the adapter (`src/adapter`: the Db, the
  DbLayer, which compiles the login's workloads once at startup and checks their access paths against the snapshot,
  the wire, admission, the migration runner), the command line (`src/cli`), and `src/index.ts`, which
  re-exports the engine's authoring API so an application imports from one place. Its `skills/grizzle/SKILL.md` is the
  agent skill `grizzle skill` installs.
- **`packages/devtools`** (`@grizzle/devtools`) is grizzle's lint tooling: the oxlint preset (`src/preset.ts`, with the
  `REJECTED` and `REJECTED_DIAGNOSTICS` maps), the oxlint plugin, superlint, the tsconfig base and each rule's fixtures,
  which the gate's `fixtures:superlint` and `fixtures:oxlint` tasks check.
- **`packages/testing`** (`@grizzle/testing`) is the choice-stream testing library every test runs on: generators,
  `explore`, `exhaust` and `commands`, the shrinker, the Vitest adapter, the test rules' oxlint plugin, `pnpm fuzz`'s
  script and the source-mutation tester (`scripts/mutate.ts`). Its own suite and bench (`src/*.test.ts`, `src/engine.bench.ts`) are its `test` and `bench`.
- **`test/`, `bench/` and `scripts/`** reach both packages' modules through the root's `#` subpath imports: `#compiler/*`
  is the engine's `src`, `#adapter/*` and `#cli/*` the shell's, `#index.ts` the shell's entry point.

## Development environment

Everything runs natively on one macOS machine through Homebrew. There is no Docker, no container image and no hosted
CI. The git hook lefthook installs (`lefthook.yml`) is the CI: pre-commit runs `pnpm check`, except during a merge or a
rebase, and only refuses a failing commit; it never formats or stages a file.

- **Toolchain:** `brew install node pnpm meson ninja pkgconf bison flex openssl@3 lz4 zstd readline`. You need
  Node 26 or later, and pnpm at the version `packageManager` pins; `pnpm install` patches TypeScript 7.1 beta for
  `@effect/tsgo` (the `prepare` script). Development has no build step: Node runs each package's `src/*.ts` directly
  through type stripping, and tests and scripts import src. The repository resolves its own package names to their
  `src/` (`packages/grizzle/src/index.ts`, `packages/engine/src/index.ts`) through the `grizzle-source` export
  condition, which comes first in each package's `exports`: `tsconfig.json`, `packages/grizzle/tsconfig.json` and the
  type-test batch's programs name it in `customConditions`, and every Node process the repository starts on its own code
  passes `--conditions=grizzle-source` (`test/support/process.ts` `sourceCondition`), while a consumer never names it
  and so resolves `dist/`. The published packages are the one build: `pnpm build` (scripts/build.ts, which each
  package's prepack runs before `npm publish`) emits each package's `dist/`, each module stripped by Node's own
  `stripTypeScriptTypes`, so dist keeps src's lines and columns, and the declarations `tsc -b` emits into each package's
  `types/`, with src's `#` imports rewritten to relative paths, and the shell's `#compiler/` imports to the engine's
  `@bjornpagen/grizzle-engine/internal/` subpaths. test/unit/dev/package.test.ts installs that build under a consumer's
  node_modules and loads, runs and typechecks it. Never add a bundler.
- **Dependencies** are plain: no patch, no vendored fork. The runtime's one driver is node-postgres (`pg`) in pipeline mode, and
  `pnpm install --frozen-lockfile` installs everything.
- **`pnpm pg:build`** builds the pinned PostgreSQL, 19rc1, from source. The pin is in `scripts/pg/pin.env`, which
  every script reads. The build verifies the tarball's SHA256, applies the pin's source patches (`scripts/pg/patches/`,
  each checksummed in pin.env and applied without fuzz), runs PostgreSQL's own regression suites, and
  builds pgvector and plpgsql_check (2.10.15) at their pinned tags. The installation goes under
  `~/.local/opt/postgresql/<version>/`, the source under `~/.cache/grizzle/src/`.
- **`pnpm pg:init`** creates the cluster under `~/.local/var/grizzle/pg<version>/`:
    - a builtin C.UTF-8 cluster on port 5433, localhost only, with TLS 1.3, SCRAM, and only `hostssl` lines for TCP, and
      `max_pred_locks_per_transaction = 2048`, room for the predicate locks of many SERIALIZABLE transactions at once;
    - a local CA and server certificate, plus an unrelated CA for the refusal tests;
    - the role `grizzle_dev` (the migration identity and owner, not a superuser, with CREATEROLE to create the logins
      and world roles a migration declares), with SET on `lc_messages` and `deadlock_timeout`;
    - `grizzle_template`, from which every test database is cloned and which accepts no connections. A test database
      runs `deadlock_timeout = 10ms` and `default_transaction_isolation = serializable` as its own defaults
      (`test/support/pg.ts` `testDatabaseSettings`).
- **`pnpm pg:doctor`** is the go/no-go check: version and build, `jit` off, `max_pred_locks_per_transaction`,
  extensions, locale, money formatting, `ON CONFLICT DO SELECT`, verify-full TLS with a wrong CA, a wrong host name
  and plaintext all refused, and the owner's SET on `lc_messages` and `deadlock_timeout`. `--quick` runs the checks
  that need no scratch database, and every database test run starts with it.
- **`pnpm pg <command>`** runs `scripts/pg/ctl.sh`:
    - `start`, `stop` and `status`;
    - `psql`, verify-full as `grizzle_dev`;
    - `admin`, as the bootstrap superuser over the socket;
    - `env`, which prints a `DATABASE_URL`;
    - `reset`, which drops test databases and roles.
- **The coverage cluster** is a second cluster, on port 5435, set up like the main one and preloading plpgsql_check
  with its profiler on, for PL/pgSQL coverage: `scripts/pg/init.sh --coverage` creates it, and `ctl.sh --coverage`
  (`pnpm pg:coverage`) and `doctor.sh --coverage` drive and check it. A test run uses it when `GRIZZLE_PG_CLUSTER` is
  `coverage`.

Every connection to the cluster, the tests' included, is verify-full TLS over TCP. Nothing keeps a PID file: child
processes are owned by an `AbortSignal`, `await using` or a `DisposableStack`.

## Commands

| Command                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                 | `effect-tsgo tsrs -b`: tsrs, the Rust TypeScript 7.1 checker, Effect-patched by `@effect/tsgo`, over three projects joined by project references: `packages/engine/tsconfig.json`, the engine, which emits its declarations into `packages/engine/types`; `packages/grizzle/tsconfig.json`, the shell, against the engine's declarations, emitting its own into `packages/grizzle/types`; and `tsconfig.json`, test, bench, scripts and `oxlint.config.ts`, against both packages' declarations. Each package's `typecheck` task runs `tsrs -b` on its own project, after the projects it references. The declarations and the build info are gitignored. The three tsconfigs extend the dev tools' `tsconfig.base.json`, the compiler's strictness and the Effect language service with all 130 of its diagnostics listed, and the root's `tsconfig.base.json`, grizzle's module settings. The engine's project clears the plugins, so the service never compiles the engine; the shell's project and `tsconfig.json` restate the plugin to add their per-file `overrides`, and root superlint holds each restatement to the base. Every Effect diagnostic fails it, suggestions included. The two package projects are composite, which needs incremental build info; `tsconfig.json` builds without it. The dev tools and the testing library check on their own with `--noEmit`, the testing library's tsconfig extending `tsconfig.json`. |
| `pnpm format`                    | oxfmt's check over the repository, with `.oxfmtrc.json`, whose ignore list leaves markdown alone. `pnpm format:write` rewrites the files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm superlint`                 | superlint (`packages/devtools/src/lint.ts`), the type-aware rules on TypeScript 7's native API, over the tooling project (test, bench, scripts). At the root it also holds every tsconfig's Effect diagnostics to `REJECTED_DIAGNOSTICS`. Each package's `superlint` task lints that package's own program. grizzle's names for the rules (the files and emitted-text type `sql-text-assertion` reads, the vocabularies `unchecked-vocabulary-literal` guards) and its exceptions are the `superlint` field of the root `package.json`. `pnpm superlint <files or dirs>` lints those alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm oxlint`                    | oxlint, type-aware through tsgolint, over `test`, `bench`, `scripts` and `oxlint.config.ts`; each package's `oxlint` task lints that package. `oxlint.config.ts` is the dev tools' `lintConfig` with grizzle's lists: its restricted imports, its Effect-free files (`packages/engine/**`), the plugin's names (the import doors, the naming door's brands, the test helpers, the naming rule's markers) and its per-file exceptions, each with its reason. The test rules hold in the preset's test files, `*.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm dead-code`                 | fallow (`.fallowrc.json`): unused files, exports and dependencies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm architecture`              | fallow (`.fallowrc.json`): the layering of `src` as `boundaries` zones and the zones each may import, and import cycles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm test`                      | The tests that need no network, the `unit` and `types` tiers, the testing library's own suite included, on Vitest (`vitest.config.ts`). `pnpm test <files or dirs>` runs only those; `-t <pattern>` filters by name. Flags follow the command directly (`pnpm test --maxWorkers=2`), never after `--`, which pnpm passes on and Vitest then reads what follows as files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm test:network`              | The tests that talk to the local cluster, the `pg` and `schedules` tiers (`vitest.network.config.ts`), behind the global setup described below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pnpm fuzz <suite> [fuzztime]`   | Both test runs with one suite fuzzed, as `go test -fuzz` does: for the fuzz time (`30s`, `5m`, `1000x`) or until a case fails. Its corpus is the gitignored `.vitest/testing/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pnpm check`                     | The gate, which the pre-commit hook runs: `turbo run` over each package's tasks and the root's, at `"concurrency": "100%"` (`turbo.json`), ordered by turbo's graph and cached, so a warm run replays what did not change. Each package's `typecheck`, `superlint` and `oxlint`; the dev tools' `fixtures:superlint` and `fixtures:oxlint`; and the root's `typecheck`, `superlint`, `oxlint`, `format`, `dead-code`, `architecture` and `dedupe` (`pnpm dedupe --check`). Tests are not in the gate: `pnpm test` runs them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm mutate`                    | The mutation tester for `packages/engine/src` and `packages/grizzle/src/adapter`, a measurement and never a gate. Use `--sample N` for a seeded sample. The full run takes about a day.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm plpgsql-coverage`          | Statement and branch coverage of every PL/pgSQL function grizzle installed in one database of the coverage cluster, by kind (law, advance and refusal functions, the below-SERIALIZABLE guard), read before the database is dropped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm bench`                     | The performance gates in `bench/`, separate from `pnpm check`. `pnpm bench:full` runs them at full scale, for a quiet machine, and writes the gate listing to `bench/results/GATES.md`. `pnpm bench cold` measures cold starts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Vitest runs each test file in a process of its own, never through Vite's module runner: Node runs the files as it runs
the code, by type stripping. `pnpm test` runs as many files at once as the cores allow; `pnpm test:network` runs six
(`test/support/substrate/workers.ts`), under what PostgreSQL's default `max_connections` admits. Vitest's own process,
every test process and every child a file spawns run under the hardened flags, which the test scripts put in
`NODE_OPTIONS` (`test/support/process.ts` `hardenedNode`, `packages/testing/src/vitest/config.ts` `HARDENED_FLAGS`):
`--disable-proto=delete`, `--disable-sigusr1`, `--throw-deprecation`, `--pending-deprecation`, `--force-context-aware`,
`--no-global-search-paths` and `--unhandled-rejections=strict`. V8's JIT and code generation from strings stay on: never `--jitless`,
`--disallow-code-generation-from-strings`, `--frozen-intrinsics` or `--no-addons`. A file named
`<name>.exclusive.test.ts` needs the cluster to itself: it runs after every other file, one at a time, because its long
SERIALIZABLE transactions would summarize everyone else's. Each pg or schedules file uses its worker's long-lived
database, `gz_shared_<VITEST_POOL_ID>`, and unique schema names, because roles are cluster-wide. The network run's
global setup (`test/support/pg-global-setup.ts`) runs the doctor's quick checks, sweeps what ended runs left behind, and
clones the worker databases. Once every file has ended, its teardown sweeps again. Nothing drops a database while files
run: DROP DATABASE holds its transaction id through the checkpoint it forces, which makes PostgreSQL summarize every
other file's SERIALIZABLE transactions, and their writes then fail with 40001. The type tier's checks are one tsgo
program, which its global setup builds while the files run (`test/types/batch/global-setup.ts`).

Every generated suite draws from one run seed, `TEST_SEED`. The run prints the seed first, and setting it reproduces
a run; `TEST_REPLAY='<suite>:<steering>:<tape>'` replays one case as its failure printed it, under the steering it was drawn with. Each search runs, in order
(`@grizzle/testing/explore`):

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

## Code rules

- **Fully type-safe.** Both packages' `src`, `test/`, `scripts/` and `bench/` follow these rules, and the dev tools
  enforce them: oxlint (type-aware, with the preset and plugin) and superlint (`packages/devtools`):
    - no type assertion except `as const`;
    - no `any`, explicit, implicit or through an alias, so no `JSON.parse` and no read of a Context's `mapUnsafe`,
      whose results are `any`;
    - no non-null assertion `!`;
    - no overload signatures, a Function.dual's two call signatures included, but `withLayer`'s in
      `test/support/with-layer.ts`, which pipes call data-last;
    - no `@ts-ignore` or `@ts-nocheck`;
    - `@ts-expect-error` only in negative type tests under `test/types/**/fixtures/`, each naming its diagnostic code:
      `// @ts-expect-error -- TSnnnn: why`, or `// @ts-expect-error -- TSnnnn refusal: <message>` for a refusal
      grizzle's types name;
    - no written type at a property, parameter or return that holds both `null` and `undefined`; optional plus `| null`
      counts as both;
    - no absence check (`=== undefined`, `== null`, `??`, `?.`) on a value whose type admits neither `undefined` nor
      `null`;
    - no `default` in a switch whose cases already cover every member of its union;
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
  type layer (`packages/engine/src/types/**`) and the type tests.
- **The engine is pure.** It is the Effect-free code of `oxlint.config.ts`. Its `no-restricted-imports` refuses a
  runtime load of `effect` or `@effect/*` in `packages/engine` (an `import type` passes, through `allowTypeImports`),
  any Node module there but `node:crypto`, the driver and a platform's SDK. Its `no-restricted-globals` refuses its
  clock, timers, randomness, `Promise`, `process`, `fetch` and `WebSocket`. Because the Effect language service never
  runs there, the bans Effect owns elsewhere hold on it: no `try` (but the three files that hold its catch doors), no
  `new Error`, no `async`, strict boolean conditions, no console, no `process.env` and no `Math.random`. The engine
  validates its own API inputs natively. Effect Schema never runs in `packages/*/src` (owner, 2026-11-04; the
  `no-restricted-imports` ban passes only `import type`): what PostgreSQL answers grizzle's own statements is trusted
  through `#compiler/core/trusted.ts`, snapshot.json and meta.json are trusted once their fingerprint and seal hold, and every
  foreign input (the environment, CLI arguments, a DbConfig, claims) is narrowed by a reader of its own.
- **Effect, in the shell, the tests, the scripts and the benches.** Every Effect language-service diagnostic is an
  error, except the ones `REJECTED_DIAGNOSTICS` in the dev tools' preset rejects and the per-file exceptions in the
  `overrides` of the plugin that `packages/grizzle/tsconfig.json` and `tsconfig.json` restate: the entry points that
  provide their layers, the shell's per-row hot paths, which read text, arrays and records natively, and the tests that
  play an environment or a socket. The service runs there and never on the engine. A non-public export that exposes
  `FileSystem` or `Path` is `@internal`; tests and scripts read and write files through `FileSystem` under
  `NodeServices.layer`. An error is a `Data.TaggedError` whose classified case is its `reason`, a
  union of reason classes, each itself a `Data.TaggedError` rendering its own `message`, so `Effect.catchReason`,
  `catchReasons` and `unwrapReason` reach every case. What follows from a reason, such as a stage, is a getter, never a
  stored field, and `cause` holds only a foreign value wrapped. No `.match` member call in `packages/*/src`: the
  dependency audit (`test/unit/deps`) reads any as a regular expression's; read an Option with `Option.isSome` and
  `.value`.
- **Hardened Node.** grizzle works under `--disable-proto=delete` and `--disable-sigusr1`, and every test runs under
  the hardened flags (`hardenedNode`), which add that a deprecation throws and an unhandled rejection is fatal. Never
  read or write the `__proto__` accessor: a null-prototype object is the `{ __proto__: null }` literal or
  `Object.create(null)`, a key from outside is read with `Object.hasOwn`, and a record of such keys is a Map or a
  null-prototype object (oxlint `no-proto`). Nothing sends SIGUSR1.
- **Names come from the naming door.** `packages/engine/src/core/identity.ts` is the one module that mints the
  installed identifiers' brands (oxlint `brands-sole-mint`, whose options in `oxlint.config.ts` name each brand's doors);
  elsewhere a name is admitted from text only at a decode
  boundary, the IR and snapshot decoders and the server's error reader. A test or a bench names a production
  identifier through the door, never by spelling it (oxlint `test-no-spelled-names`).
- **SQL is printed, never written.** Every SQL text grizzle sends is the engine printer's print of an AST
  (`EmittedText`, minted by `sql/emit.ts` alone) or a reviewed migration file's statement (`MigrationText`, minted by
  `adapter/migrate/input.ts`), and the printer names every type, function and relation by its schema, so no
  search_path changes what a statement means. The shell's catalog reads are catalog-read ASTs (`sql/catalog.ts`). A
  string holding a `::` cast in `packages/*/src` outside the printer and the lexer is refused (oxlint `no-raw-sql`); a
  test's SQL that neither AST expresses is minted in `test/support/sql.ts`.
- **Tests go through the doors.** Assertions come from `#test/support/assert.ts`, whose equalities type the expected
  value by the actual one; oxlint's `import-doors` refuses `node:assert` and `isDeepStrictEqual` elsewhere. Emitted SQL
  is asserted by its structure, never its text, except the migration DDL a person reviews (superlint
  `sql-text-assertion`). A member of one of `src`'s closed vocabularies is written where the compiler checks it
  (superlint `unchecked-vocabulary-literal`). A test asserts an error's tag, reason and fields, never its prose, never
  compares two values by their JSON text, and declares its features as a closed union: the library's `features` refuses
  `string` as its vocabulary.
- **No module state outside test files.** superlint's `no-module-state` refuses a module-level `let` and a constant
  whose type a write can change (an array, a Map, an object with a writable property) everywhere but in `*.test.ts`
  files. A WeakMap or WeakSet keyed by a handle is a registry and allowed, and so are the stateless codecs; a cache of a
  derived fact is never module state, it is deleted.
- **Regular expressions are arkregex's `regex()`**, which types a pattern's captures, everywhere, tests included (the
  plugin's `no-raw-regexp`). The exceptions are the ECMAScript oracle of the regex tests, the README mirrors and the
  dependency audit's planted controls, each an override with its reason.
- **Heavy type-level programming lives only in the query layer** (`packages/engine/src/types/query` and its neighbours).
  Elsewhere, types are plain. Type-checking cost is never budgeted: never trade precision for checker speed.
- **Representation first.** When a new case shows up, change the data so the case stops being special or stops being
  expressible, instead of adding a branch, flag, guard or sentinel. Parse at the boundary, dispatch exhaustively, and
  make invalid states unrepresentable. See `.claude/skills/representation-first/SKILL.md`.
- **Immutable by default is pinned.** Relations are immutable unless declared `mutable(R)`. Code follows the same
  default: readonly data, values rather than mutable builders.
- **Layering.** Each area of `src` imports only the areas its rule in `.fallowrc.json`'s `boundaries` allows, a DAG;
  fallow requires every `src` module to lie in a zone, and `src` never imports `test`, `scripts` or `bench`. The
  packages an area loads are `oxlint.config.ts`'s `no-restricted-imports`: `packages/engine/` loads only the types of
  `effect`, no Node module but `node:crypto`, and no driver; and no module of `src` loads a platform's SDK (Vercel,
  AWS), which the caller wires through `password` and `attachPool`.
- **Tabs**, counted two columns wide in a 100-column line, in TypeScript, JSON and shell. oxfmt formats.
- **Comments state rules in plain words.** Say what the code guarantees and why. Never cite a document, a line number,
  a review, a work item or a commit, and never narrate what the code used to do. Only JSDoc on a declaration survives:
  the plugin's `no-comment` refuses every other comment but a tool's directive, and its fixer deletes them.
- **Correctness over performance.** When in doubt, pick the stronger semantics and the least surprising behaviour.
  Optimize later, behind the differential oracle.

### Rejected rules

The rules rejected on purpose live in the dev tools' preset: `REJECTED` in `packages/devtools/src/preset.ts` for oxlint, and `REJECTED_DIAGNOSTICS` there for Effect's
diagnostics, each with its reason. A rejected rule is off in every block `lintConfig` builds, naming one in a block of
`oxlint.config.ts` is a type error (`active`), and root superlint refuses a tsconfig whose Effect offs differ from
`REJECTED_DIAGNOSTICS`. A rule that forces worse code is rejected in the
preset, never kept with an allow-list or worked around. A rule off for some files
only is an override in `oxlint.config.ts`, with its reason beside it. There is no inline suppression (the plugin's
`no-inline-suppression`): an exception to an oxlint rule is a per-file override in `oxlint.config.ts`, an exception to
a superlint rule an entry in the `superlint` field's `exceptions`, and an exception to an Effect diagnostic a per-file
entry in the plugin's `overrides` of the tsconfig whose project holds the file.

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
2. **An oracle, then search.** A generated property against an oracle beats examples. Keep an example only for a
   property no generator reaches, or for a readable statement of a rule.
3. **Small, tricky inputs from explicit distributions.** Generators draw few rows and short values, valid by
   construction, from a randomly chosen subset of features (swarm testing), with dictionaries of the values the code
   branches on. Plan diversity comes from perturbing the planner and drawing the policy constants, not from large data.
4. **An escaped bug is a bug in the generator.** Fix the generator so it finds the bug and its relatives, then fix the
   code, then keep the shrunk case.
5. **Assert exactly the contract:** agreement with the oracle modulo what the contract leaves open, the law outcome and
   its witness, one plan per statement. Never assert SQL text, statement counts or line numbers unless the text is the
   contract, as for migration DDL a person reviews.
6. **Waits observe facts, never sleep, and no verdict depends on the clock.** A wait, such as the lock-wait barrier
   (`test/support/substrate/barrier.ts`) or the concurrency driver's, observes a fact (a lock wait in pg_locks, a
   backend gone from pg_stat_activity, a message on the wire) with no deadline; a wait that never ends is a hang, which
   the case's hang guard (`caseHang`) reports.

**The testing library** (`packages/testing`, `@grizzle/testing`) holds the generic testing primitives on Effect and
Vitest: a choice-stream engine, where every case is a tape of bounded choices that one generator searches at random,
enumerates exhaustively, replays, mutates and shrinks. grizzle's own primitives, which know its engine and PostgreSQL, live in `test/support`. Use one
primitive per job; a suite never grows its own runner, coverage counter, seed parser, PRNG, fixed-seed sample or SQL
text match. A type batch's population judges its requirements on `floorPopulation`, its witnesses, with `unreachedOf`.

| Job | Primitive |
| --- | --- |
| Search: kept cases, floor, steered and rotating streams, shrinking bounded by a count of candidates, one failure report with its replay token and kept-case literal | `@grizzle/testing/explore`: `explore` (`drawn`, `sketched`), `exhaust` |
| Generators on the choice stream: bounded whole numbers, elements, weighted and proportional choices, collections that state their bounds, recursion, patterns, Unicode scalars, doubles and their special values | `@grizzle/testing/gen`, `pattern`, `values` |
| What the cases reached: required situations and pairs, judged on the label-fixed witnesses; the Good–Turing residual over independent cases | `@grizzle/testing/features` |
| A state machine judged by a pure model, its programs shrunk step by step | `@grizzle/testing/commands` |
| Schedules: every order under sleep sets, PCT, drawn and scripted, over a driver of the system | `@grizzle/testing/interleave` |
| Steering by a suite's notes or by V8 block coverage | `@grizzle/testing/sense` |
| Choosing features and options with a floor for every choice; Live, Stale and Wild values at a public boundary | `@grizzle/testing/swarm`, `lsw` |
| A wait that observes a fact | `@grizzle/testing/fact` |
| N implementations agreeing modulo a declared equivalence (exact, order, multiset, set, a projection) | `@grizzle/testing/oracle` |
| grizzle's delivered values compared exactly: a Decimal by `equals`, its one form | `test/support/equivalence.ts` |
| Picks over 0..0xffff, a choice's floor among options | `test/support/pick.ts` |
| Identifier and literal dictionaries, admitted by the production validators | `test/support/kernel/dict.ts` |
| A threshold drawn per case, production's constant first, then small values, passed through the deciding function's own parameter | `test/support/kernel/policy.ts` |
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
  steered phase, which runs only while one is unreached, on a stream its label fixes. Floor and steered cases see what
  is pending (`Case.steering`) and may aim their draws at it. Rotating and kept cases are plain draws: they never meet
  a requirement, and only the rotating stream's independent cases enter the residual-risk estimate, whose Good-Turing
  assumption needs them; a witness's notes never reach that tally, by its type. Never raise `runs` to reach coverage:
  give the generator an arm, aim the draws, or give the steered phase more cases.
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
- **The connection lease:** every process that opens test connections first takes one of the cluster's leases
  (`test/support/substrate/shared.ts`), advisory-lock slots sized from `max_connections`, each covering 12
  connections. Any number of runs, copies of the tree and benches share one cluster; a process with no free slot
  waits in the server. That wait is queueing, not a hang: a hook has no time limit in the network tier
  (`vitest.network.config.ts`), so a file the runner starts beyond the free slots waits its turn whatever it takes, and
  each case's own hang guard is what stops a case that hangs.

**The oracles:**

- **The differential oracle** (`test/pg/oracle`, `test/support/oracle`): generated schemas, data and queries run
  through three implementations on PostgreSQL, which must agree. They are the conservative lowering, the optimized
  lowering, and the reference evaluator.
- **The write oracle** (`test/pg/write/oracle`, `test/support/oracle/write`): each run draws a schema (pure sets,
  candidate keys, identity columns, a relation whose every column is an identity, mutable relations, deferred and
  immediate foreign keys, references into candidate keys, capacities, numerics at typmods that round onto each other,
  and texts of two lengths), planner statistics and a perturbation. Its ChangeSets draw Stream members, described
  additions of no field, bound parameters (`ChangeSet.bind`) and compiled handles (`db.compile`). Each ChangeSet runs
  through `db.apply` and through the conservative realization of the same program, and both must give the add-wins
  model's outcome, including the host's refusals, which write nothing, and a domain's refusal of a value its field
  does not admit, such as a longer text read into a shorter field. Every artifact is held to its position invariants,
  and no statement updates an immutable relation's rows in place. A TransientFailure is legitimate only where the
  model's collisions allow one, and every flight must begin SERIALIZABLE.
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
- **The law families** (`test/pg/laws/families`): each family (selected-source containment, conditional mirrors,
  alternatives, which draws its roster, its armed handles and shared arm relations, capacity, two capacities on one
  relation by keys of one arity, two laws sharing tables, span coverage, also into a target whose fields are named apart
  and declared in another heading order, a work queue, timekeeping, deposits) draws schemas from its whole parameter
  space and judges writes against a host model of the laws, including span keys, span coverage and row checks. A law's
  refusal names which side's write broke it, so the parent's and the payload's checks are each required. The same
  schemas drive concurrent histories, generated races and a direct SQL writer (`direct-*.test.ts`).
- **The residual law structure** (`test/unit/laws`): each participant of a drawn residual law re-checks exactly the
  terms of the law's violation query that read its relation, each unit's trigger filters exactly its event's row
  images, and each unit raises once per term (`participant-checks.test.ts`); an installation's objects, its total and
  its snapshot grow at most linearly in every schema dimension, compared at n and 2n as AST node counts
  (`scaling.test.ts`); and a migration revalidates a law exactly when the law's normalized violation query changed
  (`digest.test.ts`). The catalog verifier holds every installed law trigger to one event and every law function to one
  trigger (`test/support/catalog/verify.ts`).
- **The direct-writer model** (`test/pg/direct-writers`): psql writers' statements, built as typed SQL ASTs over
  generated schemas, drawing missing fields (23502), unknown handles (22P02) and transactions below SERIALIZABLE
  (25000). For each transaction it predicts which step fails, with its SQLSTATE and the laws allowed, or the committed
  state and sequences.
- **The worlds model** (`test/support/worlds`): a model of installations, sessions, actions and observations,
  independent of grizzle's source (laws are judged by the host law model), checked against the real system
  (`execute`), which installs a drawn installation through its first migration and performs each action as grizzle's
  caller or as a direct SQL writer would. Each action's observation must be one the model allows, no value hidden from
  the acting session may appear in anything grizzle answered, every stored relation must hold exactly the model's facts
  and every open session's connection probe as the model expects, and the model's state keeps every invariant. Its
  suites: random programs over a documents base, guided by block coverage of the worlds code, an exhaustive small box,
  and inductive single steps from drawn states (`test/pg/world-model`); concurrent races (`test/schedules/worlds`); and
  the school system's installation (`test/pg/education`).
- **The protocol tap** (`test/support/wire-tap.ts`): a session whose every message, both ways, a test reads off the
  wire. The wire suite (`test/pg/adapter/suites/batch-parity.ts`) holds a flight to one round trip, atomicity, its
  failures and cancellation, and the round-trip suite (`test/pg/adapter/suites/round-trips.ts`) holds every public
  call to one round trip.
- **The mutation tester** (`pnpm mutate`, `scripts/dev/mutate`): it breaks rewrites, proofs, guards, runtime decisions
  and, with its `sql-world` operators, the SQL that installs and enters a world, in `packages/engine/src` and
  `packages/grizzle/src/adapter`, and checks that some test notices: first the unit project, then a seeded subset of
  the PostgreSQL oracles, the public-boundary differential among them. Survivors are triaged in
  `test/support/mutation/triage.json`, and each becomes a generator feature. It measures whether the tests kill the
  mutants of the code they target, and gates nothing. A verdict names one mutant of the current
  population by its id, so a verdict whose mutant no longer exists, its code moved or changed, refuses every run until
  it is triaged again or deleted.
- **Type tests** (`test/types`): fixtures checked under tsgo as one batch, plus a disarmed copy that must fail with
  exactly the diagnostic each `@ts-expect-error` names, printing `Refusal<"<message>">` exactly where the directive
  names that refusal. The README's and `packages/grizzle/skills/grizzle/SKILL.md`'s `ts` blocks are checked code: each
  is mirrored line for line in `test/types/examples/fixtures/readme.ts` or `skill.ts`, which the batch typechecks, and
  `test/types/examples/blocks.test.ts` holds every block to its fixture, so an edit to a block alone fails.
