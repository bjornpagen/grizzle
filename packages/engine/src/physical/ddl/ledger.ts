/**
 * What every installation knows of the migrations ledger: its table's name and its folder rows' ordinal, which the
 * snapshot guard reads, and the guard itself. The ledger's own statements and its state are the deploy layer's
 * (deploy/ledger/ledger.ts), which reads these.
 */
import { sha256Octets } from "#compiler/core/digest.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { type Sqlstate, sqlstates } from "#compiler/core/sqlstate.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import type {
	CreateDomain,
	Expr,
	FunctionName,
	PlFunction,
	PlStatement,
	Revoke
} from "#compiler/sql/ast.ts"

import {
	and,
	call,
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

/**
 * The drift check's proofs' table, beside the ledger in the installed schema, which the naming door names
 * (identity.proofs): no Db reads it, so no fence or guard names it (deploy/ledger/ledger.ts proofsTable).
 */
export const proofsTableName: string = identifierOf(identity.proofs())

/**
 * The encoding a digest of the ledger and the proofs travels in between the shell and its bytea column: lowercase hex,
 * the spelling every fingerprint and file digest the shell holds is in (snapshot.json, meta.json; core/sha256.ts
 * sha256Hex), rendered at this boundary from the 32 bytes the column stores.
 *
 * @formatConstant PostgreSQL 19's encode and decode format name for hexadecimal
 */
const hexEncoding = "hex"

/**
 * The installation's digest domain in `schema` (core/identity.ts digestDomain): every SHA-256 digest column's type, a
 * bytea whose CHECK holds its length, 32 bytes. An installation's Setup creates it among its domains
 * (physical/ddl/context.ts), before the ledger and the proofs, whose digest columns it types; a fence of the ledger
 * alone creates it so too (test/support/flight/model.ts fenceSql).
 */
export const digestDomainDdl = (schema: string): CreateDomain => {
	const named = identity.digestDomain()
	return {
		kind: "createDomain",
		name: { schema, name: identifierOf(named) },
		base: types.bytea,
		collation: undefined,
		constraints: [
			{
				name: identifierOf(identity.domainCheck(named)),
				predicate: eq(
					call("octet_length", [{ kind: "domainValue" }]),
					lit.int(sha256Octets, types.integer)
				)
			}
		]
	}
}

/** The bytes a digest's hex spells, `decode(<hex>, 'hex')`: how a fingerprint or a file's digest enters its column. */
export const digestOfHex = (hex: Expr): Expr =>
	call("decode", [hex, lit.text(hexEncoding, types.text)])

/** A digest column's bytes as their hex, `encode(<digest>, 'hex')`: how a rows statement reads one back. */
export const hexOfDigest = (digest: Expr): Expr =>
	call("encode", [digest, lit.text(hexEncoding, types.text)])

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

/**
 * The library PostgreSQL 19 plans every statement grizzle sends by: contrib's planner module, which enforces the advice
 * in force where a statement is planned or replanned (pg_plan_advice.advice), by the name its module magic gives it.
 * Every session grizzle serves loads it (README "Install"), by shared_preload_libraries or by the database's
 * session_preload_libraries; without it PostgreSQL plans every statement by its own costs.
 *
 * @formatConstant pg_plan_advice's module name, PG_MODULE_MAGIC_EXT(.name = "pg_plan_advice")
 *   (https://github.com/postgres/postgres/blob/REL_19_0/contrib/pg_plan_advice/pg_plan_advice.c#L31)
 */
export const planAdviceModule = "pg_plan_advice"

/**
 * The columns of pg_get_loaded_modules' rows, as pg_proc names its OUT parameters: each loaded file's module name, its
 * version and its file's name.
 *
 * @formatConstant pg_get_loaded_modules' proargnames, {module_name,version,file_name}
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/include/catalog/pg_proc.dat#L6885)
 */
export const loadedModuleColumns = ["module_name", "version", "file_name"] as const

/**
 * Whether the session's backend loaded pg_plan_advice, by the modules it loaded, under `alias`, its columns the
 * generated names of loadedModuleColumns', c1 the module's name:
 *
 *   EXISTS (SELECT 1 FROM pg_catalog.pg_get_loaded_modules() AS <alias>(c1, c2, c3) WHERE <alias>.c1 = 'pg_plan_advice')
 *
 * pg_get_loaded_modules reads the backend's own list of the files it loaded, those shared_preload_libraries and
 * session_preload_libraries name among them, and every role may call it. No setting proves the library loaded: without
 * it PostgreSQL keeps a pg_plan_advice setting as a placeholder, so a database or role that sets one reads it back
 * whatever its sessions loaded and plans by none of it.
 */
export const adviceLoaded = (alias: string): Expr =>
	exists(
		simpleSelect(
			[one],
			[
				{
					kind: "function",
					call: call("pg_get_loaded_modules", []),
					alias,
					columns: {
						kind: "named",
						names: loadedModuleColumns.map((_, at) => `c${at + 1}`),
						ordinality: false
					},
					lateral: false
				}
			],
			eq(col(alias, "c1"), lit.text(planAdviceModule, types.text))
		)
	)

/** What the snapshot guard's first refusal says (adviceLoaded): the library and the two ways a database loads it. */
const adviceUnloadedMessage =
	"pg_plan_advice is not loaded in this session: a superuser loads it for the database (ALTER DATABASE ... SET session_preload_libraries = 'pg_plan_advice') or for the server (shared_preload_libraries = 'pg_plan_advice')"

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
 * The guard, `"<schema>".__require_snapshot(fingerprint text) RETURNS void`, reads the session's libraries and the
 * ledger as its owner and refuses:
 *
 *   IF NOT EXISTS (pg_plan_advice among the backend's loaded modules) THEN
 *     RAISE EXCEPTION ... USING ERRCODE = '55Z04';   -- the session plans by no advice (adviceLoaded)
 *   END IF;
 *   IF EXISTS (a folder row whose file count is not the number of its folder's file rows) THEN
 *     RAISE EXCEPTION ... USING ERRCODE = '55Z02';   -- a migration running or stopped part-way
 *   END IF;
 *   IF NOT EXISTS (a folder row whose target is decode(fingerprint, 'hex'), with no folder row after it by name) THEN
 *     RAISE EXCEPTION ... USING ERRCODE = '55Z01';   -- the latest complete target is another
 *   END IF;
 *
 * It is the rule of `ledgerState`, the apply runner's and the drift check's: no folder partial, and the latest folder's
 * target the Db's fingerprint. Folders sort by name in pg_c_utf8, by code point as compareCodePoints does. Admission
 * (`guard`) and every Db transaction (`enter`) call this one function behind the one fence, so they cannot disagree.
 * The library comes first: a transaction of a session that did not load it runs nothing, and its every statement would
 * be planned, and replanned, by PostgreSQL's costs alone.
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
				eq(col("r3", "target"), digestOfHex(fingerprint)),
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
			advice: noAdvice,
			language: "plpgsql",
			name: { schema, name: snapshotGuardName },
			params: [{ name: "fingerprint", type: types.text }],
			returns: "void",
			volatility: "VOLATILE",
			parallel: "UNSAFE",
			security: "DEFINER",
			body: {
				declare: [],
				body: [
					refuseWhen(
						not(adviceLoaded("r5")),
						raiseAs(adviceUnloadedMessage, sqlstates.grizzleAdviceUnloaded)
					),
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
