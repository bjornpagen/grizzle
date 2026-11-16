/**
 * A retirable statement at the schema door (schema/statements.ts admitRetirable, schema/own.ts its admission and
 * checkUnits): which units a schema may declare. A unit retires each of its header's groups whole, so its schema must
 * keep every row of a group inside the group's bodies, and keep the header's retirement field its unit's alone.
 *
 * The box: one header, Root, with one retirement field, none or two; Step keyed with or without its group; the unit's
 * bodies, a nonempty set of Step, Claim and Note; a containment of Claim's step into Step carrying the group or crossing
 * it, or none; a containment of Note's step into Step, or none; Root made mutable or not; a key over Root that reads its
 * retirement field or none; and a retirement field on Note, which heads no unit, or none.
 *
 * Oracle: the rules the statement's documentation states, restated over the box: a schema owns exactly when the header
 * has exactly one retirement field and no other relation has one; every body's key holds its group; every containment
 * into a body comes from a body of the unit, carrying the group to the group; the header is immutable; and no other
 * statement reads the retirement field. Features: owned, and each rule broken alone.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { assert } from "#test/support/assert.ts"
import {
	brokenOf,
	declaredGen,
	owns,
	type UnitFeature
} from "#test/unit/schema/retirable.fixtures.ts"

/** A retirable statement at the schema door owns a unit exactly when its rows stay in their groups and its retirement field is its own. */
export const aRetirableStatementAtTheSchemaDoorOwnsAUnitExactlyWhenItsRowsStayInTheirGroupsAndItsRetirementFieldIsItsOwn =
	property.exhaust(finite(declaredGen), {
		needs: {},
		situations: [
			"owned",
			"refused: the header's retirement fields are not one",
			"refused: a relation outside every header holds a retirement field",
			"refused: a body's key lacks its group",
			"refused: a containment into a body comes from outside the unit",
			"refused: a containment into a body crosses the group",
			"refused: the header is mutable",
			"refused: a key reads the retirement field"
		] satisfies ReadonlyArray<Reached<UnitFeature>>,
		check: (_, c: Case<UnitFeature>) => (d) =>
			Effect.sync(() => {
				const broken = brokenOf(d)
				const owned = owns(d)
				assert.equal(
					owned,
					broken.length === 0,
					`${Formatter.format(d)} breaks ${broken.length === 0 ? "nothing" : Arr.join(broken, "; ")}`
				)
				const [only, ...more] = broken
				if (only === undefined) {
					c.note("owned")
				} else if (more.length === 0) {
					c.note(`refused: ${only}`)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the retirable statement's rules restated over the box: one retirement field, the header's; bodies keyed by their group; containments into a body from the unit carrying the group; an immutable header; no other reader of the retirement field"
		},
		box: "Root's retirement fields, none, one or two; Step keyed with or without its group; every nonempty set of Step, Claim and Note as bodies; Claim's step into Step carried, crossed or none; Note's step into Step or none; Root mutable or not; a key reading Root's retirement field or none; a retirement field on Note or none",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/statements.ts",
				original:
					'const isDeclaration = (value: Readonly<Record<string, unknown>>): boolean => {\n\tconst kind = ownedKind(value) ?? value["kind"]\n\treturn kind === "relation" || kind === "closed" || kind === "closedRelation" || kind === "derived"\n}',
				replacement:
					"const isDeclaration = (value: Readonly<Record<string, unknown>>): boolean => { return true }",
				why: 'Operator mutant (boolean-return) at packages/engine/src/schema/statements.ts:119 in isDeclaration: `{\n\tconst kind = ownedKind(value) ?? value["kind"]\n\treturn kind === "relation" ||` becomes `{ return true }`; the property fails (lane CATCH, grizzle 0baff5d6).'
			}
		]
	})
