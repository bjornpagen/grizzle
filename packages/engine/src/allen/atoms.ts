import { endpointMask } from "#compiler/allen/endpoints.ts"
import { AllenMask, converseMask, intersectMasks, uniteMasks } from "#compiler/allen/mask.ts"

/**
 * The nine range operators by their pg_operator.oprcode. A range operator's identity in the IR is its code with the
 * range carrier (`range_overlaps:int4range`), as the registry names the polymorphic range comparisons.
 */
export const rangeOperatorCodes = {
	"&&": "range_overlaps",
	"@>": "range_contains",
	"<@": "range_contained_by",
	"<<": "range_before",
	">>": "range_after",
	"&<": "range_overleft",
	"&>": "range_overright",
	"-|-": "range_adjacent",
	"=": "range_eq"
} as const
export type RangeOperator = keyof typeof rangeOperatorCodes

interface AllenAtom {
	/** The atom as a formula spells it, with A the left span and B the right. */
	readonly text: string
	readonly op: RangeOperator
	/** The span the operator reads first: A, or B for B &< A and B &> A. */
	readonly first: "A" | "B"
	/** The basic relations for which the atom holds. */
	readonly holds: AllenMask
}

const aFirst = (op: RangeOperator, holds: AllenMask): AllenAtom => ({
	text: `A ${op} B`,
	op,
	first: "A",
	holds
})

/** B op A holds for (A, B) exactly when A op B holds for (B, A): the converse of A op B's set. */
const bFirst = (op: RangeOperator, aFirstHolds: AllenMask): AllenAtom => ({
	text: `B ${op} A`,
	op,
	first: "B",
	holds: converseMask(aFirstHolds)
})

/** The operands of an atom in the operator's order, given the spans A and B. */
export const atomOperands = <T>(atom: AllenAtom, a: T, b: T): readonly [T, T] =>
	atom.first === "A" ? [a, b] : [b, a]

/**
 * Whether a GiST range_ops index on A can serve the atom unnegated: exactly when A is the operator's first operand,
 * every A-first spelling being a range_ops strategy with A as its indexed operand.
 */
export const atomIndexable = (atom: AllenAtom): boolean => atom.first === "A"

/**
 * The relations each operator holds for with A first: its definition over the endpoints of two nonempty half-open
 * ranges, as rangetypes.c states it for a canonical discrete range, read through the endpoint masks (endpoints.ts),
 * so every atom's set is derived from the relations' one definition.
 */
const operatorHolds: { readonly [O in RangeOperator]: AllenMask } = {
	"&&": intersectMasks(endpointMask("lower", "lt", "upper"), endpointMask("upper", "gt", "lower")),
	"@>": intersectMasks(endpointMask("lower", "le", "lower"), endpointMask("upper", "ge", "upper")),
	"<@": intersectMasks(endpointMask("lower", "ge", "lower"), endpointMask("upper", "le", "upper")),
	"<<": endpointMask("upper", "le", "lower"),
	">>": endpointMask("lower", "ge", "upper"),
	"&<": endpointMask("upper", "le", "upper"),
	"&>": endpointMask("lower", "ge", "lower"),
	"-|-": uniteMasks(endpointMask("upper", "eq", "lower"), endpointMask("lower", "eq", "upper")),
	"=": intersectMasks(endpointMask("lower", "eq", "lower"), endpointMask("upper", "eq", "upper"))
}

/**
 * The range-operator atoms an Allen mask compiles to, in the fixed atom order.
 *
 * Every mask compiles to a Boolean formula over PostgreSQL's range operators alone, each of which the GiST range_ops
 * operator class serves; lower() and upper() are never needed. The nine operators are `&&`, `@>`, `<@`, `<<`, `>>`,
 * `&<`, `&>`, `-|-` and `=`, and the search runs over them in both operand orders. Swapping the operands of an atom maps
 * each relation in its set to its converse, so the eighteen spellings denote eleven distinct sets:
 *
 * - `&&`, `-|-` and `=` are symmetric: B && A is A && B, and likewise for the other two;
 * - B @> A is A <@ B and B <@ A is A @> B; B << A is A >> B and B >> A is A << B (PostgreSQL records each pair as
 *   commutators, pg_operator.oprcom);
 * - B &< A (b1 <= a1) and B &> A (b0 >= a0) are new sets. `&<` and `&>` have no commutator in PostgreSQL 19
 *   (oprcom = 0), so these two spellings exist only with B on the left.
 *
 * The eleven atoms are those sets, each under one spelling: the nine A-first spellings in the operator order above,
 * then B &< A and B &> A. That index order is the fixed atom order the table generator breaks ties with.
 *
 * Indexability: `r.allen(left, mask, right)` puts the span term on the left, and a GiST index on that span drives the
 * scan. Every A-first atom is a range_ops strategy with A as its indexed operand, so an index on A can serve it. B &< A
 * and B &> A have the index column on the right and no commutator to turn them around, so no index on A can serve
 * them: they appear in formulas as rechecked conditions but never count as a disjunct's indexable atom. Every disjunct
 * of the table carries an unnegated indexable atom.
 */
const atomOrder = [
	aFirst("&&", operatorHolds["&&"]),
	aFirst("@>", operatorHolds["@>"]),
	aFirst("<@", operatorHolds["<@"]),
	aFirst("<<", operatorHolds["<<"]),
	aFirst(">>", operatorHolds[">>"]),
	aFirst("&<", operatorHolds["&<"]),
	aFirst("&>", operatorHolds["&>"]),
	aFirst("-|-", operatorHolds["-|-"]),
	aFirst("=", operatorHolds["="]),
	bFirst("&<", operatorHolds["&<"]),
	bFirst("&>", operatorHolds["&>"])
] as const

export const allenAtoms: ReadonlyArray<AllenAtom> = atomOrder

/**
 * The range operator an IR node names by its implementing function, with the relations it holds for with its first
 * operand as A: what reads an atom of a formula back as a mask (check/allen.ts).
 */
export const rangeOperatorMasks: ReadonlyMap<string, AllenMask> = new Map(
	allenAtoms
		.filter((atom) => atom.first === "A")
		.map((atom) => [rangeOperatorCodes[atom.op], atom.holds])
)

export const allenAtomCount = 11

/** A literal: the code `atom * 2 + negated` of an atom in the fixed atom order, or of its negation. */
export type AllenLiteral =
	| 0
	| 1
	| 2
	| 3
	| 4
	| 5
	| 6
	| 7
	| 8
	| 9
	| 10
	| 11
	| 12
	| 13
	| 14
	| 15
	| 16
	| 17
	| 18
	| 19
	| 20
	| 21

/** Each atom's literals in the fixed atom order: the atom, then its negation. */
export const atomLiterals: ReadonlyArray<readonly [AllenLiteral, AllenLiteral]> = [
	[0, 1],
	[2, 3],
	[4, 5],
	[6, 7],
	[8, 9],
	[10, 11],
	[12, 13],
	[14, 15],
	[16, 17],
	[18, 19],
	[20, 21]
]

/** The atom of each literal (atomLiterals). */
const literalAtoms: { readonly [L in AllenLiteral]: AllenAtom } = {
	0: atomOrder[0],
	1: atomOrder[0],
	2: atomOrder[1],
	3: atomOrder[1],
	4: atomOrder[2],
	5: atomOrder[2],
	6: atomOrder[3],
	7: atomOrder[3],
	8: atomOrder[4],
	9: atomOrder[4],
	10: atomOrder[5],
	11: atomOrder[5],
	12: atomOrder[6],
	13: atomOrder[6],
	14: atomOrder[7],
	15: atomOrder[7],
	16: atomOrder[8],
	17: atomOrder[8],
	18: atomOrder[9],
	19: atomOrder[9],
	20: atomOrder[10],
	21: atomOrder[10]
}

/** A conjunction of literals, in ascending code order. Each atom appears at most once. */
export type AllenConjunction = ReadonlyArray<AllenLiteral>
/**
 * A disjunction of conjunctions (disjunctive normal form). The table's formulas list their disjuncts in ascending
 * lexicographic order of their codes.
 */
export type AllenFormula = ReadonlyArray<AllenConjunction>

export const literalAtom = (literal: AllenLiteral): AllenAtom => literalAtoms[literal]
export const literalNegated = (literal: AllenLiteral): boolean => (literal & 1) === 1

/** The relations a literal holds for. */
const literalHolds = (literal: AllenLiteral): AllenMask => {
	const holds = literalAtom(literal).holds
	return AllenMask(literalNegated(literal) ? 0x1fff ^ holds : holds)
}

/** The relations a conjunction holds for. The empty conjunction is true. */
export const conjunctionHolds = (conjunction: AllenConjunction): AllenMask => {
	let mask = 0x1fff
	for (const literal of conjunction) {
		mask &= literalHolds(literal)
	}
	return AllenMask(mask)
}

/** The relations a formula holds for, computed from the atoms' sets. The empty formula is false. */
export const formulaHolds = (formula: AllenFormula): AllenMask => {
	let mask = 0
	for (const conjunction of formula) {
		mask |= conjunctionHolds(conjunction)
	}
	return AllenMask(mask)
}

/** A formula's truth for one pair, given the truth of each atom for that pair as bit `atom` of `atoms`. */
export const evaluateFormula = (formula: AllenFormula, atoms: number): boolean =>
	formula.some((conjunction) =>
		conjunction.every(
			(literal) => ((atoms & (1 << (literal >> 1))) !== 0) !== literalNegated(literal)
		)
	)

/** The number of atom occurrences in a formula: the generator's primary cost. */
export const formulaAtomCount = (formula: AllenFormula): number => {
	let count = 0
	for (const conjunction of formula) {
		count += conjunction.length
	}
	return count
}

/** Whether every disjunct carries an unnegated indexable atom. */
export const everyDisjunctIndexable = (formula: AllenFormula): boolean =>
	formula.every((conjunction) =>
		conjunction.some((literal) => !literalNegated(literal) && atomIndexable(literalAtom(literal)))
	)

/**
 * The formula as text, for diagnostics and tests: `A && B AND NOT A @> B OR ...`. A negated equality is written
 * `A <> B`.
 */
export const formulaText = (formula: AllenFormula): string =>
	formula
		.map((conjunction) =>
			conjunction
				.map((literal) => {
					const atom = literalAtom(literal)
					if (!literalNegated(literal)) {
						return atom.text
					}
					return atom.op === "=" ? atom.text.replace("=", "<>") : `NOT ${atom.text}`
				})
				.join(" AND ")
		)
		.join(" OR ")
