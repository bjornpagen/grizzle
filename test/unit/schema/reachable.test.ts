/**
 * A reachable statement at its doors (schema/statements.ts admitReachable, schema/own.ts its admission and role
 * admission, write/hold/stated.ts heldUnits): which reachable statements a schema may declare, which roles over one may
 * write, and which ChangeSets over one may retire a holder's unit.
 *
 * The schema door's box: the target, the records at their whole key in order, at it reversed, at a prefix of it, or a
 * plain relation over the same fields; the holders, Ref at the key's fields, Ref selected, at one field, at the digest
 * and pred of the part, named twice, or none; Ref a body of Root's unit or not; the records free, a body of Run's unit,
 * or a second reachable statement's target; a containment into the records' root from Ext, the holder's own restated,
 * or none; and a containment of the records' root in Ext or none. Oracle: the statement's rules restated over the box:
 * the builder refuses a target that is no records' side, a selected holder, a holder of another width than the target,
 * a holder named twice and no holder, each by the refusal it names; ownership refuses, as MalformedDescription, a target
 * that is not the records' whole key in order, a holder reading a pred term or no retirable body, records that are a
 * retirable body or a second statement's target, and a containment into the records from outside them; a schema
 * breaking none owns, a containment out of the records among them.
 *
 * The role door's box: a role over a schema whose records two holders hold, each a body of a unit of its own, whose
 * list writes or only inserts every nonempty set of the two holders and Out. Oracle: a write list naming a holder is
 * refused as RoleRefused writeReachableHolder naming it: its deletion would let a reference go and release nothing; an
 * insert list naming one, and a write list naming none, owns.
 *
 * The ChangeSet door's box: a ChangeSet over that schema that retires a holder's unit (Root's or Batch's), Other's,
 * which holds no records, or none, beside a write of the records' root or of their attachment, a read of their root, a
 * read-back of their root's delta, or a write of Out alone. Oracle: one that retires a holder's unit and touches the
 * records is refused as RetiredUnitTouched naming the relation of the records, the unit's header and how, as a
 * retirement's release is no stratum's to net; one beside Other's retirement or none compiles, but where a delta of the
 * records no member writes refuses otherwise.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { succeeded } from "#test/support/assert.ts"
import {
	answerOf,
	builderBrokenOf,
	type ChangeFeature,
	changeAnswerOf,
	changeGen,
	declaredGen,
	type DoorFeature,
	holdersNamed,
	ownedBrokenOf,
	refusalsOf,
	roleAnswerOf,
	type RoleFeature,
	roleGen,
	touchedOf
} from "#test/unit/schema/reachable.fixtures.ts"

/**
 * A reachable statement is admitted exactly when its target is free records at their whole key in order, each holder
 * is every fact of a retirable body of the target's width, named once, and nothing else contains into the records.
 */
export const aReachableStatementIsAdmittedExactlyWhenItsTargetIsFreeRecordsAtTheirWholeKeyEachHolderARetirableBodyAndNothingElseContainsIntoThem =
	property.exhaust(finite(declaredGen), {
		needs: {},
		situations: [
			"owned",
			"owned: a containment out of the records",
			"refused: the target is no records' side",
			"refused: a holder is selected",
			"refused: a holder's width is not the target's",
			"refused: a holder is named twice",
			"refused: no holder",
			"refused: the target is not the records' whole key in order",
			"refused: a holder reads a pred term",
			"refused: a holder is no retirable body",
			"refused: the records are a retirable body",
			"refused: the records are a second statement's target",
			"refused: a containment into the records comes from outside them"
		] satisfies ReadonlyArray<Reached<DoorFeature>>,
		check: (_, c: Case<DoorFeature>) => (d) =>
			Effect.sync(() => {
				const builder = builderBrokenOf(d)
				const owned = ownedBrokenOf(d)
				const answer = answerOf(d)
				const [onlyBuilder, ...moreBuilder] = builder
				if (onlyBuilder !== undefined) {
					if (answer.ok) {
						return assert.fail(`${Formatter.format(d)} owned, breaking ${Arr.join(builder, "; ")}`)
					}
					const reason = answer.error.reason
					assert.ok(
						reason._tag === "Refused" && refusalsOf(builder).includes(reason.refusal),
						`${Formatter.format(d)} refused by the builder for ${Arr.join(builder, "; ")}, not ${Formatter.format(reason)}`
					)
					if (moreBuilder.length === 0) {
						c.note(`refused: ${onlyBuilder}`)
					}
					return
				}
				const [onlyOwned, ...moreOwned] = owned
				if (onlyOwned !== undefined) {
					if (answer.ok) {
						return assert.fail(`${Formatter.format(d)} owned, breaking ${Arr.join(owned, "; ")}`)
					}
					assert.equal(
						answer.error.reason._tag,
						"MalformedDescription",
						`${Formatter.format(d)} refused by ownership for ${Arr.join(owned, "; ")}`
					)
					if (moreOwned.length === 0) {
						c.note(`refused: ${onlyOwned}`)
					}
					return
				}
				succeeded(answer, `${Formatter.format(d)} breaks no rule`)
				c.note("owned")
				if (d.outward) {
					c.note("owned: a containment out of the records")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the reachable statement's rules restated over the box: a target of free records at their whole key in order; holders each every fact of a retirable body, of the target's width, named once; no containment into the records from outside them"
		},
		box: "the target whole, reversed, a prefix or a plain relation; the holders at the key's fields, selected, at one field, at a pred term, named twice or none; the holder a body of Root's unit or not; the records free, Run's body or a second statement's target; a containment into the records' root from Ext, restated from the holder, or none; a containment of the records' root in Ext or none",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/own.ts",
				original: '\t\t\tif (roles.get(holder.relation)?.kind !== "body") {',
				replacement: '\t\t\tif (roles.get(holder.relation)?.kind === "header") {',
				why: "A holder that is no retirable body owns, so a holder row could go by a ChangeSet's deletion, releasing nothing."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: "\t\t\tif (roles.has(side.relation) || holders.has(side.relation)) {",
				replacement: "\t\t\tif (holders.has(side.relation)) {",
				why: "Records that are a retirable body own beside their reachable statement, two statements removing their rows."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: "\t\t\t\tif (into !== undefined && released.get(st.left.relation) !== into) {",
				replacement: "\t\t\t\tif (into === undefined && released.get(st.left.relation) !== into) {",
				why: "A containment into the records from outside them owns, so a release is refused by its foreign key."
			},
			{
				file: "packages/engine/src/schema/statements.ts",
				original: "\t\tif (side.terms.length !== root.terms.length) {",
				replacement: "\t\tif (side.terms.length < root.terms.length) {",
				why: "A holder wider than the target passes the builder, so a prefix target beside a full holder is refused by ownership, not by the width refusal it names."
			}
		]
	})

/** A role over reachable records is refused exactly where its write list names a holder, by the holder it names. */
export const aRoleOverReachableRecordsIsRefusedExactlyWhereItsWriteListNamesAHolder =
	property.exhaust(finite(roleGen), {
		needs: {},
		situations: [
			"refused: a write list names a holder",
			"owned: a write list names no holder",
			"owned: an insert list names a holder"
		] satisfies ReadonlyArray<Reached<RoleFeature>>,
		check: (_, c: Case<RoleFeature>) => (r) =>
			Effect.sync(() => {
				const answer = roleAnswerOf(r)
				const holders = holdersNamed(r)
				if (r.list === "write" && Arr.isReadonlyArrayNonEmpty(holders)) {
					if (answer.ok) {
						return assert.fail(`a role writing ${Formatter.format(r.names)} owned`)
					}
					const reason = answer.error.reason
					assert.ok(
						reason._tag === "RoleRefused" &&
							reason.rule.kind === "writeReachableHolder" &&
							holders.includes(reason.rule.relation),
						`a role writing ${Formatter.format(r.names)} refused as RoleRefused writeReachableHolder of one of ${Formatter.format(holders)}, not ${Formatter.format(reason)}`
					)
					c.note("refused: a write list names a holder")
					return
				}
				succeeded(
					answer,
					`a role ${r.list === "write" ? "writing" : "inserting"} ${Formatter.format(r.names)}`
				)
				c.note(
					r.list === "write"
						? "owned: a write list names no holder"
						: "owned: an insert list names a holder"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the role rule restated over the box: no write list names a holder of reachable records"
		},
		box: "a write or an insert list, naming every nonempty set of the two holders and Out",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/own.ts",
				original: "\t\t\t\t\tif (targets.has(holder.relation)) {",
				replacement: '\t\t\t\t\tif (targets.has(holder.relation.concat("?"))) {',
				why: "A write list naming a holder owns, so a ChangeSet's deletion of a reference releases nothing."
			}
		]
	})

/**
 * A ChangeSet that retires a holder's unit touches no relation of the records the unit holds: it is refused, naming the
 * relation, the header and how, where any member or read-back writes, reads or reads the delta of one.
 */
export const aChangeSetThatRetiresAHoldersUnitIsRefusedWhereItTouchesTheRecordsTheUnitReleases =
	property.exhaust(finite(changeGen), {
		needs: {},
		situations: [
			"refused: a write of the records' root",
			"refused: a write of the records' attachment",
			"refused: a read of the records",
			"refused: a delta of the records",
			"refused: beside Batch's retirement",
			"compiled: a touch of the records beside Other's retirement",
			"compiled: a touch of the records retiring nothing"
		] satisfies ReadonlyArray<Reached<ChangeFeature>>,
		check: (_, c: Case<ChangeFeature>) => (d) =>
			Effect.sync(() => {
				const touched = touchedOf(d.touch)
				const program = changeAnswerOf(d)
				if ((d.retired === "Root" || d.retired === "Batch") && touched !== undefined) {
					if (program.ok) {
						return assert.fail(`${Formatter.format(d)} compiled, touching ${touched.relation}`)
					}
					const reason = program.error.reason
					assert.ok(
						reason._tag === "RetiredUnitTouched" &&
							reason.relation === touched.relation &&
							reason.header === d.retired &&
							reason.how === touched.how,
						`${Formatter.format(d)} refused as RetiredUnitTouched ${touched.relation} ${touched.how} of ${d.retired}, not ${Formatter.format(reason)}`
					)
					c.note(
						d.touch === "rootWritten"
							? "refused: a write of the records' root"
							: d.touch === "noteWritten"
								? "refused: a write of the records' attachment"
								: d.touch === "rootRead"
									? "refused: a read of the records"
									: "refused: a delta of the records"
					)
					if (d.retired === "Batch") {
						c.note("refused: beside Batch's retirement")
					}
					return
				}
				if (d.touch === "rootDelta" && !program.ok) {
					assert.ok(
						program.error.reason._tag !== "RetiredUnitTouched",
						`${Formatter.format(d)} refused as RetiredUnitTouched, retiring no holder's unit`
					)
					return
				}
				succeeded(program, `${Formatter.format(d)} compiles`)
				if (touched !== undefined) {
					c.note(
						d.retired === "Other"
							? "compiled: a touch of the records beside Other's retirement"
							: "compiled: a touch of the records retiring nothing"
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the retire rule restated over the box: a ChangeSet retiring a unit whose bodies hold reachable records touches no relation of them"
		},
		box: "Root's, Batch's, Other's or no retirement; a write of the records' root or attachment, a read of their root, a read-back of their root's delta, or a write of Out",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/hold/stated.ts",
				original: "\t\t\t\treleasedBy.set(relation, place.unit.header)",
				replacement: '\t\t\t\treleasedBy.set(relation.concat("?"), place.unit.header)',
				why: "A ChangeSet that retires a holder's unit writes or reads the records it releases, its counts a stratum's to net."
			}
		]
	})
