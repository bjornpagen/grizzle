import { Array as Arr, Option } from "effect"
import { type AnyNode, type Context, refusal } from "#oxlint/rule.ts"
import { isCallTo, isNamed, ORDERED_EQUALITIES, pathOf, sidesOf, valueOf } from "#oxlint/syntax.ts"

/** The calls that list the keys, values or entries of an unordered collection as an array or an iterator. */
const PROJECTIONS: ReadonlyArray<string> = [
	"HashMap.entries",
	"HashMap.keys",
	"HashMap.toEntries",
	"HashMap.toValues",
	"HashMap.values",
	"MutableHashMap.keys",
	"MutableHashMap.values",
	"Object.entries",
	"Object.keys",
	"Object.values",
	"Record.collect",
	"Record.keys",
	"Record.toEntries",
	"Record.values"
]

/** The methods that iterate a Map's or a Set's keys, values or entries. */
const ITERATIONS: ReadonlyArray<string> = ["entries", "keys", "values"]

/** The modules whose calls build hash collections. */
const HASH_COLLECTIONS: ReadonlyArray<string> = [
	"HashMap",
	"HashSet",
	"MutableHashMap",
	"MutableHashSet"
]

const isIteration = (node: AnyNode): boolean =>
	node.type === "CallExpression" &&
	Arr.isReadonlyArrayEmpty(node.arguments) &&
	node.callee.type === "MemberExpression" &&
	!node.callee.computed &&
	Arr.contains(ITERATIONS, node.callee.property.name)

/** A Set or a Map: built by its constructor or by a hash collection module, or named by a `const` that holds one. */
const isUnorderedCollection = (context: Context, node: AnyNode): boolean => {
	const value = valueOf(context, node)
	if (value.type === "NewExpression") {
		return isNamed(context, value.callee, ["Map", "Set"])
	}
	return (
		value.type === "CallExpression" &&
		Option.exists(pathOf(context, value.callee), (path) =>
			Option.exists(Arr.head(path), (root) => Arr.contains(HASH_COLLECTIONS, root))
		)
	)
}

/** Iterable contents of an unordered collection: the collection itself, or a projection of it. */
const isUnorderedIterable = (context: Context, node: AnyNode): boolean =>
	isUnorderedCollection(context, node) || isProjection(context, valueOf(context, node))

/**
 * An array or iterator whose order is the collection's iteration order, not a promise: a projection call, a Map's or
 * a Set's iteration methods, `Array.from` of anything but an array-like object literal, and a spread or
 * `Arr.fromIterable` of an unordered collection or of a projection.
 */
const isProjection = (context: Context, node: AnyNode): boolean => {
	if (isCallTo(context, node, PROJECTIONS) || isIteration(node)) {
		return true
	}
	if (node.type === "CallExpression" && isCallTo(context, node, ["Array.from"])) {
		return Option.exists(Arr.head(node.arguments), (source) => source.type !== "ObjectExpression")
	}
	if (node.type === "CallExpression" && isCallTo(context, node, ["Array.fromIterable"])) {
		return Option.exists(Arr.head(node.arguments), (source) => isUnorderedIterable(context, source))
	}
	if (node.type === "ArrayExpression") {
		const [only, ...rest] = node.elements
		return (
			only?.type === "SpreadElement" &&
			Arr.isReadonlyArrayEmpty(rest) &&
			isUnorderedIterable(context, only.argument)
		)
	}
	return false
}

/** A compared value that is, or holds in an object or array literal, a projection of an unordered collection. */
const holdsProjection = (context: Context, node: AnyNode): boolean => {
	if (isProjection(context, node)) {
		return true
	}
	if (node.type === "ObjectExpression") {
		return Arr.some(
			node.properties,
			(property) => property.type === "Property" && holdsProjection(context, property.value)
		)
	}
	return (
		node.type === "ArrayExpression" &&
		Arr.some(
			node.elements,
			(element) =>
				element !== null && element.type !== "SpreadElement" && holdsProjection(context, element)
		)
	)
}

/**
 * An ordered equality that compares the iteration order of a Set, a Map, a hash collection or an object's keys. That
 * order is the collection's, not the contract's: the test fails when an innocuous change reorders it.
 */
export const noOrderedUnordered = refusal(
	"unordered",
	"This compares the iteration order of an unordered collection, which its contract does not promise. Compare it as a multiset with agree(…, multiset(exact)), or as a set with agree(…, set(exact)).",
	(context, refuse) => ({
		CallExpression: (node) => {
			if (
				Option.exists(sidesOf(context, node, ORDERED_EQUALITIES), (sides) =>
					Arr.some(sides, (side) => holdsProjection(context, side))
				)
			) {
				refuse(node)
			}
		}
	})
)
