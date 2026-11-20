/**
 * A CLI in the generated entry's shape renders a run's error in the run's error format (design 7.4), through the
 * parser, the presenter, recordRun, send and the final catch together.
 *
 * - An error the parser decides (a flag the command does not know, a value a flag refuses) is rendered by
 *   `<PREFIX>_ERROR_FORMAT` alone, since nothing was recorded: as json, its one `{"error":{...}}` object, the help the
 *   presenter held for it dropped; as text, that help, then the error. The root run with no subcommand prints its help
 *   on stderr under either format and exits 0.
 * - An error in the command is rendered by `--error-format`, else the variable, else text, which recordRun records
 *   before the handler runs; a variable that is neither `text` nor `json` is itself the command's error, naming the
 *   variable and never its value.
 * - A `404` after a request D-AD7 would retry, by the method and Idempotency-Key `send` recorded, carries the retry
 *   hint: a second sentence of the json message, a line of its own in text.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	askedHelp,
	expectedOf,
	type Ran,
	ranOf,
	RUN_FEATURES,
	type RunFeature,
	runFeatures,
	runs
} from "#test/runtime/output-error-json.fixtures.ts"

/** Each run prints exactly what design 7.4 says, and exits with its code. */
export const errorFormat = property.exhaust(runs, {
	box: "an unknown flag, a refused value, the root with no subcommand, a usage error in the handler and a 404 after each of GET, PUT, DELETE, POST and PATCH with and without an Idempotency-Key, each under every --error-format (absent, text, json) and EXAMPLE_ERROR_FORMAT (absent, text, json, invalid)",
	needs: { asked: askedHelp },
	situations: RUN_FEATURES,
	check:
		({ asked }, c: Case<RunFeature>) =>
		(run) =>
			Effect.gen(function* () {
				c.noteAll(runFeatures(run))
				const help = yield* asked
				const ran = yield* ranOf(run)
				assert.deepEqual<Ran>(
					ran,
					expectedOf(run, help),
					"the run prints what design 7.4 says, in the run's format, and exits with its code"
				)
			}),
	oracle: {
		kind: "specification",
		name: "design 7.4's error format: a parse error by the variable alone, its held help dropped under json; an error in the command by the flag, else the variable; the retry hint after a request D-AD7 retries"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: '\tconst json = rendering.format === "json"',
			replacement: '\tconst json = rendering.format !== "json"',
			why: "A run recorded as json renders text and one recorded as text renders json; the property fails (TESTPOLICY2's census, mutant cbd6610b04)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "const help = flushHeldHelp(json && rendered !== undefined)",
			replacement: "const help = flushHeldHelp(false)",
			why: "A parse error under json prints the help the presenter held before its object, so stderr is no longer one object; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: ": Ref.update(record.value, (state) => ({ ...state, help }))",
			replacement: ": Console.error(help)",
			why: "The presenter prints the help at once instead of holding it, so a parse error under json prints help beside its object; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "? flushHeldHelp(false)",
			replacement: "? flushHeldHelp(true)",
			why: "The help the presenter held for the root run with no subcommand is dropped, so that run prints nothing; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original:
				"const format = Option.isSome(flag) ? flag.value : yield* envErrorFormat(envPrefix)",
			replacement: "const format = yield* envErrorFormat(envPrefix)",
			why: "recordRun reads the variable over --error-format, so the flag no longer decides the format of an error in the command; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: 'idempotencyKey: Headers.has(request.headers, "idempotency-key"),',
			replacement: "idempotencyKey: false,",
			why: "send records no Idempotency-Key, so a 404 after a POST that carried one has no retry hint; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "method: request.method",
			replacement: 'method: "GET"',
			why: "send records every request as a GET, so a 404 after a POST without an Idempotency-Key carries the retry hint; the property fails."
		}
	]
})
