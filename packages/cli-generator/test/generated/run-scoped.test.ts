/**
 * A generated CLI renders a run's error once, in the run's error format, and warns once per run.
 *
 * - Format: `--error-format`, then `<PREFIX>_ERROR_FORMAT`, then text (design 7.4). An error raised before the
 *   arguments are parsed (a missing required flag) or at start-up (an unreadable client certificate) is rendered by
 *   the variable alone: json when it says `json`, text otherwise. An error in the command (a body that is not JSON) is
 *   rendered by the flag, else the variable; a variable that is neither `text` nor `json` is itself the command's
 *   error, rendered as text. `json` is exactly one `{"error":{...}}` line naming the error's kind and no text error;
 *   text is an `Error:` line or an `ERROR` section and no JSON object. Every case exits 2 before any connection, and no
 *   message shows the invalid variable's value or the certificate's path.
 * - Warnings: a header credential sent in plaintext to a host that is not loopback warns exactly once in a run, however
 *   many attempts `--retries` makes against a `503`, each attempt carrying the credential.
 *
 * One package with a mutual-TLS scheme beside a header key. An exhaustion of every error under every flag, variable and
 * invalid-variable setting, and an exhaustion of retry counts through a recording proxy.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, Option, Path, String as Str } from "effect"
import {
	busy,
	caseFeatures,
	done,
	type ErrorOutcome,
	errorCases,
	expectedError,
	expectedWarning,
	faultArgs,
	type FormatFeature,
	INVALID_FORMAT,
	KEY,
	MISSING_CERTIFICATE,
	PLAIN_HOST,
	renderedOf,
	RETRY_FEATURES,
	type RetryFeature,
	retryCounts,
	runFixture,
	type WarningOutcome
} from "#test/generated/run-scoped.fixtures.ts"
import { runBin } from "#test/support/cli-package.ts"
import { valuesOf } from "#test/support/http.ts"

/** Each error renders once in the run's format, before any connection, showing no secret. */
export const errorRendering = property.exhaust(errorCases, {
	box: "every error (in the command, before the arguments are parsed, at start-up) under every error-format flag and variable setting, an invalid variable among them",
	needs: { fixture: runFixture, scratch: Scratch.dir, checkout: Checkout.dir },
	situations: [
		"rendered as json",
		"rendered as text",
		"the flag set",
		"the variable set",
		"an invalid variable"
	],
	check:
		({ fixture, scratch: scratchDir }, k: Case<FormatFeature>) =>
		(c) =>
			Effect.gen(function* () {
				const { server, built, command } = yield* fixture
				const path = yield* Path.Path
				const scratch = yield* scratchDir
				const certificate = path.join(scratch, MISSING_CERTIFICATE)
				k.noteAll(caseFeatures(c))
				const observed = yield* server.observe(
					() => done,
					runBin(built, {
						args: Arr.flatten([
							command,
							["--base-url", server.origins["127.0.0.1"]],
							Option.match(c.setting.flag, {
								onNone: () => [],
								onSome: (format) => ["--error-format", format]
							}),
							faultArgs(c.fault)
						]),
						env: {
							RUNS_HEADER_KEY: KEY,
							...Option.match(c.setting.variable, {
								onNone: () => ({}),
								onSome: (variable) => ({
									RUNS_ERROR_FORMAT: variable === "invalid" ? INVALID_FORMAT : variable
								})
							}),
							...(c.fault === "an unreadable certificate"
								? { RUNS_CLIENT_CERT: certificate, RUNS_CLIENT_KEY: certificate }
								: {})
						},
						stdin: new Uint8Array(0)
					})
				)
				const stderr = Buffer.from(observed.result.stderr).toString("utf8")
				assert.deepEqual<ErrorOutcome>(
					{
						exitCode: observed.result.exitCode,
						connections: observed.connections.length,
						rendered: renderedOf(stderr),
						showsSecret:
							Str.includes(INVALID_FORMAT)(stderr) || Str.includes(MISSING_CERTIFICATE)(stderr)
					},
					expectedError(c),
					"the error renders once in the run's format, before any connection, showing no secret"
				)
			}),
	oracle: {
		kind: "specification",
		name: "design 7.4's error format: the error once in the run's format, exit 2 before any connection, and no secret shown"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: '(Option.getOrUndefined(env) === "json" ? "json" : "text")',
			replacement: '("text")',
			why: "An error raised before the arguments are parsed renders as text whatever the variable says, so a missing required flag under a json variable is no JSON line; the property fails."
		}
	]
})

/** A run warns once however many attempts carry the credential. */
export const warnsOnce = property.exhaust(retryCounts, {
	box: "0, 1 and 2 retries against a 503, each attempt carrying a header key to a plaintext host",
	needs: { fixture: runFixture, checkout: Checkout.dir },
	situations: RETRY_FEATURES,
	check:
		({ fixture }, k: Case<RetryFeature>) =>
		(retries) =>
			Effect.gen(function* () {
				const { server, proxy, plainBase, built, command } = yield* fixture
				k.noteAll(Option.toArray(Arr.get(RETRY_FEATURES, retries)))
				const observed = yield* proxy.observe(
					server.observe(
						() => busy,
						runBin(built, {
							args: Arr.flatten([
								command,
								[
									"--base-url",
									plainBase,
									"--allow-credentials-for-base-url",
									"--retry-unsafe",
									"--retries",
									String(retries),
									"--owner",
									"o",
									"--body",
									"{}"
								]
							]),
							env: { RUNS_HEADER_KEY: KEY, HTTP_PROXY: proxy.url },
							stdin: new Uint8Array(0)
						})
					)
				)
				const stderr = Buffer.from(observed.result.result.stderr).toString("utf8")
				assert.deepEqual<WarningOutcome>(
					{
						exitCode: observed.result.result.exitCode,
						keys: Arr.map(observed.result.requests, (request) =>
							valuesOf(request.headers, "x-key")
						),
						warningsNamingTheHost: Arr.map(
							Arr.filter(Str.split("\n")(stderr), Str.startsWith("Warning:")),
							Str.includes(PLAIN_HOST)
						)
					},
					expectedWarning(retries),
					"one warning per run, each attempt carrying the key"
				)
			}),
	oracle: {
		kind: "specification",
		name: "one plaintext warning a run, however many attempts carry the credential"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "\t\t\tconst allowedByFlag = sendsToBase && !bound.includes(baseOrigin)",
			replacement: "\t\t\tconst allowedByFlag = false",
			why: "No plaintext warning is printed though --allow-credentials-for-base-url sends the key to a plaintext host that is not bound; the property fails."
		}
	]
})
