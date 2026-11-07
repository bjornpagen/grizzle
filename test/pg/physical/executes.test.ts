/**
 * EXECUTE follows what a role's statements evaluate, on PostgreSQL 19 (physical/ddl/roles.ts roleExecutes), over the
 * generated worlds of test/support/executes.ts: rosters, sets, a contract, laws whose CHECKs and generated columns cast
 * into their domains, and roles writing drawn relations.
 *
 * The oracle is the catalog's own record of what an object evaluates, independent of the installer: from every table a
 * role inserts into or updates, its views, its policies and the domains it holds USAGE on, through pg_depend's normal
 * dependencies on functions and types (a CHECK's, a default's or generated column's, an index's, a view's rule, a
 * policy's, a function body's), each table's columns' types and each domain's CHECKs and base type. For every role:
 *
 * - has_function_privilege holds of exactly the constants reached so, with every closed relation's constants, which its
 *   queries' closed reads call;
 * - its first insert into each table it writes, of a row every column domain admits, is refused by no missing
 *   privilege (42501): every function a CHECK or a generated column calls, through a cast into a domain or not, is
 *   granted.
 *
 * Planted bug: the installer's reachability stops following a statement's types, and every seed fails.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec, Result } from "effect"
import { handlesText } from "#compiler/ir/codes.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import {
	buildExecutesWorld,
	constantsOf,
	type ExecutesWorld,
	executesWorldGen,
	type FieldSketch,
	installedRole,
	reachableConstants
} from "#test/support/executes.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

type Feature =
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
const reachedSql = `WITH RECURSIVE
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
const grantedSql = `SELECT p.proname::text FROM pg_catalog.pg_proc p
	JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
	WHERE n.nspname = $2::name AND pg_catalog.has_function_privilege($1::name, p.oid, 'EXECUTE')`

const sorted = (xs: Iterable<string>): ReadonlyArray<string> => Arr.sort(xs, Order.String)

/** Takes on `role` for one statement in the owner's session and rolls back: the SQLSTATE it was refused with, if any. */
const refusalAs = (session: RawSession, role: string, sql: string, params: ReadonlyArray<string>) =>
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

layer(Substrate.layer)("a role's EXECUTE grants on PostgreSQL 19", (it) => {
	it.effect(
		"hold of exactly the constants the catalog says its writes and reads evaluate, and refuse no first insert",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const owner = yield* substrate.session({ ...ownerSession(), label: "executes owner" })
					return yield* explore(
						{
							oracle: { kind: "unstated" },
							suite: "pg/physical/executes",
							draw: drawn(executesWorldGen),
							literal: Formatter.format,
							coverage: required<Feature>(
								[
									"a constant only a written table's casts reach",
									"a role that writes nothing",
									"an insert that holds"
								],
								{ cases: 16, sense: notesOnly }
							),
							kept: [],
							runs: 16,
							shrink: { kind: "bounded", candidates: 40 },
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						(world: ExecutesWorld, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const built = buildExecutesWorld(world, "Grants")
									const m = yield* installMigrated(built.schema, {
										label: "executes",
										logins: [built.login],
										extensions: [],
										ambient: ordinarySession
									})
									const i = m.installation
									const names = namesOf(m)
									const constants = constantsOf(i)
									const closedConstants = Arr.flatMap(Rec.values(i.owned.relations), (r) =>
										r.kind === "closedRelation"
											? Arr.map(i.names.closed(r.name).functions, (f) => f.name)
											: []
									)
									const codecOf = (roster: string) =>
										defined(
											Option.getOrUndefined(
												Arr.findFirst(
													[...i.names.codes.rosters.values()],
													(x) => x.roster === roster
												)
											),
											`the codes of ${roster}`
										)
									/** A value every domain of the field admits: a live handle's code, the empty set, one. */
									const valueOf = (f: FieldSketch): string => {
										switch (f.kind) {
											case "code": {
												const roster = defined(
													built.rosters.get(f.roster),
													`the roster ${f.roster}`
												)
												return String(names.code(roster, roster.handles[0]))
											}
											case "set":
												return handlesText(codecOf(f.roster), [])
											case "count":
											case "plain":
												return "1"
											case "ref":
												return "00000000-0000-4000-8000-000000000002"
										}
									}
									for (const r of world.roles) {
										const installed = installedRole(i, r.name)
										const reached = yield* owner.values(reachedSql, [
											installed.role,
											i.names.schema,
											installed.schema
										])
										const granted = yield* owner.values(grantedSql, [
											installed.role,
											i.names.schema
										])
										const expected = new Set([
											...Arr.filter(
												Arr.map(reached, (row) => String(row[0])),
												(name) => constants.has(name)
											),
											...closedConstants
										])
										assert.deepEqual(
											sorted(
												Arr.filter(
													Arr.map(granted, (row) => String(row[0])),
													(name) => constants.has(name)
												)
											),
											sorted(expected),
											`the constants ${r.name} holds EXECUTE on, against the catalog's reach`
										)
										if (r.writes.length === 0) {
											c.note("a role that writes nothing")
										}
										const every = reachableConstants(i, installed, "every type")
										const own = reachableConstants(i, installed, "no written table's types")
										if (Arr.some([...every], (name) => !own.has(name))) {
											c.note("a constant only a written table's casts reach")
										}
										for (const written of r.writes) {
											const sketch = defined(
												Option.getOrUndefined(
													Arr.findFirst(world.relations, (x) => x.name === written)
												),
												`the relation ${written}`
											)
											const value = defined(built.relations.get(written), `the relation ${written}`)
											const columns = [
												names.column(value, "id"),
												...Arr.map(sketch.fields, (f) => names.column(value, f.name))
											]
											const refused = yield* refusalAs(
												owner,
												installed.role,
												`INSERT INTO ${names.table(value)} (${Arr.join(columns, ", ")}) VALUES (${Arr.join(
													Arr.map(columns, (_, k) => `$${k + 1}`),
													", "
												)})`,
												["00000000-0000-4000-8000-000000000001", ...Arr.map(sketch.fields, valueOf)]
											)
											assert.notDeepEqual(
												refused,
												Option.some("42501"),
												`${r.name}'s first insert into ${written} lacks no privilege`
											)
											if (Option.isNone(refused)) {
												c.note("an insert that holds")
											}
										}
									}
								})
							)
					)
				})
			)
	)
})
