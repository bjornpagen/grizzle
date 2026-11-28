/** What runner-advice.test.ts reads: its schema, the transactions the apply runner sends, and the runner's own rows' scope. */

import { Array as Arr, Option, String as Str } from "effect"
import type { MigrationSession } from "#adapter/migrate/session.ts"
import type { BatchStatement } from "#adapter/wire/batch.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { LedgerStatements } from "#compiler/deploy/ledger/ledger.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema, unit } from "#compiler/public/schema.ts"
import {
	type AdvisedPlan,
	type LawScope,
	type ScopeStatement,
	type Supplied
} from "#test/support/advice.ts"
import { sentSql } from "#test/support/flight/scripted.ts"

/**
 * The schema: T's facts by document and place, in the unit Document; and, `withOnes`, Ones, those of T whose `a` is one,
 * stored at level 1, whose migration creates Ones' table and T's index on `a` and fills Ones by a data step that reads T
 * at its constant `a` through that index, which the drafter creates before it (deploy/render/advise.ts
 * indexesBeforeReaders).
 */
export const runnerSchema = (withOnes: boolean) => {
	const T = relation("T", { doc: int4, at: int4, a: int4, b: int4 }, ["doc", "at"])
	const Base = schema("runner_advice", [T], [unit("Document", { doc: int4 })])
	const Ones = derived(
		"Ones",
		query(Base).rule((r) => {
			const { doc, at, b } = v(T, "t")
			return r.match(T, { doc, at, a: 1, b }).find({ doc, at, b })
		})
	)
	return schema.extend([Base], "runner_advice_1", withOnes ? [Ones] : [], [])
}

/**
 * The migration whose data steps a case holds to their advice: a schema's first, which creates T, its index on `a` and
 * Ones' table and fills Ones over T in one migration; a later one, which adds Ones over T installed; or the first with
 * a reviewer's statement written at the end of its Structure file, after its recorded ones (`reviewerStatement`).
 */
export type Migration =
	| "the first migration"
	| "a later migration"
	| "a reviewer's statement among the recorded ones"

/** The migration of the case drawn `drawn`, 0 to 2 (Migration). */
export const migrationOf = (drawn: number): Migration =>
	drawn === 1
		? "a later migration"
		: drawn === 2
			? "a reviewer's statement among the recorded ones"
			: "the first migration"

/**
 * The reviewer's statement a case writes after a Structure file's recorded ones: a read of T under the alias `r1`, the
 * first a file's advice scope mints, which would meet every atom the file's data steps carry for r1 if the runner ran
 * it under their advice.
 */
export const reviewerStatement = (schema: string): string =>
	`SELECT pg_catalog.count(*) FROM ${quoteIdent(schema)}."t" AS "r1" WHERE "r1"."a" = 1`

/** A reviewer writing `statement` at the end of each Structure file, after its recorded statements, every other file
 * as drafted. */
export const writingAtStructure =
	(statement: string) =>
	(file: { readonly name: string; readonly text: string }): string =>
		Str.endsWith("-structure.sql")(file.name) ? `${file.text}\n\n${statement};\n` : file.text

/**
 * The advice in force at the statement of `transaction` whose text is `sql`, by the sets of it before it (LedgerStatements
 * `advise`), none where no set comes before it or no statement is `sql`.
 */
export const adviceBefore = (
	transaction: ReadonlyArray<BatchStatement>,
	ledger: Pick<LedgerStatements, "advise">,
	sql: string
): string | undefined =>
	Option.getOrUndefined(
		Option.flatMap(
			Arr.findFirstIndex(transaction, (st) => sentSql(st) === sql),
			(at) =>
				Arr.last(
					Arr.map(
						Arr.filter(transaction.slice(0, at), (st) => sentSql(st) === ledger.advise.text),
						(st) => String(st.params[0])
					)
				)
		)
	)

/** One statement's scope under the advice `set`: what plans it, its atoms to read off its plan. */
export const statementScope = (label: string, sql: string, set: string): LawScope => ({
	label,
	sends: "sent",
	advice: set,
	aliases: [],
	targets: [],
	levels: [],
	reads: [],
	statements: [{ label, sql }],
	vehicle: { kind: "flight", advice: set }
})

/** `m`, each transaction it sends kept in `sent`, in order, as the runner sends it. */
export const keeping = (
	m: MigrationSession,
	sent: Array<ReadonlyArray<BatchStatement>>
): MigrationSession => ({
	installation: m.installation,
	apart: m.apart,
	alongside: m.alongside,
	transaction: (statements) => {
		sent.push(statements)
		return m.transaction(statements)
	}
})

/** The advice a transaction the runner sent opens with (LedgerStatements `advise`), none where it opens otherwise. */
export const openingAdvice = (
	transaction: ReadonlyArray<BatchStatement>,
	ledger: Pick<LedgerStatements, "advise">
): string | undefined => {
	const [first] = transaction
	return first === undefined || sentSql(first) !== ledger.advise.text
		? undefined
		: String(first.params[0])
}

/**
 * The runner's own rows a file's transaction may send beside its data steps, under the advice the runner set (`set`):
 * the ledger's rows and its head, and a redraft's re-record of its folder (LedgerStatements), each cost-chosen, named by
 * its table's own name, so no atom of the advice names one of them.
 */
export const rowsScope = (
	ledger: Pick<LedgerStatements, "recordFolder" | "recordFile" | "recordHead" | "redraftFolder">,
	set: string
): LawScope => ({
	label: "the runner's rows",
	sends: "sent",
	advice: set,
	aliases: [],
	targets: [],
	levels: [],
	reads: [],
	statements: Arr.map(
		[ledger.recordFolder, ledger.recordFile, ledger.recordHead, ledger.redraftFolder] as const,
		(e, at): ScopeStatement => ({ label: `row ${at + 1}`, sql: String(e.text) })
	),
	vehicle: { kind: "flight", advice: set }
})

/** Each atom of a supplied advice PostgreSQL matched in one of `plans`: an atom a statement of them named. */
export const matchedIn = (plans: ReadonlyArray<AdvisedPlan>): ReadonlyArray<string> =>
	Arr.flatMap(plans, (p) =>
		Arr.flatMap(Option.getOrElse(p.supplied, Arr.empty<Supplied>), (x) =>
			x.feedback.match === "not matched" ? [] : [x.atom.text]
		)
	)
