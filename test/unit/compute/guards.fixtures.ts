import { Array as Arr, Record as Rec } from "effect"
import { regexTextMaxBytes, type GuardTest, type PreconditionKind } from "#compiler/core/errors.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import type { Carrier } from "#compiler/ir/scalar.ts"
import { pg } from "#compiler/public/fields.ts"
import { lexicalForm } from "#compiler/public/text.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import {
	baseParams,
	lowerWith,
	param,
	spelledExpr,
	testContract,
	type TestField,
	type TestOperand,
	testPg
} from "#test/unit/compute/support.ts"

export const kinds: Arr.NonEmptyReadonlyArray<PreconditionKind> = [
	"nonzero",
	"nonnegative",
	"finite",
	"fits",
	"contract",
	"language",
	"powerDomain",
	"powerRange",
	"bucketDomain",
	"lexical",
	"bounded"
]

/** The term with its fault mended: the named guard written around it, its operand a typed parameter, or neither. */
type Mended =
	| { readonly kind: "guarded"; readonly term: (x: ScalarTerm) => { readonly expr: OpenExpr } }
	| { readonly kind: "typed"; readonly term: () => { readonly expr: OpenExpr } }
	| { readonly kind: "beyond one guard" }

/** One planted fault: the column's operand type, the partial term over it, and its mending. */
interface Plant {
	readonly operand: TestOperand
	readonly faulty: (x: ScalarTerm) => { readonly expr: OpenExpr }
	readonly mended: Mended
}

/** A zero each operand type's literals spell. */
const zeroOf = (f: TestOperand): LiteralDesc =>
	f.scalar.carrier === "int8" ? 0n : f.scalar.carrier === "numeric" ? Decimal.of("0") : 0

const Positive = testContract("Positive", testPg.integer, (x) => Compute.gt(x, 0))

const Fraction = testContract("Fraction", testPg.numericOf(5, 2), (x) =>
	Compute.lt(x, Decimal.of("1"))
)

const Named = testContract("Named", testPg.text, (x) => Compute.ne(x, ""))

const Truth = testContract("Truth", testPg.boolean, (x) => Compute.eq(x, true))

const lower = testPg.regex("^[a-z]+$", "u")

/** A text a pattern bounds, which Compute.matches reads in a query: an unbounded one it refuses. */
const short = testPg.regex("^.{0,80}$", "su")

/** Division by the operand itself, guarded by Compute.nonzero. */
const nonzero = (operand: TestField): Plant => ({
	operand,
	faulty: (x) => Compute.div(x, x),
	mended: {
		kind: "guarded",
		term: (x) =>
			Compute.when(Compute.nonzero(x), (d: ScalarTerm) => Compute.div(x, d), Compute.sub(x, x))
	}
})

/** A narrowing of the operand into `target`, guarded by Compute.within at zero, which every target holds. */
const fits = (operand: TestOperand, target: TestField): Plant => ({
	operand,
	faulty: (x) => Compute.cast(x, target),
	mended: {
		kind: "guarded",
		term: (x) =>
			Compute.when(
				Compute.within(x, zeroOf(operand), zeroOf(operand)),
				(y: ScalarTerm) => Compute.cast(y, target),
				zeroOf(target)
			)
	}
})

/** A contract cast over a number, guarded by Compute.within at `inside`, a value its predicate holds of. */
const numberContract = (operand: TestField, target: TestField, inside: LiteralDesc): Plant => ({
	operand,
	faulty: (x) => Compute.cast(x, target),
	mended: {
		kind: "guarded",
		term: (x) =>
			Compute.when(
				Compute.within(x, inside, inside),
				(y: ScalarTerm) => Compute.cast(y, target),
				inside
			)
	}
})

/** A contract cast over a type no Compute test bounds, mended by a parameter of the contract's own type. */
const typedContract = (operand: TestField, target: TestField): Plant => ({
	operand,
	faulty: (x) => Compute.cast(x, target),
	mended: { kind: "typed", term: () => Compute.cast(param("p", target), target) }
})

/** A square root of the operand, guarded by Compute.nonnegative. */
const sqrt = (operand: TestOperand): Plant => ({
	operand,
	faulty: (x) => Compute.sqrt(x),
	mended: {
		kind: "guarded",
		term: (x) =>
			Compute.when(Compute.nonnegative(x), (y: ScalarTerm) => Compute.sqrt(y), Compute.sub(x, x))
	}
})

/** The least scale of the operand, guarded by Compute.isFinite. */
const minScale = (operand: TestOperand): Plant => ({
	operand,
	faulty: (x) => Compute.minScale(x),
	mended: {
		kind: "guarded",
		term: (x) => Compute.when(Compute.isFinite(x), (y: ScalarTerm) => Compute.minScale(y), 0)
	}
})

/** The operand to its own power, whose sign Compute.positive proves and whose range it does not. */
const power = (operand: TestOperand): Plant => ({
	operand,
	faulty: (x) => Compute.power(x, x),
	mended: { kind: "beyond one guard" }
})

/**
 * The operand to its own power under Compute.positive, its sign proved and its range not, guarded by Compute.within
 * between one and two, which proves both.
 */
const powerRange = (operand: TestOperand, one: LiteralDesc, two: LiteralDesc): Plant => ({
	operand,
	faulty: (x) => Compute.when(Compute.positive(x), (y: ScalarTerm) => Compute.power(y, y), one),
	mended: {
		kind: "guarded",
		term: (x) =>
			Compute.when(Compute.within(x, one, two), (y: ScalarTerm) => Compute.power(y, y), one)
	}
})

/** The planted faults of each precondition kind, over each operand type the registry admits for its operation. */
export const plants: { readonly [K in PreconditionKind]: Arr.NonEmptyReadonlyArray<Plant> } = {
	nonzero: [
		nonzero(testPg.smallint),
		nonzero(testPg.integer),
		nonzero(testPg.bigint),
		nonzero(testPg.numeric)
	],
	nonnegative: [sqrt(testPg.numeric)],
	finite: [minScale(testPg.numeric), minScale(testPg.computedNumeric)],
	fits: [
		fits(testPg.integer, testPg.smallint),
		fits(testPg.bigint, testPg.integer),
		fits(testPg.bigint, testPg.smallint),
		fits(testPg.numeric, testPg.numericOf(5, 2)),
		fits(testPg.computedNumeric, testPg.numericOf(5, 2))
	],
	contract: [
		numberContract(testPg.integer, Positive, 1),
		numberContract(testPg.numericOf(5, 2), Fraction, Decimal.of("0")),
		typedContract(testPg.text, Named),
		typedContract(testPg.boolean, Truth)
	],
	language: [
		{
			operand: short,
			faulty: (x) => Compute.cast(x, lower),
			mended: {
				kind: "guarded",
				term: (x) =>
					Compute.when(
						Compute.matches(x, Compute.pattern("^[a-z]+$")),
						(y: ScalarTerm) => Compute.cast(y, lower),
						"a"
					)
			}
		}
	],
	powerDomain: [power(testPg.numeric), power(testPg.double)],
	powerRange: [
		powerRange(testPg.numeric, Decimal.of("1"), Decimal.of("2")),
		powerRange(testPg.double, 1, 2)
	],
	bucketDomain: [
		{
			operand: testPg.numeric,
			faulty: (x) =>
				Compute.when(Compute.isFinite(x), (y: ScalarTerm) => Compute.widthBucket(y, y, y, 10), 0),
			mended: { kind: "beyond one guard" }
		}
	],
	lexical: Arr.map(
		[
			[testPg.integer, pg.integer],
			[testPg.bigint, pg.bigint]
		] as const,
		([target, descriptor]) => ({
			operand: short,
			faulty: (x: ScalarTerm) => Compute.cast(x, target),
			mended: {
				kind: "guarded",
				term: (x: ScalarTerm) =>
					Compute.when(
						Compute.matches(x, lexicalForm(descriptor)),
						(y: ScalarTerm) => Compute.cast(y, target),
						zeroOf(target)
					)
			}
		})
	),
	bounded: [
		{
			operand: testPg.text,
			faulty: (x) => Compute.utf16Length(x),
			mended: {
				kind: "guarded",
				term: (x) =>
					Compute.when(
						Compute.within(Compute.octetLength(x), 0, regexTextMaxBytes),
						() => Compute.utf16Length(x),
						0
					)
			}
		}
	]
}

/**
 * Where each kind's plant is lowered: a query's, whose operations are the widest, or a check's for a text's UTF-16
 * units, which only a check, a contract predicate or a generated field reads.
 */
const modeOf: { readonly [K in PreconditionKind]: "query" | "check" } = {
	nonzero: "query",
	nonnegative: "query",
	finite: "query",
	fits: "query",
	contract: "query",
	language: "query",
	powerDomain: "query",
	powerRange: "query",
	bucketDomain: "query",
	lexical: "query",
	bounded: "check"
}

/** The tests Compute writes over a value of a carrier: a number's facts and bounds, a text's patterns, or none. */
export const writable = (carrier: Carrier): ReadonlyArray<GuardTest["kind"]> => {
	switch (carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "exactInteger":
		case "exactMoney":
			return ["nonzero", "nonnegative", "positive", "isFinite", "within"]
		case "text":
			return ["matches", "octets", "typed"]
		case "bytes":
			return []
		case "bool":
		case "uuid":
		case "date":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
			return ["typed"]
	}
}

/** What a case reached: each kind refused with a guard, a text's and an untestable type's guards, a mending admitted. */
export type Feature =
	| `refused for ${PreconditionKind}`
	| "a text operand's guard"
	| "a guard no Compute test writes"
	| "a named guard, written, admitted"

export const lowered = (
	kind: PreconditionKind,
	expr: { readonly expr: OpenExpr },
	operand: TestOperand
) =>
	lowerWith(
		modeOf[kind],
		spelledExpr(expr.expr),
		{ x: { kind: "column", type: operand.scalar } },
		false,
		baseParams
	)

/** The widest list of plants, which bounds the box's operand picks. */
export const widest = Arr.reduce(Rec.values(plants), 0, (n, list) => Math.max(n, list.length))
