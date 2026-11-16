/**
 * ChangeSet#deleteWhere (write/changeset/value.ts) is the delete of the query each of its selections is: over the
 * ChangeSet agreement's Work (test/support/agreement/changeset-schema.ts), and over a role that writes a world entry, a
 * ChangeSet begun empty, after a stratum, or with a parameter bound, given one deleteWhere of a record of relations,
 * each key's selection some of the fields its delete's rows state, each equal to a parameter or a literal, compiles to
 * the plan, statement by statement in both realizations, of the same ChangeSet given one delete of each key's query, in
 * any order, `match(R, x).where(eq(x.f, value), …).find(x)` over the rows as a delete names them, or is refused for the
 * same reason. The oracle is the specification: a field-equality member is the query it states, which the write front
 * end makes of it (write/frontend/equal.ts), so the planner holds the two as one thing. A case may plant one fault a
 * JavaScript caller can make, each refused as MalformedDescription: a field its rows do not state, a variable or a
 * Compute term in place of a parameter, a key of a closed relation or of none, a selection that is no record.
 *
 * Features: one key, four keys or more, an empty selection, several fields, a literal, a parameter shared by two keys,
 * a parameter of the bound name, a unit's delete, a tree's root, a world entry's key, a stratum before, another order, a
 * plan compiled, a compile refused, and each fault.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { Work } from "#test/support/agreement/changeset-schema.ts"
import { Wherer } from "#test/support/agreement/delete-where.ts"
import { assert, defined } from "#test/support/assert.ts"
import {
	baseOf,
	caseGen,
	type DeleteWhereFeature,
	faults,
	planOf,
	selectionQueryOf,
	recordOf,
	relationOf
} from "#test/unit/write/changeset/delete-where.fixtures.ts"

/** ChangeSet#deleteWhere is the delete of each selection's query in any order: one plan, or one refusal, and a JavaScript caller's fault refused. */
export const changeSetDeleteWhereIsTheDeleteOfEachSelectionsQueryInAnyOrderOnePlanOrOneRefusalAndAJavaScriptCallersFaultRefused =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"one key",
			"four keys or more",
			"an empty selection",
			"several fields",
			"a literal",
			"a parameter two keys share",
			"a parameter of the bound name",
			"a unit's delete",
			"a tree's root",
			"a world entry's key",
			"a stratum before",
			"deleted in another order",
			"a plan compiled",
			"a compile refused",
			...Arr.map(faults, (f): DeleteWhereFeature => `planted: ${f}`)
		] satisfies ReadonlyArray<Reached<DeleteWhereFeature>>,
		check: (_, c: Case<DeleteWhereFeature>) => (sketch) =>
			Effect.sync(() => {
				const base = baseOf(sketch.base)
				if (sketch.fault !== undefined) {
					c.note(`planted: ${sketch.fault}`)
					const built = catchCompileError(() => base.deleteWhere(recordOf(sketch)))
					const plan = built.ok ? planOf(sketch.base, built.value) : undefined
					assert.equal(
						built.ok
							? plan?.kind === "refused"
								? plan.reason
								: "compiled"
							: built.error.reason._tag,
						"MalformedDescription",
						sketch.fault
					)
					return
				}
				const where = base.deleteWhere(recordOf(sketch))
				const each = Arr.reduce(sketch.order, base, (cs, at) => {
					const key = defined(sketch.keys[at], "a key of the record")
					return cs.delete(
						relationOf(key.name),
						selectionQueryOf(sketch.base === "over the role" ? Wherer : Work, key)
					)
				})
				const plan = planOf(sketch.base, where)
				assert.deepEqual(plan, planOf(sketch.base, each), "one plan")
				c.note(plan.kind === "plan" ? "a plan compiled" : "a compile refused")
				if (sketch.keys.length === 1) {
					c.note("one key")
				}
				if (sketch.keys.length >= 4) {
					c.note("four keys or more")
				}
				const params = Arr.flatMap(sketch.keys, (k) =>
					Arr.flatMap(k.fields, (s) => (s.equaled.kind === "param" ? [s.equaled.name] : []))
				)
				if (params.length > new Set(params).size) {
					c.note("a parameter two keys share")
				}
				for (const k of sketch.keys) {
					if (k.fields.length === 0) {
						c.note("an empty selection")
					}
					if (k.fields.length > 1) {
						c.note("several fields")
					}
					for (const s of k.fields) {
						if (s.equaled.kind === "literal") {
							c.note("a literal")
						}
						if (
							s.equaled.kind === "param" &&
							s.equaled.name === "p" &&
							sketch.base === "a bound parameter"
						) {
							c.note("a parameter of the bound name")
						}
					}
					if (k.name === "Order" || k.name === "Cart" || k.name === "Pool" || k.name === "Bin") {
						c.note("a unit's delete")
					}
					if (k.name === "Node") {
						c.note("a tree's root")
					}
					if (k.name === "Manual") {
						c.note("a world entry's key")
					}
				}
				if (sketch.base === "after a stratum") {
					c.note("a stratum before")
				}
				if (Arr.some(sketch.order, (at, i) => at !== i)) {
					c.note("deleted in another order")
				}
			}),
		oracle: {
			kind: "specification",
			name: "a field-equality member is the query its selection states, so deleteWhere is the deletes of its keys' queries"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/equal.ts",
				original:
					'\t\t\t\t\twhere: names.flatMap((field): ReadonlyArray<ExprDesc> => {\n\t\t\t\t\t\tconst e = fields[field]\n\t\t\t\t\t\treturn e === undefined\n\t\t\t\t\t\t\t? []\n\t\t\t\t\t\t\t: [{ kind: "compare", op: "eq", left: variable(field), right: operand(e) }]\n\t\t\t\t\t}),',
				replacement:
					'\t\t\t\t\twhere: names\n\t\t\t\t\t\t.flatMap((field): ReadonlyArray<ExprDesc> => {\n\t\t\t\t\t\t\tconst e = fields[field]\n\t\t\t\t\t\t\treturn e === undefined\n\t\t\t\t\t\t\t\t? []\n\t\t\t\t\t\t\t\t: [{ kind: "compare", op: "eq", left: variable(field), right: operand(e) }]\n\t\t\t\t\t\t})\n\t\t\t\t\t\t.slice(0, 1),',
				why: "The front end keeps a field-equality member's first equality alone (write/frontend/equal.ts equalQuery), so a selection of several fields deletes the rows its first field selects."
			}
		]
	})
