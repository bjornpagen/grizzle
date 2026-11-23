/**
 * Scoped entries over PostgreSQL: a role holding scopedEntriesOf(S) reads and writes the schema's own programs over its
 * owner's rows, as row-level security holds it, and every law over every row (scoped.fixtures.ts). Over drawn lawful
 * states of a sitting, drawn sessions and one drawn write of each kind:
 *
 * - each of the role's reads of a scoped relation answers exactly the slice the model reads (sliceOf), and the pinned
 *   negation (steps of a number with no stamp) the slice's;
 * - each write answers what the model answers, laws judged over every row: an assignment at a number another owner's
 *   row holds is refused on Assignment's key, by its definer probe; a row outside the owner's rows is outsideWorld; an
 *   event and its stamp are written in one stratum; a session is written with its Visits nested, drawn in order; an
 *   item is appended to its stored session, which counts it; and the state after a write is the model's;
 * - a direct writer, the role taken on in SQL, is refused (42501) an assignment of another student and an update moving
 *   its own assignment to another student: the policy's WITH CHECK holds every row it writes to the owner's.
 *
 * Oracle: the specification, the slice and the laws over every row, stated over the drawn state (scoped.fixtures.ts).
 *
 * Features: a read of the owner's rows, an assignment refused at another owner's key, an outsideWorld write, an event
 * refused at its own key, an event and its stamp in one stratum, a sequence's owner inserted with its members, a counted
 * member appended, a direct write outside the owner's rows refused.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import {
	Assignment,
	clerkOf,
	EventAt,
	ItemSession,
	rowText,
	type ScopedCase,
	scopedAt,
	scopedCaseGen,
	type ScopedFeature,
	scopedTemplate,
	seedFacts,
	SittingEvent,
	sliceOf,
	type Tables,
	tablesOf,
	TestSession,
	Visit,
	writeOutcome
} from "#test/pg/scoped/scoped.fixtures.ts"
import { rowsOf, writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { servedGenerated } from "#test/support/served-db.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import { ownerSession, Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { tokenOf } from "#test/support/worlds.ts"

const sorted = (rows: ReadonlyArray<string>): ReadonlyArray<string> => Arr.sort(rows, Order.String)

/** A role holding scoped entries reads and writes the schema's programs over its owner's rows, every law over every row. */
export const aRoleHoldingScopedEntriesReadsAndWritesTheSchemasProgramsOverItsOwnersRowsEveryLawOverEveryRow =
	property.explore(scopedCaseGen, {
		needs: { scoped: Substrate.seat(scopedTemplate) },
		situations: [
			"a read of the owner's rows",
			"an assignment refused at another owner's key",
			"an outsideWorld write",
			"an event refused at its own key",
			"an event and its stamp in one stratum",
			"a sequence's owner inserted with its members",
			"a counted member appended",
			"a direct write outside the owner's rows refused"
		] satisfies ReadonlyArray<Reached<ScopedFeature>>,
		check:
			({ scoped }, cx: Case<ScopedFeature>) =>
			(c: ScopedCase) =>
				Effect.scoped(
					Effect.flatMap(scoped, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const m = taken.value.installed
								const { app, desk, student } = scopedAt(m.declared)
								const s = yield* Substrate
								const owner = yield* s.session({ ...ownerSession(), label: "scoped owner" })
								const names = namesOf(m)
								/** Every table as text rows, as the owner reads it: the read programs' columns. */
								const tables = Effect.gen(function* () {
									const read = (sql: string) =>
										Effect.map(owner.values(sql, []), (rows) => sorted(Arr.map(rows, rowText)))
									const col = <R extends Parameters<typeof names.column>[0]>(
										r: R,
										...fields: ReadonlyArray<Parameters<typeof names.column<R>>[1]>
									) =>
										Arr.join(
											Arr.map(fields, (f) => `${names.column(r, f)}::text`),
											", "
										)
									const t: Tables = {
										assignments: yield* read(
											`SELECT ${col(Assignment, "number", "student", "test")} FROM ${names.table(Assignment)}`
										),
										events: yield* read(
											`SELECT ${col(SittingEvent, "number", "step", "kind")} FROM ${names.table(SittingEvent)}`
										),
										eventsAt: yield* read(
											`SELECT ${col(EventAt, "number", "step", "at")} FROM ${names.table(EventAt)}`
										),
										sessions: yield* read(
											`SELECT ${col(TestSession, "child", "stage", "pkg", "visits", "items")} FROM ${names.table(TestSession)}`
										),
										visits: yield* read(
											`SELECT ${col(Visit, "child", "stage", "at", "note")} FROM ${names.table(Visit)}`
										),
										items: yield* read(
											`SELECT ${col(ItemSession, "child", "stage", "item")} FROM ${names.table(ItemSession)}`
										)
									}
									return t
								})
								const deskServed = servedGenerated(taken.value, desk)
								const appServed = servedGenerated(taken.value, app)
								const seeds = seedFacts(c.state)
								yield* Effect.gen(function* () {
									const db = yield* Db.open(deskServed.login.roles.staff, {})
									yield* db.workload.seedPeople.once({
										params: {},
										facts: { insert: seeds.people }
									})
									yield* db.workload.seedAssignments.once({
										params: {},
										facts: { insert: seeds.assignments }
									})
									yield* db.workload.seedEvents.once({
										params: {},
										facts: { insert: seeds.events }
									})
									yield* db.workload.seedLater.once({ params: {}, facts: { insert: seeds.later } })
								}).pipe(Effect.scoped, withLayer(deskServed.layer))
								const seeded = yield* tables
								assert.deepEqual(seeded, tablesOf(c.state), "the seeded state is the drawn one")

								yield* Effect.gen(function* () {
									const db = yield* Db.open(appServed.login.roles.student, {
										token: tokenOf({ sub: clerkOf[c.person] })
									})
									const assignmentsRows = yield* rowsOf(
										db.workload.assignments.once({ params: {}, facts: {} })
									)
									const eventsRows = yield* rowsOf(
										db.workload.events.once({ params: {}, facts: {} })
									)
									const eventsAtRows = yield* rowsOf(
										db.workload.eventsAt.once({ params: {}, facts: {} })
									)
									const sessionsRows = yield* rowsOf(
										db.workload.sessions.once({ params: {}, facts: {} })
									)
									const visitsReadRows = yield* rowsOf(
										db.workload.visitsRead.once({ params: {}, facts: {} })
									)
									const itemsReadRows = yield* rowsOf(
										db.workload.itemsRead.once({ params: {}, facts: {} })
									)
									const slice = tablesOf(sliceOf(c.state, c.person))
									const read = <Row>(
										rows: ReadonlyArray<Row>,
										values: (row: Row) => ReadonlyArray<unknown>
									) => sorted(Arr.map(rows, (row) => rowText(values(row))))
									assert.deepEqual(
										read(assignmentsRows, (r) => [r.number, r.student, r.test]),
										slice.assignments,
										"the owner's assignments"
									)
									assert.deepEqual(
										read(eventsRows, (r) => [r.number, r.step, r.kind]),
										slice.events,
										"the events of the owner's assignments"
									)
									assert.deepEqual(
										read(eventsAtRows, (r) => [r.number, r.step, r.at]),
										slice.eventsAt,
										"the stamps of the owner's events"
									)
									assert.deepEqual(
										read(sessionsRows, (r) => [r.child, r.stage, r.pkg, r.visits, r.items]),
										slice.sessions,
										"the owner's sessions, each with its counts"
									)
									assert.deepEqual(
										read(visitsReadRows, (r) => [r.child, r.stage, r.at, r.note]),
										slice.visits,
										"the owner's Visits"
									)
									assert.deepEqual(
										read(itemsReadRows, (r) => [r.child, r.stage, r.item]),
										slice.items,
										"the owner's items"
									)
									const own = sliceOf(c.state, c.person)
									for (const a of c.state.assignments) {
										const unstampedRows = yield* rowsOf(
											db.workload.unstamped.once({ params: { number: a.number }, facts: {} })
										)
										const steps = read(unstampedRows, (r) => [r.step])
										const expected = sorted(
											Arr.flatMap(own.events, (e) =>
												e.number === a.number &&
												!Arr.some(own.eventsAt, (t) => t.number === e.number && t.step === e.step)
													? [rowText([e.step])]
													: []
											)
										)
										assert.deepEqual(steps, expected, `the unstamped steps of number ${a.number}`)
									}
									cx.note("a read of the owner's rows")

									const write = c.write
									const call = (() => {
										switch (write.kind) {
											case "addAssignment":
												return writeAnswerOf(
													db.workload.addAssignment.once({
														params: {},
														facts: { insert: { Assignment: [write.row] } }
													})
												)
											case "addEvent":
												return writeAnswerOf(
													db.workload.addEvent.once({
														params: {},
														facts: { insert: { SittingEvent: [write.row] } }
													})
												)
											case "addEventAt":
												return writeAnswerOf(
													db.workload.addEventAt.once({
														params: {},
														facts: {
															insert: {
																SittingEvent: [write.event],
																EventAt: [
																	{
																		number: write.event.number,
																		step: write.event.step,
																		at: write.at
																	}
																]
															}
														}
													})
												)
											case "openSession":
												return writeAnswerOf(
													db.workload.openSession.once({
														params: {},
														facts: {
															insert: {
																TestSession: [
																	{
																		child: write.row.child,
																		stage: write.row.stage,
																		pkg: write.row.pkg,
																		visits: Arr.map(write.row.notes, (note) => ({ note }))
																	}
																]
															}
														}
													})
												)
											case "addItem":
												return writeAnswerOf(
													db.workload.addItem.once({
														params: {},
														facts: { insert: { ItemSession: [write.row] } }
													})
												)
										}
									})()
									const answered = yield* Effect.result(call)
									if (Result.isFailure(answered)) {
										return assert.fail(
											`the ${write.kind} failed with ${answered.failure.kind}: ${answered.failure.message}`
										)
									}
									const answer = answered.success
									const expected = writeOutcome(c)
									const before = tablesOf(c.state)
									const after = yield* tables
									switch (expected.kind) {
										case "accepted":
											assert.equal(answer.kind, "accepted", `the ${write.kind} is accepted`)
											assert.deepEqual(after, tablesOf(expected.after), "the state after the write")
											if (write.kind === "addEventAt") {
												cx.note("an event and its stamp in one stratum")
											}
											if (write.kind === "openSession") {
												cx.note("a sequence's owner inserted with its members")
											}
											if (write.kind === "addItem") {
												cx.note("a counted member appended")
											}
											break
										case "unchanged":
											assert.equal(answer.kind, "unchanged", `the ${write.kind} changes nothing`)
											assert.deepEqual(after, before, "the state after an unchanged write")
											break
										case "outsideWorld":
											assert.equal(
												answer.kind,
												"outsideWorld",
												`the ${write.kind} is outside the owner's rows`
											)
											assert.deepEqual(after, before, "an outsideWorld write stores nothing")
											cx.note("an outsideWorld write")
											break
										case "either":
											assert.ok(
												answer.kind === "outsideWorld" || answer.kind === "refused",
												`the ${write.kind}, outside the owner's rows and breaking a law, is either; it answered ${answer.kind}`
											)
											assert.deepEqual(after, before, "a refused write stores nothing")
											break
										case "refused": {
											if (answer.kind !== "refused") {
												return assert.fail(
													`the ${write.kind} is refused on ${expected.relation}; it answered ${answer.kind}`
												)
											}
											if (expected.law === "key") {
												const key = names.primaryKeyLaw(
													expected.relation === "Assignment"
														? Assignment
														: expected.relation === "SittingEvent"
															? SittingEvent
															: TestSession
												)
												assert.deepEqual(
													Arr.map(refusedEntries(answer.refused), (l) => names.reported(l)),
													[key],
													`the ${write.kind} is refused on ${expected.relation}'s key alone, judged over every row`
												)
												if (write.kind === "addAssignment") {
													const held = Arr.findFirst(
														c.state.assignments,
														(a) => a.number === write.row.number
													)
													if (held._tag === "Some" && held.value.student !== c.person) {
														cx.note("an assignment refused at another owner's key")
													}
												}
												if (write.kind === "addEvent") {
													cx.note("an event refused at its own key")
												}
											}
											assert.deepEqual(after, before, "a refused write stores nothing")
											break
										}
									}
								}).pipe(Effect.scoped, withLayer(appServed.layer))

								const writer = yield* s.session({
									...worldSession(m.world(student)),
									label: "direct student"
								})
								const other = c.person === "ann" ? "bob" : "ann"
								yield* expectSqlstate(
									writer.query(
										`INSERT INTO ${names.table(Assignment)} (${names.column(Assignment, "number")}, ${names.column(Assignment, "student")}, ${names.column(Assignment, "test")}) VALUES (9, '${other}', 'a')`,
										[]
									),
									"42501"
								)
								const ownedRows = yield* owner.values(
									`SELECT ${names.column(Assignment, "number")}::text FROM ${names.table(Assignment)} WHERE ${names.column(Assignment, "student")} = '${c.person}'`,
									[]
								)
								const owned = Arr.findFirst(ownedRows, () => true)
								if (owned._tag === "Some") {
									yield* expectSqlstate(
										writer.query(
											`UPDATE ${names.table(Assignment)} SET ${names.column(Assignment, "student")} = '${other}' WHERE ${names.column(Assignment, "number")} = ${String(owned.value[0])}`,
											[]
										),
										"42501"
									)
								}
								cx.note("a direct write outside the owner's rows refused")
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the owner's slice, and the laws over every row, stated over the drawn state"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: `\t\t\treturn clauses.line(\`WITH CHECK (\${printExpr(statement.filter)})\`)`,
				replacement: '\t\t\treturn clauses.line("WITH CHECK (true)")',
				why: "A policy admits every row a write leaves: a direct writer's assignment of another student, and its update moving its own assignment to another, commit where the policy refuses them with 42501."
			},
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original: "\t\t\t\t\t\t\t\t\t\t],\n\t\t\t\t\t\t\t\t\t\toutside\n",
				replacement: "\t\t\t\t\t\t\t\t\t\t],\n\t\t\t\t\t\t\t\t\t\tnot(outside)\n",
				why: "A key probe judges a key through the owner's rows, not over every row: an assignment at a number another owner's row holds is not refused on Assignment's key, which the statement then meets at the key it cannot see."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original:
					'\t\t\t\t\t\tif (op !== "delete") {\n\t\t\t\t\t\t\tprecheckMember(stratum, relation, slot, target)\n\t\t\t\t\t\t}\n',
				replacement: "",
				why: "A counted member a scoped entry appends by its own slot is prechecked by no statement, since no action writes it: an item appended to another student's session reaches the policy, which refuses it 42501 as the write's failure where the precheck answers outsideWorld."
			}
		]
	})
