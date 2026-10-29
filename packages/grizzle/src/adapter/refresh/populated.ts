import { Array as Arr, Order, String as Str } from "effect"
import { textArray } from "#adapter/admission/roles.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { refreshStatement } from "#compiler/physical/derived/objects.ts"
import type { ObjectName } from "#compiler/sql/ast.ts"
import { isDecimal } from "#compiler/sql/naming.ts"
import { printObjectName, printStatement } from "#compiler/sql/print.ts"

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
 * statement the transaction runs `rewrittenSql` for each named view, and refuses a plain refresh whose view it reports
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
 * The statements are adapter-owned catalog SQL, like admission's: every identifier quoted, every parameter cast, every
 * literal typed, and nothing they return can be NULL (relname and relispopulated are NOT NULL catalog columns, and the
 * comparison is IS DISTINCT FROM, never `<>`, over the storage a materialized view always has).
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
export const populatedSql =
	'SELECT "c"."relname"::text, "c"."relispopulated"::text FROM "pg_catalog"."pg_class" AS "c" ' +
	'JOIN "pg_catalog"."pg_namespace" AS "n" ON "n"."oid" = "c"."relnamespace" ' +
	'WHERE "n"."nspname" = $1::name AND "c"."relkind" = \'m\'::"char" AND "c"."relname" = ANY ($2::name[])'

/** The parameters of `populatedSql` for the views of one PostgreSQL schema. */
export const populatedParams = (
	schema: string,
	views: ReadonlyArray<string>
): ReadonlyArray<string> => [schema, textArray(Arr.sort(new Set(views), Order.String))]

/**
 * The views `populatedSql` reported populated. A row is the view's name and PostgreSQL's boolean text, each a text
 * cell as the wire delivers every one.
 */
export const populatedViews = (rows: ReadonlyArray<ReadonlyArray<string>>): ReadonlySet<string> => {
	const out = new Set<string>()
	for (const [name, populated] of rows) {
		if (name !== undefined && populated === "true") {
			out.add(name)
		}
	}
	return out
}

/** The refresh statement's text for one view: CONCURRENTLY exactly when it is populated. */
export const refreshSql = (view: ObjectName, populated: boolean): string =>
	printStatement(refreshStatement(view, populated))

/**
 * Whether another refresher rewrote `view` after the transaction's snapshot, waiting first for a plain refresh of it in
 * progress (see the header). The view is named in the text, schema-qualified, because only a relation the statement
 * names is locked; its schema and name are also the parameters `rewrittenParams` gives. The CTE reads no row: the
 * planner drops it unreferenced, so a view that is still unpopulated is never scanned.
 */
const rewrittenSql = (view: ObjectName): string =>
	`WITH "lock"("c1") AS (SELECT 1::int4 FROM ${printObjectName(view)} AS "r1" WHERE false) ` +
	'SELECT ("pg_catalog"."pg_relation_filenode"("c"."oid") IS DISTINCT FROM "c"."relfilenode")::text ' +
	'FROM "pg_catalog"."pg_class" AS "c" JOIN "pg_catalog"."pg_namespace" AS "n" ON "n"."oid" = "c"."relnamespace" ' +
	'WHERE "n"."nspname" = $1::name AND "c"."relname" = $2::name AND "c"."relkind" = \'m\'::"char"'

/** The parameters of `rewrittenSql` for `view`. */
const rewrittenParams = (view: ObjectName): ReadonlyArray<string> => [view.schema, view.name]

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

/**
 * A text as an SQL string literal: every quote doubled, a backslash taken as itself under standard_conforming_strings,
 * PostgreSQL's default, which no login overrides: admission refuses a role setting the snapshot does not declare.
 */
const literal = (text: string): string => `'${Str.replaceAll("'", "''")(text)}'`

/**
 * The refresh block of `views`, in refresh order (see the header):
 *
 *   DO $grizzle$ DECLARE "p0" boolean; "c0" text; ... BEGIN
 *     SELECT "c"."relispopulated" INTO "p0" FROM ... WHERE "n"."nspname" = '<schema>' AND "c"."relname" = '<view>' ...;
 *     EXECUTE '<rewrittenSql>' INTO "c0" USING '<schema>', '<view>';
 *     IF "p0" IS NOT TRUE AND "c0" = 'true' THEN RAISE EXCEPTION ... USING ERRCODE = '40Z01', DETAIL = '... 0'; END IF;
 *     IF "p0" IS TRUE THEN EXECUTE '<REFRESH ... CONCURRENTLY>'; ELSE EXECUTE '<REFRESH ...>'; END IF;
 *   END $grizzle$
 *
 * Every populated reading and every rewrite check comes before the first refresh statement, as they would in their own
 * statements. The body is dollar-quoted under a tag it does not contain.
 */
export const refreshBlock = (views: ReadonlyArray<ObjectName>): string => {
	/** Each view with its index and the two variables the block reads it into: whether it is populated, and its check. */
	const slots = Arr.map(views, (view, i) => ({ view, i, p: `"p${i}"`, c: `"c${i}"` }))
	const declare = Arr.join(
		Arr.map(slots, (s) => `${s.p} boolean; ${s.c} text;`),
		" "
	)
	const reads = Arr.map(slots, ({ view, p }) => {
		const schema = view.schema
		return (
			`SELECT "c"."relispopulated" INTO ${p} FROM "pg_catalog"."pg_class" AS "c" ` +
			'JOIN "pg_catalog"."pg_namespace" AS "n" ON "n"."oid" = "c"."relnamespace" ' +
			`WHERE "n"."nspname" = ${literal(schema)}::name AND "c"."relname" = ${literal(view.name)}::name ` +
			`AND "c"."relkind" = 'm'::"char";`
		)
	})
	const checks = Arr.map(
		slots,
		({ view, c }) =>
			`EXECUTE ${literal(rewrittenSql(view))} INTO ${c} USING ` +
			`${Arr.join(
				Arr.map(rewrittenParams(view), (p) => literal(p)),
				", "
			)};`
	)
	const refusals = Arr.map(
		slots,
		({ i, p, c }) =>
			`IF ${p} IS NOT TRUE AND ${c} = 'true' THEN RAISE EXCEPTION 'grizzle refused the refresh' ` +
			`USING ERRCODE = ${literal(sqlstates.grizzleConcurrentChange)}, DETAIL = ${literal(concurrentRefreshDetail(i))}; END IF;`
	)
	const refreshes = Arr.map(
		slots,
		({ view, p }) =>
			`IF ${p} IS TRUE THEN EXECUTE ${literal(refreshSql(view, true))}; ` +
			`ELSE EXECUTE ${literal(refreshSql(view, false))}; END IF;`
	)
	const body = `DECLARE ${declare} BEGIN ${Arr.join([...reads, ...checks, ...refusals, ...refreshes], " ")} END`
	let tag = "$grizzle$"
	for (let n = 1; Str.includes(tag)(body); n++) {
		tag = `$grizzle${n}$`
	}
	return `DO ${tag} ${body} ${tag}`
}
