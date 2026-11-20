# @bjornpagen/grizzle-cli-generator

Generate standalone command-line applications from OpenAPI 3.0, 3.1 and 3.2 specifications, a grizzle login's among them. Each API operation becomes a command. The generated code uses Effect's CLI and HTTP libraries and runs on Node. Reading Effect `HttpApi` definitions is planned for later.

Inspired by [Cloudflare's Forge](https://github.com/cloudflare/forge) and its [cf CLI](https://github.com/cloudflare/cf). This is an independent project, unaffiliated with Cloudflare or the Effect maintainers. It began as effect-openapi-cli-generator, whose history this package carries, and its code stays under its MIT license (`LICENSE`).

**Status:** under construction, and not published: it is a package of grizzle's workspace, and nothing imports it.

## What it does

- Keeps HTTP semantics exactly: method, path, parameter locations, serialization, body encoding and security. Command names never imply HTTP verbs.
- Refuses what it cannot implement with a diagnostic that names the location and the specification section. Nothing is dropped silently.
- Treats the input specification as untrusted. Nothing from it becomes executable code or a path outside the output directory, and every value read from it is narrowed at the boundary by a reader of the generator's own.
- Produces the same output for the same input and options.
- Gives generated CLIs typed errors, stable exit codes, help built from the specification's own prose, and credentials that never appear in source, help or logs.

Read [the project direction](docs/project.md) for the pipeline, the generated package layout, request and error behavior, and the package layout, and [the printer](docs/printer.md) for how emitted source is laid out.

## Grizzle logins

grizzle writes one OpenAPI 3.2 document per login, `openapi/<login>.json` beside `served/` in each migration folder `grizzle generate` writes. A CLI for a login comes from that document and an author config:

```json
{
	"package": { "name": "acme-app", "version": "1.0.0" },
	"binName": "acme-app",
	"envPrefix": "ACME_APP",
	"acceptedOrigins": ["https://api.acme.example"]
}
```

```sh
node packages/cli-generator/src/bin.ts generate migrations/<folder>/openapi/app.json --config acme-app.json --out acme-app
cd acme-app && pnpm install && pnpm build
```

- Each program of each role is a command, `acme-app <role> <program>`. Its input's members are flags (`--params.<name>`, `--window.size`, `--facts.<op>` as JSON), or the whole input is `--body`. A member that admits one value, such as a program's empty `params` and the `grizzle-wire` header that names the program's form, is sent by the CLI itself and listed under CONSTANTS in its help.
- The document names no server, since a login's document is the same wherever it is deployed: give the base URL as `--base-url` or `<PREFIX>_BASE_URL`. The token of a role that reads a context comes from `--bearer-file`, `<PREFIX>_BEARER` or a terminal prompt, and is sent only to an origin `acceptedOrigins` binds. A server on plain HTTP, such as one on the loopback address, needs `"allowInsecure": true` too.
- A call prints one JSON line per event. A read prints its `reset`, an `upsert` per row and `ready`, and stops there unless `--follow` keeps it reading the live changes; a read at its call's instant ends at the `end` after its `ready`, and offers no `--follow`. A write prints its `outcome` and `end`. An `error` event exits 1, and `--retries <n>` calls again when the error's `retry` is `safe`, as for `unavailable` while a freshly started server's live source comes up.
- The grizzle tier (`test/grizzle/once.test.ts`) holds a generated CLI to what grizzle's own HTTP handler answers: one login, installed twice through grizzle's command line into databases cloned on grizzle's local cluster, one twin served over HTTP and called through the CLI, the other called in process.

## Layout

The package exports its raw TypeScript; Node 26 runs it by type stripping, with no build step and no loaders.

- `src/` holds one directory per pipeline stage, in pipeline order: `load/`, `validate/`, `resolve/`, `check/`, `normalize/`, `names/`, `emit/`, `write/`, `report/`. `src/model/` holds the branded values, entities and their readers: the trust boundary, where a specification's values enter only through the model's narrowing readers; the stages after `normalize/` read the model, never the source document. `src/index.ts` is the library entry; `src/main.ts` and `src/bin.ts` are the generator's command, `grizzle-cli-generator`.
- `src/runtime-src/` is the generated CLIs' runtime source. The scaffold reads it at generation and writes it verbatim under each generated package's `src/`, so every byte of it is product. It imports only `effect` subpaths, `arkregex` and its siblings, as `#runtime/<module>.ts` and `#domain/errors.ts`, which this package maps onto `src/runtime-src` and a generated package maps through its own `imports` (`"#*.ts"`: its sources for types, its built `dist/src/*.js` for Node). It never names Node and no grizzle package, since a generated CLI depends on neither: only the generated `bin.ts` names Node.
- `test/` holds the properties, which run on grizzle's runner (the root's `test.config.ts`, `pnpm test:cli-generator`), and their support; `test/grizzle` is the grizzle tier, the one part that reaches grizzle, through its public entries alone, and the local cluster. `corpus/` holds the pinned public specifications, their author configs, verdicts and tools, and `scripts/` the runtime gate and the corpus's memory guard.

fallow holds the architecture (the root's `.fallowrc.json`, its `cli-generator` zones): a stage imports only the model, the runtime and the stages before it, the runtime imports nothing of the package's, and the grizzle tier alone imports grizzle. No zone of grizzle's allows a zone of this package.

## Generated CLIs

- They run on Node 26 and later. A generated package pins `effect`, `@effect/platform-node` and `arkregex` exactly to the versions the generator runs on, and `typescript` and `@types/node` to the versions it checks with, each read from the installed manifest; it builds with `tsc` to `dist/`.
- Requests go through Effect's undici client. The runtime's `Transport` holds one client per way a hop travels, each over its own undici pool that never follows a redirect: `environment` (an `EnvHttpProxyAgent`, routed by the proxy variables) and `direct` (every loopback hop), and the same pair presenting the `mutualTLS` client certificate when the package has such a scheme and the run configured its files. The runtime's own redirect loop picks a hop's client from the hop's URL, so credentials and the certificate reach only bound origins, and the certificate never reaches a proxy.
- undici sends every RFC 9110 method token as spelled and a body on any method, so the generator refuses only `CONNECT` and a key that is not a token.
- Preserve HTTP request semantics and wire schemas exactly; command names never imply HTTP verbs. Preserve streaming, bounded memory, cancellation, cleanup and typed failures. Keep credentials, bodies and raw query values out of spans and logs. Generated CLIs keep stdout for the command result and send diagnostics to stderr.

## Development

grizzle's workspace builds, checks and tests this package with the rest ([CONTRIBUTING.md](../../CONTRIBUTING.md)):

```sh
pnpm types                                                # the typecheck, every package's
pnpm check                                                # the gate: this package's typecheck and oxlint, its runtime gate and its benchmark among the rest
pnpm test:cli-generator                                   # its properties, the grizzle tier against the local cluster
pnpm --filter @bjornpagen/grizzle-cli-generator corpus    # regenerate and check the corpus verdicts (it fetches the pinned specifications)
```

- While the package is cleaned to grizzle's standard, its typecheck and oxlint run through `scripts/ratchet.ts`: each tool runs in full, and the task fails when any file's finding count rises above what `ratchet.json` holds for it (a file the ledger does not name holds none, so new code comes in clean), or when the tool fails to run or its own summary disagrees with what was read. `pnpm --filter @bjornpagen/grizzle-cli-generator ratchet:lower` writes lower counts after a cleanup; the ledger only falls, covers this package alone, and goes, with the script, at zero. The commit gate's AST-only oxlint (the root's `oxlint.ast.config.ts`) leaves the files the ledger holds oxlint findings for to the ratchet.
- The suites not yet converted to properties run on Vitest, `pnpm --filter @bjornpagen/grizzle-cli-generator test` (`vitest.config.ts`, which leaves out the property modules `test/support/roster.ts` lists); a module converted to properties enters the roster in the commit that converts it, and Vitest goes with the last.
- The runtime gate (`scripts/runtime-gate.ts`) generates `test/fixtures/runtime-gate`, whose operations reach every module of the generated runtime (each parameter location, every request and sequential response codec, every security scheme kind), runs the generated package's own typecheck against the installed dependencies, and lints the generated sources with the shared lint's import and property bans, read from the preset (the platform's index, Effect's metrics), since the emitter writes a module's name as a string the repository's lint never reads. It fails on any refusal but token acquisition, so the fixture cannot quietly reach less. It goes when the property that every emitted package typechecks covers it.
- The benchmark (`corpus/tools/benchmark.ts`) generates every corpus specification whose bytes are committed (qti-pie's grizzle documents), builds each package against the installed dependencies, compares its verdict byte for byte and runs every command's `--help` and `--dry-run` against what its document describes.
