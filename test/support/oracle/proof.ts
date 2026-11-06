import { Array as Arr, Option } from "effect"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { OpId } from "#compiler/ir/expr.ts"
import type {
	NativeProof,
	OperandPremise,
	OperationProof,
	Precondition,
	PreconditionProof
} from "#compiler/ir/proof.ts"
import {
	baseOf,
	numericMaxFractionDigits,
	numericMaxIntegerDigits,
	type ScalarType
} from "#compiler/ir/scalar.ts"
import {
	insideRange,
	type IntervalPremise,
	ofDigits,
	premiseHas,
	refine
} from "#compiler/scalar/compute/bounds.ts"
import {
	bucketInRange,
	contractHolds,
	fitRange,
	powerInRange
} from "#compiler/scalar/compute/lower.ts"
import { nativeHolds } from "#compiler/scalar/compute/native.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import { formIncludes, lexicalTargetOf } from "#compiler/scalar/lexical.ts"

/**
 * Whether a proof's premises establish its precondition: the proof kernel, which re-checks the kept proofs a lowering
 * builds (ir/proof.ts PreconditionProof). A fact precondition holds by a premise of that fact on its operand, or by an
 * interval premise on it whose every value has the fact (bounds.ts premiseHas); fits, contract, powerDomain and
 * bucketDomain hold by interval premises the caller's `judge` reads, with the arithmetic scalar/compute/lower.ts writes
 * once for each, fits over the values but NaN and the others over intervals that hold no NaN; lexical by a language
 * premise whose language the judge finds inside the target's form again, or a literal it parses. A proof no premise of the
 * needed kind supports is no proof.
 */
const checkProof = (
	proof: PreconditionProof,
	judge: (precondition: Precondition, premises: PreconditionProof["premises"]) => boolean
): boolean => {
	const p = proof.precondition
	switch (p.kind) {
		case "nonzero":
		case "nonnegative":
		case "finite":
			return Arr.some(
				proof.premises,
				(m) =>
					m.operand === p.operand &&
					((m.kind === "fact" && m.fact === p.kind) ||
						(m.kind === "interval" && premiseHas(m, p.kind)))
			)
		case "fits":
		case "contract":
		case "powerDomain":
		case "bucketDomain":
		case "lexical":
			return judge(p, proof.premises)
	}
}

/**
 * Whether a node's proof re-derives its precondition from its premises: the proof kernel (checkProof) with each
 * magnitude precondition's arithmetic, the one place it is written (scalar/compute/lower.ts), over the node's type and
 * its first operand's. A contract proof's premises are judged again against the node's own contract when its value's
 * interval is all it has.
 */
const proofHolds = (
	proof: PreconditionProof,
	node: { readonly type: ScalarType; readonly operand: ScalarType | undefined }
): boolean =>
	checkProof(proof, (precondition, premises) => {
		const interval = (operand: number) =>
			Option.getOrUndefined(
				Arr.findFirst(
					premises,
					(p): p is IntervalPremise => p.kind === "interval" && p.operand === operand
				)
			)
		const finite = (operand: number) => {
			const p = interval(operand)
			return p === undefined || p.nan ? undefined : p
		}
		switch (precondition.kind) {
			case "fits": {
				const p = interval(0)
				const range = fitRange(node.type)
				return (
					p !== undefined && range !== undefined && insideRange(p.low, p.high, range[0], range[1])
				)
			}
			case "contract": {
				if (Arr.some(premises, (p) => p.kind === "checked")) {
					return true
				}
				const p = finite(0)
				return (
					p !== undefined &&
					node.operand !== undefined &&
					contractHolds(
						node.type,
						node.operand,
						refine(
							ofDigits(numericMaxIntegerDigits.value, numericMaxFractionDigits.value, {
								infinite: false,
								nan: false
							}),
							{ kind: "within", low: p.low, high: p.high }
						)
					)
				)
			}
			case "powerDomain": {
				const b = finite(0)
				const e = finite(1)
				const facts = Arr.filter(
					premises,
					(p): p is Extract<OperandPremise, { readonly kind: "fact" }> => p.kind === "fact"
				)
				return (
					b !== undefined &&
					e !== undefined &&
					Arr.some(facts, (p) => p.fact === "nonnegative" && p.operand === 0) &&
					Arr.some(
						facts,
						(p) =>
							(p.fact === "nonzero" && p.operand === 0) ||
							(p.fact === "nonnegative" && p.operand === 1)
					) &&
					powerInRange(b.low, b.high, e.low, e.high, node.type)
				)
			}
			case "bucketDomain": {
				const lo = finite(1)
				const hi = finite(2)
				const c = finite(3)
				return (
					lo !== undefined &&
					hi !== undefined &&
					c !== undefined &&
					bucketInRange(lo.low, lo.high, hi.low, hi.high, c.low, c.high)
				)
			}
			case "lexical": {
				const form = lexicalTargetOf(node.type)
				return (
					form !== undefined &&
					Arr.some(
						premises,
						(p) =>
							p.operand === 0 &&
							((p.kind === "checked" && p.by === "literal") ||
								(p.kind === "language" &&
									formIncludes({ source: p.pattern, flags: p.flags }, form).kind === "included"))
					)
				)
			}
			case "nonzero":
			case "nonnegative":
			case "finite":
				return false
		}
	})

/** Whether two preconditions are one: one kind, on one operand where the kind names one. */
const samePrecondition = (a: Precondition, b: Precondition): boolean =>
	a.kind === b.kind && ("operand" in a && "operand" in b ? a.operand === b.operand : true)

/**
 * Whether an operation's kept proof proves every precondition its overload requires (`required`, the registry's
 * Totality, or a domain cast's contract): one entry per precondition, in its order, none missing and none besides, each
 * re-derived from its own premises (proofHolds). No precondition stands on another's premises.
 */
export const operationProofHolds = (
	proof: OperationProof,
	required: NonEmptyReadonlyArray<Precondition>,
	node: { readonly type: ScalarType; readonly operand: ScalarType | undefined }
): boolean =>
	proof.length === required.length &&
	Arr.every(proof, (p, i) => {
		const precondition = required[i]
		return (
			precondition !== undefined &&
			samePrecondition(p.precondition, precondition) &&
			proofHolds(p, node)
		)
	})

/**
 * Whether a node's native proof re-derives that PostgreSQL's own overload computes its IEEE 754 operation where it
 * stands (ir/proof.ts NativeProof): the node's overload is an IEEE 754 one into a float carrier, and the proof's
 * premises establish it with the arithmetic scalar/compute/native.ts writes once, over the node's type and its first
 * operand's. A native proof on any other overload is no proof.
 */
export const nativeProofHolds = (
	proof: NativeProof,
	node: {
		readonly op: OpId
		readonly type: ScalarType
		readonly operand: ScalarType | undefined
	}
): boolean => {
	const totality = nativeOp(node.op)?.totality
	const carrier = baseOf(node.type).carrier
	return (
		totality?.kind === "ieee" &&
		(carrier === "float4" || carrier === "float8") &&
		node.operand !== undefined &&
		nativeHolds(totality.op, carrier, node.operand, proof.premises)
	)
}
