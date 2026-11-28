/**
 * A set states its roster at every door a set enters: Bit.of(R, handles) over one of two rosters whose handles share
 * names, entered at a field over either roster as a scalar literal, a comparison's operand, a closed relation's fact
 * (schema/literal.ts) and the codec a parameter or a written fact is encoded by (codec/scalar.ts), beside a plain Set of
 * the same names, which states no roster.
 *
 * The oracle: every door admits the set exactly when it states the field's own roster or none and every handle is one
 * the field's roster holds, a literal's refusal MalformedDescription and the codec's the fault bitsMember or bitsType;
 * an admitted literal holds exactly its handles, in the field roster's order, and the codec encodes the set as it
 * encodes a plain Set of the same handles.
 *
 * Features: each door admitting and refusing, and a set of another roster whose names the field holds.
 */

import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { rosterOf } from "#compiler/ir/scalar.ts"
import { Bit, bit } from "#compiler/public/fields.ts"
import { closed } from "#compiler/public/schema.ts"
import { describeFieldOrThrow } from "#compiler/scalar/registry.ts"
import {
	type Door,
	doorVerdict,
	type Feature,
	handlesOf,
	type Maker,
	names,
	picked
} from "#test/unit/compute/roster-set.fixtures.ts"

/** A set over a roster is admitted at a field exactly when it states that field's roster or none, at every door. */
export const aSetOverARosterIsAdmittedAtAFieldExactlyWhenItStatesThatFieldsRosterOrNoneAtEveryDoor =
	property.exhaust(
		finite((source) => ({
			alpha: source.draw(int(1, 7)),
			beta: source.draw(int(1, 7)),
			maker: source.draw(element<Maker>(["Alpha", "Beta", "a plain Set"])),
			members: source.draw(int(0, 7)),
			field: source.draw(element<"Alpha" | "Beta">(["Alpha", "Beta"])),
			door: source.draw(
				element<Door>([
					"a scalar literal",
					"a comparison's operand",
					"a closed relation's fact",
					"the codec"
				])
			)
		})),
		{
			needs: {},
			situations: [
				"a scalar literal admitted",
				"a scalar literal refused",
				"a comparison's operand admitted",
				"a comparison's operand refused",
				"a closed relation's fact admitted",
				"a closed relation's fact refused",
				"the codec admitted",
				"the codec refused",
				"a set of another roster whose names the field holds"
			] satisfies ReadonlyArray<Reached<Feature>>,
			check: (_, k: Case<Feature>) => (c) =>
				Effect.gen(function* () {
					const rosters = {
						Alpha: closed.ordered("Alpha", handlesOf(c.alpha)),
						Beta: closed.ordered("Beta", handlesOf(c.beta))
					}
					const made = c.maker === "a plain Set" ? undefined : rosters[c.maker]
					const pool = made === undefined ? names : made.handles
					const members = Arr.filter(picked(c.members), (h) => pool.includes(h))
					const set: ReadonlySet<string> =
						made === undefined ? new Set(members) : Bit.of(made, members)
					const field = bit(rosters[c.field])
					const described = describeFieldOrThrow(field, SourceLoc("the set's field", []))
					const roster = defined(rosterOf(described.scalar), "a set field's roster")
					const held = Arr.every(members, (h) => roster.handles.includes(h))
					const expected = (c.maker === "a plain Set" || c.maker === c.field) && held
					const verdict = yield* doorVerdict(c.door, field, set, members)
					assert.equal(verdict.kind, expected ? "admitted" : "refused", Formatter.format(c))
					if (verdict.kind === "admitted" && verdict.handles !== undefined) {
						assert.deepEqual(
							verdict.handles,
							Arr.filter(roster.handles, (h) => members.includes(h))
						)
					}
					k.note(`${c.door} ${verdict.kind}`)
					if (c.maker !== "a plain Set" && c.maker !== c.field && held && isNonEmpty(members)) {
						k.note("a set of another roster whose names the field holds")
					}
				}),
			oracle: {
				kind: "specification",
				name: "a set states its roster, or none, at every door"
			},
			box: "two rosters over three names, every maker and pick of a set, at a field over either, at every door",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/values/identity.ts",
					original:
						'\tconst stated = statedRoster(value)\n\tif (stated !== undefined && stated !== roster.roster) {\n\t\treturn Result.err("bitsMember")\n\t}\n',
					replacement: "",
					why: 'The codec\'s door reads a set\'s handles alone, its stated roster unchecked, so Bit.of(Alpha, ["low"]) at a field over Beta is admitted where Beta holds "low"; the door property fails at the codec.'
				}
			]
		}
	)
