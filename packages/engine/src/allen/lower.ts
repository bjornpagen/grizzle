import {
	type AllenFormula,
	atomOperands,
	literalAtom,
	literalNegated,
	type RangeOperator
} from "#compiler/allen/atoms.ts"
import { type AllenMask, emptyAllenMask, fullAllenMask } from "#compiler/allen/mask.ts"
import { allenTable } from "#compiler/allen/table.generated.ts"
import { defect } from "#compiler/core/invariant.ts"

/**
 * The table's formula for a mask. The empty mask's entry is empty. The table has an entry for every parsed mask, so a
 * miss is a defect. The check stays: the 8192 entries are a generated file's, whose length no type spells and
 * table.test.ts checks.
 */
export const allenFormula = (mask: AllenMask): AllenFormula => {
	const formula = allenTable[mask]
	if (formula === undefined) {
		throw defect(`an Allen table entry for mask ${mask}`)
	}
	return formula
}

/** What a mask is as a predicate: never true, always true, or its table formula. */
export type AllenForm =
	| { readonly kind: "never" }
	| { readonly kind: "always" }
	| { readonly kind: "formula"; readonly formula: AllenFormula }

export const allenForm = (mask: AllenMask): AllenForm =>
	mask === emptyAllenMask
		? { kind: "never" }
		: mask === fullAllenMask
			? { kind: "always" }
			: { kind: "formula", formula: allenFormula(mask) }

/**
 * How one lowering spells a formula over span operands of type T: a literal, the range operator `op` over its two
 * operands in the operator's order, negated or not; and the conjunction and disjunction of two or more parts.
 */
export interface FormulaBuilder<T> {
	readonly literal: (op: RangeOperator, negated: boolean, first: T, second: T) => T
	readonly and: (parts: ReadonlyArray<T>) => T
	readonly or: (parts: ReadonlyArray<T>) => T
}

/** The parts joined, or the one part alone. */
const joined = <T>(parts: ReadonlyArray<T>, join: (parts: ReadonlyArray<T>) => T): T => {
	const [first, ...rest] = parts
	return first !== undefined && rest.length === 0 ? first : join(parts)
}

/**
 * An Allen mask between two span expressions as a predicate, in every lowering that writes one: a table formula over
 * the spans `left` (A) and `right` (B), through one lowering's builder.
 *
 * The formula comes from the shipped table; no formula is derived at compile time. Each literal is one range operator
 * between the two spans, so the predicate uses no lower() or upper() and every disjunct carries an unnegated operator a
 * GiST index on the left span can drive, the negated ones being rechecked on the candidate rows. The mask is never
 * widened to a broader operator and filtered by endpoints.
 *
 * A mask is one of three forms (allenForm): the empty mask holds for no pair, the full mask for every pair, and every
 * other mask is its table formula, folded through a builder deciding only how a literal, a conjunction and a
 * disjunction are spelled: the IR's (allenExpr, which the checker's r.allen and the optimizer's Allen normal form both
 * write), from which every lowering prints the predicate.
 *
 * The two operands are any span-valued expressions: columns, a span parameter bound as the base range type, or a range
 * literal. The caller orders them as `r.allen(left, mask, right)` does.
 *
 * Each literal's operands are in its atom's order, a conjunction of one literal is that literal, a formula of one
 * disjunct is that disjunct. The parts are built in the formula's order, literal by literal.
 */
export const buildFormula = <T>(
	formula: AllenFormula,
	left: T,
	right: T,
	build: FormulaBuilder<T>
): T =>
	joined(
		formula.map((conjunction) =>
			joined(
				conjunction.map((literal) => {
					const atom = literalAtom(literal)
					const [first, second] = atomOperands(atom, left, right)
					return build.literal(atom.op, literalNegated(literal), first, second)
				}),
				build.and
			)
		),
		build.or
	)
