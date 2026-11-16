/**
 * A volume fill (test/support/substrate/fill.ts): tables filled over one series in chunks, each chunk one transaction
 * inserting the same slice of the series into every table of the fill, sized by the WAL the chunk before wrote, so no
 * transaction of a fixture's fill holds its XID for the whole fill. A long one holds back every SERIALIZABLE snapshot's
 * xmin, and with it SSI's cleanup, every DEFERRABLE read's safe snapshot and every replication slot's creation, for
 * every file on the cluster.
 *
 * Each case draws a table's shape (its rows computed from the series, its rows of defaults only, or two rows to a key,
 * the second skipped), a pad width, the rows, and the deferred law the table carries: none, a constraint trigger an
 * INSERT fires or one only an UPDATE fires, or a deferred foreign key into a parent table filled before it, in its own
 * fill, or after it. It creates the tables and a twin of the table in a schema of its own, and fills them.
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
 * key already held, a fill with a chunk that inserted no row, each deferred law.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Predicate, Result } from "effect"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { type VolumeFill, type VolumeTable, volumeFill } from "#test/support/substrate/fill.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The deferred law the table carries: none; an INITIALLY DEFERRED constraint trigger an INSERT fires, or one only an
 * UPDATE fires; or an INITIALLY DEFERRED foreign key into a parent table filled before the table, in the table's own
 * fill (its slice after the table's in each chunk), or after it.
 */
const deferredLaws = [
	"none",
	"a constraint trigger an INSERT fires",
	"a constraint trigger only an UPDATE fires",
	"a foreign key into an earlier fill",
	"a foreign key into its own fill",
	"a foreign key into a later fill"
] as const

type Deferred = (typeof deferredLaws)[number]

type FillFeature =
	| "a fill of one row"
	| "a fill whose WAL passed one segment"
	| "a fill of defaults only"
	| "a fill that skipped rows a key already held"
	| "a fill with a chunk that inserted no row"
	| Deferred

const features: Arr.NonEmptyReadonlyArray<FillFeature> = [
	"a fill of one row",
	"a fill whose WAL passed one segment",
	"a fill of defaults only",
	"a fill that skipped rows a key already held",
	"a fill with a chunk that inserted no row",
	...deferredLaws
]

/** The laws a chunking could split, which the admission refuses. */
const refused: ReadonlyArray<Deferred> = [
	"a constraint trigger an INSERT fires",
	"a foreign key into a later fill"
]

/**
 * A table's rows: each computed from its index `g` and keyed by it, each of defaults only (an identity key and a
 * default pad), computed with two indices to a key, the second skipped as a key already held, or computed over two keys
 * only, as a key over a roster's few codes is, so every index past the first two is skipped and a chunk of them inserts
 * no row.
 */
type Shape = "computed" | "defaults" | "halved" | "repeating"

/** A case: the table's shape, its pad's width, the rows filled, and the deferred law the table carries. */
interface FillCase {
	readonly shape: Shape
	readonly width: number
	readonly rows: number
	readonly deferred: Deferred
}

/**
 * The widest pad: below the 2 kB past which PostgreSQL compresses a row's text or moves it out of line
 * (TOAST_TUPLE_THRESHOLD), so a row's WAL grows with its pad.
 */
const widest = 1000

/** Cases over rows up to what two of the cluster's WAL segments hold of the widest pad, so fills pass one. */
const caseGen =
	(segment: number): Gen<FillCase> =>
	(source) => ({
		shape: source.draw(element(["computed", "defaults", "halved", "repeating"] as const)),
		width: source.draw(int(0, widest)),
		rows: source.draw(int(1, Math.ceil((2 * segment) / widest))),
		deferred: source.draw(element(deferredLaws))
	})

/** The table's columns and their CREATE TABLE text, by shape. */
const columnsOf = (c: FillCase): string =>
	c.shape === "defaults"
		? `k int8 GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, pad text NOT NULL DEFAULT pg_catalog.repeat('x', ${c.width})`
		: "k int8 PRIMARY KEY, at int8 NOT NULL, pad text NOT NULL"

/** Each filled column's SQL over the index `g`, by shape. */
const fillColumns = (c: FillCase): ReadonlyArray<readonly [string, string]> => {
	const pad: readonly [string, string] = [
		"pad",
		`pg_catalog.repeat(pg_catalog.chr(97 + (g % 26)::int4), ${c.width})`
	]
	switch (c.shape) {
		case "computed":
			return [["k", "g"], ["at", "g"], pad]
		case "halved":
			return [["k", "g / 2"], ["at", "g"], pad]
		case "repeating":
			return [["k", "g % 2"], ["at", "g"], pad]
		case "defaults":
			return []
	}
}

/**
 * A stored row's index in the series, by shape: the identity key counts from 1 in the series' order. The column the
 * table's foreign key reads holds it, or, of defaults only, that index plus one, as the parent's key does.
 */
const indexSql = (shape: Shape): string => (shape === "defaults" ? "k - 1" : "at")

/** The fills of a case: the table's own and its parent's, in the order the law puts them, and the table's fill's place. */
const fillsOf = (
	c: FillCase,
	child: VolumeTable,
	parent: VolumeTable
): { readonly fills: Arr.NonEmptyReadonlyArray<VolumeFill>; readonly at: number } => {
	const conflicts = c.shape === "halved" || c.shape === "repeating" ? "skipped" : "refused"
	const alone: VolumeFill = { tables: [child], rows: c.rows, conflicts }
	const parents: VolumeFill = { tables: [parent], rows: c.rows, conflicts: "refused" }
	switch (c.deferred) {
		case "a foreign key into an earlier fill":
			return { fills: [parents, alone], at: 1 }
		case "a foreign key into its own fill":
			return { fills: [{ tables: [child, parent], rows: c.rows, conflicts }], at: 0 }
		case "a foreign key into a later fill":
			return { fills: [alone, parents], at: 0 }
		case "none":
		case "a constraint trigger an INSERT fires":
		case "a constraint trigger only an UPDATE fires":
			return { fills: [alone], at: 0 }
	}
}

/** The DDL of the law the case's table carries, named `law`. */
const lawSql = (
	c: FillCase,
	schema: string,
	table: string,
	parent: string
): ReadonlyArray<string> => {
	const trigger = (event: string) => [
		`CREATE FUNCTION ${schema}.accept() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$`,
		`CREATE CONSTRAINT TRIGGER law AFTER ${event} ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${schema}.accept()`
	]
	const foreign = [
		`ALTER TABLE ${table} ADD CONSTRAINT law FOREIGN KEY (${c.shape === "defaults" ? "k" : "at"}) REFERENCES ${parent} (k) DEFERRABLE INITIALLY DEFERRED`
	]
	switch (c.deferred) {
		case "none":
			return []
		case "a constraint trigger an INSERT fires":
			return trigger("INSERT")
		case "a constraint trigger only an UPDATE fires":
			return trigger("UPDATE")
		case "a foreign key into an earlier fill":
		case "a foreign key into its own fill":
		case "a foreign key into a later fill":
			return foreign
	}
}

/** The one int8 cell a read answers, as a number. */
const int8 = (rows: ReadonlyArray<ReadonlyArray<unknown>>): number => {
	const cell = rows[0]?.[0]
	return Predicate.isBigInt(cell)
		? Number(cell)
		: assert.fail(`no int8 cell in ${Formatter.format(rows)}`)
}

/** Two indices to one key, the second skipped: its one-index chunk inserts no row and writes no WAL. */
const oneIndexSkipped: FillCase = { shape: "halved", width: 0, rows: 2, deferred: "none" }

const cases = 24

layer(Substrate.layer)("a volume fill", (it) => {
	it.effect(
		"commits a fixture's slices chunk by chunk, each sized by the WAL of the chunk before, and refuses a fill a chunking could split a deferred law of",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const segmentRows = yield* s.admin.queryValues(
						"SELECT pg_catalog.pg_size_bytes(pg_catalog.current_setting('wal_segment_size'))",
						[]
					)
					const segment = int8(segmentRows)
					return yield* explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "one INSERT over the whole series into a twin table, beside the chunks' own xmins, the WAL budget each chunk's predecessor sets, and the deferred laws a chunking could split"
							},
							suite: "pg/substrate/fill",
							draw: drawn(caseGen(segment)),
							literal: Formatter.format,
							coverage: required<FillFeature>(features, { cases: 4 * cases, sense: notesOnly }),
							kept: [
								{
									note: "FULLSUITE at 96d796b0: a chunk of the one index whose key the index before already held inserted no row and wrote no WAL, and the loader died dividing by it",
									sketch: oneIndexSkipped,
									draws: "",
									reaches: [
										"none",
										"a fill that skipped rows a key already held",
										"a fill with a chunk that inserted no row"
									]
								}
							],
							runs: cases,
							shrink: { kind: "bounded", candidates: 30 },
							steerEvery: 8,
							caseHang
						},
						(c, k) =>
							Effect.scoped(
								Effect.gen(function* () {
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
									const conflicts =
										c.shape === "halved" || c.shape === "repeating" ? "skipped" : "refused"
									const { fills, at } = fillsOf(
										c,
										{ table, columns },
										{ table: parent, columns: [["k", c.shape === "defaults" ? "g + 1" : "g"]] }
									)
									const filled = yield* Effect.result(volumeFill(s.admin, fills))
									const counted = yield* s.admin.queryValues(
										`SELECT count(*)::int8 FROM ${table}`,
										[]
									)
									const stored = int8(counted)
									if (Arr.contains(refused, c.deferred)) {
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
										s.admin.queryValues(
											`SELECT k::text, pg_catalog.md5(pad) FROM ${relation} ORDER BY k`,
											[]
										)
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
									const budgeted = Arr.reduce(
										chunks,
										{ budget: 1, at: 0 },
										({ budget, at }, chunk) => {
											const indices = chunk.to - chunk.from + 1
											assert.equal(chunk.from, at, "each chunk starts where the one before ended")
											assert.ok(
												indices <= budget,
												`a chunk of ${indices} indices from ${chunk.from}, past the ${budget} the segment holds at the WAL each index of the last chunk that wrote wrote, or past one before any did: ${Formatter.format(chunks)}`
											)
											return {
												budget:
													chunk.wal === 0
														? budget
														: Math.max(1, Math.floor((segment * indices) / chunk.wal)),
												at: chunk.to + 1
											}
										}
									)
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
								})
							)
					)
				})
			)
	)
})
