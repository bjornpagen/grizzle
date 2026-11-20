/**
 * A volume fill (test/support/substrate/fill.ts): tables filled over one series in chunks, each chunk one transaction
 * inserting the same slice of the series into every table of the fill, sized by the WAL the chunk before wrote, so no
 * transaction of a fixture's fill holds its XID for the whole fill. A long one holds back every SERIALIZABLE snapshot's
 * xmin, and with it SSI's cleanup, every DEFERRABLE read's safe snapshot and every replication slot's creation, for
 * every file on the cluster.
 *
 * Each case draws a table's shape (its rows computed from the series, its rows of defaults only, or two rows to a key,
 * the second skipped), a pad width and the deferred law the table carries: none, a constraint trigger an INSERT fires
 * or one only an UPDATE fires, or a deferred foreign key into a parent table filled before it, in its own fill, or after
 * it. In its own database (Substrate.fresh) it reads the cluster's WAL segment and draws the rows, up to what two
 * segments hold of the widest pad. It creates the tables and a twin of the table in a schema of its own, and fills them.
 *
 * Oracle: a second implementation and the specification. The twin is filled by one INSERT over the whole series, and
 * the table holds exactly its rows. The table's fill's chunks cover the series in order, the first of one index; each
 * chunk's rows share one xmin, a different one from every other chunk's, so each committed alone; and no chunk holds
 * more indices than the cluster's WAL segment holds at the WAL each index of the last chunk before it that wrote, or
 * than one where none has: a chunk that inserted no row writes nothing and measures nothing. A table a
 * constraint trigger an INSERT fires guards, or whose deferred foreign key points into a later fill, is refused, naming
 * the law, with no row written; every other is filled.
 *
 * Features: a fill of one row, a fill whose WAL passed one segment, a fill of defaults only, a fill that skipped rows a
 * key already held, a fill with a chunk that inserted no row, each deferred law. The last but one is FULLSUITE's
 * regression at 96d796b0 (a chunk of the one index whose key the index before already held inserted no row and wrote
 * no WAL, and the loader died dividing by it): every case that reaches it runs that chunk.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Predicate, Result } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	columnsOf,
	type FillCase,
	type FillFeature,
	fillColumns,
	fillFeatures,
	fillSpace,
	fillsOf,
	indexSql,
	int8,
	lawSql,
	refusedLaws,
	rowsUpTo
} from "#test/pg/substrate/fill.fixtures.ts"
import { volumeFill } from "#test/support/substrate/fill.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A volume fill commits a fixture's slices chunk by chunk, each sized by the WAL of the chunk before, and refuses a
 * fill a chunking could split a deferred law of.
 */
export const chunkedFill = property.explore(fillSpace, {
	needs: { substrate: Substrate.fresh },
	/** Its pre-conversion budget: runs 24, coverage cases 96 (fill.test.ts:200,224,237 at d55043f1^). */
	budget: { runs: 24, steered: 96 },
	situations: fillFeatures satisfies ReadonlyArray<Reached<FillFeature>>,
	check:
		({ substrate }, k: Case<FillFeature>) =>
		(drawn) =>
			Effect.gen(function* () {
				const s = yield* substrate
				const segmentRows = yield* s.admin.queryValues(
					"SELECT pg_catalog.pg_size_bytes(pg_catalog.current_setting('wal_segment_size'))",
					[]
				)
				const segment = int8(segmentRows)
				const c: FillCase = { ...drawn, rows: k.draw(rowsUpTo(segment)) }
				const name = yield* s.schema(freshSchema)
				const schema = quoteIdent(name)
				const table = `${schema}.t`
				const parent = `${schema}.p`
				const twin = `${schema}.twin`
				yield* s.admin.query(`CREATE TABLE ${table} (${columnsOf(c)})`, [])
				yield* s.admin.query(`CREATE TABLE ${twin} (LIKE ${table} INCLUDING ALL)`, [])
				yield* s.admin.query(`CREATE TABLE ${parent} (k int8 PRIMARY KEY)`, [])
				for (const sql of lawSql(c, schema, table, parent)) {
					yield* s.admin.query(sql, [])
				}
				k.note(c.deferred)
				const columns = fillColumns(c)
				const conflicts = c.shape === "halved" || c.shape === "repeating" ? "skipped" : "refused"
				const { fills, at } = fillsOf(
					c,
					{ table, columns },
					{ table: parent, columns: [["k", c.shape === "defaults" ? "g + 1" : "g"]] }
				)
				const filled = yield* Effect.result(volumeFill(s.admin, fills))
				const counted = yield* s.admin.queryValues(`SELECT count(*)::int8 FROM ${table}`, [])
				const stored = int8(counted)
				if (Arr.contains(refusedLaws, c.deferred)) {
					assert.ok(
						Result.isFailure(filled) &&
							filled.failure._tag === "VolumeFillRefused" &&
							filled.failure.deferred === "law",
						`a fill a chunking could split ${c.deferred} of is refused naming it, not ${Formatter.format(filled)}`
					)
					assert.equal(stored, 0, "a refused fill writes no row")
					return
				}
				if (Result.isFailure(filled)) {
					return assert.fail(`the fill commits, not ${Formatter.format(filled.failure)}`)
				}
				const chunks = Arr.filter(filled.success, (chunk) => chunk.fill === at)
				const names = Arr.map(columns, ([column]) => quoteIdent(column))
				yield* s.admin.query(
					`INSERT INTO ${twin}${Arr.isReadonlyArrayNonEmpty(names) ? ` (${Arr.join(names, ", ")})` : ""} SELECT ${Arr.join(
						Arr.map(columns, ([, sql]) => sql),
						", "
					)} FROM pg_catalog.generate_series(0, ${c.rows - 1}) AS s(g)${conflicts === "skipped" ? " ON CONFLICT DO NOTHING" : ""}`,
					[]
				)
				const rowsOf = (relation: string) =>
					s.admin.queryValues(`SELECT k::text, pg_catalog.md5(pad) FROM ${relation} ORDER BY k`, [])
				const filledRows = yield* rowsOf(table)
				const twinRows = yield* rowsOf(twin)
				assert.deepEqual(
					filledRows,
					twinRows,
					"the fill stores exactly the rows one INSERT over the whole series stores"
				)
				if (c.rows === 1) {
					k.note("a fill of one row")
				}
				if (c.shape === "defaults") {
					k.note("a fill of defaults only")
				}
				if (stored < c.rows && c.shape !== "defaults") {
					k.note("a fill that skipped rows a key already held")
				}
				if (Arr.reduce(chunks, 0, (sum, chunk) => sum + chunk.wal) > segment) {
					k.note("a fill whose WAL passed one segment")
				}
				assert.ok(
					Option.exists(Arr.head(chunks), (first) => first.from === 0),
					`the chunks start at the series' first index: ${Formatter.format(chunks)}`
				)
				if (Arr.some(chunks, (chunk) => chunk.inserted === 0)) {
					k.note("a fill with a chunk that inserted no row")
				}
				const budgeted = Arr.reduce(chunks, { budget: 1, at: 0 }, ({ budget, at }, chunk) => {
					const indices = chunk.to - chunk.from + 1
					assert.equal(chunk.from, at, "each chunk starts where the one before ended")
					assert.ok(
						indices <= budget,
						`a chunk of ${indices} indices from ${chunk.from}, past the ${budget} the segment holds at the WAL each index of the last chunk that wrote wrote, or past one before any did: ${Formatter.format(chunks)}`
					)
					return {
						budget:
							chunk.wal === 0 ? budget : Math.max(1, Math.floor((segment * indices) / chunk.wal)),
						at: chunk.to + 1
					}
				})
				assert.equal(budgeted.at, c.rows, "the chunks end at the series' last index")
				const commits = yield* s.admin.queryValues(
					`SELECT count(DISTINCT (u.n, t.xmin::text))::int8, count(DISTINCT u.n)::int8, count(DISTINCT t.xmin::text)::int8
FROM ${table} AS t JOIN ROWS FROM (pg_catalog.unnest($1::int8[]), pg_catalog.unnest($2::int8[])) WITH ORDINALITY AS u(lo, hi, n)
	ON t.${indexSql(c.shape)} BETWEEN u.lo AND u.hi`,
					[Arr.map(chunks, (chunk) => chunk.from), Arr.map(chunks, (chunk) => chunk.to)]
				)
				const [pairs, held, xmins] = commits[0] ?? []
				assert.ok(
					Predicate.isBigInt(held) && pairs === held && xmins === held,
					`each chunk's rows share one xmin, a different one from every other chunk's: (chunk, xmin) pairs, chunks holding rows and xmins ${Formatter.format(commits)}`
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "one INSERT over the whole series into a twin table, beside the chunks' own xmins, the WAL budget each chunk's predecessor sets, and the deferred laws a chunking could split"
	},
	kept: [],
	kills: []
})
