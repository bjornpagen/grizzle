import { Array as Arr, Record as Rec } from "effect"
import { regexTextMaxBytes, type GuardTest, type PreconditionKind } from "#compiler/core/errors.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import type { Carrier } from "#compiler/ir/scalar.ts"
import { int4, int8 } from "#compiler/public/fields.ts"
import { lexicalForm } from "#compiler/public/text.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { Numeric } from "#compiler/scalar/values/decimal.ts"
import {
	baseParams,
	lowerWith,
	param,
	spelledExpr,
	testContract,
	type TestField,
	type TestOperand,
	testPg
} from "#test/support/unit/compute/support.ts"

export const kinds: Arr.NonEmptyReadonlyArray<PreconditionKind> = [
	"nonzero",
	"nonnegative",
	"finite",
	"integral",
	"fits",
	"domain",
	"language",
	"powerDomain",
	"powerRange",
	"bucketDomain",
	"lexical",
	"bounded",
	"clock"
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
	f.scalar.carrier === "int8" ? 0n : f.scalar.carrier === "numeric" ? Numeric.of("0") : 0

/** A consumer's contract and the key its module holds, which a cast into it takes (scalar/contract.ts admitMintKey). */
interface Keyed {
	readonly contract: TestField
	readonly key: symbol
}

const Positive: Keyed = {
	contract: testContract("Positive", testPg.integer, (x) => computeCore.gt(x, 0)),
	key: Symbol("Positive")
}

const Fraction: Keyed = {
	contract: testContract("Fraction", testPg.numericOf(5, 2), (x) =>
		computeCore.lt(x, Numeric.of("1"))
	),
	key: Symbol("Fraction")
}

const Named: Keyed = {
	contract: testContract("Named", testPg.text, (x) => computeCore.ne(x, "")),
	key: Symbol("Named")
}

const Truth: Keyed = {
	contract: testContract("Truth", testPg.boolean, (x) => computeCore.eq(x, true)),
	key: Symbol("Truth")
}

const lower = testPg.regex("^[a-z]+$", "u")

/** A text a pattern bounds, which computeCore.matches reads in a query: an unbounded one it refuses. */
const short = testPg.regex("^.{0,80}$", "su")

/** Division by the operand itself, guarded by computeCore.nonzero. */
const nonzero = (operand: TestField): Plant => ({
	operand,
	faulty: (x) => computeCore.div(x, x),
	mended: {
		kind: "guarded",
		term: (x) =>
			computeCore.when(
				computeCore.nonzero(x),
				(d: ScalarTerm) => computeCore.div(x, d),
				computeCore.sub(x, x)
			)
	}
})

/** A narrowing of the operand into `target`, guarded by computeCore.within at zero, which every target holds. */
const fits = (operand: TestOperand, target: TestField): Plant => ({
	operand,
	faulty: (x) => computeCore.cast(x, target),
	mended: {
		kind: "guarded",
		term: (x) =>
			computeCore.when(
				computeCore.within(x, zeroOf(operand), zeroOf(operand)),
				(y: ScalarTerm) => computeCore.cast(y, target),
				zeroOf(target)
			)
	}
})

/** A contract cast over a number under the contract's key, guarded by computeCore.within at `inside`, a value its
 * predicate holds of. */
const numberContract = (operand: TestField, target: Keyed, inside: LiteralDesc): Plant => ({
	operand,
	faulty: (x) => computeCore.cast(x, target.contract, target.key),
	mended: {
		kind: "guarded",
		term: (x) =>
			computeCore.when(
				computeCore.within(x, inside, inside),
				(y: ScalarTerm) => computeCore.cast(y, target.contract, target.key),
				inside
			)
	}
})

/** A contract cast under the contract's key over a type no scalar test bounds, mended by a parameter of the contract's
 * own type. */
const typedContract = (operand: TestField, target: Keyed): Plant => ({
	operand,
	faulty: (x) => computeCore.cast(x, target.contract, target.key),
	mended: {
		kind: "typed",
		term: () => computeCore.cast(param("p", target.contract), target.contract, target.key)
	}
})

/** A square root of the operand, guarded by computeCore.nonnegative. */
const sqrt = (operand: TestOperand): Plant => ({
	operand,
	faulty: (x) => computeCore.sqrt(x),
	mended: {
		kind: "guarded",
		term: (x) =>
			computeCore.when(
				computeCore.nonnegative(x),
				(y: ScalarTerm) => computeCore.sqrt(y),
				computeCore.sub(x, x)
			)
	}
})

/** The least scale of the operand, guarded by computeCore.isFinite. */
const minScale = (operand: TestOperand): Plant => ({
	operand,
	faulty: (x) => computeCore.minScale(x),
	mended: {
		kind: "guarded",
		term: (x) =>
			computeCore.when(computeCore.isFinite(x), (y: ScalarTerm) => computeCore.minScale(y), 0)
	}
})

/** The operand to its own power, whose sign computeCore.positive proves and whose range it does not. */
const power = (operand: TestOperand): Plant => ({
	operand,
	faulty: (x) => computeCore.power(x, x),
	mended: { kind: "beyond one guard" }
})

/**
 * The operand to its own power under computeCore.positive, its sign proved and its range not, guarded by computeCore.within
 * between one and two, which proves both.
 */
const powerRange = (operand: TestOperand, one: LiteralDesc, two: LiteralDesc): Plant => ({
	operand,
	faulty: (x) =>
		computeCore.when(computeCore.positive(x), (y: ScalarTerm) => computeCore.power(y, y), one),
	mended: {
		kind: "guarded",
		term: (x) =>
			computeCore.when(
				computeCore.within(x, one, two),
				(y: ScalarTerm) => computeCore.power(y, y),
				one
			)
	}
})

/** The zone a planted Time.wall reads, a parameter of a closed id of the test's zone roster. */
const utc = (): ScalarTerm => param("zone", testPg.zone)

/**
 * The zone's wall clock at the operand, a bigint of any value, which timestamptz's range does not bound, guarded by
 * computeCore.within at zero, the Unix epoch, which it holds.
 */
const clock = (operand: TestField): Plant => ({
	operand,
	faulty: (x) => computeCore.wall(x, utc()),
	mended: {
		kind: "guarded",
		term: (x) =>
			computeCore.when(
				computeCore.within(x, 0n, 0n),
				(y: ScalarTerm) => computeCore.wall(y, utc()),
				0n
			)
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
	integral: [
		{
			operand: testPg.numeric,
			faulty: (x) =>
				computeCore.when(
					computeCore.isFinite(x),
					(y: ScalarTerm) => computeCore.cast(y, testPg.exactInteger),
					0n
				),
			mended: { kind: "beyond one guard" }
		}
	],
	fits: [
		fits(testPg.integer, testPg.smallint),
		fits(testPg.bigint, testPg.integer),
		fits(testPg.bigint, testPg.smallint),
		fits(testPg.numeric, testPg.numericOf(5, 2)),
		fits(testPg.computedNumeric, testPg.numericOf(5, 2))
	],
	domain: [
		numberContract(testPg.integer, Positive, 1),
		numberContract(testPg.numericOf(5, 2), Fraction, Numeric.of("0")),
		typedContract(testPg.text, Named),
		typedContract(testPg.boolean, Truth)
	],
	language: [
		{
			operand: short,
			faulty: (x) => computeCore.cast(x, lower),
			mended: {
				kind: "guarded",
				term: (x) =>
					computeCore.when(
						computeCore.matches(x, computeCore.pattern("^[a-z]+$")),
						(y: ScalarTerm) => computeCore.cast(y, lower),
						"a"
					)
			}
		}
	],
	powerDomain: [power(testPg.numeric), power(testPg.double)],
	powerRange: [
		powerRange(testPg.numeric, Numeric.of("1"), Numeric.of("2")),
		powerRange(testPg.double, 1, 2)
	],
	bucketDomain: [
		{
			operand: testPg.numeric,
			faulty: (x) =>
				computeCore.when(
					computeCore.isFinite(x),
					(y: ScalarTerm) => computeCore.widthBucket(y, y, y, 10),
					0
				),
			mended: { kind: "beyond one guard" }
		}
	],
	lexical: Arr.map(
		[
			[testPg.integer, int4],
			[testPg.bigint, int8]
		] as const,
		([target, descriptor]) => ({
			operand: short,
			faulty: (x: ScalarTerm) => computeCore.cast(x, target),
			mended: {
				kind: "guarded",
				term: (x: ScalarTerm) =>
					computeCore.when(
						computeCore.matches(x, lexicalForm(descriptor)),
						(y: ScalarTerm) => computeCore.cast(y, target),
						zeroOf(target)
					)
			}
		})
	),
	clock: [clock(testPg.bigint)],
	bounded: [
		{
			operand: testPg.text,
			faulty: (x) => computeCore.utf16Length(x),
			mended: {
				kind: "guarded",
				term: (x) =>
					computeCore.when(
						computeCore.within(computeCore.octetLength(x), 0, regexTextMaxBytes),
						() => computeCore.utf16Length(x),
						0
					)
			}
		}
	]
}

/**
 * Where each kind's plant is lowered: a query's, whose operations are the widest, or a check's for a text's UTF-16
 * units, which only a check, a domain predicate or a generated field reads.
 */
const modeOf: { readonly [K in PreconditionKind]: "query" | "check" } = {
	nonzero: "query",
	nonnegative: "query",
	finite: "query",
	integral: "query",
	fits: "query",
	domain: "query",
	language: "query",
	powerDomain: "query",
	powerRange: "query",
	bucketDomain: "query",
	lexical: "query",
	bounded: "check",
	clock: "query"
}

/**
 * The remedies a refusal names over a value of a carrier: the tests the scalar catalogue writes, a number's facts and
 * bounds, a text's patterns, or none, and a number's fraction digits, which no test bounds, a value of a type of none.
 */
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
			return ["nonzero", "nonnegative", "positive", "isFinite", "within", "integral"]
		case "text":
			return ["matches", "octets", "typed"]
		case "sha256":
		case "bytes":
			return []
		case "variant":
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
			return ["typed"]
	}
}

/** What a case reached: each kind refused with a guard, a text's and an untestable type's guards, a mending admitted. */
export type Feature =
	| `refused for ${PreconditionKind}`
	| "a text operand's guard"
	| "a guard no scalar test writes"
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
