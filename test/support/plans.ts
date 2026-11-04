import { Array as Arr, Effect, Option, Result, Schema } from "effect"
import { dbContext } from "#adapter/db/context.ts"
import { makeReader, poolExecutor } from "#adapter/reader/reader.ts"
import { type EstimatedNode, parsePlanTree, planNodes } from "#bench/harness/explain.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { countingExecutor, untyped } from "#test/pg/page/support.ts"
import { assert } from "#test/support/assert.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The plan properties of a workload read at volume, as the plans suites judge every statement a read sends
 * (test/pg/e2e-platform/plans.exclusive.test.ts, test/pg/e2e-work/plans.exclusive.test.ts), and the doors they read the
 * runtime and the catalog through. Two properties, each PostgreSQL's own judgment of the statement as the runtime sent
 * it:
 *
 * - served: with sequential and index scans disabled (enable_indexscan disables index-only scans too), every scan of a
 *   relation the statement restricts, by a filter of its own or by the join condition of the nested loop it is the
 *   inner side of, reads by an index condition on an index the installation planned. The one scan left enabled is a
 *   bitmap scan, which reads a relation only by an index condition, so a scan that still applies its restriction
 *   without one, a sequential scan that survives above all, is an access no planned index serves. With sequential
 *   scans alone disabled, an index walked whole was still an enabled scan, and PostgreSQL walks one for its order: at
 *   a million usage events, spendByDay read a week of Day by walking Day's primary key, in the day order its grouping
 *   wants, filtering the window that Day's GiST serves, and that was its free plan too. The serving rule is never
 *   restated: PostgreSQL finds the index;
 * - chosen at volume: the free plan scans no relation of more than largeRows rows, neither once by a sequential scan
 *   nor as a nested loop's inner side without an index condition. Over a relation of at most largeRows rows, the scan
 *   is the planner's choice, never judged: the platform's rate cards are a few pages at any volume, which PostgreSQL
 *   rightly reads whole rather than through the GiST index that serves them.
 *
 * Both read PostgreSQL's own plan (EXPLAIN FORMAT JSON through the tree's one decoder, bench/harness/explain.ts) and
 * its own row counts (pg_class.reltuples after VACUUM ANALYZE).
 *
 * A load's series `g` spread over `distinct` values by PostgreSQL's 64-bit hash seeded with `salt`: two spread columns of
 * different salts are independent, and one alone holds each of its values on about 1 / distinct of the rows. (A salt
 * added to one multiplicative hash only shifted every value by one offset, so two columns were one column renamed.)
 */
export const spread = (salt: number, distinct: number): string =>
	`((pg_catalog.hashint8extended(g::int8, ${salt}) % ${distinct} + ${distinct}) % ${distinct})`

/** The size above which a relation is never scanned: once sequentially, or per row of a nested loop's outer side. */
const largeRows = 20_000

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

/**
 * The chosen-at-volume property of one free plan (see the header): each sequential scan of a relation of more than
 * largeRows rows, and each scan of one on a nested loop's inner side that reads no index condition. `rows` holds each
 * relation's rows by its name.
 */
const chosenProblems = (
	plan: EstimatedNode,
	rows: ReadonlyMap<string, number>
): ReadonlyArray<string> => {
	const out: Array<string> = []
	const visit = (n: EstimatedNode, inner: boolean): void => {
		const relation = scanned(n)
		const size = Option.isSome(relation) ? rows.get(relation.value) : undefined
		if (Option.isSome(relation) && size !== undefined && size > largeRows) {
			if (n.nodeType === "Seq Scan") {
				out.push(`a sequential scan of ${relation.value} (${size} rows)`)
			} else if (inner && conditionedIndexes(n).length === 0) {
				out.push(
					`a nested loop whose inner side ${n.nodeType} ${relation.value} (${size} rows) reads no index condition`
				)
			}
		}
		for (const [at, child] of n.children.entries()) {
			visit(child, inner || (n.nodeType === "Nested Loop" && at === 1))
		}
	}
	visit(plan, false)
	return out
}

/**
 * What the plans suites judge a read's statements against: each relation's rows as the last VACUUM ANALYZE counted
 * them (relationRows), and the indexes the installation planned (plannedIndexes).
 */
export interface PlanJudge {
	readonly rows: ReadonlyMap<string, number>
	readonly planned: ReadonlySet<string>
}

/** One statement as the runtime sent it. */
interface Sent {
	readonly sql: string
	readonly params: ReadonlyArray<string>
}

const explained = (admin: PgConnection, name: string, st: Sent) =>
	Effect.map(admin.queryValues(`EXPLAIN (FORMAT JSON) ${st.sql}`, st.params), (rows) => {
		const plan = parsePlanTree(rows[0]?.[0])
		return Result.isSuccess(plan) ? plan.success : assert.fail(`${name}: no plan`)
	})

/**
 * The plan properties of the statements a read named `name` sent, each problem named by the read, and the indexes the
 * free plans read. Each statement is EXPLAINed with its parameters on `admin` twice: freely, then in one transaction
 * rolled back with sequential and index scans disabled.
 */
export const sentProblems = (
	admin: PgConnection,
	name: string,
	sent: ReadonlyArray<Sent>,
	judge: PlanJudge
): Effect.Effect<{ problems: Array<string>; read: Set<string> }, SqlError> =>
	Effect.gen(function* () {
		const problems: Array<string> = []
		const read = new Set<string>()
		for (const st of sent) {
			const plan = yield* explained(admin, name, st)
			for (const n of planNodes(plan)) {
				for (const index of Option.toArray(n.index)) {
					read.add(index)
				}
			}
			for (const problem of chosenProblems(plan, judge.rows)) {
				problems.push(`${name}: ${problem}`)
			}
		}
		yield* Effect.acquireUseRelease(
			admin.query("BEGIN", []),
			() =>
				Effect.andThen(
					Effect.andThen(
						admin.query("SET LOCAL enable_seqscan = off", []),
						admin.query("SET LOCAL enable_indexscan = off", [])
					),
					Effect.forEach(
						sent,
						(st) =>
							Effect.map(explained(admin, name, st), (plan) => {
								for (const problem of servedProblems(plan, judge.planned)) {
									problems.push(`${name}: ${problem}`)
								}
							}),
						{ discard: true }
					)
				),
			() => Effect.ignore(admin.query("ROLLBACK", []))
		)
		return { problems, read }
	})

const Sized = Schema.Array(Schema.Tuple([Schema.String, Schema.String]))

/** Each table's and materialized view's rows in `schema`, by name, as the last VACUUM ANALYZE counted them. */
export const relationRows = (schema: string) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const sized = yield* Effect.flatMap(
			admin.queryValues(
				"SELECT c.relname::text, c.reltuples::bigint::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n " +
					"ON n.oid = c.relnamespace WHERE n.nspname = $1::text AND c.relkind IN ('r', 'm')",
				[schema]
			),
			Schema.decodeUnknownEffect(Sized)
		)
		return new Map(Arr.map(sized, ([r, n]) => [r, Number(n)]))
	})

/** The names of every index the installation planned: each key and enforcement index, and each it created. */
export const plannedIndexes = (installation: Installation): ReadonlySet<string> =>
	new Set(Arr.map(installation.indexes, (i) => i.index.name))

/**
 * Every index of `schema` that backs no constraint and enforces no uniqueness: the access and law-probe indexes the
 * index engine creates, as PostgreSQL holds them.
 */
export const createdIndexes = (schema: string) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const names = yield* Effect.flatMap(
			admin.queryValues(
				"SELECT c.relname::text FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid " +
					"JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = $1::text " +
					"AND NOT i.indisunique AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS k WHERE k.conindid = i.indexrelid) " +
					"ORDER BY 1",
				[schema]
			),
			Schema.decodeUnknownEffect(Schema.Array(Schema.Tuple([Schema.String])))
		)
		return Arr.map(names, ([name]) => name)
	})

/** The runtime's own reader of `db` over the Db's pool, through an executor that records every statement it sends. */
export const recordingReader = (db: Parameters<typeof dbContext>[0]) => {
	const ctx = dbContext(db)
	if (ctx === undefined) {
		return Effect.die(new Error("the Db has no runtime context"))
	}
	const { executor, counts } = countingExecutor(poolExecutor(ctx))
	return Effect.succeed({ reader: untyped(makeReader(ctx, executor)), counts })
}
