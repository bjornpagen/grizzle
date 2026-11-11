import { Array as Arr, Option } from "effect"
import { type AnyNode, type Context, refusal } from "#oxlint/rule.ts"
import { isNamed, pathOf, propertiesNamed, testPathOf, valueOf } from "#oxlint/syntax.ts"

/** A suite, a test or a layer of tests: the calls whose options can retry a test or run tests at once. */
const takesTestOptions = (context: Context, node: AnyNode): boolean =>
	Option.isSome(testPathOf(context, node)) || isNamed(context, node, ["layer"])

const isFalse = (node: AnyNode): boolean => node.type === "Literal" && node.value === false

/** The options of a test call that retry it, or that run it beside others: any `retry`, and `concurrent` unless `false`. */
const refusedOptionsOf = (context: Context, argument: AnyNode): ReadonlyArray<AnyNode> => {
	const options = valueOf(context, argument)
	return [
		...propertiesNamed(options, "retry"),
		...Arr.filter(propertiesNamed(options, "concurrent"), (property) => !isFalse(property.value))
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
					Option.contains(Arr.last(path), "flakyTest")
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
					Option.contains(Arr.last(path), "concurrent")
				)
			) {
				refuse(node)
			}
		}
	})
)
