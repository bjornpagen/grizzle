/** What the properties of fields.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { array, boolean, constant, type Gen, int, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	fieldSketchGen,
	type PgMember,
	type SketchedField
} from "#test/unit/schema/field-sketch.ts"

/** A relation of drawn fields: each roster's handle count, and its fields' types, each contract named by its field. */
interface DeclaredCase {
	readonly rosters: Arr.NonEmptyReadonlyArray<number>
	readonly fields: Arr.NonEmptyReadonlyArray<SketchedField>
}

export const handlesOf = (count: number): Arr.NonEmptyReadonlyArray<string> =>
	Arr.prepend(
		Arr.map(
			upTo(count - 1, (i) => i + 1),
			(h) => `h${h}`
		),
		"h0"
	)

export const declaredGen: Gen<DeclaredCase> = (source) => {
	const rosters = nonEmpty(source.draw(array(int(1, 3), { min: 1, max: 2 })), "the rosters")
	const fields = nonEmpty(
		source.draw(array(fieldSketchGen(rosters.length, constant("C")), { min: 1, max: 4 })),
		"the fields"
	)
	return {
		rosters,
		fields: Arr.map(fields, (f, i): SketchedField =>
			f.kind === "contract" ? { ...f, name: `C${i}` } : f
		)
	}
}

/**
 * A declared field's kind, a `pg` member's by its member: each member is a descriptor of its own, which its own arm of
 * declaredDescOf gives back, so a case of one member reaches no other's.
 */
export type DeclaredFeature = `kind ${Exclude<SketchedField["kind"], "pg">}` | `pg ${PgMember}`

/** Contracts over bigint, each checked or not, the ones a relation declares, and the one a derived field is cast to. */
interface ContractCase {
	readonly contracts: ReadonlyArray<boolean>
	readonly declared: ReadonlyArray<number>
	readonly target: number
}

/** A contract predicate VALUE >= 0, as Logic.ge records it. */
export const nonNegative: OpenExpr = {
	kind: "compare",
	op: "ge",
	left: { kind: "value" },
	right: { kind: "literal", value: 0n }
}

export const contractCaseGen: Gen<ContractCase> = (source) => {
	const contracts = source.draw(array(boolean, { min: 1, max: 3 }))
	return {
		contracts,
		declared: source.draw(subarray(upTo(contracts.length, (i) => i))),
		target: source.draw(int(0, contracts.length - 1))
	}
}
