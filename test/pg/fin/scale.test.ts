/**
 * Long families and large imports through grizzle's lowering, on PostgreSQL 19rc1 (fin.md §11, "Scale", §15): what a
 * bound that bites only at scale must still satisfy, the sizes drawn afresh each run (doctrine rule 10) rather than
 * fixed small.
 *
 * - **A long family** of N members of one owner, written in one transaction, then grown by one, which is one count
 *   update whose owner-axis cascade rewrites ‹n› on every one of the N rows inside that statement, then shrunk from its
 *   first slot by the prescribed suffix rewrite (delete every row, lower the count, insert the rest one slot down).
 *   Every step commits, and every copy reads back as its owner's count.
 * - **A large import** of M owners with families of zero to four members, and one tree of T rows, each in one
 *   transaction. Each commits, and the deferred after-trigger queue, which holds one 12-byte event per deferred
 *   foreign-key check until COMMIT (fin.md §15; trigger.c's AfterTriggerEventDataOneCtid, in chunks of at most 1 MB with
 *   no spill), stays linear in the deferred checks the model counts: the last axis once per non-empty owner, and for a
 *   counted family its deferred predecessor axis once per member past slot 0.
 *
 * - **Oracles:** PostgreSQL as the judge (each write commits), the families theorem on what reads back, and the queue's
 *   size against its event count. The bound is 24 bytes an event, the event's 12 twice over for a chunk's growth
 *   by doubling, plus 2 MiB, two chunks of the largest size, for the chunk in fill and the shared trigger data: a queue
 *   that grew per row by more than an event, or kept immediate checks' events past their statement, exceeds it.
 */
import { layer } from "@effect/vitest"
import { drawn as drawnCase, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { measureTransaction, type TransactionMeasure } from "#bench/harness/transaction.ts"
import { familySeat, familyStoredOf, storedSql } from "#test/pg/fin/family.ts"
import { cleared, seatOf } from "#test/pg/fin/installed.ts"
import { nodeBatchSql, nodeBatchParams, RELATIONS, Trees } from "#test/pg/fin/tree.ts"
import { loadTree } from "#test/pg/substrate/tree.ts"
import { assert } from "#test/support/assert.ts"
import { breachesOf, SHAPES, type Shape } from "#test/support/families/theorem.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The sizes of one run's case. */
interface Scale {
	readonly shape: Shape
	/** The long family's length. */
	readonly long: number
	/** The import's owners, and its tree's rows and fan-out. */
	readonly owners: number
	readonly tree: number
	readonly fanout: number
	/** A seed for each owner's family length, 0 to 4. */
	readonly lengths: number
}

/** The sizes drawn across runs: long families of 10,000 to 60,000, imports of 500 to 5,000 owners, trees of 5,000 to 40,000. */
const scaleGen: Gen<Scale> = (source) => ({
	shape: source.draw(element(SHAPES)),
	long: source.draw(int(10_000, 60_000)),
	owners: source.draw(int(500, 5_000)),
	tree: source.draw(int(5_000, 40_000)),
	fanout: source.draw(int(2, 8)),
	lengths: source.draw(int(1, 1_000_000))
})

/** Each owner's family length in an import: 0 to 4, read off the seed. */
const lengthOf = (scale: Scale, owner: number): number => ((owner * 7919 + scale.lengths) % 997) % 5

/** An array literal of whole numbers, typed. */
const arrayOf = (values: ReadonlyArray<number>, type: "int4" | "int8"): string =>
	`'{${Arr.join(Arr.map(values, String), ",")}}'::${type}[]`

/** Bytes the deferred queue may hold for `events` deferred checks (the header's bound). */
const queueBound = (events: number): number => 24 * events + 2 * 1024 * 1024

/** The queue's size a measured transaction read before its COMMIT, failing the case where it could not be read. */
const queueBytes = (m: TransactionMeasure): number => {
	assert.equal(m.deferredEvents.kind, "observed", "the deferred queue is read")
	if (m.deferredEvents.kind !== "observed" || !m.deferredEvents.value.available) {
		return assert.fail(`the deferred queue is unreadable: ${Formatter.format(m.deferredEvents)}`)
	}
	return m.deferredEvents.value.totalBytes
}

layer(Substrate.layer)(
	"long families and large imports through grizzle's lowering on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"grow and shrink a long family by its cascade and suffix rewrite, and import many families and a large tree with the deferred queue linear in its deferred checks",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const families = yield* Effect.forEach(SHAPES, (shape) =>
							familySeat(shape, `scale ${shape}`)
						)
						const trees = yield* seatOf(Trees, RELATIONS, "scale tree")
						return yield* explore(
							{
								suite: "fin/scale",
								draw: drawnCase(scaleGen),
								literal: Formatter.format,
								coverage: noCoverage,
								kept: [],
								runs: 2,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 1,
								caseHang,
								oracle: {
									kind: "postgresql",
									name: "PostgreSQL commits each write; the families theorem holds of what reads back; the deferred queue's size is within 24 bytes an event plus 2 MiB of the deferred checks the model counts"
								}
							},
							(scale) =>
								Effect.gen(function* () {
									const f = Arr.getUnsafe(
										Arr.filter(families, (s) => s.shape === scale.shape),
										0
									)
									const { seat } = f
									const c = (relation: string, role: string) => seat.column(relation, role)
									const owner = seat.table("Owner")
									const member = seat.table("Member")
									const memberCols = `${c("Member", "member")}, ${c("Member", "g")}, ${c("Member", f.index)}, ${c("Member", "‹n›")}`
									const measured = (statements: ReadonlyArray<string>) =>
										measureTransaction(seat.session, {
											readOnly: false,
											statements: Arr.map(statements, (sql, i) => ({
												label: `${i}`,
												sql,
												params: [],
												explain: false
											})),
											end: "plain",
											deferredEvents: true,
											wal: false
										})
									const lawful = Effect.gen(function* () {
										const values = yield* seat.session.values(storedSql(f), [])
										const breaches = breachesOf(familyStoredOf(values))
										assert.equal(
											breaches.length,
											0,
											`the committed state holds the families theorem: ${Formatter.format(breaches.slice(0, 5))}`
										)
									})
									const n = scale.long
									const counted = scale.shape === "counted"
									const write = yield* measured([
										`INSERT INTO ${owner} (${c("Owner", "id")}, ${c("Owner", "n")}) VALUES (0, ${n})`,
										`INSERT INTO ${member} (${memberCols}) SELECT a, 0, a, ${n} FROM pg_catalog.generate_series(${n - 1}, 0, -1) AS a`
									])
									assert.equal(write.outcome.kind, "committed", `the long family of ${n} commits`)
									const longEvents = 1 + (counted ? n - 1 : 0)
									assert.ok(
										queueBytes(write) <= queueBound(longEvents),
										`the deferred queue of ${longEvents} checks`
									)
									const grow = yield* measured([
										`UPDATE ${owner} SET ${c("Owner", "n")} = ${n + 1} WHERE ${c("Owner", "id")} = 0`,
										`INSERT INTO ${member} (${memberCols}) VALUES (${n}, 0, ${n}, ${n + 1})`
									])
									assert.equal(
										grow.outcome.kind,
										"committed",
										"growing the long family by one commits"
									)
									const stale = yield* seat.session.values(
										`SELECT count(*)::int8 FROM ${member} WHERE ${c("Member", "‹n›")} <> ${n + 1}`,
										[]
									)
									assert.equal(
										Number(Arr.getUnsafe(Arr.getUnsafe(stale, 0), 0)),
										0,
										"the count's cascade rewrote every copy"
									)
									const shrink = yield* measured([
										`DELETE FROM ${member} WHERE ${c("Member", "g")} = 0`,
										`UPDATE ${owner} SET ${c("Owner", "n")} = ${n} WHERE ${c("Owner", "id")} = 0`,
										`INSERT INTO ${member} (${memberCols}) SELECT a + 1, 0, a, ${n} FROM pg_catalog.generate_series(0, ${n - 1}) AS a`
									])
									assert.equal(
										shrink.outcome.kind,
										"committed",
										"the suffix rewrite from the first slot commits"
									)
									yield* lawful
									yield* cleared(seat, ["Owner", "Member"])
									const lengths = Arr.map(Arr.range(0, scale.owners - 1), (o) => lengthOf(scale, o))
									const rows = Arr.flatMap(lengths, (k, o) =>
										Arr.map(Arr.range(0, k - 1).slice(0, k), (at) => [o, at, k] as const)
									)
									const imported = yield* measured([
										`INSERT INTO ${owner} (${c("Owner", "id")}, ${c("Owner", "n")}) SELECT o, n FROM ROWS FROM (pg_catalog.unnest(${arrayOf(
											Arr.map(lengths, (_, o) => o),
											"int4"
										)}), pg_catalog.unnest(${arrayOf(lengths, "int8")})) AS t(o, n)`,
										...(rows.length === 0
											? []
											: [
													`INSERT INTO ${member} (${memberCols}) SELECT m, g, a, n FROM ROWS FROM (pg_catalog.unnest(${arrayOf(
														Arr.map(rows, (_, i) => i),
														"int4"
													)}), pg_catalog.unnest(${arrayOf(
														Arr.map(rows, ([o]) => o),
														"int4"
													)}), pg_catalog.unnest(${arrayOf(
														Arr.map(rows, ([, a]) => a),
														"int8"
													)}), pg_catalog.unnest(${arrayOf(
														Arr.map(rows, ([, , k]) => k),
														"int8"
													)})) AS t(m, g, a, n)`
												])
									])
									assert.equal(
										imported.outcome.kind,
										"committed",
										`the import of ${scale.owners} families commits`
									)
									const importEvents =
										Arr.filter(lengths, (k) => k > 0).length +
										(counted ? Arr.filter(rows, ([, a]) => a > 0).length : 0)
									assert.ok(
										queueBytes(imported) <= queueBound(importEvents),
										`the deferred queue of ${importEvents} checks`
									)
									yield* lawful
									yield* cleared(seat, ["Owner", "Member"])
									const tree = loadTree(scale.tree, scale.fanout)
									const loaded = yield* measureTransaction(trees.session, {
										readOnly: false,
										statements: [
											{
												label: "tree",
												sql: nodeBatchSql(trees),
												params: nodeBatchParams(tree),
												explain: false
											}
										],
										end: "plain",
										deferredEvents: true,
										wal: false
									})
									assert.equal(
										loaded.outcome.kind,
										"committed",
										`the tree of ${scale.tree} rows commits in one INSERT`
									)
									const treeEvents = Arr.filter(tree, (r) => r.children > 0).length
									assert.ok(
										queueBytes(loaded) <= queueBound(treeEvents),
										`the tree's deferred queue of ${treeEvents} checks`
									)
									yield* cleared(trees, RELATIONS)
								})
						)
					})
				)
		)
	}
)
