/**
 * A query's records on PostgreSQL 19 (program/records.ts records, recordsFacts and recordsQuery): each case installs a
 * base of Item, a relation holding a field of every type a stored column may be (test/unit/program/records.fixtures.ts),
 * and over it a level listing the records of four queries: one rule finding every column beside a head literal, one
 * rule of a drawn subset of the columns beside a drawn literal or none, a union of two rules of one heading, each a
 * literal of its own at one key, which the records store as a column of exactly those literals, and one rule of a drawn
 * subset beside a computed numeric, which the records store as numeric within its bound. Item's facts are written, each query read
 * through the full role's Db, and each row it found inserted into its records under an owner of its own (recordsFacts),
 * then read back by recordsQuery at that owner: exactly the row the query found, value for value, through the query's
 * own decoder.
 *
 * Oracle: the query's own read of Item, which the records' read must give again.
 *
 * Features: each column stored, each kind of head literal written again, and a computed numeric stored.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rcd } from "effect"
import { recordsFacts } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import {
	itemFacts,
	levelsOf,
	type RecordsFeature,
	recordsCaseGen,
	recordsSituations
} from "#test/pg/records/records.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { readOnce, writeOnce } from "#test/support/calls.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { Item } from "#test/unit/program/records.fixtures.ts"

/** Each row a query found, inserted into its records and read back at its owner, is the row the query found. */
export const aRowAQueryFoundReadsBackFromItsRecordsExactlyAsTheQueryFoundIt = property.explore(
	recordsCaseGen,
	{
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: recordsSituations satisfies ReadonlyArray<Reached<RecordsFeature>>,
		check:
			({ substrate }, c: Case<RecordsFeature>) =>
			(cells) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const declared = levelsOf("Rec", cells)
							const done = yield* installMigrated(declared.Den, {
								ambient: ordinarySession,
								label: "records",
								logins: [declared.server],
								extensions: []
							})
							const rebuilt = levelsOf(done.schema, cells)
							const db = yield* openServedDb(done, rebuilt.server.roles.app, {})
							const programs = Rcd.fromEntries([
								["items", ChangeSet.empty(rebuilt.Den).insert(Item, [])],
								...Arr.flatMap(rebuilt.queries, (q, i) => [[`q${i}`, q] as const]),
								...Arr.flatMap(rebuilt.found, (f, i) => [
									[`insert${i}`, ChangeSet.empty(rebuilt.Den).insert(f.row, [])] as const
								]),
								...Arr.flatMap(rebuilt.reads, (read, i) => [[`read${i}`, read] as const])
							])
							const served = yield* db.serve(programs)
							yield* writeOnce(member(served, "items"))({
								params: {},
								facts: { insert: { Item: itemFacts } }
							})
							for (const [i, cell] of cells.entries()) {
								const what = `the records of ${Formatter.format(cell)}`
								for (const column of cell.columns) {
									c.note(`stores ${column}`)
								}
								if (cell.kind === "find" && cell.literal !== undefined) {
									c.note(`writes a ${typeof cell.literal} literal`)
								}
								if (cell.kind === "union") {
									c.note(`stores a union's ${typeof cell.literals[0]} literals`)
								}
								if (cell.kind === "sum") {
									c.note("stores a computed numeric")
								}
								const found = yield* readOnce(member(served, `q${i}`))({ params: {}, facts: {} })
								const records = rebuilt.found[i]
								if (records === undefined) {
									return assert.fail(`${what}: no records`)
								}
								const insert: Readonly<Record<string, ReadonlyArray<unknown>>> = recordsFacts(
									rebuilt.Den,
									records
								)(Arr.map(found, (row, at) => [{ at: BigInt(at) }, row] as const))
								const rows = insert[records.row.name] ?? []
								yield* writeOnce(member(served, `insert${i}`))({
									params: {},
									facts: { insert: { [records.row.name]: rows } }
								})
								for (const [at, row] of found.entries()) {
									const back = yield* readOnce(member(served, `read${i}`))({
										params: { at: BigInt(at) },
										facts: {}
									})
									assert.deepEqual(
										back,
										[row],
										`${what}: the row at ${at} reads back as the query found it`
									)
								}
							}
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: { kind: "second-implementation", name: "the query's own read of Item" },
		show: Formatter.format,
		budget: { runs: 6, steered: 6 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/records.ts",
				original: "\t\t\t\t\t...root.columns.map((c) => [c, row[c]] as const)",
				replacement: "\t\t\t\t\t...root.columns.slice(1).map((c) => [c, row[c]] as const)",
				why: "recordsFacts leaves a row's first stored column out, so the insert of its records is refused for the missing field and nothing reads back."
			},
			{
				file: "packages/engine/src/program/records.ts",
				original:
					"keyNames.map((k) => r.eq(vars[k], r.param(k, ownerField(state.ownerFields, k))))",
				replacement: "[]",
				why: "The read binds no owner, so at each owner it reads every stored row of the records, not the one row the query found there."
			}
		]
	}
)
