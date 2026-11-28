/**
 * Claims-scoped reads over PostgreSQL: a role whose scope binds a unit reads and writes the base's own programs over its
 * world, every member of the unit at the keys its claims name, and every law over every row (claims.fixtures.ts). Over
 * drawn lawful states of a sitting, drawn sessions of a student (their Clerk user's child, or no one) or a coach (their
 * granted children, any number), and one drawn write:
 *
 * - every read of the workload answers exactly what its second implementation answers over the world (readsOver): each
 *   member's rows, the live derived Status and Graded, an aggregate, a take, a negation, an import, one assignment by
 *   its number, the whole Grade, a relation of no unit, and the role's query entry Firsts; and a clocked read of each
 *   drawn child's presentations at a stage, the child its caller's parameter, which answers the world's rows alone, so a
 *   child the claims do not bind reads nothing: the clock binds a parameter, never the world;
 * - each write answers what the model answers, laws judged over every row: a raw fact of a member outside the claimed
 *   children is outsideWorld, a delete's among them; an assignment at a number another child holds is refused on the
 *   number's key; a session is written with its Visits nested; an item is appended to its stored session, which counts
 *   it; the events of the world's eventless assignments are written, proven inside the claims; and an assign of a
 *   class's children, whose child no member gives, is held to the claims; a first mark inserted through Firsts, a query
 *   entry over a member, is held to the claims as a whole write is, beside the entry's own membership; a delete of a
 *   counted member, and of a session, a unit whose Visits and items go with it, from raw facts or from a class's
 *   enrolment, is held to the claims; the state after a write is the model's;
 * - every scan of a member in every statement the role's reads send is an index probe that binds the unit's key, as
 *   PostgreSQL plans it under the advice the read carries, the plan laws held over it (test/support/advice.ts): a
 *   claims-scoped read probes by the child wherever it reads a member, inside every derivation.
 *
 * Oracle: the specification, the world and the laws over every row, stated over the drawn state (claims.fixtures.ts); the
 * plans PostgreSQL 19 makes under each read's carried advice, read by the plan laws (test/support/advice.ts).
 *
 * Features: a student's, a no-one's and a coach's reads; a clocked read of a child the claims do not bind; a whole read
 * of a relation in no unit; an outsideWorld fact; an assignment refused at another child's number; a sequence's owner
 * with its members; a counted member appended; a delete outside the claims refused; a write proven inside the claims; a
 * write whose child no member gives prechecked; a write through a query entry outside the claims refused, and one
 * accepted; a unit's delete and a counted member's outside the claims refused, and each accepted; a unit delete whose
 * child no member gives prechecked.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, Record as Rec, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	Assignment,
	assignmentOver,
	presentedOver,
	type ClaimsCase,
	claimedOf,
	claimsAt,
	claimsCaseGen,
	type ClaimsFeature,
	claimsTemplate,
	Invalidation,
	ItemSession,
	Kind,
	Presented,
	readsOver,
	rowText,
	seedFacts,
	SittingEvent,
	subOf,
	type Tables,
	tablesOf,
	TestSession,
	Visit,
	worldOf,
	writeOutcome
} from "#test/pg/claims/claims.fixtures.ts"
import { lawNodes, lawsOver, plannedScope, servedRead } from "#test/support/advice.ts"
import { rowsOf, writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { servedGenerated } from "#test/support/served-db.ts"
import { ownerSession, Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { tokenOf } from "#test/support/worlds.ts"

const sorted = (rows: ReadonlyArray<string>): ReadonlyArray<string> => Arr.sort(rows, Order.String)

/** The feature a write of kind `kind` refused outsideWorld reaches. */
const outsideFeature = (kind: ClaimsCase["write"]["kind"]): ClaimsFeature => {
	switch (kind) {
		case "removeInvalidation":
			return "a delete outside the claims refused outsideWorld"
		case "assignClass":
			return "a write whose child no member gives prechecked"
		case "present":
			return "a write through a query entry outside the claims refused outsideWorld"
		case "closeSession":
			return "a unit's delete outside the claims refused outsideWorld"
		case "closeClass":
			return "a unit delete whose child no member gives prechecked"
		case "dropItem":
			return "a family member's delete outside the claims refused outsideWorld"
		case "addAssignment":
		case "addEvent":
		case "openSession":
		case "addItem":
		case "startEventless":
			return "a raw fact outside the claims refused outsideWorld"
	}
}

/** A role's world reads and writes the base's programs over the units its claims bind, every law over every row. */
export const aRoleWithAScopeReadsAndWritesItsWorldEveryLawOverEveryRow = property.explore(
	claimsCaseGen,
	{
		needs: { claims: Substrate.fresh(claimsTemplate) },
		situations: [
			"a student's reads of their child's rows",
			"a clocked read of a child the claims do not bind reads nothing",
			"a student signed in as no one reads no member's row",
			"a coach's reads of several children's rows",
			"a read of a relation in no unit, whole",
			"a raw fact outside the claims refused outsideWorld",
			"an assignment refused at another child's number",
			"a sequence's owner inserted with its members",
			"a counted member appended",
			"a delete outside the claims refused outsideWorld",
			"a write proven inside the claims accepted",
			"a write whose child no member gives prechecked",
			"a write through a query entry outside the claims refused outsideWorld",
			"a write through a query entry accepted",
			"a unit's delete outside the claims refused outsideWorld",
			"a unit deleted whole with its nested rows",
			"a family member's delete outside the claims refused outsideWorld",
			"a counted member removed",
			"a unit delete whose child no member gives prechecked"
		] satisfies ReadonlyArray<Reached<ClaimsFeature>>,
		check:
			({ claims }, cx: Case<ClaimsFeature>) =>
			(c: ClaimsCase) =>
				Effect.scoped(
					Effect.flatMap(claims, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const m = taken.value.installed
								const { app, desk, numberKey } = claimsAt(m.declared)
								const s = yield* Substrate
								const owner = yield* s.session({ ...ownerSession(), label: "claims owner" })
								const names = namesOf(m)
								/** Every member's table as text rows, as the owner reads it. */
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
											`SELECT ${col(Assignment, "child", "number", "test")} FROM ${names.table(Assignment)}`
										),
										events: yield* read(
											`SELECT ${col(SittingEvent, "child", "number", "step", "kind")} FROM ${names.table(SittingEvent)}`
										),
										invalidations: yield* read(
											`SELECT ${col(Invalidation, "child", "number", "change")} FROM ${names.table(Invalidation)}`
										),
										sessions: yield* read(
											`SELECT ${col(TestSession, "child", "stage", "pkg", "visits", "items")} FROM ${names.table(TestSession)}`
										),
										visits: yield* read(
											`SELECT ${col(Visit, "child", "stage", "at", "note")} FROM ${names.table(Visit)}`
										),
										items: yield* read(
											`SELECT ${col(ItemSession, "child", "stage", "item")} FROM ${names.table(ItemSession)}`
										),
										presented: yield* read(
											`SELECT ${col(Presented, "child", "stage", "at", "k")} FROM ${names.table(Presented)}`
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
									yield* db.workload.seedFacts.once({ params: {}, facts: { insert: seeds.facts } })
									yield* db.workload.seedItems.once({ params: {}, facts: { insert: seeds.items } })
								}).pipe(Effect.scoped, withLayer(deskServed.layer))
								const code = (kind: (typeof Kind.handles)[number]) => names.code(Kind, kind)
								const seeded = yield* tables
								assert.deepEqual(
									seeded,
									tablesOf(c.state, code),
									"the seeded state is the drawn one"
								)

								const claimed = claimedOf(c.state, c.claims)
								const world = worldOf(c.state, claimed)
								const expectedReads = readsOver(world)
								yield* Effect.gen(function* () {
									const token = tokenOf({ sub: subOf(c.claims) })
									const opened =
										c.claims.role === "student"
											? {
													role: "student" as const,
													db: yield* Db.open(appServed.login.roles.student, { token })
												}
											: {
													role: "coach" as const,
													db: yield* Db.open(appServed.login.roles.coach, { token })
												}
									const w = opened.db.workload
									const text = <Row>(
										rows: ReadonlyArray<Row>,
										values: (row: Row) => ReadonlyArray<unknown>
									) => sorted(Arr.map(rows, (row) => rowText(values(row))))
									/** A read's rows as text rows in order, each its columns `values` reads. */
									const readOf = <Row, E, R>(
										rows: Effect.Effect<Iterable<Row>, E, R>,
										values: (row: Row) => ReadonlyArray<unknown>
									) => Effect.map(rowsOf(rows), (read) => text(read, values))
									const actual: Readonly<Record<string, ReadonlyArray<string>>> = {
										assignments: yield* readOf(
											w.assignments.once({ params: {}, facts: {} }),
											(r) => [r.child, r.number, r.test]
										),
										events: yield* readOf(w.events.once({ params: {}, facts: {} }), (r) => [
											r.child,
											r.number,
											r.step,
											r.kind
										]),
										statuses: yield* readOf(w.statuses.once({ params: {}, facts: {} }), (r) => [
											r.child,
											r.number,
											r.status
										]),
										graded: yield* readOf(w.graded.once({ params: {}, facts: {} }), (r) => [
											r.child,
											r.number,
											r.grade
										]),
										grades: yield* readOf(w.grades.once({ params: {}, facts: {} }), (r) => [
											r.number,
											r.grade
										]),
										eventCounts: yield* readOf(
											w.eventCounts.once({ params: {}, facts: {} }),
											(r) => [r.child, r.number, r.events]
										),
										latest: yield* readOf(w.latest.once({ params: {}, facts: {} }), (r) => [
											r.child,
											r.number,
											r.test
										]),
										eventless: yield* readOf(w.eventless.once({ params: {}, facts: {} }), (r) => [
											r.child,
											r.number
										]),
										invalidated: yield* readOf(
											w.invalidated.once({ params: {}, facts: {} }),
											(r) => [r.child, r.number]
										),
										sessions: yield* readOf(w.sessions.once({ params: {}, facts: {} }), (r) => [
											r.child,
											r.stage,
											r.pkg,
											r.visits,
											r.items
										]),
										visitsRead: yield* readOf(w.visitsRead.once({ params: {}, facts: {} }), (r) => [
											r.child,
											r.stage,
											r.at,
											r.note
										]),
										itemsRead: yield* readOf(w.itemsRead.once({ params: {}, facts: {} }), (r) => [
											r.child,
											r.stage,
											r.item
										]),
										withEvents: yield* readOf(w.withEvents.once({ params: {}, facts: {} }), (r) => [
											r.child,
											r.number,
											Arr.join(sorted(Arr.map(r.events, (e) => rowText([e.step, e.kind]))), "/")
										]),
										spans: yield* readOf(w.spans.once({ params: {}, facts: {} }), (r) => [
											r.child,
											r.stage,
											r.at,
											r.k,
											r.end
										]),
										firsts: yield* readOf(
											opened.role === "student"
												? opened.db.workload.studentFirsts.once({ params: {}, facts: {} })
												: opened.db.workload.coachFirsts.once({ params: {}, facts: {} }),
											(r) => [r.child, r.stage, r.at]
										)
									}
									assert.deepEqual(actual, expectedReads, "every read answers its world's rows")
									for (const number of [1n, 2n, 3n]) {
										const one = yield* readOf(
											w.assignmentOf.once({ params: { number }, facts: {} }),
											(r) => [r.child, r.number, r.test, r.status]
										)
										assert.deepEqual(
											one,
											assignmentOver(world, number),
											`the assignment of number ${number} in the world`
										)
									}
									/** Each child and stage the drawn state presents at, claimed or not, once. */
									const sittings = new Map(
										Arr.map(c.state.presented, (p) => [rowText([p.child, p.stage]), p] as const)
									)
									for (const { child, stage } of sittings.values()) {
										const presented = yield* readOf(
											w.presentedOf.once({ params: { child, stage }, facts: {} }),
											(r) => [r.child, r.stage, r.at, r.k]
										)
										assert.deepEqual(
											presented,
											presentedOver(world, child, stage),
											`the presentations of ${child} at stage ${stage}, read at the call's instant, in the world`
										)
										if (!claimed.has(child)) {
											cx.note("a clocked read of a child the claims do not bind reads nothing")
										}
									}
									if (c.claims.role === "student") {
										cx.note(
											claimed.size === 0
												? "a student signed in as no one reads no member's row"
												: "a student's reads of their child's rows"
										)
									}
									if (c.claims.role === "coach" && claimed.size > 1) {
										cx.note("a coach's reads of several children's rows")
									}
									if (c.state.grades.length > world.assignments.length) {
										cx.note("a read of a relation in no unit, whole")
									}

									const write = c.write
									const call = (() => {
										switch (write.kind) {
											case "addAssignment":
												return writeAnswerOf(
													w.addAssignment.once({
														params: {},
														facts: { insert: { Assignment: [write.row] } }
													})
												)
											case "addEvent":
												return writeAnswerOf(
													w.addEvent.once({
														params: {},
														facts: { insert: { SittingEvent: [write.row] } }
													})
												)
											case "openSession":
												return writeAnswerOf(
													w.openSession.once({
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
													w.addItem.once({
														params: {},
														facts: { insert: { ItemSession: [write.row] } }
													})
												)
											case "removeInvalidation":
												return writeAnswerOf(
													w.removeInvalidation.once({
														params: {},
														facts: { delete: { Invalidation: [write.row] } }
													})
												)
											case "startEventless":
												return writeAnswerOf(w.startEventless.once({ params: {}, facts: {} }))
											case "assignClass":
												return writeAnswerOf(
													w.assignClass.once({
														params: { class: "a", number: write.number, test: write.test },
														facts: {}
													})
												)
											case "closeSession":
												return writeAnswerOf(
													w.closeSession.once({
														params: {},
														facts: { delete: { TestSession: [write.row] } }
													})
												)
											case "dropItem":
												return writeAnswerOf(
													w.dropItem.once({
														params: {},
														facts: { delete: { ItemSession: [write.row] } }
													})
												)
											case "closeClass":
												return writeAnswerOf(
													w.closeClass.once({
														params: { class: "a", stage: write.stage, pkg: write.pkg },
														facts: {}
													})
												)
											case "present": {
												const facts = { insert: { Firsts: [write.row] } }
												return writeAnswerOf(
													opened.role === "student"
														? opened.db.workload.studentPresents.once({ params: {}, facts })
														: opened.db.workload.coachPresents.once({ params: {}, facts })
												)
											}
										}
									})()
									const answered = yield* Effect.result(call)
									if (Result.isFailure(answered)) {
										return assert.fail(
											`the ${write.kind} failed with ${answered.failure._tag}: ${answered.failure.message}`
										)
									}
									const answer = answered.success
									const expected = writeOutcome(c, claimed)
									const before = tablesOf(c.state, code)
									const after = yield* tables
									switch (expected.kind) {
										case "accepted":
											assert.equal(answer._tag, "accepted", `the ${write.kind} is accepted`)
											assert.deepEqual(
												after,
												tablesOf(expected.after, code),
												"the state after the write"
											)
											if (write.kind === "openSession" && write.row.notes.length > 0) {
												cx.note("a sequence's owner inserted with its members")
											}
											if (write.kind === "addItem") {
												cx.note("a counted member appended")
											}
											if (write.kind === "startEventless") {
												cx.note("a write proven inside the claims accepted")
											}
											if (write.kind === "present") {
												cx.note("a write through a query entry accepted")
											}
											if (write.kind === "closeSession" || write.kind === "closeClass") {
												cx.note("a unit deleted whole with its nested rows")
											}
											if (write.kind === "dropItem") {
												cx.note("a counted member removed")
											}
											break
										case "unchanged":
											assert.equal(answer._tag, "unchanged", `the ${write.kind} changes nothing`)
											assert.deepEqual(after, before, "the state after an unchanged write")
											break
										case "outsideWorld":
											assert.equal(
												answer._tag,
												"outsideWorld",
												`the ${write.kind} is outside the world`
											)
											assert.deepEqual(after, before, "an outsideWorld write stores nothing")
											cx.note(outsideFeature(write.kind))
											break
										case "either":
											assert.ok(
												answer._tag === "outsideWorld" || answer._tag === "refused",
												`the ${write.kind}, outside the world and breaking a law, is either; it answered ${answer._tag}`
											)
											assert.deepEqual(after, before, "a refused write stores nothing")
											break
										case "refused": {
											if (answer._tag !== "refused") {
												return assert.fail(
													`the ${write.kind} is refused on ${expected.relation.name}; it answered ${answer._tag}`
												)
											}
											if (expected.law !== "other") {
												const law =
													expected.law === "number"
														? names.lawOf(numberKey)
														: names.primaryKeyLaw(expected.relation)
												assert.deepEqual(
													Arr.map(refusedEntries(answer.refused), (l) => names.reported(l)),
													[law],
													`the ${write.kind} is refused on ${expected.relation.name}'s ${expected.law} key alone, judged over every row`
												)
											}
											if (expected.law === "number" && write.kind === "addAssignment") {
												cx.note("an assignment refused at another child's number")
											}
											assert.deepEqual(after, before, "a refused write stores nothing")
											break
										}
									}
								}).pipe(Effect.scoped, withLayer(appServed.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the world the claims bind, each read's second implementation over it, and the laws over every row"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/claims/claims.test.ts#aRoleWithAScopeReadsAndWritesItsWorldEveryLawOverEveryRow:-:2.0.0.0.0.1.0.2.0.0.0.0.0.0.2.0.0.0.0.0.0.1.0.1.0.0.2.0.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.1.0.0"
				),
				reason:
					"ann opens her TestSession at stage 2 of pkg a with no Visits exactly as it is stored, while an ItemSession of it stands: every stated fact is stored as stated, so the write is unchanged before any law is judged (its ItemSessions' count is drawn, never stated), where the model refused it on TestSession's primary key",
				since: "2026-11-28"
			}
		],
		kills: [
			{
				file: "packages/engine/src/ir/derived.ts",
				original: '\t\tif (node.kind === "Base") {\n\t\t\treturn worldBase(node)\n\t\t}\n',
				replacement: "",
				why: "A read of a member reads every child's rows: a student's assignments, events and statuses hold another child's."
			},
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original: '\treturn claims.kind === "claimed" ? [{ op: "precheck", check: claims }] : []\n',
				replacement: "\treturn []\n",
				why: "A raw fact of another child's is written: an assignment, an event, a session or an item outside the claims is accepted where it is outsideWorld."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: "\t\t\tprecheckMember(stratum, unit.relation, source, unit.claims)\n",
				replacement: "",
				why: "A unit delete is held to nothing: a delete of another child's session, from raw facts or from a class's enrolment, removes it and every row nested under it where it is outsideWorld."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original:
					'\t\t\t\t\t\t)\n\t\t\t\t\t\tprecheckMember(stratum, relation, { kind: "slot", input: slot.input }, claims)\n',
				replacement:
					'\t\t\t\t\t\t)\n\t\t\t\t\t\tif (op !== "delete") {\n\t\t\t\t\t\t\tprecheckMember(stratum, relation, { kind: "slot", input: slot.input }, claims)\n\t\t\t\t\t\t}\n',
				why: "A family member's delete is held to nothing: another child's item is removed where its delete is outsideWorld."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: "\t\t\tclaims: claimsOf(written.name, entry.entry),\n",
				replacement: "\t\t\tclaims: noCheck,\n",
				why: "A write through a query entry over a member is held to the entry alone: a first mark of another child's sitting through Firsts is accepted where it is outsideWorld."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: "\t\t\tclaims: claimsOf(written.name, entry.entry),\n",
				replacement: "\t\t\tclaims: claimsOf(written.name, EntryName(written.name)),\n",
				why: "A write through a query entry refused outside the world names its relation, which the role writes by no such name: the refusal is no outsideWorld the role's witness reads, but a failure."
			},
			{
				file: "packages/engine/src/ir/derived.ts",
				original:
					"\t\t\treturn restriction?.owner.unit === unit && restriction.on.some((p) => p.left === column)",
				replacement: "\t\t\treturn true",
				why: "A write whose child a relation of no unit gives is proven inside the claims: an assign of a class's children writes another child's assignment where it is outsideWorld."
			},
			{
				file: "packages/engine/src/physical/derived/definition.ts",
				original:
					"\t\trows: {\n\t\t\t...options.role.world.base.rows(options.role.writable),\n\t\t\tworld: options.role.worldRows()\n\t\t}\n",
				replacement: "\t\trows: options.role.world.base.rows(options.role.writable)\n",
				why: "A query entry's view reads its member in reality's world, every child's rows: a student's Firsts holds another child's first mark."
			}
		]
	}
)

/**
 * Every scan of a member in every statement a scoped role's reads send binds the unit's key in its index condition, as
 * PostgreSQL plans it under the advice the read carries: each read compiled as a served Db of the role compiles it
 * (test/support/advice.ts servedRead) and planned on the role's own session, its claims in force, in a transaction
 * rolled back after it, the plan laws held over it (plannedScope, lawsOver), and each scan of a member's table among its
 * plans holding the member's child, or one of its keys whole, in its index condition: a claims-scoped read probes by
 * the child wherever it reads a member, inside every derivation.
 */
export const everyScanOfAMemberUnderAScopeProbesByTheUnitsKey = property.explore(claimsCaseGen, {
	needs: { claims: Substrate.fresh(claimsTemplate) },
	situations: [],
	check:
		({ claims }) =>
		(c: ClaimsCase) =>
			Effect.scoped(
				Effect.flatMap(claims, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const m = taken.value.installed
							const { app, student, coach, members, reads, firsts } = claimsAt(m.declared)
							const s = yield* Substrate
							const names = namesOf(m)
							const role = c.claims.role === "student" ? student : coach
							const served = c.claims.role === "student" ? app.roles.student : app.roles.coach
							const session = yield* s.session({
								...worldSession(m.world(role), {
									kind: "document",
									text: jsonText({ Session: { sub: subOf(c.claims) } })
								}),
								label: `planning ${c.claims.role}`
							})
							/** Each member's table, by the qualified name a plan's scan names it by, with its `child` column and each
							 * of its keys without one. */
							const tables = new Map<
								string,
								{ readonly child: string; readonly keys: ReadonlyArray<ReadonlyArray<string>> }
							>(
								Arr.map(members, (member) => {
									const q = m.installation.names.relation(member.relation.name)
									return [
										`${q.schema}.${q.name}`,
										{
											child: names.columnIdent(member.relation, "child"),
											keys: Arr.map(member.keys, (k) =>
												Arr.map(k, (f) => names.columnIdent(member.relation, f))
											)
										}
									] as const
								})
							)
							const problems: Array<string> = []
							for (const [name, program] of Rec.toEntries({
								...reads,
								presentedOf: reads.presentedOf.clocked,
								firsts: firsts[c.claims.role]
							})) {
								const read = yield* servedRead(m, served, program, `${c.claims.role}'s ${name}`)
								const planned = yield* Effect.acquireUseRelease(
									session.values("BEGIN", []),
									() => plannedScope(session, read.scope),
									() => Effect.orDie(session.values("ROLLBACK", []))
								)
								for (const problem of lawsOver(read.scope, planned)) {
									problems.push(problem)
								}
								for (const plan of planned.plans) {
									for (const node of lawNodes(plan.root)) {
										const relation = Option.getOrElse(node.relation, () => "")
										const table = tables.get(relation)
										if (table === undefined) {
											continue
										}
										const shown = Option.getOrElse(node.alias, () => "")
										const bound = new Set(
											Arr.flatMap(
												[
													node,
													...Arr.filter(node.children, (n) => n.nodeType === "Bitmap Index Scan")
												],
												(n) =>
													Arr.flatMap(n.indexCond, (ref) =>
														ref.alias === shown ? [ref.column] : []
													)
											)
										)
										if (
											!bound.has(table.child) &&
											!Arr.some(table.keys, (k) => Arr.every(k, (col) => bound.has(col)))
										) {
											problems.push(
												`${read.scope.label}: its ${node.nodeType} of ${relation} binds ${Arr.join([...bound], ", ")} in its index condition, neither ${table.child} nor a whole key`
											)
										}
									}
								}
							}
							assert.deepEqual(
								problems,
								[],
								`every read of the ${c.claims.role} plans as it carries and probes each member by its child`
							)
						}),
						Substrate,
						taken.substrate
					)
				)
			),
	oracle: {
		kind: "postgresql",
		name: "PostgreSQL 19's plans of each read under the advice it carries, on the role's session: its generated advice, its feedback on the supplied, and each member scan's index condition against the unit's key"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
			original:
				'\t\t\tcase "SemiJoin":\n\t\t\t\treturn restrictedByValues(node.left) || semiJoinDriven(node) !== undefined\n',
			replacement: '\t\t\tcase "SemiJoin":\n\t\t\t\treturn restrictedByValues(node.left)\n',
			why: "The owner, a sign-in read at the claims' key, is no set the claims restrict: each member is read whole and tested against it row by row, a scan that binds no child."
		},
		{
			file: "packages/engine/src/ir/derived.ts",
			original: '\t\tif (node.kind === "Base") {\n\t\t\treturn worldBase(node)\n\t\t}\n',
			replacement: "",
			why: "A member is read whole, its child bound by no index condition."
		}
	]
})
