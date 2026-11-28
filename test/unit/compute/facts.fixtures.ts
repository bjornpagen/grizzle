/** What the properties of facts.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { GuardTest } from "#compiler/core/errors.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { type Fact, factNames } from "#compiler/ir/proof.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { type TestField, testPg } from "#test/support/unit/compute/support.ts"

/** The small literals a comparison draws: zero, the units and a value past them on either side. */
type Small = -5 | -1 | 0 | 1 | 5

const smalls: Arr.NonEmptyReadonlyArray<Small> = [-5, -1, 0, 1, 5]

/** A comparison of the contract's value with literals, a conjunct of its predicate. */
type Atom =
	| { readonly op: "ge" | "gt" | "le" | "lt" | "ne" | "eq"; readonly value: Small }
	| { readonly op: "between"; readonly low: Small; readonly high: Small }

const atomGen: Gen<Atom> = (source) => {
	const op = source.draw(element(["ge", "gt", "le", "lt", "ne", "eq", "between"] as const))
	if (op !== "between") {
		return { op, value: source.draw(element(smalls)) }
	}
	const a = source.draw(element(smalls))
	const b = source.draw(element(smalls))
	return a <= b ? { op, low: a, high: b } : { op, low: b, high: a }
}

/** `fact` where `holds`, else nothing. */
const when = (holds: boolean, fact: Fact): ReadonlyArray<Fact> => (holds ? [fact] : [])

/**
 * What a comparison implies of every value it admits, a numeric typmod's or an integer's: one bounded above admits no
 * NaN, which PostgreSQL orders above every value, and a typmod no infinity, so it is finite; one bounded below at or
 * above zero is nonnegative; one that admits no zero is nonzero.
 */
const atomFacts = (atom: Atom): ReadonlyArray<Fact> => {
	switch (atom.op) {
		case "ge":
			return [...when(atom.value >= 0, "nonnegative"), ...when(atom.value > 0, "nonzero")]
		case "gt":
			return [...when(atom.value >= 0, "nonnegative"), ...when(atom.value >= 0, "nonzero")]
		case "le":
			return ["finite", ...when(atom.value < 0, "nonzero")]
		case "lt":
			return ["finite", ...when(atom.value <= 0, "nonzero")]
		case "ne":
			return when(atom.value === 0, "nonzero")
		case "eq":
			return [
				"finite",
				...when(atom.value >= 0, "nonnegative"),
				...when(atom.value !== 0, "nonzero")
			]
		case "between":
			return [
				"finite",
				...when(atom.low >= 0, "nonnegative"),
				...when(atom.low > 0 || atom.high < 0, "nonzero")
			]
	}
}

/** A base a contract is drawn over, the literal of a small value at it, and whether its type has every value finite. */
interface Base {
	readonly name: "integer" | "bigint" | "numeric"
	readonly field: TestField
	readonly literal: (n: Small) => LiteralDesc
	readonly finite: boolean
}

const bases: Arr.NonEmptyReadonlyArray<Base> = [
	{ name: "integer", field: testPg.integer, literal: (n) => n, finite: true },
	{ name: "bigint", field: testPg.bigint, literal: (n) => BigInt(n), finite: true },
	{ name: "numeric", field: testPg.numericOf(7, 2), literal: (n) => String(n), finite: false }
]

/** The facts a predicate of `atoms` over `base` implies, in the one order. */
export const impliedFacts = (base: Base, atoms: ReadonlyArray<Atom>): ReadonlyArray<Fact> => {
	const implied = new Set<Fact>([...when(base.finite, "finite"), ...Arr.flatMap(atoms, atomFacts)])
	return Arr.filter(factNames, (f) => implied.has(f))
}

/** A comparison as the contract's predicate states it over its value. */
const comparison = (x: ScalarTerm, atom: Atom, base: Base): { readonly expr: OpenExpr } => {
	switch (atom.op) {
		case "between":
			return computeCore.between(x, base.literal(atom.low), base.literal(atom.high))
		case "ge":
		case "gt":
		case "le":
		case "lt":
		case "ne":
		case "eq":
			return computeCore[atom.op](x, base.literal(atom.value))
	}
}

/** The predicate of the conjunction of `atoms`. */
export const predicateOf =
	(atoms: Arr.NonEmptyReadonlyArray<Atom>, base: Base) =>
	(x: ScalarTerm): { readonly expr: OpenExpr } => {
		const [first, ...rest] = atoms
		return Arr.isReadonlyArrayNonEmpty(rest)
			? computeCore.and(Arr.map(atoms, (a) => comparison(x, a, base)))
			: comparison(x, first, base)
	}

/**
 * Where the operation's operand is: a column of the contract, a parameter of it, bound as its base, or a conditional
 * between two readings of the column.
 */
type Form = "column" | "parameter" | "conditional"

/** One case: a contract's base, predicate and declaration, and the fact an operation over a term of it needs. */
interface FactCase {
	readonly base: Base
	readonly atoms: Arr.NonEmptyReadonlyArray<Atom>
	readonly declared: ReadonlyArray<Fact>
	readonly needs: Fact
	readonly form: Form
}

export const caseGen: Gen<FactCase> = (source) => {
	const base = source.draw(element(bases))
	const atoms = nonEmpty(
		source.draw(array(atomGen, { min: 1, max: 3 })),
		"a predicate's comparisons"
	)
	const flags = Arr.map(factNames, () => source.draw(boolean))
	return {
		base,
		atoms,
		declared: Arr.filter(factNames, (_, i) => flags[i] === true),
		needs: source.draw(element(factNames)),
		form: source.draw(element<Form>(["column", "parameter", "conditional"]))
	}
}

/**
 * The partial operation over the contract's term `x` that needs `fact`, and whether its operand is `x` itself: a
 * division, whose divisor an integer's exact division widens and still reads as `x`; over numeric a square root and
 * min_scale; over an integer a square root and min_scale of its numeric conversion, whose operand is the conversion.
 */
export const operation = (
	fact: Fact,
	base: Base,
	x: ScalarTerm
): { readonly term: { readonly expr: OpenExpr }; readonly direct: boolean } => {
	const numeric = base.name === "numeric"
	switch (fact) {
		case "nonzero":
			return { term: computeCore.div(x, x), direct: true }
		case "nonnegative":
			return { term: computeCore.sqrt(numeric ? x : computeCore.numeric(x)), direct: numeric }
		case "finite":
			return { term: computeCore.minScale(numeric ? x : computeCore.numeric(x)), direct: numeric }
	}
}

/** The scalar test that guards each fact. */
export const guardKinds: { readonly [F in Fact]: GuardTest["kind"] } = {
	nonzero: "nonzero",
	nonnegative: "nonnegative",
	finite: "isFinite"
}

export type Feature =
	| `over ${Base["name"]}`
	| `over a ${Form}`
	| `${Fact} admitted by its declaration`
	| "a declared fact a conditional drops"
	| "finite by its type"
	| `${Fact} refused, its declaration named`
	| `${Fact} refused, its guard named`
	| "a declaration its predicate implies, compiled"
	| "a declaration its predicate does not imply, refused"

export const situations: Arr.NonEmptyReadonlyArray<Feature> = [
	"over integer",
	"over bigint",
	"over numeric",
	"over a column",
	"over a parameter",
	"over a conditional",
	"a declared fact a conditional drops",
	...Arr.flatMap(factNames, (f): ReadonlyArray<Feature> => [
		`${f} admitted by its declaration`,
		`${f} refused, its declaration named`,
		`${f} refused, its guard named`
	]),
	"finite by its type",
	"a declaration its predicate implies, compiled",
	"a declaration its predicate does not imply, refused"
]
