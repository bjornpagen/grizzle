/**
 * A contract's facts are exactly the ones its `proves` declares, over drawn contracts: a base (an integer, a bigint or
 * a numeric typmod), a predicate that is a conjunction of comparisons of its value with small literals, and a
 * declaration among the facts.
 *
 * The oracle for what a predicate implies is a host table of each comparison's facts over every value it admits
 * (atomFacts), independent of the bound domain: a conjunction implies what any of its comparisons does, and an integer
 * is finite by its type. A declaration compiles exactly when the predicate implies every fact it names, and is refused
 * at its `proves` otherwise. A partial operation over a term of a contract that compiles, a column or a parameter, is
 * admitted exactly when the contract declares the fact it needs or its base has it, and refused naming that fact
 * otherwise: by the declaration to add (GuardTest proves) where the predicate implies the fact and the operation reads
 * the contract's own term, an exact widening of it included, else by the Compute guard of the fact. A conditional of
 * the contract's terms is an operation's result, as its TypeScript type states: it has its SQL type's facts alone (an
 * integer is finite), whatever its branches declare, and no declaration remedies its refusal.
 *
 * Features: each base, each operand form, a declared fact a conditional drops, each fact admitted by its declaration,
 * refused naming its declaration, and refused naming its guard, finite by its type, and a declaration compiled and one
 * refused.
 *
 * Plants: compute-facts-declaration-unchecked (a declaration its predicate does not imply compiles).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { GuardTest } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { type Fact, factNames } from "#compiler/ir/proof.ts"
import { computeCore as Compute, scalarTerm } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { contractPredicateTable } from "#compiler/scalar/compute/total.ts"
import { bareEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { argumentsOf } from "#test/support/list.ts"
import { referencePatterns } from "#test/support/oracle/reference/evaluate.ts"
import {
	baseParams,
	type LeafBinding,
	lowerWith,
	param,
	spelledExpr,
	type TestField,
	testDeclaringContract,
	testPg,
	v
} from "#test/unit/compute/support.ts"

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
const impliedFacts = (base: Base, atoms: ReadonlyArray<Atom>): ReadonlyArray<Fact> => {
	const implied = new Set<Fact>([...when(base.finite, "finite"), ...Arr.flatMap(atoms, atomFacts)])
	return Arr.filter(factNames, (f) => implied.has(f))
}

/** A comparison as the contract's predicate states it over its value. */
const comparison = (x: ScalarTerm, atom: Atom, base: Base): { readonly expr: OpenExpr } => {
	switch (atom.op) {
		case "between":
			return x.between(base.literal(atom.low), base.literal(atom.high))
		case "ge":
		case "gt":
		case "le":
		case "lt":
		case "ne":
		case "eq":
			return x[atom.op](base.literal(atom.value))
	}
}

/** The predicate of the conjunction of `atoms`. */
const predicateOf =
	(atoms: Arr.NonEmptyReadonlyArray<Atom>, base: Base) =>
	(x: ScalarTerm): { readonly expr: OpenExpr } => {
		const [first, ...rest] = atoms
		return Arr.isReadonlyArrayNonEmpty(rest)
			? Compute.and(...argumentsOf(Arr.map(atoms, (a) => comparison(x, a, base))))
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

const caseGen: Gen<FactCase> = (source) => {
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
const operation = (
	fact: Fact,
	base: Base,
	x: ScalarTerm
): { readonly term: { readonly expr: OpenExpr }; readonly direct: boolean } => {
	const numeric = base.name === "numeric"
	switch (fact) {
		case "nonzero":
			return { term: Compute.div(x, x), direct: true }
		case "nonnegative":
			return { term: Compute.sqrt(numeric ? x : Compute.numeric(x)), direct: numeric }
		case "finite":
			return { term: Compute.minScale(numeric ? x : Compute.numeric(x)), direct: numeric }
	}
}

/** The Compute test that guards each fact. */
const guardKinds: { readonly [F in Fact]: GuardTest["kind"] } = {
	nonzero: "nonzero",
	nonnegative: "nonnegative",
	finite: "isFinite"
}

type Feature =
	| `over ${Base["name"]}`
	| `over a ${Form}`
	| `${Fact} admitted by its declaration`
	| "a declared fact a conditional drops"
	| "finite by its type"
	| `${Fact} refused, its declaration named`
	| `${Fact} refused, its guard named`
	| "a declaration its predicate implies, compiled"
	| "a declaration its predicate does not imply, refused"

const situations: Arr.NonEmptyReadonlyArray<Feature> = [
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

describe("a contract's facts", () => {
	it.effect(
		"are exactly the facts its proves declares, each of which its predicate implies",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "a host table of each comparison's facts over every value it admits (atomFacts)"
						},
						suite: "unit/compute/contract-facts",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Feature>(situations, { cases: 600, sense: notesOnly }),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ base, atoms, declared, needs, form }, c) =>
						Effect.sync(() => {
							c.note(`over ${base.name}`)
							const name = `Facts_${base.name}`
							const implied = impliedFacts(base, atoms)
							const predicate = predicateOf(atoms, base)
							const table = contractPredicateTable(
								spelledExpr(
									predicate(scalarTerm({ kind: "value" }, base.field.scalar, base.field)).expr
								),
								base.field.scalar,
								name,
								declared,
								{
									loc: SourceLoc(`contract ${name}`, []),
									fieldType: (desc, at) => scalarTypeOf(desc, bareEnv, at),
									patterns: referencePatterns(),
									patternLanguage: textLookup
								}
							)
							const sound = Arr.every(declared, (f) => implied.includes(f))
							if (!sound) {
								c.note("a declaration its predicate does not imply, refused")
								if (table.ok) {
									return assert.fail(
										`contract ${name} declares ${Arr.join(declared, ", ")}, its predicate implies only ${Arr.join(implied, ", ")}`
									)
								}
								const refusal = table.error.reason
								if (refusal._tag !== "MalformedDescription") {
									return assert.fail(`a MalformedDescription at proves, not ${refusal._tag}`)
								}
								assert.deepEqual(refusal.at.path, ["proves"])
								return
							}
							assert.ok(
								table.ok,
								`contract ${name}'s declaration of facts its predicate implies compiles`
							)
							c.note("a declaration its predicate implies, compiled")
							c.note(`over a ${form}`)
							const contract = testDeclaringContract(name, base.field, predicate, declared)
							const column = v("x", contract)
							const x =
								form === "column"
									? column
									: form === "parameter"
										? param("x", contract)
										: Compute.cond(Compute.eq(column, column), column, column)
							const vars: Readonly<Record<string, LeafBinding>> = {
								x: { kind: "column", type: contract.scalar }
							}
							const op = operation(needs, base, x)
							const lowered = lowerWith("query", spelledExpr(op.term.expr), vars, false, baseParams)
							const byType = base.finite && needs === "finite"
							const declares = declared.includes(needs)
							if (byType || (declares && form !== "conditional")) {
								c.note(byType ? "finite by its type" : `${needs} admitted by its declaration`)
								assert.ok(lowered.ok, `${needs} over contract ${name}, which has it, is admitted`)
								return
							}
							if (lowered.ok) {
								return assert.fail(
									`${needs} over a ${form} of contract ${name}, which declares ${Arr.join(declared, ", ")}, is refused`
								)
							}
							if (declares) {
								c.note("a declared fact a conditional drops")
							}
							const reason = lowered.error.reason
							if (reason._tag !== "PartialOperation") {
								return assert.fail(`a PartialOperation for ${needs}, not ${reason._tag}`)
							}
							assert.equal(reason.precondition, needs)
							if (form !== "conditional" && op.direct && implied.includes(needs)) {
								c.note(`${needs} refused, its declaration named`)
								assert.deepEqual(reason.guard.remedy, { kind: "proves", contract: name })
								return
							}
							c.note(`${needs} refused, its guard named`)
							assert.equal(reason.guard.remedy.kind, guardKinds[needs])
						})
				)
			)
	)
})
