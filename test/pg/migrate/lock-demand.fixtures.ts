/** What the properties of lock-demand.test.ts read: the probing session, the lock names and the drafted paths. */

import { Array as Arr, Effect, Option, String as Str } from "effect"
import { migrationSession, type MigrationSession } from "#adapter/migrate/session.ts"
import {
	type BatchStatement,
	oneShotStatement,
	runTransaction,
	type Transaction
} from "#adapter/wire/batch.ts"
import type { Session } from "#adapter/wire/session.ts"
import type { LedgerStatements } from "#compiler/deploy/ledger/ledger.ts"
import type { InstallationNames } from "#compiler/plan/migration.ts"
import { testSql } from "#test/support/sql.ts"

/** The transaction a migration's file runs in (adapter/migrate/session.ts fileTransaction). */
const fileTransaction: Transaction = {
	access: "readWrite",
	isolation: "serializable",
	end: "COMMIT"
}

/**
 * The transaction the names of what the session holds before a file's transaction are read in (`probingSession`):
 * read-only, and its own, so the catalogs the names probe reads, each locked to its transaction's end, are released
 * before the file's transaction begins.
 */
const priorTransaction: Transaction = { access: "readOnly", end: "COMMIT" }

/**
 * The locks the session's backend holds, each locked object once whatever its modes (lock.c LOCKTAG): every row of
 * pg_locks of its own pid granted, but its virtual transaction id, which lives in its fast-path slot and no shared entry
 * until another waits on it, a predicate lock, which lives in the predicate lock table (predicate.c), and pg_locks
 * itself, which the probe reads.
 */
const fromLocks = `FROM "pg_catalog"."pg_locks" AS "l"`

const heldLocks = `WHERE "l"."pid" = "pg_catalog"."pg_backend_pid"() AND "l"."granted" AND "l"."locktype" <> 'virtualxid'
  AND "l"."mode" <> 'SIReadLock' AND "l"."relation" IS DISTINCT FROM 'pg_catalog.pg_locks'::"pg_catalog"."regclass"`

/** The count of the objects the backend holds locked (heldLocks). */
const countProbe = testSql(
	`SELECT "pg_catalog"."count"(*)::"pg_catalog"."text" FROM (SELECT DISTINCT "l"."locktype", "l"."database", "l"."relation", "l"."page", "l"."tuple", "l"."transactionid", "l"."classid", "l"."objid", "l"."objsubid" ${fromLocks} ${heldLocks}) AS "held"`
)

/**
 * Each object the backend holds locked (heldLocks), named as deploy/locks/demand.ts lockTargetText names its targets:
 * a relation by its schema and name, a TOAST relation by its table's, a system catalog's by its own, a type, function,
 * constraint, schema, role or language by its names; anything else by its lock type; and every object the catalog no
 * longer holds, one the transaction dropped (a relation, a type, a function, a role, a schema), as `transient`, which no
 * name is left of: one COALESCE over the whole name, so no branch reads NULL where a dropped object leaves no row. Beside
 * its name, the LOCKTAG's parts that keep two objects of one name apart (two transient ones), each as text, '' where the
 * lock type has none: a session reads no NULL cell and no cell that is not text (adapter/errors/failures.ts
 * UnreadableAnswer).
 */
const namesProbe = testSql(`SELECT DISTINCT COALESCE(CASE
  WHEN "l"."locktype" = 'relation' THEN CASE
    WHEN "c"."relkind" = 't' THEN 'toast ' || ('"' || "pg_catalog"."replace"("own_n"."nspname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("own"."relname", '"', '""') || '"')
    WHEN "ti"."indrelid" IS NOT NULL AND "tt"."relkind" = 't' THEN 'toastIndex ' || ('"' || "pg_catalog"."replace"("towner_n"."nspname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("towner"."relname", '"', '""') || '"')
    WHEN "n"."nspname" = 'pg_catalog' THEN 'catalog "' || "c"."relname" || '"'
    ELSE 'relation ' || ('"' || "pg_catalog"."replace"("n"."nspname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("c"."relname", '"', '""') || '"') END
  WHEN "l"."locktype" = 'object' AND "l"."classid" = 'pg_catalog.pg_type'::"pg_catalog"."regclass" THEN CASE
    WHEN "t"."typcategory" = 'A' AND "t"."typelem" <> 0 THEN 'arrayType ' || ('"' || "pg_catalog"."replace"("en"."nspname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("et"."typname", '"', '""') || '"')
    ELSE 'type ' || ('"' || "pg_catalog"."replace"("tn"."nspname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("t"."typname", '"', '""') || '"') END
  WHEN "l"."locktype" = 'object' AND "l"."classid" = 'pg_catalog.pg_proc'::"pg_catalog"."regclass" THEN 'function ' || ('"' || "pg_catalog"."replace"("pn"."nspname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("p"."proname", '"', '""') || '"')
  WHEN "l"."locktype" = 'object' AND "l"."classid" = 'pg_catalog.pg_constraint'::"pg_catalog"."regclass" THEN CASE
    WHEN "k"."contypid" <> 0 THEN 'domainConstraint ' || ('"' || "pg_catalog"."replace"("kdn"."nspname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("kd"."typname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("k"."conname", '"', '""') || '"')
    ELSE 'constraint ' || ('"' || "pg_catalog"."replace"("krn"."nspname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("kr"."relname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("k"."conname", '"', '""') || '"') END
  WHEN "l"."locktype" = 'object' AND "l"."classid" = 'pg_catalog.pg_namespace'::"pg_catalog"."regclass" THEN 'namespace ' || ('"' || "pg_catalog"."replace"("s"."nspname", '"', '""') || '"')
  WHEN "l"."locktype" = 'object' AND "l"."classid" = 'pg_catalog.pg_authid'::"pg_catalog"."regclass" THEN CASE
    WHEN "r"."rolname" = CURRENT_USER THEN 'role ""' ELSE 'role ' || ('"' || "pg_catalog"."replace"("r"."rolname", '"', '""') || '"') END
  WHEN "l"."locktype" = 'object' AND "l"."classid" = 'pg_catalog.pg_language'::"pg_catalog"."regclass" THEN 'language ' || ('"' || "pg_catalog"."replace"("g"."lanname", '"', '""') || '"')
  WHEN "l"."locktype" = 'object' AND "l"."classid" = 'pg_catalog.pg_attrdef'::"pg_catalog"."regclass" THEN 'columnDefault ' || ('"' || "pg_catalog"."replace"("adn"."nspname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("adc"."relname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("ada"."attname", '"', '""') || '"')
  WHEN "l"."locktype" = 'object' AND "l"."classid" = 'pg_catalog.pg_rewrite'::"pg_catalog"."regclass" THEN 'rule ' || ('"' || "pg_catalog"."replace"("rwn"."nspname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("rwc"."relname", '"', '""') || '"')
  WHEN "l"."locktype" = 'object' AND "l"."classid" = 'pg_catalog.pg_trigger'::"pg_catalog"."regclass" THEN 'trigger ' || ('"' || "pg_catalog"."replace"("tgn"."nspname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("tgc"."relname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("tg"."tgname", '"', '""') || '"')
  WHEN "l"."locktype" = 'object' AND "l"."classid" = 'pg_catalog.pg_policy'::"pg_catalog"."regclass" THEN 'policy ' || ('"' || "pg_catalog"."replace"("pln"."nspname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("plc"."relname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("pl"."polname", '"', '""') || '"')
  WHEN "l"."locktype" = 'object' AND "l"."classid" = 'pg_catalog.pg_statistic_ext'::"pg_catalog"."regclass" THEN 'statistics ' || ('"' || "pg_catalog"."replace"("stn"."nspname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("st"."stxname", '"', '""') || '"')
  WHEN "l"."locktype" = 'object' AND "l"."classid" = 'pg_catalog.pg_opclass'::"pg_catalog"."regclass" THEN 'operatorClass ' || ('"' || "pg_catalog"."replace"("ocn"."nspname", '"', '""') || '"') || '.' || ('"' || "pg_catalog"."replace"("oc"."opcname", '"', '""') || '"')
  WHEN "l"."locktype" = 'object' AND "l"."classid" = 'pg_catalog.pg_publication'::"pg_catalog"."regclass" THEN 'publication ' || ('"' || "pg_catalog"."replace"("pb"."pubname", '"', '""') || '"')
  WHEN "l"."locktype" = 'object' AND "l"."classid" = 'pg_catalog.pg_database'::"pg_catalog"."regclass" THEN 'database '
  WHEN "l"."locktype" = 'object' THEN 'object ' || "l"."classid"::"pg_catalog"."regclass"::"pg_catalog"."text"
  ELSE "l"."locktype" END, 'transient'),
  "l"."locktype", COALESCE("l"."database"::"pg_catalog"."text", ''), COALESCE("l"."relation"::"pg_catalog"."text", ''), COALESCE("l"."classid"::"pg_catalog"."text", ''), COALESCE("l"."objid"::"pg_catalog"."text", ''), COALESCE("l"."objsubid"::"pg_catalog"."text", ''), COALESCE("l"."transactionid"::"pg_catalog"."text", '')
${fromLocks}
LEFT JOIN "pg_catalog"."pg_class" AS "c" ON "l"."locktype" = 'relation' AND "c"."oid" = "l"."relation"
LEFT JOIN "pg_catalog"."pg_namespace" AS "n" ON "n"."oid" = "c"."relnamespace"
LEFT JOIN "pg_catalog"."pg_class" AS "own" ON "c"."relkind" = 't' AND "own"."reltoastrelid" = "c"."oid"
LEFT JOIN "pg_catalog"."pg_namespace" AS "own_n" ON "own_n"."oid" = "own"."relnamespace"
LEFT JOIN "pg_catalog"."pg_index" AS "ti" ON "c"."relkind" = 'i' AND "ti"."indexrelid" = "c"."oid"
LEFT JOIN "pg_catalog"."pg_class" AS "tt" ON "tt"."oid" = "ti"."indrelid"
LEFT JOIN "pg_catalog"."pg_class" AS "towner" ON "tt"."relkind" = 't' AND "towner"."reltoastrelid" = "tt"."oid"
LEFT JOIN "pg_catalog"."pg_namespace" AS "towner_n" ON "towner_n"."oid" = "towner"."relnamespace"
LEFT JOIN "pg_catalog"."pg_type" AS "t" ON "l"."classid" = 'pg_catalog.pg_type'::"pg_catalog"."regclass" AND "t"."oid" = "l"."objid"
LEFT JOIN "pg_catalog"."pg_namespace" AS "tn" ON "tn"."oid" = "t"."typnamespace"
LEFT JOIN "pg_catalog"."pg_type" AS "et" ON "et"."oid" = "t"."typelem"
LEFT JOIN "pg_catalog"."pg_namespace" AS "en" ON "en"."oid" = "et"."typnamespace"
LEFT JOIN "pg_catalog"."pg_proc" AS "p" ON "l"."classid" = 'pg_catalog.pg_proc'::"pg_catalog"."regclass" AND "p"."oid" = "l"."objid"
LEFT JOIN "pg_catalog"."pg_namespace" AS "pn" ON "pn"."oid" = "p"."pronamespace"
LEFT JOIN "pg_catalog"."pg_constraint" AS "k" ON "l"."classid" = 'pg_catalog.pg_constraint'::"pg_catalog"."regclass" AND "k"."oid" = "l"."objid"
LEFT JOIN "pg_catalog"."pg_class" AS "kr" ON "kr"."oid" = "k"."conrelid"
LEFT JOIN "pg_catalog"."pg_namespace" AS "krn" ON "krn"."oid" = "kr"."relnamespace"
LEFT JOIN "pg_catalog"."pg_type" AS "kd" ON "kd"."oid" = "k"."contypid"
LEFT JOIN "pg_catalog"."pg_namespace" AS "kdn" ON "kdn"."oid" = "kd"."typnamespace"
LEFT JOIN "pg_catalog"."pg_namespace" AS "s" ON "l"."classid" = 'pg_catalog.pg_namespace'::"pg_catalog"."regclass" AND "s"."oid" = "l"."objid"
LEFT JOIN "pg_catalog"."pg_roles" AS "r" ON "l"."classid" = 'pg_catalog.pg_authid'::"pg_catalog"."regclass" AND "r"."oid" = "l"."objid"
LEFT JOIN "pg_catalog"."pg_language" AS "g" ON "l"."classid" = 'pg_catalog.pg_language'::"pg_catalog"."regclass" AND "g"."oid" = "l"."objid"
LEFT JOIN "pg_catalog"."pg_attrdef" AS "ad" ON "l"."classid" = 'pg_catalog.pg_attrdef'::"pg_catalog"."regclass" AND "ad"."oid" = "l"."objid"
LEFT JOIN "pg_catalog"."pg_class" AS "adc" ON "adc"."oid" = "ad"."adrelid"
LEFT JOIN "pg_catalog"."pg_namespace" AS "adn" ON "adn"."oid" = "adc"."relnamespace"
LEFT JOIN "pg_catalog"."pg_attribute" AS "ada" ON "ada"."attrelid" = "ad"."adrelid" AND "ada"."attnum" = "ad"."adnum"
LEFT JOIN "pg_catalog"."pg_rewrite" AS "rw" ON "l"."classid" = 'pg_catalog.pg_rewrite'::"pg_catalog"."regclass" AND "rw"."oid" = "l"."objid"
LEFT JOIN "pg_catalog"."pg_class" AS "rwc" ON "rwc"."oid" = "rw"."ev_class"
LEFT JOIN "pg_catalog"."pg_namespace" AS "rwn" ON "rwn"."oid" = "rwc"."relnamespace"
LEFT JOIN "pg_catalog"."pg_trigger" AS "tg" ON "l"."classid" = 'pg_catalog.pg_trigger'::"pg_catalog"."regclass" AND "tg"."oid" = "l"."objid"
LEFT JOIN "pg_catalog"."pg_class" AS "tgc" ON "tgc"."oid" = "tg"."tgrelid"
LEFT JOIN "pg_catalog"."pg_namespace" AS "tgn" ON "tgn"."oid" = "tgc"."relnamespace"
LEFT JOIN "pg_catalog"."pg_policy" AS "pl" ON "l"."classid" = 'pg_catalog.pg_policy'::"pg_catalog"."regclass" AND "pl"."oid" = "l"."objid"
LEFT JOIN "pg_catalog"."pg_class" AS "plc" ON "plc"."oid" = "pl"."polrelid"
LEFT JOIN "pg_catalog"."pg_namespace" AS "pln" ON "pln"."oid" = "plc"."relnamespace"
LEFT JOIN "pg_catalog"."pg_statistic_ext" AS "st" ON "l"."classid" = 'pg_catalog.pg_statistic_ext'::"pg_catalog"."regclass" AND "st"."oid" = "l"."objid"
LEFT JOIN "pg_catalog"."pg_namespace" AS "stn" ON "stn"."oid" = "st"."stxnamespace"
LEFT JOIN "pg_catalog"."pg_opclass" AS "oc" ON "l"."classid" = 'pg_catalog.pg_opclass'::"pg_catalog"."regclass" AND "oc"."oid" = "l"."objid"
LEFT JOIN "pg_catalog"."pg_namespace" AS "ocn" ON "ocn"."oid" = "oc"."opcnamespace"
LEFT JOIN "pg_catalog"."pg_publication" AS "pb" ON "l"."classid" = 'pg_catalog.pg_publication'::"pg_catalog"."regclass" AND "pb"."oid" = "l"."objid"
${heldLocks}`)

/** One transaction a probed migration session ran: the file it records, if it records one, and what it held. */
export interface ProbedTransaction {
	/** The file whose row the transaction records, by name; none for a transaction of no file's, a ledger or proof write. */
	readonly file: string | undefined
	/** The most objects the transaction held locked between two of its statements, the session's own locks before it
	 * began left out: its apply locks. */
	readonly peak: number
	/** Each object held locked at its end (namesProbe), the session's own before it began among them. */
	readonly names: ReadonlyArray<string>
	/** Each object the session held locked before the transaction began, read in a transaction of its own before it,
	 * the catalogs that read locks among them. */
	readonly before: ReadonlyArray<string>
}

/** The first cell of an outcome's first row, as a count. */
const countOf = (rows: ReadonlyArray<ReadonlyArray<string>>): number => Number(rows[0]?.[0] ?? "0")

/**
 * A migration session over `session` whose every transaction runs as the apply runner sends it, a probe of its locks
 * after BEGIN and after each statement and the names of what it holds before COMMIT, each probe a read that changes
 * nothing, and before it, in a read-only transaction of its own, the names of what the session holds: what each
 * transaction held is pushed onto `ran`, in order, under the file its row of the ledger records (`ledger`'s recordFile),
 * if it records one. Statements apart and the drift check's transaction run as they do.
 *
 * No names probe runs in the file's transaction before its last count: the names probe reads the catalogs it names
 * objects from, pg_class, pg_namespace, pg_proc, pg_trigger and a dozen more, each with every index of it its planner
 * opens, and keeps each locked to its transaction's end, so read after BEGIN it stood in the baseline every count
 * subtracts, and every catalog the file itself reads was held already and counted for none: a structure file whose
 * guard bracket reads pg_trigger, pg_class, pg_namespace and pg_proc with their indexes, fourteen catalogs its count
 * states, measured 21 where it held 35, and its stated 43 read as past twice what it held.
 */
export const probingSession = (
	session: Session,
	installation: InstallationNames,
	ledger: Pick<LedgerStatements, "recordFile">,
	ran: Array<ProbedTransaction>
): MigrationSession => {
	const plain = migrationSession(session, installation)
	const count = oneShotStatement(countProbe, [])
	const names = oneShotStatement(namesProbe, [])
	return {
		...plain,
		transaction: (statements: ReadonlyArray<BatchStatement>) =>
			Effect.flatMap(runTransaction(session, [names], priorTransaction), (prior) =>
				Effect.map(
					runTransaction(
						session,
						[count, ...Arr.flatMap(statements, (s) => [s, count]), names],
						fileTransaction
					),
					(outcomes) => {
						const counts = Arr.map(
							Arr.filter(outcomes.slice(0, -1), (_, i) => i % 2 === 0),
							(o) => countOf(o.rows)
						)
						const [baseline = 0] = counts
						const row = Arr.findFirst(
							statements,
							(st) => st._tag === "oneShot" && st.sql === ledger.recordFile.text
						)
						const file = Option.match(row, {
							onNone: () => undefined,
							onSome: (st) => st.params[2]
						})
						ran.push({
							file: typeof file === "string" ? file : undefined,
							peak: Arr.reduce(counts, 0, (most, n) => Math.max(most, n)) - baseline,
							names: Arr.map(outcomes.at(-1)?.rows ?? [], (row) => row[0] ?? ""),
							before: Arr.map(prior[0]?.rows ?? [], (row) => row[0] ?? "")
						})
					}
				)
			)
	}
}

/** What a transaction held that the count of its targets does not name, and what it names that the transaction did not
 * hold, each a lock target's text (lockTargetText), a transient one by its kind alone. */
export const lockDifference = (
	held: ReadonlyArray<string>,
	before: ReadonlyArray<string>,
	counted: ReadonlyArray<string>
): { readonly missed: ReadonlyArray<string>; readonly spare: ReadonlyArray<string> } => {
	const already = new Set(before)
	const observed = Arr.filter(held, (h) => !already.has(h) || h === "transient")
	const kind = (t: string) =>
		Str.startsWith("transient")(t)
			? "transient"
			: Str.startsWith("advisory")(t)
				? "advisory"
				: Str.startsWith("transaction")(t)
					? "transactionid"
					: t
	const stated = Arr.map(counted, kind)
	const tally = (list: ReadonlyArray<string>) => {
		const m = new Map<string, number>()
		for (const x of list) {
			m.set(x, (m.get(x) ?? 0) + 1)
		}
		return m
	}
	const o = tally(observed)
	const s = tally(stated)
	const missed: Array<string> = []
	const spare: Array<string> = []
	for (const [k, n] of o) {
		for (let i = s.get(k) ?? 0; i < n; i++) {
			missed.push(k)
		}
	}
	for (const [k, n] of s) {
		for (let i = o.get(k) ?? 0; i < n; i++) {
			spare.push(k)
		}
	}
	return { missed, spare }
}
