import { Effect, pipe, type Scope, String as Str } from "effect"
import type { ApplyError, OpenError } from "#adapter/errors/execution.ts"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import type { AnyLoginRole, LevelsOf, Schema, StatementsByName } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { type Fixture, openFixture } from "#test/pg/e2e-laws/support.ts"
import { Cents, Instant } from "#test/support/fixtures/api/contracts.ts"
import * as P from "#test/support/fixtures/api/payroll.ts"
import { stateA } from "#test/support/fixtures/golden/payroll.ts"
import type { SqlError } from "#test/support/pg.ts"
import { applyRuntime } from "#test/support/runtime-db.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { Substrate } from "#test/support/substrate/substrate.ts"

/** Payroll under the name of its installation, the schema the Db opens. */
export type PayrollInstalled = Schema<
	string,
	(typeof P.Payroll)["relations"],
	StatementsByName<(typeof P.Payroll)["statements"], (typeof P.Payroll)["relations"]>
>
/** The fixture's worlds over the installed Payroll. */
export type PayrollWorlds = ReturnType<typeof P.reportingWorlds>

/**
 * A ChangeSet and its db.apply as one role: the outcome, and the ChangeSet value grizzle compiles (a typed one, or a
 * JavaScript caller's built with the runtime builder).
 */
export interface Attempt {
	readonly changes: unknown
	readonly outcome: Effect.Effect<ApplyOutcome<unknown>, ApplyError | OpenError>
}

/** The ledger's member queries over the rebuilt schema. */
const members = (s: PayrollInstalled) => ({
	/** Approve an employee's shifts of a week. */
	approveShifts: query(s).rule((r) => {
		const { during } = v(P.Shift, "shift")
		return r
			.match(P.Shift, {
				employee: r.param("employee", P.Shift.fields.employee),
				during,
				week: r.param("week", P.Shift.fields.week),
				status: "pending"
			})
			.find({
				employee: r.param("employee", P.Shift.fields.employee),
				during,
				week: r.param("week", P.Shift.fields.week),
				status: "approved"
			})
	}),
	postings: query(s)
		.rule((r) => {
			const { id, gross } = v(P.PayLine, "payLine")
			return r.match(P.PayLine, { id, run: r.param("run", P.PayLine.fields.run), gross }).find({
				line: id,
				account: "GrossWages",
				side: "debit",
				amount: gross
			})
		})
		.rule((r) => {
			const { id, net } = v(P.PayLine, "payLine")
			return r
				.match(P.PayLine, { id, run: r.param("run", P.PayLine.fields.run), net })
				.find({ line: id, account: "NetPay", side: "credit", amount: net })
		})
		.rule((r) => {
			const { id, gross, net } = v(P.PayLine, "payLine")
			return r
				.match(P.PayLine, { id, run: r.param("run", P.PayLine.fields.run), gross, net })
				.find({
					line: id,
					account: "Withholding",
					side: "credit",
					amount: Compute.when(
						Compute.within(Compute.sub(gross, net), 0n, 9223372036854775807n),
						(withheld) => Compute.cast(withheld, Cents),
						Compute.literal(Cents, 0n)
					)
				})
		}),
	/** The pay run put. */
	payPut: query(s).rule((r) => {
		const { employer, period } = v(P.PayRun, "payRun")
		return r
			.match(P.PayRun, {
				id: r.param("run", P.PayRun.fields.id),
				employer,
				period,
				stage: "approved"
			})
			.find({ id: r.param("run", P.PayRun.fields.id), employer, period, stage: "paid" })
	}),
	payPayment: query(s).rule((r) =>
		r
			.match(P.PayRun, { id: r.param("run", P.PayRun.fields.id), stage: "approved" })
			.find({ run: r.param("run", P.Payment.fields.run), settled: r.param("now", Instant) })
	)
})

export interface Payroll extends ReturnType<typeof members> {
	readonly f: Fixture
	/** Payroll rebuilt under the installed name, and its worlds. */
	readonly s: PayrollInstalled
	readonly w: PayrollWorlds
	readonly cs: () => ChangeSet<PayrollInstalled>
	/**
	 * db.apply of a ChangeSet without parameters, whose parameter type is unknown, as `role`, a role reached through its
	 * login.
	 */
	readonly attempt: <L extends LevelsOf<PayrollInstalled>, W extends string, Reads>(
		role: AnyLoginRole,
		changes: ChangeSet<L, unknown, W, Reads>
	) => Attempt
}

/**
 * The payroll ledger, installed for the law-bearing end-to-end suites.
 *
 * Reporting installs completely under a fresh schema name, every law native and RunTotal's materialized view included,
 * with the facts of the state after onboard, logShifts and draftRun (test/support/fixtures/golden/payroll.ts stateA).
 * The facts carry the six postings' entry numbers, so the identity sequence is advanced past them as the owner, as a
 * migration that writes explicit serial values ends. The ChangeSets are applied to Payroll rebuilt under the installed
 * name: the ledger's program builds them over Reporting, the schema an application opens, but every law and every
 * relation they write is Payroll's, the roles that write are the fixture's worlds over the rebuilt Payroll
 * (reportingWorlds), and the queries inside the members are over Payroll there too. The member queries the ledger
 * states over Payroll (test/support/fixtures/api/payroll.ts) are written once more here over the rebuilt schema value,
 * because a member must be written over a level of its ChangeSet's schema.
 */
export const openPayroll: Effect.Effect<
	Payroll,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> = Effect.gen(function* () {
	const f = yield* openFixture(P.Reporting, [P.reportingWorlds(P.Payroll).server], {
		facts: stateA,
		after: [
			`SELECT pg_catalog.setval('$S.${quoteIdent(identifierOf(identity.sequence(P.Posting.name, "entry")))}'::regclass, 6)`
		]
	})
	const s = f.rebuilt(P.Payroll)
	const payroll: Payroll = {
		...members(s),
		f,
		s,
		w: P.reportingWorlds(s),
		cs: () => ChangeSet.empty(s),
		attempt: (role, changes) => ({
			changes,
			outcome: f.withDb(role, (...[, ctx]) => applyRuntime(ctx, changes, {}))
		})
	}
	return payroll
})

/** Fresh uuids for the facts the ChangeSets add, beside the golden ones. */
export const fresh = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe((0x9000 + n).toString(16), Str.padStart(12, "0"))}`
