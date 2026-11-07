import { Array as Arr, Order, String as Str } from "effect"
import { textArray } from "#adapter/admission/roles.ts"
import { C, emptyNameMap, isDecimal, refreshStatement } from "#compiler/plan/catalog.ts"
import {
	concatNonEmpty,
	emitCatalog,
	type EmittedText,
	emitText,
	type Expr,
	lit,
	mapNonEmpty,
	type NonEmptyReadonlyArray,
	type ObjectName,
	type OutputRows,
	type ParamText,
	sqlstates,
	types
} from "#compiler/plan/common.ts"
import { textParam } from "#compiler/plan/read.ts"

/**
 * Plain or CONCURRENTLY: which refresh statement each view takes.
 *
 * "The first refresh of a view after its creation is a plain REFRESH MATERIALIZED VIEW, because the concurrent form
 * needs a populated view. Every later one is REFRESH MATERIALIZED VIEW CONCURRENTLY". Whether a view has
 * been populated is PostgreSQL's own record of it, `pg_class.relispopulated`: false from
 * `CREATE MATERIALIZED VIEW ... WITH NO DATA` until the first REFRESH commits, and false again after a migration drops
 * and recreates the view. There is no host-side memory of it, which would be wrong across instances and
 * across migrations.
 *
 * The refresh transaction reads it for every view it names in one statement per schema, its first, so in the
 * transaction's own SERIALIZABLE snapshot, before any refresh statement runs. A view the snapshot
 * shows populated stays populated, because only a migration, which recreates the view, makes it unpopulated again, and
 * another refresher's commit after the snapshot meets its CONCURRENTLY diff as 40001 (run.ts). A view the catalog does
 * not hold fails its rewrite check with PostgreSQL's own refusal (42P01), as the plain refresh statement would.
 *
 * A view the snapshot shows unpopulated takes the plain form, and there another refresher's commit after the snapshot
 * would go unmet: the plain statement swaps in a new heap built from this transaction's snapshot instead of diffing
 * tuples, so neither a unique index nor SSI meets the rows the other refresher published, and the later commit would
 * overwrite them with an older state, which no serial order of the two refreshes produces. So before any refresh
 * statement the transaction runs the rewrite check (`rewrittenSelect`) for each named view, and refuses a plain refresh whose view it reports
 * rewritten (a populated view's report decides nothing, run.ts): its CTE names the view, which takes the
 * view's ACCESS SHARE lock, waiting for any plain refresh of it in progress (whose ACCESS EXCLUSIVE lock is held to its
 * commit), and the lock's acquisition processes the catalog invalidations of everything committed meanwhile. It then
 * compares the view's storage as the transaction's snapshot shows it (`pg_class.relfilenode`, read by MVCC) with the
 * catalog's current one (`pg_relation_filenode`, read through the system cache). Every plain refresh rewrites the view
 * into new storage, so a difference is exactly another refresher's plain refresh committed after the snapshot, and the
 * refresh fails with TransientFailure{ConcurrentRefresh}; a caller's retry has a snapshot that sees the view populated
 * and takes the concurrent form. A CONCURRENTLY refresh keeps the storage, and one committed after the snapshot needs a populating
 * commit before it, which the comparison already meets. The ACCESS SHARE lock is held to the end of the transaction, so
 * no other plain refresh can commit between the comparison and this transaction's own refresh statement; two grizzle
 * refreshers that both compared before either refreshed then deadlock on the upgrade, and the 40P01 fails one of them.
 *
 * The statements are catalog-read ASTs the engine prints (sql/catalog.ts), like admission's: every name absolute, every
 * parameter cast, every literal typed, and nothing they return can be NULL (relname and relispopulated are NOT NULL
 * catalog columns, and the comparison is IS DISTINCT FROM, never `<>`, over the storage a materialized view always has).
 *
 * The choice is the server's (refreshBlock): one DO block reads each named view's populated state, runs every rewrite
 * check, and then issues each refresh statement, plain or CONCURRENTLY as the reading chose, through EXECUTE, so the
 * refresh needs no answer before its refresh statements and is one round trip. PostgreSQL runs REFRESH MATERIALIZED
 * VIEW, CONCURRENTLY included, inside a transaction block and from PL/pgSQL alike: it refuses neither (matview.c
 * checks only that the view is populated for CONCURRENTLY, and not in use by an open scan of this transaction, which
 * no earlier statement of the block leaves). The block's own reads see the transaction's snapshot, the one the
 * statements in front of it read, so the populated reading the host also takes in front of the block is the block's
 * choice. A rewritten unpopulated view raises grizzle's concurrent-change code (core/sqlstate.ts), the class 40 code a
 * write statement raises for a concurrent change it met and nothing else in a refresh raises, with the target's
 * position in refresh order as its DETAIL, which the host reads back as TransientFailure{ConcurrentRefresh}; any other
 * refusal inside the block keeps its own SQLSTATE.
 */
const views = C.from("pg_class", "c")
const viewSchemas = C.from("pg_namespace", "n")
const viewsIn = C.join(
	views.item,
	viewSchemas.item,
	C.eq(viewSchemas.col("oid"), views.col("relnamespace"))
)
const isView = C.eq(views.col("relkind"), C.letter("m"))

/** The materialized views of the schema $1 among the names $2, each with whether it is populated. */
export const populatedSql: EmittedText = emitCatalog(
	C.query(
		[C.asText(views.col("relname")), C.asText(views.col("relispopulated"))],
		[viewsIn],
		C.and([
			C.eq(viewSchemas.col("nspname"), C.param(1, "name")),
			isView,
			C.any(views.col("relname"), C.arrayParam(2, "name"))
		])
	)
)

/** The parameters of `populatedSql` for the views named `names` of one PostgreSQL schema. */
export const populatedParams = (
	schema: string,
	names: ReadonlyArray<string>
): ReadonlyArray<ParamText> => [
	textParam(schema),
	textArray(Arr.sort(new Set(names), Order.String))
]

/**
 * The views `populatedSql` reported populated. A row is the view's name and PostgreSQL's boolean text, each a text
 * cell as the wire delivers every one.
 */
export const populatedViews = (rows: OutputRows): ReadonlySet<string> => {
	const out = new Set<string>()
	for (const [name, populated] of rows) {
		if (name !== undefined && populated === "true") {
			out.add(name)
		}
	}
	return out
}

/** The refresh statement's text for one view: CONCURRENTLY exactly when it is populated. */
export const refreshSql = (view: ObjectName, populated: boolean): EmittedText =>
	emitText(refreshStatement(view, populated), emptyNameMap).text

/**
 * Whether another refresher rewrote the view of the schema $1 named $2 after the transaction's snapshot, waiting first
 * for a plain refresh of it in progress (see the header). The view is named in the statement too, as `view`, because
 * only a relation the statement names is locked. The CTE reads no row: the planner drops it unreferenced, so a view
 * that is still unpopulated is never scanned.
 */
const rewrittenSelect = (view: ObjectName): C.CatalogSelect => {
	const locked = C.fromObject(view, "r1")
	return C.withCtes(
		[C.cte("lock", ["c1"], C.query([C.literal(1n, "integer")], [locked.item], C.bool(false)))],
		C.query(
			[
				C.distinctFrom(C.call("pg_relation_filenode", [views.col("oid")]), views.col("relfilenode"))
			],
			[viewsIn],
			C.and([
				C.eq(viewSchemas.col("nspname"), C.param(1, "name")),
				C.eq(views.col("relname"), C.param(2, "name")),
				isView
			])
		)
	)
}

/** The parameters of `rewrittenSelect` for `view`, as the EXECUTE binds them. */
const rewrittenParams = (view: ObjectName): ReadonlyArray<Expr> => [
	lit.text(view.schema, types.text),
	lit.text(view.name, types.text)
]

/**
 * The DETAIL the refresh block raises for the target at `position` in refresh order, and the position a DETAIL names.
 */
const concurrentRefreshTag = "ConcurrentRefresh "
export const concurrentRefreshDetail = (position: number): string =>
	`${concurrentRefreshTag}${position}`

export const concurrentRefreshPosition = (detail: string | undefined): number | undefined => {
	if (detail === undefined || !Str.startsWith(concurrentRefreshTag)(detail)) {
		return undefined
	}
	const digits = Str.slice(concurrentRefreshTag.length)(detail)
	return isDecimal(digits) ? Number(digits) : undefined
}

/** A boolean PL/pgSQL variable of the refresh block. */
const variable = (name: string): Expr => ({ kind: "plVar", name })

const isTrue = (expr: Expr): Expr => ({ kind: "isTrue", expr })

/** EXECUTE of the refresh statement of `view`, plain or CONCURRENTLY. */
const refreshOf = (view: ObjectName, concurrently: boolean): C.DoStatement => ({
	kind: "execute",
	command: { kind: "statement", statement: refreshStatement(view, concurrently) },
	into: undefined,
	using: []
})

/**
 * The refresh block of the views `targets`, in refresh order (see the header), a DO block (sql/catalog.ts DoBlock):
 *
 *   DO $$
 *   DECLARE "p0" boolean; "c0" boolean; ...
 *   BEGIN
 *     SELECT "c"."relispopulated" INTO "p0" FROM ... WHERE "n"."nspname" = '<schema>'::name AND ...;
 *     EXECUTE '<the rewrite check of the view>' INTO "c0" USING '<schema>', '<view>';
 *     IF NOT "p0" IS TRUE AND "c0" IS TRUE THEN RAISE EXCEPTION ... USING ERRCODE = '40Z01', DETAIL = '... 0'; END IF;
 *     IF "p0" IS TRUE THEN EXECUTE '<REFRESH ... CONCURRENTLY>'; ELSE EXECUTE '<REFRESH ...>'; END IF;
 *   END
 *   $$
 *
 * Every populated reading and every rewrite check comes before the first refresh statement, as they would in their own
 * statements. The printer dollar-quotes the body under a tag it does not contain and quotes each executed statement.
 */
export const refreshBlock = (targets: NonEmptyReadonlyArray<ObjectName>): EmittedText => {
	const slots = mapNonEmpty(targets, (view, i) => ({ view, i, p: `p${i}`, c: `c${i}` }))
	const reads = Arr.map(slots, ({ view, p }): C.DoStatement => ({
		kind: "selectInto",
		query: C.core(
			[views.col("relispopulated")],
			[viewsIn],
			C.and([
				C.eq(viewSchemas.col("nspname"), C.literal(view.schema, "name")),
				C.eq(views.col("relname"), C.literal(view.name, "name")),
				isView
			])
		),
		into: [p]
	}))
	const checks = Arr.map(slots, ({ view, c }): C.DoStatement => ({
		kind: "execute",
		command: { kind: "statement", statement: rewrittenSelect(view) },
		into: c,
		using: rewrittenParams(view)
	}))
	const refusals = Arr.map(slots, ({ i, p, c }): C.DoStatement => ({
		kind: "if",
		branches: [
			{
				condition: {
					kind: "and",
					args: [{ kind: "not", expr: isTrue(variable(p)) }, isTrue(variable(c))]
				},
				body: [
					{
						kind: "raise",
						message: "grizzle refused the refresh",
						using: [
							{
								option: "ERRCODE",
								value: lit.text(sqlstates.grizzleConcurrentChange, types.text)
							},
							{ option: "DETAIL", value: lit.text(concurrentRefreshDetail(i), types.text) }
						]
					}
				]
			}
		],
		else: []
	}))
	const refreshes = mapNonEmpty(slots, ({ view, p }): C.DoStatement => ({
		kind: "if",
		branches: [{ condition: isTrue(variable(p)), body: [refreshOf(view, true)] }],
		else: [refreshOf(view, false)]
	}))
	return emitCatalog({
		kind: "do",
		declare: Arr.flatMap(slots, ({ p, c }) => [
			{ name: p, type: types.boolean },
			{ name: c, type: types.boolean }
		]),
		body: concatNonEmpty([...reads, ...checks, ...refusals], refreshes)
	})
}
