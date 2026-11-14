# Working in effect-openapi-cli-generator

This repository is a hard fork of effect-openapi-cli-generator: an Effect-native generator that reads an OpenAPI 3.0, 3.1 or 3.2 document and writes the source of a standalone command-line application that runs on Node. Read README.md and docs/project.md first. Upstream compatibility is not kept: a change replaces the old way everywhere in one go.

## Code is the documentation

Code, types and lint rules are the documentation. The only comments are JSDoc on declarations and the comments other tools read; oxlint's `no-comment` rule refuses every other comment. JSDoc and Markdown state what code cannot express: why a design exists, what it rejects, and outside facts, in plain words, never narrating history.

Lint (oxlint, superlint) and Effect's diagnostics record owner decisions: strengthen them, never weaken them to let code through. Inline suppressions are refused (`no-inline-suppression`). Rules and Effect diagnostics rejected on purpose live in the `rejected` lists of `toolchain.config.ts`, each with its reason. A finding is fixed by changing the code, never by an exemption list.

## Design

- **Representation over control flow.** When a new case appears, change the types so it stops being special or stops being expressible, instead of adding a branch, flag, guard or sentinel. Parse at the boundary once; never re-validate inside. Absence is a variant or an `Option`, never a fallback.
- **Delete before you add.** A fix removes the cause. A new rule, guard or branch needs evidence that deleting something could not do the job.
- **Hard cutovers.** No shims, aliases or readers of an old form.
- **Effect as it is meant to be used.** Prefer what Effect already does over a home-rolled version.

## Workspace

A Turborepo workspace on pnpm. Every package of this repository sits at `packages/<name>` and exports its raw TypeScript; Node 26 runs it by type stripping, with no build step and no loaders.

- `packages/generator`: the generator, one directory per pipeline stage under `src/` in pipeline order: `load/`, `validate/`, `resolve/`, `check/`, `normalize/`, `names/`, `emit/`, `write/`, `report/`. `src/model/` holds the branded values, entities and codecs: the trust boundary, where specification values enter only through `Schema` decoding; stages after `normalize/` read the model, never the source document. `src/index.ts` is the library entry; `src/main.ts` and `src/bin.ts` are the generator CLI. Tests live under `test/`, the pinned public specifications, their author configs, verdicts and tools under `corpus/`, and the maintenance scripts under `scripts/`.
- `src/runtime-src/` is the generated CLIs' runtime source. The scaffold reads it at generation and writes it verbatim under each generated package's `src/`, so every byte of it is product. It imports only `effect` subpaths, `arkregex`, and its siblings as `#runtime/<module>.ts` and `#domain/errors.ts`, which the generator package maps onto `src/runtime-src` and a generated package maps through its own `imports` (`"#*.ts"`: its sources for types, its built `dist/src/*.js` for Node). It never names Node: only the generated `bin.ts` does.
- `packages/json`: superstarter's JSON door, vendored byte for byte. It is superstarter's; this repository changes it only to follow superstarter.
- `vendor/toolchain`: the shared toolchain, a git submodule of github.com/bjornpagen/toolchain pinned by commit. Its two packages join the workspace and run from source: `@bjornpagen/devtools` (superlint, the oxlint preset and plugin, the tsconfig bases) and `@bjornpagen/testing` (the testing library). The toolchain's own gate proves them, so this repository's gate runs only its own packages, and changes the toolchain only by moving the pin. This repository's decisions about it are `toolchain.config.ts` (what it rejects and the core's names; it runs no pack, having no Drizzle and no web app) and `oxlint.config.ts`.

Inside a package, import only through its `#` subpath imports with the real extension (`#load/json.ts`, `#test/support/env.ts`); across packages, by package export (`@bjornpagen/testing/explore`). No relative imports. Effect is imported from its barrel: `import { Effect, Schema } from "effect"`. Regular expressions go through arkregex, JSON text through `@superstarter/json` (or `Formatter.formatJson` where a layout is part of a byte contract). File names are kebab-case.

fallow holds the architecture in `.fallowrc.json`: every file is in a zone, and a stage imports only the model, the runtime and the stages before it. A new import across zones is a decision: widen the rule on purpose or move the code.

## Generated CLIs

- They run on Node 26 and later. A generated package pins `effect`, `@effect/platform-node` and `arkregex` exactly to the versions the generator runs on, and `typescript` and `@types/node` to the versions it checks with, each read from the installed manifest; it builds with `tsc` to `dist/`.
- Requests go through Effect's undici client. The runtime's `Transport` holds one client per way a hop travels, each over its own undici pool that never follows a redirect: `environment` (an `EnvHttpProxyAgent`, routed by the proxy variables) and `direct` (every loopback hop), and the same pair presenting the `mutualTLS` client certificate when the package has such a scheme and the run configured its files. The runtime's own redirect loop picks a hop's client from the hop's URL, so credentials and the certificate reach only bound origins, and the certificate never reaches a proxy.
- undici sends every RFC 9110 method token as spelled and a body on any method, so the generator refuses only `CONNECT` and a key that is not a token.

## Toolchain

- Node 26 is the one runtime, for the generator and for the CLIs it generates. pnpm installs; every external dependency's version lives once, in the strict catalog in `pnpm-workspace.yaml`, and a package names it `catalog:`.
- TypeScript 7 with Effect's language service, from `@effect/tsgo`: typecheck runs `effect-tsgo tsrs`. The dev tools' tsconfig base lists every diagnostic the installed `@effect/tsgo` ships, each at error except those in `REJECTED_DIAGNOSTICS`. `pnpm install` runs `effect-tsgo patch`.
- `pnpm check` is the gate, run by lefthook before every commit and push: through turbo, every package's typecheck, superlint and oxlint, oxfmt in check mode, fallow's dead-code and architecture checks, `pnpm dedupe --check`, and the runtime gate. Nothing in the gate writes files outside a scratch directory it removes; `pnpm format:write` does.
- While the generator is being cleaned, its typecheck, superlint and oxlint and the root's dead-code and architecture run through `packages/generator/scripts/ratchet.ts`: each tool runs in full, and the gate fails when any file's finding count rises above what `packages/generator/ratchet.json` holds for that file (a file it does not name holds none, so new code comes in clean), or when the tool fails to run or its own summary disagrees with what was read. `pnpm ratchet:lower` writes lower counts after a cleanup; measure on a tree that holds only committed work. A tool at zero leaves the ledger; the ratchet goes when the ledger is empty.
- The runtime gate (`packages/generator/scripts/runtime-gate.ts`) generates `packages/generator/test/fixtures/runtime-gate`, whose operations reach every module of the generated runtime (each parameter location, every request and sequential response codec, every security scheme kind), and runs the generated package's own typecheck against the installed dependencies. It fails on any refusal but token acquisition, so the fixture cannot quietly reach less. It goes when the property that every emitted package typechecks covers it.
- `pnpm test` runs Vitest through `@bjornpagen/testing` under the library's hardened Node flags. Suites are properties over constructed generators checked against the oracle each states, with required features, and the plants each suite was checked against named in its header. No hand-picked examples with hand verdicts. The generator's golden fixtures and corpus verdicts are byte checks of a deterministic generator. `pnpm corpus` regenerates and checks the corpus verdicts (it fetches the pinned specifications and builds every package).

## Effect

`effect` and `@effect/platform-node` are pinned exactly in the catalog. For Effect APIs, read the installed package's own `AGENTS.md`, `ai-docs/` and source (`node_modules/effect/`) before other material.

- Use Effect's capabilities before custom code: `effect/cli`, `Schema`, `Config`, `effect/http`, `Stream`, `Sink`, `Context.Service`, `Layer`, `Scope`, `Schedule`, `FileSystem`, `ChildProcess`. When custom code remains necessary, name the verified gap at its owning boundary.
- A function that returns an Effect is an `Effect.fn`. Decode untrusted input with `Schema` into useful types; errors are branded `Schema.TaggedError` classes.
- Preserve HTTP request semantics and wire schemas exactly; command names never imply HTTP verbs.
- Preserve streaming, bounded memory, cancellation, cleanup and typed failures. Keep credentials, bodies and raw query values out of spans and logs. Generated CLIs keep stdout for the command result and send diagnostics to stderr.

## Working here

- Work on `main`. Commit only your own files, by pathspec; commit messages are plain prose.
- Push, publish or deploy only on the owner's go-ahead.
