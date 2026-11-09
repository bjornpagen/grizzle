import { type AnyNode, type Context, refusal } from "#oxlint/rule.ts"
import { isCallTo, valueOf } from "#oxlint/syntax.ts"

/** A count written as a positive integer: a number literal of at least 1, or a `const` that holds one. */
const isPositiveCount = (context: Context, node: AnyNode): boolean => {
	const value = valueOf(context, node)
	return (
		value.type === "Literal" &&
		typeof value.value === "number" &&
		Number.isInteger(value.value) &&
		value.value >= 1
	)
}

/**
 * Effect's `Array.makeBy(n, f)` over a count no positive literal states. makeBy normalizes its count to at least 1, so a
 * count that is 0 makes one element: a generator that draws 0 never draws its empty case, and a size of 0 is built as
 * 1, with no failure to say so. Its data-last form takes its count from the pipe, so it states none either.
 */
export const noClampedCount = refusal(
	"clampedCount",
	"Array.makeBy makes at least one element: a count of 0 makes one, so a search never reaches its empty case. Make 0 … n − 1 with a helper that makes none for 0 (the repository's upTo), or write a positive literal count.",
	(context, refuse) => ({
		CallExpression: (node) => {
			if (!isCallTo(context, node, ["Array.makeBy", "makeBy"])) {
				return
			}
			const [count, make] = node.arguments
			if (count === undefined || make === undefined || !isPositiveCount(context, count)) {
				refuse(node)
			}
		}
	})
)
