import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import {
	enforcement,
	innerIdent,
	type Node,
	qualifiedIdent
} from "#compiler/physical/obligations/graph.ts"
import type {
	AlterDatabaseDefault,
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

/** The database defaults the installation sets, each the fact a check of the database compares. */
export const databaseDefaults: ReadonlyArray<AlterDatabaseDefault> = [
	{
		kind: "alterDatabaseDefault",
		parameter: "default_transaction_isolation",
		value: "serializable"
	}
]

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
			language: "plpgsql",
			name,
			params: [],
			returns: "trigger",
			volatility: "VOLATILE",
			parallel: "UNSAFE",
			security: "DEFINER",
			planCacheMode: "force_custom_plan",
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

/** The manifest identity of a database default. */
const databaseDefaultIdent = (d: AlterDatabaseDefault): string => `databaseDefault:${d.parameter}`

/** The database defaults and the guard function, in Setup: neither names a type or a table.
 *
 * Every transaction runs at SERIALIZABLE. Three installed facts make it so, and every other module relies on it:
 *
 * - the database default: default_transaction_isolation = serializable on the installation's database
 *   (`databaseDefaults`), so a session of any role that names no level runs
 *   SERIALIZABLE. Setting it needs the database's owner, so an installation by any other role fails with 42501;
 * - the guard function, one per installation:
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
 *   FOR EACH STATEMENT, so a session or role that sets a lower level is refused with 25000, naming the table, before
 *   the statement writes a row. Its name is one fixed name, which PostgreSQL scopes to its table, so a renamed table
 *   carries it unchanged.
 *
 * With every writer SERIALIZABLE, PostgreSQL's SSI orders every write and every law function's reads: a transaction
 * that would commit in no serial order with a concurrent one fails with 40001, a TransientFailure the caller may run
 * again. */
export const addIsolation = (b: InstallBuilder): Node<"setup"> => {
	for (const d of databaseDefaults) {
		b.add(
			{
				kind: "databaseDefault",
				ident: { kind: "text", text: databaseDefaultIdent(d) },
				ddl: [d],
				reasons: [enforcement(`the database default ${d.parameter} of schema ${b.owned.name}`)],
				phase: "setup"
			},
			[]
		)
	}
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

/** The guard trigger of the table of `relation`, `table`, which addTables has just added. The ledger's,
 * the one table no relation declares, is the snapshot's. */
export const addIsolationTrigger = (
	b: InstallBuilder,
	relation: string,
	table: Node<"structure">
): void => {
	b.add(
		{
			kind: "isolationTrigger",
			ident: {
				kind: "trigger",
				schema: b.settings.installation,
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
