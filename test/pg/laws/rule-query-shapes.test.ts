/**
 * The downstream shapes of rules over queries on PostgreSQL 19rc2, kept beside the search of rule-query.test.ts: each
 * exhausted over a box of states, every state written whole by a served ChangeSet of grizzle's into empty tables.
 *
 * - **A join as a rule's side**, a typed href: ResourceHref ⋈ ResourceTyped on node is TypedHref, a live derived
 *   relation in place of a stored copy kept in step by containments both ways. A check over it (an item's href is
 *   internal), a selection of it contained in Entry (an item's href names an entry), and LomObject contained in it.
 * - **A semijoin as a containment's source**, a title of a record that names an object: LomTitle ⋉ RecordObject on
 *   record is contained in ObjectTitle, so a title of a record that names none forces nothing.
 * - **A semijoin of two selections**, a held type: the variable references that hold a type ⋉ the held expressions
 *   under them on node, projected on node, is contained in HeldType, so a setter with two held expressions forces one
 *   row and a setter with none forces none.
 * - **An anti-join as a containment's source**, a probe row: the items no key holds a k for are contained in Flag.
 *
 * The oracle is each rule restated over the rows: a write is accepted exactly when its state keeps every rule, and
 * refused `invariant-rejected` otherwise, naming rules the state breaks, its witness `unreported`. The box is every
 * state of each shape over one or two nodes, records, items and keys, which reaches each rule broken alone.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Layer } from "effect"
import { Db } from "#adapter/public/db.ts"
import { cleared, seatOfInstalled } from "#test/pg/fin/installed.ts"
import {
	brokenOf,
	declared,
	Disagreed,
	type Feature,
	programsOf,
	RELATIONS,
	shapeRowsOf,
	type Rule,
	ruleOf,
	rules,
	shapes,
	sketchGen
} from "#test/pg/laws/rule-query-shapes.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { nonEmpty } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { servedFixture } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * Downstream's rules over queries on PostgreSQL 19rc2 accept exactly the states of each downstream shape that keep its rules, refusing the rest naming a rule they break.
 */
export const downstreamsRulesOverQueriesOnPostgreSQL19rc2AcceptExactlyTheStatesOfEachDownstreamShapeThatKeepItsRulesRefusingTheRestNamingARuleTheyBreak =
	property.exhaust(finite(sketchGen), {
		needs: { substrate: Substrate.installing },
		situations: nonEmpty([
			"typedHref: accepted",
			"titledObject: accepted",
			"heldSetter: accepted",
			"unmatched: accepted",
			...Arr.map(rules, (r) => `refused by ${r}` as const),
			"a setter with two held expressions forces one held type",
			"a typed href's lom object accepted"
		]) satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, c: Case<Feature>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const done = yield* installMigrated(declared, {
							ambient: ordinarySession,
							label: "rule_shapes",
							logins: [fullWorld(declared, {}).server],
							extensions: []
						})
						const value = shapes(done.schema)
						const world = fullWorld(value, programsOf(value))
						const seat = yield* seatOfInstalled(done, RELATIONS, "rule_shapes")
						const served = yield* servedFixture(done, world.server)
						const context = yield* Layer.build(served.layer)
						const db = yield* Db.open(served.login.roles.app, {}).pipe(
							Effect.provideContext(context)
						)

						yield* cleared(seat, RELATIONS)
						const rows = shapeRowsOf(sketch)
						const outcome = yield* answered(
							db.workload.insertAll.once({ params: {}, facts: { insert: rows } })
						)
						const breaks = brokenOf(sketch)
						if (outcome.kind === "accepted" || outcome.kind === "unchanged") {
							if (breaks.length > 0) {
								return yield* new Disagreed({
									message: `accepted a state breaking ${Arr.join(breaks, ", ")}: ${Formatter.format(sketch)}`
								})
							}
							c.note(`${sketch.shape}: accepted`)
							if (
								sketch.shape === "heldSetter" &&
								sketch.heldType &&
								Arr.filter(sketch.expressions, (e) => e.parent === 1 && e.held).length === 2
							) {
								c.note("a setter with two held expressions forces one held type")
							}
							if (sketch.shape === "typedHref" && sketch.lom !== "none") {
								c.note("a typed href's lom object accepted")
							}
							return
						}
						const named =
							outcome.kind === "refused" ? Arr.map(refusedLaws(outcome.refused), ruleOf) : []
						const broke = (r: Rule | undefined): r is Rule => r !== undefined && breaks.includes(r)
						if (
							outcome.kind !== "refused" ||
							outcome.witness.kind !== "unreported" ||
							!(outcome.refused.kind === "some"
								? Arr.some(named, broke)
								: Arr.isReadonlyArrayNonEmpty(named) && Arr.every(named, broke))
						) {
							return yield* new Disagreed({
								message: `answered ${Formatter.format(outcome)} where the state breaks ${Arr.join(breaks, ", ") || "nothing"}: ${Formatter.format(sketch)}`
							})
						}
						for (const r of Arr.filter(named, broke)) {
							c.note(`refused by ${r}`)
						}
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "each downstream rule restated over the rows: a state is accepted exactly when it keeps every rule"
		},
		box: "every state of a typed href over one resource, two paths and two types, of titles over two records, of a held type over one setter with up to two expressions under two nodes, and of probe rows over two items and two keys",
		kept: [],
		kills: []
	})
