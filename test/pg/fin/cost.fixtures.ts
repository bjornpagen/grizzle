/** What the properties of cost.test.ts read: its spaces, models and helpers. */

import { type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import { type FamilySeat, familyTemplates } from "#test/pg/fin/family.ts"
import { cleared, type Seat, seatTemplate } from "#test/pg/fin/installed.ts"
import { Trees } from "#test/pg/fin/tree.ts"
import { assert } from "#test/support/assert.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** A case: the smallest size measured, and the tree's fan-out. */
interface Cost {
	readonly n: number
	readonly fanout: number
}

export const costGen: Gen<Cost> = (source) => ({
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
export const sizesOf = (c: Cost): readonly [number, number, number] => [c.n, 2 * c.n, 4 * c.n]

/** The buffers the transaction read so far of each table and index of `schema` it read: its block requests. */
const touchedSql = `SELECT c.relname::text, pg_catalog.pg_stat_get_xact_blocks_fetched(c.oid)::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = $1::text AND c.relkind IN ('r', 'i') AND pg_catalog.pg_stat_get_xact_blocks_fetched(c.oid) > 0 ORDER BY 2 DESC, 1`

/**
 * The buffers `statements` read of `seat`'s schema in one SERIALIZABLE transaction, its deferred checks fired, which is
 * then rolled back, so the family or tree it measured stands for the next operation. It runs on a session of its own,
 * whose RI probes are planned afresh (ri_triggers.c keeps a backend's prepared probes across transactions), so no
 * measurement inherits another's plans.
 */
export const touched = (seat: Seat, relation: string, statements: ReadonlyArray<string>) =>
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
export const linear = (
	work: Work,
	sizes: readonly [number, number, number],
	what: string
): void => {
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
export const familyOf = (f: FamilySeat, k: number) =>
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
export const wholeDelete = (f: FamilySeat): ReadonlyArray<string> => [
	`DELETE FROM ${f.seat.table("Member")} WHERE ${f.seat.column("Member", "g")} = 0`,
	`DELETE FROM ${f.seat.table("Owner")} WHERE ${f.seat.column("Owner", "id")} = 0`
]

/** A family's suffix rewrite from its first slot: delete every member, lower the count, insert the rest one slot down. */
export const suffixRewrite = (f: FamilySeat, k: number): ReadonlyArray<string> => [
	`DELETE FROM ${f.seat.table("Member")} WHERE ${f.seat.column("Member", "g")} = 0`,
	`UPDATE ${f.seat.table("Owner")} SET ${f.seat.column("Owner", "n")} = ${k - 1} WHERE ${f.seat.column("Owner", "id")} = 0`,
	`INSERT INTO ${f.seat.table("Member")} (${memberColumns(f)}) SELECT a + ${k}, 0, a, ${k - 1} FROM pg_catalog.generate_series(0, ${k - 2}) AS a`
]

/** Each shape's family installed once per member (family.ts familyTemplates), which each case's seats hold. */
export const costFamilies = familyTemplates(import.meta, "cost")

/** The tree installed once per member (installed.ts seatTemplate), which each case's seat holds. */
export const costTree = seatTemplate(import.meta, Trees, "cost tree")
