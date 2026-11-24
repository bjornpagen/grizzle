/** What the properties of total.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { type Aimed, aimed, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { CompileError, CompileReasonTag } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import type { CompareOp, ExprDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { contractPredicateTable } from "#compiler/scalar/compute/total.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { referencePatterns } from "#test/support/oracle/reference/evaluate.ts"
import {
	baseParams,
	lowerWith,
	scalarOfDesc,
	testContract,
	type TestField,
	testPg
} from "#test/unit/compute/support.ts"

/**
 * A contract predicate is lowered in the "check" mode, which differs from the "query" mode only in what it reads and
 * admits (scalar/compute/lower.ts): it reads only the domain's VALUE, refusing a parameter (Refused, "a schema predicate
 * reads no parameter") and a variable (MalformedDescription); its operations are those the host evaluates for the
 * ContractLiteral check, so it refuses round (UnsupportedOperation); and it refuses float and money arithmetic, which no CHECK holds
 * (UnsupportedOperation). Every other verdict, an admission, a PartialOperation for an unproved precondition, a
 * ResourceBound past numeric's digits, a MalformedDescription for an ill-typed term, is the query mode's: the oracle
 * is the same predicate lowered in the query mode over a column of the base.
 */

const options = Object.freeze({
	loc: SourceLoc("test", []),
	fieldType: (d: Parameters<typeof scalarOfDesc>[0]) => Result.ok(scalarOfDesc(d)),
	patterns: referencePatterns()
})

/** The bases a contract's VALUE is drawn of: the integers, numeric at a typmod and at the widest, a float and money. */
type Base = "bigint" | "integer" | "numeric" | "wide" | "double" | "money"

const bases: Arr.NonEmptyReadonlyArray<Base> = [
	"bigint",
	"integer",
	"numeric",
	"wide",
	"double",
	"money"
]

const fieldOf = (b: Base): TestField => {
	switch (b) {
		case "bigint":
			return testPg.bigint
		case "integer":
			return testPg.integer
		case "numeric":
			return testPg.numericOf(10, 2)
		case "wide":
			return testPg.numeric
		case "double":
			return testPg.double
		case "money":
			return testPg.money
	}
}

/** Whether a base's arithmetic no CHECK holds: IEEE 754 float, and money read through its STABLE cast. */
export const lossy = (b: Base): boolean => b === "double" || b === "money"

/**
 * The literals a base's terms draw: zero and nonzero values, the decimal zeros, a divisor near numeric's least scale
 * and a factor near its most digits, the values the totality proofs and the digit bound branch on.
 */
const literalsOf = (b: Base): Arr.NonEmptyReadonlyArray<LiteralDesc> => {
	switch (b) {
		case "bigint":
			return [0n, 1n, -3n, 7n]
		case "integer":
			return [0, 1, -3, 7]
		case "numeric":
		case "wide":
			return ["0", "0.0", "0.00", "2.5", "-1", "1e-16383", "1e131071"]
		case "double":
			return [0, 1.5, -2]
		case "money":
			return [Money.of(0n), Money.of(150n)]
	}
}

type Binary = "add" | "sub" | "mul" | "div" | "mod" | "least" | "greatest"

type Unary = "neg" | "abs" | "sign" | "round"

/**
 * A term over the domain's VALUE: VALUE, a literal, an operation, a narrowing cast to integer, or a conditional; an
 * operation over VALUE itself often, which a check's refusals and the totality proofs read.
 */
type Term =
	| { readonly kind: "value" }
	| { readonly kind: "literal"; readonly value: LiteralDesc }
	| { readonly kind: "binary"; readonly fn: Binary; readonly left: Term; readonly right: Term }
	| { readonly kind: "unary"; readonly fn: Unary; readonly arg: Term }
	| { readonly kind: "cast"; readonly arg: Term }
	| {
			readonly kind: "cond"
			readonly op: "lt" | "eq"
			readonly left: Term
			readonly whenTrue: Term
			readonly whenFalse: Term
	  }

const termGen = (b: Base, depth: number): Gen<Term> => {
	const leaf: Gen<Term> = weighted<Term>([
		[3, element([{ kind: "value" } as const])],
		[2, (source) => ({ kind: "literal", value: source.draw(element(literalsOf(b))) })]
	])
	if (depth === 0) {
		return leaf
	}
	const inner = termGen(b, depth - 1)
	const value: Term = { kind: "value" }
	return weighted<Term>([
		[3, leaf],
		[
			2,
			(source) => ({
				kind: "binary",
				fn: source.draw(element(["add", "mul", "div", "mod"] as const)),
				left: value,
				right: source.draw(leaf)
			})
		],
		[
			1,
			(source) => ({
				kind: "unary",
				fn: source.draw(element(["abs", "sign", "neg", "round"] as const)),
				arg: value
			})
		],
		[
			3,
			(source) => ({
				kind: "binary",
				fn: source.draw(element(["add", "sub", "mul", "div", "mod", "least", "greatest"] as const)),
				left: source.draw(inner),
				right: source.draw(inner)
			})
		],
		[
			2,
			(source) => ({
				kind: "unary",
				fn: source.draw(element(["neg", "abs", "sign", "round"] as const)),
				arg: source.draw(inner)
			})
		],
		[1, (source) => ({ kind: "cast", arg: source.draw(inner) })],
		[
			1,
			(source) => ({
				kind: "cond",
				op: source.draw(element(["lt", "eq"] as const)),
				left: source.draw(inner),
				whenTrue: source.draw(inner),
				whenFalse: source.draw(inner)
			})
		]
	])
}

/** What the predicate reads where a contract's reads VALUE: VALUE itself, a parameter, or a variable. */
type Read = "value" | "parameter" | "variable"

/** A predicate: a term of the base compared with a literal, reading VALUE or, as a fault, something else. */
interface PredicateCase {
	readonly base: Base
	readonly op: CompareOp
	readonly left: Term
	readonly right: LiteralDesc
	readonly read: Read
}

const compareOps: Arr.NonEmptyReadonlyArray<CompareOp> = ["lt", "le", "eq", "ne", "gt", "ge"]

const predicateGen: Gen<PredicateCase> = (source) => {
	const base = source.draw(element(bases))
	return {
		base,
		op: source.draw(element(compareOps)),
		left: source.draw(termGen(base, 2)),
		right: source.draw(element(literalsOf(base))),
		read: source.draw(
			weighted<Read>([
				[8, element(["value"] as const)],
				[1, element(["parameter", "variable"] as const)]
			])
		)
	}
}

/** The bases every CHECK holds the arithmetic of, so both modes judge a division alike. */
type ExactBase = Exclude<Base, "double" | "money">

const exactBases: Arr.NonEmptyReadonlyArray<ExactBase> = ["bigint", "integer", "numeric", "wide"]

/** The zeros among an exact base's literals (literalsOf). */
const zerosOf = (b: ExactBase): Arr.NonEmptyReadonlyArray<LiteralDesc> => {
	switch (b) {
		case "bigint":
			return [0n]
		case "integer":
			return [0]
		case "numeric":
		case "wide":
			return ["0", "0.0", "0.00"]
	}
}

/** VALUE read by a predicate over `base` that compares `left` with a literal of the base. */
const valuePredicate =
	(base: Base, left: Gen<Term>): Gen<PredicateCase> =>
	(source) => ({
		base,
		op: source.draw(element(compareOps)),
		left: source.draw(left),
		right: source.draw(element(literalsOf(base))),
		read: "value"
	})

/** VALUE divided by, or taken modulo, a zero of an exact base: a PartialOperation both modes refuse alike. */
const zeroDivisorGen: Gen<PredicateCase> = (source) => {
	const base = source.draw(element(exactBases))
	return source.draw(
		valuePredicate(base, (inner) => ({
			kind: "binary",
			fn: inner.draw(element(["div", "mod"] as const)),
			left: { kind: "value" },
			right: { kind: "literal", value: inner.draw(element(zerosOf(base))) }
		}))
	)
}

/**
 * VALUE of a numeric times a factor one digit short of numeric's most: a product past them over operands each proved
 * within them, a ResourceBound both modes refuse alike. A factor of numeric's most digits is bounded by numeric's own
 * limit alone, whose product PostgreSQL holds to it (scalar/values/fault.ts resultDigits).
 */
const resourceBoundGen: Gen<PredicateCase> = (source) =>
	source.draw(
		valuePredicate(source.draw(element(["numeric", "wide"] as const)), () => ({
			kind: "binary",
			fn: "mul",
			left: { kind: "value" },
			right: { kind: "literal", value: "1e131070" }
		}))
	)

/**
 * The predicates, aimed at the verdicts a drawn term reaches about one case in a hundred: a zero divisor, and a product
 * past numeric's digits.
 */
export const predicateSpace: Aimed<PredicateCase, FragmentFeature> = aimed(predicateGen, [
	["a zero divisor refused", zeroDivisorGen],
	["agreed: ResourceBound", resourceBoundGen]
])

const literalExpr = (value: LiteralDesc): ExprDesc => ({ kind: "literal", value })

/** A term with VALUE rendered as `leaf`. */
const render = (t: Term, leaf: ExprDesc): ExprDesc => {
	switch (t.kind) {
		case "value":
			return leaf
		case "literal":
			return literalExpr(t.value)
		case "binary":
			return { kind: "compute", fn: t.fn, args: [render(t.left, leaf), render(t.right, leaf)] }
		case "unary":
			return t.fn === "round"
				? { kind: "compute", fn: "round", args: [render(t.arg, leaf)], scale: undefined }
				: { kind: "compute", fn: t.fn, args: [render(t.arg, leaf)] }
		case "cast":
			return { kind: "cast", to: testPg.integer.desc, arg: render(t.arg, leaf) }
		case "cond":
			return {
				kind: "cond",
				pred: {
					kind: "compare",
					op: t.op,
					left: render(t.left, leaf),
					right: render(t.whenTrue, leaf)
				},
				onTrue: render(t.whenTrue, leaf),
				onFalse: render(t.whenFalse, leaf)
			}
	}
}

const predicateOf = (c: PredicateCase, leaf: ExprDesc): ExprDesc => ({
	kind: "compare",
	op: c.op,
	left: render(c.left, leaf),
	right: literalExpr(c.right)
})

/** The contract predicate table of the case, its VALUE read as the case reads it. */
export const checkMode = (c: PredicateCase) => {
	const base = fieldOf(c.base)
	const leaf: ExprDesc =
		c.read === "value"
			? { kind: "value" }
			: c.read === "parameter"
				? { kind: "param", name: "p", type: base.desc }
				: { kind: "var", var: "y" }
	return contractPredicateTable(predicateOf(c, leaf), base.scalar, "Test", [], options)
}

/** The same predicate in the query mode, VALUE a column of the base. */
export const queryMode = (c: PredicateCase) =>
	lowerWith(
		"query",
		predicateOf(c, { kind: "var", var: "x" }),
		{ x: { kind: "column", type: fieldOf(c.base).scalar } },
		true,
		baseParams
	)

/** Whether a term holds an operation, round, or arithmetic, or arithmetic reading VALUE directly, anywhere in it. */
export const holds = (t: Term, at: (node: Term) => boolean): boolean => {
	if (at(t)) {
		return true
	}
	switch (t.kind) {
		case "value":
		case "literal":
			return false
		case "binary":
			return holds(t.left, at) || holds(t.right, at)
		case "unary":
		case "cast":
			return holds(t.arg, at)
		case "cond":
			return holds(t.left, at) || holds(t.whenTrue, at) || holds(t.whenFalse, at)
	}
}

export const isRound = (t: Term): boolean => t.kind === "unary" && t.fn === "round"

export const isArithmetic = (t: Term): boolean =>
	t.kind === "binary" && t.fn !== "least" && t.fn !== "greatest"

export const isValueArithmetic = (t: Term): boolean =>
	isArithmetic(t) && t.kind === "binary" && (t.left.kind === "value" || t.right.kind === "value")

const isZeroDivisor = (t: Term): boolean =>
	t.kind === "binary" &&
	(t.fn === "div" || t.fn === "mod") &&
	t.right.kind === "literal" &&
	(t.right.value === 0 ||
		t.right.value === 0n ||
		t.right.value === "0" ||
		t.right.value === "0.0" ||
		t.right.value === "0.00")

/** A mode's verdict: admitted, or its refusal's tag, a named refusal by its message (core/refusals.ts). */
export type Verdict = "admitted" | Exclude<CompileReasonTag, "Refused"> | `Refused:${Refused}`

export type FragmentFeature =
	| "agreed: admitted"
	| "agreed: PartialOperation"
	| "agreed: ResourceBound"
	| "agreed: MalformedDescription"
	| "a zero divisor refused"
	| "a conditional admitted"
	| "least admitted"
	| "greatest admitted"
	| "abs and sign of a float admitted"
	| "round refused in a check"
	| "float arithmetic refused in a check"
	| "money arithmetic refused in a check"
	| "a parameter refused in a check"
	| "a variable refused in a check"

/** The case's features: the verdicts the modes agree on, and what the check mode alone refuses. */
export const featuresOf = (
	c: PredicateCase,
	check: Verdict,
	query: Verdict
): ReadonlyArray<FragmentFeature> => {
	const t = c.left
	const both = check === query ? query : "differ"
	return [
		...(c.read === "value" && both === "admitted" ? ["agreed: admitted" as const] : []),
		...(c.read === "value" && both === "PartialOperation"
			? ["agreed: PartialOperation" as const]
			: []),
		...(c.read === "value" && both === "ResourceBound" ? ["agreed: ResourceBound" as const] : []),
		...(c.read === "value" && both === "MalformedDescription"
			? ["agreed: MalformedDescription" as const]
			: []),
		...(both === "PartialOperation" && holds(t, isZeroDivisor)
			? ["a zero divisor refused" as const]
			: []),
		...(both === "admitted" && holds(t, (x) => x.kind === "cond")
			? ["a conditional admitted" as const]
			: []),
		...(both === "admitted" && holds(t, (x) => x.kind === "binary" && x.fn === "least")
			? ["least admitted" as const]
			: []),
		...(both === "admitted" && holds(t, (x) => x.kind === "binary" && x.fn === "greatest")
			? ["greatest admitted" as const]
			: []),
		...(both === "admitted" &&
		c.base === "double" &&
		holds(t, (x) => x.kind === "unary" && (x.fn === "abs" || x.fn === "sign"))
			? ["abs and sign of a float admitted" as const]
			: []),
		...(query === "admitted" && check === "UnsupportedOperation" && holds(t, isRound)
			? ["round refused in a check" as const]
			: []),
		...(query === "admitted" &&
		check === "UnsupportedOperation" &&
		c.base === "double" &&
		holds(t, isValueArithmetic)
			? ["float arithmetic refused in a check" as const]
			: []),
		...(query === "admitted" &&
		check === "UnsupportedOperation" &&
		c.base === "money" &&
		holds(t, isValueArithmetic)
			? ["money arithmetic refused in a check" as const]
			: []),
		...(c.read === "parameter" && query === "admitted"
			? ["a parameter refused in a check" as const]
			: []),
		...(c.read === "variable" && query === "admitted"
			? ["a variable refused in a check" as const]
			: [])
	]
}

export const verdictOf = (r: Result.Result<unknown, CompileError>): Verdict =>
	r.ok
		? "admitted"
		: r.error.reason._tag === "Refused"
			? `Refused:${r.error.reason.refusal}`
			: r.error.reason._tag

export const Cents = testContract("Cents", testPg.bigint, (x) => computeCore.ge(x, 0n))
