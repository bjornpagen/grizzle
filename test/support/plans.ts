import { Array as Arr, Effect, Option, Result } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { memberCalls, type ServedCalls } from "#adapter/db/handles.ts"
import type { LoadedMember } from "#adapter/served/load.ts"
import type { Session } from "#adapter/wire/session.ts"
import { type EstimatedNode, parsePlanTree, planNodes } from "#bench/harness/explain.ts"
import type { Param } from "#compiler/core/wire.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { ObjectName } from "#compiler/sql/ast.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import type { RoleDefault } from "#test/support/substrate/substrate.ts"

/**
 * The plan property of a workload read, as the plans suites judge every statement a read sends
 * (test/pg/e2e-platform/plans.test.ts, test/pg/e2e-work/plans.test.ts), and the doors they read the runtime and the
 * catalog through. The property is PostgreSQL's own judgment of the statement as the runtime sent it, served, over
 * relations it plans unanalyzed (unanalyzed): with sequential and index scans disabled (enable_indexscan disables
 * index-only scans too) and index-only scans never considered, every scan of a relation the statement restricts, by a
 * filter of its own or by the join condition of the nested loop it is the inner side of, reads by an index condition on
 * an index the installation planned. The one scan left enabled is a bitmap scan, and PostgreSQL builds one from an
 * index only at an index condition or a partial index's predicate: it builds an index path of neither only for an
 * index-only scan, which it never considers here, or for the index's order, which a bitmap scan does not keep
 * (indxpath.c build_index_paths, get_index_paths). Its count of disabled nodes outranks every cost, so a scan that
 * still applies its restriction without an index condition, a sequential scan that survives above all, is an access no
 * planned index serves, whatever rows the relations hold. That needs every restriction estimated below a selectivity of
 * 1, which an unanalyzed relation's defaults are: PostgreSQL builds no bitmap path from an index whose order a join or
 * a grouping can use at a selectivity of 1, which analyzed statistics of a relation holding one value estimate, so on a
 * platform of one row a relation its reads scanned relations sequentially beside the indexes that serve them. With
 * sequential scans alone disabled, an index walked whole was still an enabled scan, and PostgreSQL walks one for its
 * order: at a million usage events, spendByDay read a week of Day by walking Day's primary key, in the day order its
 * grouping wants, filtering the window that Day's GiST serves. The serving rule is never restated: PostgreSQL finds the
 * index, in its own plan (EXPLAIN FORMAT JSON through the tree's one decoder, bench/harness/explain.ts).
 *
 * A load's series `g` spread over `distinct` values by PostgreSQL's 64-bit hash seeded with `salt`: two spread columns of
 * different salts are independent, and one alone holds each of its values on about 1 / distinct of the rows. (A salt
 * added to one multiplicative hash only shifted every value by one offset, so two columns were one column renamed.)
 */
export const spread = (salt: number, distinct: number): string =>
	`((pg_catalog.hashint8extended(g::int8, ${salt}) % ${distinct} + ${distinct}) % ${distinct})`

/** The nodes that scan a stored relation. */
const relationScans: ReadonlySet<string> = new Set([
	"Seq Scan",
	"Index Scan",
	"Index Only Scan",
	"Bitmap Heap Scan",
	"Tid Scan",
	"Tid Range Scan",
	"Sample Scan"
])

/**
 * The nodes that pass their one child's rows up unchanged in kind: a nested loop's inner side read through one still
 * reads that child's relation.
 */
const passThrough: ReadonlySet<string> = new Set([
	"Materialize",
	"Memoize",
	"Sort",
	"Incremental Sort"
])

/** The relation a scan node reads, none for any other node. */
const scanned = (n: EstimatedNode): Option.Option<string> =>
	relationScans.has(n.nodeType) ? n.relation : Option.none()

/**
 * The indexes a scan reads by an index condition: an index scan's own, or every bitmap index scan under a bitmap heap
 * scan; none when it reads by none.
 */
const conditionedIndexes = (scan: EstimatedNode): ReadonlyArray<string> => {
	if (scan.nodeType === "Bitmap Heap Scan") {
		const bitmaps = Arr.filter([...planNodes(scan)], (n) => n.nodeType === "Bitmap Index Scan")
		return Arr.every(bitmaps, (b) => Option.isSome(b.indexCond))
			? Arr.flatMap(bitmaps, (b) => Option.toArray(b.index))
			: []
	}
	return Option.isSome(scan.indexCond) ? Option.toArray(scan.index) : []
}

/**
 * The scan a nested loop's inner side reads directly, through nodes that pass its rows up; none when it is a join or
 * anything else.
 */
const directScan = (n: EstimatedNode): Option.Option<EstimatedNode> => {
	if (Option.isSome(scanned(n))) {
		return Option.some(n)
	}
	const [only, ...more] = n.children
	return passThrough.has(n.nodeType) && only !== undefined && more.length === 0
		? directScan(only)
		: Option.none()
}

/**
 * What restricts a scan: a filter of its own, an index condition, or the join condition of the nested loop it is the
 * inner side of; none for a scan that reads every row.
 */
type Restriction = "a filter" | "an index condition" | "a nested loop's join condition"

const restrictionOf = (
	scan: EstimatedNode,
	joined: ReadonlySet<EstimatedNode>
): Option.Option<Restriction> =>
	Option.isSome(scan.indexCond) || Option.isSome(scan.recheckCond)
		? Option.some("an index condition")
		: Option.isSome(scan.filter)
			? Option.some("a filter")
			: joined.has(scan)
				? Option.some("a nested loop's join condition")
				: Option.none()

/**
 * The served property of one plan made with sequential and index scans disabled (see the header): each scan of a
 * restricted relation that reads by no index condition, or reads through an index the installation did not plan.
 * `planned` holds the names of the indexes the installation planned.
 */
const servedProblems = (
	plan: EstimatedNode,
	planned: ReadonlySet<string>
): ReadonlyArray<string> => {
	const nodes = [...planNodes(plan)]
	const joined = new Set(
		Arr.flatMap(nodes, (n) => {
			const inner = n.children[1]
			return n.nodeType === "Nested Loop" && n.joinFilter.kind === "filter" && inner !== undefined
				? Option.toArray(directScan(inner))
				: []
		})
	)
	const out: Array<string> = []
	for (const n of nodes) {
		const relation = scanned(n)
		if (Option.isNone(relation)) {
			continue
		}
		const restriction = restrictionOf(n, joined)
		if (Option.isNone(restriction)) {
			continue
		}
		const indexes = conditionedIndexes(n)
		if (indexes.length === 0) {
			out.push(
				`a ${n.nodeType} of ${relation.value}, restricted by ${restriction.value}, reads no index condition`
			)
		}
		for (const index of indexes) {
			if (!planned.has(index)) {
				out.push(
					`a ${n.nodeType} of ${relation.value} reads through ${index}, which the installation did not plan`
				)
			}
		}
	}
	return out
}

/** One statement as the runtime sent it, each parameter a text or a binary value (core/wire.ts Param). */
interface Sent {
	readonly sql: string
	readonly params: ReadonlyArray<Param>
}

const explained = (admin: PgConnection, name: string, st: Sent) =>
	Effect.map(admin.queryValues(`EXPLAIN (FORMAT JSON) ${st.sql}`, st.params), (rows) => {
		const plan = parsePlanTree(rows[0]?.[0])
		return Result.isSuccess(plan) ? plan.success : assert.fail(`${name}: no plan`)
	})

/**
 * The settings every judged statement is planned under (see the header): sequential and index scans disabled, and
 * index-only scans never considered, so PostgreSQL builds no index path of no condition that a bitmap scan could read.
 * Each is a parameter and its value, which a transaction sets LOCAL (sentProblems) and a role's sessions take as their
 * defaults (ALTER ROLE ... SET), so a served member's own explain plans under them.
 */
export const judgedSettings: ReadonlyArray<RoleDefault> = [
	{ parameter: "enable_seqscan", value: "off" },
	{ parameter: "enable_indexscan", value: "off" },
	{ parameter: "enable_indexonlyscan", value: "off" }
]

/**
 * The served property of the statements a read named `name` sent, each problem named by the read, judged against
 * `planned`, the names of the indexes the installation planned (plannedIndexes): each statement EXPLAINed with its
 * parameters on `admin` in one transaction rolled back, under the judged settings, over relations the caller left
 * unanalyzed (unanalyzed).
 */
export const sentProblems = (
	admin: PgConnection,
	name: string,
	sent: ReadonlyArray<Sent>,
	planned: ReadonlySet<string>
): Effect.Effect<ReadonlyArray<string>, SqlError> =>
	Effect.acquireUseRelease(
		admin.query("BEGIN", []),
		() =>
			Effect.andThen(
				Effect.forEach(
					judgedSettings,
					(setting) => admin.query(`SET LOCAL ${setting.parameter} = ${setting.value}`, []),
					{ discard: true }
				),
				Effect.map(
					Effect.forEach(sent, (st) =>
						Effect.map(explained(admin, name, st), (plan) =>
							Arr.map(servedProblems(plan, planned), (problem) => `${name}: ${problem}`)
						)
					),
					Arr.flatten
				)
			),
		() => Effect.ignore(admin.query("ROLLBACK", []))
	)

/**
 * The statements that clear a relation's statistics, its own, its columns' and its extended statistics', the
 * relation's schema and name their parameters (unanalyzed).
 */
const clearedStatistics: ReadonlyArray<string> = [
	"SELECT pg_catalog.pg_clear_relation_stats($1::text, $2::text)",
	"SELECT pg_catalog.pg_clear_attribute_stats($1::text, $2::text, a.attname::text, false) " +
		"FROM pg_catalog.pg_attribute AS a JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid " +
		"JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace " +
		"WHERE n.nspname = $1::text AND c.relname = $2::text AND a.attnum > 0 AND NOT a.attisdropped",
	"SELECT pg_catalog.pg_clear_extended_stats($1::text, $2::text, s.nspname::text, e.stxname::text, false) " +
		"FROM pg_catalog.pg_statistic_ext AS e JOIN pg_catalog.pg_namespace AS s ON s.oid = e.stxnamespace " +
		"JOIN pg_catalog.pg_class AS c ON c.oid = e.stxrelid JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace " +
		"WHERE n.nspname = $1::text AND c.relname = $2::text"
]

/**
 * `relations`, each a table or a materialized view, as PostgreSQL plans a relation never vacuumed or analyzed, whatever
 * rows it holds: autovacuum off for each, so nothing analyzes it after, and its statistics cleared. PostgreSQL then
 * takes a relation of fewer than ten pages for ten (tableam.c table_block_relation_estimate_size), its tuples by their
 * width, and estimates every restriction by a default selectivity below 1. Analyzed statistics of a small relation
 * decide a plan by its rows: a restriction of a relation holding one value is estimated to keep every row, and a whole
 * index of one page, read by a merge join, costs less than a descent a row.
 */
export const unanalyzed = (
	admin: PgConnection,
	relations: ReadonlyArray<ObjectName>
): Effect.Effect<void, SqlError> =>
	Effect.forEach(
		relations,
		(r) =>
			Effect.andThen(
				admin.query(`ALTER TABLE ${printObjectName(r)} SET (autovacuum_enabled = false)`, []),
				Effect.forEach(clearedStatistics, (sql) => admin.query(sql, [r.schema, r.name]), {
					discard: true
				})
			),
		{ discard: true }
	)

/** The names of every index the installation planned: each key and enforcement index, and each it created. */
export const plannedIndexes = (installation: Installation): ReadonlySet<string> =>
	new Set(Arr.map(installation.indexes, (i) => i.index.name))

/**
 * What a Db's reads sent, as a recording context counts it (recordingContext): the flights its sessions wrote, one
 * round trip each, and every statement of a program among them, its text and its parameters, a text or a binary value
 * each (core/wire.ts Param), in order; a transaction's controls and the Db's prologue are no statement of a program.
 */
export interface Counts {
	flights: number
	statements: number
	readonly sent: Array<{ readonly sql: string; readonly params: ReadonlyArray<Param> }>
}

/** `session`, every flight it writes counted into `counts` (Counts) before it is written. */
const recordingSession = (
	session: Session,
	counts: Counts,
	prologue: ReadonlySet<string>
): Session => ({
	...session,
	send: (pipeline, onAnswer, onEnd, onCut) => {
		counts.flights++
		for (const query of pipeline) {
			if (
				query._tag === "control" ||
				(query._tag === "prepared" && prologue.has(query.text.name))
			) {
				continue
			}
			counts.statements++
			counts.sent.push({
				sql: query._tag === "prepared" ? query.text.sql : query.sql,
				params: query.params
			})
		}
		session.send(pipeline, onAnswer, onEnd, onCut)
	}
})

/** The Db context `ctx` with every session its pool leases recording what it sends into `counts` (Counts). */
export const recordingContext = (
	ctx: ServedDbContext
): { readonly ctx: ServedDbContext; readonly counts: Counts } => {
	const counts: Counts = { flights: 0, statements: 0, sent: [] }
	const prologue: ReadonlySet<string> = new Set([
		ctx.prologue.fence.text.name,
		ctx.prologue.enter.text.name
	])
	return {
		ctx: {
			...ctx,
			pool: {
				...ctx.pool,
				lease: Effect.map(ctx.pool.lease, (session) => recordingSession(session, counts, prologue))
			}
		},
		counts
	}
}

/**
 * The calls of any loaded member of the served Db of `ctx` (test/support/served-db.ts ServedDb.load, adapter/db/handles.ts
 * memberCalls), every statement they send recorded (recordingContext), and the counts every member's calls share.
 */
export const recordingMembers = (
	ctx: ServedDbContext
): {
	readonly calls: (member: LoadedMember) => ServedCalls
	readonly counts: Counts
} => {
	const recording = recordingContext(ctx)
	return { calls: (member) => memberCalls(recording.ctx, member), counts: recording.counts }
}
