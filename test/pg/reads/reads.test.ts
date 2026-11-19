/**
 * Reads through Db: workload members over the worked example's Work, served through its login's served file and run
 * through Db.open and a DbLayer, exactly as an application reads. get over keys and queries, attachments stitched
 * by parent key and the encoding refusal are the public-boundary differential's (test/pg/oracle/public), over generated
 * programs. Here, as properties:
 *
 * - a relation parameter is a set of facts, as an array or as a Stream: a repeated fact is one, an absent key matches
 *   nothing, and an input of 250,000 distinct facts, past any bound of rows, is read like a small one;
 * - a heterogeneous union over drawn facts is delivered merged on its completed order, its take the first k;
 * - a union's heading groups and an attachment's statements read one snapshot: with a commit landing between two of
 *   their statements at a drawn interleaving point (the table whose lock the read waits on), the read answers as the
 *   database stood before the commit or after it, never a mix.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Fiber, Layer, Option, Order, Stream } from "effect"
import { Db } from "#adapter/public/db.ts"
import { indices } from "#compiler/core/array.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import {
	accountTaskNotes,
	answer,
	byIdText,
	largeInput,
	payloadRows,
	plain,
	relationCaseGen,
	type RelationFeature,
	snapshotCaseOf,
	type SnapshotFeature,
	snapshotSketches,
	stored,
	unionCaseGen,
	type UnionFeature,
	unionMember,
	unionMembers,
	uuidAt,
	waitingOn,
	waits,
	workFactsOf,
	workTables
} from "#test/pg/reads/reads.fixtures.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { readOnce, rowsOf } from "#test/support/calls.ts"
import { exactValue } from "#test/support/equivalence.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { workFacts } from "#test/support/fixtures/golden/work.ts"
import { replaceMigrated as replace } from "#test/support/install-migrate.ts"
import { namesOf, parsedName } from "#test/support/kernel/naming.ts"
import { pickIndex } from "#test/support/pick.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * Reads through Db a relation parameter is a set of facts as an array or a Stream, of any number of facts.
 *
 * Its pre-conversion budget: runs 60, coverage cases 60 (test/pg/reads/reads.test.ts at 8ad8d5b2c).
 */
export const readsThroughDbARelationParameterIsASetOfFactsAsAnArrayOrAStreamOfAnyNumberOfFacts =
	property.explore(relationCaseGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"an array",
			"a Stream",
			"a repeated fact",
			"an absent key",
			"no fact",
			"a large input"
		] satisfies ReadonlyArray<Reached<RelationFeature>>,
		check:
			({ substrate }, notes: Case<RelationFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const opened = yield* installed(W.Work, workFacts, {
							label: "real",
							programs: { tasksById: W.tasksById }
						})
						const sessions = yield* Layer.build(opened.served.layer)
						const db = yield* Db.open(opened.served.login.roles.app, {}).pipe(
							Effect.provideContext(sessions)
						)

						const distinct = c.size.kind === "small" ? c.size.n : largeInput
						/**
						 * The distinct keys: some of the stored tasks', the rest absent; then repeats of the first.
						 */
						const present = Math.min(distinct, pickIndex(c.present, stored.length + 1))
						const keys = Arr.map(indices(distinct), (n) =>
							n < present ? defined(stored[n]).id : uuidAt(0xff, n)
						)
						const facts = Arr.map(
							[
								...keys,
								...Array.from({ length: keys.length === 0 ? 0 : c.repeats }, () => defined(keys[0]))
							],
							(id) => ({ id })
						)
						const outcome = yield* Effect.result(
							rowsOf(
								db.workload.tasksById.once({
									params: {
										ids: c.stream ? Stream.fromIterable(facts) : facts
									},
									facts: {}
								})
							)
						)
						unorderedEqual(
							Arr.map(succeeded(outcome, `${distinct} facts read`), plain),
							Arr.map(
								Arr.filter(stored, (x) => keys.includes(x.id)),
								(x) => ({ id: x.id, kind: x.kind })
							)
						)
						if (distinct === largeInput) {
							notes.note("a large input")
						}
						notes.note(c.stream ? "a Stream" : "an array")
						if (facts.length > distinct) {
							notes.note("a repeated fact")
						}
						if (distinct > present) {
							notes.note("an absent key")
						}
						if (distinct === 0) {
							notes.note("no fact")
						}
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "a relation parameter as a set: the stored tasks its distinct keys name, whatever repeats or absent keys it holds"
		},
		budget: { runs: 60, steered: 60 },
		kept: [],
		kills: []
	})

/**
 * Reads through Db a heterogeneous union over drawn facts is delivered merged on its completed order, its take the first k.
 *
 * Its pre-conversion budget: runs 60, coverage cases 60 (test/pg/reads/reads.test.ts at 8ad8d5b2c).
 */
export const readsThroughDbAHeterogeneousUnionOverDrawnFactsIsDeliveredMergedOnItsCompletedOrderItsTakeTheFirstK =
	property.explore(unionCaseGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"ascending",
			"descending",
			"a take",
			"no take",
			"an empty group",
			"a take past the union"
		] satisfies ReadonlyArray<Reached<UnionFeature>>,
		check:
			({ substrate }, notes: Case<UnionFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						let group = 0
						return yield* Effect.gen(function* () {
							const opened = yield* installed(W.Work, {}, { label: "real", programs: {} })
							const { serve } = yield* openServedDb(opened.installed, opened.server.roles.app, {})
							const unions = yield* serve(unionMembers)

							const facts = workFactsOf(group++, c.accounts, c.tasks)
							yield* replace(opened.installed, facts)
							const rows = payloadRows(facts)
							const sorted = Arr.sort(rows, c.descending ? Order.flip(byIdText) : byIdText)
							const got = yield* readOnce(member(unions, unionMember(c)))({
								params: {},
								facts: {}
							})
							if (c.take.kind === "none") {
								assert.deepEqual(Arr.map(got, plain), sorted)
							} else {
								assert.deepEqual(Arr.map(got, plain), sorted.slice(0, c.take.k))
								if (c.take.k > rows.length) {
									notes.note("a take past the union")
								}
							}
							notes.note(c.descending ? "descending" : "ascending")
							notes.note(c.take.kind === "none" ? "no take" : "a take")
							if (facts.AutomaticTask.length === 0 || facts.ManualTask.length === 0) {
								notes.note("an empty group")
							}
						}).pipe(Effect.scoped)
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "the union's rows sorted on its completed order, the first k of them under a take"
		},
		budget: { runs: 60, steered: 60 },
		kept: [],
		kills: []
	})

/**
 * Reads through Db a union's heading groups and an attachment's statements read one snapshot wherever a commit lands between them.
 *
 * Its pre-conversion budget: runs 24, coverage cases 24 (test/pg/reads/reads.test.ts at 8ad8d5b2c).
 */
export const readsThroughDbAUnionsHeadingGroupsAndAnAttachmentsStatementsReadOneSnapshotWhereverACommitLandsBetweenThem =
	property.explore(steered(snapshotSketches), {
		needs: { substrate: Substrate.installing },
		situations: [
			...Arr.map(waits, waitingOn),
			"read the state before the commit"
		] satisfies ReadonlyArray<Reached<SnapshotFeature>>,
		check:
			({ substrate }, notes: Case<SnapshotFeature>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						let group = 0
						return yield* Effect.gen(function* () {
							const s = yield* Substrate
							const opened = yield* installed(W.Work, workFacts, {
								label: "real",
								programs: { taskPayloads: W.taskPayloads, accountTaskNotes }
							})
							const names = namesOf(opened.installed)
							/** Kind's codes: a closed id is stored as its handle's code. */
							const kinds = defined(
								opened.installed.names.codes.rosters.get(parsedName("Kind")),
								"the codes of Kind"
							)
							/**
							 * The Db's sessions log in as the login's role, which pg_stat_activity reports whatever role a
							 * transaction enters.
							 */
							const role = opened.installed.as(opened.server).role
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(opened.served.login.roles.app, {})
								const reads = {
									union: rowsOf(db.workload.taskPayloads.once({ params: {}, facts: {} })),
									attachment: rowsOf(db.workload.accountTaskNotes.once({ params: {}, facts: {} }))
								}
								const resolved = snapshotCaseOf(sketch)
								const { wait, deletes } = resolved
								return yield* Effect.gen(function* () {
									const preRead = yield* reads[wait.read]
									const pre = answer(preRead)
									const g = group++
									const account = uuidAt(0x40 + g, 0)
									const automatic = uuidAt(0x40 + g, 1)
									const manual = uuidAt(0x40 + g, 2)
									const holder = yield* s.session({ ...ownerSession(), label: "holder" })
									yield* holder.begin
									yield* holder.query(
										`LOCK TABLE ${names.table(wait.table)} IN ACCESS EXCLUSIVE MODE`,
										[]
									)
									const reading = yield* Effect.forkChild(reads[wait.read], {
										startImmediately: true
									})
									const pid = holder.pid
									yield* s.awaitBlockedBy(pid, role)
									/**
									 * The newest tasks of the previous case, if any, leave with what hangs on them.
									 */
									const n = (relation: (typeof workTables)[number]) => names.table(relation)
									yield* holder.query(
										`INSERT INTO ${n(W.Account)} (${names.column(W.Account, "id")}, ${names.column(W.Account, "name")}) VALUES ($1::uuid, $2::text)`,
										[account, `committed ${g}`]
									)
									yield* holder.query(
										`INSERT INTO ${n(W.Task)} (${names.column(W.Task, "id")}, ${names.column(W.Task, "account")}, ${names.column(W.Task, "kind")}) VALUES ($1::uuid, $3::uuid, $4::smallint), ($2::uuid, $3::uuid, $5::smallint)`,
										[
											automatic,
											manual,
											account,
											String(codeOf(kinds, "Automatic")),
											String(codeOf(kinds, "Manual"))
										]
									)
									yield* holder.query(
										`INSERT INTO ${n(W.AutomaticTask)} (${names.column(W.AutomaticTask, "task")}, ${names.column(W.AutomaticTask, "budget")}) VALUES ($1::uuid, 100)`,
										[automatic]
									)
									yield* holder.query(
										`INSERT INTO ${n(W.ManualTask)} (${names.column(W.ManualTask, "task")}, ${names.column(W.ManualTask, "operator")}) VALUES ($1::uuid, 'Uma')`,
										[manual]
									)
									yield* holder.query(
										`INSERT INTO ${n(W.TaskNote)} (${names.column(W.TaskNote, "task")}, ${names.column(W.TaskNote, "note")}) VALUES ($1::uuid, 'committed')`,
										[manual]
									)
									if (deletes) {
										/** The previous case's automatic and manual task, each with what hangs on it. */
										const gone = [uuidAt(0x40 + g - 1, 1), uuidAt(0x40 + g - 1, 2)]
										const deleteGone = (
											table: typeof W.TaskNote | typeof W.AutomaticTask | typeof W.ManualTask
										) =>
											holder.query(
												`DELETE FROM ${names.table(table)} WHERE ${names.column(table, "task")} IN ($1::uuid, $2::uuid)`,
												gone
											)
										yield* deleteGone(W.TaskNote)
										yield* deleteGone(W.AutomaticTask)
										yield* deleteGone(W.ManualTask)
										yield* holder.query(
											`DELETE FROM ${names.table(W.Task)} WHERE ${names.column(W.Task, "id")} IN ($1::uuid, $2::uuid)`,
											gone
										)
									}
									yield* holder.commit
									const joined = yield* Fiber.join(reading)
									const got = answer(joined)
									const postRead = yield* reads[wait.read]
									const post = answer(postRead)
									assert.notDeepEqual(pre, post, "the commit changes the answer")
									const state = Option.isNone(exactValue(got, pre))
										? "read the state before the commit"
										: Option.isNone(exactValue(got, post))
											? "read the state after the commit"
											: "a mix"
									if (state === "a mix") {
										return assert.fail(
											`${waitingOn(wait)} read neither the state before the commit nor the one after it`
										)
									}
									notes.note(waitingOn(wait))
									notes.note(state)
								}).pipe(Effect.scoped)
							}).pipe(Effect.scoped, withLayer(opened.served.layer))
						}).pipe(Effect.scoped)
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "the read's answer is the database before the commit or after it, each read alone, never a mix"
		},
		budget: { runs: 24, steered: 24 },
		kept: [],
		kills: []
	})
