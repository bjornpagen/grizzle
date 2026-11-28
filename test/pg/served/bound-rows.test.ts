/**
 * A lower level's relation parameter bound to a query of a higher level reads the query's rows inside the lower level's
 * write, in its one statement, with no read before it, and writes what today's form writes when fed those rows.
 *
 * - **Property:** a case draws Delivery's visits, suspensions, ends and awaiting items, the app's stages and admins, the
 *   child it acts for, the operator its token names and a score. The open visits read through the import's bind of the
 *   app's guard (`openBound`) are the ledger's `openVisit` fed the rows the guard returns (`openFed`). The ChangeSet-level
 *   bind of the ledger's `suspendTest` to the guard (`suspendBound`, the program's one parameter `child`) explains as
 *   one statement, both members and the guard they share in it (one node of the write's DAG: test/unit/write/
 *   bound-rows); applied, it writes a
 *   moment and a suspension of each open visit of the child's own sittings, exactly what the fed form writes. The
 *   scorers' write bound to the admitted operator, a context's read, across its sequence (`evaluate`), whose first
 *   stratum alone reads the scorers, explains as its two strata's two statements, the guard a part of the first, and
 *   writes the child's awaiting items scored by the operator where Admin holds them, and grades them. The app's
 *   decision of a stage sequenced before the ledger's take bound to the guard (`decideTake`, `child` one parameter of
 *   the app's member and of the guard's) is two statements, the take reading the guard after the decision, a part of
 *   its own statement: a visit of each of the child's sittings, the decided one among them (docs/reads-and-writes.md "Writes": a
 *   relation parameter bound to a query is evaluated once before the first stratum of the part it is bound on).
 * - **Oracle:** second implementation: today's form, the ledger's own programs fed the guard's rows, and its writes as
 *   their specification states them (`suspendedOf`, `evaluatedOf`).
 * - **Features:** a child with open visits, a child none of whose sittings is open, an admitted operator, an operator
 *   Admin does not hold.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { memberCalls, memberExplains } from "#adapter/db/handles.ts"
import {
	type BoundCase,
	boundCaseGen,
	boundRowsTemplate,
	factsOf,
	sittingsOfCase,
	textsOf,
	worldOf,
	writtenOf
} from "#test/pg/served/bound-rows.fixtures.ts"
import { readOnce, writeOnce } from "#test/support/calls.ts"
import { loadMigrated } from "#test/support/install-migrate.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

type BoundFeature =
	| "a child with open visits"
	| "a child none of whose sittings is open"
	| "an admitted operator"
	| "an operator Admin does not hold"

const features = [
	"a child with open visits",
	"a child none of whose sittings is open",
	"an admitted operator",
	"an operator Admin does not hold"
] as const satisfies ReadonlyArray<Reached<BoundFeature>>

/** The open visits of the child's own sittings: no suspension of the visit and no end of its sitting holds. */
const openOf = (c: BoundCase) =>
	Arr.filter(
		c.visits,
		(x) =>
			Arr.some(sittingsOfCase(c), (s) => s.child === x.child && s.stage === x.stage) &&
			!Arr.some(c.suspended, (s) => s.child === x.child && s.stage === x.stage && s.k === x.k) &&
			!Arr.some(c.ended, (e) => e.child === x.child && e.stage === x.stage)
	)

/** What suspendTest writes, fed the child's own sittings: a moment of each open sitting, a suspension of each visit. */
const suspendedOf = (c: BoundCase) => ({
	moments: Arr.dedupe(textsOf(["child", "stage"], openOf(c))),
	suspensions: textsOf(["child", "stage", "k"], [...c.suspended, ...openOf(c)])
})

/** What recordValue writes for the operator: the child's awaiting items scored where Admin holds them, and graded. */
const evaluatedOf = (c: BoundCase) => {
	const scored = Arr.contains(c.admins, c.operator)
		? Arr.filter(c.awaiting, (a) => a.child === c.child)
		: []
	return {
		scored: textsOf(
			["child", "n", "scorer", "score"],
			Arr.map(scored, (a) => ({ ...a, scorer: c.operator, score: c.score }))
		),
		graded: textsOf(["child", "n"], scored)
	}
}

/** What the app's decision and the ledger's take leave: the decided stage the child's, and a visit of each of its
 * sittings, the decided one among them, beside the visits the case held: the take's `taken` is bound on the take, the
 * guard read once before the take's stratum, after the decision (docs/reads-and-writes.md "Writes"). */
const tookOf = (c: BoundCase) => {
	const stages = Arr.dedupeWith(
		[...c.stages, { child: c.child, key: c.decided }],
		(a, b) => a.child === b.child && a.key === b.key
	)
	const taken = Arr.map(
		Arr.filter(stages, (s) => s.child === c.child),
		(s) => ({ child: s.child, stage: s.key, k: 1 })
	)
	return {
		stages: textsOf(["child", "key"], stages),
		visits: Arr.dedupe(textsOf(["child", "stage", "k"], [...c.visits, ...taken]))
	}
}

/** A relation parameter bound to a higher level's query reads its rows in the lower level's one statement. */
export const aRelationParameterBoundToAHigherLevelsQueryReadsItsRowsInTheLowerLevelsOneStatement =
	property.explore(boundCaseGen, {
		needs: Substrate.oneOf({ bound: boundRowsTemplate }, Substrate.fresh),
		situations: features,
		budget: { runs: 16, steered: features.length },
		check: (templates, notes: Case<BoundFeature>) => (c) =>
			Effect.scoped(
				Effect.gen(function* () {
					notes.note(
						openOf(c).length > 0
							? "a child with open visits"
							: "a child none of whose sittings is open"
					)
					notes.note(
						Arr.contains(c.admins, c.operator)
							? "an admitted operator"
							: "an operator Admin does not hold"
					)
					const taken = yield* templates.bound
					yield* Effect.provideService(
						Effect.gen(function* () {
							const substrate = yield* Substrate
							const installed = taken.value.installed
							yield* loadMigrated(installed, factsOf(c))
							const world = worldOf(installed.declared)
							yield* withServedDb(
								installed,
								world.server.roles.app,
								{ sub: c.operator },
								({ ctx: db, loadWithTables }) =>
									Effect.gen(function* () {
										const loaded = yield* loadWithTables(world.programs)
										const call = (name: string) => memberCalls(db, member(loaded.members, name))
										const sittings = yield* readOnce(call("sittingsOf"))({
											params: { child: c.child },
											facts: {}
										})
										const bound = yield* readOnce(call("openBound"))({
											params: { child: c.child },
											facts: {}
										})
										const fed = yield* readOnce(call("openFed"))({
											params: { sittings },
											facts: {}
										})
										const visit = ["child", "stage", "k"] as const
										assert.deepEqual(
											textsOf(visit, bound),
											textsOf(visit, fed),
											"the import's bind of the guard reads what openVisit fed its rows reads"
										)
										const input = { params: { child: c.child }, facts: {} }
										const explains = memberExplains(
											db,
											loaded.tables,
											member(loaded.members, "suspendBound")
										)
										if (explains.kind !== "change") {
											return assert.fail("a ChangeSet explains as a change")
										}
										const plans = yield* explains.explain(input)
										assert.equal(plans.length, 1, "the bound ChangeSet is one statement")
										const suspended = yield* Effect.result(writeOnce(call("suspendBound"))(input))
										if (Result.isFailure(suspended)) {
											return assert.fail(
												`suspendBound applies: ${Formatter.format(suspended.failure)}`
											)
										}
										const evaluation = { params: { child: c.child, score: c.score }, facts: {} }
										const evaluates = memberExplains(
											db,
											loaded.tables,
											member(loaded.members, "evaluate")
										)
										if (evaluates.kind !== "change") {
											return assert.fail("a ChangeSet explains as a change")
										}
										const strata = yield* evaluates.explain(evaluation)
										assert.equal(
											strata.length,
											2,
											"the bound sequence is its two strata's statements, no read before"
										)
										const evaluated = yield* Effect.result(writeOnce(call("evaluate"))(evaluation))
										if (Result.isFailure(evaluated)) {
											return assert.fail(`evaluate applies: ${Formatter.format(evaluated.failure)}`)
										}
										const decision = { params: { child: c.child, decided: c.decided }, facts: {} }
										const takes = memberExplains(
											db,
											loaded.tables,
											member(loaded.members, "decideTake")
										)
										if (takes.kind !== "change") {
											return assert.fail("a ChangeSet explains as a change")
										}
										const took = yield* takes.explain(decision)
										assert.equal(
											took.length,
											2,
											"the decision and the bound take are two statements, no read between"
										)
										const decided = yield* Effect.result(writeOnce(call("decideTake"))(decision))
										if (Result.isFailure(decided)) {
											return assert.fail(`decideTake applies: ${Formatter.format(decided.failure)}`)
										}
										const written = yield* writtenOf(substrate.admin, installed.schema)
										assert.deepEqual(
											written,
											{ ...suspendedOf(c), ...evaluatedOf(c), ...tookOf(c) },
											"the bound programs write what the ledger fed the guard's rows writes"
										)
									})
							)
						}),
						Substrate,
						taken.substrate
					)
				})
			),
		oracle: {
			kind: "second-implementation",
			name: "today's form, the ledger's programs fed the rows the app's guard returns, and its writes as stated"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\t\t\treturn this.#boundRows(src.cell.name, heading, resolved, loc)\n",
				replacement:
					'\t\t\t\treturn this.node({ kind: "InputSet", input: { kind: "declared", param: src.cell.relationUse(heading, loc) }, heading }, loc)\n',
				why: "A relation parameter bound to a query reads the caller's rows of its name anyway, which no caller gives: the bound programs read and write nothing of the child's sittings, or are refused for the rows they lack."
			}
		]
	})
