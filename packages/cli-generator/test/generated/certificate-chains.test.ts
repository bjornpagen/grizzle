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
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import {
	certificateFixture,
	type ChainFeature,
	type ChainObservation,
	errorsOf,
	expectedNotices,
	expectedOf,
	expectedReport,
	landing,
	leaksOf,
	linesOf,
	noticesOf,
	reportOf,
	runFeatures,
	runOf,
	startArgs,
	startEnv,
	type StartFeature,
	startFeatures,
	type Stop,
	stopEnv,
	stopExit,
	type StopObservation,
	stops
} from "#test/generated/certificate-chains.fixtures.ts"
import { runBin } from "#test/support/cli-package.ts"
import { chainScript } from "#test/support/redirect-model.ts"

/**
 * Each hop's connection presents the certificate exactly when the hop is to the bound origin, a withheld credential is
 * noticed once, and no certificate path is printed. Its budget is the count its suite stated before the conversion: 20 independent
 * cases, and up to 40 steered while a situation is unreached.
 */
export const certificateChains = property.explore(runOf, {
	needs: { fixture: certificateFixture, checkout: Checkout.dir },
	situations: [
		"a run from the bound origin",
		"a run from an operator base",
		"an operator base from the environment",
		"an operator base the flag admits",
		"a hop to the unbound origin",
		"back to the bound origin",
		"a relative Location",
		"a refused loop"
	],
	check:
		({ fixture }, k: Case<ChainFeature>) =>
		(r) =>
			Effect.gen(function* () {
				const { server, built, command, env } = yield* fixture
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
				assert.deepEqual<ChainObservation>(
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
			}),
	oracle: {
		kind: "second-implementation",
		name: "the redirect loop's model (redirect-model.ts), with the certificate on exactly the hops to the bound origin"
	},
	kept: [],
	budget: { runs: 20, steered: 40 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
			original:
				"export const presentsCertificate = (url: string, boundOrigins: readonly string[]): boolean =>\n\tisBound(url, boundOrigins)",
			replacement:
				"export const presentsCertificate = (url: string, boundOrigins: readonly string[]): boolean =>\n\ttrue",
			why: "Every hop presents the certificate, so a hop to the unbound origin carries it; the property fails."
		}
	]
})

/**
 * A run a fault or a dry run stops opens no connection, exits with its stop's code, reports the setting to fix and prints
 * no certificate path; while a stop or a start is still pending, a case aimed at it draws a run made to reach it (stops). Its budget is the count its suite stated before the conversion: 12 independent
 * cases, and up to 30 steered while a situation is unreached.
 */
export const certificateStops = property.explore(stops, {
	needs: { fixture: certificateFixture, checkout: Checkout.dir },
	situations: [
		"no certificate configured",
		"a certificate path that names no file",
		"a dry run",
		"a run from the bound origin",
		"a run from an operator base",
		"an operator base from the environment",
		"an operator base the flag admits"
	],
	check:
		({ fixture }, k: Case<Stop | StartFeature>) =>
		(c) =>
			Effect.gen(function* () {
				const { server, built, command, env } = yield* fixture
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
				const errors = errorsOf(observed.result.stderr)
				const notices =
					c.stop === "a dry run" && c.run.start.kind === "bound" ? Option.some(0) : Option.none()
				assert.deepEqual<StopObservation>(
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
			}),
	oracle: {
		kind: "specification",
		name: "no connection, the exit code and the one error each planted fault names, and no path printed"
	},
	kept: [],
	budget: { runs: 12, steered: 30 },
	kills: [
		{
			file: "packages/cli-generator/src/emit/entry.ts",
			original:
				'\t\t["cert", fn("certificateFile", path("scheme.certEnv"), path("configured.cert"))],',
			replacement:
				'\t\t["cert", fn("certificateFile", path("scheme.keyEnv"), path("configured.cert"))],',
			why: "A certificate path that names no file is refused naming the key's setting, not the certificate's; the property fails."
		}
	]
})
