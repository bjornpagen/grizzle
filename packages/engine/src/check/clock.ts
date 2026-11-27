import * as Result from "@bjornpagen/grizzle-text/base/result"
import { type CompileError, ruleRefused } from "#compiler/core/errors.ts"
import { ParamId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import {
	type ClockBinding,
	type ClockSource,
	clockInstantName,
	type Int8Type,
	isInt8Type
} from "#compiler/ir/clock.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { ownedLevels } from "#compiler/scalar/contract.ts"
import { plainType } from "#compiler/scalar/native.ts"

/**
 * Whether a parameter's type is one a clock reading binds: an int8 type of at most one consumer's contract
 * (scalar/contract.ts ownedLevels), whose key its member's binding takes, which a contract over another's would not
 * make alone.
 */
const isReadingType = (t: ScalarType): t is Int8Type => isInt8Type(t) && ownedLevels(t) <= 1

/**
 * Whether `binding` may bind `name` among `params`: a scalar parameter of the program of an int8 type, bigint, natural or
 * one consumer's contract over either (isReadingType), the only types a reading of the clock is, which the reading is
 * cast to at bind so the contract judges it there; never an undeclared name or a relation parameter.
 */
const bindsReading = (params: ReadonlyArray<ParamDecl>, name: string): boolean => {
	const decl = params.find((p) => p.name === name)
	switch (decl?.kind) {
		case "scalar":
		case "clock":
			return isReadingType(decl.type)
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
				"clocked binds only parameters of the program whose values are bigints: bigint, natural, or one consumer's contract over either, under its key"
			)
		)
	}
	return Result.ok(
		params.map((p): ParamDecl => {
			const unit = Object.hasOwn(binding, p.name) ? binding[p.name] : undefined
			return unit !== undefined && p.kind === "scalar" && isReadingType(p.type)
				? { id: p.id, name: p.name, kind: "clock", type: p.type, unit }
				: p
		})
	)
}

/**
 * The clock's stated instant: a bigint count of microseconds since the Unix epoch, the parameter every program a moved
 * clock's compile serves that may read the clock declares (sourcedParams), which a Db over a moved clock states at each
 * call, the same in every statement of the call, and which every reading of the clock in the program reads
 * (lower/conservative/context.ts clockReading). PostgreSQL's own resolution, so every unit's reading of it is exact: a
 * reading in microseconds is the stated count itself.
 */
export const clockInstant: Extract<ParamDecl, { readonly kind: "scalar" }> = Object.freeze({
	id: ParamId(clockInstantName),
	name: clockInstantName,
	kind: "scalar",
	type: plainType("int8")
})

/**
 * The declared parameters of a program that may read the clock, compiled under `source`: its own, and under a moved
 * clock the clock's stated instant after them, which its readings read.
 */
export const sourcedParams = (
	params: ReadonlyArray<ParamDecl>,
	source: ClockSource
): ReadonlyArray<ParamDecl> => {
	switch (source.kind) {
		case "transaction":
			return params
		case "moved":
			return [...params, clockInstant]
	}
}
