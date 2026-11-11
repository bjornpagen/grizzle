import { Array as Arr, Option } from "effect"
import { type AnyNode, type Context, refusal } from "#oxlint/rule.ts"
import { isNamed, pathOf, propertiesNamed, testPathOf, valueOf } from "#oxlint/syntax.ts"

/** The call that retries a test until it passes, by the last name of its path. */
export const FLAKY = "flakyTest"

/** The option of a test that retries it. */
export const RETRY = "retry"

/** The option, or the modifier, that runs tests at once. */
export const CONCURRENT = "concurrent"

/** The calls besides a suite or a test that take a test's options: a layer of tests. */
export const LAYERS: ReadonlyArray<string> = ["layer"]

/** A suite, a test or a layer of tests: the calls whose options can retry a test or run tests at once. */
const takesTestOptions = (context: Context, node: AnyNode): boolean =>
	Option.isSome(testPathOf(context, node)) || isNamed(context, node, LAYERS)

const isFalse = (node: AnyNode): boolean => node.type === "Literal" && node.value === false

/** The options of a test call that retry it, or that run it beside others: any `retry`, and `concurrent` unless `false`. */
const refusedOptionsOf = (context: Context, argument: AnyNode): ReadonlyArray<AnyNode> => {
	const options = valueOf(context, argument)
	return [
		...propertiesNamed(options, RETRY),
		...Arr.filter(propertiesNamed(options, CONCURRENT), (property) => !isFalse(property.value))
	]
}

/**
 * Retries and in-file concurrency: `flakyTest`, a `retry` option, `it.concurrent`, `test.concurrent`,
 * `describe.concurrent`, and a `concurrent` option of a suite, a test or a layer. A retried test hides the
 * nondeterminism it found; tests run at once interleave by accident instead of by design.
 */
export const noRetryOrConcurrency = refusal(
	"retryOrConcurrency",
	"A test is deterministic or it is wrong: a retry hides the nondeterminism instead of removing it. Tests in a file run one at a time; a test that wants concurrency forks fibers on purpose.",
	(context, refuse) => ({
		CallExpression: (node) => {
			if (
				Option.exists(pathOf(context, node.callee), (path) =>
					Option.contains(Arr.last(path), FLAKY)
				)
			) {
				refuse(node)
			}
			if (takesTestOptions(context, node.callee)) {
				Arr.forEach(
					Arr.flatMap(node.arguments, (argument) => refusedOptionsOf(context, argument)),
					refuse
				)
			}
		},
		MemberExpression: (node) => {
			if (
				Option.exists(testPathOf(context, node), (path) =>
					Option.contains(Arr.last(path), CONCURRENT)
				)
			) {
				refuse(node)
			}
		}
	})
)
