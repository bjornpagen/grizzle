import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { type Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import type { Witness } from "#compiler/public/changeset.ts"
import { Decimal, type Infer, type Span, type Uuid } from "#compiler/public/fields.ts"
import {
	alternatives,
	capacity,
	check,
	contained,
	duration,
	type Fact,
	key,
	mirrors,
	on,
	ref,
	select,
	weigh,
	within
} from "#compiler/public/schema.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import { type Attempt, fresh, openPayroll, type Payroll } from "#test/pg/e2e-laws/payroll.ts"
import { assert, containsEqual, defined } from "#test/support/assert.ts"
import { Cents, Instant } from "#test/support/fixtures/api/contracts.ts"
import * as P from "#test/support/fixtures/api/payroll.ts"
import {
	acme,
	ada,
	bo,
	digest1,
	l1,
	l2,
	p0,
	p1,
	request1,
	run1,
	run2,
	run3,
	s4,
	t0,
	t5,
	t9,
	t12,
	tApproved,
	tNow,
	tSettled,
	w1,
	w2
} from "#test/support/fixtures/golden/payroll.ts"
import { installationNamesOf, installationOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { applyRuntime } from "#test/support/runtime-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const hour = 3_600_000_000n
const span = (start: bigint, end: bigint): Span<Infer<typeof Instant>> => ({
	start: Instant(start),
	end: Instant(end)
})
const period = span(p0, p1)
const draftRun = (id: Uuid): Fact<typeof P.PayRun> => ({
	id,
	employer: acme,
	period,
	stage: "draft"
})
const cents = Cents
const name = P.LegalName

interface Case {
	/** The row's change, as the payroll outcome table names it. */
	readonly change: string
	readonly role: "hr" | "clerk" | "approver"
	/** The row's ChangeSet and its db.apply as `role`. */
	readonly changes: (p: Payroll) => Attempt
	/** The law the outcome names. */
	readonly law: LawId
	/**
	 * The witnesses the outcome may carry, its one: `unreported` for a native violation PostgreSQL states only in its
	 * message. Several only where the ChangeSet submits several facts that collide at once, and the refusal names the
	 * one its statement meets first, in the plan's order.
	 */
	readonly witnesses: Arr.NonEmptyReadonlyArray<Witness>
}

/**
 * Each law is read through the naming door from the statement that declares it: the payroll schema's statement,
 * rebuilt with the same builders and arguments (the door matches a statement by its description). The suite installs
 * fresh, so the fresh installation's text domain is the installed one.
 */
const L = installationNamesOf(installationOf(P.Payroll, { kind: "declared" }))
const { Levy, Stage } = P.Payroll.relations
const runStage = L.alternativesOf(
	alternatives(P.PayRun, "stage", Stage, { paid: P.Payment, voided: P.Voiding })
)
const paymentArm = defined(runStage.arms["paid"], "the paid arm's law")
const offCycleReasons = L.mirrorsOf(
	mirrors(on(select(P.PayLine, { offCycle: true }), "id"), on(P.OffCycleReason, "line"))
)

const approvedHours = capacity(on(P.Timesheet, "employee", "week"), {
	from: on(select(P.Shift, { status: "approved" }), "employee", "week"),
	weight: weigh(duration("during")),
	within: within(0n, ref("ceiling"))
})

const depositAmount = capacity(on(P.PayLine, "id"), {
	from: on(P.Deposit, "line"),
	weight: weigh("amount"),
	within: within(ref("net"), ref("net"))
})

const approvers = capacity(on(P.Employer, "id"), {
	from: on(P.Approver, "employer"),
	within: within(1n, "*")
})

/** A native violation's witness: PostgreSQL states its key only in its message. */
const unreported: Witness = { kind: "unreported" }

/** The witness of a Posting refused at its key, (line, account). */
const postingKey = (line: string, account: string): Witness => ({
	kind: "key",
	relation: "Posting",
	values: { line, account }
})

/** From the state after onboard, logShifts and draftRun. */
const fromStateA: Arr.NonEmptyReadonlyArray<Case> = [
	{
		change: "insert Employee ada with another name",
		role: "hr",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.hr,
				p
					.cs()
					.insert(P.Employee, [
						{ id: ada, employer: acme, code: "E000001", name: name("Ada Lovelace") }
					])
			),
		law: L.primaryKeyLaw(P.Employee),
		witnesses: [{ kind: "key", relation: "Employee", values: { id: ada } }]
	},
	{
		change: "two puts of TaxProfile bo with different filings",
		role: "hr",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.hr,
				p.cs().put(P.TaxProfile, [
					{ employee: bo, filing: "joint", extra: cents(2_500n) },
					{ employee: bo, filing: "head", extra: cents(2_500n) }
				])
			),
		law: L.primaryKeyLaw(P.TaxProfile),
		witnesses: [{ kind: "key", relation: "TaxProfile", values: { employee: bo } }]
	},
	{
		change: "insert a second Employer with acme's EIN",
		role: "hr",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.hr,
				p
					.cs()
					.insert(P.Employer, [
						{ id: fresh(1), ein: P.Ein("12-3456789"), name: name("Other Tools LLC") }
					])
			),
		law: L.lawOf(key(P.Employer, ["ein"])),
		witnesses: [{ kind: "key", relation: "Employer", values: { ein: P.Ein("12-3456789") } }]
	},
	{
		change: "put ReportsTo { employee: bo, manager: bo }",
		role: "hr",
		changes: (p) =>
			p.attempt(p.w.server.roles.hr, p.cs().put(P.ReportsTo, [{ employee: bo, manager: bo }])),
		law: L.lawOf(check("NotOwnManager", P.ReportsTo, (x) => x.ne(x.employee, x.manager))),
		witnesses: [unreported]
	},
	{
		change: "insert ReportsTo { employee: ada, manager: <no employee> }",
		role: "hr",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.hr,
				p.cs().insert(P.ReportsTo, [{ employee: ada, manager: fresh(2) }])
			),
		law: L.lawOf(contained(on(P.ReportsTo, "manager"), on(P.Employee, "id"))),
		witnesses: [unreported]
	},
	{
		change: 'insert an Employee with code "X1" through an untyped path',
		role: "hr",
		/** The typed Fact<Employee> rejects "X1"; a JavaScript caller sends it, and the domain refuses it. */
		changes: (p) => {
			const changes = changeSetOver
				.empty(p.s)
				.insert(P.Employee, [{ id: fresh(3), employer: acme, code: "X1", name: "Xavier" }])
				.insert(P.TaxProfile, [{ employee: fresh(3), filing: "single", extra: 0n }])
			return {
				changes,
				outcome: p.f.withDb(p.w.server.roles.hr, (db) => applyRuntime(db, changes, {}))
			}
		},
		law: L.textDomain(P.Employee, "code").law,
		witnesses: [unreported]
	},
	{
		change: "insert an Employee with its TaxProfile whose name is 301 characters",
		role: "hr",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.hr,
				p
					.cs()
					.insert(P.Employee, [
						{ id: fresh(4), employer: acme, code: "E000009", name: name(Str.repeat(301)("n")) }
					])
					.insert(P.TaxProfile, [{ employee: fresh(4), filing: "single", extra: cents(0n) }])
			),
		law: L.contract("LegalName").law,
		witnesses: [unreported]
	},
	{
		change: 'put TaxProfile { employee: bo, filing: "joint", extra: Cents(-1n) }',
		role: "hr",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.hr,
				p.cs().put(P.TaxProfile, [{ employee: bo, filing: "joint", extra: cents(-1n) }])
			),
		law: L.contract("Cents").law,
		witnesses: [unreported]
	},
	{
		change: "insert Employment { employee: ada, during: [t5, t12) }",
		role: "hr",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.hr,
				p.cs().insert(P.Employment, [{ employee: ada, during: span(t5, t12), basis: "salaried" }])
			),
		law: L.primaryKeyLaw(P.Employment),
		/** The named-arbiter insert's classifying statement reports the requested fact's key. */
		witnesses: [
			{ kind: "key", relation: "Employment", values: { employee: ada, during: span(t5, t12) } }
		]
	},
	{
		change: "delete Assignment { employee: bo, during: [t5, t9) }",
		role: "hr",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.hr,
				p.cs().delete(P.Assignment, [{ employee: bo, during: span(t5, t9), costCenter: "CC-0200" }])
			),
		law: L.mirrorsOf(
			mirrors(on(P.Assignment, "employee", "during"), on(P.Employment, "employee", "during"))
		).rightToLeft,
		witnesses: [unreported]
	},
	{
		change: "insert Salary for bo, whose employment is hourly",
		role: "hr",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.hr,
				p.cs().insert(P.Salary, [{ employee: bo, during: span(t0, t9), annual: cents(5_000_000n) }])
			),
		law: L.lawOf(
			contained(
				on(P.Salary, "employee", "during"),
				on(select(P.Employment, { basis: "salaried" }), "employee", "during")
			)
		),
		witnesses: [unreported]
	},
	{
		change: "insert Leave { employee: ada, during: [t9, t12) }",
		role: "hr",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.hr,
				p.cs().insert(P.Leave, [{ employee: ada, during: span(t9, t12), reason: "vacation" }])
			),
		law: L.lawOf(
			contained(on(P.Leave, "employee", "during"), on(P.Employment, "employee", "during"))
		),
		witnesses: [unreported]
	},
	{
		change: "insert an Employee without a TaxProfile",
		role: "hr",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.hr,
				p
					.cs()
					.insert(P.Employee, [
						{ id: fresh(5), employer: acme, code: "E000010", name: name("Eve") }
					])
			),
		law: L.mirrorsOf(mirrors(on(P.Employee, "id"), on(P.TaxProfile, "employee"))).leftToRight,
		witnesses: [unreported]
	},
	{
		change: "onboard a second employer, its employee and the profile, with no Approver",
		role: "hr",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.hr,
				p
					.cs()
					.insert(P.Employer, [
						{ id: fresh(6), ein: P.Ein("98-7654321"), name: name("Second Shop LLC") }
					])
					.insert(P.Employee, [
						{ id: fresh(7), employer: fresh(6), code: "E000001", name: name("Finn") }
					])
					.insert(P.TaxProfile, [{ employee: fresh(7), filing: "single", extra: cents(0n) }])
			),
		law: L.lawOf(approvers),
		witnesses: [{ kind: "key", relation: "Employer", values: { id: fresh(6) } }]
	},
	{
		change: "delete Approver { employer: acme, approver: ada }",
		role: "hr",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.hr,
				p.cs().delete(P.Approver, [{ employer: acme, approver: ada }])
			),
		law: L.lawOf(approvers),
		witnesses: [{ kind: "key", relation: "Employer", values: { id: acme } }]
	},
	{
		change: "add a PayLine with net 1 and no deposits",
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p
					.cs()
					.insert(P.PayRun, [draftRun(fresh(10))])
					.insert(P.PayLine, [
						{
							id: fresh(11),
							run: fresh(10),
							employee: ada,
							gross: cents(1n),
							net: cents(1n),
							offCycle: false
						}
					])
			),
		law: L.lawOf(depositAmount),
		witnesses: [{ kind: "key", relation: "PayLine", values: { id: fresh(11) } }]
	},
	{
		change: "add a Deposit of 1 cent to l1",
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p
					.cs()
					.insert(P.Deposit, [
						{ line: l1, account: "000111222333", amount: cents(1n), remainder: false }
					])
			),
		law: L.lawOf(depositAmount),
		witnesses: [{ kind: "key", relation: "PayLine", values: { id: l1 } }]
	},
	{
		change: "add three 0-cent Deposits to l1 at new accounts",
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p.cs().insert(P.Deposit, [
					{ line: l1, account: "000111000001", amount: cents(0n), remainder: false },
					{ line: l1, account: "000111000002", amount: cents(0n), remainder: false },
					{ line: l1, account: "000111000003", amount: cents(0n), remainder: false }
				])
			),
		law: L.lawOf(
			capacity(on(P.PayLine, "id"), { from: on(P.Deposit, "line"), within: within(0n, 4n) })
		),
		witnesses: [{ kind: "key", relation: "PayLine", values: { id: l1 } }]
	},
	{
		change: "put l1's 300000-cent deposit with remainder: true",
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p
					.cs()
					.put(P.Deposit, [
						{ line: l1, account: "000123456789", amount: cents(300_000n), remainder: true }
					])
			),
		/** The remainder bound: Deposit, selected by remainder = true, counted per PayLine. */
		law: L.lawOf(
			capacity(on(P.PayLine, "id"), {
				from: on(select(P.Deposit, { remainder: true }), "line"),
				within: within(0n, 1n)
			})
		),
		witnesses: [{ kind: "key", relation: "Deposit", values: { line: l1 } }]
	},
	{
		change: "add a PayLine with net above gross",
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p
					.cs()
					.insert(P.PayRun, [draftRun(fresh(12))])
					.insert(P.PayLine, [
						{
							id: fresh(13),
							run: fresh(12),
							employee: ada,
							gross: cents(100n),
							net: cents(200n),
							offCycle: false
						}
					])
					.insert(P.Deposit, [
						{ line: fresh(13), account: "000123456789", amount: cents(200n), remainder: true }
					])
			),
		/**
		 * The capacity of PayLine.net within [0, gross], lowered to a table CHECK, reports the capacity's law whatever
		 * its lowering, as the remainder bound's unique index does.
		 */
		law: L.lawOf(
			capacity(on(P.PayLine, "id"), {
				from: on(P.PayLine, "id"),
				weight: weigh("net"),
				within: within(0n, ref("gross"))
			})
		),
		witnesses: [unreported]
	},
	{
		change: "add an off-cycle PayLine with deposits and no OffCycleReason",
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p
					.cs()
					.insert(P.PayRun, [draftRun(fresh(14))])
					.insert(P.PayLine, [
						{
							id: fresh(15),
							run: fresh(14),
							employee: ada,
							gross: cents(100n),
							net: cents(100n),
							offCycle: true
						}
					])
					.insert(P.Deposit, [
						{ line: fresh(15), account: "000123456789", amount: cents(100n), remainder: true }
					])
			),
		law: offCycleReasons.leftToRight,
		witnesses: [{ kind: "key", relation: "PayLine", values: { id: fresh(15) } }]
	},
	{
		change: "insert an OffCycleReason for l1",
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p.cs().insert(P.OffCycleReason, [{ line: l1, reason: "not off-cycle at all" }])
			),
		law: offCycleReasons.rightToLeft,
		witnesses: [unreported]
	},
	{
		change:
			'put LevyLine { line: l1, levy: "SocialSecurity", employeeRate: 0.05, withheld: 25000 }',
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p.cs().put(P.LevyLine, [
					{
						line: l1,
						levy: "SocialSecurity",
						employeeRate: P.Rate(Decimal.of("0.05")),
						withheld: cents(25_000n)
					}
				])
			),
		/**
		 * The containment into the closed tuples of Levy, which a finite CHECK enforces, reports the containment's law.
		 */
		law: L.lawOf(contained(on(P.LevyLine, "levy", "employeeRate"), on(Levy, "id", "employeeRate"))),
		witnesses: [unreported]
	},
	{
		change: 'as clerk, put run1 with stage: "approved" alone',
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p.cs().put(P.PayRun, [{ id: run1, employer: acme, period, stage: "approved" }])
			),
		law: L.lawOf(
			contained(on(select(P.PayRun, { stage: "approved" }), "id"), on(P.Approval, "run"))
		),
		witnesses: [{ kind: "key", relation: "PayRun", values: { id: run1 } }]
	},
	{
		change: "as clerk, insert a run run5 in stage paid with its Payment and no Approval",
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p
					.cs()
					.insert(P.PayRun, [{ id: fresh(16), employer: acme, period, stage: "paid" }])
					.insert(P.Payment, [{ run: fresh(16), settled: Instant(tSettled) }])
			),
		law: L.lawOf(contained(on(P.Payment, "run"), on(P.Approval, "run"))),
		witnesses: [unreported]
	},
	{
		change: "insert a new draft run run4 and a Reissue of it replacing run1, a draft",
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p
					.cs()
					.insert(P.PayRun, [draftRun(fresh(17))])
					.insert(P.Reissue, [{ run: fresh(17), replaces: run1 }])
			),
		law: L.lawOf(
			contained(on(P.Reissue, "replaces"), on(select(P.PayRun, { stage: "voided" }), "id"))
		),
		witnesses: [unreported]
	},
	{
		change: "insert a short approved Shift for bo labeled w1 beyond t9",
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p.cs().insert(P.Shift, [
					{
						employee: bo,
						during: span(t9 - hour, t9 + hour),
						week: P.Week(w1),
						status: "approved"
					}
				])
			),
		law: L.lawOf(
			contained(
				on(select(P.Shift, { status: "approved" }), "employee", "during"),
				on(P.Employment, "employee", "during")
			)
		),
		witnesses: [
			{
				kind: "key",
				relation: "Shift",
				values: { employee: bo, during: span(t9 - hour, t9 + hour) }
			}
		]
	},
	{
		change: "withhold applied again on its own, { run: run1 }",
		role: "clerk",
		changes: (p) => {
			const changes = p.cs().insert(P.Posting, p.postings)
			return {
				changes,
				outcome: p.f.withDb(p.w.server.roles.clerk, (db) =>
					applyRuntime(db, changes, { run: run1 })
				)
			}
		},
		law: L.lawOf(key(P.Posting, ["line", "account"])),
		witnesses: [
			postingKey(l1, "GrossWages"),
			postingKey(l1, "NetPay"),
			postingKey(l1, "Withholding"),
			postingKey(l2, "GrossWages"),
			postingKey(l2, "NetPay"),
			postingKey(l2, "Withholding")
		]
	}
]

/** approveRun's effect on run1, as enumerated facts. */
const approveRun = (p: Payroll): Attempt =>
	p.attempt(
		p.w.server.roles.approver,
		p
			.cs()
			.put(P.PayRun, [{ id: run1, employer: acme, period, stage: "approved" }])
			.insert(P.Approval, [{ run: run1, approver: ada, at: Instant(tApproved) }])
			.insert(P.Request, [{ id: request1, digest: digest1, result: "approved" }])
	)

const afterApproveRun: Arr.NonEmptyReadonlyArray<Case> = [
	{
		change: 'after approveRun, put run1 with stage: "paid" and no Payment',
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p.cs().put(P.PayRun, [{ id: run1, employer: acme, period, stage: "paid" }])
			),
		law: runStage.reverse,
		witnesses: [{ kind: "key", relation: "PayRun", values: { id: run1 } }]
	},
	{
		change: "after approveRun, insert a Payment for run1 and leave its stage approved",
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p.cs().insert(P.Payment, [{ run: run1, settled: Instant(tNow) }])
			),
		law: paymentArm,
		witnesses: [unreported]
	}
]

const afterPay: Arr.NonEmptyReadonlyArray<Case> = [
	{
		change:
			"after pay, apply voidAndReissue's enumerated put and Voiding to run1, keeping the Payment",
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p
					.cs()
					.put(P.PayRun, [{ id: run1, employer: acme, period, stage: "voided" }])
					.insert(P.Voiding, [{ run: run1, reason: "wrong period" }])
			),
		law: paymentArm,
		witnesses: [unreported]
	}
]

/** After voidAndReissue on a draft run2 with no lines. */
const afterVoidAndReissue: Arr.NonEmptyReadonlyArray<Case> = [
	{
		change:
			"after voidAndReissue, insert a draft run run7 and a Reissue of it replacing run2 again",
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p
					.cs()
					.insert(P.PayRun, [draftRun(fresh(18))])
					.insert(P.Reissue, [{ run: fresh(18), replaces: run2 }])
			),
		/** The capacity's law, whose upper bound of one is a unique index. */
		law: L.lawOf(
			capacity(on(P.PayRun, "id"), { from: on(P.Reissue, "replaces"), within: within(0n, 1n) })
		),
		witnesses: [{ kind: "key", relation: "Reissue", values: { replaces: run2 } }]
	}
]

/**
 * The w2 shift logged pending, inside employment, with no w2 timesheet, and the third w1 shift, 25 hours, which
 * takes the week's 16 approved hours past 40.
 */
const w2Shift = span(s4 + hour, s4 + 2n * hour)
const thirdShift = span(s4 + 3n * hour, s4 + 28n * hour)

/** approveShifts of `week` as the clerk. */
const approveShifts = (p: Payroll, week: bigint): Attempt => {
	const changes = p.cs().put(P.Shift, p.approveShifts)
	return {
		changes,
		outcome: p.f.withDb(p.w.server.roles.clerk, (db) =>
			applyRuntime(db, changes, { employee: bo, week: P.Week(week) })
		)
	}
}

const w2Case: Case = {
	change: "approveShifts for w2 after logging a pending w2 shift, with no w2 timesheet",
	role: "clerk",
	changes: (p) => approveShifts(p, w2),
	law: L.lawOf(
		contained(
			on(select(P.Shift, { status: "approved" }), "employee", "week"),
			on(P.Timesheet, "employee", "week")
		)
	),
	witnesses: [{ kind: "key", relation: "Shift", values: { employee: bo, during: w2Shift } }]
}

const ceilingCase: Case = {
	change: "approveShifts after logging a third pending w1 shift past forty hours",
	role: "clerk",
	changes: (p) => approveShifts(p, w1),
	law: L.lawOf(approvedHours),
	witnesses: [{ kind: "key", relation: "Timesheet", values: { employee: bo, week: w1 } }]
}

const afterApproveShifts: Arr.NonEmptyReadonlyArray<Case> = [
	{
		change: "after approveShifts, as hr, put Timesheet { employee: bo, week: w1, ceiling: 1 }",
		role: "hr",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.hr,
				p.cs().put(P.Timesheet, [{ employee: bo, week: P.Week(w1), ceiling: P.Micros(1n) }])
			),
		law: L.lawOf(approvedHours),
		witnesses: [{ kind: "key", relation: "Timesheet", values: { employee: bo, week: w1 } }]
	}
]

/** Every stored table's row count, as the owner: a refused ChangeSet leaves them all as they were. */
const tableCounts = (p: Payroll) =>
	p.f.rows(
		`SELECT c.relname::text, (xpath('/row/n/text()', pg_catalog.query_to_xml(format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = '${p.f.installed.schema}' AND c.relkind = 'r' ORDER BY 1`
	)

const text = (value: unknown): string => Formatter.format(value)

/** The row's db.apply outcome: `invariant-rejected` with its law and key-only witness. */
const runGrizzle = (c: Case, law: LawId, attempt: Attempt) =>
	Effect.gen(function* () {
		const outcome = yield* attempt.outcome
		assert.ok(outcome.kind === "invariant-rejected", `${c.change}: ${text(outcome)}`)
		assert.deepEqual(outcome.law, L.described(law), c.change)
		containsEqual(c.witnesses, outcome.witness, c.change)
	})

const runCase = (p: Payroll, c: Case) => runGrizzle(c, c.law, c.changes(p))

/**
 * Every row of `rows` applied on `p`, one after another in their order, as a finite space checked whole: each refusal
 * rolls back, so every row meets the state the rows start from.
 */
const everyRow = (suite: string, p: Payroll, rows: Arr.NonEmptyReadonlyArray<Case>) =>
	exhaust(
		{
			suite: `e2e-laws/payroll-invalid/${suite}`,
			generator: element(rows),
			literal: (c: Case) => Formatter.format(c.change),
			limit: rows.length,
			coverage: noCoverage,
			caseHang
		},
		(c: Case) => runCase(p, c)
	)

const accepted = (attempt: Attempt) =>
	Effect.gen(function* () {
		const outcome = yield* attempt.outcome
		assert.equal(outcome.kind, "accepted", text(outcome))
	})

/**
 * A pending shift of bo's. Shifts are logged and withdrawn by the clerk through grizzle: inserts into and an exact
 * deletion from Shift, whose primary key is a span key (the named-arbiter insert).
 */
const pendingShift = (during: { readonly start: bigint; readonly end: bigint }, week: bigint) => ({
	employee: bo,
	during: span(during.start, during.end),
	week: P.Week(week),
	status: "pending" as const
})

/**
 * The payroll example's invalid ChangeSets give their stated refusing laws.
 *
 * Each row of the invalid-ChangeSet table is applied through db.apply as the role whose write list holds it, from the
 * state the row names, and its outcome is `invariant-rejected` with the stated law and its witness: the insert
 * protocol's conflict row and a residual function's DETAIL give a key, host normalization gives the key it refused, the
 * insert protocol's probe of a unique object besides the arbiter gives the requested fact at that object's fields, and
 * a native violation whose key PostgreSQL reports only in its message is `unreported`; a domain constraint's
 * violation names the domain's law. A refusal rolls
 * everything back, so the rows that start from one state run one after another on one installation, and the state is
 * unchanged at the end.
 *
 * Every ChangeSet is built through the typed API, its contract values through their brand constructors (which check
 * nothing: the database does). The one row whose value the field's type itself refuses, an employee code that is not
 * `E` and six digits, is a JavaScript caller's: it is built with the runtime ChangeSet builder and applied
 * through the Db's runtime (test/support/runtime-db.ts), as such a caller's value would be.
 */
export const payrollInvalidSuite = (): void => {
	layer(Substrate.layer, { excludeTestServices: true })(
		"the payroll example's invalid ChangeSets give their stated refusing laws",
		(it) => {
			it.effect("from the state after onboard, logShifts and draftRun", (ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const p = yield* openPayroll
						const before = yield* tableCounts(p)
						const exhausted = yield* everyRow("state-a", p, fromStateA)
						const counts = yield* tableCounts(p)
						assert.deepEqual(counts, before, "every refusal rolled back")
						return exhausted
					}).pipe(Effect.scoped)
				)
			)

			it.effect("after approveRun, and after pay", (ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const p = yield* openPayroll
						yield* accepted(approveRun(p))
						yield* everyRow("after-approve-run", p, afterApproveRun)
						/** The pay ChangeSet: the run settles with its Payment. */
						const pay = p.cs().put(P.PayRun, p.payPut).insert(P.Payment, p.payPayment)
						yield* accepted({
							changes: pay,
							outcome: p.f.withDb(p.w.server.roles.clerk, (db) =>
								applyRuntime(db, pay, { run: run1, now: Instant(tNow) })
							)
						})
						return yield* everyRow("after-pay", p, afterPay)
					}).pipe(Effect.scoped)
				)
			)

			it.effect("after voidAndReissue", (ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const p = yield* openPayroll
						yield* accepted(
							p.attempt(p.w.server.roles.clerk, p.cs().insert(P.PayRun, [draftRun(run2)]))
						)
						yield* accepted(
							p.attempt(
								p.w.server.roles.clerk,
								p
									.cs()
									.put(P.PayRun, [{ id: run2, employer: acme, period, stage: "voided" }])
									.insert(P.Voiding, [{ run: run2, reason: "wrong period" }])
									.insert(P.PayRun, [draftRun(run3)])
									.insert(P.Reissue, [{ run: run3, replaces: run2 }])
							)
						)
						return yield* everyRow("after-void-and-reissue", p, afterVoidAndReissue)
					}).pipe(Effect.scoped)
				)
			)

			it.effect(
				"approving shifts without a timesheet or past the ceiling, and lowering the ceiling",
				(ctx) =>
					searched(
						ctx,
						Effect.gen(function* () {
							const p = yield* openPayroll
							const log = (
								during: { readonly start: bigint; readonly end: bigint },
								week: bigint
							) =>
								accepted(
									p.attempt(
										p.w.server.roles.clerk,
										p.cs().insert(P.Shift, [pendingShift(during, week)])
									)
								)
							yield* log(w2Shift, w2)
							yield* runCase(p, w2Case)
							yield* log(thirdShift, w1)
							yield* runCase(p, ceilingCase)
							yield* accepted(
								p.attempt(
									p.w.server.roles.clerk,
									p.cs().delete(P.Shift, [pendingShift(thirdShift, w1)])
								)
							)
							yield* accepted(approveShifts(p, w1))
							const rows = yield* p.f.rows(
								`SELECT "week"::text, "status"::text, count(*)::text FROM $S."shift" GROUP BY 1, 2 ORDER BY 1, 2`
							)
							assert.deepEqual(rows, [
								[String(w1), "approved", "2"],
								[String(w2), "pending", "1"]
							])
							return yield* everyRow("after-approve-shifts", p, afterApproveShifts)
						}).pipe(Effect.scoped)
					)
			)
		}
	)
}
