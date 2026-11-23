/**
 * A relation parameter a ChangeSet binds to a query is an input of the call, evaluated once in the state before its first
 * stratum, and every member and read-back that reads it reads that one evaluation (README "Writes", ChangeSetDesc
 * `boundRows`, ir/write.ts BoundInput), on PostgreSQL 19: a later stratum and a read-back read the rows the bound query
 * had before the change, never the query evaluated again over the state they run in.
 *
 * Schema: Item(id), Mark(id), Log(id), each keyed by its id. `target` is bound to the items no mark holds, so a mark the
 * call adds takes its item out of the target.
 *
 * The space, drawn: the stored items, a nonempty subset of 1..4, and marks, a subset; the first stratum marks the
 * target's items or every item; the target logged in the first stratum, in a second one sequenced after it, or nowhere;
 * a read-back `picked` of the target alone, of the target's items the change marked (delta.added(Mark) joined to
 * `target`, riding the statement that makes it), or none; and `target` bound once on the whole ChangeSet, or by each
 * sequenced part that reads it. Read only by the first stratum's members, the binding is a part of their queries; read
 * by a later stratum or a read-back, it is carried, filled once into a carrier before the first stratum: both arms are
 * drawn. Each case loads its state on a clone of the template and applies its ChangeSet once.
 *
 * Property, per case: the Description holds `target` once among its bound rows, each part's binding of the one query
 * one input; the call commits; Mark, Log and `picked` are the model's (bound-once.fixtures.ts modelOf), `target` read as
 * the items no stored mark holds by every stratum and read-back. Oracle: specification, the model, the bound query
 * evaluated once over the stored state. Kills: every binding a part of its readers' queries however late they read it,
 * and each member reading its own copy of every binding, so a later stratum evaluates it again over the state after the
 * first stratum's marks, which hold every item of the target.
 *
 * Features: each way of marking, logging, reading and binding, and a carried binding whose re-evaluation reads another
 * target.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, Record as Rec } from "effect"
import { changeApplication, variantOf } from "#adapter/db/handles.ts"
import { hasProperties } from "#compiler/core/record.ts"
import { changeSetDesc } from "#compiler/write/changeset/value.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	changeOf,
	Item,
	Log,
	Mark,
	modelOf,
	Once,
	onceGen,
	onceInstall,
	onceTemplate,
	reevaluationDiffers,
	type Situation,
	situations
} from "#test/pg/write/bound-once/bound-once.fixtures.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A delivered row of `picked` as the property compares it, its id, or a failure naming what it is. */
const pickedId = (row: unknown): number =>
	hasProperties(row) && typeof row["id"] === "number"
		? row["id"]
		: assert.fail(`a row of picked, not ${Formatter.format(row)}`)

/** A relation parameter bound to a query is read once, before the change, by every stratum and read-back that reads it. */
export const aRelationParameterBoundToAQueryIsReadOnceBeforeTheChangeByEveryStratumAndReadBackThatReadsIt =
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
						if (reevaluationDiffers(c)) {
							k.note("carried, its re-evaluation another target")
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
						assert.equal(
							Rec.size(boundRows),
							1,
							"one input of the call, however many parts bound it"
						)
						assert.ok(Rec.has(boundRows, "target"), "the input is target")
						const model = modelOf(c)
						const outcome = yield* withServedDb(
							opened.installed,
							opened.server.roles.app,
							{},
							({ ctx, load }) =>
								Effect.gen(function* () {
									const served = yield* load({ bound: change })
									const loaded = member(served, "bound")
									if (loaded.kind !== "change") {
										return yield* Effect.die(new Error("the ChangeSet loads as a change"))
									}
									return yield* changeApplication(
										ctx,
										variantOf(ctx, loaded.variants)
									)({ params: {}, facts: {} })
								})
						)
						const reads =
							outcome.kind === "accepted" || outcome.kind === "no-change"
								? outcome.reads
								: assert.fail(`the call commits, not ${outcome.kind}`)
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
							"Log is the target before the change"
						)
						const picked = hasProperties(reads) ? reads["picked"] : undefined
						assert.deepEqual<ReadonlyArray<number> | undefined>(
							Arr.isArray(picked) ? Arr.sort(Arr.map(picked, pickedId), Order.Number) : undefined,
							model.picked,
							"picked reads the target before the change"
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
			name: "the bound query evaluated once over the stored state, the items no stored mark holds, read by every stratum and read-back (bound-once.fixtures.ts modelOf)"
		},
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: "\t\tObject.keys(desc.boundRows).filter(",
				replacement: "\t\t[].filter(",
				why: "Every binding is a part of its readers' queries however late they read it: the second stratum's log and the read-back evaluate the target again after the first stratum's marks, which hold every item of it, and read none."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original:
					"\tconst inlined = new Map(Object.entries(desc.boundRows).filter(([name]) => !later.has(name)))",
				replacement: "\tconst inlined = new Map(Object.entries(desc.boundRows))",
				why: "Each member reads its own copy of every binding: the second stratum's log evaluates the target again over the state after the first stratum's marks and logs none of it, while the carrier its read-back reads holds the target before the change."
			}
		]
	})
