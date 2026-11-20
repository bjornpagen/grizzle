/**
 * What a level may state about the levels below it, against the rule restated as the oracle: a process over a lower
 * level holds none of the code above it, so a level reaches a lower ordinary relation only as one side of a containment
 * whose other side is its own, the lower side's terms fields with no span, every fact or a selection, into a side holding
 * a key the target relation declares (a foreign key PostgreSQL judges, its selected terms generated columns it computes;
 * test/unit/laws/lowered-rules draws the superkeys and constants, test/pg/levels the writes), or as a row check over it,
 * the level's own CHECK on the lower table (test/pg/levels/level-checks), and never by a key, `mutable`, `race` or a
 * family.
 *
 * The box is every statement of a drawn space stated at the upper level `Up` over `Lo`: a key, a check, `mutable`,
 * `race` and a counted family over a lower and an upper relation; and every containment from one of four sources (an upper field
 * or a lower candidate key, every fact or a selection) into one of eight targets (the upper primary key, or the lower
 * primary key, candidate key or a field no key holds, every fact or a selection that fixes no field). Each is owned,
 * and refused with LevelRefused, naming the lower relation it reaches and both levels, exactly where the oracle refuses
 * it: a containment between two lower relations, or into a lower field no key holds; every other statement owns, a
 * selected lower side among them, its law columns generated columns PostgreSQL computes on the lower table.
 * An admitted statement's levels each install in the PostgreSQL schema their own declared name converts to.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { conversionOf, identifierOf } from "#compiler/core/identity.ts"
import {
	ownedUp,
	levelRefusedAt,
	shapeGen,
	shapeText,
	type Situation,
	statementOf
} from "#test/unit/schema/levels.fixtures.ts"

/** A level's laws over the levels below it reach a lower relation only by a containment of fields, selected or not, into a key or a row check, every other reach LevelRefused. */
export const aLevelsLawsOverTheLevelsBelowItReachALowerRelationOnlyByAContainmentOfFieldsSelectedOrNotIntoAKeyOrARowCheckEveryOtherReachLevelRefused =
	property.exhaust(finite(shapeGen), {
		needs: {},
		situations: [
			"admitted",
			"refused",
			"a lower source admitted",
			"a lower target admitted",
			"a lower check admitted",
			"a selected lower source admitted",
			"a lower source into a selected target admitted",
			"a lower target selected beyond constants admitted"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (shape) =>
			Effect.sync(() => {
				const owned = ownedUp(statementOf(shape))
				const expected = levelRefusedAt(shape)
				if (expected === undefined) {
					assert.equal(owned.ok, true, `${shapeText(shape)} owns`)
					if (owned.ok) {
						assert.deepEqual<ReadonlyArray<string>>(
							Arr.map(owned.value.levels, (l) => identifierOf(l.installation)),
							[conversionOf("Lo"), conversionOf("Up")],
							"each level installs in the schema its own name converts to"
						)
					}
					c.note("admitted")
					if (shape.kind === "contained" && shape.source.place === "lower") {
						c.note("a lower source admitted")
						if (shape.source.selected) {
							c.note("a selected lower source admitted")
						}
						if (shape.target.selected) {
							c.note("a lower source into a selected target admitted")
						}
					}
					if (shape.kind === "contained" && shape.target.place === "lower") {
						c.note("a lower target admitted")
						if (shape.target.selected) {
							c.note("a lower target selected beyond constants admitted")
						}
					}
					if (shape.kind === "check" && shape.place === "lower") {
						c.note("a lower check admitted")
					}
					return
				}
				assert.equal(owned.ok, false, `${shapeText(shape)} is refused`)
				if (owned.ok) {
					return
				}
				const reason = owned.error.reason
				assert.equal(reason._tag, "LevelRefused", shapeText(shape))
				if (reason._tag === "LevelRefused") {
					assert.equal(reason.relation, expected)
					assert.equal(reason.level, "Up")
					assert.equal(reason.below, "Lo")
				}
				c.note("refused")
			}),
		oracle: {
			kind: "second-implementation",
			name: "the rule of what a level may state below it, restated per shape"
		},
		box: "a key, a check, mutable and a counted family over each level; every containment of four sources into eight targets",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/own.ts",
				original: "\t\t\tfor (const relation of relations) {",
				replacement: "\t\t\tfor (const relation of relations.slice(1)) {",
				why: "A statement reaching one lower relation admitted (schema/own.ts checkLevels reads past its first relation)."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: '\t\t\tcase "check":\n\t\t\t\treturn',
				replacement: '\t\t\tcase "check":\n\t\t\t\treturn reach([d.relation])\n',
				why: "A row check over a lower relation refused as LevelRefused."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: "(target !== undefined || !fieldSide(d.left, source) || !keyed)",
				replacement:
					"(target !== undefined || d.left.selection.conjuncts.length > 0 || !fieldSide(d.left, source) || !keyed)",
				why: "A selected lower source refused as LevelRefused, as it was before a level could select a lower side."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: "(target !== undefined || !fieldSide(d.left, source) || !keyed)",
				replacement: "(!fieldSide(d.left, source) || !keyed)",
				why: "A containment between two lower relations admitted, its foreign key ordering the lower level's own statements."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: "if (target !== undefined && !keyed) {",
				replacement:
					"if (target !== undefined && (d.right.selection.conjuncts.length > 0 || !keyed)) {",
				why: "A lower target selected beyond constants refused as LevelRefused."
			}
		]
	})
