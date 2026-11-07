import { Array as Arr, String as Str } from "effect"
import * as ts from "typescript/ast"
import { type Checker, type Type, TypeFlags } from "typescript/sync"
import { isDefaultLibraryPath } from "#lint/paths.ts"
import type { Visit } from "#lint/types.ts"
import type { Report } from "#shared/finding.ts"

/** The builtin collections that key by reference: their first type argument is the key, or the element. */
const IDENTITY_KEYED: ReadonlyArray<string> = ["Map", "Set", "WeakMap", "WeakSet"]

const NULLISH = TypeFlags.Null | TypeFlags.Undefined

const isEquality = (kind: ts.SyntaxKind): boolean =>
	kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
	kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
	kind === ts.SyntaxKind.EqualsEqualsToken ||
	kind === ts.SyntaxKind.ExclamationEqualsToken

/** The flags of a value a list of values holds: a text, a number, a bigint, a boolean, an enum member, or a literal or
 * template of one. */
const VALUE =
	TypeFlags.StringLike |
	TypeFlags.NumberLike |
	TypeFlags.BigIntLike |
	TypeFlags.BooleanLike |
	TypeFlags.EnumLike

/** The members of a type: a union's, or the type alone. */
const membersOf = (type: Type): ReadonlyArray<Type> =>
	type.isUnionType() ? type.getTypes() : [type]

/** The element types of a list: an array's one type argument, a tuple's elements; none for any other type. */
const elementsOf = (checker: Checker, type: Type): ReadonlyArray<Type> | undefined =>
	(type.isTupleType() || checker.isArrayType(type)) && type.isTypeReference()
		? checker.getTypeArguments(type)
		: undefined

/**
 * Whether a type is a list of values: an array or a tuple, a readonly one included, whose elements are values (texts,
 * numbers, bigints, booleans, enum members, a brand of one) or lists of values, or a branded such list, or a union of
 * them beside null and undefined. Two lists of values are equal exactly when their elements are, so their references
 * mean nothing; a list of objects is compared by reference on purpose, to see whether a rewrite shared it.
 */
const isValueList = (checker: Checker, type: Type): boolean => {
	if (type.isUnionType()) {
		const members = Arr.filter(type.getTypes(), (member) => (member.flags & NULLISH) === 0)
		return (
			Arr.isReadonlyArrayNonEmpty(members) &&
			Arr.every(members, (member) => isValueList(checker, member))
		)
	}
	if (type.isIntersectionType()) {
		return Arr.some(type.getTypes(), (member) => isValueList(checker, member))
	}
	const elements = elementsOf(checker, type)
	return (
		elements !== undefined &&
		Arr.isReadonlyArrayNonEmpty(elements) &&
		Arr.every(elements, (element) => isValue(checker, element))
	)
}

/** Whether a type is a list of any elements, a brand of one, or a union of lists beside null and undefined. */
const isList = (checker: Checker, type: Type): boolean => {
	if (type.isUnionType()) {
		const members = Arr.filter(type.getTypes(), (member) => (member.flags & NULLISH) === 0)
		return (
			Arr.isReadonlyArrayNonEmpty(members) &&
			Arr.every(members, (member) => isList(checker, member))
		)
	}
	if (type.isIntersectionType()) {
		return Arr.some(type.getTypes(), (member) => isList(checker, member))
	}
	return elementsOf(checker, type) !== undefined
}

/** Whether a type is a value, a brand of one, or a list of values: every member of a union is. */
const isValue = (checker: Checker, type: Type): boolean =>
	Arr.every(
		membersOf(type),
		(member) =>
			(member.flags & VALUE) !== 0 ||
			(member.isIntersectionType() &&
				Arr.some(member.getTypes(), (part) => (part.flags & VALUE) !== 0)) ||
			isValueList(checker, member)
	)

/**
 * Whether an identity comparison only shortcuts a comparison of the same two lists' elements: the left side of an
 * `||` whose right side reads both, as `a === b || (a.length === b.length && …)` does. Equal references are equal
 * lists, so the shortcut is sound, and the right side decides every other pair.
 */
const isShortcut = (comparison: ts.BinaryExpression): boolean => {
	const { parent } = comparison
	if (
		comparison.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
		!ts.isBinaryExpression(parent) ||
		parent.operatorToken.kind !== ts.SyntaxKind.BarBarToken ||
		parent.left !== comparison
	) {
		return false
	}
	const sourceFile = comparison.getSourceFile()
	const read = parent.right.getText(sourceFile)
	return (
		Str.includes(comparison.left.getText(sourceFile))(read) &&
		Str.includes(comparison.right.getText(sourceFile))(read)
	)
}

/** The key type of a builtin identity-keyed collection: a Map's or WeakMap's first type argument, a Set's element. */
const identityKeyOf = (checker: Checker, type: Type): Type | undefined => {
	const symbol = type.getSymbol()
	if (
		symbol === undefined ||
		!Arr.contains(IDENTITY_KEYED, symbol.name) ||
		!Arr.every(symbol.declarations, (declaration) => isDefaultLibraryPath(declaration.path)) ||
		!type.isTypeReference()
	) {
		return undefined
	}
	const [key] = checker.getTypeArguments(type)
	return key
}

const SUGGESTION =
	"Key the collection with TupleMap or TupleSet (packages/engine/src/core/tuple-map.ts), which compare a key by its elements, or compare the lists element by element."

/**
 * tuple-identity: a list of values is a value, so two are never compared by reference. `===` and `!==` (and `==`,
 * `!=`) between two lists of values (arrays or tuples of texts, numbers, bigints, booleans, enum members, their brands,
 * or lists of those: an identity tuple) compare references, so two lists of the same elements are unequal and the
 * comparison silently never matches a list built elsewhere. A builtin Map, Set, WeakMap or WeakSet keyed by any list
 * keys by reference: a lookup with an equal list finds nothing, and a cache keyed by one array object is a hidden memo,
 * which the repository forbids anyway. Both compile, which is why the rule
 * exists. A construction is read at its own type and at the type its context gives it, which an empty `new Map()`
 * takes its key from. What passes: a list compared with null or undefined; `a === b || …` where the right side
 * compares the same two lists' elements (equal references are equal lists); two lists of objects, compared by
 * reference on purpose (a rewrite that returns the list it was given when nothing changed); and TupleMap and TupleSet,
 * which key a list by its elements.
 */
export const tupleIdentity: Visit = ({ checker, semantics }) => {
	const listAt = (node: ts.Node): boolean => {
		const type = semantics.typeAt(node)
		return type !== undefined && isValueList(checker, type)
	}
	return (node): ReadonlyArray<Report> => {
		if (
			ts.isBinaryExpression(node) &&
			isEquality(node.operatorToken.kind) &&
			!isShortcut(node) &&
			listAt(node.left) &&
			listAt(node.right)
		) {
			return [
				{
					node,
					message:
						"Both sides of this equality are lists, so it compares their references: two lists of the same elements are unequal, and it never matches a list built elsewhere.",
					suggestion: SUGGESTION
				}
			]
		}
		if (!ts.isNewExpression(node)) {
			return []
		}
		const keyedByList = Arr.some(
			[semantics.typeAt(node), checker.getContextualType(node)],
			(type) => {
				const key = type === undefined ? undefined : identityKeyOf(checker, type)
				return key !== undefined && isList(checker, key)
			}
		)
		return keyedByList
			? [
					{
						node,
						message:
							"This builtin collection is keyed by a list, which it compares by reference: a lookup with an equal list built elsewhere finds nothing.",
						suggestion: SUGGESTION
					}
				]
			: []
	}
}
