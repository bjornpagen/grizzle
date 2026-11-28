/** What variable-types.test.ts reads: its schema, its boxes, and the types each case's read delivers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import type { OracleTemplate } from "#test/support/conservative.ts"

/**
 * The refinements a learner's id is held at: as a ledger keys it, 69 bytes of any text (metis's LearnerId); as a
 * person's, 255 characters (metis's Timeback user), which a LearnerId always is; and two that neither holds the other's
 * values of, letters of one kind and of another.
 */
const refinements = {
	learner: str.bytes(69, str.regex("^.+$", "su")),
	person: str.bytes(1020, str.regex("^.{1,255}$", "su")),
	lower: str.bytes(16, str.regex("^[a-m]+$", "u")),
	upper: str.bytes(16, str.regex("^[h-z]+$", "u"))
} as const

export type Refinement = keyof typeof refinements

/** A relation holding a learner's id at each refinement, keyed by a number and the id. */
const holders = {
	learner: relation("LearnerHeld", { n: int8, child: refinements.learner }, ["n", "child"]),
	person: relation("PersonHeld", { n: int8, child: refinements.person }, ["n", "child"]),
	lower: relation("LowerHeld", { n: int8, child: refinements.lower }, ["n", "child"]),
	upper: relation("UpperHeld", { n: int8, child: refinements.upper }, ["n", "child"])
} as const

const Held = schema(
	"VariableTypes",
	[holders.learner, holders.person, holders.lower, holders.upper],
	[]
)

/** The type a read of one holder's id delivers: its column's own. */
const deliveredBy = (holder: Refinement): ScalarType => {
	const read = query(Held).rule((r) => {
		const { child } = v(holders[holder], "held")
		return r.match(holders[holder], { n: r.param("n", int8), child }).find({ child })
	})
	return deliveredChild(
		succeeded(compileTemplate(read, undefined, testCompile), "the read compiles")
	)
}

/** The type of the `child` column a compiled read's root delivers. */
const deliveredChild = (template: OracleTemplate): ScalarType =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst(template.programs.checked.dag.roots[0].heading, (c) => c.name === "child")
		),
		"the read delivers its child"
	).type

/** A pair of holders one variable binds, and the order the rule matches them in. */
export interface BindingCase {
	readonly first: Refinement
	readonly second: Refinement
}

export const bindingCaseGen: Gen<BindingCase> = element<BindingCase>([
	{ first: "learner", second: "person" },
	{ first: "person", second: "learner" },
	{ first: "learner", second: "learner" },
	{ first: "lower", second: "upper" },
	{ first: "upper", second: "lower" }
])

export type BindingFeature =
	| "the narrower first"
	| "the wider first"
	| "one refinement"
	| "incomparable"

/** A case's feature: which order it binds its variable in, or that neither refinement holds the other. */
export const bindingFeature = (c: BindingCase): BindingFeature =>
	c.first === c.second
		? "one refinement"
		: c.first === "lower" || c.first === "upper"
			? "incomparable"
			: c.first === "learner"
				? "the narrower first"
				: "the wider first"

/**
 * What a read binding one variable to both holders' ids delivers, matched in the case's order: the variable's type,
 * or the refusal of a variable no one of whose columns' types guarantees the others'.
 */
export const boundOf = (c: BindingCase): Result.Result<ScalarType, CompileError> => {
	const read = query(Held).rule((r) => {
		const { child } = v(holders[c.first], "first")
		return r
			.match(holders[c.first], { n: r.param("n", int8), child })
			.match(holders[c.second], { n: r.param("n", int8), child })
			.find({ child })
	})
	return Result.map(compileTemplate(read, undefined, testCompile), deliveredChild)
}

/** The type a case's variable must take: the narrower holder's, a learner's id, which every person's id holder holds. */
export const narrowestOf = (c: BindingCase): ScalarType =>
	deliveredBy(c.first === "person" || c.second === "person" ? "learner" : c.first)

/** A relation parameter's declared refinement and the refinement the query bound to it delivers. */
export interface ParamCase {
	readonly declared: Refinement
	readonly delivered: Refinement
}

export const paramCaseGen: Gen<ParamCase> = element<ParamCase>(
	Arr.flatMap(["learner", "person"] as const, (declared) =>
		Arr.map(["learner", "person"] as const, (delivered) => ({ declared, delivered }))
	)
)

export type ParamFeature = "one refinement" | "a narrower one delivered" | "a wider one delivered"

export const paramFeature = (c: ParamCase): ParamFeature =>
	c.declared === c.delivered
		? "one refinement"
		: c.delivered === "learner"
			? "a narrower one delivered"
			: "a wider one delivered"

/**
 * What a read of a relation parameter of the declared refinement delivers, bound to a query of the delivered
 * refinement's holder: the parameter's id at its declared type, or the refusal of a binding whose query delivers values
 * the declared type does not hold.
 */
export const paramOf = (c: ParamCase): Result.Result<ScalarType, CompileError> => {
	const held = query(Held).rule((r) => {
		const { child } = v(holders[c.delivered], "held")
		return r.match(holders[c.delivered], { n: 1n, child }).find({ child })
	})
	const sittings = query(Held).rule((r) => {
		const given = r.relation("sittings", { child: refinements[c.declared] })
		const { child } = v(given, "sitting")
		return r.match(given, { child }).find({ child })
	})
	const read = query(Held).rule((r) => {
		const bound = sittings.bind({ sittings: held })
		const { child } = v(bound, "bound")
		return r.match(bound, { child }).find({ child })
	})
	return Result.map(compileTemplate(read, undefined, testCompile), deliveredChild)
}

/** The declared refinement's own type, which the parameter's rows take. */
export const declaredTypeOf = (c: ParamCase): ScalarType => deliveredBy(c.declared)
