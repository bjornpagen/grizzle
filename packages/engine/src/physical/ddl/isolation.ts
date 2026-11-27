import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import {
	enforcement,
	innerIdent,
	type Node,
	qualifiedIdent
} from "#compiler/physical/obligations/graph.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import type {
	CreateGuardTrigger,
	Expr,
	ObjectName,
	PlFunction,
	PlStatement,
	Revoke
} from "#compiler/sql/ast.ts"
import { call, lit, ne, objectName, types } from "#compiler/sql/build.ts"

/** The name of the guard function. */
export const isolationGuardName: string = identifierOf(identity.isolationGuard())
/** The name of every table's guard trigger. */
const isolationTriggerName: string = identifierOf(identity.isolationTrigger())

/** The installed guard function of a schema. */
const isolationFunction = (schema: string): ObjectName => objectName(schema, isolationGuardName)

const tgSpecial = (name: "TG_TABLE_SCHEMA" | "TG_TABLE_NAME"): Expr => ({ kind: "plSpecial", name })

const refuseBelowSerializable: PlStatement = {
	kind: "if",
	branches: [
		{
			condition: ne(
				call("current_setting", [lit.text("transaction_isolation", types.text)]),
				lit.text("serializable", types.text)
			),
			body: [
				{
					kind: "raise",
					message: "a write to a grizzle table requires SERIALIZABLE",
					using: [
						{ option: "ERRCODE", value: lit.text("invalid_transaction_state", types.text) },
						{ option: "SCHEMA", value: tgSpecial("TG_TABLE_SCHEMA") },
						{ option: "TABLE", value: tgSpecial("TG_TABLE_NAME") },
						{ option: "HINT", value: lit.text("write at SERIALIZABLE", types.text) }
					]
				}
			]
		}
	],
	else: []
}

/** The guard function's DDL: its CREATE FUNCTION, then the REVOKE EXECUTE ... FROM PUBLIC that follows it at once, as
 * the refusal function's. It reads no table, so the header every installed function has confers
 * nothing. */
const isolationFunctionDdl = (schema: string): readonly [PlFunction, Revoke] => {
	const name = isolationFunction(schema)
	return [
		{
			kind: "createFunction",
			advice: noAdvice,
			language: "plpgsql",
			name,
			params: [],
			returns: "trigger",
			volatility: "VOLATILE",
			parallel: "UNSAFE",
			security: "DEFINER",
			body: {
				declare: [],
				body: [
					refuseBelowSerializable,
					{ kind: "return", value: { kind: "plSpecial", name: "NEW" } }
				]
			}
		},
		{
			kind: "revoke",
			privileges: ["EXECUTE"],
			on: { kind: "FUNCTION", names: [{ ...name, args: [] }] },
			from: [{ kind: "PUBLIC" }]
		}
	]
}

/** The manifest identity of the guard function of `schema`. */
export const isolationFunctionIdent = (schema: string): string =>
	qualifiedIdent("function", schema, isolationGuardName)

/**
 * The guard function, in Setup: it names no type or table.
 *
 * Every transaction grizzle opens states its level, and every write of a grizzle table runs SERIALIZABLE but a write of
 * a role that certification runs READ COMMITTED (core/isolation.ts), whose BEGIN states its level. No installed default
 * makes it so, and no session grizzle does not open relies on one: the installation sets no database default, so a
 * foreign session, psql or a monitoring tool, starts at the server's default, READ COMMITTED unless its operator chose
 * otherwise, and counts among no SERIALIZABLE transaction of the cluster unless it says SERIALIZABLE itself (such a
 * transaction makes every SERIALIZABLE READ ONLY read on the cluster take predicate locks: predicate.c counts
 * SERIALIZABLE read-write transactions cluster-wide). What makes it so:
 *
 * - Every BEGIN grizzle sends names its level: a served read's SERIALIZABLE READ ONLY, a served write's at its role's,
 *   and a migration file's transaction SERIALIZABLE (the shell's adapter/migrate/session.ts
 *   fileTransaction), the ledger's records in a migration's transaction, the drift check's SERIALIZABLE and rolled
 *   back, and the live leader's fanout READ COMMITTED; `grizzle check` opens those same sessions.
 *   A statement grizzle sends outside a BEGIN runs on an owner's session, the migration identity's (a survey or catalog
 *   read, a catalog's DDL, a `-- grizzle: no-transaction` file's statements), whose startup options state SERIALIZABLE
 *   as its default (the shell's adapter/wire/session.ts, owner startup), so each still runs SERIALIZABLE by grizzle's
 *   own statement; a login's session sends no write outside a BEGIN.
 * - The guard function, one per installation:
 *
 *     CREATE OR REPLACE FUNCTION <schema>.<guard>() RETURNS trigger ... AS $$
 *     BEGIN
 *       IF current_setting('transaction_isolation') <> 'serializable' THEN
 *         RAISE EXCEPTION 'a write to a grizzle table requires SERIALIZABLE'
 *           USING ERRCODE = 'invalid_transaction_state', SCHEMA = TG_TABLE_SCHEMA, TABLE = TG_TABLE_NAME,
 *           HINT = 'write at SERIALIZABLE';
 *       END IF;
 *       RETURN NEW;
 *     END $$;
 *
 *   A statement trigger's return value is ignored, and NEW is NULL in one;
 * - the guard trigger, one per table, the migrations ledger's included, BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
 *   FOR EACH STATEMENT, so a session or role at a lower level is refused with 25000, naming the table, before the
 *   statement writes a row. Its name is one fixed name, which PostgreSQL scopes to its table, so a renamed table carries
 *   it unchanged. A table every writer of which certification runs READ COMMITTED takes none (`readCommittedRelations`):
 *   the installation holds no guard object for it, so no statement branches on a level.
 *
 * The guard alone keeps a direct SQL writer inside the certified model, whatever any default says: a guarded table is
 * one some role that runs SERIALIZABLE writes, every role with no change member among them (certify.ts `members`), and
 * its guard refuses every write of it below SERIALIZABLE, so a direct writer of it either says SERIALIZABLE, and SSI
 * tracks it as it tracks every SERIALIZABLE role, or is refused. A table with no guard has only writers certified READ
 * COMMITTED that hold INSERT and SELECT alone; a direct insert of it through one of their grants falls outside the
 * certification at any level, since SSI never tracks the READ COMMITTED members beside it.
 *
 * With every writer of a guarded table SERIALIZABLE, PostgreSQL's SSI orders every write and every law function's reads
 * there: a transaction that would commit in no serial order with a concurrent one fails with 40001, a TransientFailure
 * the caller may run again. */
export const addIsolation = (b: InstallBuilder): Node<"setup"> => {
	b.name(identity.isolationGuard())
	b.name(identity.isolationTrigger())
	return b.add(
		{
			kind: "isolationFunction",
			ident: b.qualified("function", identity.isolationGuard()),
			ddl: isolationFunctionDdl(b.schema),
			reasons: [enforcement(`the SERIALIZABLE writes of schema ${b.owned.name}`)],
			phase: "setup"
		},
		[b.schemaNode]
	)
}

/** The guard trigger of `table` in `schema`: its manifest identity and its one statement. */
export const isolationTrigger = (
	schema: string,
	table: ObjectName
): { readonly ident: string; readonly ddl: readonly [CreateGuardTrigger] } => ({
	ident: innerIdent("trigger", schema, table.name, isolationTriggerName),
	ddl: [
		{
			kind: "createGuardTrigger",
			name: isolationTriggerName,
			table,
			function: isolationFunction(schema)
		}
	]
})

/**
 * The relations whose tables take no guard trigger, of `roles`, each role's level (Installation.certification) with the
 * table privileges it holds by relation (physical/ddl/roles.ts grantedPrivileges): each relation some role writes,
 * holding INSERT, UPDATE or DELETE on it, every such role READ COMMITTED and holding only INSERT and SELECT there. Its
 * every writer is held by its grants to inserts, and certification proved that each runs correctly at READ COMMITTED.
 * A relation no role writes keeps its guard, as does one a SERIALIZABLE role writes: certification is a claim the
 * installation is handed, so a table is guarded unless every claim about it is.
 */
export const readCommittedRelations = (
	roles: ReadonlyArray<{
		readonly level: Isolation
		readonly privileges: ReadonlyMap<string, ReadonlySet<TablePrivilege>>
	}>
): ReadonlySet<string> => {
	const relaxed = new Map<string, boolean>()
	for (const role of roles) {
		for (const [relation, held] of role.privileges) {
			if (held.has("INSERT") || held.has("UPDATE") || held.has("DELETE")) {
				const inserts = role.level === "readCommitted" && !held.has("UPDATE") && !held.has("DELETE")
				relaxed.set(relation, (relaxed.get(relation) ?? true) && inserts)
			}
		}
	}
	return new Set([...relaxed].flatMap(([relation, r]) => (r ? [relation] : [])))
}

/** The guard trigger of the table of `relation`, `table`, which addTables has just added, unless certification runs its
 * every writer READ COMMITTED (`readCommittedRelations`). The ledger's, the one table no relation declares, is the
 * snapshot's. */
export const addIsolationTrigger = (
	b: InstallBuilder,
	relation: string,
	table: Node<"structure">
): void => {
	if (b.readCommitted.has(relation)) {
		return
	}
	b.add(
		{
			kind: "isolationTrigger",
			ident: {
				kind: "trigger",
				schema: b.names.levelOf(relation),
				relation: b.names.relationNamed(relation),
				name: identity.isolationTrigger()
			},
			ddl: isolationTrigger(b.schema, b.names.relation(relation)).ddl,
			reasons: [enforcement(`the SERIALIZABLE writes of relation ${relation}`)],
			phase: "structure"
		},
		[table, b.isolation]
	)
}
