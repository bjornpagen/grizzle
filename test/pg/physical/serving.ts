import { Array as Arr, Effect, Option, Order, Result, Schema } from "effect"
import {
	explainStatementWith,
	type PlanNode,
	parsePlan,
	planNodes
} from "#bench/harness/explain.ts"

import {
	type AccessUse,
	allRows,
	defaultOpclass,
	type IndexRequest
} from "#compiler/ir/products.ts"
import type { PlannedIndex } from "#compiler/physical/indexes/engine.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { InstallExtension } from "#compiler/physical/install/extension.ts"
import { printObjectName, quoteIdent, quoteString } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import { parsedName, wild } from "#test/support/kernel/naming.ts"
import type { SqlError } from "#test/support/pg.ts"
import { beginSerializable } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { requesting } from "#test/unit/physical/fixtures.ts"

/**
 * What a probe asks of its relation: every key equal to a value; an equality prefix and its last key bounded on both
 * sides (by its sampled value alone, by the half of the column's extent holding it after a prefix); the keys' order;
 * equality on each scalar key and overlap on each span key; the nearest vectors.
 */
const shapes = ["equality", "range", "ordered", "overlap", "nearest"] as const
export type Shape = (typeof shapes)[number]

/** Each workload use's probe, as ir/products.ts accessUses defines the use. */
const accessShape: Readonly<Record<AccessUse, Shape>> = {
	"key lookup": "equality",
	"equality lookup": "equality",
	"join key": "equality",
	"write target": "equality",
	range: "range",
	"prefix search": "range",
	"take seek": "ordered",
	"page seek": "ordered",
	"span predicate": "overlap",
	"approximate vector retrieval": "nearest"
}

/**
 * A law's probe by its access method: a B-tree probe looks every requested column up by equality, a GiST probe tests
 * equality on each scalar and overlap on each span (a PERIOD reference's, a coverage's).
 */
const lawShape: Readonly<Record<IndexRequest["method"], Shape>> = {
	btree: "equality",
	gist: "overlap",
	hnsw: "nearest"
}

const shapeOf = (r: IndexRequest): Shape =>
	r.role === "access" ? accessShape[r.use] : lawShape[r.method]

/** Whether a shape fixes a column, so its scan must carry an index condition. */
const conditioned: Readonly<Record<Shape, boolean>> = {
	equality: true,
	range: true,
	ordered: false,
	overlap: true,
	nearest: false
}

/** Whether a shape's probe takes its values from a row the relation holds: an order takes none. */
const sampledShape: Readonly<Record<Shape, boolean>> = {
	equality: true,
	range: true,
	ordered: false,
	overlap: true,
	nearest: true
}

/** Whether a shape asks for an order, so no sort may stand above its scan. */
const orderedShape: Readonly<Record<Shape, boolean>> = {
	equality: false,
	range: false,
	ordered: true,
	overlap: false,
	nearest: true
}

/**
 * The pages a scan of an index of each access method reads beside its entries' leaves and the heap (see judgeServing):
 * the inner pages of its descent, the leaf its entries straddle into, and the visibility map page; twice a B-tree's for
 * a GiST index, whose sibling keys overlap, so its probe may follow two paths down. An HNSW scan reads a neighbourhood
 * of its graph whatever the result.
 */
const descentPages: Readonly<Record<PlannedIndex["method"], number>> = {
	btree: 4,
	gist: 8,
	hnsw: Number.POSITIVE_INFINITY
}

/**
 * What the judgment reads of a planned index: its access method, the fields its keys hold, whether it is unique, its
 * pages, and its entries, a row each.
 */
export interface IndexFacts {
	readonly method: PlannedIndex["method"]
	readonly fields: ReadonlySet<string>
	readonly unique: boolean
	readonly pages: number
	readonly entries: number
}

/** What the judgment reads of an installation: the PostgreSQL schema it lives in and what it planned and named. */
export interface Judged {
	readonly schema: string
	readonly installation: Installation
}

/** The rows a probe reads: every row, or those whose boolean fields hold the given values, a law's selected source. */
export type ProbeRows =
	| { readonly kind: "all" }
	| {
			readonly kind: "selected"
			readonly where: Arr.NonEmptyReadonlyArray<{ readonly field: string; readonly value: boolean }>
	  }

export const everyRow: ProbeRows = { kind: "all" }

/**
 * A request a suite hands the engine itself, as it states it: a workload access by its use, whose access method the use
 * fixes (a span predicate is GiST's, an approximate retrieval HNSW's, every other use a B-tree's), or a law's B-tree
 * probe of the rows it reads. Each key names a field of the relation once.
 */
export type RequestSpec =
	| {
			readonly kind: "access"
			readonly relation: string
			readonly use: AccessUse
			readonly keys: Arr.NonEmptyReadonlyArray<{
				readonly field: string
				readonly dir: "asc" | "desc"
			}>
	  }
	| {
			readonly kind: "law"
			readonly relation: string
			readonly keys: Arr.NonEmptyReadonlyArray<string>
			readonly rows: ProbeRows
	  }

const methodOfUse: Readonly<Record<AccessUse, IndexRequest["method"]>> = {
	"key lookup": "btree",
	"equality lookup": "btree",
	"join key": "btree",
	"write target": "btree",
	range: "btree",
	"prefix search": "btree",
	"take seek": "btree",
	"page seek": "btree",
	"span predicate": "gist",
	"approximate vector retrieval": "hnsw"
}

/** A spec as text, for a report. */
export const specText = (spec: RequestSpec): string =>
	spec.kind === "access"
		? `${spec.use} on ${spec.relation}(${Arr.join(
				Arr.map(spec.keys, (k) => `${k.field}${k.dir === "desc" ? " desc" : ""}`),
				", "
			)})`
		: `a law probe on ${spec.relation}(${Arr.join(spec.keys, ", ")})${
				spec.rows.kind === "all"
					? ""
					: ` where ${Arr.join(
							Arr.map(spec.rows.where, (s) => `${s.field} = ${s.value}`),
							" and "
						)}`
			}`

/** The engine's request of a spec, `at` its position, which names a law's. */
const requestOf = (spec: RequestSpec, at: number): IndexRequest => {
	switch (spec.kind) {
		case "access":
			return {
				relation: spec.relation,
				keys: Arr.map(spec.keys, (k) => ({ expr: k.field, dir: k.dir, opclass: defaultOpclass })),
				method: methodOfUse[spec.use],
				role: "access",
				use: spec.use
			}
		case "law": {
			const rows = spec.rows
			return {
				relation: spec.relation,
				keys: Arr.map(spec.keys, (field) => ({
					expr: field,
					dir: "asc" as const,
					opclass: defaultOpclass
				})),
				method: "btree",
				role: "lawMaintenance",
				use: "reverse reference",
				rows:
					rows.kind === "all"
						? allRows
						: {
								kind: "selected",
								selection: Arr.map(rows.where, (w) => ({
									column: w.field,
									value: { kind: "bool" as const, value: w.value }
								}))
							},
				justification: { kind: "law", law: wild.lawId(`drawn${at}`) }
			}
		}
	}
}

/**
 * The installer extension that hands the engine the specs' requests, and the rows each request's probe reads: a spec's
 * own, and every row for a request the schema's own laws make, which the specs' schemas give no selection.
 */
export const drawnRequests = (
	specs: ReadonlyArray<RequestSpec>
): {
	readonly extension: InstallExtension
	readonly rowsOf: (request: IndexRequest) => ProbeRows
} => {
	const specified = Arr.map(
		specs,
		(spec, at) => [requestOf(spec, at), spec.kind === "law" ? spec.rows : everyRow] as const
	)
	const requests = Arr.map(specified, ([r]) => r)
	const rows = new Map<IndexRequest, ProbeRows>(specified)
	return {
		extension: requesting(requests),
		rowsOf: (request) => {
			const drawn = rows.get(request)
			if (drawn !== undefined) {
				return drawn
			}
			if (request.role === "lawMaintenance" && request.rows.kind === "selected") {
				return assert.fail(
					`the schema's own law probes ${request.relation} by a selection no spec states`
				)
			}
			return everyRow
		}
	}
}

/**
 * What a plan states of one index, as two plans of one request set compare: its name, whether the engine created it or
 * another object installs it (a key's or an enforcement index), its access method, its keys in index order with their
 * directions, and the uses of the requests it serves, each once, sorted.
 */
export interface PlannedShape {
	readonly index: string
	readonly origin: PlannedIndex["index"]["kind"]
	readonly method: string
	readonly keys: ReadonlyArray<{ readonly field: string; readonly dir: "asc" | "desc" }>
	readonly uses: ReadonlyArray<string>
}

/** The plan's indexes, in plan order (see PlannedShape). */
export const planShape = (installed: Judged): ReadonlyArray<PlannedShape> =>
	Arr.map(installed.installation.indexes, (i) => ({
		index: i.index.name,
		origin: i.index.kind,
		method: i.method,
		keys: Arr.map(i.keys, (k) => ({ field: k.field, dir: k.dir })),
		uses: Arr.sort(Arr.dedupe(Arr.map(i.requests, (r) => r.use)), Order.String)
	}))

/** A closed relation's enum type, qualified and quoted, as a cast names it. */
export const enumTypeSql = (installed: Judged, closed: string): string =>
	printObjectName(installed.installation.names.enumType(parsedName(closed)))

/**
 * A relation's table as the probes read it: quoted and qualified, its own name as EXPLAIN reports a scan's relation,
 * its columns whose type is a range type, directly or under domains, those of few values, whose type is a boolean or an
 * enum, so that fixing one bounds no scan, and the rows it holds.
 */
interface Table {
	readonly quoted: string
	readonly name: string
	readonly spans: ReadonlySet<string>
	readonly few: ReadonlySet<string>
	readonly rows: number
}

/** What a column of a table holds, by its type under its domains: a span, few values, or many. */
const ColumnHolds = Schema.Array(
	Schema.Tuple([Schema.String, Schema.Literals(["span", "few", "many"])])
)

const tableOf = (installed: Judged, relation: string) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const q = installed.installation.names.relation(relation)
		const quoted = `${quoteIdent(q.schema)}.${quoteIdent(q.name)}`
		const columns = yield* Schema.decodeUnknownEffect(ColumnHolds)(
			yield* admin.queryValues(
				"WITH RECURSIVE base(name, oid, typtype, typbasetype) AS (" +
					"SELECT a.attname, t.oid, t.typtype, t.typbasetype FROM pg_catalog.pg_attribute AS a " +
					"JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid " +
					"WHERE a.attrelid = $1::text::regclass AND a.attnum > 0 AND NOT a.attisdropped " +
					"UNION ALL SELECT b.name, t.oid, t.typtype, t.typbasetype FROM base AS b " +
					"JOIN pg_catalog.pg_type AS t ON t.oid = b.typbasetype WHERE b.typtype = 'd'::\"char\") " +
					"SELECT name::text, CASE WHEN typtype = 'r'::\"char\" THEN 'span' " +
					"WHEN typtype = 'e'::\"char\" OR oid = 'pg_catalog.bool'::pg_catalog.regtype THEN 'few' ELSE 'many' END " +
					"FROM base WHERE typtype <> 'd'::\"char\"",
				[quoted]
			)
		)
		const holding = (holds: "span" | "few"): ReadonlySet<string> =>
			new Set(
				Arr.map(
					Arr.filter(columns, ([, h]) => h === holds),
					([name]) => name
				)
			)
		const counted = yield* Schema.decodeUnknownEffect(Texts)(
			yield* admin.queryValues(`SELECT count(*)::text FROM ${quoted}`, [])
		)
		return {
			quoted,
			name: q.name,
			spans: holding("span"),
			few: holding("few"),
			rows: Number(counted[0]?.[0])
		} satisfies Table
	})

const PagesAndPredicate = Schema.Array(Schema.Tuple([Schema.String, Schema.NullOr(Schema.String)]))

/**
 * Each of `indexes`, by name, with its facts (IndexFacts): its entries are every row of its table or, for a partial
 * index, the rows its predicate admits.
 */
const indexFacts = (
	installed: Judged,
	indexes: ReadonlyArray<PlannedIndex>,
	tableFor: (relation: string) => Table
) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const facts = new Map<string, IndexFacts>()
		for (const i of indexes) {
			const table = tableFor(i.relation)
			const [row] = yield* Schema.decodeUnknownEffect(PagesAndPredicate)(
				yield* admin.queryValues(
					"SELECT (pg_catalog.pg_relation_size(c.oid) / pg_catalog.current_setting('block_size')::bigint)::text, " +
						"pg_catalog.pg_get_expr(x.indpred, x.indrelid) FROM pg_catalog.pg_class AS c " +
						"JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace JOIN pg_catalog.pg_index AS x ON x.indexrelid = c.oid " +
						"WHERE n.nspname = $1::text AND c.relname = $2::text",
					[installed.schema, i.index.name]
				)
			)
			if (row === undefined) {
				return assert.fail(`no index ${i.index.name} in ${installed.schema}`)
			}
			const [pages, predicate] = row
			const entries =
				predicate === null
					? table.rows
					: Number(
							(yield* Schema.decodeUnknownEffect(Texts)(
								yield* admin.queryValues(
									`SELECT count(*)::text FROM ${table.quoted} WHERE ${predicate}`,
									[]
								)
							))[0]?.[0]
						)
			facts.set(i.index.name, {
				method: i.method,
				fields: new Set(Arr.map(i.keys, (k) => k.field)),
				unique: i.unique,
				pages: Number(pages),
				entries
			})
		}
		return facts
	})

/** Every index the installation planned, by name, with its facts (IndexFacts), each relation's table read once. */
export const plannedFacts = (
	installed: Judged
): Effect.Effect<ReadonlyMap<string, IndexFacts>, SqlError | Schema.SchemaError, Substrate> =>
	Effect.gen(function* () {
		const indexes = installed.installation.indexes
		const tables = new Map<string, Table>()
		for (const r of new Set(Arr.map(indexes, (i) => i.relation))) {
			tables.set(r, yield* tableOf(installed, r))
		}
		return yield* indexFacts(installed, indexes, (relation) => {
			const t = tables.get(relation)
			return t ?? assert.fail(`no table read for ${relation}`)
		})
	})

/**
 * The rows the series of a load makes for each relation: enough that an index of a 16-byte key spans some 70 leaf
 * pages, so a lookup and a sweep of it differ by far more than the bound's slack.
 */
const volumeRows = 20_000

/**
 * One relation's rows as SQL over the series `g`, 0 to the load's rows - 1: each field's expression, by declared field
 * name.
 */
export interface VolumeLoad {
	readonly relation: string
	readonly fields: ReadonlyArray<readonly [field: string, sql: string]>
}

/** Loads every relation at volumeRows (loadRows). */
export const loadAtVolume = (
	installed: Judged,
	loads: ReadonlyArray<VolumeLoad>
): Effect.Effect<void, SqlError, Substrate> => loadRows(installed, loads, volumeRows)

/**
 * Loads every relation in order over the series 0 to `rows` - 1, in one SERIALIZABLE transaction as the owner, each row
 * a key already holds skipped, then VACUUM ANALYZEs each table, so its statistics and visibility map are a settled
 * table's.
 */
export const loadRows = (
	installed: Judged,
	loads: ReadonlyArray<VolumeLoad>,
	rows: number
): Effect.Effect<void, SqlError, Substrate> =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const table = (relation: string): string => {
			const q = installed.installation.names.relation(relation)
			return `${quoteIdent(q.schema)}.${quoteIdent(q.name)}`
		}
		const inserts = Arr.map(
			loads,
			(l) =>
				`INSERT INTO ${table(l.relation)} (${Arr.join(
					Arr.map(l.fields, ([field]) =>
						quoteIdent(installed.installation.names.column(l.relation, field))
					),
					", "
				)}) SELECT ${Arr.join(
					Arr.map(l.fields, ([, sql]) => sql),
					", "
				)} FROM pg_catalog.generate_series(0, ${rows - 1}) AS s(g) ON CONFLICT DO NOTHING`
		)
		yield* Effect.onError(
			Effect.gen(function* () {
				yield* admin.query(beginSerializable, [])
				for (const statement of inserts) {
					yield* admin.query(statement, [])
				}
				yield* admin.query("COMMIT", [])
			}),
			() => Effect.ignore(admin.query("ROLLBACK", []))
		)
		for (const l of loads) {
			yield* admin.query(`VACUUM (ANALYZE) ${table(l.relation)}`, [])
		}
	})

/**
 * One request's probe: the statement, its shape, its relation's table, what the report calls it, the fields its key
 * conditions bind (every key of a shape that fixes its columns, none of an order's), and the rows its key conditions
 * match outside its selection (none for a probe of every row).
 */
interface Probe {
	readonly label: string
	readonly shape: Shape
	readonly table: Table
	readonly sql: string
	readonly bound: ReadonlyArray<string>
	readonly rechecked: number
}

const Texts = Schema.Array(Schema.Array(Schema.String))

const where = (conditions: ReadonlyArray<string>): string =>
	conditions.length === 0 ? "" : ` WHERE ${Arr.join(conditions, " AND ")}`

/**
 * The probe of `request` (see the header): its values those of the middle row, in physical order, of the rows `rows`
 * selects.
 */
const probeOf = (installed: Judged, table: Table, request: IndexRequest, rows: ProbeRows) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const column = (field: string): string =>
			quoteIdent(installed.installation.names.column(request.relation, field))
		const keys = Arr.map(request.keys, (k) => ({
			field: String(k.expr),
			dir: k.dir,
			opclass: k.opclass
		}))
		const label = `${request.role} ${request.use} on ${request.relation}(${Arr.join(
			Arr.map(keys, (k) => `${k.field}${k.dir === "desc" ? " desc" : ""}`),
			", "
		)})${
			rows.kind === "all"
				? ""
				: ` where ${Arr.join(
						Arr.map(rows.where, (s) => `${s.field} = ${s.value}`),
						" and "
					)}`
		} by ${request.method}`
		const selection =
			rows.kind === "all"
				? []
				: Arr.map(rows.where, (s) => `${column(s.field)} = ${s.value ? "TRUE" : "FALSE"}`)
		const shape = shapeOf(request)
		const sampled = sampledShape[shape] ? keys : []
		const sample =
			sampled.length === 0
				? []
				: (yield* Schema.decodeUnknownEffect(Texts)(
						yield* admin.queryValues(
							`SELECT ${Arr.join(
								Arr.map(sampled, (k) => `${column(k.field)}::text`),
								", "
							)} FROM ${table.quoted}${where(selection)} ` +
								`ORDER BY ctid OFFSET (SELECT count(*) / 2 FROM ${table.quoted}${where(selection)}) LIMIT 1`,
							[]
						)
					))[0]
		if (sample === undefined) {
			return assert.fail(`${label}: ${request.relation} holds no row to probe`)
		}
		const value = (at: number): string => {
			const v = sample[at]
			return v === undefined
				? assert.fail(`${label}: the sample has no value at ${at}`)
				: quoteString(v)
		}
		/** Each of the first `count` keys equal to its sampled value. */
		const equal = (count: number): ReadonlyArray<string> =>
			Arr.map(keys.slice(0, count), (k, at) => `${column(k.field)} = ${value(at)}`)
		/**
		 * A range probe's bounds on its last key: after an equality prefix, the half of the column's extent that holds
		 * the sampled value, from its least value to its median or from its median to its greatest, so the prefix's
		 * rows are what an index taking the column right after the prefix reads, a scan of the prefix's rows alone
		 * rechecks the column on them, an index taking the column first reads half, and the sampled row is among the
		 * probe's; alone, the sampled value, so the probe reads a point of the column, not half of it.
		 */
		const rangeBounds = (at: number, c: string) =>
			at === 0
				? Effect.succeed({ lo: value(at), hi: value(at) })
				: Effect.map(
						Effect.flatMap(
							admin.queryValues(
								`WITH m AS (SELECT (SELECT ${c} FROM ${table.quoted} ORDER BY ${c} LIMIT 1) AS lo, ` +
									`(SELECT ${c} FROM ${table.quoted} ORDER BY ${c} OFFSET (SELECT count(*) / 2 FROM ${table.quoted}) LIMIT 1) AS mid, ` +
									`(SELECT ${c} FROM ${table.quoted} ORDER BY ${c} DESC LIMIT 1) AS hi) ` +
									`SELECT (CASE WHEN ${value(at)} <= mid THEN lo ELSE mid END)::text, ` +
									`(CASE WHEN ${value(at)} <= mid THEN mid ELSE hi END)::text FROM m`,
								[]
							),
							Schema.decodeUnknownEffect(Texts)
						),
						(extent) => {
							const [lo, hi] = extent[0] ?? []
							return lo === undefined || hi === undefined
								? assert.fail(`${label}: no extent of ${c}`)
								: { lo: quoteString(lo), hi: quoteString(hi) }
						}
					)
		/** The probe's conditions on its keys and what follows its WHERE clause, by its shape. */
		const statement = yield* Effect.suspend(() => {
			switch (shape) {
				case "equality":
					return Effect.succeed({ conditions: equal(keys.length), tail: "" })
				case "range": {
					const last = keys.length - 1
					const bounded = keys[last]
					if (bounded === undefined) {
						return assert.fail(`${label}: a range request with no key`)
					}
					const c = column(bounded.field)
					return Effect.map(rangeBounds(last, c), ({ lo, hi }) => ({
						conditions: [...equal(last), `${c} >= ${lo}`, `${c} <= ${hi}`],
						tail: ""
					}))
				}
				case "overlap":
					return Effect.succeed({
						conditions: Arr.map(
							keys,
							(k, at) =>
								`${column(k.field)} ${table.spans.has(installed.installation.names.column(request.relation, k.field)) ? "&&" : "="} ${value(at)}`
						),
						tail: ""
					})
				case "ordered":
					return Effect.succeed({
						conditions: [],
						tail: ` ORDER BY ${Arr.join(
							Arr.map(keys, (k) => `${column(k.field)} ${k.dir === "desc" ? "DESC" : "ASC"}`),
							", "
						)} LIMIT 10`
					})
				case "nearest": {
					const first = keys[0]
					if (first === undefined) {
						return assert.fail(`${label}: a nearest request with no key`)
					}
					const operator = first.opclass.kind === "default" ? "<->" : "<=>"
					return Effect.succeed({
						conditions: [],
						tail: ` ORDER BY ${column(first.field)} OPERATOR(${quoteIdent(installed.installation.names.vectorSchema)}.${operator}) ${value(0)} LIMIT 10`
					})
				}
			}
		})
		const sql = `SELECT 1 FROM ${table.quoted}${where([...statement.conditions, ...selection])}${statement.tail}`
		/**
		 * The rows its key conditions match outside its selection: those an index of every row finds and PostgreSQL
		 * rechecks the selection on.
		 */
		const rechecked =
			selection.length === 0 || statement.conditions.length === 0
				? 0
				: Number(
						(yield* Schema.decodeUnknownEffect(Texts)(
							yield* admin.queryValues(
								`SELECT count(*)::text FROM ${table.quoted}${where([...statement.conditions, `NOT (${Arr.join(selection, " AND ")})`])}`,
								[]
							)
						))[0]?.[0]
					)
		const bound = conditioned[shape] ? Arr.map(keys, (k) => k.field) : []
		return { label, shape, table, sql, bound, rechecked } satisfies Probe
	})

/**
 * What PostgreSQL made of a probe: served through a planned index; swept through one, the scan meeting every rule but
 * reading past what its result requires, in more than one descent or more buffers than the bound; or not served, and
 * why.
 */
type Verdict =
	| { readonly kind: "served"; readonly through: PlannedIndex }
	| { readonly kind: "swept"; readonly through: PlannedIndex; readonly why: string }
	| { readonly kind: "unserved"; readonly why: string }

const sorts: ReadonlySet<string> = new Set(["Sort", "Incremental Sort"])

/**
 * The planned index a scan reads, held to the rules every probe's scan meets (see judgeServing): an Index Scan or Index
 * Only Scan of an index the installation planned (`planned`, by name), with an index condition when its probe fixes a
 * column (`fixes`); or why it is none.
 */
export const plannedScan = (
	scan: PlanNode,
	planned: ReadonlyMap<string, PlannedIndex>,
	fixes: boolean
): Result.Result<PlannedIndex, string> => {
	if (scan.nodeType !== "Index Scan" && scan.nodeType !== "Index Only Scan") {
		return Result.fail(`a ${scan.nodeType}`)
	}
	if (Option.isNone(scan.index)) {
		return Result.fail(`an ${scan.nodeType} naming no index`)
	}
	const index = scan.index.value
	const through = planned.get(index)
	if (through === undefined) {
		return Result.fail(`a scan of ${index}, which the installation did not plan`)
	}
	if (fixes && Option.isNone(scan.indexCond)) {
		return Result.fail(`a scan of ${index} with no index condition`)
	}
	return Result.succeed(through)
}

/**
 * What a scan read of its index against what its result requires (see judgeServing): its loops; the entries its index
 * condition matched over every loop, the rows it returned and those its filter rechecked (each of which PostgreSQL
 * reports per loop), its probe's own; its heap
 * fetches, one per entry for an Index Scan and those its visibility map does not prove for an Index Only Scan; the
 * buffers it touched itself, beside those of the plans under it (a subplan its filter runs), which PostgreSQL counts in
 * its own too; and the bound on them, a descent per loop, the result's share of the index's pages and a page per fetch.
 */
interface ScanReads {
	readonly loops: number
	readonly entries: number
	readonly fetched: number
	readonly touched: number
	readonly bound: number
}

/** The buffers a node touched, shared hit and read, PostgreSQL's own count, the nodes under it included. */
export const touchedBy = (node: PlanNode): number =>
	node.buffers.sharedHit + node.buffers.sharedRead

/** What a scan of an index of `scanned`'s facts read (ScanReads). */
export const scanReads = (scan: PlanNode, scanned: IndexFacts): ScanReads => {
	const loops = Math.max(1, scan.actualLoops)
	const entries = (scan.actualRows + scan.rowsRemovedByFilter) * scan.actualLoops
	const fetched = Option.getOrElse(scan.heapFetches, () => entries)
	const under = Arr.reduce(scan.children, 0, (sum, child) => sum + touchedBy(child))
	const share = Math.ceil((entries * scanned.pages) / scanned.entries)
	return {
		loops,
		entries,
		fetched,
		touched: Math.max(0, touchedBy(scan) - under),
		bound: descentPages[scanned.method] * loops + share + fetched
	}
}

/**
 * Why a scan of `index` descended into it more often than it looped (see judgeServing), as a B-tree skip scan over a
 * column the probe leaves unbound does; none for a scan that descends once per loop.
 */
export const extraDescents = (scan: PlanNode, index: string): Option.Option<string> => {
	const loops = Math.max(1, scan.actualLoops)
	return Option.isSome(scan.indexSearches) && scan.indexSearches.value > loops
		? Option.some(
				loops === 1
					? `${scan.indexSearches.value} descents of ${index}`
					: `${scan.indexSearches.value} descents of ${index} over ${loops} loops`
			)
		: Option.none()
}

/** Why a scan of `index` touched more buffers than its bound (scanReads); none for a scan within it. */
export const overBound = (
	scan: PlanNode,
	index: string,
	scanned: IndexFacts
): Option.Option<string> => {
	const read = scanReads(scan, scanned)
	return read.touched > read.bound
		? Option.some(
				`${read.touched} buffers of ${index} for ${read.entries} of its ${scanned.entries} entries over ${scanned.pages} pages and ${read.fetched} heap fetches, over ${read.bound}`
			)
		: Option.none()
}

/**
 * The verdict on a probe's plan (see the header), `planned` the indexes the installation planned on the probe's
 * relation, by name, `facts` every planned index's facts, and `claimed` whether a scan of an index is held to the
 * engine's claim, every condition the probe states on its keys the index's.
 */
const verdictOf = (
	probe: Probe,
	plan: PlanNode,
	planned: ReadonlyMap<string, PlannedIndex>,
	facts: ReadonlyMap<string, IndexFacts>,
	claimed: (index: string) => boolean
): Verdict => {
	const nodes = [...planNodes(plan)]
	const scans = Arr.filter(
		nodes,
		(n) => Option.isSome(n.relation) && n.relation.value === probe.table.name
	)
	const [scan, ...more] = scans
	if (scan === undefined || more.length > 0) {
		return { kind: "unserved", why: `${scans.length} scans of the relation` }
	}
	const read = plannedScan(scan, planned, conditioned[probe.shape])
	if (Result.isFailure(read)) {
		return { kind: "unserved", why: read.failure }
	}
	const through = read.success
	const index = through.index.name
	const scanned = facts.get(index)
	if (scanned === undefined) {
		return assert.fail(`${probe.label}: no facts read for ${index}`)
	}
	const unheld = Arr.filter(probe.bound, (field) => !scanned.fields.has(field))
	const keyed =
		scanned.unique && Arr.every([...scanned.fields], (field) => probe.bound.includes(field))
	if (claimed(index) && Arr.isReadonlyArrayNonEmpty(unheld) && !keyed) {
		return {
			kind: "unserved",
			why: `a scan of ${index}, which does not hold ${Arr.join(unheld, ", ")}, so a filter rechecks them`
		}
	}
	if (scan.rowsRemovedByFilter > 0 && scan.rowsRemovedByFilter !== probe.rechecked) {
		return {
			kind: "unserved",
			why: `a scan of ${index} removing ${scan.rowsRemovedByFilter} rows by a filter, where its selection excludes ${probe.rechecked}`
		}
	}
	if (orderedShape[probe.shape] && Arr.some(nodes, (n) => sorts.has(n.nodeType))) {
		return { kind: "unserved", why: `a sort above the scan of ${index}` }
	}
	const swept = Option.orElse(extraDescents(scan, index), () => overBound(scan, index, scanned))
	return Option.isSome(swept)
		? { kind: "swept", through, why: swept.value }
		: { kind: "served", through }
}

const analyzed = { serialize: { kind: "off" }, wal: false } as const

/**
 * Each probe with its plan, run in one transaction rolled back, with sequential and bitmap scans disabled and `before`
 * run first. Each probe runs twice and its second run is judged: a first execution reads the catalog rows its scan's
 * operator classes need, which PostgreSQL counts in the scan's buffers.
 */
const planned = (probes: ReadonlyArray<Probe>, before: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		return yield* Effect.acquireUseRelease(
			admin.query("BEGIN", []),
			() =>
				Effect.gen(function* () {
					for (const s of [
						"SET LOCAL enable_seqscan = off",
						"SET LOCAL enable_bitmapscan = off",
						...before
					]) {
						yield* admin.query(s, [])
					}
					const plans: Array<readonly [Probe, PlanNode]> = []
					for (const probe of probes) {
						const explain = explainStatementWith(probe.sql, analyzed)
						yield* admin.queryValues(explain, [])
						const rows = yield* admin.queryValues(explain, [])
						const plan = parsePlan(rows[0]?.[0])
						if (Result.isFailure(plan)) {
							return assert.fail(`${probe.label}: no plan: ${plan.failure.message}`)
						}
						plans.push([probe, plan.success.plan])
					}
					return plans
				}),
			() => Effect.ignore(admin.query("ROLLBACK", []))
		)
	})

/**
 * A sweep of another planned index than the request's own that no plan the engine makes avoids, by the PostgreSQL
 * behaviour behind it.
 */
type Residue =
	| "swept through another GiST index, gistcostestimate blind to its key order"
	| "swept through another partial B-tree, skip-scan costing it below the heap an index of every row fetches"

/** What the judgment noted of one request or one created index. */
export type ServingFeature =
	| `${Shape} probe served`
	| "served by a key or enforcement index"
	| "served by a created index"
	| "read through another planned index than the engine's"
	| Residue
	| "a GiST index serving a B-tree request"
	| "a created index needed"
	| "a relation its key bounds below the load, not judged"

/**
 * PostgreSQL's judgment of the index engine (physical/indexes/engine.ts) over an installation at volume: whether each
 * index request the engine claims served is served, and whether each index it created is needed.
 *
 * The engine plans every request onto an index it claims serves it. Nothing here restates which index serves which
 * request. Each request becomes a probe, the statement its use asks of its relation (shapeOf, from what each use means,
 * ir/products.ts accessUses), its values those of a row the relation holds, and PostgreSQL plans and runs it under
 * EXPLAIN (ANALYZE, BUFFERS) with sequential and bitmap scans disabled, so it reads through an index whenever one can
 * apply the probe at all. The probe is served when PostgreSQL ran it through one Index Scan or Index Only Scan of the
 * request's relation, on an index the installation planned (the request's own or another PostgreSQL finds cheaper);
 * when it is another, the probe runs again through the request's own alone, every other index of the relation dropped
 * in a transaction rolled back, and must be served there too, so the engine's claim is judged on the index it names:
 *
 * - with an index condition, when the probe fixes a column (every shape but an order);
 * - in one descent of the index (Index Searches at most 1), so a B-tree skip scan over a leading column the request
 *   does not fix does not serve it, as the engine states;
 * - through the request's own index, and through any index the needed check below reads, with every condition the
 *   probe states on its keys the index's: the index holds every field the probe fixes, so no filter rechecks one,
 *   however few rows the data lets that filter remove, but for a unique index all of whose keys the probe fixes, which
 *   finds the rows of one key, on which PostgreSQL rechecks the rest (physical/indexes/engine.ts: a unique index's
 *   keyed and pinned placements). Another index PostgreSQL chooses for its statistics, a column the load fills with
 *   distinct values say, is held to what it read, as the two rules below hold it;
 * - removing no row by a filter, but for a law's probe of selected rows on an index of every row, which serves it
 *   (physical/indexes/engine.ts: the rows an index holds): its filter removes exactly the rows the probe's key
 *   conditions match outside its selection, which PostgreSQL rechecks;
 * - with no sort above it, when the probe asks for an order;
 * - touching at most the buffers its result requires (shared hit and read, PostgreSQL's own count): the result's share of
 *   the index's pages, its entries (the rows it returned and those its filter rechecked) over the index's entries times
 *   its pages, rounded up; a heap page per entry an Index Scan fetched, or per Heap Fetch of an Index Only Scan; and the
 *   descent, the index's inner pages (two at this volume), the leaf its entries straddle into and the visibility map
 *   page, 4 for a B-tree and 8 for a GiST index, whose sibling keys overlap, so its probe may follow two paths down. The
 *   bound counts what the result requires and nothing the scan read beyond it, so a scan that sweeps the index, or a
 *   subtree of it under a column the probe leaves unbound, does not serve the probe, however large its result. Each
 *   probe's second run is judged (planned). Measured on PostgreSQL 19 at this volume, Booking's GiST span key (260
 *   pages, built as the rows load) touches 5 buffers for a probe on room and during, 7 for the 150 rows of one on room
 *   alone, and 93 for one on during alone; a primary key of 139 pages led by a boolean touches 69 for the 10,000 rows of
 *   an equality on it, half its entries, against a bound of 74. A nearest-vector probe has no such bound: HNSW reads a
 *   neighbourhood of its graph whatever the result.
 *
 * Two sweeps of another planned index than the request's own are ones no plan the engine makes avoids, and are excused
 * (residueOf), each through an index that holds every field the probe fixes, no order of whose keys serves the probe
 * beside the requests it serves, since no field of many values the probe fixes is fixed by all of them
 * (keyOrdersConflict). The request's own index alone must still serve the probe.
 *
 * - A GiST index's. gistcostestimate is blind to column position: it costs a GiST scan by the selectivity of all its
 *   conditions wherever their columns stand (genericcostestimate), and charges its descent ceil(ln N) comparisons where
 *   btcostestimate charges ceil(log2 N), so at the one leaf a selective result needs, PostgreSQL prefers that index to a
 *   B-tree the probe's fields lead, or to a GiST index of as many pages, and sweeps it. When a relation's requests need
 *   conflicting key orders, as a span predicate on (fixed, span), another on (span) and an equality lookup on (fixed) do,
 *   one of them is exposed whatever the plan. Measured on PostgreSQL 19 at this volume, an equality on a numeric of 141
 *   values costs 6.50 through a GiST index on (span, numeric) of 144 pages, which it sweeps in 145 buffers, and 6.51
 *   through a B-tree on (numeric, float8) of 97 pages, which reads 3.
 * - A partial B-tree's, read for a probe of its selection whose own index holds every row. When the distinct values of
 *   the columns before the probe's outnumber the index's pages, btcostestimate's skip-scan costing gives up skipping and
 *   costs a sweep of the whole index; an index-only sweep of a partial index fetches no heap page, where a scan of an
 *   index of every row fetches one per entry, the selection's and the rest it rechecks, and PostgreSQL sweeps the partial
 *   index, rightly, in fewer buffers. The engine orders a created index for the requests no planned index serves, so
 *   when the requests on a selection need conflicting key orders, as law probes of the held bookings on (room, id) and
 *   on (id) beside one on (room) that the span key's GiST index serves do, the one an index of every row serves is
 *   exposed; leading with room would take a second partial index, for (id).
 *   Measured on PostgreSQL 19 at this volume, that probe on room costs 364.04 through the partial B-tree on (id, room) of
 *   73 pages, which it sweeps in 74 buffers over 2 descents, and 442.90 through the span key's GiST index, which reads 117
 *   for its 150 entries.
 *
 * Each index the engine created must be needed: with it dropped, in a transaction rolled back, some request it serves
 * is no longer served. An index PostgreSQL can do without is one the engine built beside another that already serves
 * every request it holds.
 *
 * The populations load their relations at volume before judging (serving.test.ts), so a lookup and a sweep differ by
 * far more than the descent.
 *
 * Judges the installation (see the header): every problem, none when PostgreSQL agrees with every claim. `rowsOf` gives
 * each request's probe rows; `note` records what was judged.
 */
export const judgeServing = (
	installed: Judged,
	rowsOf: (request: IndexRequest) => ProbeRows,
	note: (feature: ServingFeature) => void
): Effect.Effect<ReadonlyArray<string>, SqlError | Schema.SchemaError, Substrate> =>
	Effect.gen(function* () {
		const indexes = installed.installation.indexes
		const relations = [...new Set(Arr.map(indexes, (i) => i.relation))]
		const tables = new Map<string, Table>()
		for (const r of relations) {
			tables.set(r, yield* tableOf(installed, r))
		}
		const plannedOn = (relation: string): ReadonlyMap<string, PlannedIndex> =>
			new Map(
				Arr.map(
					Arr.filter(indexes, (i) => i.relation === relation),
					(i) => [i.index.name, i] as const
				)
			)
		const tableFor = (relation: string): Table => {
			const t = tables.get(relation)
			return t ?? assert.fail(`no table read for ${relation}`)
		}
		/**
		 * A relation whose key admits fewer rows than the load wrote (its key fields closed handles, say) holds too few
		 * for any index to tell from a scan: its requests are not judged.
		 */
		const judged = Arr.filter(indexes, (i) => tableFor(i.relation).rows >= volumeRows)
		if (judged.length < indexes.length) {
			note("a relation its key bounds below the load, not judged")
		}
		const facts = yield* indexFacts(installed, judged, tableFor)
		const probes = new Map<IndexRequest, Probe>()
		for (const i of judged) {
			for (const r of i.requests) {
				probes.set(r, yield* probeOf(installed, tableFor(r.relation), r, rowsOf(r)))
			}
		}
		const probeFor = (r: IndexRequest): Probe => {
			const p = probes.get(r)
			return p ?? assert.fail("a request with no probe")
		}
		/**
		 * Whether no order of `through`'s keys serves the probe beside the requests it serves: it holds every field the
		 * probe fixes, and no field of many values the probe fixes is fixed by every request it serves, so no order leads,
		 * among its columns of many values, with a field that serves the probe beside them.
		 */
		const keyOrdersConflict = (through: PlannedIndex, probe: Probe): boolean => {
			const few = tableFor(through.relation).few
			const many = Arr.filter(
				probe.bound,
				(field) => !few.has(installed.installation.names.column(through.relation, field))
			)
			return (
				Arr.isReadonlyArrayNonEmpty(probe.bound) &&
				Arr.every(probe.bound, (field) => Arr.some(through.keys, (k) => k.field === field)) &&
				!Arr.some(many, (field) =>
					Arr.every(through.requests, (r) => probeFor(r).bound.includes(field))
				)
			)
		}
		/**
		 * The residue behind PostgreSQL's sweep of `through`, another planned index than `host`, the request's own, when it
		 * is one (see the header): with the key orders in conflict, a GiST index's, whose key order gistcostestimate is
		 * blind to, or a partial B-tree's read in place of an index of every row, which btcostestimate's skip-scan costing
		 * prices as a sweep below that index's heap fetches.
		 */
		const residueOf = (
			through: PlannedIndex,
			host: PlannedIndex,
			probe: Probe
		): Option.Option<Residue> => {
			if (!keyOrdersConflict(through, probe)) {
				return Option.none()
			}
			switch (through.method) {
				case "gist":
					return Option.some(
						"swept through another GiST index, gistcostestimate blind to its key order"
					)
				case "btree":
					return through.rows.kind === "selected" && host.rows.kind === "all"
						? Option.some(
								"swept through another partial B-tree, skip-scan costing it below the heap an index of every row fetches"
							)
						: Option.none()
				case "hnsw":
					return Option.none()
			}
		}
		/**
		 * The statements that drop every planned index of `host`'s relation but `host`, each with the key or exclusion
		 * constraint that owns it.
		 */
		const withoutOthers = (host: PlannedIndex) =>
			Effect.gen(function* () {
				const { admin } = yield* Substrate
				const q = installed.installation.names.relation(host.relation)
				const table = `${quoteIdent(q.schema)}.${quoteIdent(q.name)}`
				const statements: Array<string> = []
				for (const i of Arr.filter(
					indexes,
					(i) => i.relation === host.relation && i.index.name !== host.index.name
				)) {
					const index = `${quoteIdent(q.schema)}.${quoteIdent(i.index.name)}`
					const [owner] = yield* Schema.decodeUnknownEffect(Texts)(
						yield* admin.queryValues(
							"SELECT c.conname::text FROM pg_catalog.pg_constraint AS c WHERE c.conindid = $1::text::regclass " +
								"AND c.conrelid = $2::text::regclass AND c.contype IN ('p'::\"char\", 'u'::\"char\", 'x'::\"char\")",
							[index, table]
						)
					)
					const constraint = owner?.[0]
					statements.push(
						constraint === undefined
							? `DROP INDEX ${index}`
							: `ALTER TABLE ${table} DROP CONSTRAINT ${quoteIdent(constraint)} CASCADE`
					)
				}
				return statements
			})
		const problems: Array<string> = []
		/**
		 * Every request is served: through the index PostgreSQL chooses, held to the engine's claim when it is the
		 * request's own, or swept through another planned index, a residue no plan the engine makes avoids; and when
		 * PostgreSQL chooses another, through its own alone, every other index of the relation dropped, held to the claim.
		 */
		const served = (host: PlannedIndex) =>
			Effect.gen(function* () {
				const plans = yield* planned(Arr.map(host.requests, probeFor), [])
				for (const [request, [probe, plan]] of Arr.zip(host.requests, plans)) {
					const verdict = verdictOf(
						probe,
						plan,
						plannedOn(host.relation),
						facts,
						(index) => index === host.index.name
					)
					const residue =
						verdict.kind === "swept" && verdict.through.index.name !== host.index.name
							? residueOf(verdict.through, host, probe)
							: Option.none()
					if (verdict.kind === "unserved" || (verdict.kind === "swept" && Option.isNone(residue))) {
						problems.push(`${probe.label}, planned on ${host.index.name}: ${verdict.why}`)
						continue
					}
					const other = verdict.through.index.name !== host.index.name
					if (other) {
						const [alone] = yield* planned([probe], yield* withoutOthers(host))
						if (alone === undefined) {
							return assert.fail(`${probe.label}: no plan through ${host.index.name} alone`)
						}
						const claim = verdictOf(
							probe,
							alone[1],
							new Map([[host.index.name, host]]),
							facts,
							() => true
						)
						if (claim.kind !== "served") {
							problems.push(`${probe.label}, planned on ${host.index.name}, alone: ${claim.why}`)
							continue
						}
					}
					note(`${probe.shape} probe served`)
					note(
						host.index.kind === "created"
							? "served by a created index"
							: "served by a key or enforcement index"
					)
					if (other) {
						note("read through another planned index than the engine's")
					}
					if (Option.isSome(residue)) {
						note(residue.value)
					}
					if (host.method === "gist" && request.method === "btree") {
						note("a GiST index serving a B-tree request")
					}
				}
			})
		for (const i of judged) {
			yield* served(i)
		}
		for (const i of judged) {
			if (i.index.kind !== "created") {
				continue
			}
			const q = installed.installation.names.relation(i.relation)
			const plans = yield* planned(Arr.map(i.requests, probeFor), [
				`DROP INDEX ${quoteIdent(q.schema)}.${quoteIdent(i.index.name)}`
			])
			const without = new Map(
				Arr.filter([...plannedOn(i.relation)], ([name]) => name !== i.index.name)
			)
			const verdicts = Arr.map(
				plans,
				([probe, plan]) => [probe, verdictOf(probe, plan, without, facts, () => true)] as const
			)
			if (Arr.some(verdicts, ([, v]) => v.kind !== "served")) {
				note("a created index needed")
				continue
			}
			const through = Arr.flatMap(verdicts, ([p, v]) =>
				v.kind === "served" ? [`${p.label} through ${v.through.index.name}`] : []
			)
			problems.push(
				`${i.index.name} is not needed: without it PostgreSQL serves ${Arr.join(through, "; ")}`
			)
		}
		return problems
	})
