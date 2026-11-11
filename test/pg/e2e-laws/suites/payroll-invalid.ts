import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import type { Witness } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { Decimal, type Infer, type Span, type Uuid } from "#compiler/public/fields.ts"
import {
	alternatives,
	check,
	contained,
	type Fact,
	key,
	on,
	select
} from "#compiler/public/schema.ts"
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
	w1
} from "#test/support/fixtures/golden/payroll.ts"
import { installationNamesOf, installationOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { refusedLaws } from "#test/support/refused.ts"
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
	/** The row's ChangeSet applied as `role` through its login's served file. */
	readonly changes: (p: Payroll) => Attempt
	/** The law the outcome names. */
	readonly law: LawId
	/**
	 * The witnesses the outcome may carry, its one: a key, or `unreported` for a foreign key's violation, which
	 * PostgreSQL states only in its message; a check's, a contract's or a pattern's names the stated fact the host
	 * finds breaking it. Several only where the ChangeSet submits several facts that collide at once, and the refusal names the
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
const { LevyRate, Stage } = P.Payroll.relations
const runStage = L.alternativesOf(
	alternatives(P.PayRun, "stage", Stage, { paid: P.Payment, voided: P.Voiding })
)
const paymentArm = defined(runStage.arms["paid"], "the paid arm's law")
/**
 * The off-cycle lines and their reasons: the payroll's mirrors, whose two containments are each a law, an off-cycle line
 * having its reason and a reason's line being off-cycle.
 */
const offCycleLines = on(
	select(P.PayLine, (l) => l.eq(l.offCycle, true)),
	"id"
)
const reasonLines = on(P.OffCycleReason, "line")
const offCycleHasReason = L.lawOf(contained(offCycleLines, reasonLines))
const reasonIsOffCycle = L.lawOf(contained(reasonLines, offCycleLines))

/**
 * The laws capacity stated, each by fin.md §6 a row check on a family's owner: its count, or its sum fold's end. Each is
 * read through the naming door from the check the fixture declares.
 */
const atLeastOneApprover = L.lawOf(
	check("AtLeastOneApprover", P.Employer, (e) => e.ge(e.approvers, 1n))
)
const atMostFourDeposits = L.lawOf(
	check("AtMostFourDeposits", P.PayLine, (l) => l.le(l.deposits, 4n))
)
const depositsSumToNet = L.lawOf(
	check("DepositsSumToNet", P.PayLine, (l) => l.eq(l.deposited, l.net))
)
const netWithinGross = L.lawOf(check("NetWithinGross", P.PayLine, (l) => l.le(l.net, l.gross)))
const approvedHoursWithinCeiling = L.lawOf(
	check("ApprovedHoursWithinCeiling", P.Timesheet, (t) =>
		t.le(t.approvedHours, Compute.base(t.ceiling))
	)
)
/** At most one remainder deposit per line: a key over the selected side (fin.md §6, "at most one"). */
const oneRemainder = L.lawOf(
	key(
		on(
			select(P.Deposit, (d) => d.eq(d.remainder, true)),
			"line"
		)
	)
)

/**
 * A draft run and its one line for ada, inserted fresh by the clerk with the line's deposits as rows naming the line: a
 * pay line's deposits are a counted family, a set of Deposit rows keyed by (line, account), whose count and sum grizzle
 * draws.
 */
const freshLine =
	(
		n: number,
		line: { readonly gross: bigint; readonly net: bigint; readonly offCycle: boolean },
		deposits: ReadonlyArray<{
			readonly account: `${number}`
			readonly amount: bigint
			readonly remainder: boolean
		}>
	) =>
	(p: Payroll): Attempt =>
		p.attempt(
			p.w.server.roles.clerk,
			p.cs().insert(P.PayRun, []).insert(P.PayLine, []).insert(P.Deposit, []),
			{
				insert: {
					PayRun: [draftRun(fresh(n))],
					PayLine: [
						{
							id: fresh(n + 1),
							run: fresh(n),
							employee: ada,
							gross: cents(line.gross),
							net: cents(line.net),
							offCycle: line.offCycle
						}
					],
					Deposit: Arr.map(deposits, (d) => ({ ...d, line: fresh(n + 1), amount: cents(d.amount) }))
				}
			}
		)

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
			p.attempt(p.w.server.roles.hr, p.cs().insert(P.Employee, []), {
				insert: {
					Employee: [{ id: ada, employer: acme, code: "E000001", name: name("Ada Lovelace") }]
				}
			}),
		law: L.primaryKeyLaw(P.Employee),
		witnesses: [{ kind: "key", relation: "Employee", values: { id: ada } }]
	},
	{
		change: "two puts of TaxProfile bo with different filings",
		role: "hr",
		changes: (p) =>
			p.attempt(p.w.server.roles.hr, p.cs().put(P.TaxProfile, []), {
				put: {
					TaxProfile: [
						{ employee: bo, filing: "joint", extra: cents(2_500n) },
						{ employee: bo, filing: "head", extra: cents(2_500n) }
					]
				}
			}),
		law: L.primaryKeyLaw(P.TaxProfile),
		witnesses: [{ kind: "key", relation: "TaxProfile", values: { employee: bo } }]
	},
	{
		change: "insert a second Employer with acme's EIN",
		role: "hr",
		changes: (p) =>
			p.attempt(p.w.server.roles.hr, p.cs().insert(P.Employer, []).insert(P.Approver, []), {
				insert: {
					Employer: [{ id: fresh(1), ein: P.Ein("12-3456789"), name: name("Other Tools LLC") }],
					Approver: [{ employer: fresh(1), approver: ada }]
				}
			}),
		law: L.lawOf(key(on(P.Employer, "ein"))),
		witnesses: [{ kind: "key", relation: "Employer", values: { ein: P.Ein("12-3456789") } }]
	},
	{
		change: "put ReportsTo { employee: bo, manager: bo }",
		role: "hr",
		changes: (p) =>
			p.attempt(p.w.server.roles.hr, p.cs().put(P.ReportsTo, []), {
				put: { ReportsTo: [{ employee: bo, manager: bo }] }
			}),
		law: L.lawOf(check("NotOwnManager", P.ReportsTo, (x) => x.ne(x.employee, x.manager))),
		/** The put states the row the check refuses, so the host names its key. */
		witnesses: [{ kind: "key", relation: "ReportsTo", values: { employee: bo } }]
	},
	{
		change: "insert ReportsTo { employee: ada, manager: <no employee> }",
		role: "hr",
		changes: (p) =>
			p.attempt(p.w.server.roles.hr, p.cs().insert(P.ReportsTo, []), {
				insert: { ReportsTo: [{ employee: ada, manager: fresh(2) }] }
			}),
		law: L.lawOf(contained(on(P.ReportsTo, "manager"), on(P.Employee, "id"))),
		witnesses: [unreported]
	},
	{
		change: 'insert an Employee with code "X1" through an untyped path',
		role: "hr",
		/** The typed facts of Employee refuse "X1"; a JavaScript caller's facts send it, and the domain refuses it. */
		changes: (p) =>
			p.attempt(p.w.server.roles.hr, p.cs().insert(P.Employee, []).insert(P.TaxProfile, []), {
				insert: {
					Employee: [{ id: fresh(3), employer: acme, code: "X1", name: "Xavier" }],
					TaxProfile: [{ employee: fresh(3), filing: "single", extra: 0n }]
				}
			}),
		law: L.patternLaw(P.Employee, "code"),
		witnesses: [{ kind: "key", relation: "Employee", values: { id: fresh(3) } }]
	},
	{
		change: "insert an Employee with its TaxProfile whose name is 301 characters",
		role: "hr",
		changes: (p) =>
			p.attempt(p.w.server.roles.hr, p.cs().insert(P.Employee, []).insert(P.TaxProfile, []), {
				insert: {
					Employee: [
						{ id: fresh(4), employer: acme, code: "E000009", name: name(Str.repeat(301)("n")) }
					],
					TaxProfile: [{ employee: fresh(4), filing: "single", extra: cents(0n) }]
				}
			}),
		law: L.contract("LegalName").law,
		witnesses: [{ kind: "key", relation: "Employee", values: { id: fresh(4) } }]
	},
	{
		change: 'put TaxProfile { employee: bo, filing: "joint", extra: Cents(-1n) }',
		role: "hr",
		changes: (p) =>
			p.attempt(p.w.server.roles.hr, p.cs().put(P.TaxProfile, []), {
				put: { TaxProfile: [{ employee: bo, filing: "joint", extra: cents(-1n) }] }
			}),
		law: L.contract("Cents").law,
		witnesses: [{ kind: "key", relation: "TaxProfile", values: { employee: bo } }]
	},
	{
		change: "insert Employment { employee: ada, during: [t5, t12) }",
		role: "hr",
		changes: (p) =>
			p.attempt(p.w.server.roles.hr, p.cs().insert(P.Employment, []), {
				insert: { Employment: [{ employee: ada, during: span(t5, t12), basis: "salaried" }] }
			}),
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
			p.attempt(p.w.server.roles.hr, p.cs().delete(P.Assignment, []), {
				delete: { Assignment: [{ employee: bo, during: span(t5, t9), costCenter: "CC-0200" }] }
			}),
		law: L.lawOf(
			contained(on(P.Employment, "employee", "during"), on(P.Assignment, "employee", "during"))
		),
		witnesses: [unreported]
	},
	{
		change: "insert Salary for bo, whose employment is hourly",
		role: "hr",
		changes: (p) =>
			p.attempt(p.w.server.roles.hr, p.cs().insert(P.Salary, []), {
				insert: { Salary: [{ employee: bo, during: span(t0, t9), annual: cents(5_000_000n) }] }
			}),
		law: L.lawOf(
			contained(
				on(P.Salary, "employee", "during"),
				on(
					select(P.Employment, (e) => e.eq(e.basis, "salaried")),
					"employee",
					"during"
				)
			)
		),
		witnesses: [unreported]
	},
	{
		change: "insert Leave { employee: ada, during: [t9, t12) }",
		role: "hr",
		changes: (p) =>
			p.attempt(p.w.server.roles.hr, p.cs().insert(P.Leave, []), {
				insert: { Leave: [{ employee: ada, during: span(t9, t12), reason: "vacation" }] }
			}),
		law: L.lawOf(
			contained(on(P.Leave, "employee", "during"), on(P.Employment, "employee", "during"))
		),
		witnesses: [unreported]
	},
	{
		change: "insert an Employee without a TaxProfile",
		role: "hr",
		changes: (p) =>
			p.attempt(p.w.server.roles.hr, p.cs().insert(P.Employee, []), {
				insert: { Employee: [{ id: fresh(5), employer: acme, code: "E000010", name: name("Eve") }] }
			}),
		law: L.lawOf(contained(on(P.Employee, "id"), on(P.TaxProfile, "employee"))),
		witnesses: [unreported]
	},
	{
		change: "onboard a second employer, its employee and the profile, with no Approver",
		role: "hr",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.hr,
				p.cs().insert(P.Employer, []).insert(P.Employee, []).insert(P.TaxProfile, []),
				{
					insert: {
						Employer: [{ id: fresh(6), ein: P.Ein("98-7654321"), name: name("Second Shop LLC") }],
						Employee: [{ id: fresh(7), employer: fresh(6), code: "E000001", name: name("Finn") }],
						TaxProfile: [{ employee: fresh(7), filing: "single", extra: cents(0n) }]
					}
				}
			),
		law: atLeastOneApprover,
		/** The inserted employer holds its family empty, so the host judges its count 0 and names it. */
		witnesses: [{ kind: "key", relation: "Employer", values: { id: fresh(6) } }]
	},
	{
		change: "add a PayLine with net 1 and no deposits",
		role: "clerk",
		changes: freshLine(10, { gross: 1n, net: 1n, offCycle: false }, []),
		law: depositsSumToNet,
		witnesses: [{ kind: "key", relation: "PayLine", values: { id: fresh(11) } }]
	},
	{
		change: "add a PayLine with net 300 whose two deposits sum to 299",
		role: "clerk",
		changes: freshLine(20, { gross: 300n, net: 300n, offCycle: false }, [
			{ account: "000123456789", amount: 200n, remainder: false },
			{ account: "000987654321", amount: 99n, remainder: true }
		]),
		law: depositsSumToNet,
		witnesses: [{ kind: "key", relation: "PayLine", values: { id: fresh(21) } }]
	},
	{
		change: "add a PayLine with five 1-cent deposits",
		role: "clerk",
		changes: freshLine(
			22,
			{ gross: 5n, net: 5n, offCycle: false },
			Arr.map(
				["000111000001", "000111000002", "000111000003", "000111000004", "000111000005"] as const,
				(account) => ({ account, amount: 1n, remainder: false })
			)
		),
		law: atMostFourDeposits,
		witnesses: [{ kind: "key", relation: "PayLine", values: { id: fresh(23) } }]
	},
	{
		change: "add a PayLine with two remainder deposits",
		role: "clerk",
		changes: freshLine(24, { gross: 300n, net: 300n, offCycle: false }, [
			{ account: "000123456789", amount: 200n, remainder: true },
			{ account: "000987654321", amount: 100n, remainder: true }
		]),
		/**
		 * The second remainder deposit meets the first at the selected side's UNIQUE over its law column. The members are
		 * written by the family's own statement, not the insert protocol, so the witness is the line the key refuses, or
		 * none where PostgreSQL states the key only in its message.
		 */
		law: oneRemainder,
		witnesses: [{ kind: "key", relation: "Deposit", values: { line: fresh(25) } }, unreported]
	},
	{
		change: "add a PayLine with net above gross",
		role: "clerk",
		changes: freshLine(12, { gross: 100n, net: 200n, offCycle: false }, [
			{ account: "000123456789", amount: 200n, remainder: true }
		]),
		/** A row check on the line itself: fin.md §6, "source equal to target". The host names the stated line. */
		law: netWithinGross,
		witnesses: [{ kind: "key", relation: "PayLine", values: { id: fresh(13) } }]
	},
	{
		change: "add an off-cycle PayLine with deposits and no OffCycleReason",
		role: "clerk",
		changes: (p) =>
			p.attempt(
				p.w.server.roles.clerk,
				p.cs().insert(P.PayRun, []).insert(P.PayLine, []).insert(P.Deposit, []),
				{
					insert: {
						PayRun: [draftRun(fresh(14))],
						PayLine: [
							{
								id: fresh(15),
								run: fresh(14),
								employee: ada,
								gross: cents(100n),
								net: cents(100n),
								offCycle: true
							}
						],
						Deposit: [
							{ line: fresh(15), account: "000123456789", amount: cents(100n), remainder: true }
						]
					}
				}
			),
		law: offCycleHasReason,
		witnesses: [unreported]
	},
	{
		change: "insert an OffCycleReason for l1",
		role: "clerk",
		changes: (p) =>
			p.attempt(p.w.server.roles.clerk, p.cs().insert(P.OffCycleReason, []), {
				insert: { OffCycleReason: [{ line: l1, reason: "not off-cycle at all" }] }
			}),
		law: reasonIsOffCycle,
		witnesses: [unreported]
	},
	{
		change:
			'put LevyLine { line: l1, levy: "SocialSecurity", employeeRate: 0.05, withheld: 25000 }',
		role: "clerk",
		changes: (p) =>
			p.attempt(p.w.server.roles.clerk, p.cs().put(P.LevyLine, []), {
				put: {
					LevyLine: [
						{
							line: l1,
							levy: "SocialSecurity",
							employeeRate: P.Rate(Decimal.of("0.05")),
							withheld: cents(25_000n)
						}
					]
				}
			}),
		/**
		 * The containment into the closed relation LevyRate, a table CHECK over its constant, reports its own law, and
		 * the host names the put row no LevyRate row meets.
		 */
		law: L.lawOf(
			contained(on(P.LevyLine, "levy", "employeeRate"), on(LevyRate, "levy", "employeeRate"))
		),
		witnesses: [{ kind: "key", relation: "LevyLine", values: { line: l1, levy: "SocialSecurity" } }]
	},
	{
		change: 'as clerk, put run1 with stage: "approved" alone',
		role: "clerk",
		changes: (p) =>
			p.attempt(p.w.server.roles.clerk, p.cs().put(P.PayRun, []), {
				put: { PayRun: [{ id: run1, employer: acme, period, stage: "approved" }] }
			}),
		law: L.lawOf(
			contained(
				on(
					select(P.PayRun, (r) => r.eq(r.stage, "approved")),
					"id"
				),
				on(P.Approval, "run")
			)
		),
		witnesses: [unreported]
	},
	{
		change: "as clerk, insert a run run5 in stage paid with its Payment and no Approval",
		role: "clerk",
		changes: (p) =>
			p.attempt(p.w.server.roles.clerk, p.cs().insert(P.PayRun, []).insert(P.Payment, []), {
				insert: {
					PayRun: [{ id: fresh(16), employer: acme, period, stage: "paid" }],
					Payment: [{ run: fresh(16), settled: Instant(tSettled) }]
				}
			}),
		law: L.lawOf(contained(on(P.Payment, "run"), on(P.Approval, "run"))),
		witnesses: [unreported]
	},
	{
		change: "insert a new draft run run4 and a Reissue of it replacing run1, a draft",
		role: "clerk",
		changes: (p) =>
			p.attempt(p.w.server.roles.clerk, p.cs().insert(P.PayRun, []).insert(P.Reissue, []), {
				insert: { PayRun: [draftRun(fresh(17))], Reissue: [{ run: fresh(17), replaces: run1 }] }
			}),
		law: L.lawOf(
			contained(
				on(P.Reissue, "replaces"),
				on(
					select(P.PayRun, (r) => r.eq(r.stage, "voided")),
					"id"
				)
			)
		),
		witnesses: [unreported]
	},
	{
		change: "insert a short approved Shift for bo labeled w1 beyond t9",
		role: "clerk",
		changes: (p) =>
			p.attempt(p.w.server.roles.clerk, p.cs().insert(P.Shift, []), {
				insert: {
					Shift: [
						{
							employee: bo,
							during: span(t9 - hour, t9 + hour),
							week: P.Week(w1),
							status: "approved"
						}
					]
				}
			}),
		law: L.lawOf(
			contained(
				on(
					select(P.Shift, (s) => s.eq(s.status, "approved")),
					"employee",
					"during"
				),
				on(P.Employment, "employee", "during")
			)
		),
		/** A PERIOD foreign key from the approved shift's range law column: its violation names no fact. */
		witnesses: [unreported]
	},
	{
		change:
			"insert two approved Shifts for bo labeled w1 whose forty-one hours pass its forty-hour ceiling",
		role: "clerk",
		changes: (p) =>
			p.attempt(p.w.server.roles.clerk, p.cs().insert(P.Shift, []), {
				insert: {
					Shift: [
						{
							employee: bo,
							during: span(s4 + hour, s4 + 2n * hour),
							week: P.Week(w1),
							status: "approved"
						},
						{
							employee: bo,
							during: span(s4 + 3n * hour, s4 + 43n * hour),
							week: P.Week(w1),
							status: "approved"
						}
					]
				}
			}),
		/**
		 * The sum fold of the approved shifts' generated hours, each shift counted once by its key, its end on bo's w1
		 * timesheet, held to the ceiling by a row check (fin.md §6, "duration" then "weighted").
		 */
		law: approvedHoursWithinCeiling,
		witnesses: [unreported]
	},
	{
		change:
			'insert Posting { line: l1, account: "GrossWages", side: "debit", amount: Cents(500_001n) }',
		role: "clerk",
		changes: (p) =>
			p.attempt(p.w.server.roles.clerk, p.cs().insert(P.Posting, []), {
				insert: {
					Posting: [{ line: l1, account: "GrossWages", side: "debit", amount: cents(500_001n) }]
				}
			}),
		/**
		 * A generated addition, its entry drawn, meets stored postings at key(line, account), the first declared key that
		 * holds no drawn field: l1's stored GrossWages posting is 500_000, so the request is a conflict there, never an
		 * exact repeat, which would change nothing.
		 */
		law: L.lawOf(key(on(P.Posting, "line", "account"))),
		witnesses: [postingKey(l1, "GrossWages")]
	}
]

/** approveRun's effect on run1, as enumerated facts. */
const approveRun = (p: Payroll): Attempt =>
	p.attempt(
		p.w.server.roles.approver,
		p.cs().put(P.PayRun, []).insert(P.Approval, []).insert(P.Request, []),
		{
			put: { PayRun: [{ id: run1, employer: acme, period, stage: "approved" }] },
			insert: {
				Approval: [{ run: run1, approver: ada, at: Instant(tApproved) }],
				Request: [{ id: request1, digest: digest1, result: "approved" }]
			}
		}
	)

const afterApproveRun: Arr.NonEmptyReadonlyArray<Case> = [
	{
		change: 'after approveRun, put run1 with stage: "paid" and no Payment',
		role: "clerk",
		changes: (p) =>
			p.attempt(p.w.server.roles.clerk, p.cs().put(P.PayRun, []), {
				put: { PayRun: [{ id: run1, employer: acme, period, stage: "paid" }] }
			}),
		/**
		 * The paid runs in the paid arm: a native foreign key from the run's generated law column, deferred on the cycle,
		 * so it names no fact.
		 */
		law: defined(runStage.reverse["paid"], "the paid handle's reverse law"),
		witnesses: [unreported]
	},
	{
		change: "after approveRun, insert a Payment for run1 and leave its stage approved",
		role: "clerk",
		changes: (p) =>
			p.attempt(p.w.server.roles.clerk, p.cs().insert(P.Payment, []), {
				insert: { Payment: [{ run: run1, settled: Instant(tNow) }] }
			}),
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
			p.attempt(p.w.server.roles.clerk, p.cs().put(P.PayRun, []).insert(P.Voiding, []), {
				put: { PayRun: [{ id: run1, employer: acme, period, stage: "voided" }] },
				insert: { Voiding: [{ run: run1, reason: "wrong period" }] }
			}),
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
			p.attempt(p.w.server.roles.clerk, p.cs().insert(P.PayRun, []).insert(P.Reissue, []), {
				insert: { PayRun: [draftRun(fresh(18))], Reissue: [{ run: fresh(18), replaces: run2 }] }
			}),
		/** At most one reissue per run: a key over Reissue's `replaces` (fin.md §6, "at most one"). */
		law: L.lawOf(key(on(P.Reissue, "replaces"))),
		witnesses: [{ kind: "key", relation: "Reissue", values: { replaces: run2 } }]
	}
]

/** Every stored table's row count, as the owner: a refused ChangeSet leaves them all as they were. */
const tableCounts = (p: Payroll) =>
	p.f.rows(
		`SELECT c.relname::text, (xpath('/row/n/text()', pg_catalog.query_to_xml(format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = '${p.f.installed.schema}' AND c.relkind = 'r' ORDER BY 1`
	)

const text = (value: unknown): string => Formatter.format(value)

/**
 * The row's outcome: `invariant-rejected` with its one law and a key-only witness. No law of the payroll merges
 * into another's native object, so every refusal names one law.
 */
const runGrizzle = (c: Case, law: LawId, attempt: Attempt) =>
	Effect.gen(function* () {
		const outcome = yield* attempt.outcome
		assert.ok(outcome.kind === "invariant-rejected", `${c.change}: ${text(outcome)}`)
		assert.deepEqual(refusedLaws(outcome.refused), [L.described(law)], c.change)
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
			box: { kind: "unstated" },
			oracle: { kind: "unstated" },
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
 * The payroll example's invalid ChangeSets give their stated refusing laws.
 *
 * Each row of the invalid-ChangeSet table is applied as the role whose write list holds it, from the
 * state the row names, and its outcome is `invariant-rejected` with the stated law and its witness: the insert
 * protocol's conflict row gives a key, host normalization gives the key it refused, the insert protocol's probe of a
 * unique object besides the arbiter gives the requested fact at that object's fields, and a native violation whose key
 * PostgreSQL reports only in its message is `unreported`; a domain constraint's violation names the domain's law.
 * Every law is native: the laws capacity stated are keys over a side and row checks on a counted family's owner, its
 * count or its sum fold's end (fin.md §6), and a counted family's members are rows naming their owner. A refusal rolls
 * everything back, so the rows that start from one state run one after another on one installation, and the state is
 * unchanged at the end.
 *
 * Every ChangeSet is built through the typed API and applied through the role's login's served file, its array members
 * taking each call's facts by op and relation, its contract values through their brand constructors (which check
 * nothing: the database does). The one row whose value the field's type itself refuses, an employee code that is not
 * `E` and six digits, is a JavaScript caller's facts, as such a caller's value would be.
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
						yield* accepted(
							p.called(
								p.w.server.roles.clerk,
								p.cs().put(P.PayRun, p.payPut).insert(P.Payment, p.payPayment),
								{ run: run1, now: Instant(tNow) }
							)
						)
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
							p.attempt(p.w.server.roles.clerk, p.cs().insert(P.PayRun, []), {
								insert: { PayRun: [draftRun(run2)] }
							})
						)
						yield* accepted(
							p.attempt(
								p.w.server.roles.clerk,
								p
									.cs()
									.put(P.PayRun, [])
									.insert(P.Voiding, [])
									.insert(P.PayRun, [])
									.insert(P.Reissue, []),
								{
									put: { PayRun: [{ id: run2, employer: acme, period, stage: "voided" }] },
									insert: {
										Voiding: [{ run: run2, reason: "wrong period" }],
										PayRun: [draftRun(run3)],
										Reissue: [{ run: run3, replaces: run2 }]
									}
								}
							)
						)
						return yield* everyRow("after-void-and-reissue", p, afterVoidAndReissue)
					}).pipe(Effect.scoped)
				)
			)
		}
	)
}
