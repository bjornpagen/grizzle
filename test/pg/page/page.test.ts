/**
 * The page runtime through the readers.
 *
 * The traversal property, that windows walked from the start and from the end at every size 1 through 7 concatenate to
 * the complete sorted distinct result D and that each window's attachments read exactly its rows' children, is
 * test/pg/page/generated.ts's, over generated ordered queries, minus the transaction and the handles. Here the Paging
 * fixture installs under a fresh schema and opens through Db.open and its login's served file as its full world, every
 * ordered query a paged member of its workload, exactly as an application reads windows, and its unpaged member beside
 * it, whose read is D:
 *
 * - every window answers exactly by the D of the moment and its anchor's values, through the query's paged member or
 *   its twin, another member paging the same query, whatever happened to D since the anchor's row was read: over drawn
 *   facts, a drawn query of the fixture and a walk of drawn windows, each anchored at the key of a row some earlier
 *   window delivered, through either member, with drawn changes to D between them (deleting an anchor's task, moving it,
 *   deleting the last window's tasks, inserting, flagging, emptying the account), each written as the facts' whole new
 *   state in one transaction that reads nothing (test/support/substrate/replace.ts), so no reset is an SSI pivot under
 *   load. A start window holds D's first k rows and an end window its last k; an after window the first k rows strictly
 *   after the anchor's values, a before window the last k strictly before them, whether or not a row of the anchor is
 *   still in D; every window in D's order. Each window is one flight carrying its one statement;
 * - a window input that is not exactly its params, no facts and a window of an anchor and a size, its size a safe integer
 *   of at least 1, its anchor of its kind and a key of one admitted value per comparator, is refused before any SQL: the
 *   call's error is the input refusal of its fault, and the Db's sessions send nothing; every other input reads its
 *   window in one flight;
 * - a window size has no upper bound: a walk's windows draw sizes up to the largest safe integer, which the statement
 *   binds as a bigint limit.
 *
 * test/pg/page/values.test.ts covers the boundary values, test/pg/page/plans.test.ts the plans, and
 * test/pg/page/generated.ts the generated ordered queries.
 *
 * Oracle: the specification of a window, D of the moment and the anchor's values, which the drawn facts and the walk's
 * own writes state, D read by the query's unpaged member; and the window rule restated, with no flight counted.
 *
 * Features: each query through each member, each anchor kind, the anchors the walk names, and each input refusal. A
 * drawn input reaches its key's own refusal only past every earlier check, about one input in a hundred, so a case
 * whose turn aims at one draws an input every check before its key admits, carrying the refused key (keyAims).
 */

import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { CallInputRefused } from "#adapter/errors/failures.ts"
import { readCallError } from "#adapter/live/call-error.ts"
import { type Anchor, keyOf } from "#compiler/live/index.ts"
import {
	A,
	anchorOf,
	B,
	type Delivered,
	expectedOf,
	type Handle,
	inputFacts,
	type InputFeature,
	inputOf,
	inputSketchGen,
	keyAims,
	memberName,
	type ModelTask,
	pagedMembers,
	pagedQueryNames,
	pagingInstall,
	pagingTemplate,
	params,
	t,
	tasksOf,
	titleOf,
	type WalkFeature,
	walkSketchGen
} from "#test/pg/page/page.fixtures.ts"
import {
	canon,
	holdsKey,
	pageTemplate,
	sortedResult,
	strictlyAfter,
	strictlyBefore,
	windowOf
} from "#test/pg/page/support.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { readOnce } from "#test/support/calls.ts"
import { replaceMigrated as replace } from "#test/support/install-migrate.ts"
import { pickIndex } from "#test/support/pick.ts"
import { recordingContext } from "#test/support/plans.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { Paging } from "#test/unit/page/fixtures.ts"

/**
 * The page runtime through the readers answers every window by the D of the moment and its anchor's values, through either member, whatever changed since its anchor's row was read, each window one flight.
 *
 * Its pre-conversion budget: runs 100, coverage cases 100 (test/pg/page/page.test.ts at 8ad8d5b2c).
 */
export const thePageRuntimeThroughTheReadersAnswersEveryWindowByTheDOfTheMomentAndItsAnchorsValuesThroughEitherMemberWhateverChangedSinceItsAnchorsRowWasReadEachWindowOneFlight =
	property.explore(walkSketchGen, {
		needs: { seated: Substrate.seat(pagingTemplate) },
		situations: [
			...Arr.map(pagedQueryNames, (q): WalkFeature => `query ${q}`),
			...Arr.flatMap(["start", "end", "after", "before"] as const, (kind) =>
				Arr.map(
					["member", "twin"] as const,
					(handle): WalkFeature => `${kind} through the ${handle}`
				)
			),
			"an anchor of the other member's row",
			"an anchor gone from D",
			"an anchor still in D",
			"rows past a gone anchor",
			"an empty anchored window",
			"an emptied D",
			"a write between windows"
		] satisfies ReadonlyArray<Reached<WalkFeature>>,
		check:
			({ seated }, c: Case<WalkFeature>) =>
			(walk) =>
				Effect.flatMap(seated, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const opened = yield* openedIn(Paging, {}, pagingInstall, taken)
							const { ctx: dbCtx, load } = yield* openServedDb(
								opened.installed,
								opened.server.roles.app,
								{}
							)
							const loaded = yield* load(pagedMembers)
							const recording = recordingContext(dbCtx)
							return yield* Effect.gen(function* () {
								/** A paged member's calls, their flights counted. */
								const pagedCalls = (handle: Handle) =>
									memberCalls(recording.ctx, member(loaded, memberName(walk.query, handle)))
								const unpaged = memberCalls(
									dbCtx,
									member(loaded, memberName(walk.query, "unpaged"))
								)
								const compiled = pageTemplate(
									member(loaded, memberName(walk.query, "member")),
									opened.installed.names.codes
								)
								/** The facts: the drawn tasks, a note pair once, a flag per task. */
								const model: Array<ModelTask> = Arr.map(walk.tasks, (x, n) => ({
									id: t(n),
									account: x.other ? B : A,
									priority: x.priority,
									title: titleOf(x.title),
									flag: "none"
								}))
								for (const f of walk.flags) {
									if (model.length > 0) {
										const at = pickIndex(f.task, model.length)
										model[at] = { ...defined(model[at]), flag: f.high ? "High" : "Low" }
									}
								}
								const notes = new Map<string, { readonly task: string; readonly note: string }>()
								for (const n of walk.notes) {
									if (model.length > 0) {
										const owner = defined(model[pickIndex(n.task, model.length)]).id
										notes.set(`${owner} ${n.note}`, { task: owner, note: `note ${n.note}` })
									}
								}
								/**
								 * D's facts as the model holds them when it runs: its tasks, the notes of the tasks it
								 * still holds, its flags.
								 */
								const writeModel = Effect.suspend(() =>
									replace(opened.installed, {
										Task: Arr.map(model, (x) => ({
											id: x.id,
											account: x.account,
											priority: x.priority,
											title: x.title
										})),
										Note: Arr.filter([...notes.values()], (n) =>
											Arr.some(model, (x) => x.id === n.task)
										),
										Flag: Arr.flatMap(model, (x) =>
											x.flag === "none" ? [] : [{ task: x.id, level: x.flag }]
										)
									})
								)
								yield* writeModel
								let fresh = walk.tasks.length
								const pool: Array<Delivered> = []
								let last: ReadonlyArray<Delivered> = []
								for (const step of walk.steps) {
									/** The writes, each resolved against the model. */
									const targets = (pick: number): ReadonlyArray<string> => {
										const marked = [
											...new Set(Arr.flatMap(pool, (d) => tasksOf(walk.query, d.row, model)))
										]
										const candidates =
											marked.length > 0
												? marked
												: Arr.map(
														Arr.filter(model, (x) => x.account === A),
														(x) => x.id
													)
										if (candidates.length === 0) {
											return []
										}
										const chosen = defined(candidates[pickIndex(pick, candidates.length)])
										return Option.match(
											Arr.findFirst(pool, (d) =>
												tasksOf(walk.query, d.row, model).includes(chosen)
											),
											{
												onNone: () => [chosen],
												onSome: (row) => tasksOf(walk.query, row.row, model)
											}
										)
									}
									/** A removed task takes its notes and its flag with it. */
									const remove = (ids: ReadonlyArray<string>) => {
										for (const i of ids) {
											const at = Arr.findFirstIndex(model, (x) => x.id === i)
											if (Option.isSome(at)) {
												model.splice(at.value, 1)
											}
										}
									}
									/** Each target task, changed in place in the model. */
									const update = (
										ids: ReadonlyArray<string>,
										change: (task: ModelTask) => ModelTask
									) => {
										for (const i of ids) {
											const at = Option.getOrThrow(Arr.findFirstIndex(model, (x) => x.id === i))
											model[at] = change(defined(model[at]))
										}
									}
									for (const write of step.writes) {
										switch (write.kind) {
											case "delete a row's tasks":
												remove(targets(write.target))
												break
											case "delete the last window":
												remove([
													...new Set(Arr.flatMap(last, (d) => tasksOf(walk.query, d.row, model)))
												])
												break
											case "empty the account":
												remove(
													Arr.map(
														Arr.filter(model, (x) => x.account === A),
														(x) => x.id
													)
												)
												break
											case "move a row's tasks":
												update(targets(write.target), (task) => ({
													...task,
													priority: write.priority,
													title: titleOf(write.title)
												}))
												break
											case "insert":
												model.push({
													id: t(fresh++),
													account: write.task.other ? B : A,
													priority: write.task.priority,
													title: titleOf(write.task.title),
													flag: "none"
												})
												break
											case "flag":
												update(targets(write.target), (task) => ({
													...task,
													flag: write.level
												}))
												break
										}
									}
									if (step.writes.length > 0) {
										yield* writeModel
									}
									if (step.writes.length > 0 && pool.length > 0) {
										c.note("a write between windows")
									}
									/** The window, anchored at a delivered row's key when it names one and one exists. */
									const w = step.window
									const anchorRow =
										w.kind === "after" || w.kind === "before"
											? anchorOf(w.anchor, last, pool)
											: Option.none<Delivered>()
									const anchor: Anchor = Option.match(anchorRow, {
										onNone: () =>
											w.kind === "start" || w.kind === "after"
												? { kind: "start" }
												: { kind: "end" },
										onSome: (row) =>
											w.kind === "after"
												? { kind: "after", key: row.key }
												: { kind: "before", key: row.key }
									})
									const flights = recording.counts.flights
									const statements = recording.counts.statements
									const answered = yield* windowOf(pagedCalls(w.handle), params, anchor, w.size)
									assert.deepEqual(
										[recording.counts.flights - flights, recording.counts.statements - statements],
										[1, 1],
										`a ${anchor.kind} window is one flight of one statement`
									)
									/** The oracle: D now, and the anchor's values. */
									const rows = yield* readOnce(unpaged)({ params, facts: {} })
									const full = sortedResult(compiled, rows)
									const k = w.size
									const expected = ((): ReadonlyArray<unknown> => {
										switch (anchor.kind) {
											case "start":
												return full.slice(0, k)
											case "end":
												return full.slice(Math.max(0, full.length - k))
											case "after":
												return strictlyAfter(compiled, rows, anchor.key).slice(0, k)
											case "before": {
												const before = strictlyBefore(compiled, rows, anchor.key)
												return before.slice(Math.max(0, before.length - k))
											}
										}
									})()
									const presented: ReadonlyArray<unknown> = Arr.map(answered, canon)
									assert.deepEqual(
										presented,
										expected,
										`${anchor.kind} ${k} through the ${w.handle}`
									)
									c.note(`query ${walk.query}`)
									c.note(`${anchor.kind} through the ${w.handle}`)
									if (Option.isSome(anchorRow)) {
										const gone = !holdsKey(compiled, rows, anchorRow.value.key)
										c.note(gone ? "an anchor gone from D" : "an anchor still in D")
										if (gone && expected.length > 0) {
											c.note("rows past a gone anchor")
										}
										if (expected.length === 0) {
											c.note("an empty anchored window")
										}
										if (full.length === 0) {
											c.note("an emptied D")
										}
										if (anchorRow.value.handle !== w.handle) {
											c.note("an anchor of the other member's row")
										}
									}
									last = Arr.map(answered, (row) => ({
										key: keyOf(compiled.fields, row),
										row,
										handle: w.handle
									}))
									appendAll(pool, last)
								}
							}).pipe(Effect.scoped)
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "D of the moment and the anchor's values, as the walk's own writes state them"
		},
		budget: { runs: 100, steered: 100 },
		kept: [],
		kills: []
	})

/**
 * The page runtime through the readers refuses every window input but exactly its params, no facts and a window of an anchor and a size before any SQL, and reads every other in one flight.
 *
 * Its pre-conversion budget: runs 200, coverage cases 200 (test/pg/page/page.test.ts at 8ad8d5b2c).
 */
export const thePageRuntimeThroughTheReadersRefusesEveryWindowInputButExactlyItsParamsNoFactsAndAWindowOfAnAnchorAndASizeBeforeAnySQLAndReadsEveryOtherInOneFlight =
	property.explore(aimed(inputSketchGen, keyAims), {
		needs: { seated: Substrate.seat(pagingTemplate) },
		situations: [
			...Arr.map(pagedQueryNames, (q): InputFeature => `query ${q}`),
			"envelope",
			"facts",
			"window",
			"size",
			"anchor",
			"admitted",
			"a key of another length",
			"a key value no codec admits"
		] satisfies ReadonlyArray<Reached<InputFeature>>,
		check:
			({ seated }, notes: Case<InputFeature>) =>
			(c) =>
				Effect.flatMap(seated, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const opened = yield* openedIn(Paging, inputFacts, pagingInstall, taken)
							const { ctx: dbCtx, load } = yield* openServedDb(
								opened.installed,
								opened.server.roles.app,
								{}
							)
							const loaded = yield* load(pagedMembers)
							const recording = recordingContext(dbCtx)

							const paging = member(loaded, memberName(c.query, "member"))
							const calls = memberCalls(recording.ctx, paging)
							const compiled = pageTemplate(paging, opened.installed.names.codes)
							const [first] = yield* windowOf(calls, params, { kind: "start" }, 1)
							const row = keyOf(compiled.fields, defined(first, "a row of D"))
							const expected = expectedOf(c)
							const flights = recording.counts.flights
							const statements = recording.counts.statements
							const answer = yield* Effect.result(readOnce(calls)(inputOf(c, row)))
							const sent = [
								recording.counts.flights - flights,
								recording.counts.statements - statements
							]
							if (expected.verdict === "admitted") {
								assert.ok(Result.isSuccess(answer), Formatter.format(answer))
								assert.deepEqual(sent, [1, 1], "one flight of one statement")
							} else {
								assert.deepEqual(
									answer,
									Result.fail(
										readCallError(
											new ReadFailure({
												reason: new CallInputRefused({ fault: expected.verdict })
											})
										)
									),
									expected.verdict
								)
								assert.deepEqual(sent, [0, 0], "no SQL")
							}
							notes.noteAll(expected.reached)
							notes.note(`query ${c.query}`)
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "the window rule restated, a refusal sending no flight and every other input one"
		},
		budget: { runs: 200, steered: 200 },
		kept: [],
		kills: []
	})
