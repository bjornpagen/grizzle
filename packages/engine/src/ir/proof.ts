import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Patterns } from "#compiler/ir/scalar.ts"

/** An exact decimal, units · 10^-scale with scale ≥ 0: an end of a proved interval, never a host value. */
export interface Exact {
	readonly units: bigint
	readonly scale: number
}

/** An operand's position in an operation's operands, for the precondition and the premise that name it. */
export type OperandIndex = 0 | 1 | 2 | 3

/**
 * What an operation needs of its operands to be defined on them, beyond their types:
 * - `nonzero`: the operand is never zero (a divisor);
 * - `nonnegative`: the operand is never below zero (numeric sqrt's radicand, power's base);
 * - `finite`: the operand is never NaN or an infinity (min_scale, numeric or a float cast to an integer or money,
 *   width_bucket's operands);
 * - `fits`: a cast's value other than NaN fits its target, a narrower carrier or a numeric typmod, once the cast
 *   rounds it; NaN passes a typmod, and a cast that NaN would fail into an integer or money also requires `finite`;
 * - `contract`: the value satisfies the contract a domain cast enters;
 * - `language`: the text a domain cast enters a regex-refined text with lies in the refinement's language;
 * - `powerDomain`: power's base is never below zero, and never zero or its exponent never below zero, the facts a
 *   term's TypeScript type states;
 * - `powerRange`: power's result over those operands stays inside its carrier's range;
 * - `bucketDomain`: width_bucket's bounds differ and its count lies in 1..2147483646;
 * - `lexical`: a text a parse reads is a member of the lexical form `form` names (ParseForm), so the parse reads it
 *   without raising, to the value the form's mapping gives it (scalar/lexical.ts lexicalValue);
 * - `bounded`: a text a regex function reads is at most regexTextMaxBytes UTF-8 bytes (core/limits.ts), the longest
 *   subject PostgreSQL's regex engine widens without refusing its allocation, so the read never raises.
 *
 * nonzero, nonnegative and finite are facts a term's TypeScript type states (Facts), exactly, and powerDomain rests on
 * them; fits, contract, powerRange and bucketDomain rest on numeric bounds no TypeScript type can state, which the
 * lowering's bound domain proves (scalar/compute/bounds.ts); language and lexical rest on the operand's text
 * refinement, whose language the lowering proves included in the target's pattern or form (scalar/regex/inclusion.ts);
 * bounded rests on the operand's byte bound, its type's or a guard's.
 */
export type Precondition =
	| { readonly kind: "nonzero"; readonly operand: OperandIndex }
	| { readonly kind: "nonnegative"; readonly operand: OperandIndex }
	| { readonly kind: "finite"; readonly operand: OperandIndex }
	| { readonly kind: "fits" }
	| { readonly kind: "contract" }
	| { readonly kind: "language" }
	| { readonly kind: "powerDomain" }
	| { readonly kind: "powerRange" }
	| { readonly kind: "bucketDomain" }
	| { readonly kind: "lexical"; readonly form: ParseForm }
	| { readonly kind: "bounded" }

/**
 * The lexical form a parse reads its text by, which its `lexical` precondition names: its target type's own (`target`,
 * scalar/lexical.ts lexicalTargetOf), a Compute.cast's, cut to the values the type holds exactly; every decimal text
 * of a double (`doubleText`), Compute.parseDouble's, whose every member rounds to a double; or every decimal text
 * within the bytes whose every value plain numeric holds (`decimalText`), Compute.parseDecimal's. The registry states
 * it per overload and a proof carries it, so a language proved inside one form never stands for another's
 * precondition: the forms over one type differ, and the proof kernel compares them.
 */
export const parseForms = ["target", "doubleText", "decimalText"] as const
export type ParseForm = (typeof parseForms)[number]

/** A fact about every value of a term that its type states: never zero, never below zero, never NaN or an infinity. */
export type Fact = "nonzero" | "nonnegative" | "finite"

/** Every fact, in the one order a contract's list of them keeps. */
export const factNames = ["finite", "nonnegative", "nonzero"] as const satisfies ReadonlyArray<Fact>

/** Whether a list of facts is in the one order, each once: what a contract's declaration holds. */
export const factsSorted = (facts: ReadonlyArray<Fact>): boolean =>
	facts.every((f, i) => {
		const before = facts[i - 1]
		return before === undefined || before < f
	})

/**
 * Where a fact comes from: a literal's own value; a contract that declares the fact, which its build checked against
 * its predicate; the guard of the Compute.when whose branch the term stands in; or the term's type, which holds no
 * value without it (an integer is finite).
 */
export type FactSource =
	| { readonly kind: "literal" }
	| { readonly kind: "contract"; readonly name: string }
	| { readonly kind: "guard" }
	| { readonly kind: "type" }

/**
 * What a proof rests on: an operand's fact and its source; a closed finite interval every value of the operand but NaN
 * lies in, and whether NaN is among its values, which the bound domain derived from carrier ranges, typmods, a
 * computed numeric's proved bound, contracts' atoms, literals, exact digit bounds, guards and recursion bounds; or
 * an operand whose value is checked against a refinement where it is no read's evaluation: a literal at compile time
 * (ContractLiteral), a parameter at bind, or a written value by the write itself, whose refusal is the write's outcome
 * (README: writes keep their value checks).
 */
export type OperandPremise =
	| {
			readonly kind: "fact"
			readonly operand: OperandIndex
			readonly fact: Fact
			readonly source: FactSource
	  }
	| {
			readonly kind: "interval"
			readonly operand: OperandIndex
			readonly low: Exact
			readonly high: Exact
			readonly nan: boolean
	  }
	| {
			readonly kind: "checked"
			readonly operand: OperandIndex
			readonly by: "literal" | "parameter" | "write"
	  }
	| {
			/**
			 * An operand whose every value is a member of a regex refinement's language, the language of the conjunction
			 * `patterns`, and of at most `bytes` UTF-8 bytes where the refinement bounds them: its type's, or the
			 * refinement a Compute.matches guard gives it inside its branch. A parse's lexical precondition rests on it,
			 * the language included in the form, and a cast's into a refined text, the language included in the target's
			 * and the bytes within its byte bound (str.bytes), which the tests' proof kernel decides again.
			 */
			readonly kind: "language"
			readonly operand: OperandIndex
			readonly patterns: Patterns
			readonly bytes: number | undefined
	  }
	| {
			/**
			 * An operand whose every value is at most `bytes` UTF-8 bytes: a text literal by its own bytes, any other
			 * term by its text refinement's byte bound, a str.bytes bound or a bounded pattern's, or the one the
			 * Compute.within(Compute.octetLength(x), 0, bytes) guard of the Compute.when whose branch it stands in gives
			 * it. A regex function's bounded precondition rests on it, its bytes within regexTextMaxBytes.
			 */
			readonly kind: "octets"
			readonly operand: OperandIndex
			readonly bytes: number
	  }

/** The proof of one precondition: the precondition and the premises it rests on. */
export interface PreconditionProof {
	readonly precondition: Precondition
	readonly premises: NonEmptyReadonlyArray<OperandPremise>
}

/**
 * The kept, checkable proof that a partial operation is defined where it stands: one PreconditionProof per precondition
 * its Totality requires, in its order (a narrowing from numeric proves finite, then fits), each on premises of its own.
 * An expression names a partial operation only with one (ir/expr.ts PartialOp), and the tests' proof kernel
 * (test/support/oracle/proof.ts) re-derives every precondition from its own premises, so a proof is a value that can be
 * verified, never a claim, and no precondition is claimed without one.
 */
export type OperationProof = NonEmptyReadonlyArray<PreconditionProof>

/**
 * The kept, checkable proof that PostgreSQL's own overload computes an IEEE 754 operation's value where it stands (an
 * overload whose Totality is ieee): the premises its operands' values meet, under which the native operation neither
 * overflows, underflows, divides by zero nor takes the root of a negative, so it raises on none of them and its result
 * is IEEE 754's. A node that carries one renders natively, with no guard and no binding
 * (lower/conservative/expr/total.ts ieeeForm); one that carries none renders the guarded IEEE 754 form. The tests'
 * proof kernel (test/support/oracle/proof.ts nativeProofHolds) re-derives it from its premises with the arithmetic
 * scalar/compute/native.ts writes once.
 */
export interface NativeProof {
	readonly premises: NonEmptyReadonlyArray<OperandPremise>
}
