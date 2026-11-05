import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { quoteIdent } from "#compiler/sql/print.ts"
import { fresh, openPayroll, type Payroll } from "#test/pg/e2e-laws/payroll.ts"
import { assert } from "#test/support/assert.ts"
import {
	acme,
	ada,
	bo,
	type DirectWriter,
	directWriters,
	l1,
	p0,
	p1,
	run1,
	t5,
	t9,
	t12,
	tApproved,
	tNow,
	tSettled
} from "#test/support/fixtures/golden/payroll.ts"
import type { PgErrorFields } from "#test/support/substrate/errors.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import type { PsqlWriter } from "#test/support/substrate/psql.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
const run5 = fresh(50)
const run6 = fresh(51)
const newLine = fresh(52)

/**
 * The psql variables the writers' statements use: the golden constants, and fresh ids for run5, run6 and the new line.
 */
const variables: Readonly<Record<string, string>> = {
	l1,
	run1,
	ada,
	bo,
	acme,
	run5,
	run6,
	line: newLine,
	p0: String(p0),
	p1: String(p1),
	t5: String(t5),
	t9: String(t9),
	t12: String(t12),
	now: String(tNow)
}

/** A psql variable as a statement spells it, quoted (`:'name'`) or bare (`:name`): split on, it is every odd piece. */
const variableToken = regex("(:'[a-z0-9]+'|:[a-z][a-z0-9]*\\b)")

/** A psql variable's value as psql interpolates it: quoted as a literal for `:'name'`, bare for `:name`. */
const valueOf = (token: string): string => {
	const quoted = Str.startsWith(":'")(token)
	const name = quoted ? Str.slice(2, -1)(token) : Str.slice(1)(token)
	const value = variables[name]
	assert.ok(value !== undefined, `no value for ${token}`)
	return quoted ? `'${value}'` : value
}

/**
 * The statement as psql would run it after interpolating `:'name'` and `:name`, over the installed schema: a row names
 * the declared schema `payroll` bare or, where the naming door qualified a name, quoted.
 */
const spell = (p: Payroll, sql: string): string => {
	const interpolated = Arr.join(
		Arr.map(Str.split(sql, variableToken), (piece, i) => (i % 2 === 0 ? piece : valueOf(piece))),
		""
	)
	return Str.replaceAll(
		"payroll.",
		`${p.f.q}.`
	)(Str.replaceAll(`${quoteIdent("payroll")}.`, `${p.f.q}.`)(interpolated))
}

interface Failed {
	readonly index: number
	readonly statement: string
	readonly fields: PgErrorFields
}

/** Runs a row's statements; the first failure ends it, rolling back an open transaction. */
const runRow = (
	psql: PsqlWriter,
	statements: ReadonlyArray<string>
): Effect.Effect<Option.Option<Failed>, Error> =>
	Effect.gen(function* () {
		let open = false
		for (const [index, statement] of statements.entries()) {
			const step =
				statement === "BEGIN"
					? psql.begin
					: statement === "COMMIT"
						? psql.commit
						: statement === "ROLLBACK"
							? psql.rollback
							: Effect.asVoid(psql.run(statement))
			const result = yield* Effect.result(step)
			if (result._tag === "Failure") {
				const fields = pgErrorFields(result.failure)
				assert.ok(fields !== undefined, `${statement}: ${String(result.failure)}`)
				yield* open && statement !== "COMMIT" ? psql.rollback : Effect.void
				return Option.some({ index, statement, fields })
			}
			if (Str.startsWith("BEGIN")(statement)) {
				open = true
			}
			if (statement === "COMMIT" || statement === "ROLLBACK") {
				open = false
			}
		}
		return Option.none()
	})

const checkRow = (p: Payroll, row: DirectWriter) =>
	Effect.gen(function* () {
		const psql = yield* p.f.psql(p.w[row.role])
		if (row.precondition.kind === "setup") {
			const setup = yield* runRow(
				psql,
				Arr.map(row.precondition.setup, (s) => spell(p, s))
			)
			assert.ok(
				Option.isNone(setup),
				`${row.name}: the precondition (${row.precondition.description}) holds`
			)
		}
		const failed = yield* runRow(
			psql,
			Arr.map(row.sql, (s) => spell(p, s))
		)
		switch (row.outcome.kind) {
			case "accepted":
				assert.ok(Option.isNone(failed), `${row.name} is accepted: ${Formatter.format(failed)}`)
				return
			case "refused":
				failedWith(row, failed, row.outcome.sqlstate, row.outcome.at)
				return
			case "constraint": {
				const f = failedWith(row, failed, row.outcome.sqlstate, row.outcome.at)
				assert.equal(f.fields.constraint, row.outcome.constraint, row.name)
				return
			}
		}
	})

/** The failure a refused row meets, with the SQLSTATE at the position its outcome states. */
const failedWith = (
	row: DirectWriter,
	ran: Option.Option<Failed>,
	sqlstate: string,
	at: "statement" | "commit"
): Failed => {
	if (Option.isNone(ran)) {
		return assert.fail(`${row.name} fails with ${sqlstate}`)
	}
	const failed = ran.value
	assert.equal(failed.fields.code, sqlstate, `${row.name}: ${failed.fields.message}`)
	assert.equal(
		failed.statement === "COMMIT" ? "commit" : "statement",
		at,
		`${row.name} fails at ${at}, not at ${failed.statement}`
	)
	return failed
}

/**
 * The state after reverse, written by the roles as direct writers: approveRun's approval, pay's
 * payment, and reverse's voiding in place of the payment. run1 keeps the Approval of its first approval.
 */
const toAfterReverse = (p: Payroll) =>
	Effect.gen(function* () {
		const approver = yield* p.f.psql(p.w.approver)
		const clerk = yield* p.f.psql(p.w.clerk)
		const t = p.f.t
		const steps: ReadonlyArray<readonly [PsqlWriter, ReadonlyArray<string>]> = [
			[
				approver,
				[
					`UPDATE ${t("pay_run")} SET "stage" = 'approved' WHERE "id" = '${run1}'`,
					`INSERT INTO ${t("approval")} ("run", "approver", "at") VALUES ('${run1}', '${ada}', ${tApproved})`
				]
			],
			[
				clerk,
				[
					`UPDATE ${t("pay_run")} SET "stage" = 'paid' WHERE "id" = '${run1}'`,
					`INSERT INTO ${t("payment")} ("run", "settled") VALUES ('${run1}', ${tSettled})`
				]
			],
			[
				clerk,
				[
					`UPDATE ${t("pay_run")} SET "stage" = 'voided' WHERE "id" = '${run1}'`,
					`DELETE FROM ${t("payment")} WHERE "run" = '${run1}'`,
					`INSERT INTO ${t("voiding")} ("run", "reason") VALUES ('${run1}', 'bank returned the batch')`
				]
			]
		]
		for (const [writer, statements] of steps) {
			const failed = yield* runRow(writer, ["BEGIN", ...statements, "COMMIT"])
			assert.ok(Option.isNone(failed), Formatter.format(failed))
		}
	})

const refused: ReadonlyArray<DirectWriter> = Arr.filter(
	directWriters,
	(r) => r.outcome.kind !== "accepted" && r.startsFrom.kind === "stateA"
)
const accepted: ReadonlyArray<DirectWriter> = Arr.filter(
	directWriters,
	(r) => r.outcome.kind === "accepted"
)

/** Every native error the header names, at the place it names: what the refused rows must reach between them. */
const promised: ReadonlyArray<string> = [
	"23505 at statement",
	"23514 at statement",
	"23P01 at statement",
	"428C9 at statement",
	"22P02 at statement",
	"23503 at statement",
	"23503 at commit",
	"42501 at statement"
]

/** The SQLSTATE a refused row fails with, at its place. */
const reachedBy = (row: DirectWriter): ReadonlyArray<string> => {
	switch (row.outcome.kind) {
		case "accepted":
			return []
		case "refused":
		case "constraint":
			return [`${row.outcome.sqlstate} at ${row.outcome.at}`]
	}
}

/**
 * The payroll example's direct psql writers see the stated native errors.
 *
 * Each row of test/support/fixtures/golden/payroll.ts directWriters runs in a psql child in its role's world (logged in
 * as the fixture's login, the role taken on), schema-qualified because no role gets a search_path default, at
 * SERIALIZABLE: a row's BEGIN is BEGIN ISOLATION LEVEL SERIALIZABLE, and a statement outside a transaction runs at the
 * database's default, SERIALIZABLE. psql variables are spelled into the statements here, since a writer runs no
 * meta-command. The SQLSTATE is the observable contract: 23505, 23514, 23P01 and 428C9 at the statement; 22P02 for a
 * label outside a closed roster; 23503 from a deferred foreign key at COMMIT, or at the statement once the writer sets
 * every constraint IMMEDIATE, with the constraint's stable name where the row names it; 42501 for a privilege the role
 * lacks. Every law is native, so no refusal is a law function's 23000. A refused row
 * changes nothing, so the refused rows run one after another on one installation; each accepted row runs on its own
 * installation, from the state it names, and is judged by its outcome alone.
 */
export const payrollDirectSuite = (): void => {
	layer(Substrate.layer, { excludeTestServices: true })(
		"the payroll example's direct psql writers see PostgreSQL's native errors",
		(it) => {
			it.effect(
				"every refused row fails with its SQLSTATE, where its row says, and changes nothing",
				() =>
					Effect.gen(function* () {
						const p = yield* openPayroll
						const counts = `SELECT (SELECT count(*) FROM $S."deposit")::text, (SELECT count(*) FROM $S."posting")::text, (SELECT count(*) FROM $S."employment")::text, (SELECT "stage"::text FROM $S."pay_run" WHERE "id" = '${run1}')`
						const before = yield* p.f.rows(counts)
						for (const row of refused) {
							yield* checkRow(p, row)
						}
						const rows = yield* p.f.rows(counts)
						assert.deepEqual(rows, before)
						const reached = new Set(Arr.flatMap(refused, reachedBy))
						assert.deepEqual(
							Arr.filter(promised, (error) => !reached.has(error)),
							[],
							"every native error the header names is some refused row's"
						)
					}).pipe(Effect.scoped)
			)

			it.effect("every accepted row commits, from the state it names", () =>
				Effect.forEach(
					accepted,
					(row) =>
						Effect.gen(function* () {
							const p = yield* openPayroll
							if (row.startsFrom.kind === "named") {
								assert.equal(
									row.startsFrom.state,
									"after reverse",
									`${row.name}: a state the suite reaches`
								)
								yield* toAfterReverse(p)
							}
							yield* checkRow(p, row)
						}).pipe(Effect.scoped),
					{ discard: true }
				)
			)
		}
	)
}
