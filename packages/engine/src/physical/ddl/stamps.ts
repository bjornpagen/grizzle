/**
 * Each head of the schema (ir/instant.ts Head), a scope's or a place's, as the installation stores it: a table of its
 * keys' heads, one row a key, the last value stamped at it, and the function that stamps, which advances each key's
 * head and returns it. A write that stamps the head calls the function in the statement that stamps
 * (write/insert/stamp.ts), and nothing else writes or reads the table. A unit's scope stamps every clock of the unit
 * from one head keyed by the unit's heading, in the root's schema, as a sealed unit's founding stands there
 * (physical/ddl/seal.ts); a clock no unit holds stamps from its own child's, and a place from its group's, in its
 * relation's level's schema (physical/ddl/names.ts headIdentities).
 *
 *   CREATE TABLE "<schema>"."<head>" ("<k1>" <type 1> NOT NULL, …, "<at>" <type> NOT NULL, "__stamper" xid8 NOT NULL,
 *     CONSTRAINT "<head key>" PRIMARY KEY ("<k1>", …))
 *   REVOKE ALL ON TABLE "<schema>"."<head>" FROM PUBLIC
 *   CREATE OR REPLACE FUNCTION "<schema>"."<stamp>"("__children_1" <type 1>[], …[, "__clock" bigint])
 *     RETURNS SETOF "<schema>"."<head>" LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
 *     AS $$ BEGIN RETURN QUERY WITH "r1" AS (
 *       INSERT INTO "<schema>"."<head>" AS "r2" ("<k1>", …, "<at>", "__stamper")
 *       SELECT DISTINCT "r3"."c1", "__children_2"["r3"."c2"], …, <"__clock" | 0>, pg_current_xact_id()
 *       FROM unnest("__children_1") WITH ORDINALITY AS "r3"("c1", "c2") ORDER BY "r3"."c1", "__children_2"["r3"."c2"], …
 *       ON CONFLICT ("<k1>", …) DO UPDATE SET "<at>" = CASE WHEN "r2"."__stamper" = pg_current_xact_id()
 *         THEN "r2"."<at>" ELSE <greatest(EXCLUDED."<at>", "r2"."<at>" + 1) | "r2"."<at>" + 1> END,
 *         "__stamper" = pg_current_xact_id()
 *       RETURNING "r2"."<k1>" AS "c1", …, "r2"."<at>" AS "c<n>", "r2"."__stamper" AS "c<n + 1>")
 *     SELECT "r1"."c1", …, "r1"."c<n>" FROM "r1"; END $$
 *   REVOKE EXECUTE ON FUNCTION "<schema>"."<stamp>"(…) FROM PUBLIC
 *
 * The table's key columns are its key's fields' (ir/instant.ts headKey), by their names and types, every clock's of the
 * scope alike; then a clock head's `__instant` (identity.headInstant), every clock's type, or a place's own; and
 * `__stamper` (identity.headStamper), the 64-bit id of the transaction that stamped the key last, the top-level
 * transaction's inside a savepoint too, which no other transaction's id is and no wraparound repeats.
 * A migration that creates the table beside relations that may hold rows, a scope or a place added to stored rows, a
 * key or a type changed, a clock joining a scope over stored rows, fills it from each of them
 * (`headFill`): each key's head the greatest value they hold at it, so it stands above every stored row; a fresh
 * installation's relations hold none. From then on the stamp function is the
 * head's only writer: a clock is only ever stamped (`clockStated`), a put of a relation with a clock is refused, and a
 * place's relation admits no put and a delete of whole groups alone, which deletes their heads
 * (write/frontend/instants.ts), so every value a relation holds at a key is at most its head. A clock's deleted row
 * leaves the head where it was, and a later stamp is above it too.
 *
 * A call stamps each key once: a head its own transaction already stamped, its `__stamper` the call's transaction,
 * stands as it is, so every statement part that stamps the head at a key in one call, a clock's own rows, its
 * references' and every other clock's of the scope alike, each calling the function, takes the one instant
 * (write/insert/stamp.ts); and the instant a transaction stamped at a key is exactly the one its clocks' guard admits a
 * row there at (physical/ddl/clocked.ts), so no writer states a clock but at it. The stamper is the transaction's
 * 64-bit id, where a row's xmin, 32 bits, is a savepoint's own inside one and repeats past a wraparound that froze the
 * row (physical/ddl/seal.ts, which records its founder alike).
 *
 * Why a key's stamps follow its calls' commits, at every level (README "Instants"): the function's INSERT ... ON
 * CONFLICT DO UPDATE either inserts the key's row or locks the row it meets and assigns from that row's latest
 * committed version, waiting for a writer of it still in progress, whatever the calling statement's snapshot holds
 * (PostgreSQL 19, src/backend/executor/nodeModifyTable.c ExecOnConflictUpdate, heap_lock_tuple, the conflicting row
 * read with SnapshotAny); and it keeps that lock until its transaction ends, so two calls that stamp one key take
 * turns: the later one's stamp is the earlier one's plus the least step at least, and it commits after the earlier one
 * ended. So a scope's instants at a key rise in commit order across every clock of it (ir/instant.ts scopeOrder),
 * whatever each call's clock read: a call that began before another committed reads an earlier clock, and `h + 1`
 * carries it past. An aborted call's advance is rolled back with it, so a place stays gapless. Under a transaction
 * snapshot, REPEATABLE READ or SERIALIZABLE, a row the snapshot cannot see raises 40001 (ExecCheckTupleVisible), so a
 * SERIALIZABLE call never stamps after a head it did not see. A unit's every write holds the unit's borrow exclusively
 * at its key before its first statement (README "Units"), so its head's lock is one no other call of the key could have
 * met: it adds no wait. Calls that stamp different keys lock different rows and wait on nothing of each other's. Its
 * rows are taken in key order, so two calls that stamp several keys of one head never wait on each other in a cycle.
 *
 * The function is SECURITY DEFINER, so its caller holds no privilege on the table, and PUBLIC holds no EXECUTE on it: a
 * role that may insert into a relation of the head's (a clock's of its scope, or its place's) holds EXECUTE on it
 * (physical/ddl/roles.ts). A place's relation admits a delete of whole groups alone, which deletes the head of each
 * group it removes in its own statement, so the next insert into the group stamps 0 again (write/insert/stamp.ts
 * placeReleases): a role that may delete from it holds SELECT and DELETE on the place's head's table, which lets it do
 * no more than its DELETE on the relation does, a gap in a group or a refusal at its key; no role holds any other
 * privilege on a head's table. No relation, law, judge, capture or publication names the table, and certification
 * reads the call as one that reads no relation's table (program/isolation/certification.ts).
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Identifier } from "#compiler/core/ids.ts"
import {
	type Clock,
	clocksUnder,
	type Head,
	headKey,
	headNameOf,
	headsOf,
	headText,
	type Instants
} from "#compiler/ir/instant.ts"
import type { LawField } from "#compiler/ir/law.ts"
import { fieldColumnType } from "#compiler/ir/physical.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { headIdentities, type InstallNames } from "#compiler/physical/ddl/names.ts"
import { enforcement, type Node } from "#compiler/physical/obligations/graph.ts"
import type {
	ColumnDef,
	CreateTable,
	Expr,
	FunctionName,
	FunctionParam,
	Insert,
	ObjectName,
	PlFunction,
	Revoke
} from "#compiler/sql/ast.ts"
import {
	asc,
	binary,
	call,
	col,
	core,
	cteRef,
	derived,
	distinctCore,
	functionNameOf,
	grouped,
	lit,
	namedType,
	operandSelect,
	operandUnionAll,
	provedSelect,
	select,
	table,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { assignments, ungenerated } from "#compiler/sql/generation.ts"
import { namedQuery } from "#compiler/sql/naming.ts"
import { installedTypes } from "#compiler/sql/type-schemas.ts"
import { headValue, stampClockParam, stampParams } from "#compiler/write/insert/stamp.ts"

/** A head's stamp function as a grant names it and orders after it: its object, and its name with its parameters'
 * types; and, for a place's head, its table, which a role that deletes from the place's relation deletes the heads of
 * the groups it removes from (write/insert/stamp.ts placeReleases). */
export interface StampFunction {
	readonly node: Node<"structure">
	readonly name: FunctionName
	readonly released: ObjectName | undefined
}

/** A function's argument as its body reads it, by name. */
const argument = (p: FunctionParam): Expr => ({ kind: "plVar", name: p.name })

/** The alias of the n-th relation a statement of the function names, as every function grizzle installs spells them. */
const alias = (n: number): string => `r${n}`

/** The n-th column a statement of the function names of a relation it makes: a child field's of its unnest, and each
 * column's of its advance's RETURNING. */
const childColumn = (at: number): string => `c${at + 1}`

/** Every head table's column of the transaction that stamped each key last (identity.headStamper). */
export const headStamper: Identifier<"headStamper"> = identifierOf(identity.headStamper())

/** The transaction that stamped a head's key last, by its 64-bit id, the top-level transaction's inside a savepoint
 * too (PostgreSQL 19, xid8funcs.c pg_current_xact_id, GetTopFullTransactionId). */
const thisTransaction: Expr = call("pg_current_xact_id", [])

/** A head's table: its key's columns, its value's, and its stamper's, keyed by its key. */
const headTable = (b: InstallBuilder, head: Head, name: ObjectName, key: string): CreateTable => {
	const column = (columnName: string, type: ScalarType): ColumnDef => {
		const typed = fieldColumnType(b.names, type)
		return { name: columnName, type: typed.type, collation: typed.collation, generated: undefined }
	}
	const value = headValue(head)
	return {
		kind: "createTable",
		table: name,
		columns: [
			...mapNonEmpty(headKey(head), (f) => column(f.column, f.type)),
			column(value.column, value.type),
			{ name: headStamper, type: types.xid8, collation: undefined, generated: undefined }
		],
		primaryKey: {
			kind: "primaryKey",
			name: key,
			columns: mapNonEmpty(headKey(head), (f) => ({ column: f.column, withoutOverlaps: false }))
		},
		secondary: []
	}
}

/** The head's columns in the table's order, its key's, its value's, then its stamper's. */
const headColumns = (head: Head): NonEmptyReadonlyArray<string> => [
	...mapNonEmpty(headKey(head), (f) => f.column),
	headValue(head).column,
	headStamper
]

/**
 * What a head's fill reads of one relation: the relation, its fields that hold the head's key, position for position
 * (ir/instant.ts headKey), and the field whose values the head counts on from: a clock of the head's scope, at the first
 * of its child, or the head's place, at its group.
 */
export interface HeadSource {
	readonly relation: string
	readonly key: NonEmptyReadonlyArray<LawField>
	readonly value: LawField
}

/** A clock as its scope's head's fill reads it (HeadSource). */
const clockSource = (clock: Clock): HeadSource => ({
	relation: clock.relation,
	key: mapNonEmpty(clock.head.key, (_, i) =>
		defined(clock.child[i], "a clock's child field at each field of its scope's key")
	),
	value: clock.field
})

/** What a head's fill reads (HeadSource): a scope's, every clock of it; a place's, its own relation. */
export const headSources = (instants: Instants, head: Head): ReadonlyArray<HeadSource> =>
	head.kind === "clock"
		? clocksUnder(instants, head).map(clockSource)
		: [{ relation: head.relation, key: head.child, value: head.field }]

/**
 * The fill of a head's table from the relations `sources` (HeadSource), which a migration runs as it creates the table
 * beside relations that may hold rows (deploy/diff/diff.ts): each key's greatest stored value among them, so its head
 * stands above every row they hold, stamped by the migration's transaction, which writes no row of a relation the head
 * counts on after it. A fresh installation's relations hold none, so its head's table starts empty.
 *
 *   INSERT INTO "<schema>"."<head>" ("<k1>", …, "<at>", "__stamper")
 *   SELECT "r1"."c1", …, max("r1"."c<n>"), pg_current_xact_id() FROM (SELECT "r2"."<k1>", …, "r2"."<at>"
 *     FROM <relation> AS "r2" UNION ALL …) AS "r1"("c1", …, "c<n>") GROUP BY "r1"."c1", …
 */
export const headFill = (
	names: InstallNames,
	head: Head,
	sources: NonEmptyReadonlyArray<HeadSource>
): Insert => {
	const [read, stored] = [alias(1), alias(2)]
	const named = mapNonEmpty([...headKey(head), headValue(head)], (_, i) => childColumn(i))
	const keys = named.slice(0, -1).map((c) => col(read, c))
	const last = defined(named[named.length - 1], "a head's value column")
	const arm = (source: HeadSource) => {
		const relation = names.relation(source.relation)
		return core(
			[...source.key, source.value].map((f) => target(col(stored, f.column))),
			[table(relation.schema, relation.name, stored)],
			undefined
		)
	}
	return {
		kind: "insert",
		with: undefined,
		table: names.head(headNameOf(head)),
		alias: undefined,
		onConflict: undefined,
		returning: [],
		columns: headColumns(head),
		source: {
			kind: "query",
			query: select(
				grouped(
					core(
						[
							...keys.map(target),
							targetAs(call("max", [col(read, last)]), headValue(head).column),
							targetAs(thisTransaction, headStamper)
						],
						[
							derived(
								namedQuery(operandSelect(operandUnionAll(mapNonEmpty(sources, arm))), named),
								read,
								false
							)
						],
						undefined
					),
					keys
				)
			)
		}
	}
}

/** The stamp function's one statement (see the module's header). */
const stampFunction = (
	head: Head,
	name: ObjectName,
	tableName: ObjectName,
	params: NonEmptyReadonlyArray<FunctionParam>
): PlFunction => {
	const [stamped, held, unnested] = [alias(1), alias(2), alias(3)]
	const columns = headColumns(head)
	const at = headValue(head).column
	const key = headKey(head)
	const [first] = params
	/** The first key array's element, and its place there, by which each other key array's is read. */
	const [element, position] = [childColumn(0), childColumn(1)]
	const children = mapNonEmpty(key, (_, i): Expr => {
		const array = defined(params[i], "a key field's array parameter")
		return i === 0
			? col(unnested, element)
			: { kind: "subscript", array: argument(array), index: col(unnested, position) }
	})
	const next = binary("+", col(held, at), lit.int(1, types.bigint))
	const fresh: Expr = ((): Expr => {
		switch (head.kind) {
			case "clock":
				return { kind: "plVar", name: stampClockParam }
			case "place":
				return lit.int(0, types.bigint)
		}
	})()
	const stepped: Expr = ((): Expr => {
		switch (head.kind) {
			case "clock":
				return { kind: "greatest", args: [{ kind: "excluded", column: at }, next] }
			case "place":
				return next
		}
	})()
	/** The head as it stands where the call's own transaction stamped it, one stamp per key a call, else stepped. */
	const advanced: Expr = {
		kind: "case",
		operand: undefined,
		whens: [{ when: binary("=", col(held, headStamper), thisTransaction), result: col(held, at) }],
		else: stepped
	}
	const advance: Insert = {
		kind: "insert",
		with: undefined,
		table: tableName,
		alias: held,
		onConflict: {
			kind: "columns",
			columns: mapNonEmpty(key, (f) => f.column),
			action: {
				kind: "doUpdate",
				set: assignments(ungenerated, held, [
					{ column: at, value: advanced },
					{ column: headStamper, value: thisTransaction }
				]),
				where: undefined
			}
		},
		returning: columns.map((c, i) => targetAs(col(held, c), childColumn(i))),
		columns,
		source: {
			kind: "query",
			query: {
				...select(
					distinctCore(
						[...mapNonEmpty(children, target), target(fresh), target(thisTransaction)],
						[
							{
								kind: "function",
								call: call("unnest", [argument(first)]),
								alias: unnested,
								columns: { kind: "named", names: [element, position], ordinality: true },
								lateral: false
							}
						],
						undefined
					)
				),
				orderBy: children.map(asc)
			}
		}
	}
	return {
		kind: "createFunction",
		language: "plpgsql",
		name,
		params,
		returns: {
			setOf: namedType(installedTypes(tableName.schema), tableName.name, []),
			rows: { kind: "planner" }
		},
		volatility: "VOLATILE",
		parallel: "UNSAFE",
		security: "DEFINER",
		body: {
			declare: [],
			body: [
				{
					kind: "returnQuery",
					query: {
						...provedSelect(
							"keyed",
							columns.map((_, i) => target(col(stamped, childColumn(i)))),
							[cteRef(stamped)],
							undefined
						),
						with: {
							recursive: false,
							ctes: [{ name: stamped, materialized: undefined, query: advance }]
						}
					}
				}
			]
		}
	}
}

/**
 * Every head's table and stamp function, each an object of its own, as every catalog object is (physical/obligations/created.ts):
 * the table after the tables of the relations it is filled from (headSources), in Structure, and the function after the
 * table, whose rows it returns, so PostgreSQL drops the function before the table; a migration creates, replaces and
 * drops them together, the table filled from its relations as it is created (deploy/diff/diff.ts). Each stamp function
 * by every relation its head stamps, a clock's of its scope or its place's, for the grants of the roles that insert into
 * it.
 */
export const addStamps = (b: InstallBuilder): ReadonlyMap<string, ReadonlyArray<StampFunction>> => {
	const out = new Map<string, Array<StampFunction>>()
	const instants = b.model.theory.instants
	const heads = headsOf(instants)
	if (heads.some((h) => h.kind === "clock")) {
		b.name(identity.headInstant())
	}
	if (heads.length > 0) {
		b.name(identity.headStamper())
	}
	for (const head of heads) {
		const named = headIdentities(headNameOf(head))
		b.name(named.table)
		b.name(named.stamp)
		const key = b.name(named.key)
		const tableName = b.names.head(headNameOf(head))
		const fnName = b.names.stamp(headNameOf(head))
		const params = stampParams(head, (f) => fieldColumnType(b.names, f.type).type)
		const fn = stampFunction(head, fnName, tableName, params)
		const relations = headSources(instants, head).map((s) => s.relation)
		const ident = (kind: "table" | "function", of: typeof named.table | typeof named.stamp) =>
			named.relation === undefined ? b.qualified(kind, of) : b.qualifiedOf(kind, named.relation, of)
		const level = named.relation === undefined ? b.schemaNode : b.levelNode(named.relation)
		const revokeTable: Revoke = {
			kind: "revoke",
			privileges: ["ALL"],
			on: { kind: "TABLE", names: [tableName] },
			from: [{ kind: "PUBLIC" }]
		}
		const revokeFunction: Revoke = {
			kind: "revoke",
			privileges: ["EXECUTE"],
			on: { kind: "FUNCTION", names: [functionNameOf(fn)] },
			from: [{ kind: "PUBLIC" }]
		}
		const headNode = b.add(
			{
				kind: "head",
				ident: ident("table", named.table),
				ddl: [headTable(b, head, tableName, key), revokeTable],
				reasons: [enforcement(`the head of ${headText(head)}`)],
				phase: "structure"
			},
			[level, ...relations.map((r) => b.table(r))]
		)
		const node = b.add(
			{
				kind: "headStamp",
				ident: ident("function", named.stamp),
				ddl: [fn, revokeFunction],
				reasons: [enforcement(`the stamp of ${headText(head)}`)],
				phase: "structure"
			},
			[level, headNode]
		)
		for (const relation of relations) {
			out
				.getOrInsertComputed(relation, () => [])
				.push({
					node,
					name: functionNameOf(fn),
					released: head.kind === "place" ? tableName : undefined
				})
		}
	}
	return out
}
