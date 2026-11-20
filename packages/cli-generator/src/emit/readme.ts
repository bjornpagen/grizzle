import { regex } from "arkregex"
import { Array as Arr, JsonPointer, Option, Order, String as Str } from "effect"
import { stringLiteral } from "#emit/escape.ts"
import type { EmittedFile } from "#emit/package.ts"
import type { AuthorConfig } from "#model/author-config.ts"
import { isRefusal } from "#model/diagnostic.ts"
import type { Diagnostic } from "#model/diagnostic.ts"
import type { Api } from "#model/entities.ts"
import type { NamePlan } from "#names/index.ts"
import { envPrefixOf } from "#names/plan.ts"
import type { PlannedCredential } from "#names/plan.ts"
import { reservedCommandNames, reservedFlagNames } from "#names/reserved.ts"

/**
 * What the README is written from: the model (webhooks), the author config (bin name), the name
 * plan (credential names), and the diagnostics of every stage (check, normalize, names and emit),
 * which the caller collects. The refusal summary counts the refusals among them.
 */
export interface ReadmeInput {
	readonly api: Api
	readonly config: AuthorConfig
	readonly plan: NamePlan
	readonly diagnostics: readonly Diagnostic[]
}

interface OperationKey {
	readonly method: string
	readonly path: string
}

const byKey = Order.combine(
	Order.mapInput(Order.String, (key: OperationKey) => key.path),
	Order.mapInput(Order.String, (key: OperationKey) => key.method)
)

const sameKey = (left: OperationKey, right: OperationKey): boolean =>
	left.method === right.method && left.path === right.path

/** Markdown blocks, a blank line between each two. */
const joinBlocks: (blocks: Iterable<string>) => string = Arr.join("\n\n")

/** Markdown lines, one after another. */
const joinLines: (lines: Iterable<string>) => string = Arr.join("\n")

/** The plural `s` a count other than one puts on its noun. */
const plural = (count: number): string => (count === 1 ? "" : "s")

const backtickRun = regex("`+", "gu")

/** The length of the longest run of backticks in a text, 0 when it has none. */
const longestRun = (text: string): number =>
	Arr.reduce(Str.matchAll(backtickRun)(text), 0, (longest, run) => Math.max(longest, run[0].length))

/**
 * Spec text reaches the README only as escaped string literals inside a `text` fence: no line
 * starts with a backtick, so no line closes the fence, and no control or format character is raw.
 * The fence is one backtick longer than the longest run inside, as the formatter prints it.
 */
const fence = (lines: readonly string[]): string => {
	const body = joinLines(lines)
	const marks = Str.repeat(Math.max(3, longestRun(body) + 1))("`")

	return `${marks}text\n${body}\n${marks}`
}

const exitCodes: readonly (readonly [number, string])[] = [
	[0, "success, including `--help`, `--version`, `--describe` and `--dry-run`"],
	[1, "the API answered with an error status"],
	[2, "usage: an unknown command or flag, or a value the command refuses"],
	[3, "authentication: no configured credential fits, or the server answered 401 or 403"],
	[4, "transport: DNS, connect, TLS, timeout, or a refused redirect"],
	[5, "response or output handling failed"],
	[70, "internal defect"],
	[130, "interrupted"]
]

/** A reserved set as the README lists it: each name in code, in order. */
const listed = (names: ReadonlySet<string>): string =>
	Arr.join(
		Arr.map(Arr.sort([...names], Order.String), (name) => `\`${name}\``),
		", "
	)

const usage = (bin: string): string =>
	joinBlocks([
		"## Usage",
		`\`\`\`sh\n${bin} --help\n${bin} <command> --help\n\`\`\``,
		"Every command's `--help` shows its flags, request body fields, credentials and responses.",
		"Write a flag value that starts with `-` as `--flag=-value`: `--flag -value` is a usage error (exit 2), and help and version have no `-h` or `-v` short form.",
		`These flag names belong to the CLI, so no flag of the description may claim them: ${listed(reservedFlagNames)}. Each credential's \`<scheme>-file\` flag is reserved as well. These command names belong to the CLI, so no command or group may claim them: ${listed(reservedCommandNames)}. Flags and commands are separate: a command may share a flag's name.`
	])

const credentialLine = (credential: PlannedCredential): string =>
	`- \`${credential.env}\` or \`--${credential.flag} <path|->\``

/** Where each planned credential is read from, when the plan has any. */
const credentialSources = (plan: NamePlan): Option.Option<string> =>
	Arr.match(plan.credentials, {
		onEmpty: Option.none,
		onNonEmpty: (planned) =>
			Option.some(
				joinBlocks([
					"Each credential is read from the first source that has it: the file its flag names (`-` reads stdin), then its environment variable, then, only when stdin and stdout are both terminals, a prompt that does not echo. No flag takes a credential value on the command line.",
					joinLines(Arr.map(planned, credentialLine)),
					"A credential is sent only to the origins this package accepts. An origin `--base-url` or its environment variable names outside them gets no credential unless `--allow-credentials-for-base-url` is given."
				])
			)
	})

/**
 * The `oauth2` and `openIdConnect` schemes, when a credential of one is planned: the operator
 * supplies the token (design 6.5, D-SEC1).
 */
const passThrough = (input: ReadmeInput): Option.Option<string> => {
	const tokenSchemes = new Set(
		Arr.map(
			Arr.filter(
				input.api.securitySchemes,
				(scheme) => scheme.kind.type === "oauth2Token" || scheme.kind.type === "oidcToken"
			),
			(scheme) => scheme.name
		)
	)

	return Arr.match(
		Arr.filter(input.plan.credentials, (credential) => tokenSchemes.has(credential.scheme)),
		{
			onEmpty: Option.none,
			onNonEmpty: (planned) =>
				Option.some(
					joinBlocks([
						"### OAuth2 and OpenID Connect",
						"This CLI does not obtain tokens: it runs no OAuth2 flow and no OpenID Connect discovery. Obtain an access token elsewhere and supply it through the scheme's credential source; it is sent as `Authorization: Bearer <token>`. Each command's `--help` shows the flows, URLs and scopes.",
						joinLines(Arr.map(planned, credentialLine))
					])
				)
		}
	)
}

/**
 * The `mutualTLS` schemes' certificate, key and CA paths, when a certificate is planned:
 * environment only, no file flag (6.5). The files are read at start-up, before the command line
 * is parsed, so their errors render by `<PREFIX>_ERROR_FORMAT` alone, as a parse-time error does
 * (design 7.4).
 */
const certificates = (input: ReadmeInput): Option.Option<string> =>
	Arr.match(input.plan.certificates, {
		onEmpty: Option.none,
		onNonEmpty: (planned) =>
			Option.some(
				joinBlocks([
					"### Client certificates",
					"Each `mutualTLS` scheme reads the paths of its client certificate, its private key and an optional CA bundle from these environment variables. No flag sets them.",
					joinLines(
						Arr.map(
							planned,
							(certificate) =>
								`- \`${certificate.certEnv}\`, \`${certificate.keyEnv}\` and \`${certificate.caEnv}\``
						)
					),
					`The files are read once at start-up, before the command line is parsed. A file that cannot be read or is not a regular file fails with exit code 2 before any flag is read, so its error follows \`${envPrefixOf(input.config)}_ERROR_FORMAT\` alone, never \`--error-format\`, and names the environment variable, never the path.`,
					"The certificate is presented only to the origins this package accepts. It is never presented on a cross-origin redirect, or to an origin `--base-url` or its environment variable names outside them, even with `--allow-credentials-for-base-url`: such a request is sent without it, and stderr says so."
				])
			)
	})

/** A section's heading and blocks, or the one sentence that says it has none. */
const section = (heading: string, blocks: readonly string[], none: string): string =>
	joinBlocks([
		heading,
		...Arr.match(blocks, { onEmpty: () => [none], onNonEmpty: (present) => present })
	])

const credentials = (input: ReadmeInput): string =>
	section(
		"## Credentials",
		Arr.getSomes([credentialSources(input.plan), passThrough(input), certificates(input)]),
		"The API declares no credentials this CLI reads."
	)

/**
 * The `format: password` body fields, when any: each read from a file or stdin (design 13.1
 * R4).
 */
const secretFields = (plan: NamePlan): Option.Option<string> => {
	const commands = [...plan.root, ...Arr.flatMap(plan.groups, (group) => group.commands)]
	const names = Arr.sort(
		Arr.dedupe(
			Arr.flatMap(commands, (command) =>
				Arr.flatMap(command.flags, (flag) =>
					flag.source._tag === "Body" && flag.source.kind === "secret-file" ? [flag.name] : []
				)
			)
		),
		Order.String
	)

	return Arr.match(names, {
		onEmpty: Option.none,
		onNonEmpty: (secret) =>
			Option.some(
				joinBlocks([
					"## Secret fields",
					"A body field the description marks `format: password` has no flag that takes its value. Its `--<field>-file` flag reads the value from a file, or from stdin with `-`, and the value is never echoed.",
					joinLines(Arr.map(secret, (name) => `- \`--${name} <path|->\``))
				])
			)
	})
}

/** Ruling X7 (a): the request path through the generated modules (design 4.1). */
const howACommandRuns = (): string =>
	joinBlocks([
		"## How a command runs",
		"A command's flags are parsed by its module in `cli/<group>.ts`, which hands the input to the request builder in `api/<group>.ts`. The built request goes to `runtime/output.ts`, whose `Output.send` sends it through the client policy of `runtime/client.ts` (credentials, redirects, retries and timeouts) to the HTTP client `bin.ts` provides, then writes the response."
	])

/**
 * A Markdown table padded as the formatter prints one: each column as wide as its widest cell.
 * Every cell is ASCII, so a cell's length is its display width.
 */
const table = (header: readonly string[], rows: readonly (readonly string[])[]): string => {
	const widths = Arr.reduce(
		rows,
		Arr.map(header, (title) => title.length),
		(widest, row) => Arr.zipWith(widest, row, (width, cell) => Math.max(width, cell.length))
	)
	const line = (cells: readonly string[]): string =>
		`| ${Arr.join(
			Arr.zipWith(cells, widths, (cell, width) => Str.padEnd(width)(cell)),
			" | "
		)} |`

	return joinLines([
		line(header),
		line(Arr.map(widths, (width) => Str.repeat(width)("-"))),
		...Arr.map(rows, line)
	])
}

/** Ruling X7 (b): one row per runtime setting, precedence flag > env > author default > built-in. */
const settings = (config: AuthorConfig): string => {
	const prefix = envPrefixOf(config)

	return joinBlocks([
		"## Settings",
		"Precedence: flag > environment variable > author default > built-in default. A setting takes the first value found in that order; the author default is the one this package was generated with. Timeouts are in seconds.",
		table(
			["Flag", "Environment", "Author default (config key)", "Built-in default"],
			[
				["`--base-url`", `\`${prefix}_BASE_URL\``, "`servers.accepted`", "none"],
				["`--timeout`", `\`${prefix}_TIMEOUT\``, "none", "none"],
				["`--retries`", "none", "none", "`0`"],
				["`--idle-timeout`", `\`${prefix}_IDLE_TIMEOUT\``, "none", "none"],
				["`--error-format`", `\`${prefix}_ERROR_FORMAT\``, "none", "`text`"]
			]
		),
		`Between \`${prefix}_BASE_URL\` and the accepted server, \`--server <name|index>\` chooses one of the description's servers. With no base URL from any of them, a command fails with exit code 2 and names \`--base-url\`.`,
		`An error raised while the command line is parsed comes before any flag is read, so only \`${prefix}_ERROR_FORMAT\` sets its format. Every later error follows \`--error-format\`, then \`${prefix}_ERROR_FORMAT\`.`
	])
}

/** Design D-AD7 and 7.4: the retry policy and the `Retry-After` cap. */
const retries = (): string =>
	joinBlocks([
		"## Retries",
		"A request is retried when the connection, the DNS lookup or the wait for headers fails, or when the server answers 408, 429, 500, 502, 503 or 504. A TLS failure is not retried. Without `--retry-unsafe`, only `GET`, `HEAD`, `OPTIONS`, `TRACE`, `PUT`, `DELETE` and `QUERY` are retried, and other methods only when the request carries an `Idempotency-Key` header. A body read from stdin is never retried, because it cannot be sent twice.",
		"Nothing is retried unless the command line asks: `--retries <n>` lets a run retry up to `n` times in all, and no environment variable or default stands in for it. Waits grow exponentially with jitter, and each retry writes a note to stderr.",
		"A streamed response whose error event says retrying is safe is retried the same way, whatever the method, because the server reports that the request took no effect; it counts against the same `--retries`.",
		"A `Retry-After` header is honored up to the effective `--timeout`. When the server asks for a longer wait, the CLI does not wait: it stops retrying, and the error reports the server's value. Without a timeout, or with `--timeout 0`, nothing caps the wait."
	])

const timeouts = (config: AuthorConfig): string => {
	const prefix = envPrefixOf(config)

	return joinBlocks([
		"## Timeouts",
		`\`--timeout <seconds>\` (\`${prefix}_TIMEOUT\`) bounds each attempt's wait for the response headers, its redirects included, and a timeout exits with code 4. Without either, or with \`0\`, an attempt waits as long as its server takes.`,
		`\`--idle-timeout <seconds>\` (\`${prefix}_IDLE_TIMEOUT\`) bounds the wait for each next chunk of a response body, streamed or not, and a body that stalls longer exits with code 5. Without either, a body waits as long as its server takes: a followed stream lives on the server's heartbeats.`
	])
}

/** Design 4.6 output modes and 7.4 `--error-format json`. */
const output = (): string =>
	joinBlocks([
		"## Output",
		"stdout carries only the response body, the request `--dry-run` prints, or the `--describe` JSON. Errors, notices, retry notes and `--verbose` lines go to stderr.",
		"A response body is written to stdout as it arrives, or to a file with `--output <path>`, which `--force` lets replace an existing file. A binary body is not written to a terminal unless `--output -` asks for it.",
		"A sequential response (Server-Sent Events, NDJSON, JSON Lines or JSON text sequences) is written one JSON value per line, each line as soon as its item arrives. Numbers keep their digits. `--raw` writes the bytes as received instead. `--max-record-bytes <n>` bounds one item; a larger item, or a stream that ends inside an item, exits with code 5.",
		'A Server-Sent Events stream whose description names its events prints each event as `{"data":...,"event":...}`, data the description says is JSON as that JSON. When the stream names a ready event the command stops after it, and `--follow` keeps reading the live changes after it until the stream ends or the command is interrupted (exit code 130). A stream\'s end event ends the command; its error event is printed and then exits with code 1, retried as a fresh call under `--retries` only when the event says that is safe. A stream that names such events and ends before one of them exits with code 5.',
		"`--dry-run` prints the request to stdout with every credential replaced and sends nothing. `--verbose` prints each attempt's and each redirect hop's request and response lines and headers to stderr, redacted and without bodies.",
		'`--error-format json` writes each error to stderr as one JSON object, `{"error":{...}}`. The inner object always has `kind` and `message`, and has `operation`, `status`, `matched`, `body`, `retryAfter` and `requestId` only when they have a value. `retryAfter` is the server\'s `Retry-After` in seconds when retrying stopped at the `--timeout` cap.'
	])

/**
 * Design 6.5 Proxy environment and Loopback hosts, D-SEC8 (operator ruling 71514c79): undici's
 * `EnvHttpProxyAgent` routes every hop but a loopback one from the platform's proxy variables,
 * which carry no package prefix.
 */
const proxies = (): string =>
	joinBlocks([
		"## Proxies",
		"Requests to loopback hosts (`127.0.0.0/8`, `::1`, `localhost` and names under `.localhost`) always go direct, never through a proxy, whatever `no_proxy` or any proxy variable says, so a request to a local server, credentials included, never passes through a proxy. On macOS only `127.0.0.1` answers on the loopback interface, so another `127.x` address that a proxy used to reach now times out.",
		"Every other request is routed by the platform's proxy variables, which carry no package prefix. An `http:` URL uses `http_proxy`, else `HTTP_PROXY`. An `https:` URL uses `https_proxy`, else `HTTPS_PROXY`, else the `http:` proxy. The lowercase name wins when both are set. `ALL_PROXY` and `all_proxy` are not read. A proxy URL may be `http:`, `https:` or `socks5:`.",
		"`no_proxy`, else `NO_PROXY`, exempts the hosts it lists, separated by commas or whitespace: a name exempts itself and every name under it, `*.name` exempts only the names under it, `*` exempts every host, and `host:port` or `[ipv6]:port` exempts that port alone. CIDR ranges are not read.",
		"Every redirect hop is routed afresh from its own URL. The userinfo of a proxy URL goes only to the proxy, never to the API. Over plain `http:` the proxy receives the whole request, credentials included; over `https:` it sees only the host and port. A `mutualTLS` client certificate is presented to the API host through the tunnel, never to the proxy. The CLI has no proxy flag."
	])

const exits = (): string =>
	joinBlocks([
		"## Exit codes",
		joinLines(Arr.map(exitCodes, ([code, meaning]) => `- \`${code}\`: ${meaning}.`))
	])

/**
 * The refusal summary: each refused operation once, sorted, as an escaped literal in a fence, and
 * a count of the element and of the field refusals that belong to no refused operation, which are
 * a generated command's.
 */
const refusals = (input: ReadmeInput): string => {
	const refused = Arr.filter(input.diagnostics, isRefusal)
	const operations = Arr.sort(
		Arr.dedupeWith(
			Arr.flatMap(refused, (diagnostic) =>
				diagnostic.scope === "operation" && diagnostic.operation !== undefined
					? [{ method: diagnostic.operation.method, path: diagnostic.operation.path }]
					: []
			),
			sameKey
		),
		byKey
	)
	const isRefused = (operation: OperationKey): boolean =>
		Arr.some(operations, (key) => sameKey(key, operation))
	const inCommands = (scope: "element" | "field", noun: string): readonly string[] => {
		const count = Arr.filter(
			refused,
			(diagnostic) =>
				diagnostic.scope === scope &&
				(diagnostic.operation === undefined || !isRefused(diagnostic.operation))
		).length

		return count === 0
			? []
			: [
					`Generation refused ${count} ${noun}${plural(count)} of generated commands; each command's \`--help\` names them.`
				]
	}

	return section(
		"## Refusals",
		[
			...Arr.match(operations, {
				onEmpty: () => [],
				onNonEmpty: (refusedOperations) => [
					`Generation refused ${refusedOperations.length} operation${plural(refusedOperations.length)}, which have no command:`,
					fence(Arr.map(refusedOperations, (key) => `${key.method} ${stringLiteral(key.path)}`))
				]
			}),
			...inCommands("element", "element"),
			...inCommands("field", "body field")
		],
		"Nothing in the description was refused."
	)
}

/** The pointer of a webhook itself: the one token under `/webhooks`, still escaped. */
const webhookPointer = regex("^/webhooks/(?<name>[^/]*)$", "u")

/** The name of the webhook a pointer is the pointer of, if it is one. */
const webhookName = (pointer: string): Option.Option<string> =>
	Option.map(
		Option.fromUndefinedOr(webhookPointer.exec(pointer)?.groups.name),
		JsonPointer.unescapeToken
	)

/** The webhooks the description lists, when any, in document order, as escaped literals. */
const webhooks = (api: Api): Option.Option<string> =>
	Arr.match(
		Arr.flatMap(api.informational, (element) =>
			element.row === "DOC-08" ? Option.toArray(webhookName(element.origin.pointer)) : []
		),
		{
			onEmpty: Option.none,
			onNonEmpty: (names) =>
				Option.some(
					joinBlocks([
						"## Webhooks",
						"The description lists these webhooks. They are informational: a webhook is a request the provider sends, so this CLI has no command for it.",
						fence(Arr.map(names, (name) => stringLiteral(name)))
					])
				)
		}
	)

/**
 * Emits the generated package's `README.md` (design 4.1, 4.2): usage with the `--flag=-value`
 * escape and the reserved CLI names (design 4.4), how a command runs and the runtime settings
 * table (ruling X7), the credential sources, environment variables and file flags from the name
 * plan with the `oauth2`/`openIdConnect` pass-through and the `mutualTLS` certificate names when
 * planned, the secret-file fields when any, the retry policy, timeouts and output modes (design
 * D-AD7, 4.6, 7.4), the proxy routing with its loopback rule (design 6.5), the exit codes (design
 * 4.6), a refusal summary of every stage's refusals, and the webhooks, listed as informational.
 * The prefix comes from the config. The bin, environment, flag
 * and config names are ASCII by their grammars; every spec string is an escaped literal in a
 * `text` fence.
 */
export const emitReadme = (input: ReadmeInput): EmittedFile => {
	const bin = input.config.binName
	const intro = `\`${bin}\` is a command-line client generated from an OpenAPI description. Its \`api/\` modules are request builders, not an Effect \`HttpApi\` definition.`
	const sections = [
		`# ${bin}`,
		intro,
		usage(bin),
		howACommandRuns(),
		settings(input.config),
		credentials(input),
		...Option.toArray(secretFields(input.plan)),
		retries(),
		timeouts(input.config),
		output(),
		proxies(),
		exits(),
		refusals(input),
		...Option.toArray(webhooks(input.api))
	]

	return { content: `${joinBlocks(sections)}\n`, path: "README.md" }
}
