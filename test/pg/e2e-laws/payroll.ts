import { Effect, pipe, type Scope, String as Str } from "effect"
import type { ApplyError, OpenError } from "#adapter/errors/execution.ts"
import type { ServedRefusal } from "#adapter/public/compile.ts"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ParamMap } from "#compiler/plan/common.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import type { AnyLoginRole, LevelsOf, Schema, StatementsByName } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { type Fixture, openFixture } from "#test/pg/e2e-laws/support.ts"
import { Instant } from "#test/support/fixtures/api/contracts.ts"
import * as P from "#test/support/fixtures/api/payroll.ts"
import { stateA } from "#test/support/fixtures/golden/payroll.ts"
import type { SqlError } from "#test/support/pg.ts"
import { type CallFacts, member, withServedDb } from "#test/support/served-db.ts"
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

/** A ChangeSet applied as one role through its login's served file: the outcome. */
export interface Attempt {
	readonly outcome: Effect.Effect<ApplyOutcome<unknown>, ApplyError | OpenError | ServedRefusal>
}

/** The facts of a call of a ChangeSet that holds no array member. */
const noFacts: CallFacts = {}

/**
 * `changes` applied as `role` through its login's served file, the ChangeSet the one member of the role's workload
 * (test/support/served-db.ts withServedDb): with `facts` where it holds array members, and with `params`.
 */
const appliedAs = (
	f: Fixture,
	role: AnyLoginRole,
	changes: unknown,
	facts: CallFacts,
	params: ParamMap
): Attempt => ({
	outcome: Effect.scoped(
		withServedDb(f.installed, role, {}, ({ serve }) =>
			Effect.flatMap(serve({ attempt: changes }), (served) => {
				const ops = member(served, "attempt")
				return ops.kind === "facts" ? ops.ops.apply(facts, params) : ops.ops.apply(params)
			})
		)
	)
})

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
	 * A ChangeSet without parameters, whose parameter type is unknown, applied as `role`, a role reached through its
	 * login, with each call's facts of its array members.
	 */
	readonly attempt: <L extends LevelsOf<PayrollInstalled>, W extends string, Reads>(
		role: AnyLoginRole,
		changes: ChangeSet<L, unknown, W, Reads>,
		facts: CallFacts
	) => Attempt
	/** A ChangeSet of query members alone applied as `role` with `params`. */
	readonly called: <L extends LevelsOf<PayrollInstalled>, Params, W extends string, Reads>(
		role: AnyLoginRole,
		changes: ChangeSet<L, Params, W, Reads>,
		params: ParamMap
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
		attempt: (role, changes, facts) => appliedAs(f, role, changes, facts, {}),
		called: (role, changes, params) => appliedAs(f, role, changes, noFacts, params)
	}
	return payroll
})

/** Fresh uuids for the facts the ChangeSets add, beside the golden ones. */
export const fresh = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe((0x9000 + n).toString(16), Str.padStart(12, "0"))}`
