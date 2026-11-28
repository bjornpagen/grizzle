/** What the properties of lower.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import {
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { bigint } from "@bjornpagen/testing/values"
import { Array as Arr, Record as Rec } from "effect"
import { NodeId, ParamId } from "#compiler/core/ids.ts"
import type { CompareOp, ExprDesc } from "#compiler/ir/desc.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { sameScalarType, type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { Lowered } from "#compiler/scalar/compute/lower.ts"
import { commonType, widening } from "#compiler/scalar/compute/types.ts"
import { succeeded } from "#test/support/assert.ts"
import { definedness } from "#test/support/compute.ts"
import { widensTo } from "#test/support/fixtures/ir/scalar.ts"
import {
	buildTerm,
	type CompareSketch,
	compareSketchGen,
	type LowerHooks,
	resolveCompare,
	type TermScope,
	type TermSketch,
	termSketchGen
} from "#test/support/oracle/gen/compute.ts"
import {
	compareParamType,
	resolveValue,
	typedLiteralDesc
} from "#test/support/oracle/gen/domain.ts"
import { operationProofHolds } from "#test/support/oracle/proof.ts"
import {
	baseParams,
	field,
	type LeafBinding,
	lowerWith,
	sink,
	testContract,
	type TestField,
	testPg,
	testSpan
} from "#test/support/unit/compute/support.ts"

const Cents = testContract("Cents", testPg.bigint, (x) => computeCore.ge(x, 0n))

/** A numeric(5,2) contract that admits no negative value. */
const Rate = testContract("Rate", testPg.numericOf(5, 2), (x) => computeCore.ge(x, "0"))

/** A leaf bound to a column, the one binding the column hook reads. */
type ColumnBinding = Extract<LeafBinding, { readonly kind: "column" }>

const col = (f: { readonly scalar: ColumnBinding["type"] }): ColumnBinding => ({
	kind: "column",
	type: f.scalar
})

export const lowered = (expr: ExprDesc, vars: Readonly<Record<string, LeafBinding>>) =>
	succeeded(lowerWith("query", expr, vars, false, baseParams))

/**
 * What a leaf of a description meets: a literal never stands first, and a parameter does, at its declared type; two
 * untyped literal branches of a conditional follow the literal typing rule, a JavaScript number integer and a bigint
 * bigint, and branches of the two are malformed; a numeric literal is a decimal, never a JavaScript fraction.
 */
export type UntypedForm =
	| "literal first"
	| "parameter first"
	| "two untyped branches"
	| "fraction for numeric"

export type UntypedFeature =
	| `form ${Exclude<UntypedForm, "two untyped branches">}`
	| `branches ${UntypedLiteral["kind"]} and ${UntypedLiteral["kind"]}`

type UntypedLiteral =
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "bigint"; readonly value: bigint }

export const fields: Readonly<Record<string, TestField>> = {
	i: testPg.integer,
	b: testPg.bigint,
	n: testPg.numeric,
	n52: testPg.numericOf(5, 2),
	d: testPg.double,
	t: testPg.text,
	code: testPg.regex("^[a-z]+$", "u"),
	f: testPg.boolean,
	cents: Cents,
	rate: Rate
}

export const vars: Readonly<Record<string, LeafBinding>> = Rec.fromEntries(
	Arr.map(Rec.toEntries(fields), ([name, described]) => [name, col(described)])
)

const compareOps: Arr.NonEmptyReadonlyArray<CompareOp> = ["eq", "ne", "lt", "le", "gt", "ge"]

export const opGen = element(compareOps)

/** A literal of each kind the rule types, within a box both integer types hold. */
export const untypedLiteralGen: Gen<UntypedLiteral> = oneOf([
	map(int(-1000, 1000), (value): UntypedLiteral => ({ kind: "number", value })),
	map(bigint(-1000n, 1000n), (value): UntypedLiteral => ({ kind: "bigint", value }))
])

export const numberColumns: Arr.NonEmptyReadonlyArray<string> = ["i", "b", "n", "n52"]

/** A JavaScript fraction: a whole number and a dyadic part of it, never whole, by construction. */
export const fractionGen: Gen<number> = (source) =>
	source.draw(int(-1_000_000, 999_999)) + source.draw(int(1, 2 ** 20 - 1)) / 2 ** 20

export const literalOf = (l: UntypedLiteral): ExprDesc => ({
	kind: "literal",
	value: l.value
})

/**
 * A cast is classified by how it converts, never by a missing operation: a conversion into a contract's domain
 * is checked and can fail, whether or not the domain has a CHECK, since PostgreSQL validates every coercion into a
 * domain (a numeric base's typmod included), and every checked cast can fail (ir/expr.ts exprEffects). The planted cases are
 * conditionals over a contract column whose other branch is the column itself, a parameter of it (cast into its domain
 * where it is emitted), or the column cast into its own contract (the conditional converts it into the domain, the one
 * path a checked schema reaches). The compute generator's terms (test/support/oracle/gen/compute.ts) read the heading's
 * plain columns only, so they guard no conversion into a contract; they are drawn beside the planted cases as the
 * population every other cast comes from.
 */
export type CastFeature =
	| "generated term"
	| `domain cast into ${"a checked" | "an unchecked"} contract`

/**
 * A conditional over a contract column whose other branch is the column, a parameter of it, or the column cast into
 * its own contract, either branch first.
 */
/** A contract column of the heading: Cents, the checked Rate, or the unchecked Tag. */
type ContractColumn = "cents" | "rate" | "tag"

type CastCase =
	| { readonly kind: "generated"; readonly term: TermSketch }
	| {
			readonly kind: "conditional"
			readonly contract: ContractColumn
			readonly other: "column" | "parameter" | "identity cast"
			readonly contractFirst: boolean
	  }

/**
 * Every partial cast of a lowered table stands with a proof of each precondition the kernel re-derives (oracle/proof.ts
 * operationProofHolds); every cast into
 * a contract is a domain cast, whose proof holds too, whether or not the contract has a CHECK.
 */
export const checkCasts = (exprs: ReadonlyArray<ScalarExpr>, c: Case<CastFeature>): void => {
	for (const e of exprs) {
		if (e.kind === "cast" && "proof" in e) {
			const defined = definedness(e.cast)
			assert.ok(
				defined.kind === "partial" &&
					operationProofHolds(e.proof, defined.preconditions, {
						type: e.type,
						operand: e.args[0].type
					}),
				`a narrowing into ${typeLabel(e.type)} its proof re-derives`
			)
		}
		if (e.kind !== "cast" && e.kind !== "domainCast") {
			continue
		}
		const info = e.type.contract
		if (info === undefined) {
			continue
		}
		assert.equal(e.kind, "domainCast", `a cast into ${typeLabel(e.type)} is a domain cast`)
		if (e.kind === "domainCast") {
			assert.ok(
				operationProofHolds(e.proof, [{ kind: "domain" }], {
					type: e.type,
					operand: e.args[0].type
				}),
				`a domain cast into ${typeLabel(e.type)} its proof re-derives`
			)
		}
		c.note(
			`domain cast into ${info.predicate === undefined ? "an unchecked" : "a checked"} contract`
		)
	}
}

const Tag = testContract("Tag", testPg.numericOf(5, 2), undefined)

const castFields: Readonly<Record<string, TestField>> = {
	i: testPg.integer,
	b: testPg.bigint,
	n: testPg.numeric,
	d: testPg.double,
	m: testPg.money,
	f: testPg.boolean,
	cents: Cents,
	rate: Rate,
	tag: Tag
}

const castHeading: Heading = Arr.map(Rec.toEntries(castFields), ([name, described]) => ({
	name,
	type: described.scalar
}))

export const castVars: Readonly<Record<string, ColumnBinding>> = Rec.fromEntries(
	Arr.map(Rec.toEntries(castFields), ([name, described]) => [name, col(described)])
)

export const contracts: { readonly [C in ContractColumn]: TestField } = {
	cents: Cents,
	rate: Rate,
	tag: Tag
}

export const castCaseGen: Gen<CastCase> = oneOf<CastCase>([
	map(termSketchGen(3), (term): CastCase => ({ kind: "generated", term })),
	(source) => ({
		kind: "conditional",
		contract: source.draw(element<ContractColumn>(["cents", "rate", "tag"])),
		other: source.draw(element(["column", "parameter", "identity cast"] as const)),
		contractFirst: source.draw(boolean)
	})
])

/**
 * The compute generator's term over the heading, lowered as the query generator lowers one: literals of the type
 * they meet, parameters bound as their compared base type.
 */
export const generated = (term: TermSketch, c: Case<CastFeature>): void => {
	const s = sink()
	const declared = new Map<string, ScalarType>()
	const scope: TermScope = {
		heading: castHeading,
		params: true,
		literal: (type, value) => ({
			kind: "literal",
			value: typedLiteralDesc(resolveValue(type, value, false), type)
		}),
		param: (_, type) => {
			const name = `t${declared.size + 1}`
			declared.set(name, type)
			return name
		}
	}
	const hooks: LowerHooks = {
		emit: s.emit,
		column: (column) => {
			const binding = defined(castVars[column.name], "a heading column is a variable")
			return {
				kind: "column",
				column: { node: NodeId("n0"), name: column.name },
				args: [],
				type: binding.type,
				nonNull: "storage",
				volatility: "immutable"
			}
		},
		param: (name) => {
			const type = defined(declared.get(name), "a registered parameter")
			return {
				spec: {
					kind: "param",
					param: ParamId(name),
					role: "compare",
					args: [],
					type: compareParamType(type),
					nonNull: "codec",
					volatility: "immutable"
				},
				type
			}
		}
	}
	if (buildTerm(scope, hooks, term) === undefined) {
		return
	}
	c.note("generated term")
	checkCasts(s.emitted, c)
}

/**
 * A conditional, LEAST or GREATEST over two compatible terms combines them in their common type (compute/types.ts
 * commonType), the same whichever comes first, and lowers to a value or a typed CompileError, never a defect: its
 * result has the common type, and a branch of another type reaches it by a widening (widensTo), which drops only
 * refinements PostgreSQL never checks. An exact value beside a plain value of its family (compute/types.ts mixesExact)
 * shares no type: the combination is MalformedDescription in either order (typing.ts exactBeside). The terms are the
 * compute generator's (test/support/oracle/gen/compute.ts), a comparison's two sides, and three planted shapes the
 * generator draws too rarely: cond(p, sign(x), y) over numeric typmods, a negative scale among them (sign carries no
 * typmod, so a typmod on its branch is a narrowing that rounds or overflows), a plain span against computeCore.base of a
 * contract over a fixed-width span (a width only the operand order chose), and an exact sum of an integer or money
 * column beside the column. Each pair is combined in both orders.
 */
export type CombinedFeature =
	| "generated cond"
	| "generated least or greatest"
	| `sign over ${"the other branch's typmod" | "another typmod" | "a negative scale"}, sign ${"first" | "second"}`
	| `a plain span against a based fixed-width span, base ${"first" | "second"}`
	| `an exact value beside a plain value of its family refused, ${"exact" | "plain"} first`

type CombinedCase =
	| { readonly kind: "generated"; readonly compare: CompareSketch }
	| { readonly kind: "sign"; readonly x: string; readonly y: string }
	| { readonly kind: "span" }
	| { readonly kind: "exact"; readonly column: "i" | "m" }

export const variable = (name: string): ExprDesc => ({ kind: "var", var: name })

const fixedSpan = field({ kind: "span", endpoint: testPg.bigint.desc, width: 5n }, "range")

const Shift = testContract("Shift", fixedSpan, undefined)

const combinedFields: Readonly<Record<string, TestField>> = {
	f: testPg.boolean,
	i: testPg.integer,
	b: testPg.bigint,
	n: testPg.numeric,
	n52: testPg.numericOf(5, 2),
	n22: testPg.numericOf(2, 2),
	n3m2: testPg.numericOf(3, -2),
	d: testPg.double,
	r: testPg.real,
	m: testPg.money,
	t: testPg.text,
	code: testPg.regex("^[a-z]+$", "u"),
	s: testSpan(testPg.bigint),
	sw: fixedSpan,
	shift: Shift
}

const typmods: Arr.NonEmptyReadonlyArray<string> = ["n52", "n22", "n3m2"]

const combinedHeading: Heading = Arr.map(Rec.toEntries(combinedFields), ([name, described]) => ({
	name,
	type: described.scalar
}))

export const combinedVars: Readonly<Record<string, LeafBinding>> = Rec.fromEntries(
	Arr.map(Rec.toEntries(combinedFields), ([name, described]) => [name, col(described)])
)

const scope: TermScope = {
	heading: combinedHeading,
	params: false,
	literal: (type, value) => ({
		kind: "literal",
		value: typedLiteralDesc(resolveValue(type, value, false), type)
	}),
	param: () => "unused"
}

export const combinedCaseGen: Gen<CombinedCase> = weighted([
	[
		2,
		map(compareSketchGen(2), (compare): CombinedCase => ({
			kind: "generated",
			compare
		}))
	],
	[
		1,
		(source) => ({
			kind: "sign",
			x: source.draw(element(typmods)),
			y: source.draw(element(typmods))
		})
	],
	[1, constant<CombinedCase>({ kind: "span" })],
	[
		1,
		(source): CombinedCase => ({
			kind: "exact",
			column: source.draw(element(["i", "m"] as const))
		})
	]
])

/**
 * The two terms a case combines: a generated comparison's two sides when both are terms (a side may be a literal
 * in the other's type, which is no term), or a planted pair.
 */
export const pairOf = (c: CombinedCase): readonly [ExprDesc, ExprDesc] | undefined => {
	switch (c.kind) {
		case "generated": {
			const compare = resolveCompare(scope, c.compare)
			if (compare?.kind !== "compare" || compare.right.kind === "literal") {
				return undefined
			}
			return [compare.left, compare.right]
		}
		case "sign":
			return [{ kind: "compute", fn: "sign", args: [variable(c.x)] }, variable(c.y)]
		case "span":
			return [{ kind: "base", arg: variable("shift") }, variable("s")]
		case "exact":
			return [
				{ kind: "compute", fn: "sub", args: [variable(c.column), variable(c.column)] },
				variable(c.column)
			]
	}
}

/** The features a combination's branches, in order, reach. */
export const noteShape = (first: ExprDesc, second: ExprDesc, c: Case<CombinedFeature>): void => {
	for (const [sign, other, order] of [
		[first, second, "first"],
		[second, first, "second"]
	] as const) {
		const [x] = sign.kind === "compute" && sign.fn === "sign" ? sign.args : []
		if (
			x?.kind === "var" &&
			other.kind === "var" &&
			typmods.includes(x.var) &&
			typmods.includes(other.var)
		) {
			c.note(
				`sign over ${x.var === other.var ? "the other branch's typmod" : "another typmod"}, sign ${order}`
			)
			if (x.var === "n3m2" || other.var === "n3m2") {
				c.note(`sign over a negative scale, sign ${order}`)
			}
		}
		if (sign.kind === "base" && other.kind === "var" && other.var === "s") {
			c.note(`a plain span against a based fixed-width span, base ${order}`)
		}
	}
}

/** The combination of `first` and `second` in their common type, checked; whether it lowered to a value. */
export const combined = (
	combination: ExprDesc,
	first: Lowered,
	second: Lowered,
	values: (node: ScalarExpr) => ReadonlyArray<ScalarExpr>
): boolean => {
	const type = commonType(first.nominal, second.nominal)
	assert.ok(
		sameScalarType(type, commonType(second.nominal, first.nominal)),
		`the common type of ${typeLabel(first.nominal)} and ${typeLabel(second.nominal)} depends on their order`
	)
	const result = lowerWith("query", combination, combinedVars, false, baseParams)
	if (!result.ok) {
		return false
	}
	const node = result.value.root.expr
	assert.ok(
		sameScalarType(node.type, type),
		`${typeLabel(node.type)}, not the common type ${typeLabel(type)}`
	)
	for (const [i, branch] of [first, second].entries()) {
		const value = defined(values(node)[i], "a branch of the combination")
		assert.ok(
			sameScalarType(branch.actual, type) || widensTo(branch.actual, type),
			`${typeLabel(branch.actual)} reaches ${typeLabel(type)} by no widening`
		)
		assert.ok(
			sameScalarType(value.type, branch.actual) ||
				(value.kind === "cast" &&
					value.cast === widening(branch.actual, type) &&
					sameScalarType(value.type, type)),
			`a branch of ${typeLabel(branch.actual)} enters as ${value.kind} of ${typeLabel(value.type)}`
		)
	}
	return true
}
