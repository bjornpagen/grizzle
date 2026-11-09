import { unsupported } from "#compiler/core/errors.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { Spelled } from "#compiler/ir/desc.ts"
import type { OpId } from "#compiler/ir/expr.ts"
import type { Precondition } from "#compiler/ir/proof.ts"
import type { LowerExtension } from "#compiler/scalar/compute/lower.ts"
import { binaryCoercion, nativeOp } from "#compiler/scalar/compute/registry.ts"

/** No package lowers a predicate of its own here: r.allen, r.pointIn and r.not are refused. */
export const noExtension: LowerExtension<Spelled> = (desc, loc) =>
	Result.err(
		unsupported(loc, `${desc.kind}: lowered by its own package, not the Compute catalogue`)
	)

/**
 * Where an overload an expression names is defined: everywhere, the binary coercion, every range-polymorphic operator
 * the IR holds (definedRangeOp) and a listed overload or cast whose Totality is total, exact or ieee; partially, a listed
 * one whose Totality requires preconditions, each of which its node's proof proves (ir/proof.ts OperationProof); or
 * unknown, an identity the registry does not hold (scalar/compute/registry.ts nativeOp).
 */
export const definedness = (
	op: OpId
):
	| { readonly kind: "everywhere" }
	| { readonly kind: "partial"; readonly preconditions: NonEmptyReadonlyArray<Precondition> }
	| { readonly kind: "unknown" } => {
	if (op === binaryCoercion) {
		return { kind: "everywhere" }
	}
	const native = nativeOp(op)
	if (native !== undefined) {
		return native.totality.kind === "requires"
			? { kind: "partial", preconditions: native.totality.preconditions }
			: { kind: "everywhere" }
	}
	return typeof op === "string" ? { kind: "unknown" } : { kind: "everywhere" }
}
