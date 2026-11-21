/** What the properties of live-history.test.ts read: its models and checks. */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { identifierOf } from "#compiler/core/identity.ts"
import { type LiveNames, liveRosters } from "#compiler/deploy/upgrade/history.ts"
import { rosterCodec } from "#compiler/ir/codes.ts"
import { rosterConstants } from "#compiler/physical/ddl/constants.ts"
import { failed, succeeded } from "#test/support/assert.ts"
import {
	type Command,
	live,
	type Model,
	modelsAfter,
	rosterNames,
	rosterOf,
	slotsOf
} from "#test/unit/ir/codes.fixtures.ts"

/**
 * What a history reached, as the live database holds it: a hole, a renamed handle, a live code past a hole (a growth or a
 * re-add after a removal), an unordered roster whose codes run out of its handles' order, and both rosters changed.
 */
export type Situation =
	| "a hole"
	| "a renamed handle"
	| "a live code past a hole"
	| "an unordered roster's codes out of its handles' order"
	| "both rosters changed"

/** The schema the box's installation holds its constants in. */
const schema = "s"

/**
 * The names constant an installation holds of the roster at `index` after `model`: named by the naming door from the
 * codes it holds (physical/ddl/constants.ts rosterConstants), its elements each code's handle in code order, a hole
 * the empty name, as `grizzle upgrade` reads them back (adapter/admission/history.ts readHistory).
 */
const constantOf = (index: 0 | 1, model: Model): LiveNames => {
	const codec = rosterCodec(defined(rosterNames[index]), slotsOf(model))
	return {
		constant: { schema, name: identifierOf(rosterConstants(codec).names) },
		names: codec.names
	}
}

/** An installed constant of names that is no roster's names constant, as another constant returning name[] would be. */
const unrelated: LiveNames = { constant: { schema, name: "__unrelated_names" }, names: ["a", "b"] }

/**
 * The codes read off the live database of the installation a history reached are exactly the history's, for both
 * rosters, whatever the order the constants are read in, beside a constant that is no roster's; a roster whose names
 * constant the database lacks is RosterUnread `none`, and one two schemas hold a names constant of is `several`.
 */
export const recovered = (history: ReadonlyArray<Command>, c: Case<Situation>) =>
	Effect.sync(() => {
		const models = modelsAfter(history)
		const rosters = [rosterOf(0, live(models[0])), rosterOf(1, live(models[1]))]
		const constants = [unrelated, constantOf(1, models[1]), constantOf(0, models[0])]
		const read = succeeded(liveRosters(rosters, constants))
		for (const [index, model] of models.entries()) {
			const closed = defined(rosterNames[index])
			const roster = defined(read[index], `${closed} is read`)
			assert.deepEqual(roster.codec.codes, slotsOf(model), `${closed}'s codes are the history's`)
			assert.deepEqual(roster.fate, { kind: "continued", as: closed }, `${closed} continues itself`)
		}
		assert.deepEqual(
			failed(liveRosters(rosters, [unrelated, constantOf(1, models[1])])),
			{ roster: rosterNames[0], found: "none" },
			"a roster whose names constant the database lacks"
		)
		const twice = constantOf(0, models[0])
		assert.deepEqual(
			failed(
				liveRosters(rosters, [
					twice,
					{ ...twice, constant: { ...twice.constant, schema: `${schema}_1` } },
					constantOf(1, models[1])
				])
			),
			{ roster: rosterNames[0], found: "several" },
			"a roster two schemas hold a names constant of"
		)
		for (const model of models) {
			const holes = Arr.filter(model.slots, (slot) => slot === undefined).length
			if (holes > 0) {
				c.note("a hole")
			}
			if (model.used.size > live(model).length + holes) {
				c.note("a renamed handle")
			}
			if (
				Arr.some(
					model.slots,
					(slot, code) => slot !== undefined && code > 0 && model.slots[code - 1] === undefined
				)
			) {
				c.note("a live code past a hole")
			}
		}
		const unordered = live(models[1])
		if (Arr.some(unordered, (handle, at) => at > 0 && handle < defined(unordered[at - 1]))) {
			c.note("an unordered roster's codes out of its handles' order")
		}
		if (models[0].slots.length > 1 && models[1].slots.length > 1) {
			c.note("both rosters changed")
		}
	})
