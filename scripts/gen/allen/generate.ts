import { Array as Arr, Order } from "effect"
import {
	type AllenConjunction,
	type AllenFormula,
	allenAtomCount,
	atomIndexable,
	atomLiterals,
	conjunctionHolds,
	literalAtom,
	literalNegated
} from "#compiler/allen/atoms.ts"
import { fullAllenMask } from "#compiler/allen/mask.ts"
import { defect } from "#compiler/core/invariant.ts"

/** A conjunction of literals and the set of basic relations it holds for. */
interface Term {
	readonly holds: number
	readonly conjunction: AllenConjunction
}

/** Lexicographic order of literal code lists; a proper prefix sorts first. */
const codeOrder: Order.Order<AllenConjunction> = Arr.makeOrder(Order.Number)

/** Cost order of two conjunctions: fewer literals first, then code order. */
const costOrder: Order.Order<AllenConjunction> = Order.combine(
	Order.mapInput(Order.Number, (conjunction: AllenConjunction) => conjunction.length),
	codeOrder
)

const termCodeOrder: Order.Order<Term> = Order.mapInput(codeOrder, (term: Term) => term.conjunction)

/**
 * The conjunction an assignment spells, read as eleven base-3 digits, one per atom: 0 leaves the atom out, 1 takes it,
 * 2 takes its negation. Its literals come in ascending code order.
 */
const assignmentConjunction = (assignment: number): AllenConjunction =>
	Arr.flatMap(atomLiterals, ([positive, negated], atom) => {
		const state = Math.floor(assignment / 3 ** atom) % 3
		return state === 0 ? [] : [state === 2 ? negated : positive]
	})

/** Whether a conjunction has an unnegated atom a GiST index on the left span can serve. */
const indexable = (conjunction: AllenConjunction): boolean =>
	Arr.some(
		conjunction,
		(literal) => !literalNegated(literal) && atomIndexable(literalAtom(literal))
	)

/**
 * The cheapest conjunction with an indexable atom for every nonempty set of relations some conjunction denotes, in
 * code order.
 */
const enumerateTerms = (): ReadonlyArray<Term> => {
	const best = new Map<number, AllenConjunction>()
	for (let assignment = 0; assignment < 3 ** allenAtomCount; assignment++) {
		const conjunction = assignmentConjunction(assignment)
		if (!indexable(conjunction)) {
			continue
		}
		const holds = conjunctionHolds(conjunction)
		const current = best.get(holds)
		if (holds !== 0 && (current === undefined || costOrder(conjunction, current) < 0)) {
			best.set(holds, conjunction)
		}
	}
	return Arr.sort(
		Arr.map(Arr.fromIterable(best), ([holds, conjunction]) => ({ holds, conjunction })),
		termCodeOrder
	)
}

/**
 * The lexicographically least minimal formula for `mask` over `terms`. Only sets inside the mask can be disjuncts, and
 * a set with a cheaper (or equally cheap and code-smaller) superset is never the better disjunct, so it is dropped.
 * The minimal cost of covering the uncovered relations, ignoring order, is memoized per mask; the search then returns
 * the first cover in code order within that minimum, which is the least sorted list of disjuncts.
 */
const minimize = (mask: number, terms: ReadonlyArray<Term>): AllenFormula => {
	const inside = Arr.filter(terms, (term) => (term.holds & ~mask) === 0)
	const candidates = Arr.filter(
		inside,
		(term) =>
			!Arr.some(
				inside,
				(other) =>
					other !== term &&
					(term.holds & ~other.holds) === 0 &&
					costOrder(other.conjunction, term.conjunction) < 0
			)
	)
	const memo = new Map<number, number>()
	const cost = (remaining: number): number => {
		if (remaining === 0) {
			return 0
		}
		const memoized = memo.get(remaining)
		if (memoized !== undefined) {
			return memoized
		}
		const low = remaining & -remaining
		const least = Arr.reduce(candidates, Number.MAX_SAFE_INTEGER, (min, term) =>
			(term.holds & low) === 0
				? min
				: Math.min(min, term.conjunction.length + cost(remaining & ~term.holds))
		)
		memo.set(remaining, least)
		return least
	}
	const search = (
		remaining: number,
		start: number,
		left: number
	): ReadonlyArray<AllenConjunction> | undefined => {
		if (remaining === 0) {
			return left === 0 ? [] : undefined
		}
		for (const [index, term] of candidates.entries()) {
			const next = remaining & ~term.holds
			const spent = term.conjunction.length
			if (index < start || next === remaining || spent + cost(next) > left) {
				continue
			}
			const rest = search(next, index + 1, left - spent)
			if (rest !== undefined) {
				return [term.conjunction, ...rest]
			}
		}
		return undefined
	}
	const formula = search(mask, 0, cost(mask))
	if (formula === undefined) {
		throw defect(`a formula for the Allen mask ${mask}`)
	}
	return formula
}

/**
 * The offline Allen mask minimization: entry m is the minimal formula of mask m, in disjunctive normal form over the
 * eleven atoms of packages/engine/src/allen/atoms.ts (the nine range operators in both operand orders), under a fixed cost:
 *
 * 1. every disjunct contains an unnegated atom a GiST index on the left span can serve;
 * 2. then the fewest atom occurrences;
 * 3. then the fixed atom order: among formulas of equal cost, the one whose sorted list of disjuncts is
 *    lexicographically least, a disjunct being its ascending list of literal codes (atom * 2 + negated), so the earlier
 *    atom, and an atom's positive literal before its negation, wins.
 *
 * The search is exact. Every conjunction of literals is enumerated (3^11 of them), and for each set of basic relations
 * the cheapest conjunction with an indexable atom is kept, ties broken by code order; a formula never needs any other
 * spelling of a set, because swapping a disjunct for a cheaper or code-smaller spelling of the same set lowers the cost
 * or the sorted list. For each mask, the minimal cover of the mask by those sets is found by dynamic programming over
 * the uncovered relations, and a depth-first walk in code order, bounded by that minimum, returns the
 * lexicographically least minimal cover.
 *
 * Every nonempty mask has such a formula, because it is a union of basic relations and each basic relation has a
 * formula with an indexable atom. The empty mask has none and is refused at compilation; its entry is empty. The full
 * mask emits no predicate, but its entry still holds its minimal formula, so every entry is verified uniformly.
 */
export const generateAllenTable = (): ReadonlyArray<AllenFormula> => {
	const terms = enumerateTerms()
	return [[], ...Arr.map(Arr.range(1, fullAllenMask), (mask) => minimize(mask, terms))]
}

const renderConjunction = (conjunction: AllenConjunction): string =>
	`[${Arr.join(
		Arr.map(conjunction, (code) => `${code}`),
		", "
	)}]`

const renderFormula = (formula: AllenFormula): string =>
	`[${Arr.join(Arr.map(formula, renderConjunction), ", ")}]`

const tableHeader: ReadonlyArray<string> = [
	'import type { AllenFormula } from "#compiler/allen/atoms.ts"',
	"",
	"/**",
	" * The Allen mask table, written whole by `node scripts/gen/allen/main.ts` and never edited by hand. Entry m is the",
	" * minimal formula of mask m: a list of disjuncts, each a list of literal codes `atom * 2 + negated` over the atoms of",
	" * atoms.ts in their fixed order. Entry 0, the empty mask, is empty and is never lowered; entry 0x1fff, the full mask,",
	" * holds its formula but lowers to no predicate.",
	" */",
	"// oxfmt-ignore",
	"export const allenTable: ReadonlyArray<AllenFormula> = ["
]

/**
 * The text of packages/engine/src/allen/table.generated.ts, one formula per line in mask order, which the formatter leaves
 * as written. The allen unit test regenerates it and compares it with the committed file byte for byte.
 */
export const allenTableSource = (): string => {
	const table = generateAllenTable()
	const entries = Arr.map(
		table,
		(formula, mask) => `\t${renderFormula(formula)}${mask === table.length - 1 ? "" : ","}`
	)
	return Arr.join([...tableHeader, ...entries, "] as const", ""], "\n")
}
