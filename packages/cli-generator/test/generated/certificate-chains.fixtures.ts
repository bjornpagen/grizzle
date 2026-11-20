import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import { aimed, boolean, constant, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Duration, Effect, Option, Path, Schema, String as Str } from "effect"
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
	workerFixture
} from "#test/support/cli-package.ts"
import type { Finished } from "#test/support/process.ts"
import { followChain, type Redirect, redirectsOf } from "#test/support/redirect-model.ts"
import { latin1Bytes } from "#test/support/wire.ts"

/** What the certificate-chains properties (certificate-chains.test.ts) draw and their fixture: the chains and stops. */

/** The landing the chain ends with: an empty JSON object. */
export const landing: ScriptedResponse = {
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
const spec = jsonText({
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
	jsonText({
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
export type Stop =
	| "no certificate configured"
	| "a certificate path that names no file"
	| "a dry run"

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
export const runOf: Gen<Run> = (source) => ({
	start: start(source),
	redirects: redirectsOf(element<TlsOrigin>(["A", "B"]), { min: 0, max: 12 })(source)
})

/** Every stop, in its suite's order. */
const STOPS: Arr.NonEmptyReadonlyArray<Stop> = [
	"no certificate configured",
	"a certificate path that names no file",
	"a dry run"
]

const stoppedOf: Gen<Stopped> = (source) => ({
	run: runOf(source),
	stop: element<Stop>(STOPS)(source)
})

/** An operator base by `via`, admitted by the flag as `allow` draws. */
const operatorStart =
	(via: Gen<"flag" | "env">, allow: Gen<boolean>): Gen<Start> =>
	(source) => ({ kind: "operator", via: source.draw(via), allow: source.draw(allow) })

/** A stopped run from a start `begin` draws, stopped by what `stop` draws. */
const stoppedWith =
	(begin: Gen<Start>, stop: Gen<Stop>): Gen<Stopped> =>
	(source) => ({
		run: {
			start: source.draw(begin),
			redirects: source.draw(redirectsOf(element<TlsOrigin>(["A", "B"]), { min: 0, max: 12 }))
		},
		stop: source.draw(stop)
	})

/** Either way an operator names a base. */
const VIAS: Arr.NonEmptyReadonlyArray<"flag" | "env"> = ["flag", "env"]

/**
 * The stopped runs a search draws: the rotating stream's as the suite drew them (stoppedOf); a case aimed at a stop or
 * a start still pending, from a run made to reach it.
 */
export const stops = aimed(stoppedOf, [
	...Arr.map(STOPS, (stop) => [stop, stoppedWith(start, constant(stop))] as const),
	["a run from the bound origin", stoppedWith(constant<Start>({ kind: "bound" }), element(STOPS))],
	[
		"a run from an operator base",
		stoppedWith(operatorStart(element(VIAS), boolean), element(STOPS))
	],
	[
		"an operator base from the environment",
		stoppedWith(operatorStart(constant<"flag" | "env">("env"), boolean), element(STOPS))
	],
	[
		"an operator base the flag admits",
		stoppedWith(operatorStart(element(VIAS), constant(true)), element(STOPS))
	]
])

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
export const expectedOf = (r: Run): Expected => {
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
export const stopExit = (stop: Stop): number => {
	switch (stop) {
		case "no certificate configured":
			return 3
		case "a certificate path that names no file":
			return 2
		case "a dry run":
			return 0
	}
}

export type StartFeature =
	| "a run from the bound origin"
	| "a run from an operator base"
	| "an operator base from the environment"
	| "an operator base the flag admits"

export type ChainFeature =
	| StartFeature
	| "a hop to the unbound origin"
	| "back to the bound origin"
	| "a relative Location"
	| "a refused loop"

/** A feature when it holds, none otherwise. */
const when = <F extends string>(holds: boolean, feature: F): ReadonlyArray<F> =>
	holds ? [feature] : []

/** The features of where a run starts. */
export const startFeatures = (s: Start): ReadonlyArray<StartFeature> =>
	Arr.flatten<ReadonlyArray<ReadonlyArray<StartFeature>>>([
		when(s.kind === "bound", "a run from the bound origin"),
		when(s.kind === "operator", "a run from an operator base"),
		when(s.kind === "operator" && s.via === "env", "an operator base from the environment"),
		when(s.kind === "operator" && s.allow, "an operator base the flag admits")
	])

/** The features a run reaches. */
export const runFeatures = (r: Run, expected: Expected): ReadonlyArray<ChainFeature> => {
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
export const startArgs = (
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
export const startEnv = (
	s: Start,
	origins: Readonly<Record<TlsOrigin, string>>
): Readonly<Record<string, string>> =>
	s.kind === "operator" && s.via === "env" ? { MTLS_BASE_URL: origins.B } : {}

/** The lines of a run's stderr that are notices. */
export const noticesOf = (stderr: Uint8Array): number =>
	Arr.length(Arr.filter(linesOf(stderr), (line) => Str.startsWith("Notice:")(line)))

/** The non-empty lines of an output. */
export const linesOf = (output: Uint8Array): ReadonlyArray<string> =>
	Arr.filter(Str.split("\n")(new TextDecoder().decode(output)), Str.isNonEmpty)

/** Which of the given paths a run's stdout or stderr names. */
export const leaksOf = (run: Finished, paths: ReadonlyArray<string>): ReadonlyArray<string> => {
	const output = `${new TextDecoder().decode(run.stdout)}${new TextDecoder().decode(run.stderr)}`
	return Arr.filter(paths, (path) => Str.includes(path)(output))
}

/**
 * The notices a run's contract fixes: one when it starts at an operator base, whose credentials it withholds, and none
 * when it starts at the bound origin and never leaves it; a chain from the bound origin that reaches B is not fixed.
 */
export const expectedNotices = (r: Run, hops: ReadonlyArray<Hop>): Option.Option<number> =>
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
export type ChainObservation = Readonly<{
	hops: ReadonlyArray<Hop>
	exitCode: number
	notices: Option.Option<number>
	leaks: ReadonlyArray<string>
}>

/** What the stops property compares of a run: its connections, exit code, report, notices where fixed, and printed paths. */
export type StopObservation = Readonly<{
	connections: ReadonlyArray<TlsConnectionRecord>
	exitCode: number
	report: StopReport
	notices: Option.Option<number>
	leaks: ReadonlyArray<string>
}>

/** The environment a stop runs under: no certificate configured, a certificate path that names no file, or complete. */
export const stopEnv = (stop: Stop, env: Environments): Readonly<Record<string, string>> => {
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
export const errorsOf = (stderr: Uint8Array) =>
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
export const reportOf = (
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
export const expectedReport = (stop: Stop): StopReport => {
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

/** The suite's fixture, once per worker: the TLS capture server, the package built against origin A, its one command and its environments. */
export const certificateFixture = workerFixture(
	"test/generated/certificate-chains.fixtures.ts certificateFixture",
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
		const opened: Readonly<{
			server: TlsCaptureServer
			built: BuiltPackage
			command: ReadonlyArray<string>
			env: Environments
		}> = { server, built, command: name.path, env }
		return opened
	})
)
