import { Array as Arr } from "effect"
import type { AnyNode, CreateRule, NodeOf } from "#oxlint/rule.ts"

const PRIMITIVE_KEYWORDS: ReadonlyArray<AnyNode["type"]> = [
	"TSAnyKeyword",
	"TSBigIntKeyword",
	"TSBooleanKeyword",
	"TSNeverKeyword",
	"TSNumberKeyword",
	"TSObjectKeyword",
	"TSStringKeyword",
	"TSSymbolKeyword",
	"TSUndefinedKeyword",
	"TSUnknownKeyword",
	"TSVoidKeyword"
]

const unparenthesized = (node: AnyNode): AnyNode =>
	node.type === "TSParenthesizedType" ? unparenthesized(node.typeAnnotation) : node

const isBareTypeReference = (node: AnyNode): boolean => {
	if (node.type !== "TSTypeReference") {
		return false
	}
	return node.typeArguments === null || !Arr.isReadonlyArrayNonEmpty(node.typeArguments.params)
}

const isPointlessAliasOf = (aliased: AnyNode): boolean => {
	if (Arr.contains(PRIMITIVE_KEYWORDS, aliased.type) || aliased.type === "TSLiteralType") {
		return true
	}
	return isBareTypeReference(aliased)
}

const isInsideNamespace = (node: AnyNode): boolean => {
	let current: AnyNode | null = node.parent
	while (current !== null) {
		if (current.type === "TSModuleDeclaration") {
			return true
		}
		current = current.parent
	}
	return false
}

/** Whether an alias declares type parameters: `type Expect<T extends true> = T` constrains what it names, which is
 * structure an alias of a bare type lacks. */
const isGeneric = (node: NodeOf<"TSTypeAliasDeclaration">): boolean =>
	node.typeParameters !== null && Arr.isReadonlyArrayNonEmpty(node.typeParameters.params)

/** An alias of a primitive, a literal or a bare type adds a name without adding structure; a generic alias adds its
 * parameters. */
export const noPointlessTypeAlias: CreateRule = {
	meta: { type: "suggestion" },
	create: (context) => ({
		TSTypeAliasDeclaration: (node) => {
			if (
				!isInsideNamespace(node) &&
				!isGeneric(node) &&
				isPointlessAliasOf(unparenthesized(node.typeAnnotation))
			) {
				context.report({
					node: node.id,
					message:
						"Pointless type alias. Direct aliases to primitives, literals, or bare types are banned. Use the underlying type directly or define real structure/composition."
				})
			}
		}
	})
}
