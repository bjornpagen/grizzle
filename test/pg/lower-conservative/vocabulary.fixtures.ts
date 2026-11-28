/** What the properties of vocabulary.test.ts read: its spaces, models and helpers. */

import { Array as Arr, Option, String as Str } from "effect"
import { ExprId } from "#compiler/core/ids.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { NativeOp } from "#compiler/scalar/compute/registry.ts"
import { T } from "#test/support/unit/lower/conservative/fixtures.ts"

/** The namespaces of the exact carriers' own overloads, whose OpIds prefix the numeric signature that implements them. */
const exactNamespaces = ["exact:", "exactMoney:"] as const

/** The regprocedure signature an entry's OpId lists: the id itself, or, for an exact carrier's overload, the one it prefixes. */
export const listedSignature = (id: NativeOp["id"]): string => {
	const text = typeof id === "string" ? id : id.code
	return Option.match(
		Arr.findFirst(exactNamespaces, (n) => Str.startsWith(n)(text)),
		{ onNone: () => text, onSome: (n) => Str.slice(n.length)(text) }
	)
}

/**
 * The op node of `native` that defaultOps lowers: it reads the overload; the rest makes a well-formed scalar
 * expression, a partial overload's proof among it, which no lowering of the form reads.
 */
export const opExpr = (native: NativeOp): ScalarExpr & { readonly kind: "op" } => {
	const common = {
		kind: "op",
		id: ExprId("e1"),
		args: [],
		type: T.bool,
		nonNull: "strict",
		volatility: "immutable",
		deps: { params: [], nodes: [] },
		pgType: T.bool
	} as const
	return native.partial
		? {
				...common,
				op: native.id,
				proof: [
					{
						precondition: { kind: "nonzero", operand: 1 },
						premises: [{ kind: "checked", operand: 1, by: "literal" }]
					}
				]
			}
		: { ...common, op: native.id }
}

/** What an operator form reached: a binary operator or the unary negation. */
export type FormFeature = "binary" | "negation"

/** What a registry entry reached: a function the default vocabulary lowers to a call, or none it lowers so. */
export type LoweredFeature = "lowered to its function" | "not lowered by name"
