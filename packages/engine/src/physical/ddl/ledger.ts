/**
 * What every installation knows of the migrations ledger: its table's name and its folder rows' ordinal, which the
 * snapshot guard reads, and the guard itself. The ledger's own statements and its state are the deploy layer's
 * (deploy/ledger/ledger.ts), which reads these.
 */
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { type Sqlstate, sqlstates } from "#compiler/core/sqlstate.ts"
import type { Expr, FunctionName, PlFunction, PlStatement, Revoke } from "#compiler/sql/ast.ts"

import {
	and,
	col,
	countStar,
	eq,
	exists,
	gt,
	lit,
	ne,
	not,
	notExists,
	simpleSelect,
	table,
	target,
	types
} from "#compiler/sql/build.ts"

/** The migrations ledger's table, which the naming door names (identity.ledger). */
export const ledgerTableName: string = identifierOf(identity.ledger())

/** The ordinal of a folder's row: the one row of its folder that records its source, target and file count. */
export const folderOrdinal = 0

/** The snapshot guard's name, a function of the installed schema beside the ledger it reads, named by the door. */
export const snapshotGuardName: string = identifierOf(identity.snapshotGuard())

/** The guard of `schema`, by its signature: one text, the fingerprint of the snapshot a Db was admitted at. */
export const snapshotGuardFunction = (schema: string): FunctionName => ({
	schema,
	name: snapshotGuardName,
	args: [types.text]
})

/** `"<alias>"."ordinal" = 0`: the folder row of its folder. */
const folderRowOf = (alias: string): Expr =>
	eq(col(alias, "ordinal"), lit.int(BigInt(folderOrdinal), types.integer))

const one = target(lit.int(1n, types.integer))

const raiseAs = (message: string, state: Sqlstate): PlStatement => ({
	kind: "raise",
	message,
	using: [{ option: "ERRCODE", value: lit.text(state, types.text) }]
})

/** IF <condition> THEN <raise> END IF. */
const refuseWhen = (condition: Expr, raise: PlStatement): PlStatement => ({
	kind: "if",
	branches: [{ condition, body: [raise] }],
	else: []
})

/**
 * The snapshot guard's DDL: its CREATE FUNCTION, then the REVOKE EXECUTE ... FROM PUBLIC that follows it at once, as the
 * refusal function's. Every login holds EXECUTE on it (physical/ddl/roles.ts), and no role does.
 *
 * The fence. A Db never runs against a catalog but its snapshot's, mid-migration and at a migration's completion
 * included, in its call's one round trip and with no wait of the application's:
 *
 * - every transaction of a Db, right after BEGIN and before anything takes its snapshot, takes the ledger's ACCESS SHARE
 *   lock NOWAIT, as the login (`fence`): LOCK takes no snapshot, so it runs first, and it is refused at once (55P03)
 *   while a migration holds the ledger's ACCESS EXCLUSIVE lock or waits for it;
 * - its next statement (`enter`), the first that takes the transaction's snapshot, calls this guard, still as the login,
 *   then enters the role and sets the claims;
 * - each transaction of a migration takes the ledger's ACCESS EXCLUSIVE lock before any statement of its file
 *   (`exclusive`), which waits for the Db transactions in flight: the operator's command waits, never the application.
 *   A no-transaction file's folder is recorded unfinished, under that lock, before its first statement runs.
 *
 * The guard, `"<schema>".__require_snapshot(fingerprint text) RETURNS void`, reads the ledger as its owner and refuses:
 *
 *   IF EXISTS (a folder row whose file count is not the number of its folder's file rows) THEN
 *     RAISE EXCEPTION ... USING ERRCODE = '55Z02';   -- a migration running or stopped part-way
 *   END IF;
 *   IF NOT EXISTS (a folder row whose target is fingerprint, with no folder row after it by name) THEN
 *     RAISE EXCEPTION ... USING ERRCODE = '55Z01';   -- the latest complete target is another
 *   END IF;
 *
 * It is the rule of `ledgerState`, the apply runner's and the drift check's: no folder partial, and the latest folder's
 * target the Db's fingerprint. Folders sort by name in pg_c_utf8, by code point as compareCodePoints does. Admission
 * (`guard`) and every Db transaction (`enter`) call this one function behind the one fence, so they cannot disagree.
 */
export const snapshotGuardDdl = (schema: string): readonly [PlFunction, Revoke] => {
	const fn = snapshotGuardFunction(schema)
	const ledger = (alias: string) => table(schema, ledgerTableName, alias)
	const fingerprint: Expr = { kind: "plVar", name: "fingerprint" }
	const fileRows = (folder: string, alias: string): Expr => ({
		kind: "subquery",
		query: simpleSelect(
			[target(countStar())],
			[ledger(alias)],
			and([
				eq(col(alias, "folder"), col(folder, "folder")),
				ne(col(alias, "ordinal"), lit.int(BigInt(folderOrdinal), types.integer))
			])
		)
	})
	const unfinished = exists(
		simpleSelect(
			[one],
			[ledger("r1")],
			and([folderRowOf("r1"), ne(col("r1", "files"), fileRows("r1", "r2"))])
		)
	)
	const current = exists(
		simpleSelect(
			[one],
			[ledger("r3")],
			and([
				folderRowOf("r3"),
				eq(col("r3", "target"), fingerprint),
				notExists(
					simpleSelect(
						[one],
						[ledger("r4")],
						and([folderRowOf("r4"), gt(col("r4", "folder"), col("r3", "folder"))])
					)
				)
			])
		)
	)
	return [
		{
			kind: "createFunction",
			language: "plpgsql",
			name: { schema, name: snapshotGuardName },
			params: [{ name: "fingerprint", type: types.text }],
			returns: "void",
			volatility: "VOLATILE",
			parallel: "UNSAFE",
			security: "DEFINER",
			planCacheMode: "force_custom_plan",
			body: {
				declare: [],
				body: [
					refuseWhen(
						unfinished,
						raiseAs(
							"a grizzle migration of this schema is running or stopped part-way",
							sqlstates.grizzleMigrating
						)
					),
					refuseWhen(
						not(current),
						raiseAs(
							"the latest grizzle migration of this schema is not the snapshot of this Db",
							sqlstates.grizzleMigrated
						)
					)
				]
			}
		},
		{
			kind: "revoke",
			privileges: ["EXECUTE"],
			on: { kind: "FUNCTION", names: [fn] },
			from: [{ kind: "PUBLIC" }]
		}
	]
}
