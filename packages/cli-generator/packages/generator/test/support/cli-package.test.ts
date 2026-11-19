/**
 * A built bin runs under exactly the invocation it is given: its arguments after the bin, its whole environment and its
 * stdin, with its stdout, stderr and exit code reported whole.
 *
 * - Invocations: arguments and environment values of quotes, spaces, newlines, shell metacharacters and characters
 *   beyond ASCII, environment names in the portable shape, and stdin bytes of any value, run through a bin that
 *   prints its argv and environment as JSON on stdout, copies stdin to stderr and exits with its argument count
 *   modulo four. Oracle: the invocation itself, beside the variables the platform adds to an empty environment (macOS
 *   adds `__CF_USER_TEXT_ENCODING` to every process), read once from Node spawned directly with none.
 */
import { deepStrictEqual } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import {
	echoFixture,
	echoOf,
	type InvocationFeature,
	invocation
} from "#test/support/cli-package.fixtures.ts"
import { runBin } from "#test/support/cli-package.ts"

/**
 * The bin sees exactly the invocation, beside what the platform adds to an empty environment, and its output and exit
 * code come back whole. Its budget is the count its suite stated before the conversion: 20 independent cases, and up
 * to 60 steered while a situation is unreached.
 */
export const binRun = property.explore(invocation, {
	needs: { fixture: echoFixture, checkout: Checkout.dir },
	situations: [
		"no arguments",
		"an empty argument",
		"an empty environment",
		"an empty value",
		"no stdin",
		"a non-zero exit",
		"text beyond ASCII"
	],
	check:
		({ fixture }, k: Case<InvocationFeature>) =>
		(c) =>
			Effect.gen(function* () {
				const { built, platform } = yield* fixture
				if (Arr.isReadonlyArrayEmpty(c.args)) {
					k.note("no arguments")
				}
				if (Arr.contains(c.args, "")) {
					k.note("an empty argument")
				}
				if (Rec.isEmptyReadonlyRecord(c.env)) {
					k.note("an empty environment")
				}
				if (Arr.contains(Rec.values(c.env), "")) {
					k.note("an empty value")
				}
				if (c.stdin.length === 0) {
					k.note("no stdin")
				}
				if (c.args.length % 4 !== 0) {
					k.note("a non-zero exit")
				}
				if (
					Arr.some(Arr.appendAll(c.args, Rec.values(c.env)), (text) =>
						Arr.some(Arr.fromIterable(text), (character) => character > "\u007f")
					)
				) {
					k.note("text beyond ASCII")
				}
				const run = yield* runBin(built, c)
				const echoed = yield* echoOf(run)
				deepStrictEqual(
					echoed,
					{
						args: c.args,
						env: Rec.union(platform.env, c.env, (_platform, invoked) => invoked),
						stdin: c.stdin,
						exitCode: c.args.length % 4
					},
					"the bin sees exactly the invocation, beside what the platform adds to an empty environment, and its output and exit code come back whole"
				)
			}),
	oracle: { kind: "universal", name: "the invocation a bin reports is the one it was given" },
	kept: [],
	budget: { runs: 20, steered: 60 },
	kills: [
		{
			file: "packages/generator/test/support/cli-package.ts",
			original:
				"\t\t\tenv: invocation.env,\n\t\t\textendEnv: false,\n\t\t\tstdin: { stream: Stream.make(invocation.stdin) },",
			replacement:
				"\t\t\tenv: invocation.env,\n\t\t\textendEnv: true,\n\t\t\tstdin: { stream: Stream.make(invocation.stdin) },",
			why: "A bin runs with the runner's environment beside its own, so it sees variables its invocation never gave; the property fails."
		},
		{
			file: "packages/generator/test/support/cli-package.ts",
			original: "\t\t\tstdin: { stream: Stream.make(invocation.stdin) },\n\t\t\tkillSignal",
			replacement: '\t\t\tstdin: "ignore",\n\t\t\tkillSignal',
			why: "A bin's stdin is never written, so the bytes an invocation gives it are lost; the property fails."
		}
	]
})
