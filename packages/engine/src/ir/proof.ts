import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"

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
 * - `contract`: the value satisfies the contract or regex refinement a domain cast enters;
 * - `powerDomain`: power's result stays inside its carrier's range;
 * - `bucketDomain`: width_bucket's bounds differ and its count lies in 1..2147483646.
 *
 * nonzero, nonnegative and finite are facts a term's TypeScript type states (Facts), exactly; the other four rest on
 * numeric bounds no TypeScript type can state, which the lowering's bound domain proves (scalar/compute/bounds.ts).
 */
export type Precondition =
	| { readonly kind: "nonzero"; readonly operand: OperandIndex }
	| { readonly kind: "nonnegative"; readonly operand: OperandIndex }
	| { readonly kind: "finite"; readonly operand: OperandIndex }
	| { readonly kind: "fits" }
	| { readonly kind: "contract" }
	| { readonly kind: "powerDomain" }
	| { readonly kind: "bucketDomain" }

/** A fact about every value of a term that its type states: never zero, never below zero, never NaN or an infinity. */
export type Fact = "nonzero" | "nonnegative" | "finite"

/** Every fact, in the one order a contract's list of them keeps. */
export const factNames = ["finite", "nonnegative", "nonzero"] as const satisfies ReadonlyArray<Fact>

/** Whether a list of facts is in the one order, each once: what a contract's declaration holds. */
export const factsSorted = (facts: ReadonlyArray<Fact>): boolean =>
	facts.every((f, i) => i === 0 || (facts[i - 1] ?? f) < f)

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
 * lies in, and whether NaN is among its values, which the bound domain derived from carrier ranges, typmods, the
 * 1,000-digit bound of a bare numeric, contracts' atoms, literals, exact digit bounds, guards and recursion bounds; or
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
