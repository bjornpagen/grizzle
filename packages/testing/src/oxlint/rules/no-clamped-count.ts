import { Array as Arr, Option } from "effect"
import { type AnyNode, type Context, refusal } from "#oxlint/rule.ts"
import { isCallTo, propertiesNamed, valueOf } from "#oxlint/syntax.ts"

/**
 * How a clamping constructor takes its count: an argument of its data-first call and of its data-last call, where a
 * data-last call that takes the count from the pipe states none (`count`); a range's two inclusive ends, whose count is
 * end − start + 1, and where Iterable's range given its start alone is endless (`ends`); or Iterable.makeBy's `length`
 * option, whose absence makes an endless iterable (`length`).
 */
export type Clamp =
	| Readonly<{ kind: "count"; dataFirst: number; dataLast: number | "piped" }>
	| Readonly<{ kind: "ends"; endless: boolean }>
	| Readonly<{ kind: "length" }>

/**
 * Effect's constructors that normalize their count to at least 1, so a count of 0, or a range whose end is below its
 * start, makes one item: Array's and Chunk's makeBy and range, and Array's and Iterable's replicate, Iterable's range
 * and Iterable.makeBy's length (effect/src/internal/count.ts normalizeNonEmpty, which each reads).
 */
export const CLAMPED: ReadonlyArray<readonly [callee: string, clamp: Clamp]> = [
	["Array.makeBy", { kind: "count", dataFirst: 0, dataLast: "piped" }],
	["Array.range", { kind: "ends", endless: false }],
	["Array.replicate", { kind: "count", dataFirst: 1, dataLast: 0 }],
	["Chunk.makeBy", { kind: "count", dataFirst: 0, dataLast: "piped" }],
	["Chunk.range", { kind: "ends", endless: false }],
	["Iterable.makeBy", { kind: "length" }],
	["Iterable.range", { kind: "ends", endless: true }],
	["Iterable.replicate", { kind: "count", dataFirst: 1, dataLast: 0 }]
]

/** The option of Iterable.makeBy that holds its count. */
export const LENGTH = "length"

/** An integer written as a number literal, negated or not, or a `const` that holds one. */
const writtenInteger = (context: Context, node: AnyNode): Option.Option<number> => {
	const value = valueOf(context, node)
	if (value.type === "UnaryExpression" && value.operator === "-") {
		return Option.map(writtenInteger(context, value.argument), (magnitude) => -magnitude)
	}
	return value.type === "Literal" &&
		typeof value.value === "number" &&
		Number.isInteger(value.value)
		? Option.some(value.value)
		: Option.none()
}

/** A count written as a positive integer: the one count no clamping constructor normalizes. */
const statesPositive = (context: Context, node: AnyNode | undefined): boolean =>
	node !== undefined && Option.exists(writtenInteger(context, node), (count) => count >= 1)

/** A range's ends written as integers, the start at most the end: a range of at least one item, as written. */
const statesEnds = (context: Context, start: AnyNode, end: AnyNode): boolean =>
	Option.exists(
		Option.all([writtenInteger(context, start), writtenInteger(context, end)]),
		([from, to]) => from <= to
	)

/** Whether a call to a clamping constructor states a count it never normalizes, read as its clamp reads it. */
const statesCount = (context: Context, clamp: Clamp, args: ReadonlyArray<AnyNode>): boolean => {
	const [first, second] = args
	switch (clamp.kind) {
		case "count":
			return second === undefined
				? clamp.dataLast !== "piped" && statesPositive(context, args[clamp.dataLast])
				: statesPositive(context, args[clamp.dataFirst])
		case "ends":
			if (first === undefined) {
				return false
			}
			return second === undefined ? clamp.endless : statesEnds(context, first, second)
		case "length": {
			if (second === undefined) {
				return first !== undefined
			}
			const options = valueOf(context, second)
			return (
				options.type === "ObjectExpression" &&
				Arr.every(propertiesNamed(options, LENGTH), (property) =>
					statesPositive(context, property.value)
				)
			)
		}
	}
}

/**
 * A call to one of Effect's clamping constructors over a count no positive literal states: makeBy or replicate of a
 * count that is not a positive integer literal, a data-last makeBy, whose count comes from the pipe, and a range whose
 * ends are not integer literals with the start at most the end. Each makes one item where its count is 0, so a
 * generator that draws 0 never draws its empty case, and a size of 0 is built as 1, with no failure to say so. An
 * endless range or makeBy, with no end or no length, clamps nothing.
 */
export const noClampedCount = refusal(
	"clampedCount",
	"Effect's makeBy, replicate and range make at least one item: a count of 0, or a range whose end is below its start, makes one, so a search never reaches its empty case. Make n items with Array.from({ length: n }, (_, i) => …), which makes none for 0, or write a positive literal count.",
	(context, refuse) => ({
		CallExpression: (node) => {
			if (
				Arr.some(
					CLAMPED,
					([callee, clamp]) =>
						isCallTo(context, node, [callee]) && !statesCount(context, clamp, node.arguments)
				)
			) {
				refuse(node)
			}
		}
	})
)
