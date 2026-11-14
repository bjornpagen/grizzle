# effect-openapi-cli-generator

Generate standalone command-line applications from OpenAPI 3.0, 3.1 and 3.2 specifications. Each API operation becomes a command. The generated code uses Effect's CLI, Schema and HTTP libraries and runs on Node. Reading Effect `HttpApi` definitions is planned for later.

Inspired by [Cloudflare's Forge](https://github.com/cloudflare/forge) and its [cf CLI](https://github.com/cloudflare/cf). This is an independent project, unaffiliated with Cloudflare or the Effect maintainers.

**Status:** under construction. The generator is not usable yet, and the package is not published.

## What it does

- Keeps HTTP semantics exactly: method, path, parameter locations, serialization, body encoding and security. Command names never imply HTTP verbs.
- Refuses what it cannot implement with a diagnostic that names the location and the specification section. Nothing is dropped silently.
- Treats the input specification as untrusted. Nothing from it becomes executable code or a path outside the output directory.
- Produces the same output for the same input and options.
- Gives generated CLIs typed errors, stable exit codes, help built from the specification's own prose, and credentials that never appear in source, help or logs.

Read [the project direction](docs/project.md) for the pipeline, the generated package layout, request and error behavior, and the repository layout.

## Grizzle logins

[grizzle](https://github.com/bjornpagen/grizzle) writes one OpenAPI 3.2 document per login, `openapi/<login>.json` beside `served/` in each migration folder `grizzle generate` writes. A CLI for a login comes from that document and an author config:

```json
{
	"package": { "name": "acme-app", "version": "1.0.0" },
	"binName": "acme-app",
	"envPrefix": "ACME_APP",
	"acceptedOrigins": ["https://api.acme.example"]
}
```

```sh
effect-openapi-cli-generator generate migrations/<folder>/openapi/app.json --config acme-app.json --out acme-app
cd acme-app && pnpm install && pnpm build
```

- Each program of each role is a command, `acme-app <role> <program>`. Its input's members are flags (`--params.<name>`, `--window.size`, `--facts.<op>` as JSON), or the whole input is `--body`. A member that admits one value, such as a program's empty `params` and the `grizzle-wire` header that names the program's form, is sent by the CLI itself and listed under CONSTANTS in its help.
- The document names no server, since a login's document is the same wherever it is deployed: give the base URL as `--base-url` or `<PREFIX>_BASE_URL`. The token of a role that reads a context comes from `--bearer-file`, `<PREFIX>_BEARER` or a terminal prompt, and is sent only to an origin `acceptedOrigins` binds. A server on plain HTTP, such as one on the loopback address, needs `"allowInsecure": true` too.
- A call prints one JSON line per event. A read prints its `reset`, an `upsert` per row and `ready`, and stops there unless `--follow` keeps it reading the live changes; a read at its call's instant ends at the `end` after its `ready`, and offers no `--follow`. A write prints its `outcome` and `end`. An `error` event exits 1, and `--retries <n>` calls again when the error's `retry` is `safe`, as for `unavailable` while a freshly started server's live source comes up.
- `pnpm test:grizzle` holds a generated CLI to what grizzle itself answers: test/grizzle/once.test.ts.

## Development

Node 26 runs the TypeScript source directly; pnpm 12.16.1 (the `packageManager` pin) installs.

```sh
git submodule update --init
pnpm install
pnpm check
pnpm test
pnpm test:grizzle
pnpm format:write
```

The workspace holds the generator (`packages/generator`), superstarter's JSON door (`packages/json`), and the shared toolchain's dev tools and testing library, a git submodule at `vendor/toolchain`. `vendor/grizzle` is grizzle at the commit the end-to-end suites pin, a git submodule outside the workspace: `pnpm test:grizzle` installs its packages and runs a driver inside it against a local PostgreSQL cluster of grizzle's. `GRIZZLE_PG_CLUSTER=<port>` names a private one, so no other suite's load reaches it: create it with `GRIZZLE_PG_CLUSTER=<port> pnpm pg:init` in `vendor/grizzle`, run `GRIZZLE_PG_CLUSTER=<port> pnpm test:grizzle`, and remove it with `GRIZZLE_PG_CLUSTER=<port> pnpm pg destroy`. `pnpm check` is the gate lefthook runs before every commit and push: `effect-tsgo tsrs` with every Effect diagnostic at error, superlint, oxlint with the dev tools' preset, oxfmt, fallow's dead-code and architecture checks, and `pnpm dedupe --check`.

Read [AGENTS.md](AGENTS.md) before contributing.
