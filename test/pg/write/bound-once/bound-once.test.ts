/**
 * A relation parameter a ChangeSet binds to a query is an input of the call scoped to the ChangeSet it was bound on, as a
 * let is to its body: evaluated once in the state before that ChangeSet's first stratum, and every member and read-back
 * of it that reads it reads that one evaluation (README "Writes", ChangeSetDesc `boundRows`, ir/write.ts BoundInput),
 * on PostgreSQL 19: bound on the whole call, a later stratum and a read-back read the rows the bound query had before
 * the change, never the query evaluated again over the state they run in; bound on a part sequenced after another, its
 * rows are the query's after the earlier part's writes.
 *
 * Schema: Item(id), Mark(id), Log(id), each keyed by its id. `target` is bound to the items no mark holds, so a mark the
 * call adds takes its item out of the target.
 *
 * The space, drawn: the stored items, a nonempty subset of 1..4, and marks, a subset; the first stratum marks the
 * target's items or drawn ids; the target logged in the first stratum, in a second one sequenced after it, or nowhere;
 * a read-back `picked`, declared by the last part, of the target alone, of the target's items the change marked
 * (delta.added(Mark) joined to `target`, riding the first stratum's statement that makes it), or none; and `target`
 * bound once on the whole ChangeSet, or by each sequenced part that reads it. Read only by members of the stratum it is
 * evaluated before, a binding is a part of their queries; read by a later stratum or a read-back, it is carried, filled
 * once into a carrier first among that stratum's statements: both arms are drawn, at the first stratum and at the
 * second. Each case loads its state on a clone of the template and applies its ChangeSet once.
 *
 * Property, per case: the Description holds one binding of `target` on the whole, at stratum 0, and one for each part
 * that reads it on each part, the second's at stratum 1; the call commits and Mark, Log and `picked` are the model's
 * (bound-once.fixtures.ts modelOf), where the last part's read-back of the first stratum's delta reads the second
 * part's binding, not yet evaluated where the delta is made, among them: it runs after the writes, its delta carried out
 * of the first stratum's statement (write/schedule/plan.ts placeReadBacks). Oracle: specification, the model, each binding evaluated once, before its
 * part's first stratum. Kills: each sequenced part's binding evaluated before the call's first stratum, by the
 * ChangeSet (sequence placing it at the combination's stratum 0) and by the plan (every fill before the first
 * stratum), so the second part reads the target before the first stratum's marks; and each reader reading its own copy
 * of every binding, so a later stratum and a read-back evaluate it again over the state they run in.
 *
 * And `target` over the items alone, which no stratum of the call writes, every state of the call reading one target:
 * such a binding is a part of every reader's query, carried in no carrier, where a binding over the unmarked items is
 * carried exactly where a reader reads a state after the marks (bound-once.fixtures.ts carriedBindings; write/frontend/
 * compile.ts `agrees`): metis's assign's target test, a read of the catalog the assign never writes (edullm Q14).
 *
 * Features: each way of marking, logging, reading and binding; each target; a later part's binding that reads the
 * earlier part's writes; a binding read after the first stratum whose re-evaluation reads another target; the
 * read-back carried past its part's later binding; a binding read where the call writes none of what it reads.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, Record as Rec, Result } from "effect"
import { changeApplication, variantOf } from "#adapter/db/handles.ts"
import { hasProperties } from "#compiler/core/record.ts"
import { changeSetDesc } from "#compiler/write/changeset/value.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	boundStrata,
	callFactsOf,
	carriedBindings,
	carriedPastBinding,
	changeOf,
	Item,
	laterPartSees,
	Log,
	Mark,
	modelOf,
	Once,
	onceGen,
	onceInstall,
	onceTemplate,
	reevaluationDiffers,
	type Situation,
	situations,
	skipChangeOf,
	skipGen,
	skipModelOf,
	type SkipSituation,
	skipSituations,
	twoParts as twoPartsOf,
	unskippedTarget
} from "#test/pg/write/bound-once/bound-once.fixtures.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A delivered row of `picked` as the property compares it, its id, or a failure naming what it is. */
const pickedId = (row: unknown): number =>
	hasProperties(row) && typeof row["id"] === "number"
		? row["id"]
		: assert.fail(`a row of picked, not ${Formatter.format(row)}`)

/** A relation parameter bound to a query is read once, before the first stratum of the part it is bound on, by every stratum and read-back of that part that reads it. */
export const aRelationParameterBoundToAQueryIsReadOnceBeforeThePartItIsBoundOnByEveryStratumAndReadBackThatReadsIt =
	property.explore(onceGen, {
		needs: { fixture: Substrate.fresh(onceTemplate) },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ fixture }, k: Case<Situation>) =>
			(c) =>
				Effect.scoped(
					Effect.gen(function* () {
						k.note(c.marked)
						k.note(c.logged)
						k.note(c.read)
						k.note(c.bound)
						k.note(c.over)
						if (c.over === "the items" && (twoPartsOf(c) || c.read !== "no read-back")) {
							k.note("a binding read where the call writes none of what it reads")
						}
						if (laterPartSees(c)) {
							k.note("a later part's binding, after the earlier part's writes")
						}
						if (reevaluationDiffers(c)) {
							k.note("a binding read after the first stratum, its re-evaluation another target")
						}
						if (carriedPastBinding(c)) {
							k.note("a read-back carried past its part's later binding")
						}
						const seat = yield* fixture
						const opened = yield* openedIn(
							Once,
							{
								Item: Arr.map(c.items, (id) => ({ id })),
								Mark: Arr.map(c.marks, (id) => ({ id })),
								Log: []
							},
							onceInstall,
							seat
						)
						const admin = seat.substrate.admin
						const names = namesOf(opened.installed)
						const change = changeOf(c)
						const boundRows = defined(changeSetDesc(change), "a ChangeSet's Description").boundRows
						assert.deepEqual<ReadonlyArray<number>>(
							Arr.sort(
								Arr.map(Rec.values(boundRows), (b) => b.stratum),
								Order.Number
							),
							boundStrata(c),
							"one input for each part that binds target, at its part's first stratum"
						)
						const model = modelOf(c)
						const outcome = yield* withServedDb(
							opened.installed,
							opened.server.roles.app,
							{},
							({ ctx, load }) =>
								Effect.gen(function* () {
									const served = yield* Effect.result(load({ bound: change }))
									if (Result.isFailure(served)) {
										return { kind: "refused" as const, refusal: served.failure }
									}
									const loaded = member(served.success, "bound")
									if (loaded.kind !== "change") {
										return yield* Effect.die(new Error("the ChangeSet loads as a change"))
									}
									const variant = variantOf(ctx, loaded.variants)
									assert.equal(
										Arr.filter(variant.entry.program.statements, (s) => s.step.kind === "carrier")
											.length,
										carriedBindings(c),
										"the program fills a carrier of target exactly where a reader reads a state the call changed on what target reads"
									)
									const applied = yield* changeApplication(
										ctx,
										variant
									)({ params: {}, facts: callFactsOf(c) })
									return { kind: "applied" as const, applied }
								})
						)
						const applied =
							outcome.kind === "applied"
								? outcome.applied
								: assert.fail(`the ChangeSet loads, not ${Formatter.format(outcome.refusal)}`)
						const reads =
							applied.kind === "accepted" || applied.kind === "no-change"
								? applied.reads
								: assert.fail(`the call commits, not ${applied.kind}`)
						/** The ids a table holds, in order. */
						const ids = (table: string) =>
							Effect.map(admin.query(`SELECT id FROM ${table} ORDER BY id`, []), (result) =>
								Arr.map(result.rows, (row) => Number(row["id"]))
							)
						const marks = yield* ids(names.table(Mark))
						const logs = yield* ids(names.table(Log))
						const items = yield* ids(names.table(Item))
						assert.deepEqual<ReadonlyArray<number>>(marks, model.mark, "Mark is the model's")
						assert.deepEqual<ReadonlyArray<number>>(
							logs,
							model.log,
							"Log is the target its part's binding read"
						)
						const picked = hasProperties(reads) ? reads["picked"] : undefined
						assert.deepEqual<ReadonlyArray<number> | undefined>(
							Arr.isArray(picked) ? Arr.sort(Arr.map(picked, pickedId), Order.Number) : undefined,
							model.picked,
							"picked reads the target its part's binding read"
						)
						assert.deepEqual<ReadonlyArray<number>>(
							items,
							Arr.sort(c.items, Order.Number),
							"no item is written"
						)
					})
				),
		oracle: {
			kind: "specification",
			name: "each binding evaluated once, before its part's first stratum: the first part's over the stored state, the second's after the first stratum's marks (bound-once.fixtures.ts modelOf)"
		},
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/changeset/value.ts",
				original:
					"\tconst { top, x, y, bound } = combined(label, a, b, extra, (first) => first.strata.length)",
				replacement: "\tconst { top, x, y, bound } = combined(label, a, b, extra, () => 0)",
				why: "A sequenced part's binding is evaluated before the call's first stratum: the second part's log and read-back read the target before the first stratum's marks, and the last part's read-back of the first stratum's delta reads that target."
			},
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original: "bound.filter((b) => b.input.stratum === s)",
				replacement: "bound.filter(() => s === 0)",
				why: "Every carried binding is filled before the first stratum: the second part's binding its read-back carries holds the target before the first stratum's marks."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original:
					"\t\t\treaderStates(name).every((state) => agrees(name, stateBefore(stratum), state)) ? [] : [name]",
				replacement:
					"\t\t\treaderStates(name).every((state) => state === stateBefore(stratum)) ? [] : [name]",
				why: "A binding is a part of its readers' queries only where each reads the very state it is evaluated in, as format 8 asked: a binding over the items, which no stratum writes, is carried past the marks, a statement and a carrier the call needs none of."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original:
					"\t\t\t.every((written) => ![...footprint].some((relation) => written.has(relation)))",
				replacement: "\t\t\t.every(() => true)",
				why: "Every binding is read the same in every state, whatever the strata between write: the second part's log and the read-back read the unmarked items again after the marks, another target than the binding's."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: "\t\t\tlater.has(name) ? [] : [[name, rows] as const]",
				replacement: "\t\t\t[[name, rows] as const]",
				why: "Each reader reads its own copy of every binding: the second stratum's log and the read-back evaluate the target again over the state they run in, after the first stratum's marks."
			}
		]
	})

/**
 * A binding's query reads the call's own relation parameter, which the caller's rows reach through every composite the
 * binding is made on: `target` bound on a union, a sequence, or a sequence of a union (metis's assign: its pick read the
 * call's `titles`) to the items no mark holds that the caller's `skip` names none of. A call's own parameter is never one
 * of a part's private ones, whatever naming the composite's parts are given (write/changeset/value.ts canonicalParts),
 * so the binding reads the rows the caller states.
 */
export const aBindingsQueryReadsTheCallsOwnRelationParameterThroughEveryCompositeItIsBoundOn =
	property.explore(skipGen, {
		needs: { fixture: Substrate.fresh(onceTemplate) },
		situations: skipSituations satisfies ReadonlyArray<Reached<SkipSituation>>,
		check:
			({ fixture }, k: Case<SkipSituation>) =>
			(c) =>
				Effect.scoped(
					Effect.gen(function* () {
						k.note(c.composed)
						k.note(
							Arr.some(c.skip, (id) => c.items.includes(id) && !c.marks.includes(id))
								? "a skipped item of the target"
								: "no item skipped"
						)
						const seat = yield* fixture
						const opened = yield* openedIn(
							Once,
							{
								Item: Arr.map(c.items, (id) => ({ id })),
								Mark: Arr.map(c.marks, (id) => ({ id })),
								Log: []
							},
							onceInstall,
							seat
						)
						const admin = seat.substrate.admin
						const names = namesOf(opened.installed)
						const applied = yield* withServedDb(
							opened.installed,
							opened.server.roles.app,
							{},
							({ ctx, load }) =>
								Effect.gen(function* () {
									const served = yield* load({ bound: skipChangeOf(c) })
									const loaded = member(served, "bound")
									if (loaded.kind !== "change") {
										return yield* Effect.die(new Error("the ChangeSet loads as a change"))
									}
									return yield* changeApplication(
										ctx,
										variantOf(ctx, loaded.variants)
									)({ params: { skip: Arr.map(c.skip, (id) => ({ id })) }, facts: {} })
								})
						)
						assert.ok(
							applied.kind === "accepted" || applied.kind === "no-change",
							`the call commits, not ${applied.kind}`
						)
						const ids = (table: string) =>
							Effect.map(admin.query(`SELECT id FROM ${table} ORDER BY id`, []), (result) =>
								Arr.map(result.rows, (row) => Number(row["id"]))
							)
						const marks = yield* ids(names.table(Mark))
						const logs = yield* ids(names.table(Log))
						const model = skipModelOf(c)
						assert.deepEqual<ReadonlyArray<number>>(
							logs,
							model.log,
							`Log is the target the caller's skip of ${Formatter.format(c.skip)} leaves, ${Formatter.format(unskippedTarget(c))}`
						)
						assert.deepEqual<ReadonlyArray<number>>(marks, model.mark, "Mark is the model's")
					})
				),
		oracle: {
			kind: "specification",
			name: "the binding evaluated once before the call's first stratum over the stored items and marks and the caller's skip: Mark the marks and that target, Log the target"
		},
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/changeset/value.ts",
				original:
					'\t\t\tclosed.set(name, { kind: "rows", origin: name, stratum: 0, rows: query.rows })\n',
				replacement:
					'\t\t\tclosed.set(name, { kind: "rows", origin: name, stratum: 0, rows: renameRowsParams(query.rows, new Map([...rowsParamNames(query.rows)].map((p) => [p, p + "#1"]))) })\n',
				why: "The binding's query reads the call's own parameters under private names, as a part's private ones are renamed: the call's `skip` reaches no use of it, its rows never read by the binding (metis's reading of its by-grade pick, refuted: a call's parameter is never a part's private one)."
			}
		]
	})
