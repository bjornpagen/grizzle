import { type CompileError, ruleRefused } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { type ClockBinding, isInt8Type } from "#compiler/ir/clock.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"

/**
 * Whether `binding` may bind `name` among `params`: a scalar parameter of the program of an int8 type, bigint or a
 * contract over it, the only type a reading of the clock is; never an undeclared name or a relation parameter.
 */
const bindsReading = (params: ReadonlyArray<ParamDecl>, name: string): boolean => {
	const decl = params.find((p) => p.name === name)
	switch (decl?.kind) {
		case "scalar":
		case "clock":
			return isInt8Type(decl.type)
		case "relation":
		case undefined:
			return false
	}
}

/**
 * `params` with each scalar parameter `binding` names bound to the database's clock in its unit (ParamDecl clock), in
 * their order; or the refusal, at the first name in code point order that binds no reading (bindsReading) under `label`,
 * of the rule the types state of clocked's binding.
 */
export const clockParams = (
	params: ReadonlyArray<ParamDecl>,
	binding: ClockBinding,
	label: string
): Result.Result<ReadonlyArray<ParamDecl>, CompileError> => {
	const unbound = Object.keys(binding)
		.toSorted(compareStrings)
		.find((name) => !bindsReading(params, name))
	if (unbound !== undefined) {
		return Result.err(
			ruleRefused(
				SourceLoc(label, ["clock", unbound]),
				"clocked binds only parameters of the program whose values are bigints: bigint or a contract over it"
			)
		)
	}
	return Result.ok(
		params.map((p): ParamDecl => {
			const unit = Object.hasOwn(binding, p.name) ? binding[p.name] : undefined
			return unit !== undefined && p.kind === "scalar" && isInt8Type(p.type)
				? { id: p.id, name: p.name, kind: "clock", type: p.type, unit }
				: p
		})
	)
}
