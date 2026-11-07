/**
 * Every precondition kind's refusal names a guard its operand's type can write (core/errors.ts GuardTest), over an
 * exhaustive box of planted faults: each kind's partial operation, over a column of each operand type the registry
 * admits for it, with its precondition left unproved.
 *
 * The oracle: the refusal is PartialOperation of exactly the planted kind; its guard's test is one Compute writes over
 * the operand's type (a number's Compute.nonzero, Compute.nonnegative, Compute.positive, Compute.isFinite or
 * Compute.within; a text's Compute.matches or a bound on its bytes; over any other type no Compute test, a value of the
 * target's own type); and, where that guard alone
 * proves the precondition, the term with the named guard written around it, or its operand a parameter of the target's
 * type, is admitted. Everything is read off the error's fields, never its prose.
 *
 * Planted bug: a contract's guard is Compute.within whatever its operand's type, and the text and boolean contract
 * casts fail.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import type { GuardTest, PreconditionKind } from "#compiler/core/errors.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import type { Carrier } from "#compiler/ir/scalar.ts"
import { pg } from "#compiler/public/fields.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import type { ScalarTerm } from "#compiler/scalar/compute/term.ts"
import { lexicalFormOf } from "#compiler/scalar/lexical.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	baseParams,
	lowerWith,
	param,
	spelledExpr,
	type TestField,
	type TestOperand,
	testContract,
	testPg,
	v
} from "#test/unit/compute/support.ts"

const kinds: Arr.NonEmptyReadonlyArray<PreconditionKind> = [
	"nonzero",
	"nonnegative",
	"finite",
	"fits",
	"contract",
	"language",
	"powerDomain",
	"powerRange",
	"bucketDomain",
	"lexical"
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
const plants: { readonly [K in PreconditionKind]: Arr.NonEmptyReadonlyArray<Plant> } = {
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
						Compute.matches(x, "^[a-z]+$"),
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
						Compute.matches(x, lexicalFormOf(descriptor)),
						(y: ScalarTerm) => Compute.cast(y, target),
						zeroOf(target)
					)
			}
		})
	)
}

/** The tests Compute writes over a value of a carrier: a number's facts and bounds, a text's patterns, or none. */
const writable = (carrier: Carrier): ReadonlyArray<GuardTest["kind"]> => {
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
type Feature =
	| `refused for ${PreconditionKind}`
	| "a text operand's guard"
	| "a guard no Compute test writes"
	| "a named guard, written, admitted"

const lowered = (expr: { readonly expr: OpenExpr }, operand: TestOperand) =>
	lowerWith(
		"query",
		spelledExpr(expr.expr),
		{ x: { kind: "column", type: operand.scalar } },
		false,
		baseParams
	)

/** The widest list of plants, which bounds the box's operand picks. */
const widest = Arr.reduce(Rec.values(plants), 0, (n, list) => Math.max(n, list.length))

describe("a partial operation's refusal", () => {
	it.effect(
		"names its precondition and a guard its operand's type writes, which, written, admits the operation",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						suite: "unit/compute/guards",
						oracle: {
							kind: "specification",
							name: "the planted precondition and the guards Compute writes over its operand's type"
						},
						generator: (source) =>
							[source.draw(element(kinds)), source.draw(int(0, widest - 1))] as const,
						literal: Formatter.format,
						limit: kinds.length * widest,
						coverage: requiredInSpace<Feature>([
							...Arr.map(kinds, (k): Feature => `refused for ${k}`),
							"a text operand's guard",
							"a guard no Compute test writes",
							"a named guard, written, admitted"
						]),
						caseHang
					},
					([kind, pick], c) =>
						Effect.sync(() => {
							const list = plants[kind]
							const plant = defined(list[pick % list.length], "a plant of the kind")
							const x = v("x", plant.operand)
							const faulty = lowered(plant.faulty(x), plant.operand)
							if (faulty.ok) {
								return assert.fail(`the unguarded ${kind} operation is refused`)
							}
							const reason = faulty.error.reason
							if (reason._tag !== "PartialOperation") {
								return assert.fail(
									`the unguarded ${kind} operation is PartialOperation, not ${reason._tag}`
								)
							}
							assert.equal(reason.precondition, kind)
							const carrier = plant.operand.scalar.carrier
							assert.ok(
								Arr.contains(writable(carrier), reason.guard.remedy.kind),
								`a ${reason.guard.remedy.kind} guard is one Compute writes over a ${carrier}`
							)
							c.note(`refused for ${kind}`)
							if (carrier === "text") {
								c.note("a text operand's guard")
							}
							if (reason.guard.remedy.kind === "typed") {
								c.note("a guard no Compute test writes")
							}
							const mended = plant.mended
							switch (mended.kind) {
								case "guarded": {
									const admitted = lowered(mended.term(x), plant.operand)
									assert.ok(admitted.ok, `the ${kind} operation under its named guard is admitted`)
									c.note("a named guard, written, admitted")
									return
								}
								case "typed": {
									assert.equal(reason.guard.remedy.kind, "typed")
									const admitted = lowered(mended.term(), plant.operand)
									assert.ok(admitted.ok, `the ${kind} operation over a typed parameter is admitted`)
									c.note("a named guard, written, admitted")
									return
								}
								case "beyond one guard":
									return
							}
						})
				)
			)
	)
})
