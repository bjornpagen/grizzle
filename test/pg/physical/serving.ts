import * as EngineResult from "@bjornpagen/grizzle-text/base/result"
/**
 * Index serving judged by the plan laws (test/support/advice.ts, README "Plan advice"): every request an installation
 * plans resolves to an index that serves it, and every index the engine creates is needed (physical/indexes/engine.ts
 * planIndexes, resolverOf).
 *
 * No plan here is PostgreSQL's choice: grizzle carries each read's proven plan to PostgreSQL as plan advice, so a
 * request is served where the statement that reads by it, held to the index it resolves to, binds and reads as that
 * index's plan gives. Each request becomes a probe, the statement its use asks of its relation (shapeOf, from what each
 * use means, ir/products.ts accessUses), its values those of the middle row of its table in physical order, each a
 * parameter, aliased by an advice scope of its own (sql/naming.ts AdviceScope) and read through the index the
 * installation resolves the request to (Installation `resolve`): its plan one level of one item, an index read of that
 * index binding every column the probe conditions and needing every column it reads, its advice that plan's
 * (sql/advice.ts printAdvice). It is served when, planned under that advice:
 *
 * - Law 1: PostgreSQL plans exactly the advised plan, every atom matched, no node disabled;
 * - Law 2: every column it conditions that the index stores is in the index condition of its scan, never in a filter, so
 *   no row it reads is rechecked by a condition the index could have searched: a B-tree that holds a span and never
 *   searches it by overlap, a GiST index whose placement leaves a probed column unsearched, a lookup by columns an index
 *   holds after one the probe leaves unbound;
 * - the budget: run on the filled tables (EXPLAIN ANALYZE of its generic plan, as every session grizzle opens plans), its
 *   scan descends once and reads within its descent's pages, the index's height, and two pages a row its index condition
 *   selects (an index-only scan one and its heap fetches), so a skip scan over a leading column the probe leaves unbound
 *   or a sweep of a GiST subtree under one is a red, however few rows it returns;
 * - and no Sort stands above its scan when it asks for an order (a take or page seek's, the nearest vectors'), but over
 *   a scan that binds a unique index's every key by equality, whose one row is in every order.
 *
 * Each index the engine created is needed: without it, some request it serves lands on no index (engine.ts servingOf
 * over the installation's set less it) or on one its probe is not served by. An index whose every request another serves as well is one the engine built
 * beside an index that already served them.
 *
 * The tables stand in every pg_class state a law reads (test/support/advice.ts PgClassState, standIn), each in a
 * transaction rolled back after it, so the probes are held in each: never vacuumed, counted empty (e1's tie), analyzed,
 * skewed and large. The populations load their relations at volume (volumeRows), so a probe and a sweep of its index
 * differ by far more than one descent.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Option } from "effect"
import { type MalformedPlan, planNodes } from "#bench/harness/explain.ts"
import type { BenchSession } from "#bench/harness/session.ts"
import type { Direction } from "#compiler/core/order.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { defaultOpclass, type LawField } from "#compiler/ir/law.ts"
import {
	type AccessIndexRequest,
	accessKeyText,
	type AccessUse,
	type IndexRequest
} from "#compiler/ir/products.ts"
import { noLive } from "#compiler/live/notify.ts"
import {
	type IndexKey,
	type IndexSet,
	type PlannedIndex,
	servingOf
} from "#compiler/physical/indexes/engine.ts"
import type { IndexRef } from "#compiler/physical/indexes/ref.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import {
	type InstallExtension,
	noCalls,
	noCarriers,
	noCertificates,
	noContribution,
	noFences,
	servesNoParams
} from "#compiler/physical/install/extension.ts"
import { printAdvice } from "#compiler/sql/advice.ts"
import { AdviceScope } from "#compiler/sql/naming.ts"
import type { ReadPlan } from "#compiler/sql/plan.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	advisedExplain,
	budgetOfPlan,
	callScope,
	lawsOver,
	type MalformedAdvice,
	type PgClassState,
	pgClassStates,
	plannedScope,
	type StateLoad,
	standIn
} from "#test/support/advice.ts"
import { standUpJudge } from "#test/support/judge.ts"
import { parsedName, wild } from "#test/support/kernel/naming.ts"
import type { SqlError } from "#test/support/pg.ts"
import { insertOf } from "#test/support/substrate/fill.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * What a probe asks of its relation: every key equal to a value; an equality prefix and its last key bounded on both
 * sides (by its sampled value alone, by the half of the column's extent holding it after a prefix); an equality prefix,
 * a seek's fixed keys (AccessIndexRequest `fixed`), and the order of the keys after it; equality on each scalar key and
 * overlap on each span key; the nearest vectors; the documents a query matches; the networks a value contains.
 */
const shapes = ["equality", "range", "ordered", "overlap", "nearest", "match", "contain"] as const
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
	"approximate vector retrieval": "nearest",
	"text search": "match",
	"network containment": "contain",
	"row equality": "equality"
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
	hnsw: "nearest",
	gin: "match"
}

const shapeOf = (r: IndexRequest): Shape =>
	r.role === "access" ? accessShape[r.use] : lawShape[r.method]

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
	"approximate vector retrieval": "hnsw",
	"text search": "gin",
	"network containment": "gist",
	"row equality": "btree"
}

/**
 * How many of a spec's keys, from the first, a path of its use binds by equality (AccessPath `fixed`): every key but
 * the last of a range, a prefix search's and a span predicate's, every key of a lookup, none of a seek, which names no
 * fixed prefix here, nor of an approximate retrieval.
 */
const fixedOfUse = (use: AccessUse, keys: number): number => {
	switch (use) {
		case "key lookup":
		case "equality lookup":
		case "join key":
		case "write target":
		case "row equality":
			return keys
		case "range":
		case "prefix search":
		case "span predicate":
			return keys - 1
		case "take seek":
		case "page seek":
		case "approximate vector retrieval":
		case "text search":
		case "network containment":
			return 0
	}
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
type LawKey = Extract<IndexRequest, { readonly role: "lawMaintenance" }>["blocks"][number][number]

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
				fixed: fixedOfUse(spec.use, spec.keys.length),
				role: "access",
				use: spec.use
			}
		case "law":
			return {
				relation: spec.relation,
				blocks: [
					Arr.map(spec.keys, (field): LawKey => ({
						column: { kind: "field", field: fieldOf(spec.relation, field) },
						dir: "asc",
						opclass: defaultOpclass
					}))
				],
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
	params: servesNoParams,
	certifies: noCertificates,
	carriers: noCarriers,
	calls: noCalls,
	live: noLive,
	fences: noFences
})

/** A roster's domain, qualified and quoted, as a cast to a closed id's code names it. */
export const rosterDomainSql = (installed: Judged, roster: string): string =>
	printObjectName(installed.installation.names.rosterDomain(parsedName(roster)))

/** A relation's table, quoted and qualified. */
const tableSql = (installed: Judged, relation: string): string =>
	printObjectName(installed.installation.names.relation(relation))

/**
 * The rows the series of a load makes for each relation: enough that an index of a 16-byte key spans some 70 leaf
 * pages and two levels, so a probe and a sweep of its index differ by far more than one descent.
 *
 * @limitKind measured
 * @owner the serving populations (serving.ts volumeState)
 * @unit rows
 * @scope each relation of one case's load, in one rolled-back transaction a pg_class state
 * @evidence a B-tree of 20,000 16-byte keys holds about 70 leaf pages under one root (PostgreSQL 19, nbtree's 8 kB
 *   pages), and a GiST index of a span key over them some 150: a sweep of either reads tens of pages past a probe's
 *   bound of its height and a row's two pages
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

/**
 * The loads of `loads` as one load the laws stand in a state (test/support/advice.ts StateLoad), a row of every relation
 * its unit: rows `from` to `to` of the series, 1 to volumeRows, each relation in order, so a row a later relation
 * references by its index is stored before it, and each row a key already holds skipped, as a relation whose key
 * admits fewer rows than the load (its key fields closed handles, say) holds as many as its key admits.
 */
export const volumeState = (
	session: BenchSession,
	installed: Judged,
	loads: Arr.NonEmptyReadonlyArray<VolumeLoad>
): StateLoad => ({
	tables: Arr.map(loads, (l) => tableSql(installed, l.relation)),
	units: volumeRows,
	load: (from, to) =>
		Effect.forEach(
			loads,
			(l) =>
				session.values(
					insertOf(
						{
							table: tableSql(installed, l.relation),
							columns: Arr.map(
								l.fields,
								([field, sql]) =>
									[quoteIdent(installed.installation.names.column(l.relation, field)), sql] as const
							)
						},
						"skipped",
						from - 1,
						to - 1
					),
					[]
				),
			{ discard: true }
		)
})

/**
 * A relation's table as the probes read it: quoted and qualified, its columns whose type is a range type, directly or
 * under domains, which a probe binds by overlap, and those of the vector extension's type, which only the extension's
 * qualified operators compare.
 */
interface Table {
	readonly quoted: string
	readonly spans: ReadonlySet<string>
	readonly vectors: ReadonlySet<string>
}

/** What a column of a table is, by its type under its domains: a span or anything else, and the vector type or not. */
type ColumnKinds = ReadonlyArray<readonly [string, "span" | "other", "true" | "false"]>

const columnKindsOf = (rows: unknown): ColumnKinds => trusted<ColumnKinds>(rows)

const tableOf = (session: BenchSession, installed: Judged, relation: string) =>
	Effect.gen(function* () {
		const quoted = tableSql(installed, relation)
		const rows = yield* session.values(
			"WITH RECURSIVE base(name, oid, typtype, typbasetype, typnamespace) AS (" +
				"SELECT a.attname, t.oid, t.typtype, t.typbasetype, t.typnamespace FROM pg_catalog.pg_attribute AS a " +
				"JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid " +
				"WHERE a.attrelid = $1::text::pg_catalog.regclass AND a.attnum > 0 AND NOT a.attisdropped " +
				"UNION ALL SELECT b.name, t.oid, t.typtype, t.typbasetype, t.typnamespace FROM base AS b " +
				"JOIN pg_catalog.pg_type AS t ON t.oid = b.typbasetype WHERE b.typtype = 'd'::\"char\") " +
				"SELECT name::text, CASE WHEN typtype = 'r'::\"char\" THEN 'span' ELSE 'other' END, " +
				"(typnamespace = $2::text::pg_catalog.regnamespace)::text FROM base WHERE typtype <> 'd'::\"char\"",
			[quoted, quoteIdent(installed.installation.names.vectorSchema)]
		)
		const columns = columnKindsOf(rows)
		return {
			quoted,
			spans: new Set(Arr.flatMap(columns, ([name, kind]) => (kind === "span" ? [name] : []))),
			vectors: new Set(
				Arr.flatMap(columns, ([name, , vector]) => (vector === "true" ? [name] : []))
			)
		} satisfies Table
	})

/**
 * A request's key: its text as a report names it (a field's name, a law column's identifier, a suffix key's
 * `suffix(<field>)`), the installed column it holds, its direction and its operator class.
 */
interface RequestedKey {
	readonly text: string
	readonly column: string
	readonly dir: Direction
	readonly opclass: LawKey["opclass"]
}

/** The installed column an index key of `relation` holds, or holds the suffix key of. */
const keyColumn = (installation: Installation, relation: string, key: IndexKey): string => {
	const column = key.column.kind === "suffix" ? key.column.of : key.column
	return column.kind === "field" ? installation.names.column(relation, column.field) : column.column
}

/** A request's keys, in index order (RequestedKey). */
const requestKeys = (
	installation: Installation,
	request: IndexRequest
): ReadonlyArray<RequestedKey> =>
	request.role === "lawMaintenance"
		? Arr.map(request.blocks.flat(), (k) => {
				const column = k.column.kind === "suffix" ? k.column.of : k.column
				const field = column.kind === "field" ? column.field.name : column.column
				return {
					text: k.column.kind === "suffix" ? `suffix(${field})` : field,
					column:
						column.kind === "field" ? installation.names.column(request.relation, field) : field,
					dir: k.dir,
					opclass: k.opclass
				}
			})
		: Arr.map(request.keys, (k) => ({
				text: accessKeyText(k.expr),
				column:
					typeof k.expr === "string"
						? installation.names.column(request.relation, k.expr)
						: assert.fail(
								`a probe of the suffix key of ${request.relation}.${k.expr.suffix}, which no population asks`
							),
				dir: k.dir,
				opclass: k.opclass
			}))

/** An operator a probe's condition on a key applies: equality, a range's bounds, or a span's overlap. */
type KeyOperator = "=" | ">=" | "<=" | "&&"

/** A condition a probe states on a key: the installed column, the operator it applies, and its value's text. */
interface KeyCondition {
	readonly column: string
	readonly operator: KeyOperator
	readonly value: string
}

/**
 * One request's probe: what a report calls it, its shape, its statement, each value a parameter, `$1` the first,
 * each parameter's text in order, the columns it conditions, and those it reads (its conditions' and its order's).
 */
interface Probe {
	readonly label: string
	readonly shape: Shape
	readonly sql: string
	readonly values: ReadonlyArray<string>
	readonly conditioned: ReadonlyArray<string>
	readonly reads: ReadonlyArray<string>
}

type Texts = ReadonlyArray<ReadonlyArray<string>>

const textsOf = (rows: unknown): Texts => trusted<Texts>(rows)

/** What a probe's statement states past its conditions: its order and limit, its values numbered after theirs. */
interface Tail {
	readonly text: (first: number) => string
	readonly values: ReadonlyArray<string>
	readonly ordered: ReadonlyArray<string>
}

/** A tail of no value and no order. */
const plainTail: Tail = { text: () => "", values: [], ordered: [] }

/**
 * The probe of `request` over `table` (see the header), read as `alias`, its values those of the middle row of its table
 * in physical order, read in the transaction `session` holds open.
 */
const probeOf = (
	session: BenchSession,
	installed: Judged,
	table: Table,
	request: IndexRequest,
	alias: string
) =>
	Effect.gen(function* () {
		const keys = requestKeys(installed.installation, request)
		const label = `${request.role} ${request.use} on ${request.relation}(${Arr.join(
			Arr.map(keys, (k) => `${k.text}${k.dir === "desc" ? " desc" : ""}`),
			", "
		)}) by ${request.method}`
		const shape = shapeOf(request)
		const at = (column: string): string => `${quoteIdent(alias)}.${quoteIdent(column)}`
		const sampled = yield* session.values(
			`SELECT ${Arr.join(
				Arr.map(keys, (k) => `${quoteIdent(k.column)}::text`),
				", "
			)} FROM ${table.quoted} ORDER BY ctid OFFSET (SELECT count(*) / 2 FROM ${table.quoted}) LIMIT 1`,
			[]
		)
		const [sample] = textsOf(sampled)
		if (sample === undefined) {
			return assert.fail(`${label}: ${request.relation} holds no row to probe`)
		}
		const value = (index: number): string =>
			defined(sample[index], `${label}: the sampled value of key ${index}`)
		/** `op` between two values of a column: the extension's qualified operator over a vector. */
		const operator = (column: string, op: string): string =>
			table.vectors.has(column)
				? `OPERATOR(${quoteIdent(installed.installation.names.vectorSchema)}.${op})`
				: op
		/** Each of the first `count` keys equal to its sampled value. */
		const equal = (count: number): ReadonlyArray<KeyCondition> =>
			Arr.map(keys.slice(0, count), (k, index): KeyCondition => ({
				column: k.column,
				operator: "=",
				value: value(index)
			}))
		/**
		 * A range probe's bounds on its last key: after an equality prefix, the half of the column's extent that holds
		 * the sampled value, from its least value to its median or from its median to its greatest, so the prefix's rows
		 * are what an index taking the column right after the prefix reads, and the sampled row is among the probe's;
		 * alone, the sampled value, so the probe reads a point of the column, not half of it.
		 */
		const rangeBounds = (index: number, column: string) =>
			index === 0
				? Effect.succeed({ lo: value(index), hi: value(index) })
				: Effect.map(
						session.values(
							`WITH m AS (SELECT (SELECT ${quoteIdent(column)} FROM ${table.quoted} ORDER BY 1 LIMIT 1) AS lo, ` +
								`(SELECT ${quoteIdent(column)} FROM ${table.quoted} ORDER BY 1 OFFSET (SELECT count(*) / 2 FROM ${table.quoted}) LIMIT 1) AS mid, ` +
								`(SELECT ${quoteIdent(column)} FROM ${table.quoted} ORDER BY 1 DESC LIMIT 1) AS hi) ` +
								`SELECT (CASE WHEN $1 ${operator(column, "<=")} mid THEN lo ELSE mid END)::text, ` +
								`(CASE WHEN $1 ${operator(column, "<=")} mid THEN mid ELSE hi END)::text FROM m`,
							[value(index)]
						),
						(rows) => {
							const [lo, hi] = textsOf(rows)[0] ?? []
							return lo === undefined || hi === undefined
								? assert.fail(`${label}: no extent of ${column}`)
								: { lo, hi }
						}
					)
		/** The probe's conditions on its keys and what follows them, by its shape. */
		const { conditions, tail } = yield* Effect.suspend(
			(): Effect.Effect<
				{ readonly conditions: ReadonlyArray<KeyCondition>; readonly tail: Tail },
				SqlError
			> => {
				switch (shape) {
					case "equality":
						return Effect.succeed({ conditions: equal(keys.length), tail: plainTail })
					case "range": {
						const last = keys.length - 1
						const bounded = defined(keys[last], `${label}: a range request's last key`)
						return Effect.map(rangeBounds(last, bounded.column), ({ lo, hi }) => ({
							conditions: [
								...equal(last),
								{ column: bounded.column, operator: ">=", value: lo },
								{ column: bounded.column, operator: "<=", value: hi }
							],
							tail: plainTail
						}))
					}
					case "overlap":
						return Effect.succeed({
							conditions: Arr.map(keys, (k, index): KeyCondition => ({
								column: k.column,
								operator: table.spans.has(k.column) ? "&&" : "=",
								value: value(index)
							})),
							tail: plainTail
						})
					case "ordered": {
						const fixed = request.role === "access" ? request.fixed : 0
						const ordered = keys.slice(fixed)
						return Effect.succeed({
							conditions: equal(fixed),
							tail: {
								text: () =>
									ordered.length === 0
										? " LIMIT 10"
										: ` ORDER BY ${Arr.join(
												Arr.map(
													ordered,
													(k) => `${at(k.column)} ${k.dir === "desc" ? "DESC" : "ASC"}`
												),
												", "
											)} LIMIT 10`,
								values: [],
								ordered: Arr.map(ordered, (k) => k.column)
							}
						})
					}
					case "nearest": {
						const first = defined(keys[0], `${label}: a nearest request's key`)
						const distance = first.opclass.kind === "default" ? "<->" : "<=>"
						return Effect.succeed({
							conditions: [],
							tail: {
								text: (n) =>
									` ORDER BY ${at(first.column)} OPERATOR(${quoteIdent(installed.installation.names.vectorSchema)}.${distance}) $${n} LIMIT 10`,
								values: [value(0)],
								ordered: [first.column]
							}
						})
					}
					case "match":
						return assert.fail(
							`${label}: a text search request, which no drawn field asks: no field kind is a search document`
						)
					case "contain":
						return assert.fail(
							`${label}: a network containment request, which no drawn field asks: no field kind is an inet or a cidr`
						)
				}
			}
		)
		const stated = Arr.map(
			conditions,
			(c, index) => `${at(c.column)} ${operator(c.column, c.operator)} $${index + 1}`
		)
		const conditioned = Arr.dedupe(Arr.map(conditions, (c) => c.column))
		return {
			label,
			shape,
			sql: `SELECT 1 FROM ${table.quoted} AS ${quoteIdent(alias)}${
				stated.length === 0 ? "" : ` WHERE ${Arr.join(stated, " AND ")}`
			}${tail.text(conditions.length + 1)}`,
			values: [...Arr.map(conditions, (c) => c.value), ...tail.values],
			conditioned,
			reads: Arr.dedupe([...conditioned, ...tail.ordered])
		} satisfies Probe
	})

/** What the judgment noted of one request or one created index. */
export type ServingFeature =
	| `${Shape} probe served`
	| "served by a key or enforcement index"
	| "served by a created index"
	| "a GiST index serving a B-tree request"
	| "a created index needed"

/** A read of the bootstrap superuser's (test/support/advice.ts heightsOf): its rows. */
type SuperuserRead = (sql: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<string | null>>>

/** What a probe is judged in: the transaction its session holds open, the superuser's reads, and the installation. */
interface Judging {
	readonly session: BenchSession
	readonly read: SuperuserRead
	readonly installed: Judged
	readonly tables: Map<string, Table>
}

/** A relation's table facts (Table), read once a judging. */
const tableIn = (judging: Judging, relation: string) =>
	Option.match(Option.fromNullishOr(judging.tables.get(relation)), {
		onSome: Effect.succeed,
		onNone: () =>
			Effect.tap(tableOf(judging.session, judging.installed, relation), (t) =>
				Effect.sync(() => judging.tables.set(relation, t))
			)
	})

/** The planned index an IndexRef names. */
const plannedOf = (installation: Installation, host: IndexRef): PlannedIndex =>
	Option.getOrElse(
		Arr.findFirst(installation.indexes, (i) => i.index.name === host.name.name),
		() => assert.fail(`the installation planned no index ${host.name.name}`)
	)

/** Whether `probe`'s equalities bind every key of `index`, a unique one, so it reads at most one row by its key. */
const keyedBy = (installation: Installation, index: PlannedIndex, probe: Probe): boolean =>
	index.unique &&
	Arr.every(index.keys, (k) =>
		probe.conditioned.includes(keyColumn(installation, index.relation, k))
	)

/**
 * Every problem of `request`'s probe read through `host` (see the header): its laws, its budget, and a Sort above an
 * ordered probe's scan but over a key's one row; none where `host` serves it. The probe runs once under its advice
 * before the run its budget reads: a backend's first scan of an index reads the catalog rows of its operator classes'
 * support functions, which PostgreSQL counts in the scan's buffers, pages of no plan (serving's run at f819a5df0: a GiST
 * probe of one row read 28 to 52 pages, past 6, in the first state alone, and within its bound in every later one).
 */
const probeProblems = (judging: Judging, request: IndexRequest, host: IndexRef) =>
	Effect.gen(function* () {
		const { session, installed } = judging
		const table = yield* tableIn(judging, request.relation)
		const alias = new AdviceScope().alias({ kind: "internal", purpose: "a request's probe" })
		const probe = yield* probeOf(session, installed, table, request, alias)
		const label = `${probe.label} through ${host.name.name}`
		const plan: ReadPlan<IndexRef> = {
			levels: [
				{
					name: { kind: "top" },
					first: {
						alias,
						scan: {
							kind: host.method === "gin" ? "bitmap" : "index",
							index: host,
							bound: probe.conditioned,
							needs: probe.reads
						}
					},
					joined: [],
					appended: []
				}
			]
		}
		const scope = callScope(
			label,
			"every",
			plan,
			[{ label: "its probe", sql: probe.sql }],
			printAdvice(plan)
		)
		const planned = yield* plannedScope(session, scope)
		const laws = lawsOver(scope, planned)
		yield* session.values(probe.sql, probe.values)
		const run = yield* advisedExplain(session, probe.sql, probe.values)
		const budget = yield* budgetOfPlan(session, judging.read, label, run)
		const sorted =
			(probe.shape === "ordered" || probe.shape === "nearest") &&
			Arr.some(
				[...planNodes(run)],
				(n) => n.nodeType === "Sort" || n.nodeType === "Incremental Sort"
			) &&
			!keyedBy(installed.installation, plannedOf(installed.installation, host), probe)
				? [`${label}: a Sort above its scan, which its order asks the index for`]
				: []
		return { probe, problems: [...laws, ...budget, ...sorted] }
	})

/** `set` without the index `index` names. */
const without = (set: IndexSet, index: PlannedIndex): IndexSet => ({
	...set,
	indexes: Arr.filter(set.indexes, (i) => i.ref.name.name !== index.index.name)
})

/**
 * The judgment of the installation's indexes in the transaction `session` holds open, its tables filled and stood in a
 * pg_class state (see the header): each request every planned index serves (PlannedIndex `requests`, the requests the
 * resolver lands on it) probed through the index it resolves to, and each created index held needed. Every problem,
 * none where every request is served and every created index needed. `note` records what was judged.
 */
export const judgeServing = (
	session: BenchSession,
	read: SuperuserRead,
	installed: Judged,
	note: (feature: ServingFeature) => void
): Effect.Effect<ReadonlyArray<string>, SqlError | MalformedAdvice | MalformedPlan> =>
	Effect.gen(function* () {
		const installation = installed.installation
		const judging: Judging = { session, read, installed, tables: new Map() }
		const problems: Array<string> = []
		for (const index of installation.indexes) {
			for (const request of index.requests) {
				const host = installation.resolve(request)
				const served = yield* probeProblems(judging, request, host)
				for (const problem of served.problems) {
					problems.push(problem)
				}
				if (served.problems.length > 0) {
					continue
				}
				note(`${served.probe.shape} probe served`)
				note(
					plannedOf(installation, host).index.kind === "created"
						? "served by a created index"
						: "served by a key or enforcement index"
				)
				if (host.method === "gist" && request.method === "btree") {
					note("a GiST index serving a B-tree request")
				}
			}
		}
		for (const index of Arr.filter(installation.indexes, (i) => i.index.kind === "created")) {
			const serving = servingOf(without(installation.indexSet, index), (relation) => relation)
			let needed = false
			for (const request of index.requests) {
				const other = serving(request)
				const elsewhere =
					other === undefined ? undefined : yield* probeProblems(judging, request, other)
				needed = elsewhere === undefined || elsewhere.problems.length > 0
				if (needed) {
					break
				}
			}
			if (needed) {
				note("a created index needed")
			} else {
				problems.push(
					`${index.index.name} is not needed: each request it serves is served without it (${Arr.join(
						Arr.map(index.requests, (r) => `${r.role} ${r.use} on ${r.relation}`),
						", "
					)})`
				)
			}
		}
		return problems
	})

/**
 * The statement that clears the statistics pg_class holds of each of `tables` and of each index on them
 * (pg_clear_relation_stats): no pages and no rows counted, as a table no VACUUM or ANALYZE has seen holds them, where a
 * rolled-back ANALYZE or count leaves its in-place update of pg_class standing.
 */
const clearedStats = (tables: ReadonlyArray<string>): string =>
	"SELECT pg_catalog.pg_clear_relation_stats(n.nspname::pg_catalog.text, c.relname::pg_catalog.text) " +
	"FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace " +
	`WHERE c.oid = ANY (ARRAY[${Arr.join(
		Arr.map(tables, (t) => `${quoteString(t)}::pg_catalog.regclass`),
		", "
	)}]) OR c.oid IN (SELECT x.indexrelid FROM pg_catalog.pg_index AS x WHERE x.indrelid = ANY (ARRAY[${Arr.join(
		Arr.map(tables, (t) => `${quoteString(t)}::pg_catalog.regclass`),
		", "
	)}]))`

/**
 * `judge` in every pg_class state (see the header), each in a transaction of the owner's pinned session rolled back after
 * it, on the load's tables as installed: VACUUMed and their statistics cleared before it (`clearedStats`), since a
 * rolled-back load leaves its rows' tuples and index entries dead in their pages until a VACUUM, which a later state's
 * probes would read beside their own rows, one leaf past their bound (serving's first run at f819a5df0: a law probe of
 * Rota's two rows at its primary key read 9 pages, past 8, in the third state on, never in the first two), and its
 * ANALYZE or count updates pg_class in place, which no rollback undoes; a table's rows are never TRUNCATEd, which
 * grizzle refuses of a closed relation. In the transaction: the rule judge stood up (test/support/judge.ts
 * standUpJudge), as a direct writer of a table it holds stands it up; then `load` (StateLoad) run and its tables stood
 * in the state (test/support/advice.ts standIn). Every problem `judge` finds, each beside the states it was found in.
 */
export const inEveryState = <E>(
	installation: Installation,
	load: (session: BenchSession) => StateLoad,
	judge: (session: BenchSession, read: SuperuserRead) => Effect.Effect<ReadonlyArray<string>, E>
): Effect.Effect<ReadonlyArray<string>, E | SqlError, Substrate> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const read: SuperuserRead = (sql) => substrate.superuserRead((rows) => rows(sql))
		const found = new Map<string, Array<PgClassState>>()
		for (const state of pgClassStates) {
			const problems = yield* Effect.scoped(
				Effect.gen(function* () {
					const pinned = yield* substrate.admin.pin
					const session: BenchSession = { values: pinned.queryValues }
					const loading = load(session)
					yield* Effect.forEach(loading.tables, (t) => pinned.query(`VACUUM ${t}`, []), {
						discard: true
					})
					yield* pinned.query(clearedStats(loading.tables), [])
					return yield* Effect.acquireUseRelease(
						pinned.query("BEGIN", []),
						() =>
							Effect.gen(function* () {
								yield* standUpJudge(pinned, installation)
								yield* standIn(session, loading, state)
								return yield* judge(session, read)
							}),
						() => Effect.orDie(pinned.query("ROLLBACK", []))
					)
				})
			)
			for (const problem of problems) {
				found.set(problem, [...(found.get(problem) ?? []), state])
			}
		}
		return Arr.map(
			[...found],
			([problem, states]) => `${problem} (with every table ${Arr.join(states, ", ")})`
		)
	})
