import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	boolean,
	constant,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint, double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { NodeId, ParamId } from "#compiler/core/ids.ts"
import type { CompareOp, ExprDesc } from "#compiler/ir/desc.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import {
	contractOf,
	exactDigitsOf,
	type ScalarType,
	sameScalarType,
	typeLabel
} from "#compiler/ir/scalar.ts"
import type { Lowered } from "#compiler/scalar/compute/lower.ts"
import { commonType, mixesExact, widening } from "#compiler/scalar/compute/types.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
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

import { caseHang } from "#test/support/limits.ts"
import {
	compareParamType,
	typedLiteralDesc,
	resolveValue
} from "#test/support/oracle/gen/domain.ts"
import { operationProofHolds } from "#test/support/oracle/proof.ts"
import {
	baseParams,
	testContract,
	field,
	type LeafBinding,
	lowerWith,
	testPg,
	sink,
	testSpan,
	type TestField
} from "#test/unit/compute/support.ts"

const Cents = testContract("Cents", testPg.bigint, (x) => x.ge(0n))

/** A leaf bound to a column, the one binding the column hook reads. */
type ColumnBinding = Extract<LeafBinding, { readonly kind: "column" }>

const col = (f: { readonly scalar: ColumnBinding["type"] }): ColumnBinding => ({
	kind: "column",
	type: f.scalar
})

const lowered = (expr: ExprDesc, vars: Readonly<Record<string, LeafBinding>>) =>
	succeeded(lowerWith("query", expr, vars, false, baseParams))

/**
 * What a leaf of a description meets: a literal never stands first, and a parameter does, at its declared type; two
 * untyped literal branches of a conditional follow the literal typing rule, a JavaScript number integer and a bigint
 * bigint, and branches of the two are malformed; a numeric literal is a decimal, never a JavaScript fraction.
 */
type UntypedForm =
	| "literal first"
	| "parameter first"
	| "two untyped branches"
	| "fraction for numeric"

type UntypedFeature =
	| `form ${Exclude<UntypedForm, "two untyped branches">}`
	| `branches ${UntypedLiteral["kind"]} and ${UntypedLiteral["kind"]}`

type UntypedLiteral =
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "bigint"; readonly value: bigint }

describe("lowering in query mode", () => {
	const Rate = testContract("Rate", testPg.numericOf(5, 2), (x) => x.ge("0"))
	const fields: Readonly<Record<string, TestField>> = {
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
	const vars: Readonly<Record<string, LeafBinding>> = Rec.fromEntries(
		Arr.map(Rec.toEntries(fields), ([name, described]) => [name, col(described)])
	)
	const compareOps: Arr.NonEmptyReadonlyArray<CompareOp> = ["eq", "ne", "lt", "le", "gt", "ge"]
	const opGen = element(compareOps)

	/** A literal of each kind the rule types, within a box both integer types hold. */
	const untypedLiteralGen: Gen<UntypedLiteral> = oneOf([
		map(int(-1000, 1000), (value): UntypedLiteral => ({ kind: "number", value })),
		map(bigint(-1000n, 1000n), (value): UntypedLiteral => ({ kind: "bigint", value }))
	])
	const numberColumns: Arr.NonEmptyReadonlyArray<string> = ["i", "b", "n", "n52"]
	const literalOf = (l: UntypedLiteral): ExprDesc => ({
		kind: "literal",
		value: l.value,
		type: undefined
	})

	it.effect(
		"refuses an untyped leaf standing first, types two untyped branches by the literal typing rule, and refuses a fraction for a numeric",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/compute/untyped-leaves",
						draw: drawn((source) => ({
							form: source.draw(
								element<UntypedForm>([
									"literal first",
									"parameter first",
									"two untyped branches",
									"fraction for numeric"
								])
							),
							column: source.draw(element(numberColumns)),
							op: source.draw(opGen),
							literals: source.draw(
								(source) =>
									[source.draw(untypedLiteralGen), source.draw(untypedLiteralGen)] as const
							),
							fraction: source.draw(filter(double(-1e6, 1e6), (x) => !Number.isInteger(x), 100))
						})),
						literal: Formatter.format,
						coverage: required<UntypedFeature>(
							[
								"form literal first",
								"form parameter first",
								"form fraction for numeric",
								"branches number and number",
								"branches bigint and bigint",
								"branches number and bigint",
								"branches bigint and number"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						/**
						 * The rotating stream's sample: each form is a quarter of the cases and each pair of branch kinds a quarter
						 * of those.
						 */
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ form, column, op, literals: [a, b], fraction }, c) =>
						Effect.sync(() => {
							const term: ExprDesc = { kind: "var", var: column }
							switch (form) {
								case "literal first":
									c.note(`form ${form}`)
									refused(
										lowerWith(
											"query",
											{ kind: "compare", op, left: literalOf(a), right: term },
											vars,
											true,
											baseParams
										),
										"MalformedDescription"
									)
									return
								case "parameter first": {
									c.note(`form ${form}`)
									const declared = defined(fields[column], "the column's field")
									const sum = succeeded(
										lowerWith(
											"query",
											{
												kind: "compute",
												fn: "add",
												args: [{ kind: "param", name: "q", type: declared.desc }, term]
											},
											vars,
											false,
											baseParams
										)
									)
									assert.ok(
										Arr.some(sum.emitted, (e) => e.kind === "param"),
										"a parameter standing first is lowered at its declared type"
									)
									return
								}
								case "fraction for numeric":
									c.note(`form ${form}`)
									refused(
										lowerWith(
											"query",
											{
												kind: "compare",
												op,
												left: { kind: "var", var: "n" },
												right: { kind: "literal", value: fraction, type: undefined }
											},
											vars,
											true,
											baseParams
										),
										"MalformedDescription"
									)
									return
								case "two untyped branches": {
									c.note(`branches ${a.kind} and ${b.kind}`)
									const cond: ExprDesc = {
										kind: "cond",
										pred: { kind: "var", var: "f" },
										onTrue: literalOf(a),
										onFalse: literalOf(b)
									}
									const result = lowerWith("query", cond, vars, false, baseParams)
									if (a.kind !== b.kind) {
										refused(result, "MalformedDescription")
										return
									}
									const expected = a.kind === "number" ? testPg.integer : testPg.bigint
									const { nominal } = succeeded(result).root
									assert.ok(
										sameScalarType(nominal, expected.scalar),
										`${a.kind} branches typed ${typeLabel(nominal)}`
									)
									return
								}
							}
						})
				)
			)
	)
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
type CastFeature = "generated term" | `domain cast into ${"a checked" | "an unchecked"} contract`

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
const checkCasts = (exprs: ReadonlyArray<ScalarExpr>, c: Case<CastFeature>): void => {
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
		const info = contractOf(e.type)
		if (info === undefined) {
			continue
		}
		assert.equal(e.kind, "domainCast", `a cast into ${typeLabel(e.type)} is a domain cast`)
		if (e.kind === "domainCast") {
			assert.ok(
				operationProofHolds(e.proof, [{ kind: "contract" }], {
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

describe("a conversion into a contract", () => {
	const Rate = testContract("Rate", testPg.numericOf(5, 2), (x) => x.ge("0"))
	const Tag = testContract("Tag", testPg.numericOf(5, 2), undefined)
	const fields: Readonly<Record<string, TestField>> = {
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
	const heading: Heading = Arr.map(Rec.toEntries(fields), ([name, described]) => ({
		name,
		type: described.scalar
	}))
	const vars: Readonly<Record<string, ColumnBinding>> = Rec.fromEntries(
		Arr.map(Rec.toEntries(fields), ([name, described]) => [name, col(described)])
	)
	const contracts: { readonly [C in ContractColumn]: TestField } = {
		cents: Cents,
		rate: Rate,
		tag: Tag
	}
	const caseGen: Gen<CastCase> = oneOf<CastCase>([
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
	const generated = (term: TermSketch, c: Case<CastFeature>): void => {
		const s = sink()
		const declared = new Map<string, ScalarType>()
		const scope: TermScope = {
			heading,
			params: true,
			literal: (type, value) => ({
				kind: "literal",
				value: typedLiteralDesc(resolveValue(type, value, false), type),
				type: undefined
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
				const binding = defined(vars[column.name], "a heading column is a variable")
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

	it.effect("can fail wherever the contract has a CHECK, never total", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/compute/cast-into-contract",
					/**
					 * Planted: the conversions of one contract column each that the drawn conditionals reach about one case
					 * in thirty-six: rate and tag cast into their own contracts (a cast into a checked and an unchecked
					 * contract), and tag beside its parameter (a domain cast into an unchecked contract).
					 */
					draw: drawn(caseGen),
					literal: Formatter.format,
					coverage: required<CastFeature>(
						[
							"generated term",
							"domain cast into a checked contract",
							"domain cast into an unchecked contract"
						],
						{ cases: 200, sense: notesOnly }
					),
					kept: [
						{
							note: "tag or its parameter",
							sketch: {
								kind: "conditional",
								contract: "tag",
								other: "parameter",
								contractFirst: false
							},
							draws: "",
							reaches: ["domain cast into an unchecked contract"]
						}
					],
					/**
					 * Each conversion arm is drawn in about one case in ten, the generated terms in one in two: 200 cases
					 * reach every feature many times over.
					 */
					runs: 200,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(sketch, c) =>
					Effect.sync(() => {
						if (sketch.kind === "generated") {
							generated(sketch.term, c)
							return
						}
						const name = sketch.contract
						const chosen = contracts[name]
						const column: ExprDesc = { kind: "var", var: name }
						/**
						 * Compute.cast of a contract column into its own contract: castTo leaves a numeric contract's value at its
						 * base typmod, so the conditional converts it into the domain (CastHow "domain"), the one path a checked
						 * schema reaches.
						 */
						const other: ExprDesc =
							sketch.other === "column"
								? column
								: sketch.other === "parameter"
									? { kind: "param", name: "q", type: chosen.desc }
									: { kind: "cast", arg: column, to: chosen.desc }
						const desc: ExprDesc = {
							kind: "cond",
							pred: { kind: "var", var: "f" },
							onTrue: sketch.contractFirst ? column : other,
							onFalse: sketch.contractFirst ? other : column
						}
						checkCasts(lowered(desc, vars).emitted, c)
					})
			)
		)
	)
})

/**
 * A conditional, LEAST or GREATEST over two compatible terms combines them in their common type (compute/types.ts
 * commonType), the same whichever comes first, and lowers to a value or a typed CompileError, never a defect: its
 * result has the common type, and a branch of another type reaches it by a widening (widensTo), which drops only
 * refinements PostgreSQL never checks. An exact value beside a plain value of its family (compute/types.ts mixesExact)
 * shares no type: the combination is MalformedDescription in either order (lower.ts exactBeside). The terms are the
 * compute generator's (test/support/oracle/gen/compute.ts), a comparison's two sides, and three planted shapes the
 * generator draws too rarely: cond(p, sign(x), y) over numeric typmods, a negative scale among them (sign carries no
 * typmod, so a typmod on its branch is a narrowing that rounds or overflows), a plain span against Compute.base of a
 * contract over a fixed-width span (a width only the operand order chose), and an exact sum of an integer or money
 * column beside the column. Each pair is combined in both orders.
 */
type CombinedFeature =
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

const variable = (name: string): ExprDesc => ({ kind: "var", var: name })

describe("a combination of two compatible terms", () => {
	const fixedSpan = field({ kind: "span", endpoint: testPg.bigint.desc, width: 5n }, "range")
	const Shift = testContract("Shift", fixedSpan, undefined)
	const fields: Readonly<Record<string, TestField>> = {
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
	const heading: Heading = Arr.map(Rec.toEntries(fields), ([name, described]) => ({
		name,
		type: described.scalar
	}))
	const vars: Readonly<Record<string, LeafBinding>> = Rec.fromEntries(
		Arr.map(Rec.toEntries(fields), ([name, described]) => [name, col(described)])
	)
	const scope: TermScope = {
		heading,
		params: false,
		literal: (type, value) => ({
			kind: "literal",
			value: typedLiteralDesc(resolveValue(type, value, false), type),
			type: undefined
		}),
		param: () => "unused"
	}
	const caseGen: Gen<CombinedCase> = weighted([
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
	const pairOf = (c: CombinedCase): readonly [ExprDesc, ExprDesc] | undefined => {
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
	const noteShape = (first: ExprDesc, second: ExprDesc, c: Case<CombinedFeature>): void => {
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
	const combined = (
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
		const result = lowerWith("query", combination, vars, false, baseParams)
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

	it.effect(
		"combines in one common type whichever comes first, and widens each branch into it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/compute/common-type",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<CombinedFeature>(
							[
								"generated cond",
								"generated least or greatest",
								"sign over the other branch's typmod, sign first",
								"sign over the other branch's typmod, sign second",
								"sign over another typmod, sign first",
								"sign over another typmod, sign second",
								"sign over a negative scale, sign first",
								"sign over a negative scale, sign second",
								"a plain span against a based fixed-width span, base first",
								"a plain span against a based fixed-width span, base second",
								"an exact value beside a plain value of its family refused, exact first",
								"an exact value beside a plain value of its family refused, plain first"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						/**
						 * The rotating stream's sample: the planted shapes are each a quarter of the cases, and a generated
						 * comparison yields a pair in most of the rest.
						 */
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, c) =>
						Effect.sync(() => {
							const pair = pairOf(sketch)
							if (pair === undefined) {
								return
							}
							const [term, other] = pair
							const left = lowered(term, vars).root
							const right = lowered(other, vars).root
							for (const [first, second, a, b] of [
								[term, other, left, right],
								[other, term, right, left]
							] as const) {
								const cond: ExprDesc = {
									kind: "cond",
									pred: variable("f"),
									onTrue: first,
									onFalse: second
								}
								if (mixesExact(a.nominal, b.nominal)) {
									for (const combination of [
										cond,
										{ kind: "compute", fn: "least", args: [first, second] },
										{ kind: "compute", fn: "greatest", args: [first, second] }
									] as const) {
										refused(
											lowerWith("query", combination, vars, false, baseParams),
											"MalformedDescription"
										)
									}
									c.note(
										`an exact value beside a plain value of its family refused, ${exactDigitsOf(a.nominal) === undefined ? "plain" : "exact"} first`
									)
									continue
								}
								if (combined(cond, a, b, (node) => node.args.slice(1))) {
									noteShape(first, second, c)
									if (sketch.kind === "generated") {
										c.note("generated cond")
									}
								}
								for (const fn of ["least", "greatest"] as const) {
									if (
										combined(
											{ kind: "compute", fn, args: [first, second] },
											a,
											b,
											(node) => node.args
										) &&
										sketch.kind === "generated"
									) {
										c.note("generated least or greatest")
									}
								}
							}
						})
				)
			)
	)
})
