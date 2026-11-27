/**
 * A role's scope (schema/scope.ts ownerOf, schema/world.ts admitRole, schema/own.ts ownRole): every owner it lists reads
 * the role's contexts, and from them tables at a prefix of one of their keys, each a table the role holds whole; its
 * head is one unit's heading, each field bound at the unit's type; and the role binds each unit by one owner. The box:
 * one owner of each way it keeps the rules (a sign-in at its key, a coach's grants at a key prefix, a claim naming the
 * child itself) and one breaking each rule (scope.fixtures.ts scopeForms). Each case builds the role and owns it.
 *
 * Oracle: the rules restated per form (scope.fixtures.ts verdictOf): an admitted owner's role owns, and a broken one is
 * refused by its rule, ScopeRefused naming it, or OutsideRole naming the access.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Result } from "effect"
import { CompileError } from "#compiler/core/errors.ts"
import { ownRole } from "#compiler/schema/own.ts"
import { roleDescOf } from "#compiler/schema/world.ts"
import {
	roleOf,
	type ScopeForm,
	scopeFormGen,
	verdictOf
} from "#test/unit/schema/scope.fixtures.ts"

/** The refusal a form's role meets where it is built or owned, or none where it owns. */
const refusalOf = (form: ScopeForm): CompileError | undefined => {
	const built = Result.try({ try: () => roleOf(form), catch: (e) => e })
	if (Result.isFailure(built)) {
		return built.failure instanceof CompileError ? built.failure : undefined
	}
	const desc = roleDescOf(built.success)
	if (desc === undefined) {
		return assert.fail(`${form}: role(...) builds a role's Description`)
	}
	const owned = ownRole(desc)
	return owned.ok ? undefined : owned.error
}

/** A role's scope admits exactly the owners its rules admit, each refused one by the rule it breaks. */
export const aRolesScopeAdmitsExactlyTheOwnersItsRulesAdmit = property.exhaust(
	finite(scopeFormGen),
	{
		needs: {},
		situations: [
			"admitted",
			"refused: owner",
			"refused: unit",
			"refused: unitType",
			"refused: twice",
			"refused: outside the role"
		] satisfies ReadonlyArray<
			Reached<
				| "admitted"
				| "refused: owner"
				| "refused: unit"
				| "refused: unitType"
				| "refused: twice"
				| "refused: outside the role"
			>
		>,
		check:
			(
				_,
				c: Case<
					| "admitted"
					| "refused: owner"
					| "refused: unit"
					| "refused: unitType"
					| "refused: twice"
					| "refused: outside the role"
				>
			) =>
			(form) =>
				Effect.sync(() => {
					const verdict = verdictOf(form)
					const refusal = refusalOf(form)
					switch (verdict.kind) {
						case "admitted":
							assert.ok(
								refusal === undefined,
								`${form}: its role owns; it is refused ${refusal?.reason._tag}`
							)
							c.note("admitted")
							return
						case "scope": {
							const reason = refusal?.reason
							if (reason?._tag !== "ScopeRefused") {
								return assert.fail(`${form}: ScopeRefused, not ${reason?._tag ?? "admitted"}`)
							}
							const rule =
								reason.rule.kind === "owner" ? `owner ${reason.rule.why}` : reason.rule.kind
							assert.equal(rule, verdict.rule, `${form}: refused by its rule`)
							c.note(
								reason.rule.kind === "owner"
									? "refused: owner"
									: reason.rule.kind === "unit"
										? "refused: unit"
										: reason.rule.kind === "unitType"
											? "refused: unitType"
											: "refused: twice"
							)
							return
						}
						case "outsideRole": {
							const reason = refusal?.reason
							if (reason?._tag !== "OutsideRole") {
								return assert.fail(`${form}: OutsideRole, not ${reason?._tag ?? "admitted"}`)
							}
							assert.equal(reason.access.kind, verdict.access, `${form}: refused for its access`)
							c.note("refused: outside the role")
							return
						}
					}
				}),
		oracle: {
			kind: "specification",
			name: "the scope's rules restated per form: an owner of the role's contexts, keyed from them, of one unit's heading, read from tables the role holds whole, one a unit"
		},
		box: "an owner of each admitted form (a sign-in at its key, a grant at a key prefix, a claim naming the child) and one breaking each rule",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/scope.ts",
				original:
					'\t\tif (!arm.matches.some((m) => m.source.kind === "context")) {\n\t\t\treturn broken("noContext")\n\t\t}\n',
				replacement: "",
				why: "An owner reading no context is admitted: its rows are no session's own, the same keys for every session."
			},
			{
				file: "packages/engine/src/schema/scope.ts",
				original: "\t\t\treturn first !== undefined && settled(p.match.bindings[first])",
				replacement: "\t\t\treturn first !== undefined",
				why: "An owner reading a table at no key prefix the contexts bind is admitted: a coach's grants read at the child alone are every coach's."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original:
					"\t\t\t\treturn bound === undefined || keyed === undefined || !compatible(bound, keyed)",
				replacement: "\t\t\t\treturn bound === undefined || keyed === undefined",
				why: "An owner whose head holds another type than the unit keys by is admitted: its keys are no unit's."
			},
			{
				file: "packages/engine/src/schema/scope.ts",
				original: "\t\tif (owners.some((o) => o.unit === owner.value.unit)) {",
				replacement:
					"\t\tif (owners.some((o) => o.unit === owner.value.unit && o.unit !== o.unit)) {",
				why: "Two owners of one unit are admitted, the unit bound twice."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: '\t\t\tif (relations[read]?.kind !== "whole") {',
				replacement: '\t\t\tif (relations[read]?.kind === "never") {',
				why: "An owner reading a table the role holds through a query entry is admitted: its statements would read a table the role holds no SELECT on."
			}
		]
	}
)
