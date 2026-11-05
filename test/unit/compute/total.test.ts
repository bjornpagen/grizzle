import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { computeCore as Compute, scalarTerm } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { contractPredicateTable } from "#compiler/scalar/compute/total.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { patternMember } from "#test/support/oracle/reference/evaluate.ts"
import {
	baseParams,
	testContract,
	lowerWith,
	testPg,
	scalarOfDesc,
	spelled,
	type TestField,
	v
} from "#test/unit/compute/support.ts"

const options = {
	loc: SourceLoc("test", []),
	fieldType: (d: Parameters<typeof scalarOfDesc>[0]) => Result.ok(scalarOfDesc(d)),
	regexMember: patternMember
}

/** The predicate table of a predicate over the domain's VALUE of `base`, built as a contract's callback builds it. */
const table = (base: TestField, build: (x: ScalarTerm) => { readonly expr: OpenExpr }) =>
	contractPredicateTable(
		spelled(build(scalarTerm({ kind: "value" }, base.scalar, base)).expr),
		base.scalar,
		"Test",
		[],
		options
	)

/** The incidental constants a form draws: a nonzero integer, a bound, and a numeric typmod with few integer digits. */
interface Constants {
	readonly k: bigint
	readonly m: bigint
	readonly zero: "0" | "0.0" | "0.00"
	readonly precision: number
	readonly scale: number
}

type Outcome =
	| "admitted"
	| "UnsupportedOperation"
	| "MalformedDescription"
	| "PartialOperation"
	| "ResourceBound"

/**
 * A form of a contract predicate: the base it reads, the predicate, and the outcome compilation gives it.
 */
interface Form {
	readonly outcome: Outcome
	readonly table: (c: Constants) => Result.Result<unknown, CompileError>
}

const forms = {
	"division by a nonzero literal": {
		outcome: "admitted",
		table: ({ k, m }) => table(testPg.bigint, (x) => Compute.le(Compute.div(x, k), m))
	},
	"remainder by a nonzero literal": {
		outcome: "admitted",
		table: ({ k, m }) => table(testPg.bigint, (x) => Compute.ne(Compute.mod(x, k), m))
	},
	"integer products": {
		outcome: "admitted",
		table: ({ m }) => table(testPg.bigint, (x) => Compute.lt(Compute.mul(Compute.mul(x, x), x), m))
	},
	"bounded numeric arithmetic": {
		outcome: "admitted",
		table: ({ precision, scale }) =>
			table(testPg.numericOf(precision, scale), (x) => Compute.gt(Compute.mul(x, "2.5"), "-10"))
	},
	"bounded numeric over a tiny divisor": {
		outcome: "admitted",
		table: ({ m }) =>
			table(testPg.numericOf(20, 0), (x) => Compute.lt(Compute.div(x, "1e-16383"), m))
	},
	"negation, abs and sign over a wide numeric": {
		outcome: "admitted",
		table: ({ m }) =>
			table(testPg.numeric, (x) =>
				Compute.and(
					Compute.lt(Compute.neg(x), m),
					Compute.eq(Compute.add(Compute.sign(x), 1n), Compute.abs(x))
				)
			)
	},
	"abs and sign over a float": {
		outcome: "admitted",
		table: () =>
			table(testPg.double, (x) =>
				Compute.and(Compute.le(Compute.abs(x), 1), Compute.ne(Compute.sign(x), -1))
			)
	},
	"division by a zero literal": {
		outcome: "PartialOperation",
		table: ({ m }) => table(testPg.bigint, (x) => Compute.le(Compute.div(x, 0n), m))
	},
	"numeric division by a zero literal": {
		outcome: "PartialOperation",
		table: ({ zero, m, precision, scale }) =>
			table(testPg.numericOf(precision, scale), (x) => Compute.le(Compute.div(x, zero), m))
	},
	"division by a term": {
		outcome: "PartialOperation",
		table: ({ m }) => table(testPg.bigint, (x) => Compute.le(Compute.div(x, x), m))
	},
	"arithmetic over a wide numeric": {
		outcome: "admitted",
		table: ({ k, m }) => table(testPg.numeric, (x) => Compute.lt(Compute.add(x, k), m))
	},
	"a literal near the limit": {
		outcome: "ResourceBound",
		table: ({ m }) =>
			table(testPg.numericOf(20, 0), (x) => Compute.lt(Compute.mul(x, "1e131071"), m))
	},
	"a quotient scaling past the limit": {
		outcome: "ResourceBound",
		table: ({ m }) =>
			table(testPg.numericOf(20, 0), (x) =>
				Compute.lt(Compute.div(Compute.mul(x, "1e120000"), "1e-16383"), m)
			)
	},
	"float arithmetic": {
		outcome: "UnsupportedOperation",
		table: () => table(testPg.double, (x) => Compute.le(Compute.mul(x, 2), 10))
	},
	"money arithmetic": {
		outcome: "UnsupportedOperation",
		table: () => table(testPg.money, (x) => Compute.le(Compute.add(x, x), x))
	},
	"a cast": {
		outcome: "PartialOperation",
		table: () => table(testPg.bigint, (x) => Compute.eq(Compute.cast(x, testPg.integer), 1))
	},
	"a conditional": {
		outcome: "admitted",
		table: ({ m }) => table(testPg.bigint, (x) => Compute.eq(Compute.cond(x.gt(0n), x, 0n), m))
	},
	"a partial function": {
		outcome: "UnsupportedOperation",
		table: () => table(testPg.numeric, (x) => Compute.eq(Compute.round(x), "1"))
	},
	greatest: {
		outcome: "UnsupportedOperation",
		table: ({ m }) => table(testPg.bigint, (x) => Compute.eq(Compute.greatest(x, x), m))
	},
	"a parameter": {
		outcome: "UnsupportedOperation",
		table: () =>
			contractPredicateTable(
				{
					kind: "compare",
					op: "ge",
					left: { kind: "value" },
					right: { kind: "param", name: "p", type: testPg.bigint.desc }
				},
				testPg.bigint.scalar,
				"T",
				[],
				options
			)
	},
	"a variable": {
		outcome: "MalformedDescription",
		table: ({ m }) =>
			contractPredicateTable(
				{
					kind: "compare",
					op: "ge",
					left: { kind: "var", var: "x" },
					right: { kind: "literal", value: m, type: undefined }
				},
				testPg.bigint.scalar,
				"T",
				[],
				options
			)
	}
} as const satisfies Readonly<Record<string, Form>>

type FormName = keyof typeof forms
const formNames: Arr.NonEmptyReadonlyArray<FormName> = [
	"division by a nonzero literal",
	"remainder by a nonzero literal",
	"integer products",
	"bounded numeric arithmetic",
	"bounded numeric over a tiny divisor",
	"negation, abs and sign over a wide numeric",
	"abs and sign over a float",
	"division by a zero literal",
	"numeric division by a zero literal",
	"division by a term",
	"arithmetic over a wide numeric",
	"a literal near the limit",
	"a quotient scaling past the limit",
	"float arithmetic",
	"money arithmetic",
	"a cast",
	"a conditional",
	"a partial function",
	"greatest",
	"a parameter",
	"a variable"
]

const constantsGen: Gen<Constants> = (source) => {
	const precision = source.draw(int(1, 30))
	return {
		k: source.draw(oneOf([bigint(-1000n, -1n), bigint(1n, 1000n)])),
		m: source.draw(bigint(-1000n, 1000n)),
		zero: source.draw(element(["0", "0.0", "0.00"] as const)),
		precision,
		scale: source.draw(int(0, precision))
	}
}

describe("contract predicate tables", () => {
	it.effect(
		"admit a predicate whose every partial operation is proved, refusing an unproved one and every read but VALUE",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/compute/total-fragment",
						draw: drawn((source) => ({
							form: source.draw(element(formNames)),
							constants: source.draw(constantsGen)
						})),
						literal: Formatter.format,
						coverage: required<`form ${FormName}`>(
							Arr.map(formNames, (f) => `form ${f}` as const),
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						/** The rotating stream's sample of twenty-one forms, each about one case in twenty. */
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ form, constants }, c) =>
						Effect.sync(() => {
							c.note(`form ${form}`)
							const { outcome, table: build } = forms[form]
							const result = build(constants)
							if (outcome === "admitted") {
								succeeded(result, form)
							} else {
								refused(result, outcome, form)
							}
						})
				)
			)
	)
})

describe("the ContractLiteral check", () => {
	const Cents = testContract("Cents", testPg.bigint, (x) => x.ge(0n))

	it.effect(
		"checks a literal that adopts a contract against its predicate, and none that adopts its base",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/compute/contract-literal",
						draw: drawn((source) => ({
							n: source.draw(bigint(-1000n, 1000n)),
							site: source.draw(element(["compare" as const, "arithmetic" as const]))
						})),
						literal: Formatter.format,
						coverage: required<"compare admitted" | "compare refused" | "arithmetic admitted">(
							["compare admitted", "compare refused", "arithmetic admitted"],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						/** The rotating stream's sample: half the literals are negative, and each site is half the cases. */
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ n, site }, c) =>
						Effect.sync(() => {
							const vars = { c: { kind: "column", type: Cents.scalar } } as const
							if (site === "arithmetic") {
								c.note("arithmetic admitted")
								succeeded(
									lowerWith(
										"query",
										spelled(Compute.add(v("c", Cents), n).expr),
										vars,
										false,
										baseParams
									)
								)
								return
							}
							const result = lowerWith(
								"query",
								{
									kind: "compare",
									op: "ge",
									left: { kind: "var", var: "c" },
									right: { kind: "literal", value: n, type: undefined }
								},
								vars,
								true,
								baseParams
							)
							if (n >= 0n) {
								c.note("compare admitted")
								succeeded(result)
							} else {
								c.note("compare refused")
								refused(result, "ContractLiteral")
							}
						})
				)
			)
	)
})
