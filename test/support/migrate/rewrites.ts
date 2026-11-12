import { Array as Arr, Effect, Option, type Scope } from "effect"
import { quoteIdent, quoteString } from "#compiler/sql/print.ts"
import type { SubstrateShape, TextRows } from "#test/support/substrate/substrate.ts"

/**
 * PostgreSQL's own record of the tables it rewrites, the oracle of "a migration rewrites each table at most once".
 *
 * PostgreSQL fires a `table_rewrite` event trigger once for each table an ALTER TABLE statement rewrites, before it
 * copies the heap (src/backend/commands/tablecmds.c ATRewriteTables, EventTriggerTableRewrite), and never for a
 * statement that only scans the table or changes the catalog. The observer installs one such trigger in the substrate's
 * database, as the bootstrap superuser, whose function appends the rewritten table's OID to a log; the scope's
 * finalizer drops the trigger, its function and the log. An event trigger is the database's, so a file that observes
 * rewrites builds Substrate.isolatedLayer, a database of its own.
 *
 * A rewrite rolled back with its transaction leaves no entry. A table is logged by its OID, which a rename keeps, and
 * read back under the name pg_class holds for it when the log is read.
 */
export interface RewriteObserver {
	/** The log's position now: every rewrite logged later is after it. */
	readonly mark: Effect.Effect<RewriteMark>
	/** Each table of the PostgreSQL schema `schema` rewritten since `mark`, with how many times, by its name now. */
	readonly since: (mark: RewriteMark, schema: string) => Effect.Effect<ReadonlyMap<string, number>>
	/** `run`, and each table of `schema` rewritten while it ran, with how many times (since). */
	readonly during: <A, E, R>(
		schema: string,
		run: Effect.Effect<A, E, R>
	) => Effect.Effect<{ readonly value: A; readonly rewrites: ReadonlyMap<string, number> }, E, R>
}

/** A position of the rewrite log: the sequence number of its last entry, 0 for none. */
export interface RewriteMark {
	readonly at: bigint
}

/** The schema the observer's log and function live in, which no installation under test names. */
const logSchema = quoteIdent("gz_table_rewrites")
const log = `${logSchema}.${quoteIdent("log")}`
const recorder = `${logSchema}.${quoteIdent("record")}`
const trigger = quoteIdent("gz_table_rewrites")

/** The text of one cell a read answers, absent as none. */
const cell = (rows: TextRows, row: number, column: number): Option.Option<string> =>
	Option.fromNullishOr(rows[row]?.[column])

/** The rewrite observer of the substrate's database, installed for the scope. */
export const rewriteObserver = (
	substrate: SubstrateShape
): Effect.Effect<RewriteObserver, never, Scope.Scope> =>
	Effect.gen(function* () {
		yield* Effect.acquireRelease(
			Effect.forEach(
				[
					`CREATE SCHEMA ${logSchema}`,
					`CREATE TABLE ${log} ("seq" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "relid" pg_catalog.oid NOT NULL)`,
					`CREATE FUNCTION ${recorder}() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$BEGIN INSERT INTO ${log} ("relid") VALUES (pg_catalog.pg_event_trigger_table_rewrite_oid()); END$$`,
					`CREATE EVENT TRIGGER ${trigger} ON table_rewrite EXECUTE FUNCTION ${recorder}()`
				],
				substrate.superuser,
				{ discard: true }
			),
			() =>
				Effect.forEach(
					[`DROP EVENT TRIGGER ${trigger}`, `DROP SCHEMA ${logSchema} CASCADE`],
					substrate.superuser,
					{ discard: true }
				)
		)
		const mark: Effect.Effect<RewriteMark> = substrate.superuserRead((rows) =>
			Effect.map(rows(`SELECT coalesce(max("seq"), 0)::text FROM ${log}`), (r) => ({
				at: BigInt(Option.getOrElse(cell(r, 0, 0), () => "0"))
			}))
		)
		const since = (from: RewriteMark, schema: string): Effect.Effect<ReadonlyMap<string, number>> =>
			substrate.superuserRead((rows) =>
				Effect.map(
					rows(
						`SELECT c.relname::text, count(*)::text FROM ${log} AS l JOIN pg_catalog.pg_class AS c ON c.oid = l.relid JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = ${quoteString(schema)}::name AND l.seq > ${from.at.toString()}::bigint GROUP BY c.relname ORDER BY c.relname`
					),
					(r) =>
						new Map(
							Arr.flatMap(r, ([name, count]) =>
								name === undefined || name === null || count === undefined || count === null
									? []
									: [[name, Number(count)] as const]
							)
						)
				)
			)
		const during = <A, E, R>(schema: string, run: Effect.Effect<A, E, R>) =>
			Effect.gen(function* () {
				const before = yield* mark
				const value = yield* run
				const rewrites = yield* since(before, schema)
				return { value, rewrites }
			})
		return { mark, since, during }
	})
