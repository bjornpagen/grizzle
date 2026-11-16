/**
 * The work of rewriting a family or a tree on PostgreSQL 19rc2 grows linearly with its size: the cost law of every
 * foreign key's reverse probe (laws/model/plan.ts Reversed).
 *
 * Deleting a referenced row runs its foreign keys' RI probes, one per row (ri_triggers.c, RI_FKey_noaction_del), each
 * over the referencing columns. Where an index leads with the referencing columns that pair with the target's key, a
 * probe reads the rows that reference that one row; where only a shorter prefix leads one, as a family's key (g, at)
 * does for its predecessor axis (g, ‹p›) or a tree's primary key (doc, start) for its owner axis (doc, parent), each
 * probe reads the whole family or tree, so deleting n members reads n² rows.
 *
 * Each case draws a size n and a tree's fan-out, and measures, at n, 2n and 4n members, three operations through the
 * SQL grizzle's lowering sends, each in one SERIALIZABLE transaction rolled back after its deferred checks fire (SET
 * CONSTRAINTS ALL IMMEDIATE): a family's whole delete (its members, then its owner) and its suffix rewrite from the first
 * slot (delete every member, lower the count, insert the rest one slot down), for an ordered and a counted family; and a
 * tree's whole delete. Its work is the buffers it reads: over every table and index of the installation's schema, the
 * block requests its scans and probes made, hit or read, PostgreSQL's per-transaction counter
 * (pg_stat_get_xact_blocks_fetched), which no timing or cache state moves. Tuples returned would not do: a sequential
 * scan counts only the tuples visible to it, and a probe after a delete reads dead ones.
 * Each size's tables are analyzed once loaded, as a stored family's are, so the RI probes are planned over their
 * statistics rather than over a freshly truncated relation's defaults.
 *
 * The law: doubling the size at most multiplies the work by 2^(3/2), w(2k)² ≤ 8 w(k)² for k = n and 2n, a growth
 * exponent of at most 3/2. The exponent is a classification threshold, not a measured limit: halfway, in exponent,
 * between linear work, which doubles, and quadratic work, which quadruples once its square term dominates, so it
 * separates the two with room on both sides. A probe's B-tree descent grows by a level only past a page's fan-out of
 * entries, which keeps n·log n with its constant overheads near a doubling, and the buffers a size's plan spends beside
 * its members shrink the ratio rather than break it. Measured on a private cluster: the ordered family's whole delete
 * read 28,039, 56,069 and 112,127 buffers at 2,000, 4,000 and 8,000 members, ×2.00 at each doubling, and with no
 * reverse index for an axis and no successor key, each axis's probe scanning the member or the tree, 52,039, 164,069
 * and 560,127, ×3.15 and ×3.41, against 2^(3/2) ≈ 2.83; that ratio climbs toward 4 as n grows, which is why n is
 * drawn from 2,000 up.
 *
 * Oracle: PostgreSQL's own counters of the buffers each operation read, against the law. Features: none beyond the
 * operations, each measured in every case.
 */
import { drawn as drawnCase, explore } from "@bjornpagen/testing/explore"
import { noCoverage } from "@bjornpagen/testing/features"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { type FamilySeat, familySeat } from "#test/pg/fin/family.ts"
import { cleared, type Seat, seatOf } from "#test/pg/fin/installed.ts"
import { nodeBatchParams, nodeBatchSql, RELATIONS, Trees } from "#test/pg/fin/tree.ts"
import { loadTree } from "#test/pg/substrate/tree.ts"
import { assert } from "#test/support/assert.ts"
import { SHAPES } from "#test/support/families/theorem.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** A case: the smallest size measured, and the tree's fan-out. */
interface Cost {
	readonly n: number
	readonly fanout: number
}

const costGen: Gen<Cost> = (source) => ({
	n: source.draw(int(2_000, 4_000)),
	fanout: source.draw(int(2, 8))
})

/** The buffers one operation read: in all, and by each table and index of the schema it read. */
interface Touched {
	readonly buffers: number
	readonly by: ReadonlyArray<readonly [string, number]>
}

/** The buffers an operation read at n, 2n and 4n. */
type Work = readonly [Touched, Touched, Touched]

/** The sizes a case measures at: n, 2n and 4n. */
const sizesOf = (c: Cost): readonly [number, number, number] => [c.n, 2 * c.n, 4 * c.n]

/** The buffers the transaction read so far of each table and index of `schema` it read: its block requests. */
const touchedSql = `SELECT c.relname::text, pg_catalog.pg_stat_get_xact_blocks_fetched(c.oid)::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = $1::text AND c.relkind IN ('r', 'i') AND pg_catalog.pg_stat_get_xact_blocks_fetched(c.oid) > 0 ORDER BY 2 DESC, 1`

/**
 * The buffers `statements` read of `seat`'s schema in one SERIALIZABLE transaction, its deferred checks fired, which is
 * then rolled back, so the family or tree it measured stands for the next operation. It runs on a session of its own,
 * whose RI probes are planned afresh (ri_triggers.c keeps a backend's prepared probes across transactions), so no
 * measurement inherits another's plans.
 */
const touched = (seat: Seat, relation: string, statements: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const session = yield* substrate.session({ ...ownerSession(), label: "cost" })
			const schema = seat.installed.names.relation(relation).schema
			yield* session.begin
			const rows = yield* Effect.onError(
				Effect.gen(function* () {
					for (const sql of statements) {
						yield* session.query(sql, [])
					}
					yield* session.query("SET CONSTRAINTS ALL IMMEDIATE", [])
					return yield* session.values(touchedSql, [schema])
				}),
				() => Effect.ignore(session.rollback)
			)
			yield* session.rollback
			const by = Arr.map(rows, (r): readonly [string, number] => [String(r[0]), Number(r[1])])
			return { buffers: Arr.reduce(by, 0, (sum, [, n]) => sum + n), by }
		})
	)

/** Whether doubling a size from work `w` to work `doubled` grows it by an exponent of at most 3/2 (the header). */
const doublesLinearly = (w: number, doubled: number): boolean => doubled * doubled <= 8 * w * w

/** Fails unless `work` at n, 2n and 4n holds the law (the header), naming the operation and the sizes. */
const linear = (work: Work, sizes: readonly [number, number, number], what: string): void => {
	const [w1, w2, w4] = work
	assert.ok(
		doublesLinearly(w1.buffers, w2.buffers) && doublesLinearly(w2.buffers, w4.buffers),
		`${what}: the buffers it reads grow by an exponent of at most 3/2, w(2k)^2 <= 8 w(k)^2; at ${Arr.join(Arr.map(sizes, String), ", ")} members it read ${Arr.join(
			Arr.map(
				work,
				(w) =>
					`${w.buffers} (${Arr.join(
						Arr.map(w.by, ([r, n]) => `${r} ${n}`),
						", "
					)})`
			),
			"; "
		)}`
	)
}

/** An owner of `k` members, slots 0 to k - 1, committed and analyzed, as a stored family's tables are: the RI
 * probes' plans read its statistics. */
const familyOf = (f: FamilySeat, k: number) =>
	Effect.gen(function* () {
		const { seat } = f
		const c = (relation: string, role: string) => seat.column(relation, role)
		yield* cleared(seat, ["Owner", "Member"])
		yield* seat.session.begin
		yield* seat.session.query(
			`INSERT INTO ${seat.table("Owner")} (${c("Owner", "id")}, ${c("Owner", "n")}) VALUES (0, ${k})`,
			[]
		)
		yield* seat.session.query(
			`INSERT INTO ${seat.table("Member")} (${memberColumns(f)}) SELECT a, 0, a, ${k} FROM pg_catalog.generate_series(${k - 1}, 0, -1) AS a`,
			[]
		)
		yield* seat.session.commit
		yield* seat.session.query(`ANALYZE ${seat.table("Owner")}, ${seat.table("Member")}`, [])
	})

/** A member's columns as the family's statements write them: its key, its group, its index and ‹n›. */
const memberColumns = (f: FamilySeat): string =>
	Arr.join(
		Arr.map(["member", "g", f.index, "‹n›"], (role) => f.seat.column("Member", role)),
		", "
	)

/** A family's whole delete: every member, then its owner. */
const wholeDelete = (f: FamilySeat): ReadonlyArray<string> => [
	`DELETE FROM ${f.seat.table("Member")} WHERE ${f.seat.column("Member", "g")} = 0`,
	`DELETE FROM ${f.seat.table("Owner")} WHERE ${f.seat.column("Owner", "id")} = 0`
]

/** A family's suffix rewrite from its first slot: delete every member, lower the count, insert the rest one slot down. */
const suffixRewrite = (f: FamilySeat, k: number): ReadonlyArray<string> => [
	`DELETE FROM ${f.seat.table("Member")} WHERE ${f.seat.column("Member", "g")} = 0`,
	`UPDATE ${f.seat.table("Owner")} SET ${f.seat.column("Owner", "n")} = ${k - 1} WHERE ${f.seat.column("Owner", "id")} = 0`,
	`INSERT INTO ${f.seat.table("Member")} (${memberColumns(f)}) SELECT a + ${k}, 0, a, ${k - 1} FROM pg_catalog.generate_series(0, ${k - 2}) AS a`
]

layer(Substrate.layer)("the cost of rewriting families and trees on PostgreSQL 19rc2", (it) => {
	it.effect(
		"a family's whole delete and suffix rewrite, and a tree's whole delete, read buffers linear in its size",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const families = yield* Effect.forEach(SHAPES, (shape) =>
						familySeat(shape, `cost ${shape}`)
					)
					const trees = yield* seatOf(Trees, RELATIONS, "cost tree")
					return yield* explore(
						{
							suite: "fin/cost",
							draw: drawnCase(costGen),
							literal: Formatter.format,
							coverage: noCoverage,
							kept: [],
							runs: 2,
							shrink: completeShrink,
							steerEvery: 1,
							caseHang,
							oracle: {
								kind: "postgresql",
								name: "PostgreSQL's per-transaction count of the buffers each operation read, w(2k)^2 <= 8 w(k)^2 at k = n, 2n"
							}
						},
						(c) =>
							Effect.gen(function* () {
								const sizes = sizesOf(c)
								const [n1, n2, n4] = sizes
								for (const f of families) {
									/** A family of k members, its whole delete's work and its suffix rewrite's. */
									const at = (k: number) =>
										Effect.gen(function* () {
											yield* familyOf(f, k)
											const whole = yield* touched(f.seat, "Member", wholeDelete(f))
											const suffix = yield* touched(f.seat, "Member", suffixRewrite(f, k))
											return { whole, suffix }
										})
									const [m1, m2, m4] = yield* Effect.all([at(n1), at(n2), at(n4)])
									linear(
										[m1.whole, m2.whole, m4.whole],
										sizes,
										`the ${f.shape} family's whole delete`
									)
									linear(
										[m1.suffix, m2.suffix, m4.suffix],
										sizes,
										`the ${f.shape} family's suffix rewrite`
									)
								}
								/** A tree of k rows, and its whole delete's work. */
								const treeAt = (k: number) =>
									Effect.gen(function* () {
										yield* cleared(trees, RELATIONS)
										yield* trees.session.begin
										yield* trees.session.query(
											nodeBatchSql(trees),
											nodeBatchParams(loadTree(k, c.fanout))
										)
										yield* trees.session.commit
										yield* trees.session.query(`ANALYZE ${trees.table("Node")}`, [])
										return yield* touched(trees, "Node", [
											`DELETE FROM ${trees.table("Node")} WHERE ${trees.column("Node", "doc")} = 0`
										])
									})
								const deleted = yield* Effect.all([treeAt(n1), treeAt(n2), treeAt(n4)])
								linear(deleted, sizes, "the tree's whole delete")
							})
					)
				})
			)
	)
})
