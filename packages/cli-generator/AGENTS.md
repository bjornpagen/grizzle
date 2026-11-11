# Working in effect-openapi-cli-generator

This repository is a hard fork of effect-openapi-cli-generator: an Effect-native generator that reads an OpenAPI 3.0, 3.1 or 3.2 document and writes the source of a standalone command-line application. Read README.md and docs/project.md first. Upstream compatibility is not kept: a change replaces the old way everywhere in one go.

## Code is the documentation

Code, types and lint rules are the documentation. The only comments are JSDoc on declarations and the comments other tools read; oxlint's `no-comment` rule refuses every other comment. JSDoc and Markdown state what code cannot express: why a design exists, what it rejects, and outside facts, in plain words, never narrating history.

Lint (oxlint, superlint) and Effect's diagnostics record owner decisions: strengthen them, never weaken them to let code through. Inline suppressions are refused (`no-inline-suppression`). Rules rejected on purpose live in `REJECTED` in the dev tools' preset, and Effect's diagnostics in `REJECTED_DIAGNOSTICS`, each with its reason. A finding is fixed by changing the code, never by an exemption list.

## Design

- **Representation over control flow.** When a new case appears, change the types so it stops being special or stops being expressible, instead of adding a branch, flag, guard or sentinel. Parse at the boundary once; never re-validate inside. Absence is a variant or an `Option`, never a fallback.
- **Delete before you add.** A fix removes the cause. A new rule, guard or branch needs evidence that deleting something could not do the job.
- **Hard cutovers.** No shims, aliases or readers of an old form.
- **Effect as it is meant to be used.** Prefer what Effect already does over a home-rolled version.

## Workspace

A Turborepo workspace on pnpm. Every package sits at `packages/<name>` and exports its raw TypeScript; Node 26 runs it by type stripping, with no build step and no loaders.

- `packages/generator`: the generator, one directory per pipeline stage under `src/` in pipeline order: `load/`, `validate/`, `resolve/`, `check/`, `normalize/`, `names/`, `emit/`, `write/`, `report/`. `src/model/` holds the branded values, entities and codecs: the trust boundary, where specification values enter only through `Schema` decoding; stages after `normalize/` read the model, never the source document. `src/runtime-src/` is the generated CLIs' runtime source, emitted verbatim: it imports only `effect` subpaths and its sibling runtime modules. `src/index.ts` is the library entry; `src/main.ts` and `src/bin.ts` are the generator CLI. Tests live under `test/`, the pinned public specifications and their verdicts under `corpus/`, and the maintenance scripts under `scripts/`.
- `packages/devtools`, `packages/testing`, `packages/json`: superstarter's dev tools, testing library and JSON door, vendored byte for byte. They are superstarter's; this repository changes them only to follow superstarter.

Inside a package, import only through its `#` subpath imports with the real extension (`#load/json.ts`, `#test/support/env.ts`); across packages, by package export (`@superstarter/testing/explore`). No relative imports. Effect is imported from its barrel: `import { Effect, Schema } from "effect"`. File names are kebab-case.

fallow holds the architecture in `.fallowrc.json`: every file is in a zone, and a stage imports only the model, the runtime's facts and the stages before it. A new import across zones is a decision: widen the rule on purpose or move the code.

## Toolchain

- Node 26 is the one runtime, for the generator and for the CLIs it generates. pnpm installs; every external dependency's version lives once, in the strict catalog in `pnpm-workspace.yaml`, and a package names it `catalog:`.
- TypeScript 7 with Effect's language service, from `@effect/tsgo`: `pnpm typecheck` runs `effect-tsgo tsrs`. The dev tools' tsconfig base lists every diagnostic the installed `@effect/tsgo` ships, each at error except those in `REJECTED_DIAGNOSTICS`. `pnpm install` runs `effect-tsgo patch`.
- `pnpm check` is the gate, run by lefthook before every commit and push: through turbo, every package's typecheck, superlint and oxlint, the dev tools' fixture suites, oxfmt in check mode, fallow's dead-code and architecture checks, and `pnpm dedupe --check`. Nothing in the gate writes files; `pnpm format:write` does.
- `pnpm test` runs Vitest through `@superstarter/testing`: properties over constructed generators checked against oracles, with required features and plants. No hand-picked examples with hand verdicts. The generator's golden fixtures and corpus verdicts are byte checks of a deterministic generator.

## Effect

`effect` and `@effect/platform-node` are pinned exactly in the catalog. For Effect APIs, read the installed package's own `AGENTS.md`, `ai-docs/` and source (`node_modules/effect/`) before other material.

- Use Effect's capabilities before custom code: `effect/cli`, `Schema`, `Config`, `effect/http`, `Stream`, `Sink`, `Context.Service`, `Layer`, `Scope`, `Schedule`, `FileSystem`, `ChildProcess`. When custom code remains necessary, name the verified gap at its owning boundary.
- A function that returns an Effect is an `Effect.fn`. Decode untrusted input with `Schema` into useful types; errors are `Schema.TaggedError` classes.
- Preserve HTTP request semantics and wire schemas exactly; command names never imply HTTP verbs.
- Preserve streaming, bounded memory, cancellation, cleanup and typed failures. Keep credentials, bodies and raw query values out of spans and logs. Generated CLIs keep stdout for the command result and send diagnostics to stderr.

## Working here

- Commit messages are plain prose. Commit only your own files, by pathspec.
- Push, publish or deploy only on the owner's go-ahead.
