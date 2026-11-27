/**
 * Every carrier a write program makes states the rank its rows are bounded at (write/carriers/carriers.ts WriteCarrier
 * `bound`, CarrierBound; lower/optimize/cte-policy rowsBound): `key`, `unit` or `held` where a key or unit the call
 * fixes or the call's own rows bound them, and an unbounded rank where they grow with the store. A carrier holds its
 * rows whole in its transaction's settings, at most 1 GB a column, so the stated rank is what bounds a call's residue.
 *
 * The box, exhausted: a ChangeSet that marks the items of `target`, a relation parameter bound to the unmarked items,
 * then, sequenced after the marks, logs them, so the log reads `target` past the marks it depends on and the program
 * carries it (write/frontend/compile.ts `agrees`); `target` reads one item (its key), one child's items (its unit) or
 * every item; and the call reads back the marks it added after the log, their delta carried there, or nothing.
 *
 * Property, per case: the target's carrier states `key` for one item, `unit` for one child's and an unbounded rank
 * (prefix, cross or none) for every item; every delta carrier states `held`, the call's own rows. Oracle:
 * specification, the rank each reach binds. Kill: every carrier stated `held`, whatever its rows.
 *
 * Features: each reach and read-back; a delta carried.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { changeSetDesc } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { checking, owning } from "#test/support/policy.ts"
import {
	type BoundCase,
	boundGen,
	Bounded,
	changeOf,
	expectedBound
} from "#test/unit/write/carrier-bound.fixtures.ts"

type Feature =
	| `reaches ${BoundCase["reach"]}`
	| `reads back ${BoundCase["read"]}`
	| "a delta carried"

const owned = owning(Bounded)
const checked = checking(Bounded)
const names = succeeded(
	compileInstallation(owned, {
		...installOptions(owned),
		levels: [identity.schema(parsedSchemaName("CarrierBound"))]
	})
).names
const artifacts = succeeded(testArtifacts(Bounded, testCompile))

/** Every carrier states the rank its rows are bounded at: a key's, a unit's, the call's own, or an unbounded one. */
export const everyCarrierStatesTheRankItsRowsAreBoundedAt = property.exhaust(finite(boundGen), {
	needs: {},
	situations: [
		"reaches one item",
		"reaches one child's items",
		"reaches every item",
		"reads back no read-back",
		"reads back the marks it added",
		"a delta carried"
	] satisfies ReadonlyArray<Feature>,
	check: (_, k: Case<Feature>) => (c) =>
		Effect.sync(() => {
			k.note(`reaches ${c.reach}`)
			k.note(`reads back ${c.read}`)
			const compiled = compileWrite(checked, defined(changeSetDesc(changeOf(c)), "a ChangeSet"), {
				names,
				reads: names,
				claims: { kind: "every" },
				world: { kind: "reality" },
				laws: artifacts.laws,
				derived: artifacts.derived,
				level: "serializable",
				clock: noClock,
				source: transactionClock
			})
			const program = succeeded(compiled)
			const bound = Arr.map([...program.plan.bound.values()], (carrier) => carrier.bound)
			const expected = expectedBound(c.reach)
			assert.ok(
				bound.length === 1 &&
					(expected === "unbounded"
						? bound[0] === "prefix" || bound[0] === "cross" || bound[0] === "none"
						: bound[0] === expected),
				`the target's one carrier states ${expected}, not ${Arr.join(bound, ", ")}`
			)
			const deltas = Arr.filter(
				program.plan.carriers,
				(carrier) => !Arr.some([...program.plan.bound.values()], (b) => b.name === carrier.name)
			)
			assert.ok(
				Arr.every(deltas, (carrier) => carrier.bound === "held"),
				"every delta carrier holds the call's own rows"
			)
			if (deltas.length > 0) {
				k.note("a delta carried")
			}
		}),
	box: "a target of one item, one child's items or every item, carried past the marks, with the marks it logged read back or not",
	oracle: {
		kind: "specification",
		name: "the rank each reach binds: a key one row, a unit one unit's rows, every item unbounded"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/write/carriers/carriers.ts",
			original: '\t\t\tbound: loosestRank(rows.ranks) ?? "none",',
			replacement: '\t\t\tbound: "held",',
			why: "Every carrier stated held, the call's own rows: a target of one child's items, or of every item, stated as bounded by the call."
		}
	]
})
