/** What the properties of executes.test.ts read: its spaces, models and helpers. */

import { Array as Arr, Effect, Option, Order, Result } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

export type Feature =
	| "a constant only a written table's casts reach"
	| "a role that writes nothing"
	| "an insert that holds"

/**
 * The functions of the schema `$2` that the role `$1` evaluates, by the catalog: from the tables it inserts into or
 * updates, the views of its schema `$3`, its policies and the domains it holds USAGE on, through every edge an object's
 * evaluation follows (a table to its CHECKs, defaults and generated columns, columns' types and indexes; a view to its
 * rule; a domain to its CHECKs and base type; any object to the functions and types its expressions name, which
 * pg_depend records as normal dependencies, a SQL function body's included).
 */
export const reachedSql = `WITH RECURSIVE
	edge (classid, objid, refclassid, refobjid) AS (
		SELECT 'pg_class'::regclass::oid, c.conrelid, 'pg_constraint'::regclass::oid, c.oid
			FROM pg_catalog.pg_constraint c WHERE c.contype = 'c' AND c.conrelid <> 0
		UNION ALL
		SELECT 'pg_class'::regclass::oid, d.adrelid, 'pg_attrdef'::regclass::oid, d.oid
			FROM pg_catalog.pg_attrdef d
		UNION ALL
		SELECT 'pg_class'::regclass::oid, a.attrelid, 'pg_type'::regclass::oid, a.atttypid
			FROM pg_catalog.pg_attribute a WHERE a.attnum > 0 AND NOT a.attisdropped
		UNION ALL
		SELECT 'pg_class'::regclass::oid, i.indrelid, 'pg_class'::regclass::oid, i.indexrelid
			FROM pg_catalog.pg_index i
		UNION ALL
		SELECT 'pg_class'::regclass::oid, r.ev_class, 'pg_rewrite'::regclass::oid, r.oid
			FROM pg_catalog.pg_rewrite r
		UNION ALL
		SELECT 'pg_type'::regclass::oid, c.contypid, 'pg_constraint'::regclass::oid, c.oid
			FROM pg_catalog.pg_constraint c WHERE c.contypid <> 0
		UNION ALL
		SELECT 'pg_type'::regclass::oid, t.oid, 'pg_type'::regclass::oid, t.typbasetype
			FROM pg_catalog.pg_type t WHERE t.typtype = 'd'
		UNION ALL
		SELECT d.classid, d.objid, d.refclassid, d.refobjid
			FROM pg_catalog.pg_depend d
			WHERE d.deptype = 'n' AND d.refclassid IN ('pg_proc'::regclass::oid, 'pg_type'::regclass::oid)
	),
	base AS (SELECT n.oid FROM pg_catalog.pg_namespace n WHERE n.nspname = $2::name),
	own AS (SELECT n.oid FROM pg_catalog.pg_namespace n WHERE n.nspname = $3::name),
	root (classid, objid) AS (
		SELECT 'pg_class'::regclass::oid, c.oid FROM pg_catalog.pg_class c
			WHERE c.relnamespace = (SELECT oid FROM base) AND c.relkind = 'r'
				AND (pg_catalog.has_any_column_privilege($1::name, c.oid, 'INSERT')
					OR pg_catalog.has_any_column_privilege($1::name, c.oid, 'UPDATE'))
		UNION
		SELECT 'pg_class'::regclass::oid, c.oid FROM pg_catalog.pg_class c
			WHERE c.relnamespace = (SELECT oid FROM own) AND c.relkind = 'v'
		UNION
		SELECT 'pg_policy'::regclass::oid, p.oid FROM pg_catalog.pg_policy p
			WHERE (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = $1::name) = ANY (p.polroles)
		UNION
		SELECT 'pg_type'::regclass::oid, t.oid FROM pg_catalog.pg_type t
			WHERE t.typnamespace = (SELECT oid FROM base) AND t.typtype = 'd'
				AND pg_catalog.has_type_privilege($1::name, t.oid, 'USAGE')
	),
	reach (classid, objid) AS (
		SELECT classid, objid FROM root
		UNION
		SELECT e.refclassid, e.refobjid FROM reach r
			JOIN edge e ON e.classid = r.classid AND e.objid = r.objid
	)
SELECT p.proname::text FROM reach r
	JOIN pg_catalog.pg_proc p ON r.classid = 'pg_proc'::regclass::oid AND p.oid = r.objid
	WHERE p.pronamespace = (SELECT oid FROM base)`

/** The functions of the schema `$2` the role `$1` holds EXECUTE on. */
export const grantedSql = `SELECT p.proname::text FROM pg_catalog.pg_proc p
	JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
	WHERE n.nspname = $2::name AND pg_catalog.has_function_privilege($1::name, p.oid, 'EXECUTE')`

export const sorted = (xs: Iterable<string>): ReadonlyArray<string> => Arr.sort(xs, Order.String)

/** Takes on `role` for one statement in the owner's session and rolls back: the SQLSTATE it was refused with, if any. */
export const refusalAs = (
	session: RawSession,
	role: string,
	sql: string,
	params: ReadonlyArray<string>
) =>
	Effect.gen(function* () {
		yield* session.begin
		yield* session.query(`SET LOCAL ROLE ${quoteIdent(role)}`, [])
		const outcome = yield* Effect.result(session.query(sql, params))
		yield* session.rollback
		return Result.match(outcome, {
			onSuccess: () => Option.none<string>(),
			onFailure: (error) =>
				Option.some(
					error.reason._tag === "ServerError" ? error.reason.fields.code : error.reason.message
				)
		})
	})
