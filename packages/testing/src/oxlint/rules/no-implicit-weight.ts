import { Array as Arr, Option } from "effect"
import { type AnyNode, type Context, refusal } from "#oxlint/rule.ts"
import { isCallTo, valueOf } from "#oxlint/syntax.ts"

/** The choices that draw each entry of a list equally often. */
export const CHOICES: ReadonlyArray<string> = ["element", "oneOf"]

/** The choices whose arms pair a weight with a generator. */
export const ARMS: ReadonlyArray<string> = ["weighted", "proportional"]

/**
 * The items a list writes out: an array literal's, or those of the `const` that holds one, spreads and holes aside,
 * since what a spread adds is not written there; none for a list that is no literal.
 */
const itemsOf = (context: Context, node: AnyNode): Option.Option<ReadonlyArray<AnyNode>> => {
	const list = valueOf(context, node)
	return list.type === "ArrayExpression"
		? Option.some(
				Arr.getSomes(
					Arr.map(list.elements, (item) =>
						item === null || item.type === "SpreadElement" ? Option.none() : Option.some(item)
					)
				)
			)
		: Option.none()
}

/** The generator of an arm written as a pair, `[weight, generator]`. */
const generatorOf = (context: Context, arm: AnyNode): Option.Option<AnyNode> =>
	Option.flatMap(itemsOf(context, arm), (pair) => Arr.get(pair, 1))

/** Whether two of the options are written alike. */
const repeats = (context: Context, options: ReadonlyArray<AnyNode>): boolean => {
	const texts = Arr.map(options, (option) => context.sourceCode.getText(option))
	return Arr.dedupe(texts).length < texts.length
}

/**
 * A choice that weighs an option by writing it twice: an `element` or a `oneOf` whose written list holds one entry
 * more than once, and a `weighted` or a `proportional` with two written arms of one generator, each compared by its
 * text. Each entry is drawn equally often, so the repetition is a weight nobody stated, read off a count of lines.
 */
export const noImplicitWeight = refusal(
	"implicitWeight",
	"This weighs an option by writing it more than once, a weight nobody stated. Write each option once and state its weight with weighted([[2, constant(a)], [1, constant(b)]]).",
	(context, refuse) => ({
		CallExpression: (node) => {
			const [list] = node.arguments
			if (list === undefined) {
				return
			}
			if (isCallTo(context, node, CHOICES)) {
				if (Option.exists(itemsOf(context, list), (items) => repeats(context, items))) {
					refuse(node)
				}
				return
			}
			if (
				isCallTo(context, node, ARMS) &&
				Option.exists(itemsOf(context, list), (arms) =>
					repeats(context, Arr.getSomes(Arr.map(arms, (arm) => generatorOf(context, arm))))
				)
			) {
				refuse(node)
			}
		}
	})
)
