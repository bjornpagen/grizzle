import { Array as Arr, Option } from "effect"
import { type AnyNode, type Context, refusal } from "#oxlint/rule.ts"
import { isCallTo, isLiteralOf, keyOf, valueOf } from "#oxlint/syntax.ts"

/** A seed written into the test: a number, a bigint or a string literal, negated or not, or a `const` that holds one. */
const isFixed = (context: Context, node: AnyNode): boolean => {
	const value = valueOf(context, node)
	if (value.type === "UnaryExpression") {
		return value.operator === "-" && isFixed(context, value.argument)
	}
	return isLiteralOf(value, ["bigint", "number", "string"])
}

/**
 * The calls that take a seed, and where: the argument at an index, or any argument of a call that takes the seed in
 * either of its forms (data first or piped). A stream (`sample`'s, `caseSeed`'s) is branded by what fixes it, so a
 * literal there is a type error, and needs no rule.
 */
const SEEDED: ReadonlyArray<readonly [callee: string, at: number | "any"]> = [
	["Random.withSeed", "any"],
	["wordsOf", 0],
	["rotatingSeed", 0]
]

/** The calls that take a run, whose `seed` field seeds every case. */
const RUNS: ReadonlyArray<string> = ["Run.of"]

const isSeedArgument = (context: Context, call: AnyNode, argument: AnyNode): boolean =>
	call.type === "CallExpression" &&
	Arr.some(
		SEEDED,
		([callee, at]) =>
			isCallTo(context, call, [callee]) &&
			(at === "any" ? Arr.contains(call.arguments, argument) : call.arguments[at] === argument)
	)

/**
 * A seed written into a test, where the library or a generator takes one: the `seed` of a run, the seed of a word
 * stream, a rotating stream's run seed, `Random.withSeed(<literal>)`. A fixed seed searches one corner forever; the run
 * draws the seed, and a failure replays from it. A field named `seed` anywhere else is the suite's own data (a sketch's,
 * a kept case's) and is no seed of the search.
 */
export const noFixedSeed = refusal(
	"fixedSeed",
	"A fixed seed searches the same inputs on every run. Seeds come from the run, and TEST_SEED replays a failing one; pin an input that matters as a kept case instead.",
	(context, refuse) => ({
		Property: (node) => {
			const object = node.parent
			if (
				object.type === "ObjectExpression" &&
				object.parent.type === "CallExpression" &&
				isCallTo(context, object.parent, RUNS) &&
				Option.contains(keyOf(node), "seed") &&
				isFixed(context, node.value)
			) {
				refuse(node)
			}
		},
		CallExpression: (node) => {
			if (
				Arr.some(
					node.arguments,
					(argument) => isSeedArgument(context, node, argument) && isFixed(context, argument)
				)
			) {
				refuse(node)
			}
		}
	})
)
