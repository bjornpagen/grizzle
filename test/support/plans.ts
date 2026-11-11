import { Array as Arr, Effect, Option, Result } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { memberOpsOn } from "#adapter/db/handles.ts"
import type { MemberOps } from "#adapter/db/ops.ts"
import { poolExecutor } from "#adapter/reader/executor.ts"
import type { LoadedMember } from "#adapter/served/load.ts"
import { type EstimatedNode, parsePlanTree, planNodes } from "#bench/harness/explain.ts"
import type { Param } from "#compiler/core/wire.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { type Counts, countingExecutor } from "#test/pg/page/support.ts"
import { assert } from "#test/support/assert.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"

/**
 * The plan property of a workload read, as the plans suites judge every statement a read sends
 * (test/pg/e2e-platform/plans.test.ts, test/pg/e2e-work/plans.test.ts), and the doors they read the runtime and the
 * catalog through. The property is PostgreSQL's own judgment of the statement as the runtime sent it, served: with
 * sequential and index scans disabled (enable_indexscan disables index-only scans too), every scan of a relation the
 * statement restricts, by a filter of its own or by the join condition of the nested loop it is the inner side of,
 * reads by an index condition on an index the installation planned. The one scan left enabled is a bitmap scan, which
 * reads a relation only by an index condition, so a scan that still applies its restriction without one, a sequential
 * scan that survives above all, is an access no planned index serves; no data size moves that verdict. With sequential
 * scans alone disabled, an index walked whole was still an enabled scan, and PostgreSQL walks one for its order: at a
 * million usage events, spendByDay read a week of Day by walking Day's primary key, in the day order its grouping
 * wants, filtering the window that Day's GiST serves. The serving rule is never restated: PostgreSQL finds the index,
 * in its own plan (EXPLAIN FORMAT JSON through the tree's one decoder, bench/harness/explain.ts).
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
 * The served property of the statements a read named `name` sent, each problem named by the read, judged against
 * `planned`, the names of the indexes the installation planned (plannedIndexes): each statement EXPLAINed with its
 * parameters on `admin` in one transaction rolled back, with sequential and index scans disabled.
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
				Effect.andThen(
					admin.query("SET LOCAL enable_seqscan = off", []),
					admin.query("SET LOCAL enable_indexscan = off", [])
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

/** The names of every index the installation planned: each key and enforcement index, and each it created. */
export const plannedIndexes = (installation: Installation): ReadonlySet<string> =>
	new Set(Arr.map(installation.indexes, (i) => i.index.name))

/**
 * The operations of any loaded member of the served Db of `ctx` (test/support/served-db.ts ServedDb.load), every read
 * of them through one executor over the Db's pool that records every statement it sends (adapter/db/handles.ts
 * memberOpsOn), and the counts it records into, which every member's reads share.
 */
export const recordingMembers = (
	ctx: ServedDbContext
): {
	readonly ops: (member: LoadedMember) => MemberOps<unknown>
	readonly counts: Counts
} => {
	const { executor, counts } = countingExecutor(poolExecutor(ctx))
	return { ops: (member) => memberOpsOn(executor, ctx, member).ops, counts }
}
