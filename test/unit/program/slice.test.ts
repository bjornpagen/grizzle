/**
 * Condition three of scoped entries: a program over a role's base runs on a role holding relations scoped only where it
 * means, over the owner's rows, what it means over every row kept to the owner's (program/slice.ts). Over drawn programs
 * of one rule over metis's sitting (slice.fixtures.ts), each with its one read, a plain read, a negation, a count or a
 * take, over drawn databases and sessions: every program the role admits answers over the owner's rows exactly what the
 * model of row by row answers, and every program built pinned is admitted. A program refused is OutsideRole crossOwner
 * for the role, naming a scoped relation it reads and the read.
 *
 * Oracle: the specification, row by row as the model states it (slice.fixtures.ts expected), against the program's
 * answer over the slice (roleAnswer).
 *
 * Features: an admitted plain read, an admitted and a refused negation, count and take, and a pinned program admitted.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Equal, HashSet, Order } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { programSchema } from "#compiler/program/schema.ts"
import {
	expected,
	programDesc,
	roleAnswer,
	type SliceCase,
	sliceSpace,
	type SliceFeature,
	slicesInput,
	studentRole
} from "#test/unit/program/slice.fixtures.ts"

/** A role holding relations scoped runs a program over its base only where the program reads them row by row. */
export const aRoleHoldingRelationsScopedRunsAProgramOverItsBaseOnlyWhereItReadsThemRowByRow =
	property.explore(sliceSpace, {
		needs: {},
		situations: [
			"an admitted plain read",
			"an admitted negation",
			"a refused negation",
			"an admitted count",
			"a refused count",
			"an admitted take",
			"a refused take",
			"a pinned program admitted",
			"a cross-owner negation refused",
			"a cross-owner count refused",
			"a cross-owner take refused"
		] satisfies ReadonlyArray<Reached<SliceFeature>>,
		check: (_, cx: Case<SliceFeature>) => (c: SliceCase) =>
			Effect.sync(() => {
				const query = programDesc(c.program)
				const held = programSchema(
					slicesInput,
					studentRole,
					{ kind: "query", query },
					SourceLoc("slice case", [])
				)
				const read = c.program.read.kind
				if (!held.ok) {
					const reason = held.error.reason
					assert.ok(
						reason._tag === "OutsideRole" && reason.access.kind === "crossOwner",
						`a refused program is OutsideRole crossOwner: ${held.error.message}`
					)
					assert.ok(!c.program.pinned, `a pinned program is admitted: ${held.error.message}`)
					if (read !== "plain") {
						cx.note(`a refused ${read}`)
						const crosses = !Equal.equals(
							HashSet.fromIterable(roleAnswer(c)),
							HashSet.fromIterable(expected(c))
						)
						if (crosses) {
							cx.note(`a cross-owner ${read} refused`)
						}
					}
					return
				}
				if (c.program.pinned) {
					cx.note("a pinned program admitted")
				}
				cx.note(read === "plain" ? "an admitted plain read" : `an admitted ${read}`)
				assert.deepEqual(
					Arr.sort([...roleAnswer(c)], Order.String),
					Arr.sort([...expected(c)], Order.String),
					"the role's answer over the owner's rows is the program's answer over every row kept to the owner's"
				)
			}),
		oracle: {
			kind: "specification",
			name: "row by row: the owner's part of the program's answer over every row"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/slice.ts",
				original:
					'\t\tconst grouped = Object.values(rule.head).some((h) => h.kind === "aggregate")',
				replacement: "\t\tconst grouped = false",
				why: "A count over a group whose rows may be several owners' is admitted; over a group mixing owners the role counts the owner's rows alone, where row by row keeps no such group."
			},
			{
				file: "packages/engine/src/program/slice.ts",
				original: '\t\t\t\tif (n.kind === "opaque" || !established.has(pinKey(n.pin))) {',
				replacement: '\t\t\t\tif (n.kind === "opaque") {',
				why: "A negation at rows no positive match pins is admitted; another owner's row it would meet is absent over the slice, so the role keeps an answer row by row refuses."
			},
			{
				file: "packages/engine/src/program/slice.ts",
				original: '\t\t\t\tthis.#fixedThroughout(rows, "take")',
				replacement: "\t\t\t\tvoid rows",
				why: "A take over rows of several owners is admitted; the role takes the owner's first rows, where row by row keeps the owner's among the whole answer's first."
			}
		]
	})
