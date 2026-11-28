/**
 * ChangeSet#insertAll (write/changeset/value.ts) is the inserts of its keys: over the ChangeSet agreement's Work
 * (test/support/agreement/changeset-schema.ts), and over a role that writes a world entry, a ChangeSet begun empty,
 * after a stratum, or with a parameter bound, given one insertAll of a record of relations, each key's members an
 * array or a query, has the Description, the inputs and the bound values of the same ChangeSet given one
 * insert of each key's members in any order; so it compiles to the same plan, statement by statement, or is refused
 * for the same reason. The oracle is the specification: inserts within one stratum are one set.
 *
 * Features: one key, four keys or more, a query member, a nested member, a world entry's key, a
 * stratum before, a bound parameter yielding, another order, a plan compiled, a compile refused.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { parsedOf } from "#test/support/unit/write/changeset/fixtures.ts"
import {
	baseOf,
	caseGen,
	inputsOf,
	type InsertAllFeature,
	membersOf,
	planOf,
	relationOf,
	textOf
} from "#test/unit/write/changeset/insert-all.fixtures.ts"

/**
 * ChangeSet#insertAll is the inserts of its keys in any order: one Description, the same inputs and values, and one
 * plan.
 *
 * Budget: 200 runs and 400 steered cases, what its suite stated before it became a property
 * (test/unit/write/changeset/insert-all.test.ts:279 at 8cad5bce, its runs and its coverage's cases).
 */
export const changeSetInsertAllIsTheInsertsOfItsKeysInAnyOrderOneDescriptionTheSameInputsAndValuesAndOnePlan =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 200, steered: 400 },
		situations: [
			"one key",
			"four keys or more",
			"a query member",
			"a nested member",
			"a world entry's key",
			"a stratum before",
			"a bound parameter yielding",
			"inserted in another order",
			"a plan compiled",
			"a compile refused"
		] satisfies ReadonlyArray<Reached<InsertAllFeature>>,
		check: (_, c: Case<InsertAllFeature>) => (sketch) =>
			Effect.sync(() => {
				const members = Arr.map(sketch.keys, (k) => [k.name, membersOf(k)] as const)
				const base = baseOf(sketch.base)
				const all = base.insertAll(Rec.fromEntries(members))
				const each = Arr.reduce(sketch.order, base, (cs, at) => {
					const [name, facts] = defined(members[at], "a key of the record")
					return cs.insert(relationOf(name), facts)
				})
				assert.equal(textOf(all), textOf(each), "one Description")
				assert.deepEqual(inputsOf(all), inputsOf(each), "the same inputs, by slot")
				assert.deepEqual(
					[...parsedOf(all).values],
					[...parsedOf(each).values],
					"the same bound values"
				)
				const plan = planOf(sketch.base, all)
				assert.deepEqual(plan, planOf(sketch.base, each), "one plan")
				c.note(plan.kind === "plan" ? "a plan compiled" : "a compile refused")
				if (sketch.keys.length === 1) {
					c.note("one key")
				}
				if (sketch.keys.length >= 4) {
					c.note("four keys or more")
				}
				for (const k of sketch.keys) {
					if (k.travel === "query") {
						c.note("a query member")
						if (sketch.base === "a bound parameter") {
							c.note("a bound parameter yielding")
						}
					}
					if (k.name === "Order" || k.name === "Node") {
						c.note("a nested member")
					}
					if (k.name === "Manual") {
						c.note("a world entry's key")
					}
				}
				if (sketch.base === "after a stratum") {
					c.note("a stratum before")
				}
				if (Arr.some(sketch.order, (at, i) => at !== i)) {
					c.note("inserted in another order")
				}
			}),
		oracle: {
			kind: "specification",
			name: "a stratum's inserts are one set, so insertAll is its keys' inserts in any order"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/changeset/value.ts",
				original:
					'\tconst scope = recordEntries(rows, label, "a record of members by relation name").reduce<Scope>(',
				replacement:
					'\tconst scope = recordEntries(rows, label, "a record of members by relation name").slice(0, -1).reduce<Scope>(',
				why: "insertAll inserts every key of its record but the last (write/changeset/value.ts addInserts)."
			}
		]
	})
