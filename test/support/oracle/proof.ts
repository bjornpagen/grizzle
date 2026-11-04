import { Array as Arr, Option } from "effect"
import type { OperandPremise, Precondition, PreconditionProof } from "#compiler/ir/proof.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { insideRange, ofDigits, refine } from "#compiler/scalar/compute/bounds.ts"
import {
	bucketInRange,
	contractHolds,
	fitRange,
	powerInRange
} from "#compiler/scalar/compute/lower.ts"
import { numericMaxDisplayScale, numericMaxIntegerDigits } from "#compiler/scalar/values/decimal.ts"

/**
 * Whether a proof's premises establish its precondition: the proof kernel, which re-checks the kept proofs a lowering
 * builds (ir/proof.ts PreconditionProof). A fact precondition holds by a premise of that fact on its operand; fits,
 * contract, powerDomain and bucketDomain hold by interval premises the caller's `judge` reads, with the arithmetic
 * scalar/compute/lower.ts writes once for each. A proof no premise of the needed kind supports is no proof.
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
				(m) => m.kind === "fact" && m.fact === p.kind && m.operand === p.operand
			)
		case "fits":
		case "contract":
		case "powerDomain":
		case "bucketDomain":
			return judge(p, proof.premises)
	}
}

/**
 * Whether a node's proof re-derives its precondition from its premises: the proof kernel (checkProof) with each
 * magnitude precondition's arithmetic, the one place it is written (scalar/compute/lower.ts), over the node's type and
 * its first operand's. A contract proof's premises are judged again against the node's own contract when its value's
 * interval is all it has.
 */
export const proofHolds = (
	proof: PreconditionProof,
	node: { readonly type: ScalarType; readonly operand: ScalarType | undefined }
): boolean =>
	checkProof(proof, (precondition, premises) => {
		const interval = (operand: number) =>
			Option.getOrUndefined(
				Arr.findFirst(
					premises,
					(p): p is Extract<OperandPremise, { readonly kind: "interval" }> =>
						p.kind === "interval" && p.operand === operand
				)
			)
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
				const p = interval(0)
				return (
					p !== undefined &&
					node.operand !== undefined &&
					contractHolds(
						node.type,
						node.operand,
						refine(
							ofDigits(numericMaxIntegerDigits, numericMaxDisplayScale, {
								infinite: false,
								nan: false
							}),
							{ kind: "within", low: p.low, high: p.high }
						)
					)
				)
			}
			case "powerDomain": {
				const b = interval(0)
				const e = interval(1)
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
				const lo = interval(1)
				const hi = interval(2)
				const c = interval(3)
				return (
					lo !== undefined &&
					hi !== undefined &&
					c !== undefined &&
					bucketInRange(lo.low, lo.high, hi.low, hi.high, c.low, c.high)
				)
			}
			case "nonzero":
			case "nonnegative":
			case "finite":
				return false
		}
	})
