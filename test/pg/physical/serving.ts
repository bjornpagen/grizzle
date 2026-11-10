import { Array as Arr, Effect, Option, Order, Record as Rec, Result } from "effect"
import {
	explainStatementWith,
	type PlanNode,
	parsePlan,
	planNodes
} from "#bench/harness/explain.ts"

import type { Direction } from "#compiler/core/order.ts"
import * as EngineResult from "#compiler/core/result.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { defaultOpclass, type LawField } from "#compiler/ir/law.ts"
import type { AccessIndexRequest, AccessUse, IndexRequest } from "#compiler/ir/products.ts"
import type { IndexColumn } from "#compiler/physical/ddl/context.ts"
import { noTextDomainUses } from "#compiler/physical/ddl/domains.ts"
import type { PlannedIndex } from "#compiler/physical/indexes/engine.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import {
	type InstallExtension,
	noCertificates,
	noContribution
} from "#compiler/physical/install/extension.ts"
import { printObjectName, quoteIdent, quoteString } from "#compiler/sql/print.ts"
import { assert, defined } from "#test/support/assert.ts"
import { parsedName, wild } from "#test/support/kernel/naming.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { beginSerializable } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

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
 * A law's probe by its access method: a B-tree probe looks every requested column up by equality, as a hash probe looks
 * up its one column, and a GiST probe tests equality on each scalar and overlap on each span (a PERIOD reference's, a
 * coverage's).
 */
const lawShape: Readonly<Record<IndexRequest["method"], Shape>> = {
	btree: "equality",
	hash: "equality",
	gist: "overlap",
	hnsw: "nearest"
}

const shapeOf = (r: IndexRequest): Shape =>
	r.role === "access" ? accessShape[r.use] : lawShape[r.method]

/**
 * The fields among a request's `fields`, in key order, one of which leads, among its keys of many values (`many`), every
 * order of an index that serves the request (physical/indexes/engine.ts, the placements): any of many values for an
 * equality or an overlap; one of the prefix before a range's bounded key, or that key after a prefix of few values; an
 * order's first of many values; none for the nearest vectors, which one column holds.
 */
const leadsOf: Readonly<
	Record<
		Shape,
		(
			fields: ReadonlyArray<string>,
			many: (fields: ReadonlyArray<string>) => ReadonlyArray<string>
		) => ReadonlyArray<string>
	>
> = {
	equality: (fields, many) => many(fields),
	range: (fields, many) => {
		const prefix = many(fields.slice(0, -1))
		return Arr.isReadonlyArrayNonEmpty(prefix) ? prefix : many(fields.slice(-1))
	},
	ordered: (fields, many) => many(fields).slice(0, 1),
	overlap: (fields, many) => many(fields),
	nearest: () => []
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
 * a GiST index, whose sibling keys overlap, so its probe may follow two paths down. A hash scan reads the metapage and
 * every page of its bucket's chain: the primary page, an overflow page of the entries the other values hashed to the
 * bucket hold (a split keeps a bucket's average under a page), and the page its own entries straddle into; it never
 * scans index-only, so reads no visibility map page. An HNSW scan reads a neighbourhood of its graph whatever the
 * result.
 */
const descentPages: Readonly<Record<PlannedIndex["method"], number>> = {
	btree: 4,
	hash: 4,
	gist: 8,
	hnsw: Number.POSITIVE_INFINITY
}

/**
 * An operator a probe's condition on a key applies, by its name as pg_operator holds it: equality, a range's bounds, or
 * a span's overlap.
 */
type KeyOperator = "=" | ">=" | "<=" | "&&"

/**
 * One key of a planned index: the field it holds, and the operators its column's operator family searches it by
 * (pg_amop's search operators), as PostgreSQL's catalog states them. A condition on the field by another operator, a
 * B-tree's or a hash index's on a span by overlap, or a GiST index's on a span by a bound, is no index condition of it.
 */
interface SearchedKey {
	readonly field: string
	readonly searches: ReadonlySet<string>
	readonly values: KeyValues
}

/**
 * How many values a B-tree skip scan may step an index key's column through, read from its type and never its rows
 * (Table.closed): at most `count` for a closed column, a boolean or a closed id, or no bound for any other.
 */
type KeyValues = { readonly kind: "closed"; readonly count: number } | { readonly kind: "open" }

/**
 * How an index tells the values of its leading key apart as it places them (see judgeServing): exactly, or, a GiST index
 * led by text that holds a multibyte character, by the byte after the common prefix of a subtree's bounds, as btree_gist
 * prices text through PostgreSQL 19, so characters that share leading bytes price alike (README, PostgreSQL known
 * issues).
 */
type LeadPricing = "exact" | "shared leading bytes"

/**
 * What the judgment reads of a planned index: its access method, its keys and what it searches each by, whether it is
 * unique, its pages, its entries, a row each, and how it prices its leading key (LeadPricing).
 */
export interface IndexFacts {
	readonly method: PlannedIndex["method"]
	readonly keys: ReadonlyArray<SearchedKey>
	readonly unique: boolean
	readonly pages: number
	readonly entries: number
	readonly lead: LeadPricing
}

/** What the judgment reads of an installation: the PostgreSQL schema it lives in and what it planned and named. */
export interface Judged {
	readonly schema: string
	readonly installation: Installation
}

/**
 * A request a suite hands the engine itself, as it states it: a workload access by its use, whose access method the use
 * fixes (a span predicate is GiST's, an approximate retrieval HNSW's, every other use a B-tree's), or a law's B-tree
 * probe. Each key names a field of the relation once.
 */
export type RequestSpec =
	| {
			readonly kind: "access"
			readonly relation: string
			readonly use: AccessUse
			readonly keys: Arr.NonEmptyReadonlyArray<{
				readonly field: string
				readonly dir: Direction
			}>
	  }
	| {
			readonly kind: "law"
			readonly relation: string
			readonly keys: Arr.NonEmptyReadonlyArray<string>
	  }

const methodOfUse: Readonly<Record<AccessUse, AccessIndexRequest["method"]>> = {
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
		: `a law probe on ${spec.relation}(${Arr.join(spec.keys, ", ")})`

/** One key of a law's index request. */
type LawKey = Extract<IndexRequest, { readonly role: "lawMaintenance" }>["keys"][number]

/** A request's keys by the field or law column each names, in index order. */
const requestKeys = (
	request: IndexRequest
): ReadonlyArray<{
	readonly field: string
	readonly dir: Direction
	readonly opclass: LawKey["opclass"]
}> =>
	request.role === "lawMaintenance"
		? Arr.map(request.keys, (k) => ({
				field: k.column.kind === "field" ? k.column.field.name : k.column.column,
				dir: k.dir,
				opclass: k.opclass
			}))
		: Arr.map(request.keys, (k) => ({ field: String(k.expr), dir: k.dir, opclass: k.opclass }))

/** An index key's column as text: a field's name, or a law column's identifier. */
const keyText = (key: { readonly column: IndexColumn }): string =>
	key.column.kind === "field" ? key.column.field : key.column.column

/** The installed column an index key of `relation` holds: a field's, or a law column, its identifier its column's name. */
const keyColumn = (
	installed: Judged,
	relation: string,
	key: { readonly column: IndexColumn }
): string =>
	key.column.kind === "field"
		? installed.installation.names.column(relation, key.column.field)
		: key.column.column

/** A stored relation's field as the law model holds it, which a law's request names its key columns by. */
type FieldOf = (relation: string, field: string) => LawField

/**
 * The engine's request of a spec, `at` its position, which names a law's: an access's keys by field name, a law's by
 * the law model's field (`fieldOf`).
 */
const requestOf = (spec: RequestSpec, at: number, fieldOf: FieldOf): IndexRequest => {
	switch (spec.kind) {
		case "access":
			return {
				relation: spec.relation,
				keys: Arr.map(spec.keys, (k) => ({ expr: k.field, dir: k.dir, opclass: defaultOpclass })),
				method: methodOfUse[spec.use],
				role: "access",
				use: spec.use
			}
		case "law":
			return {
				relation: spec.relation,
				keys: Arr.map(spec.keys, (field): LawKey => ({
					column: { kind: "field", field: fieldOf(spec.relation, field) },
					dir: "asc",
					opclass: defaultOpclass
				})),
				method: "btree",
				role: "lawMaintenance",
				use: "reverse reference",
				justification: { kind: "law", law: wild.lawId(`drawn${at}`) }
			}
	}
}

/** The installer extension that hands the engine the specs' requests. */
export const drawnRequests = (specs: ReadonlyArray<RequestSpec>): InstallExtension => ({
	contribute: (builder) => {
		const fieldOf: FieldOf = (relation, field) => {
			const r = builder.model.theory.relations[relation]
			const found = r === undefined ? undefined : Arr.findFirst(r.fields, (f) => f.name === field)
			if (found === undefined || found._tag === "None") {
				return assert.fail(`the law model holds no field ${relation}.${field}`)
			}
			return found.value
		}
		return EngineResult.ok({
			...noContribution,
			indexRequests: Arr.map(specs, (spec, at) => requestOf(spec, at, fieldOf))
		})
	},
	textDomainUses: noTextDomainUses,
	certifies: noCertificates
})

/**
 * What a plan states of one index, as two plans of one request set compare: its name, whether the engine created it or
 * another object installs it (a key's or an enforcement index), its access method, its keys in index order with their
 * directions, and the uses of the requests it serves, each once, sorted.
 */
export interface PlannedShape {
	readonly index: string
	readonly origin: PlannedIndex["index"]["kind"]
	readonly method: string
	readonly keys: ReadonlyArray<{ readonly field: string; readonly dir: Direction }>
	readonly uses: ReadonlyArray<string>
}

/** The plan's indexes, in plan order (see PlannedShape). */
export const planShape = (installed: Judged): ReadonlyArray<PlannedShape> =>
	Arr.map(installed.installation.indexes, (i) => ({
		index: i.index.name,
		origin: i.index.kind,
		method: i.method,
		keys: Arr.map(i.keys, (k) => ({ field: keyText(k), dir: k.dir })),
		uses: Arr.sort(Arr.dedupe(Arr.map(i.requests, (r) => r.use)), Order.String)
	}))

/** A roster's domain, qualified and quoted, as a cast to a closed id's code names it. */
export const rosterDomainSql = (installed: Judged, roster: string): string =>
	printObjectName(installed.installation.names.rosterDomain(parsedName(roster)))

/**
 * A relation's table as the probes read it: quoted and qualified, its own name as EXPLAIN reports a scan's relation,
 * its columns whose type is a range type, directly or under domains, those of few values, a boolean's or a closed id's
 * (a code under its roster's domain), so that fixing one bounds no scan, and the rows it holds.
 */
interface Table {
	readonly quoted: string
	/** The schema of the level that installs the relation, which its table or view and their indexes stand in. */
	readonly schema: string
	readonly name: string
	readonly spans: ReadonlySet<string>
	/**
	 * The closed columns, each by the most values PostgreSQL's B-tree skip scan steps it through, read from its type and
	 * never its rows: a boolean's two, whose skip support knows both ends; a closed id's every code its roster minted,
	 * holes included, and one step past the greatest, since the skip support of the smallint under its domain steps by
	 * one and reads no CHECK; and one more where the column admits null.
	 */
	readonly closed: ReadonlyMap<string, number>
	/** The columns of a vector type, which only the extension's qualified operators compare. */
	readonly vectors: ReadonlySet<string>
	/** The columns of a text type, under its domains, that hold a multibyte character on some row. */
	readonly multibyte: ReadonlySet<string>
	readonly rows: number
}

/**
 * What a column of a table holds, by its type under its domains: a span, a boolean, or anything else; whether its type
 * is the vector extension's; whether it is a text type; and whether it admits null.
 */
type ColumnHolds = ReadonlyArray<
	readonly [
		string,
		"span" | "boolean" | "other",
		"true" | "false",
		"true" | "false",
		"true" | "false"
	]
>

const columnHoldsOf = (rows: unknown): ColumnHolds => trusted<ColumnHolds>(rows)

/**
 * The columns of a relation's closed-id fields, each with the values a skip scan steps it through (Table.closed): every
 * code its roster minted and the one past them.
 */
const closedIdColumns = (
	installed: Judged,
	relation: string
): ReadonlyArray<readonly [column: string, steps: number]> => {
	const owned = installed.installation.owned.relations[relation]
	return owned === undefined
		? []
		: Arr.flatMap(Rec.values(owned.fields), (f) =>
				f.desc.kind === "closedId"
					? [
							[
								f.column,
								defined(
									installed.installation.names.codes.rosters.get(parsedName(f.desc.roster)),
									`the codes of roster ${f.desc.roster}`
								).size + 1
							] as const
						]
					: []
			)
}

const tableOf = (installed: Judged, relation: string) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const q = installed.installation.names.relation(relation)
		const quoted = `${quoteIdent(q.schema)}.${quoteIdent(q.name)}`
		const columns = yield* Effect.map(
			admin.queryValues(
				"WITH RECURSIVE base(name, oid, typtype, typbasetype, typnamespace, typcategory, required) AS (" +
					"SELECT a.attname, t.oid, t.typtype, t.typbasetype, t.typnamespace, t.typcategory, a.attnotnull FROM pg_catalog.pg_attribute AS a " +
					"JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid " +
					"WHERE a.attrelid = $1::text::regclass AND a.attnum > 0 AND NOT a.attisdropped " +
					"UNION ALL SELECT b.name, t.oid, t.typtype, t.typbasetype, t.typnamespace, t.typcategory, b.required FROM base AS b " +
					"JOIN pg_catalog.pg_type AS t ON t.oid = b.typbasetype WHERE b.typtype = 'd'::\"char\") " +
					"SELECT name::text, CASE WHEN typtype = 'r'::\"char\" THEN 'span' " +
					"WHEN oid = 'pg_catalog.bool'::pg_catalog.regtype THEN 'boolean' ELSE 'other' END, " +
					"(typnamespace = $2::text::pg_catalog.regnamespace)::text, " +
					"(typcategory = 'S'::\"char\")::text, " +
					"(NOT required)::text " +
					"FROM base WHERE typtype <> 'd'::\"char\"",
				[quoted, quoteIdent(installed.installation.names.vectorSchema)]
			),
			columnHoldsOf
		)
		const holding = (holds: "span" | "boolean"): ReadonlySet<string> =>
			new Set(
				Arr.map(
					Arr.filter(columns, ([, h]) => h === holds),
					([name]) => name
				)
			)
		const nullable = new Set(
			Arr.map(
				Arr.filter(columns, ([, , , , admitsNull]) => admitsNull === "true"),
				([name]) => name
			)
		)
		const closed = new Map(
			Arr.map(
				[
					...Arr.map([...holding("boolean")], (name) => [name, 2] as const),
					...closedIdColumns(installed, relation)
				],
				([name, count]) => [name, nullable.has(name) ? count + 1 : count] as const
			)
		)
		const rows = yield* countOf(admin, `SELECT count(*)::text FROM ${quoted}`)
		const multibyte = new Set<string>()
		for (const [name, , , text] of columns) {
			if (text === "false") {
				continue
			}
			const [row] = yield* Effect.map(
				admin.queryValues(
					`SELECT EXISTS (SELECT FROM ${quoted} WHERE octet_length(${quoteIdent(name)}) > char_length(${quoteIdent(name)}))::text`,
					[]
				),
				textsOf
			)
			if (row?.[0] === "true") {
				multibyte.add(name)
			}
		}
		return {
			quoted,
			schema: q.schema,
			name: q.name,
			spans: holding("span"),
			closed,
			vectors: new Set(
				Arr.map(
					Arr.filter(columns, ([, , vector]) => vector === "true"),
					([name]) => name
				)
			),
			multibyte,
			rows
		} satisfies Table
	})

/** Each key column of an index, by name, with an operator its operator family searches it by, a row each. */
type ColumnSearches = ReadonlyArray<readonly [string, string]>

const columnSearchesOf = (rows: unknown): ColumnSearches => trusted<ColumnSearches>(rows)

/**
 * Each of `indexes`, by name, with its facts (IndexFacts): its entries are every row of its table, and each key is
 * searched by the operators its column's operator family searches by.
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
			const [row] = yield* Effect.map(
				admin.queryValues(
					"SELECT (pg_catalog.pg_relation_size(c.oid) / pg_catalog.current_setting('block_size')::bigint)::text " +
						"FROM pg_catalog.pg_class AS c " +
						"JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace JOIN pg_catalog.pg_index AS x ON x.indexrelid = c.oid " +
						"WHERE n.nspname = $1::text AND c.relname = $2::text",
					[table.schema, i.index.name]
				),
				textsOf
			)
			const pages = row?.[0]
			if (pages === undefined) {
				return assert.fail(`no index ${i.index.name} in ${table.schema}`)
			}
			const searches = yield* Effect.map(
				admin.queryValues(
					"SELECT a.attname::text, o.oprname::text FROM pg_catalog.pg_class AS c " +
						"JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace JOIN pg_catalog.pg_index AS x ON x.indexrelid = c.oid " +
						"CROSS JOIN LATERAL ROWS FROM (pg_catalog.unnest(x.indkey::pg_catalog.int2[]), pg_catalog.unnest(x.indclass::pg_catalog.oid[])) AS k(attnum, opclass) " +
						"JOIN pg_catalog.pg_attribute AS a ON a.attrelid = x.indrelid AND a.attnum = k.attnum " +
						"JOIN pg_catalog.pg_opclass AS oc ON oc.oid = k.opclass " +
						"JOIN pg_catalog.pg_amop AS m ON m.amopfamily = oc.opcfamily AND m.amoppurpose = 's'::\"char\" " +
						"JOIN pg_catalog.pg_operator AS o ON o.oid = m.amopopr " +
						"WHERE n.nspname = $1::text AND c.relname = $2::text",
					[table.schema, i.index.name]
				),
				columnSearchesOf
			)
			facts.set(i.index.name, {
				method: i.method,
				keys: Arr.map(i.keys, (k): SearchedKey => {
					const column = keyColumn(installed, i.relation, k)
					const count = table.closed.get(column)
					return {
						field: keyText(k),
						searches: new Set(
							Arr.flatMap(searches, ([name, operator]) => (name === column ? [operator] : []))
						),
						values: count === undefined ? { kind: "open" } : { kind: "closed", count }
					}
				}),
				unique: i.unique,
				pages: Number(pages),
				entries: table.rows,
				lead:
					i.method === "gist" &&
					Arr.some(i.keys.slice(0, 1), (k) =>
						table.multibyte.has(keyColumn(installed, i.relation, k))
					)
						? "shared leading bytes"
						: "exact"
			})
		}
		return facts
	})

/** Every index the installation planned, by name, with its facts (IndexFacts), each relation's table read once. */
export const plannedFacts = (
	installed: Judged
): Effect.Effect<ReadonlyMap<string, IndexFacts>, SqlError, Substrate> =>
	Effect.gen(function* () {
		const indexes = installed.installation.indexes
		const tables = new Map<string, Table>()
		for (const r of new Set(Arr.map(indexes, (i) => i.relation))) {
			const table = yield* tableOf(installed, r)
			tables.set(r, table)
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
 * table's. A load of no field inserts rows of defaults only, a serial numbering each.
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
		const columns = (l: VolumeLoad): string =>
			l.fields.length === 0
				? ""
				: ` (${Arr.join(
						Arr.map(l.fields, ([field]) =>
							quoteIdent(installed.installation.names.column(l.relation, field))
						),
						", "
					)})`
		const inserts = Arr.map(
			loads,
			(l) =>
				`INSERT INTO ${table(l.relation)}${columns(l)} SELECT ${Arr.join(
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

/** A condition a probe states on a key: the field, the operator it applies, and the value's literal. */
interface KeyCondition {
	readonly field: string
	readonly operator: KeyOperator
	readonly value: string
}

/** A probe's statement: the conditions it states on its keys, and what follows its WHERE clause. */
interface Statement {
	readonly conditions: ReadonlyArray<KeyCondition>
	readonly tail: string
}

/**
 * One request's probe: the statement, its shape, its relation's table, what the report calls it, and the conditions it
 * states on its keys (every key's for a shape that fixes its columns, none for an order or the nearest vectors).
 */
interface Probe {
	readonly label: string
	readonly shape: Shape
	readonly table: Table
	readonly sql: string
	readonly conditions: ReadonlyArray<KeyCondition>
}

/** The fields a probe's conditions fix, in key order, each once. */
const boundOf = (probe: Probe): ReadonlyArray<string> =>
	Arr.dedupe(Arr.map(probe.conditions, (c) => c.field))

/** Whether a key of an index searches a condition: it holds the condition's field under an operator family that
 * searches by its operator. */
const searchedBy = (k: SearchedKey, c: KeyCondition): boolean =>
	k.field === c.field && k.searches.has(c.operator)

/** The conditions of a probe that no key of an index searches, so that a filter rechecks them on what the index finds. */
const unsearchedOf = (scanned: IndexFacts, probe: Probe): ReadonlyArray<KeyCondition> =>
	Arr.filter(probe.conditions, (c) => !Arr.some(scanned.keys, (k) => searchedBy(k, c)))

type Texts = ReadonlyArray<ReadonlyArray<string>>

const textsOf = (rows: unknown): Texts => trusted<Texts>(rows)

/** The one count a `SELECT count(*)::text` statement answers. */
const countOf = (admin: PgConnection, sql: string): Effect.Effect<number, SqlError> =>
	Effect.map(admin.queryValues(sql, []), (rows) => Number(textsOf(rows)[0]?.[0]))

const where = (conditions: ReadonlyArray<string>): string =>
	conditions.length === 0 ? "" : ` WHERE ${Arr.join(conditions, " AND ")}`

/** The probe of `request` (see the header): its values those of the middle row of its table, in physical order. */
const probeOf = (installed: Judged, table: Table, request: IndexRequest) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const column = (field: string): string =>
			quoteIdent(installed.installation.names.column(request.relation, field))
		const keys = requestKeys(request)
		const label = `${request.role} ${request.use} on ${request.relation}(${Arr.join(
			Arr.map(keys, (k) => `${k.field}${k.dir === "desc" ? " desc" : ""}`),
			", "
		)}) by ${request.method}`
		const shape = shapeOf(request)
		const sampled = sampledShape[shape] ? keys : []
		const sample =
			sampled.length === 0
				? []
				: (yield* Effect.map(
						admin.queryValues(
							`SELECT ${Arr.join(
								Arr.map(sampled, (k) => `${column(k.field)}::text`),
								", "
							)} FROM ${table.quoted} ` +
								`ORDER BY ctid OFFSET (SELECT count(*) / 2 FROM ${table.quoted}) LIMIT 1`,
							[]
						),
						textsOf
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
		/** `op` between two values of a key's column: the extension's qualified operator over a vector. */
		const operator = (field: string, op: KeyOperator): string =>
			table.vectors.has(installed.installation.names.column(request.relation, field))
				? `OPERATOR(${quoteIdent(installed.installation.names.vectorSchema)}.${op})`
				: op
		/** Each of the first `count` keys equal to its sampled value. */
		const equal = (count: number): ReadonlyArray<KeyCondition> =>
			Arr.map(keys.slice(0, count), (k, at): KeyCondition => ({
				field: k.field,
				operator: "=",
				value: value(at)
			}))
		/**
		 * A range probe's bounds on its last key: after an equality prefix, the half of the column's extent that holds
		 * the sampled value, from its least value to its median or from its median to its greatest, so the prefix's
		 * rows are what an index taking the column right after the prefix reads, a scan of the prefix's rows alone
		 * rechecks the column on them, an index taking the column first reads half, and the sampled row is among the
		 * probe's; alone, the sampled value, so the probe reads a point of the column, not half of it.
		 */
		const rangeBounds = (at: number, c: string, le: string) =>
			at === 0
				? Effect.succeed({ lo: value(at), hi: value(at) })
				: Effect.map(
						Effect.map(
							admin.queryValues(
								`WITH m AS (SELECT (SELECT ${c} FROM ${table.quoted} ORDER BY ${c} LIMIT 1) AS lo, ` +
									`(SELECT ${c} FROM ${table.quoted} ORDER BY ${c} OFFSET (SELECT count(*) / 2 FROM ${table.quoted}) LIMIT 1) AS mid, ` +
									`(SELECT ${c} FROM ${table.quoted} ORDER BY ${c} DESC LIMIT 1) AS hi) ` +
									`SELECT (CASE WHEN ${value(at)} ${le} mid THEN lo ELSE mid END)::text, ` +
									`(CASE WHEN ${value(at)} ${le} mid THEN mid ELSE hi END)::text FROM m`,
								[]
							),
							textsOf
						),
						(extent) => {
							const [lo, hi] = extent[0] ?? []
							return lo === undefined || hi === undefined
								? assert.fail(`${label}: no extent of ${c}`)
								: { lo: quoteString(lo), hi: quoteString(hi) }
						}
					)
		/** The probe's conditions on its keys and what follows its WHERE clause, by its shape. */
		const statement = yield* Effect.suspend((): Effect.Effect<Statement, SqlError> => {
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
					return Effect.map(
						rangeBounds(last, c, operator(bounded.field, "<=")),
						({ lo, hi }): Statement => ({
							conditions: [
								...equal(last),
								{ field: bounded.field, operator: ">=", value: lo },
								{ field: bounded.field, operator: "<=", value: hi }
							],
							tail: ""
						})
					)
				}
				case "overlap":
					return Effect.succeed({
						conditions: Arr.map(keys, (k, at): KeyCondition => ({
							field: k.field,
							operator: table.spans.has(
								installed.installation.names.column(request.relation, k.field)
							)
								? "&&"
								: "=",
							value: value(at)
						})),
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
		const { conditions } = statement
		const stated = Arr.map(
			conditions,
			(k) => `${column(k.field)} ${operator(k.field, k.operator)} ${k.value}`
		)
		const sql = `SELECT 1 FROM ${table.quoted}${where(stated)}${statement.tail}`
		return { label, shape, table, sql, conditions } satisfies Probe
	})

/** What a swept scan read past: more descents of its index than it looped, or more buffers than its bound. */
type Past = "descents" | "buffers"

/** How a served scan descended into its index: once a loop, or by a skip scan within its descents (skipDescents). */
type Descended = "once a loop" | "by a skip scan"

/**
 * What PostgreSQL made of a probe: served through a planned index; swept through one, the scan meeting every rule but
 * reading past what its result requires (Past); or not served, and why. A scan of an index carries the buffers it
 * touched (scanReads).
 */
type Verdict =
	| {
			readonly kind: "served"
			readonly through: PlannedIndex
			readonly touched: number
			readonly descended: Descended
	  }
	| {
			readonly kind: "swept"
			readonly through: PlannedIndex
			readonly touched: number
			readonly past: Past
			readonly why: string
	  }
	| { readonly kind: "unserved"; readonly why: string }

const sorts: ReadonlySet<string> = new Set(["Sort", "Incremental Sort"])

/**
 * The planned index a scan reads, held to the rules every probe's scan meets (see judgeServing): an Index Scan or Index
 * Only Scan of an index the installation planned (`planned`, by name), with an index condition when its probe fixes a
 * column (`fixes`); or why it is none.
 */
const plannedScan = (
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
 * its own too; and the bound on them, the pages of each descent, at least one a loop, the result's share of the index's
 * pages and a page per fetch.
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
	const descents = Math.max(
		loops,
		Option.getOrElse(scan.indexSearches, () => loops)
	)
	const entries = (scan.actualRows + scan.rowsRemovedByFilter) * scan.actualLoops
	const fetched = Option.getOrElse(scan.heapFetches, () => entries)
	const under = Arr.reduce(scan.children, 0, (sum, child) => sum + touchedBy(child))
	const share = Math.ceil((entries * scanned.pages) / scanned.entries)
	return {
		loops,
		entries,
		fetched,
		touched: Math.max(0, touchedBy(scan) - under),
		bound: descentPages[scanned.method] * descents + share + fetched
	}
}

/**
 * The descents a loop of a scan of an index of `scanned`'s facts may make for a probe of `conditions` (see judgeServing):
 * those of PostgreSQL's B-tree skip scan over the keys the probe skips, the product of the values it steps each through,
 * where the probe fixes the index's first key by equality and every key it skips, one before the last key it conditions
 * that it leaves unconditioned, is closed (KeyValues); one for any other scan.
 */
const skipDescents = (scanned: IndexFacts, conditions: ReadonlyArray<KeyCondition>): number => {
	const conditioned = (k: SearchedKey): boolean => Arr.some(conditions, (c) => searchedBy(k, c))
	const last = Option.getOrElse(Arr.findLastIndex(scanned.keys, conditioned), () => 0)
	const skipped = Arr.filter(scanned.keys, (k, at) => at < last && !conditioned(k))
	const counts = Arr.flatMap(skipped, (k) => (k.values.kind === "closed" ? [k.values.count] : []))
	const led = Arr.some(scanned.keys.slice(0, 1), (k) =>
		Arr.some(conditions, (c) => c.operator === "=" && searchedBy(k, c))
	)
	return scanned.method === "btree" && led && counts.length === skipped.length
		? Arr.reduce(counts, 1, (product, count) => product * count)
		: 1
}

/** A scan whose statement's conditions the judgment does not state: one descent a loop (skipDescents). */
export const unstatedDescents = (): number => 1

/**
 * Why a scan of `index` descended into it more often than `allowed` times a loop (skipDescents), as a B-tree skip scan
 * over a column the probe leaves unbound does; none for a scan within them.
 */
const extraDescents = (scan: PlanNode, index: string, allowed: number): Option.Option<string> => {
	const loops = Math.max(1, scan.actualLoops)
	return Option.isSome(scan.indexSearches) && scan.indexSearches.value > loops * allowed
		? Option.some(
				`${scan.indexSearches.value} descents of ${index}${loops === 1 ? "" : ` over ${loops} loops`}${allowed === 1 ? "" : `, past the ${allowed} a loop its skipped closed keys allow`}`
			)
		: Option.none()
}

/** Why a scan of `index` touched more buffers than its bound (scanReads); none for a scan within it. */
const overBound = (scan: PlanNode, index: string, scanned: IndexFacts): Option.Option<string> => {
	const read = scanReads(scan, scanned)
	return read.touched > read.bound
		? Option.some(
				`${read.touched} buffers of ${index} for ${read.entries} of its ${scanned.entries} entries over ${scanned.pages} pages and ${read.fetched} heap fetches, over ${read.bound}`
			)
		: Option.none()
}

/**
 * What the judgment holds a scan of a planned index to (see judgeServing): the engine's claim, over the conditions a
 * probe states on its keys (`stated`), or over a statement whose conditions the judgment states none of, a world
 * function's body (world-serving.ts, `unstated`); or, for an index PostgreSQL chose by its cost over the one the engine
 * planned, only what it read (`read`).
 */
type Claim =
	| { readonly kind: "stated"; readonly conditions: ReadonlyArray<KeyCondition> }
	| { readonly kind: "unstated" }
	| { readonly kind: "read" }

/** What bounds a scan's read: its own buffers (`scan`), or, when functions it calls read under it, the statement's. */
type BoundedBy = "scan" | "statement"

/**
 * The closed keys of a GiST index before its first key of many values that `conditions` leave unbound: its scan descends
 * into the entries of each of their values, which PostgreSQL counts as one search (physical/indexes/engine.ts, a GiST
 * index's placement); none of any other index, whose descents PostgreSQL counts.
 */
const unboundBeforeLead = (
	scanned: IndexFacts,
	conditions: ReadonlyArray<KeyCondition>
): ReadonlyArray<SearchedKey> =>
	scanned.method === "gist"
		? Arr.filter(
				Arr.takeWhile(scanned.keys, (k) => k.values.kind === "closed"),
				(k) => !Arr.some(conditions, (c) => searchedBy(k, c))
			)
		: []

/**
 * Why a scan of `index` does not hold `claim`, none when it does: a stated condition the index does not search, unless
 * the index is unique and searches a condition on each of its keys, so it finds the rows of one key, on which a filter
 * rechecks the rest; a closed key of a GiST index before its first key of many values that the stated conditions leave
 * unbound, so the scan descends once per value of it (unboundBeforeLead); and, under either claim, a row removed by a
 * filter but the one entry a unique index finds per descent, which a key probe's membership and a unique key's recheck
 * read.
 */
const claimProblem = (
	claim: Claim,
	scan: PlanNode,
	index: string,
	scanned: IndexFacts
): Option.Option<string> => {
	const removed = (): Option.Option<string> => {
		const read = scanReads(scan, scanned)
		return scan.rowsRemovedByFilter > 0 && !(scanned.unique && read.entries <= read.loops)
			? Option.some(
					`a scan of ${index} removing ${scan.rowsRemovedByFilter} rows by a filter, past the one entry of a unique key per descent`
				)
			: Option.none()
	}
	switch (claim.kind) {
		case "read":
			return Option.none()
		case "unstated":
			return removed()
		case "stated": {
			const unsearched = Arr.filter(
				claim.conditions,
				(c) => !Arr.some(scanned.keys, (k) => searchedBy(k, c))
			)
			const keyed =
				scanned.unique &&
				Arr.every(scanned.keys, (k) => Arr.some(claim.conditions, (c) => searchedBy(k, c)))
			const unbound = unboundBeforeLead(scanned, claim.conditions)
			return Arr.isReadonlyArrayNonEmpty(unsearched) && !keyed
				? Option.some(
						`a scan of ${index}, which does not search ${Arr.join(
							Arr.map(unsearched, (c) => `${c.field} by ${c.operator}`),
							", "
						)}, so a filter rechecks them`
					)
				: Arr.isReadonlyArrayNonEmpty(unbound)
					? Option.some(
							`a scan of ${index}, which descends once per value of ${Arr.join(
								Arr.map(unbound, (k) => k.field),
								", "
							)}, unbound before its first key of many values`
						)
					: removed()
		}
	}
}

/**
 * The verdict on one scan of a stored relation (see judgeServing), `planned` the indexes the installation planned, by
 * name, `facts` every planned index's facts, `fixes` whether its statement fixes a column, so the scan needs an index
 * condition, `claimOf` what the scan of the index PostgreSQL chose is held to (Claim), `descentsOf` the descents a loop
 * of a scan of an index of given facts may make (skipDescents), and `bounded` what bounds its read: a scan of a planned
 * index, held to its claim, within its descents per loop and, bounded by its own buffers, within the bound of its
 * result; swept when it reads past them; or not served, and why. Both judges read every scan through
 * it: this file's probe of a request (verdictOf), and world-serving.ts's every scan of a world function's statement.
 */
export const judgeScan = (
	scan: PlanNode,
	planned: ReadonlyMap<string, PlannedIndex>,
	facts: ReadonlyMap<string, IndexFacts>,
	fixes: boolean,
	claimOf: (index: PlannedIndex) => Claim,
	descentsOf: (scanned: IndexFacts) => number,
	bounded: BoundedBy
): Verdict => {
	const read = plannedScan(scan, planned, fixes)
	if (Result.isFailure(read)) {
		return { kind: "unserved", why: read.failure }
	}
	const through = read.success
	const index = through.index.name
	const scanned = defined(facts.get(index), `the facts of ${index}`)
	const problem = claimProblem(claimOf(through), scan, index, scanned)
	if (Option.isSome(problem)) {
		return { kind: "unserved", why: problem.value }
	}
	const sweep =
		(past: Past) =>
		(why: string): { readonly past: Past; readonly why: string } => ({ past, why })
	const descents = extraDescents(scan, index, descentsOf(scanned))
	const swept = Option.orElse(Option.map(descents, sweep("descents")), () =>
		bounded === "scan"
			? Option.map(overBound(scan, index, scanned), sweep("buffers"))
			: Option.none()
	)
	const touched = scanReads(scan, scanned).touched
	return Option.isSome(swept)
		? { kind: "swept", through, touched, ...swept.value }
		: {
				kind: "served",
				through,
				touched,
				descended: Option.exists(
					scan.indexSearches,
					(searches) => searches > Math.max(1, scan.actualLoops)
				)
					? "by a skip scan"
					: "once a loop"
			}
}

/**
 * The verdict on a probe's plan (see the header): its one scan of its relation judged (judgeScan), `claimed` whether
 * the index PostgreSQL chose is held to the engine's claim over the probe's conditions, or, one PostgreSQL chose by its
 * cost over the request's own, only to what it read; and no sort above it when the probe asks for an order.
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
	const verdict = judgeScan(
		scan,
		planned,
		facts,
		Arr.isReadonlyArrayNonEmpty(probe.conditions),
		(index): Claim =>
			claimed(index.index.name)
				? { kind: "stated", conditions: probe.conditions }
				: { kind: "read" },
		(scanned) => skipDescents(scanned, probe.conditions),
		"scan"
	)
	return verdict.kind !== "unserved" &&
		orderedShape[probe.shape] &&
		Arr.some(nodes, (n) => sorts.has(n.nodeType))
		? { kind: "unserved", why: `a sort above the scan of ${verdict.through.index.name}` }
		: verdict
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
 * The statements that drop every planned index of `host`'s relation but `host`, each with the key or exclusion
 * constraint that owns it, so a statement run after them in a transaction rolled back reads the relation through `host`
 * alone.
 */
export const withoutOthers = (
	installed: Judged,
	host: PlannedIndex
): Effect.Effect<ReadonlyArray<string>, SqlError, Substrate> =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const q = installed.installation.names.relation(host.relation)
		const table = `${quoteIdent(q.schema)}.${quoteIdent(q.name)}`
		const statements: Array<string> = []
		for (const i of Arr.filter(
			installed.installation.indexes,
			(i) => i.relation === host.relation && i.index.name !== host.index.name
		)) {
			const index = `${quoteIdent(q.schema)}.${quoteIdent(i.index.name)}`
			const [owner] = yield* Effect.map(
				admin.queryValues(
					"SELECT c.conname::text FROM pg_catalog.pg_constraint AS c WHERE c.conindid = $1::text::regclass " +
						"AND c.conrelid = $2::text::regclass AND c.contype IN ('p'::\"char\", 'u'::\"char\", 'x'::\"char\")",
					[index, table]
				),
				textsOf
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

/** The upstream notes (upstream/<name>) a residue awaits: each a PostgreSQL behaviour a patch there changes. */
const upstreamNotes = ["gist-costestimate-column-position"] as const
type UpstreamNote = (typeof upstreamNotes)[number]

/**
 * Why PostgreSQL swept a planned index where no plan the engine makes avoids the sweep (see judgeServing): another
 * index than the request's own, where no order of its keys serves the probe beside the requests it serves
 * (keyOrdersConflict), through PostgreSQL's cost model, awaiting the upstream note that changes it, or PostgreSQL right,
 * reading the probe in no more buffers than the request's own index alone does; or any GiST index whose leading text
 * btree_gist prices by shared leading bytes (LeadPricing), past its buffers on a probe that fixes that text.
 */
type Residue =
	| { readonly kind: "cost model"; readonly awaiting: UpstreamNote }
	| { readonly kind: "right" }
	| { readonly kind: "shared leading bytes" }

/** What the judgment noted of one request or one created index. */
export type ServingFeature =
	| `${Shape} probe served`
	| "served by a key or enforcement index"
	| "served by a created index"
	| "read through another planned index than the engine's"
	| "read through another planned index that does not search every condition of its probe"
	| `swept through another index, awaiting upstream/${UpstreamNote}`
	| "swept through another B-tree in no more buffers than its own index alone"
	| "swept through a GiST index led by multibyte text, which btree_gist prices by its leading bytes"
	| "read by a skip scan over closed keys after a fixed lead"
	| "a GiST index serving a B-tree request"
	| "a created index needed"
	| "a relation its key bounds below the load, not judged"

/** What the judgment notes of a residue. */
const residueFeature = (residue: Residue): ServingFeature => {
	switch (residue.kind) {
		case "cost model":
			return `swept through another index, awaiting upstream/${residue.awaiting}`
		case "right":
			return "swept through another B-tree in no more buffers than its own index alone"
		case "shared leading bytes":
			return "swept through a GiST index led by multibyte text, which btree_gist prices by its leading bytes"
	}
}

/**
 * The residue of a probe's sweep of an index of `scanned`'s facts past its buffers where btree_gist prices the index's
 * leading text by shared leading bytes (LeadPricing) and the probe fixes that text by equality, so its one descent
 * follows every subtree whose bounds the imprecise placement left holding the value (see judgeServing); none for any
 * other sweep.
 */
const pricingResidue = (scanned: IndexFacts, probe: Probe, past: Past): Option.Option<Residue> =>
	past === "buffers" &&
	scanned.lead === "shared leading bytes" &&
	Arr.some(scanned.keys.slice(0, 1), (k) =>
		Arr.some(probe.conditions, (c) => c.operator === "=" && searchedBy(k, c))
	)
		? Option.some({ kind: "shared leading bytes" })
		: Option.none()

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
 * - with an index condition, when the probe fixes a column (every shape but an order and the nearest vectors);
 * - in one descent of the index (Index Searches at most 1), so a B-tree skip scan over a leading column the request
 *   does not fix does not serve it, as the engine states; but for the skip scan of an index the engine places a request
 *   in led by a column it fixes (physical/indexes/engine.ts, an equality lookup's index led by a requested column of
 *   many values that holds every requested column), whose keys before the last the probe conditions may hold others
 *   the probe leaves unbound: where each of those is closed, a boolean or a closed id, PostgreSQL 19 reads the probe by
 *   a skip scan in at most one descent per combination of the values it steps them through, their types' and never
 *   their rows' (Table.closed, skipDescents), each within the rows of the fixed lead; a skipped column of any other type
 *   is no such bound. Measured on PostgreSQL 19, a skip over a boolean takes 2 descents, over a smallint holding 3
 *   values 4, the last finding none past them, and 5 where it holds nulls too;
 * - through the request's own index, and through any index the needed check below reads, with every condition the
 *   probe states on its keys the index's: the index searches each, holding its field under an operator family that
 *   searches by the condition's operator (pg_amop's search operators, PostgreSQL's own catalog), so no filter rechecks
 *   one, however few rows the data lets that filter remove; but for a unique index that searches a condition on each of
 *   its keys, which finds the rows of one key, on which PostgreSQL rechecks the rest (physical/indexes/engine.ts: a
 *   unique index's keyed placements). Holding a field is not searching it: a B-tree holds a span and never searches it
 *   by overlap. The load makes each field of a key of two fields unique on its own, so a B-tree on (key, other, span)
 *   that a take seek creates finds the one row of a span predicate on (key, span), and its filter on the span removes
 *   none; it still does not serve the predicate, and the GiST index on (key, span) the predicate creates is needed;
 * - through those indexes, a GiST index with every closed key before its first key of many values conditioned by the
 *   probe: its scan descends into the entries of each value of one the probe leaves unbound, and PostgreSQL counts that
 *   as one search, so such a scan is the skip scan over a leading key a B-tree's one descent excludes, whatever the
 *   buffers its few values let it touch (physical/indexes/engine.ts; measured on PostgreSQL 19 at this volume, a lookup
 *   on a uuid of 141 values touches 7 buffers of a GiST index on `(c, uuid, span)` with c of two or three values held
 *   evenly unbound, 11 to 18 against a bound of 10 with four to eight, and 7 to 9 against 11 with two to eight when
 *   nine rows in ten hold one of them, so its read alone cannot tell); so the needed check below, which holds every index
 *   to the claim, finds no such index a stand-in for a created one;
 * - through those indexes, removing no row by a filter;
 * - with no sort above it, when the probe asks for an order;
 * - touching at most the buffers its result requires (shared hit and read, PostgreSQL's own count): the result's share of
 *   the index's pages, its entries (the rows it returned and those its filter rechecked) over the index's entries times
 *   its pages, rounded up; a heap page per entry an Index Scan fetched, or per Heap Fetch of an Index Only Scan; and each
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
 * Another planned index PostgreSQL reads a probe through, by its cost over the request's own, is not held to the claim
 * but to what it read: one descent, or a skip scan's as above, no sort, and the buffers its result requires, the rows
 * its filter rechecks among its entries. What its filter removes is the cost model's choice and the data's draw, not the plan: law probes on Event's
 * (tenant, account) and (tenant, account, id) cost 8.31 through the primary key on id and through the index on (tenant,
 * account) alike, both estimating one row, and PostgreSQL reads the second through the index on (tenant, account),
 * which finds the 5 rows of its sampled pair and rechecks id on them. No plan the engine makes avoids it: the index on
 * (tenant, account) is needed, and holding id too would serve only a request the primary key serves.
 *
 * A sweep of another planned index than the request's own is excused (residueOf) only where no plan the engine makes
 * avoids it, and only by the PostgreSQL behaviour behind it (Residue); the request's own index alone must still serve
 * the probe. No plan avoids it where that index holds every field the probe fixes and no order of its keys serves the
 * probe beside the requests it serves (keyOrdersConflict): an order serving a request leads, among its keys of many
 * values, with a field the request's shape lets lead (leadsOf), and no field may lead for the probe and for all of
 * them. A second index for the exposed request avoids none: PostgreSQL chooses between two GiST indexes holding a probe's fields, when
 * their estimates tie, by which was created last (upstream/gist-costestimate-column-position EVIDENCE.txt 2d), and the
 * request a key's index serves needs no index of its own.
 *
 * - Through a GiST index, PostgreSQL's cost model, awaiting upstream/gist-costestimate-column-position.
 *   gistcostestimate costs a GiST scan by the selectivity of all its conditions wherever their columns stand
 *   (genericcostestimate), and charges its descent ceil(ln N) comparisons where btcostestimate charges ceil(log2 N), so
 *   at the one leaf a selective result needs, PostgreSQL prefers that index to a B-tree the probe's fields lead, or to
 *   a GiST index of as many pages, and sweeps it. When a relation's requests need conflicting key orders, as a span
 *   predicate on (fixed, span), another on (span) and an equality lookup on (fixed) do, one of them is exposed whatever
 *   the plan. Measured on PostgreSQL 19 at this volume, an equality on a numeric of 141 values costs 6.50 through a GiST
 *   index on (span, numeric) of 144 pages, which it sweeps in 145 buffers, and 6.51 through a B-tree on (numeric,
 *   float8) of 97 pages, which reads 3. The residue goes, by hard cutover, once a PostgreSQL grizzle pins costs column
 *   position.
 * - Through a B-tree, PostgreSQL right: it read the probe in no more buffers than the request's own index alone. When
 *   the distinct values of the columns before the probe's outnumber the index's pages, btcostestimate's skip-scan
 *   costing gives up skipping and costs a sweep of the whole index. A B-tree swept in more buffers than the request's
 *   own index alone reads is a misjudgment no upstream note covers, and a problem.
 *
 * One residue excuses a sweep of the request's own index too, and of any other: a GiST index led by text that holds a
 * multibyte character, past its buffers on a probe that fixes that text by equality (pricingResidue). As README's
 * PostgreSQL known issues states, through PostgreSQL 19 btree_gist prices a text key by the byte after the common
 * prefix of its subtree's bounds, cut at a character boundary, so characters that share leading bytes, as the
 * two-ideograph keys of the generated workloads' text fields do (serving.test.ts), price alike, the index places them
 * imprecisely, and the probe's one descent follows every subtree whose bounds hold its value. The engine builds such an
 * index for a span predicate whose text field comes first, as README states, and PostgreSQL may read an equality lookup
 * on that text through it by its cost. Measured on PostgreSQL 19 at this volume, a GiST index on (two-ideograph text,
 * span) of 247 pages touches 51 buffers for the one row of either probe, against a bound of 9. PostgreSQL's master
 * branch fixes the pricing in commit b82d69abf6, for PostgreSQL 20; the residue goes, by hard cutover, once a PostgreSQL
 * grizzle pins prices text there.
 *
 * Each index the engine created must be needed: with it dropped, in a transaction rolled back, some request it serves
 * is no longer served. An index PostgreSQL can do without is one the engine built beside another that already serves
 * every request it holds.
 *
 * The populations load their relations at volume before judging (serving.test.ts), so a lookup and a sweep differ by
 * far more than the descent.
 *
 * Judges the installation (see the header): every problem, none when PostgreSQL agrees with every claim. `note` records
 * what was judged.
 */
export const judgeServing = (
	installed: Judged,
	note: (feature: ServingFeature) => void
): Effect.Effect<ReadonlyArray<string>, SqlError, Substrate> =>
	Effect.gen(function* () {
		const indexes = installed.installation.indexes
		const relations = [...new Set(Arr.map(indexes, (i) => i.relation))]
		const tables = new Map<string, Table>()
		for (const r of relations) {
			const table = yield* tableOf(installed, r)
			tables.set(r, table)
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
				const probe = yield* probeOf(installed, tableFor(r.relation), r)
				probes.set(r, probe)
			}
		}
		const probeFor = (r: IndexRequest): Probe => {
			const p = probes.get(r)
			return p ?? assert.fail("a request with no probe")
		}
		/** The fields of `relation` among `fields` that hold many values, so that fixing one bounds a scan. */
		const manyOf = (relation: string, fields: ReadonlyArray<string>): ReadonlyArray<string> => {
			const closed = tableFor(relation).closed
			return Arr.filter(
				fields,
				(field) => !closed.has(installed.installation.names.column(relation, field))
			)
		}
		/**
		 * Whether no order of `through`'s keys serves the probe beside the requests it serves: the probe fixes a field of
		 * many values, `through` holds every field the probe fixes, and no field that may lead an order serving the probe
		 * (leadsOf) may lead one serving each request through serves that some field leads.
		 */
		const keyOrdersConflict = (through: PlannedIndex, probe: Probe): boolean => {
			const many = (fields: ReadonlyArray<string>) => manyOf(through.relation, fields)
			const bound = boundOf(probe)
			const leads = leadsOf[probe.shape](bound, many)
			const constraining = Arr.filter(
				Arr.map(through.requests, (r) =>
					leadsOf[shapeOf(r)](
						Arr.map(requestKeys(r), (k) => k.field),
						many
					)
				),
				Arr.isReadonlyArrayNonEmpty
			)
			return (
				Arr.isReadonlyArrayNonEmpty(leads) &&
				Arr.every(bound, (field) => Arr.some(through.keys, (k) => keyText(k) === field)) &&
				!Arr.some(leads, (field) => Arr.every(constraining, (led) => led.includes(field)))
			)
		}
		/**
		 * The residue behind PostgreSQL's sweep of `through`, another planned index than the request's own, `swept` the
		 * buffers that sweep touched and `alone` those the request's own index alone touched for the probe (see the
		 * header), when the key orders conflict: through a GiST index, gistcostestimate's blindness to column position,
		 * awaiting upstream/gist-costestimate-column-position; through a B-tree, PostgreSQL right when it read no more
		 * than the request's own index alone. A hash index holds one column and an HNSW probe fixes none, so neither has a
		 * key order to conflict.
		 */
		const residueOf = (
			through: PlannedIndex,
			probe: Probe,
			swept: number,
			alone: number
		): Option.Option<Residue> => {
			if (!keyOrdersConflict(through, probe)) {
				return Option.none()
			}
			switch (through.method) {
				case "gist":
					return Option.some({ kind: "cost model", awaiting: "gist-costestimate-column-position" })
				case "btree":
					return swept <= alone ? Option.some({ kind: "right" }) : Option.none()
				case "hash":
				case "hnsw":
					return Option.none()
			}
		}
		/**
		 * What PostgreSQL's read of a probe of `host`'s comes to (see the header): a problem; or none, served through the
		 * index it chose, held to the engine's claim when it is `host`, and through `host` alone too when it is another,
		 * every other index of the relation dropped; or, when that other is swept, the residue no plan the engine makes
		 * avoids.
		 */
		const readOf = (
			host: PlannedIndex,
			probe: Probe,
			verdict: Extract<Verdict, { readonly kind: "served" | "swept" }>
		) =>
			Effect.gen(function* () {
				const problem = (why: string) =>
					Result.fail(`${probe.label}, planned on ${host.index.name}: ${why}`)
				const pricing = (swept: Extract<Verdict, { readonly kind: "swept" }>) =>
					pricingResidue(
						defined(
							facts.get(swept.through.index.name),
							`the facts of ${swept.through.index.name}`
						),
						probe,
						swept.past
					)
				const descended = (v: Extract<Verdict, { readonly kind: "served" }>) => {
					if (v.descended === "by a skip scan") {
						note("read by a skip scan over closed keys after a fixed lead")
					}
				}
				if (verdict.through.index.name === host.index.name) {
					if (verdict.kind === "served") {
						descended(verdict)
						return Result.succeed(Option.none<Residue>())
					}
					const residue = pricing(verdict)
					return Option.isSome(residue) ? Result.succeed(residue) : problem(verdict.why)
				}
				const isolated = yield* withoutOthers(installed, host)
				const [alone] = yield* planned([probe], isolated)
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
					return Result.fail(`${probe.label}, planned on ${host.index.name}, alone: ${claim.why}`)
				}
				descended(claim)
				if (verdict.kind === "served") {
					return Result.succeed(Option.none<Residue>())
				}
				const residue = Option.orElse(pricing(verdict), () =>
					residueOf(verdict.through, probe, verdict.touched, claim.touched)
				)
				return Option.isSome(residue) ? Result.succeed(residue) : problem(verdict.why)
			})
		const problems: Array<string> = []
		/** Every request is served (readOf). */
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
					if (verdict.kind === "unserved") {
						problems.push(`${probe.label}, planned on ${host.index.name}: ${verdict.why}`)
						continue
					}
					const read = yield* readOf(host, probe, verdict)
					if (Result.isFailure(read)) {
						problems.push(read.failure)
						continue
					}
					note(`${probe.shape} probe served`)
					note(
						host.index.kind === "created"
							? "served by a created index"
							: "served by a key or enforcement index"
					)
					if (verdict.through.index.name !== host.index.name) {
						note("read through another planned index than the engine's")
						const other = defined(
							facts.get(verdict.through.index.name),
							`the facts of ${verdict.through.index.name}`
						)
						if (Arr.isReadonlyArrayNonEmpty(unsearchedOf(other, probe))) {
							note(
								"read through another planned index that does not search every condition of its probe"
							)
						}
					}
					if (Option.isSome(read.success)) {
						note(residueFeature(read.success.value))
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
