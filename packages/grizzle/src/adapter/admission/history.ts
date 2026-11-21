import { Array as Arr, Effect } from "effect"
import { textArray } from "#adapter/admission/roles.ts"
import { DriftUnchecked, type MigrateError, stopped } from "#adapter/migrate/errors.ts"
import { apartRows, type MigrationSession } from "#adapter/migrate/session.ts"
import { oneShotStatement, sentAnswer } from "#adapter/wire/batch.ts"
import type { CatalogQuery } from "#adapter/wire/statement.ts"
import { C } from "#compiler/plan/catalog.ts"
import { emitCatalog, type ObjectName } from "#compiler/plan/common.ts"
import type { LiveNames } from "#compiler/plan/migration.ts"

const n = C.from("pg_namespace", "n")
const p = C.from("pg_proc", "p")
const c = C.from("pg_class", "c")
const a = C.from("pg_attribute", "a")

/** The schema read is one of $1. */
const amongSchemas = (namespace: C.CatalogExpr): C.CatalogExpr =>
	C.any(namespace, C.arrayParam(1, "text"))

/**
 * Every installed function of the schemas $1 that takes no argument and returns name[], by its schema and name: each
 * an installed constant of names, a roster's names constant among them (compiler/physical/ddl/constants.ts addRosters),
 * whose CREATE FUNCTION returns name[] of its codes' names.
 */
const namesConstantsQuery: CatalogQuery<ObjectName> = {
	sql: emitCatalog(
		C.query(
			[C.asText(n.col("nspname")), C.asText(p.col("proname"))],
			[C.join(p.item, n.item, C.eq(n.col("oid"), p.col("pronamespace")))],
			C.and([
				amongSchemas(n.col("nspname")),
				C.eq(p.col("pronargs"), C.literal(0n, "smallint")),
				C.eq(
					C.catalogCall("format_type", [p.col("prorettype"), C.nullOf("integer")]),
					C.text("name[]")
				)
			])
		)
	),
	what: "an installed constant of names' schema and name",
	row: ([schema, name]) =>
		schema === undefined || name === undefined ? undefined : { schema, name }
}

/** The elements of the installed constant of names `constant`, in its order, each as its text. */
const namesOfQuery = (constant: ObjectName): CatalogQuery<string> => {
	const u = C.fromConstantElements(constant, "u")
	return {
		sql: emitCatalog(
			C.select({
				...C.catalogCore([C.asText(u.col("element"))], [u.item], undefined),
				orderBy: [u.col("position")]
			})
		),
		what: "a name of an installed constant of names",
		row: ([name]) => name
	}
}

/**
 * Every table of the schemas $1 by its name, with the attribute numbers it has used: pg_attribute holds a row for each,
 * a dropped column's among them, which PostgreSQL never reuses, so their count is the greatest.
 */
const attnumsQuery: CatalogQuery<readonly [string, number]> = {
	sql: emitCatalog(
		C.query(
			[
				C.asText(c.col("relname")),
				C.asText(
					C.scalar(
						C.query(
							[C.countStar],
							[a.item],
							C.and([
								C.eq(a.col("attrelid"), c.col("oid")),
								C.gt(a.col("attnum"), C.literal(0n, "smallint"))
							])
						)
					)
				)
			],
			[C.join(c.item, n.item, C.eq(n.col("oid"), c.col("relnamespace")))],
			C.and([amongSchemas(n.col("nspname")), C.inList(c.col("relkind"), C.letters(["r", "p"]))])
		)
	),
	what: "a table's name and the attribute numbers it has used",
	row: ([table, count]) => {
		const used = count === undefined ? Number.NaN : Number(count)
		return table === undefined || !Number.isSafeInteger(used) ? undefined : [table, used]
	}
}

/**
 * What `grizzle upgrade` reads of an installation's history off its live database (cli/upgrade.ts): every installed
 * constant of names with its elements, which its rosters' codes are read off (compiler/deploy/upgrade/history.ts
 * liveRosters), and each table's attribute numbers used, by its name.
 */
export interface LiveHistory {
	readonly constants: ReadonlyArray<LiveNames>
	readonly attnums: ReadonlyMap<string, number>
}

/** A read of the history of `schema` the database refused or could not answer, as the drift check's: no verdict. */
const unread =
	(schema: string) =>
	(failure: DriftUnchecked["failure"]): MigrateError =>
		stopped(new DriftUnchecked({ schema, failure }))

/**
 * The history of the installation of `schemas`, `schema` its root, read in two steps of statements apart: the constants
 * of names and the tables' attribute numbers, then each constant's elements.
 */
export const readHistory = Effect.fn("readHistory")(function* (
	session: MigrationSession,
	schema: string,
	schemas: Arr.NonEmptyReadonlyArray<string>
): Effect.fn.Return<LiveHistory, MigrateError> {
	const failed = unread(schema)
	const params = [textArray(schemas)]
	const first = yield* Effect.mapError(
		session.apart([
			oneShotStatement(namesConstantsQuery.sql, params),
			oneShotStatement(attnumsQuery.sql, params)
		]),
		failed
	)
	const constants = yield* Effect.mapError(
		Effect.fromResult(apartRows(namesConstantsQuery, sentAnswer(first, 0))),
		failed
	)
	const attnums = yield* Effect.mapError(
		Effect.fromResult(apartRows(attnumsQuery, sentAnswer(first, 1))),
		failed
	)
	const reads = Arr.map(constants, namesOfQuery)
	const elements = Arr.isReadonlyArrayNonEmpty(reads)
		? yield* Effect.mapError(
				session.apart(Arr.map(reads, (q) => oneShotStatement(q.sql, []))),
				failed
			)
		: []
	const named: Array<LiveNames> = []
	for (const [i, constant] of constants.entries()) {
		const query = reads[i]
		if (query === undefined) {
			break
		}
		const names = yield* Effect.mapError(
			Effect.fromResult(apartRows(query, sentAnswer(elements, i))),
			failed
		)
		named.push({ constant, names })
	}
	const history: LiveHistory = { constants: named, attnums: new Map(attnums) }
	return history
})
