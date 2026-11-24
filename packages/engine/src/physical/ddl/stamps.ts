/**
 * Each head of the schema (ir/instant.ts Head), a clock or a place, as the installation stores it: a table of its
 * children's heads, one row a child, the last value stamped at it, and the function that stamps, which advances each
 * child's head and returns it. A write that stamps the head calls the function in the statement that stamps
 * (write/insert/stamp.ts), and nothing else writes or reads the table.
 *
 *   CREATE TABLE "<level>"."<head>" ("<c1>" <type 1> NOT NULL, …, "<at>" <type> NOT NULL,
 *     CONSTRAINT "<head key>" PRIMARY KEY ("<c1>", …))
 *   REVOKE ALL ON TABLE "<level>"."<head>" FROM PUBLIC
 *   CREATE OR REPLACE FUNCTION "<level>"."<stamp>"("__children_1" <type 1>[], …[, "__clock" bigint])
 *     RETURNS SETOF "<level>"."<head>" LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
 *     AS $$ BEGIN RETURN QUERY WITH "r1" AS (
 *       INSERT INTO "<level>"."<head>" AS "r2" ("<c1>", …, "<at>")
 *       SELECT DISTINCT "r3"."c1", "__children_2"["r3"."c2"], …, <"__clock" | 0>
 *       FROM unnest("__children_1") WITH ORDINALITY AS "r3"("c1", "c2") ORDER BY "r3"."c1", "__children_2"["r3"."c2"], …
 *       ON CONFLICT ("<c1>", …) DO UPDATE SET "<at>" = CASE WHEN "r2"."xmin" = xid(pg_current_xact_id()) THEN "r2"."<at>"
 *         ELSE <greatest(EXCLUDED."<at>", "r2"."<at>" + 1) | "r2"."<at>" + 1> END
 *       RETURNING "r2"."<c1>" AS "c1", …, "r2"."<at>" AS "c<n>")
 *     SELECT "r1"."c1", …, "r1"."c<n>" FROM "r1"; END $$
 *   REVOKE EXECUTE ON FUNCTION "<level>"."<stamp>"(…) FROM PUBLIC
 *
 * The table's columns are the relation's child and head columns, by their names and types. A migration that creates
 * the table beside a relation that may hold rows, a clock or a place added to stored rows, a key or a type changed, the
 * format upgraded, fills it (`headFill`): each child's head the greatest value the relation holds at it, so it starts
 * above every stored row; a fresh installation's relation holds none. From then on the stamp function is the head's
 * only writer: a clock is only ever
 * stamped (`clockStated`), a put of a relation with a clock is refused, and a place's relation admits no put and a
 * delete of whole groups alone, which deletes their heads (write/frontend/instants.ts), so every value the relation
 * holds at a child is at most its head. A clock's deleted row leaves the head where it was, and a later stamp is above
 * it too.
 *
 * A call stamps each child once: a head its own transaction already wrote, its row's xmin the call's transaction id,
 * stands as it is, so every statement part that stamps the head at a child in one call, a clock's own rows and its
 * references' alike, each calling the function, takes the one instant (write/insert/stamp.ts).
 *
 * Why a child's stamps follow its calls' commits, at every level (README "Instants"): the function's INSERT ... ON
 * CONFLICT DO UPDATE either inserts the child's row or locks the row it meets and assigns from that row's latest
 * committed version, waiting for a writer of it still in progress, whatever the calling statement's snapshot holds
 * (PostgreSQL 19, src/backend/executor/nodeModifyTable.c ExecOnConflictUpdate, heap_lock_tuple, the conflicting row
 * read with SnapshotAny); and it keeps that lock until its transaction ends, so two calls that stamp one child take
 * turns: the later one's stamp is the earlier one's plus the least step at least, and it commits after the earlier one
 * ended. An aborted call's advance is rolled back with it, so a place stays gapless. Under a transaction snapshot,
 * REPEATABLE READ or SERIALIZABLE, a row the snapshot cannot see raises 40001 (ExecCheckTupleVisible), so a
 * SERIALIZABLE call never stamps after a head it did not see. Calls that stamp different children lock different rows
 * and wait on nothing of each other's. Its rows are taken in key order, so two calls that stamp several children of one
 * head never wait on each other in a cycle.
 *
 * The function is SECURITY DEFINER, so its caller holds no privilege on the table, and PUBLIC holds no EXECUTE on it: a
 * role that may insert into the head's relation holds EXECUTE on it (physical/ddl/roles.ts). A place's relation admits a
 * delete of whole groups alone, which deletes the head of each group it removes in its own statement, so the next
 * insert into the group stamps 0 again (write/insert/stamp.ts placeReleases): a role that may delete from it holds
 * SELECT and DELETE on the place's head's table, which lets it do no more than its DELETE on the relation does, a gap in
 * a group or a refusal at its key; no role holds any other privilege on a head's table. No relation, law, judge, capture or publication names the table, and certification reads the
 * call as one that reads no relation's table (program/isolation/certification.ts).
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { identity } from "#compiler/core/identity.ts"
import { type Head, headsOf, headText } from "#compiler/ir/instant.ts"
import type { LawField } from "#compiler/ir/law.ts"
import { fieldColumnType } from "#compiler/ir/physical.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import type { InstallNames } from "#compiler/physical/ddl/names.ts"
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
	distinctCore,
	functionNameOf,
	grouped,
	lit,
	namedType,
	provedSelect,
	select,
	table,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { assignments, ungenerated } from "#compiler/sql/generation.ts"
import { installationTypes } from "#compiler/sql/type-schemas.ts"
import { stampClockParam, stampParams } from "#compiler/write/insert/stamp.ts"

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

/** A head's table: its child's columns and its head's, each the relation's own by name and type, keyed by the child. */
const headTable = (b: InstallBuilder, head: Head, name: ObjectName, key: string): CreateTable => {
	const column = (field: LawField): ColumnDef => {
		const { type, collation } = fieldColumnType(b.names, field.type)
		return {
			name: b.names.column(head.relation, field.name),
			type,
			collation,
			generated: undefined
		}
	}
	return {
		kind: "createTable",
		table: name,
		columns: [...mapNonEmpty(head.child, column), column(head.field)],
		primaryKey: {
			kind: "primaryKey",
			name: key,
			columns: mapNonEmpty(head.child, (f) => ({
				column: b.names.column(head.relation, f.name),
				withoutOverlaps: false
			}))
		},
		secondary: []
	}
}

/** The head's columns in the table's order, its child's then its own. */
const headColumns = (names: InstallNames, head: Head): NonEmptyReadonlyArray<string> => [
	...mapNonEmpty(head.child, (f) => names.column(head.relation, f.name)),
	names.column(head.relation, head.field.name)
]

/**
 * The fill of a head's table, which a migration runs as it creates the table beside a relation that may hold rows
 * (deploy/diff/diff.ts): each child's greatest stored value of the head's field, so its head starts above every row
 * the relation holds. A fresh installation's relation holds none, so its head's table starts empty.
 */
export const headFill = (names: InstallNames, head: Head): Insert => {
	const relation = names.relation(head.relation)
	const stored = alias(1)
	const children = head.child.map((f) => col(stored, names.column(head.relation, f.name)))
	return {
		kind: "insert",
		with: undefined,
		table: names.head(head.relation, head.field.name),
		alias: undefined,
		onConflict: undefined,
		returning: [],
		columns: headColumns(names, head),
		source: {
			kind: "query",
			query: select(
				grouped(
					core(
						[
							...children.map(target),
							target(call("max", [col(stored, names.column(head.relation, head.field.name))]))
						],
						[table(relation.schema, relation.name, stored)],
						undefined
					),
					children
				)
			)
		}
	}
}

/** The stamp function's one statement (see the module's header). */
const stampFunction = (
	b: InstallBuilder,
	head: Head,
	name: ObjectName,
	tableName: ObjectName,
	params: NonEmptyReadonlyArray<FunctionParam>
): PlFunction => {
	const [stamped, held, unnested] = [alias(1), alias(2), alias(3)]
	const columns = headColumns(b.names, head)
	const at = b.names.column(head.relation, head.field.name)
	const [first] = params
	/** The first child array's element, and its place there, by which each other child array's is read. */
	const [element, position] = [childColumn(0), childColumn(1)]
	const children = mapNonEmpty(head.child, (_, i): Expr => {
		const array = defined(params[i], "a child's array parameter")
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
	/** The head as it stands where the call's own transaction wrote it, one stamp per child a call, else stepped. */
	const advanced: Expr = {
		kind: "case",
		operand: undefined,
		whens: [
			{
				when: binary("=", col(held, "xmin"), call("xid", [call("pg_current_xact_id", [])])),
				result: col(held, at)
			}
		],
		else: stepped
	}
	const advance: Insert = {
		kind: "insert",
		with: undefined,
		table: tableName,
		alias: held,
		onConflict: {
			kind: "columns",
			columns: mapNonEmpty(head.child, (f) => b.names.column(head.relation, f.name)),
			action: {
				kind: "doUpdate",
				set: assignments(ungenerated, held, [{ column: at, value: advanced }]),
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
						[...mapNonEmpty(children, target), target(fresh)],
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
			setOf: namedType(installationTypes(b.names.levelOf(head.relation)), tableName.name, []),
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
 * the table after the head's relation's table, in Structure, and the function after the table, whose rows it returns,
 * so PostgreSQL drops the function before the table; a migration creates, replaces and drops them together, the table
 * filled from its relation as it is created (deploy/diff/diff.ts). Each stamp function by the head's relation, every
 * head over it, for the grants of the roles that insert into it.
 */
export const addStamps = (b: InstallBuilder): ReadonlyMap<string, ReadonlyArray<StampFunction>> => {
	const out = new Map<string, Array<StampFunction>>()
	for (const head of headsOf(b.model.theory.instants)) {
		const tableNamed = identity.head(head.relation, head.field.name)
		b.name(tableNamed)
		const stampNamed = identity.stamp(head.relation, head.field.name)
		b.name(stampNamed)
		const tableName = b.names.head(head.relation, head.field.name)
		const fnName = b.names.stamp(head.relation, head.field.name)
		const key = b.name(identity.headKey(head.relation, head.field.name))
		const params = stampParams(head, (f) => fieldColumnType(b.names, f.type).type)
		const fn = stampFunction(b, head, fnName, tableName, params)
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
				ident: b.qualifiedOf("table", head.relation, tableNamed),
				ddl: [headTable(b, head, tableName, key), revokeTable],
				reasons: [enforcement(`the head of ${headText(head)}`)],
				phase: "structure"
			},
			[b.levelNode(head.relation), b.table(head.relation)]
		)
		const node = b.add(
			{
				kind: "headStamp",
				ident: b.qualifiedOf("function", head.relation, stampNamed),
				ddl: [fn, revokeFunction],
				reasons: [enforcement(`the stamp of ${headText(head)}`)],
				phase: "structure"
			},
			[b.levelNode(head.relation), headNode]
		)
		out
			.getOrInsertComputed(head.relation, () => [])
			.push({
				node,
				name: functionNameOf(fn),
				released: head.kind === "place" ? tableName : undefined
			})
	}
	return out
}
