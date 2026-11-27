/**
 * The scopes of a schema's clocks (analysis/theory/instants.ts, ir/instant.ts ClockScope and scopeOrder): every clock of
 * a relation under a unit is of the unit's one scope, keyed by the unit's heading, so its writes stamp from the unit's
 * one head; every other clock is its own child's. The fact the provers read, scopeOrder, names each clock's head and the
 * fields of its relation that hold the head's key.
 *
 * The box, exhausted: the unit U over k, or none; A, a clock of child (k) or (k, j); B, of child (k); C, of child (c),
 * which U's heading does not lead; and R, keyed by r, whose at is a reference A's clock stamps. 4 cases.
 *
 * Properties, per case, against the model (scopes.fixtures.ts modelOf), the rule stated again over the case's own shape:
 * each clock's head is its model scope's, keyed by the model's fields of its relation (scopeOrder); two clocks share a
 * head exactly where their scopes are one (sameHead); the schema's clock heads are each scope once (headsOf); and R's
 * stamp reads A's head at R's fields that hold its key (stampAt).
 *
 * Features: a unit's two clocks sharing its head, one of a child longer than the unit's key, a clock outside the unit
 * beside them, a reference stamped at the unit's key, and clocks of no unit, each its own child's.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import {
	type Head,
	headsOf,
	headText,
	sameHead,
	scopeOrder,
	stampAt
} from "#compiler/ir/instant.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	modelOf,
	names,
	type ScopesFeature,
	scopesGen,
	scopesNotes,
	scopesSchema
} from "#test/unit/analysis/theory/scopes.fixtures.ts"
import { theoryResult } from "#test/unit/analysis/theory/support.ts"

/** Every clock of a unit's relations shares the unit's one head, keyed by its heading, every other clock its own child's, and the fact the provers read names each clock's head and the fields that hold its key. */
export const everyClockOfAUnitsRelationsSharesTheUnitsOneHeadKeyedByItsHeadingAndEveryOtherClockItsOwnChilds =
	property.exhaust(finite(scopesGen), {
		needs: {},
		box: "the unit U over k or none, A of child (k) or (k, j) beside B, C and R, 4 cases",
		situations: [
			"a unit's two clocks share its head",
			"a unit's clock of a child longer than its key",
			"clocks of no unit, each its own child's",
			"a clock outside the unit beside its clocks",
			"a reference stamped at its unit's key"
		] satisfies ReadonlyArray<Reached<ScopesFeature>>,
		check: (_, k: Case<ScopesFeature>) => (c) =>
			Effect.sync(() => {
				k.noteAll(scopesNotes(c))
				const model = modelOf(c)
				const theory = succeeded(
					theoryResult(scopesSchema(c)),
					`the theory of ${Formatter.format(c)}`
				)
				const instants = theory.instants
				const relationOf = (name: string): StoredRelationName =>
					defined(
						Option.getOrUndefined(Arr.findFirst([...instants.roles.keys()], (r) => r === name)),
						`the relation ${name} of instants`
					)
				const heads = new Map<string, Head>()
				for (const [clock, scope] of model.clocks) {
					const got = defined(
						scopeOrder(instants, relationOf(clock), "at"),
						`the scope of ${clock}.at`
					)
					heads.set(clock, got.head)
					assert.deepEqual(
						{ scope: headText(got.head), key: names(got.key) },
						scope,
						`the scope of ${clock}.at in ${Formatter.format(c)}`
					)
				}
				for (const [x, a] of model.clocks) {
					for (const [y, b] of model.clocks) {
						assert.equal(
							sameHead(defined(heads.get(x), x), defined(heads.get(y), y)),
							a.scope === b.scope,
							`whether ${x}.at and ${y}.at share a head in ${Formatter.format(c)}`
						)
					}
				}
				assert.equal(
					Arr.filter(headsOf(instants), (h) => h.kind === "clock").length,
					model.heads,
					`the clock heads of ${Formatter.format(c)}, each scope once`
				)
				const reference = defined(instants.roles.get(relationOf("R"))?.get("at"), "R.at's role")
				assert.ok(reference.kind === "reference", "R.at is a reference")
				const stamp = defined(reference.stamp, "R.at's stamp")
				const at = stampAt({ kind: "clock", ...stamp })
				assert.deepEqual(
					{ scope: headText(at.head), key: names(at.key) },
					model.reference,
					`R.at's stamp in ${Formatter.format(c)}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the rule over the case: A and B, keyed by k first, share U's one scope keyed (k) where U is declared, every other clock its own child's, R stamped from A's scope at its fields holding the scope's key (scopes.fixtures.ts modelOf)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/instants.ts",
				original: "\t\tconst member = units.get(r.name)\n",
				replacement: '\t\tconst member = units.get("")\n',
				why: "Every clock is its own child's scope again, as before the unit-wide clock: A and B under U take two heads, keyed by their children, where the model holds them U's one."
			},
			{
				file: "packages/engine/src/ir/instant.ts",
				original:
					"\tmapNonEmpty(stamp.clock.head.key, (_, i) =>\n\t\tdefined(stamp.child[i], \"a stamped row's field at each field of its scope's key\")\n\t)\n",
				replacement: "\tstamp.child\n",
				why: "A clock's stamp reads its scope's key from every field of its row's child: A under U, of child (k, j), names (k, j) for U's key (k), where the model names (k)."
			}
		]
	})
