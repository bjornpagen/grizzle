/**
 * A generated CLI presents its mutualTLS client certificate on every connection to its bound origin and on no other.
 *
 * - Chains: from the bound origin A (the TLS capture server's first origin), or from the unbound origin B named by
 *   `--base-url` or `MTLS_BASE_URL`, with or without `--allow-credentials-for-base-url`, a chain of up to twelve
 *   redirects, each a 301, 302, 303, 307 or 308 to A or to B, absolute or relative, to a fresh path or back to one the
 *   chain already sent, after a GET, with the certificate's files configured.
 *   Oracles: the redirect loop's model (redirect-model.ts) for the hops; for each hop's connection, the certificate
 *   subject exactly when the hop is to A; one notice when the run starts at an operator base and none when it never
 *   leaves A; and no certificate, key or CA path, nor their directory, in anything the run prints.
 * - Stops: the same runs with one planted configuration fault, no certificate configured or a certificate path that
 *   names no file, or as a dry run, under JSON errors. Oracles: no connection at all; exit 3, 2 or 0; a missing
 *   certificate's one CredentialMissing error naming the scheme and both its file settings, a missing file's one
 *   UsageError line naming the certificate setting, and no error for a dry run, nor a notice for one at the bound
 *   origin; and no path printed.
 *
 * Plants (local only, reverted): client.ts clientFor taking the certified clients for every hop; auth.ts
 * presentsCertificate answering yes for every origin; errors.ts CredentialMissing's exit code set to 1; entry.ts's
 * unreadable-file error printing the path it could not read.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { jsonTextOf } from "@superstarter/json"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	Formatter,
	Layer,
	Option,
	Path,
	Schema,
	String as Str
} from "effect"
import {
	type ScriptedResponse,
	type TlsCaptureServer,
	tlsCaptureServer
} from "#test/support/capture-server.ts"
import { clientSubject, type TlsOrigin } from "#test/support/certificates.ts"
import {
	buildPackage,
	type BuiltPackage,
	generateFixture,
	harnessLayer,
	runBin
} from "#test/support/cli-package.ts"
import type { Finished } from "#test/support/process.ts"
import {
	chainScript,
	followChain,
	type Redirect,
	redirectsOf
} from "#test/support/redirect-model.ts"
import { latin1Bytes } from "#test/support/wire.ts"

/** The landing the chain ends with: an empty JSON object. */
const landing: ScriptedResponse = {
	status: 200,
	headers: [["Content-Type", "application/json"]],
	delay: Duration.zero,
	body: { kind: "complete", bytes: latin1Bytes("{}") }
}

/** The landing response's JSON. */
const landed = {
	content: { "application/json": { schema: { type: "object" } } },
	description: "Landed."
} as const

/** One GET behind a mutualTLS scheme. */
const spec = jsonTextOf({
	openapi: "3.1.0",
	info: { title: "Mutual TLS chains", version: "1.0.0" },
	paths: {
		"/hop": {
			get: { operationId: "hop-get", security: [{ client: [] }], responses: { "200": landed } }
		}
	},
	components: {
		securitySchemes: { client: { type: "mutualTLS", description: "A client certificate." } }
	}
})

/** The author config, binding exactly origin A. */
const configOf = (bound: string): string =>
	jsonTextOf({
		package: { name: "mtls-chains", version: "1.0.0" },
		binName: "mtls",
		envPrefix: "MTLS",
		acceptedOrigins: [bound]
	})

/**
 * Where a run starts: the bound origin, or B named by `--base-url` or by `MTLS_BASE_URL`, with or without the flag that
 * admits an operator base.
 */
type Start =
	| Readonly<{ kind: "bound" }>
	| Readonly<{ kind: "operator"; via: "flag" | "env"; allow: boolean }>

/** A run with the certificate configured: where it starts and the chain the server answers. */
type Run = Readonly<{ start: Start; redirects: ReadonlyArray<Redirect<TlsOrigin>> }>

/**
 * What stops a run before any connection: no certificate configured (refused with exit 3), a certificate path that
 * names no file (refused with exit 2), or a dry run (exit 0).
 */
type Stop = "no certificate configured" | "a certificate path that names no file" | "a dry run"

/** A run that stops: the run it would have been and what stops it. */
type Stopped = Readonly<{ run: Run; stop: Stop }>

const start: Gen<Start> = (source) =>
	boolean(source)
		? {
				kind: "operator",
				via: element<"flag" | "env">(["flag", "env"])(source),
				allow: boolean(source)
			}
		: { kind: "bound" }

/** A run: where it starts, and a chain of up to twelve redirects across A and B that may revisit a URL it sent. */
const runOf: Gen<Run> = (source) => ({
	start: start(source),
	redirects: redirectsOf(element<TlsOrigin>(["A", "B"]), { min: 0, max: 12 })(source)
})

const stoppedOf: Gen<Stopped> = (source) => ({
	run: runOf(source),
	stop: element<Stop>([
		"no certificate configured",
		"a certificate path that names no file",
		"a dry run"
	])(source)
})

/** One hop as the oracle compares it: its origin, method, target, and the certificate its connection presented. */
type Hop = Readonly<{
	origin: TlsOrigin
	method: string
	target: string
	certificate: Option.Option<string>
}>

/** What the model expects of a run: its hops, its exit code, and whether the loop refuses a hop that repeats a request. */
type Expected = Readonly<{ hops: ReadonlyArray<Hop>; exitCode: number; loops: boolean }>

/** The loop's specification run over a chain, with the certificate on exactly the hops to A. */
const expectedOf = (r: Run): Expected => {
	const run = followChain<TlsOrigin>(
		{ origin: r.start.kind === "bound" ? "A" : "B", method: "GET", withBody: false },
		r.redirects
	)
	return {
		hops: Arr.map(run.hops, (hop) => ({
			origin: hop.origin,
			method: hop.method,
			target: hop.path,
			certificate: hop.origin === "A" ? Option.some(clientSubject) : Option.none()
		})),
		exitCode: run.end === "landed" ? 0 : 4,
		loops: run.end === "loop"
	}
}

/** The exit code a stop gives. */
const stopExit = (stop: Stop): number => {
	switch (stop) {
		case "no certificate configured":
			return 3
		case "a certificate path that names no file":
			return 2
		case "a dry run":
			return 0
	}
}

type StartFeature =
	| "a run from the bound origin"
	| "a run from an operator base"
	| "an operator base from the environment"
	| "an operator base the flag admits"

type ChainFeature =
	| StartFeature
	| "a hop to the unbound origin"
	| "back to the bound origin"
	| "a relative Location"
	| "a refused loop"

/** A feature when it holds, none otherwise. */
const when = <F extends string>(holds: boolean, feature: F): ReadonlyArray<F> =>
	holds ? [feature] : []

/** The features of where a run starts. */
const startFeatures = (s: Start): ReadonlyArray<StartFeature> =>
	Arr.flatten<ReadonlyArray<ReadonlyArray<StartFeature>>>([
		when(s.kind === "bound", "a run from the bound origin"),
		when(s.kind === "operator", "a run from an operator base"),
		when(s.kind === "operator" && s.via === "env", "an operator base from the environment"),
		when(s.kind === "operator" && s.allow, "an operator base the flag admits")
	])

/** The features a run reaches. */
const runFeatures = (r: Run, expected: Expected): ReadonlyArray<ChainFeature> => {
	const hops = expected.hops
	const origins = Arr.map(hops, (hop) => hop.origin)
	return Arr.flatten<ReadonlyArray<ReadonlyArray<ChainFeature>>>([
		startFeatures(r.start),
		when(Arr.contains(Arr.drop(origins, 1), "B"), "a hop to the unbound origin"),
		when(
			Arr.some(Arr.zip(origins, Arr.drop(origins, 1)), ([from, to]) => from === "B" && to === "A"),
			"back to the bound origin"
		),
		when(
			Arr.some(
				Arr.zip(origins, Arr.take(r.redirects, hops.length - 1)),
				([from, next]) => next.relative && next.to === from
			),
			"a relative Location"
		),
		when(expected.loops, "a refused loop")
	])
}

/** The arguments that choose where a run starts. */
const startArgs = (
	s: Start,
	origins: Readonly<Record<TlsOrigin, string>>
): ReadonlyArray<string> => {
	switch (s.kind) {
		case "bound":
			return ["--base-url", origins.A]
		case "operator":
			return Arr.appendAll(
				s.via === "flag" ? ["--base-url", origins.B] : [],
				s.allow ? ["--allow-credentials-for-base-url"] : []
			)
	}
}

/** The environment that chooses where a run starts: `MTLS_BASE_URL` for an operator base from the environment. */
const startEnv = (
	s: Start,
	origins: Readonly<Record<TlsOrigin, string>>
): Readonly<Record<string, string>> =>
	s.kind === "operator" && s.via === "env" ? { MTLS_BASE_URL: origins.B } : {}

/** The lines of a run's stderr that are notices. */
const noticesOf = (stderr: Uint8Array): number =>
	Arr.length(Arr.filter(linesOf(stderr), (line) => Str.startsWith("Notice:")(line)))

/** The non-empty lines of an output. */
const linesOf = (output: Uint8Array): ReadonlyArray<string> =>
	Arr.filter(Str.split("\n")(new TextDecoder().decode(output)), Str.isNonEmpty)

/** Which of the given paths a run's stdout or stderr names. */
const leaksOf = (run: Finished, paths: ReadonlyArray<string>): ReadonlyArray<string> => {
	const output = `${new TextDecoder().decode(run.stdout)}${new TextDecoder().decode(run.stderr)}`
	return Arr.filter(paths, (path) => Str.includes(path)(output))
}

/**
 * The notices a run's contract fixes: one when it starts at an operator base, whose credentials it withholds, and none
 * when it starts at the bound origin and never leaves it; a chain from the bound origin that reaches B is not fixed.
 */
const expectedNotices = (r: Run, hops: ReadonlyArray<Hop>): Option.Option<number> =>
	r.start.kind === "operator"
		? Option.some(1)
		: Arr.every(hops, (hop) => hop.origin === "A")
			? Option.some(0)
			: Option.none()

/**
 * The environments a run is given, each with JSON errors: trust in the test CA alone, with both certificate files, or
 * with a certificate path that names no file; and every certificate path a run's output must never name.
 */
type Environments = Readonly<{
	trust: Readonly<Record<string, string>>
	complete: Readonly<Record<string, string>>
	unreadable: Readonly<Record<string, string>>
	paths: ReadonlyArray<string>
}>

/** A connection as the TLS capture server records it. */
type TlsConnectionRecord = Readonly<{ origin: TlsOrigin; certificate: Option.Option<string> }>

/** What the chains property compares of a run: its hops, exit code, notices where fixed, and printed paths. */
type ChainObservation = Readonly<{
	hops: ReadonlyArray<Hop>
	exitCode: number
	notices: Option.Option<number>
	leaks: ReadonlyArray<string>
}>

/** What the stops property compares of a run: its connections, exit code, report, notices where fixed, and printed paths. */
type StopObservation = Readonly<{
	connections: ReadonlyArray<TlsConnectionRecord>
	exitCode: number
	report: StopReport
	notices: Option.Option<number>
	leaks: ReadonlyArray<string>
}>

/** The environment a stop runs under: no certificate configured, a certificate path that names no file, or complete. */
const stopEnv = (stop: Stop, env: Environments): Readonly<Record<string, string>> => {
	switch (stop) {
		case "no certificate configured":
			return env.trust
		case "a certificate path that names no file":
			return env.unreadable
		case "a dry run":
			return env.complete
	}
}

/** One error line a run writes under `MTLS_ERROR_FORMAT=json`. */
const ErrorLine = Schema.fromJsonString(
	Schema.Struct({ error: Schema.Struct({ kind: Schema.String, message: Schema.String }) })
)

/** The errors among a run's stderr lines. */
const errorsOf = (stderr: Uint8Array) =>
	Effect.map(
		Effect.forEach(linesOf(stderr), (line) => Effect.option(Schema.decodeEffect(ErrorLine)(line))),
		(decoded) => Arr.map(Arr.getSomes(decoded), (line) => line.error)
	)

/** The certificate settings a scheme carries, which an error names when one of them needs fixing. */
const SETTINGS: ReadonlyArray<string> = ["MTLS_CLIENT_CA", "MTLS_CLIENT_CERT", "MTLS_CLIENT_KEY"]

/** What a stop's report says, as far as its contract fixes it: each error's kind, the settings it names, and whether it names the scheme; and how many lines stderr holds. */
type StopReport = Readonly<{
	errors: ReadonlyArray<
		Readonly<{ kind: string; settings: ReadonlyArray<string>; namesScheme: Option.Option<boolean> }>
	>
	lines: Option.Option<number>
}>

/**
 * A stop's report, read as its contract fixes it: a missing certificate's one error names the scheme and both of its
 * file settings; a path that names no file is the one line of stderr, an error naming that setting; a dry run reports
 * no error.
 */
const reportOf = (
	stop: Stop,
	errors: ReadonlyArray<Readonly<{ kind: string; message: string }>>,
	lines: number
): StopReport => ({
	errors: Arr.map(errors, (error) => ({
		kind: error.kind,
		settings: Arr.filter(SETTINGS, (setting) => Str.includes(setting)(error.message)),
		namesScheme:
			stop === "no certificate configured"
				? Option.some(Str.includes("client")(error.message))
				: Option.none()
	})),
	lines: stop === "a certificate path that names no file" ? Option.some(lines) : Option.none()
})

/** The report a stop's contract gives. */
const expectedReport = (stop: Stop): StopReport => {
	switch (stop) {
		case "no certificate configured":
			return {
				errors: [
					{
						kind: "CredentialMissing",
						settings: ["MTLS_CLIENT_CERT", "MTLS_CLIENT_KEY"],
						namesScheme: Option.some(true)
					}
				],
				lines: Option.none()
			}
		case "a certificate path that names no file":
			return {
				errors: [
					{ kind: "UsageError", settings: ["MTLS_CLIENT_CERT"], namesScheme: Option.none() }
				],
				lines: Option.some(1)
			}
		case "a dry run":
			return { errors: [], lines: Option.none() }
	}
}

/** The suite's fixture: the TLS capture server, the package built against origin A, its one command and its environments. */
class CertificateFixture extends Context.Service<
	CertificateFixture,
	Readonly<{
		server: TlsCaptureServer
		built: BuiltPackage
		command: ReadonlyArray<string>
		env: Environments
	}>
>()("effect-openapi-cli-generator/test/generated/certificate-chains.test/CertificateFixture") {}

const fixture = Layer.effect(
	CertificateFixture,
	Effect.gen(function* () {
		const server = yield* tlsCaptureServer
		const generated = yield* generateFixture({
			spec: { path: "openapi.json", text: spec },
			config: { path: "author-config.json", text: configOf(server.origins.A) },
			authorFiles: []
		})
		const built = yield* buildPackage(generated)
		const name = yield* Effect.fromOption(
			Arr.findFirst(
				generated.result.report.commandNames,
				(entry) => entry.pointer === "/paths/~1hop/get"
			)
		)
		const path = yield* Path.Path
		const trust = { NODE_EXTRA_CA_CERTS: server.certificates.ca.path, MTLS_ERROR_FORMAT: "json" }
		const cert = server.certificates.client.cert.path
		const key = server.certificates.client.key.path
		const env: Environments = {
			trust,
			complete: { ...trust, MTLS_CLIENT_CERT: cert, MTLS_CLIENT_KEY: key },
			unreadable: { ...trust, MTLS_CLIENT_CERT: `${cert}.absent`, MTLS_CLIENT_KEY: key },
			paths: [cert, key, server.certificates.ca.path, path.dirname(cert)]
		}
		return { server, built, command: name.path, env }
	})
).pipe(Layer.provideMerge(harnessLayer))

layer(fixture, { excludeTestServices: true })("a generated CLI's client certificate", (it) => {
	it.effect("is presented on every connection to the bound origin and on no other", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { server, built, command, env } = yield* CertificateFixture
				return yield* explore(
					{
						suite: "certificate chains",
						oracle: {
							kind: "second-implementation",
							name: "the redirect loop's model (redirect-model.ts), with the certificate on exactly the hops to the bound origin"
						},
						draw: drawn(runOf),
						literal: Formatter.format,
						coverage: required<ChainFeature>(
							[
								"a run from the bound origin",
								"a run from an operator base",
								"an operator base from the environment",
								"an operator base the flag admits",
								"a hop to the unbound origin",
								"back to the bound origin",
								"a relative Location",
								"a refused loop"
							],
							{ cases: 40, sense: notesOnly }
						),
						kept: [],
						runs: 20,
						shrink: { kind: "bounded", candidates: 40 },
						concurrency: 1,
						steerEvery: 10,
						caseHang: Duration.seconds(60)
					},
					(r, k) =>
						Effect.gen(function* () {
							const expected = expectedOf(r)
							k.noteAll(runFeatures(r, expected))
							const notices = expectedNotices(r, expected.hops)
							const observed = yield* server.observe(
								chainScript(r.redirects, server.origins, landing),
								runBin(built, {
									args: Arr.appendAll(command, startArgs(r.start, server.origins)),
									env: { ...env.complete, ...startEnv(r.start, server.origins) },
									stdin: new Uint8Array(0)
								})
							)
							deepStrictEqual<ChainObservation>(
								{
									hops: Arr.map(observed.requests, (request) => ({
										origin: request.origin,
										method: request.method,
										target: request.target,
										certificate: Option.flatMap(
											Arr.get(observed.connections, request.connection),
											(connection) => connection.certificate
										)
									})),
									exitCode: observed.result.exitCode,
									notices: Option.map(notices, () => noticesOf(observed.result.stderr)),
									leaks: leaksOf(observed.result, env.paths)
								},
								{ hops: expected.hops, exitCode: expected.exitCode, notices, leaks: [] },
								"each hop's connection presents the certificate exactly when the hop is to the bound origin, a withheld credential is noticed once, and no certificate path is printed"
							)
						})
				)
			})
		)
	)

	it.effect(
		"is never presented by a run a fault or a dry run stops: no connection, and the stop's exit code",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { server, built, command, env } = yield* CertificateFixture
					return yield* explore(
						{
							suite: "certificate stops",
							oracle: {
								kind: "specification",
								name: "no connection, the exit code and the one error each planted fault names, and no path printed"
							},
							draw: drawn(stoppedOf),
							literal: Formatter.format,
							coverage: required<Stop | StartFeature>(
								[
									"no certificate configured",
									"a certificate path that names no file",
									"a dry run",
									"a run from the bound origin",
									"a run from an operator base",
									"an operator base from the environment",
									"an operator base the flag admits"
								],
								{ cases: 30, sense: notesOnly }
							),
							kept: [],
							runs: 12,
							shrink: { kind: "bounded", candidates: 30 },
							concurrency: 1,
							steerEvery: 6,
							caseHang: Duration.seconds(60)
						},
						(c, k) =>
							Effect.gen(function* () {
								k.note(c.stop)
								k.noteAll(startFeatures(c.run.start))
								const observed = yield* server.observe(
									chainScript(c.run.redirects, server.origins, landing),
									runBin(built, {
										args: Arr.flatten([
											command,
											startArgs(c.run.start, server.origins),
											c.stop === "a dry run" ? ["--dry-run"] : []
										]),
										env: { ...stopEnv(c.stop, env), ...startEnv(c.run.start, server.origins) },
										stdin: new Uint8Array(0)
									})
								)
								const errors = yield* errorsOf(observed.result.stderr)
								const notices =
									c.stop === "a dry run" && c.run.start.kind === "bound"
										? Option.some(0)
										: Option.none()
								deepStrictEqual<StopObservation>(
									{
										connections: observed.connections,
										exitCode: observed.result.exitCode,
										report: reportOf(c.stop, errors, linesOf(observed.result.stderr).length),
										notices: Option.map(notices, () => noticesOf(observed.result.stderr)),
										leaks: leaksOf(observed.result, env.paths)
									},
									{
										connections: [],
										exitCode: stopExit(c.stop),
										report: expectedReport(c.stop),
										notices,
										leaks: []
									},
									"a stopped run opens no connection, exits with its stop's code, reports the setting to fix and prints no certificate path"
								)
							})
					)
				})
			)
	)
})
