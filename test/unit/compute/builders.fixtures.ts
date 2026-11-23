/** What the properties of builders.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { constant, element, type Gen, oneOf } from "@bjornpagen/testing/gen"
import { type Drawn, type DrawnFeature, lsw, WILD_KINDS } from "@bjornpagen/testing/lsw"
import { bigint } from "@bjornpagen/testing/values"
import { Array as Arr, Option } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { int8Max, int8Min } from "#compiler/ir/carriers.ts"
import { baseOf, sameScalarType, type ScalarType } from "#compiler/ir/scalar.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { type ScalarTerm, typedTermOf } from "#compiler/scalar/compute/term.ts"
import { pgDescriptors as descriptors } from "#compiler/scalar/pg.ts"
import {
	decimal,
	param,
	testContract,
	type TestField,
	testPg,
	v
} from "#test/unit/compute/support.ts"

const Cents = testContract("Cents", testPg.bigint, (x) => computeCore.ge(x, 0n))

const EpochDay = testContract("EpochDay", testPg.bigint, undefined)

export const cents = v("cents", Cents)

const plainBigint = v("b", testPg.bigint)

export const int = v("i", testPg.integer)

export const flag = v("flag", testPg.boolean)

/** The type a builder registered for a typed term. */
export const typeOf = (term: unknown): ScalarType => {
	const t = typedTermOf(term)
	if (t === undefined) {
		return assert.fail("a typed term")
	}
	return t.type
}

/** Whether a term is typed, its type exactly the descriptor's. */
export const typedAs = (term: unknown, of: { readonly scalar: ScalarType }): boolean => {
	const t = typedTermOf(term)
	return t !== undefined && sameScalarType(t.type, of.scalar)
}

/** The CompileError `f` throws: one that returns, or throws anything else, fails the test. */
export const throws = (f: () => unknown): CompileError => {
	const caught = catchCompileError(f)
	if (caught.ok) {
		throw new Error("expected a CompileError")
	}
	return caught.error
}

/**
 * The typing rules of the builders (compute/builders.ts, compute/typing.ts), stated over operands of one base, bigint,
 * so no widening between integer types enters: two operands meet only when their nominal types are one (a contract its
 * own contract, a bare base its bare base, computeCore.base the explicit way between them), but for an equality, which
 * meets any two refinements of one base carrier, typed at it (scalar/compute/typing.ts refinedPair); LEAST, GREATEST and a
 * conditional keep that type, a sum is exact, an exact integer one digit past its base's 19, and a comparison is
 * boolean. A conditional is typed by its first branch, a term, never a JavaScript literal or a parameter; the other
 * branch is a term or parameter of that type, or a JavaScript literal of its base's host kind (integer a number, bigint
 * a bigint, numeric a bigint). A span's endpoints are typed by its endpoint descriptor, and its width, the difference of
 * its endpoints, is an exact integer; any other descriptor, or an operand that is no span, is malformed.
 */
type Operand = "cents" | "other cents" | "epoch day" | "bigint" | "based cents"

export const operands: Arr.NonEmptyReadonlyArray<Operand> = [
	"cents",
	"other cents",
	"epoch day",
	"bigint",
	"based cents"
]

export const operandTerms: { readonly [O in Operand]: ScalarTerm } = {
	cents,
	"other cents": v("cents2", Cents),
	"epoch day": v("e", EpochDay),
	bigint: plainBigint,
	"based cents": computeCore.base(cents)
}

export const nominalOf: { readonly [O in Operand]: TestField } = {
	cents: Cents,
	"other cents": Cents,
	"epoch day": EpochDay,
	bigint: testPg.bigint,
	"based cents": testPg.bigint
}

export type BinaryOp = "add" | "eq" | "least" | "greatest"

/** The type a binary builder gives its term, or "predicate" for a comparison, a predicate by construction. */
export const binary: {
	readonly [B in BinaryOp]: (a: ScalarTerm, b: ScalarTerm) => ScalarType | "predicate"
} = {
	add: (a, b) => typeOf(computeCore.add(a, b)),
	eq: (a, b) => {
		computeCore.eq(a, b)
		return "predicate"
	},
	least: (a, b) => typeOf(computeCore.least(a, b)),
	greatest: (a, b) => typeOf(computeCore.greatest(a, b))
}

type FirstBranch =
	| "integer literal"
	| "bigint literal"
	| "numeric literal"
	| "integer column"
	| "cents column"
	| "number"
	| "integer parameter"

type OtherBranch =
	| "number"
	| "bigint"
	| "fraction"
	| "integer parameter"
	| "bigint parameter"
	| "integer column"
	| "cents column"

export const firsts: Arr.NonEmptyReadonlyArray<FirstBranch> = [
	"integer literal",
	"bigint literal",
	"numeric literal",
	"integer column",
	"cents column",
	"number",
	"integer parameter"
]

export const others: Arr.NonEmptyReadonlyArray<OtherBranch> = [
	"number",
	"bigint",
	"fraction",
	"integer parameter",
	"bigint parameter",
	"integer column",
	"cents column"
]

/** A first branch: a term of its type, a parameter of its declared type among them, or a JavaScript literal, which no first branch may be. */
export const firstOf: {
	readonly [F in FirstBranch]: {
		readonly operand: ScalarTerm | number
		readonly term: TestField | undefined
	}
} = {
	"integer literal": { operand: computeCore.literal(testPg.integer, 1), term: testPg.integer },
	"bigint literal": { operand: computeCore.literal(testPg.bigint, 1n), term: testPg.bigint },
	"numeric literal": {
		operand: computeCore.literal(testPg.numeric, decimal("0.5")),
		term: testPg.numeric
	},
	"integer column": { operand: int, term: testPg.integer },
	"cents column": { operand: cents, term: Cents },
	number: { operand: 1, term: undefined },
	"integer parameter": { operand: param("n", testPg.integer), term: testPg.integer }
}

/** The other branch, and the type it meets as a term or parameter, or the host kind it is as a JavaScript literal. */
export const otherOf: {
	readonly [O in OtherBranch]: {
		readonly operand: ScalarTerm | number | bigint
		readonly meets:
			| { readonly kind: "typed"; readonly type: TestField }
			| { readonly kind: "host"; readonly host: "number" | "bigint" | "fraction" }
	}
} = {
	number: { operand: 0, meets: { kind: "host", host: "number" } },
	bigint: { operand: 0n, meets: { kind: "host", host: "bigint" } },
	fraction: { operand: 0.5, meets: { kind: "host", host: "fraction" } },
	"integer parameter": {
		operand: param("d", testPg.integer),
		meets: { kind: "typed", type: testPg.integer }
	},
	"bigint parameter": {
		operand: param("b", testPg.bigint),
		meets: { kind: "typed", type: testPg.bigint }
	},
	"integer column": { operand: int, meets: { kind: "typed", type: testPg.integer } },
	"cents column": { operand: cents, meets: { kind: "typed", type: Cents } }
}

/** The JavaScript host kind a literal adopting each first branch's base must be. */
export const hostKindOf = (t: TestField): "number" | "bigint" =>
	sameScalarType(baseOf(t.scalar), testPg.integer.scalar) ? "number" : "bigint"

export type Endpoint = "cents" | "integer" | "bigint"

export const endpointOf: { readonly [E in Endpoint]: TestField } = {
	cents: Cents,
	integer: testPg.integer,
	bigint: testPg.bigint
}

/** A descriptor other than the span's own endpoint: its bare base, or another integer type. */
export const wrongEndpointOf: { readonly [E in Endpoint]: TestField } = {
	cents: testPg.bigint,
	integer: testPg.bigint,
	bigint: testPg.integer
}

export type SpanFn = "lower" | "upper" | "width"

export type BuilderCase =
	| { readonly kind: "binary"; readonly op: BinaryOp; readonly a: Operand; readonly b: Operand }
	| { readonly kind: "cond"; readonly first: FirstBranch; readonly other: OtherBranch }
	| {
			readonly kind: "span"
			readonly fn: SpanFn
			readonly endpoint: Endpoint
			readonly descriptor: "own" | "other"
			readonly operand: "span" | "no span"
	  }

export type BuilderFeature =
	| `binary ${BinaryOp} ${"typed" | "refused"}`
	| `cond ${"typed" | "refused"}`
	| `span ${SpanFn} ${"typed" | "refused"}`

/**
 * Where a JavaScript caller's value meets the scalar catalogue: a literal's type and a cast's target, read as descriptors
 * (compute/builders.ts describedField), and a literal's value, read by the registry's literal boundary (Call.literal).
 */
type ComputeSite = "literal type" | "cast target" | "literal value"

export type BoundaryFeature = DrawnFeature<never> | `site ${ComputeSite}`

/**
 * A descriptor (live pg.bigint, or wild) at a descriptor site, or a value (a live int8 bigint, or wild) at the literal
 * value.
 */
export const boundaryCaseGen: Gen<readonly [Drawn<unknown, never>, ComputeSite]> = oneOf([
	(source) =>
		[
			source.draw(
				lsw<unknown>({
					live: constant<unknown>(descriptors.bigint),
					stale: Option.none(),
					wild: WILD_KINDS
				})
			),
			source.draw(element<ComputeSite>(["literal type", "cast target"]))
		] as const,
	(source) =>
		[
			source.draw(
				lsw<unknown>({
					live: bigint(int8Min, int8Max),
					stale: Option.none(),
					wild: WILD_KINDS
				})
			),
			"literal value"
		] as const
])
