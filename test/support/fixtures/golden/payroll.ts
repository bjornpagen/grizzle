/**
 * The payroll example's golden values: the fixture states, the member facts of its ChangeSets, and the outcome table of
 * its direct psql writers, stated exactly.
 *
 * The example's symbolic constants are fixed here: instants are epoch microseconds from 2026-01-01T00:00Z, with
 * t0 < t5 < t9 < t12 a few days apart, the run period [p0, p1) inside [t0, t9), two eight-hour pending shifts inside
 * employment, and weeks counted since the epoch. The facts of stateA are exactly the state the invalid ChangeSets and
 * the direct writers start from, after onboard, logShifts and draftRun.
 */
import { Array as Arr, String as Str } from "effect"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { id } from "#test/support/fixtures/golden/types.ts"
import { capacity, contained, on, onSelected, within } from "#test/support/fixtures/ir/desc.ts"
import * as P from "#test/support/fixtures/ir/payroll.ts"
import { installationNamesOf, installationOf } from "#test/support/kernel/naming.ts"

/**
 * The names of the payroll installation, through the naming door: its schema is the declared `payroll`, so the quoted
 * qualified names the rows spell are the installer's.
 */
const payroll = installationNamesOf(installationOf(P.PayrollDesc, { kind: "declared" }))
/** The law of PayLine's deposit amounts summing to its net, a residual law over PayLine and Deposit. */
const depositAmount = payroll.lawOfDesc(
	capacity(on("PayLine", ["id"]), on("Deposit", ["line"]), within("net", "net"), {
		kind: "field",
		field: "amount"
	})
)

/** The law of an approved run's approval. */
const approvedRunApproval = payroll.lawOfDesc(
	contained(onSelected("PayRun", ["id"], { stage: "approved" }), on("Approval", ["run"]))
)

export const acme = id(1, 1)
export const ada = id(2, 1)
export const bo = id(2, 2)
export const run1 = id(3, 1)
export const run2 = id(3, 2)
export const run3 = id(3, 3)
export const l1 = id(4, 1)
export const l2 = id(4, 2)
export const request1 = id(5, 1)

const base = 1_767_225_600_000_000n
const day = 86_400_000_000n
const hour = 3_600_000_000n
export const t0 = base
export const t5 = base + 5n * day
export const t9 = base + 9n * day
export const t12 = base + 12n * day
export const p0 = base + day
export const p1 = base + 8n * day
const s1 = base + day + 9n * hour
const s2 = s1 + 8n * hour
const s3 = base + 2n * day + 9n * hour
export const s4 = s3 + 8n * hour
export const w1 = 2922n
export const w2 = 2923n
/** approveRun's now, run2's settlement in stateB, and the now run1 is paid at. */
export const tApproved = p1 + hour
export const tSettled = p1 + 2n * hour
export const tNow = p1 + 3n * hour
export const digest1 = Str.repeat(32)("5e")

const span = (start: bigint, end: bigint) => ({ start, end })
const dec = (exact: string): Decimal => Decimal.of(exact)

export type Facts = Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>

/** onboard, logShifts (828-831) and draftLines (847-858), as enumerated member facts. */
const onboardFacts: Facts = {
	Employer: [{ id: acme, ein: "12-3456789", name: "Acme Tools LLC" }],
	Employee: [
		{ id: ada, employer: acme, code: "E000001", name: "Ada Byron" },
		{ id: bo, employer: acme, code: "E000002", name: "Bo Diaz" }
	],
	TaxProfile: [
		{ employee: ada, filing: "single", extra: 0n },
		{ employee: bo, filing: "joint", extra: 2_500n }
	],
	ReportsTo: [{ employee: bo, manager: ada }],
	Approver: [{ employer: acme, approver: ada }],
	Employment: [
		{ employee: ada, during: span(t0, t9), basis: "salaried" },
		{ employee: bo, during: span(t0, t9), basis: "hourly" }
	],
	Assignment: [
		{ employee: ada, during: span(t0, t9), costCenter: "CC-0100" },
		{ employee: bo, during: span(t0, t5), costCenter: "CC-0100" },
		{ employee: bo, during: span(t5, t9), costCenter: "CC-0200" }
	],
	Salary: [{ employee: ada, during: span(t0, t9), annual: 12_000_000n }],
	/** 40 hours. */
	Timesheet: [{ employee: bo, week: w1, ceiling: 144_000_000_000n }]
}

const logShiftsFacts: Facts = {
	Shift: [
		{ employee: bo, during: span(s1, s2), week: w1, status: "pending" },
		{ employee: bo, during: span(s3, s4), week: w1, status: "pending" }
	]
}

const draftLinesFacts: Facts = {
	PayRun: [{ id: run1, employer: acme, period: span(p0, p1), stage: "draft" }],
	PayLine: [
		{ id: l1, run: run1, employee: ada, gross: 500_000n, net: 390_000n, offCycle: false },
		{ id: l2, run: run1, employee: bo, gross: 120_000n, net: 98_000n, offCycle: true }
	],
	OffCycleReason: [{ line: l2, reason: "missed shift from the prior period" }],
	Deposit: [
		{ line: l1, account: "000123456789", amount: 300_000n, remainder: false },
		{ line: l1, account: "000987654321", amount: 90_000n, remainder: true },
		{ line: l2, account: "000555000111", amount: 98_000n, remainder: true }
	]
}

/**
 * withhold's members over run1: withholdingFor's rows and the three posting arms' rows. Gross times
 * the rate, rounded half away from zero: 500000 x 0.062 = 31000, x 0.0145 = 7250; 120000 x 0.062 = 7440, x 0.0145 =
 * 1740; Futa withholds nothing from the employee.
 */
type LevyLineRow = {
	readonly line: string
	readonly levy: string
	readonly employeeRate: Decimal
	readonly withheld: bigint
}

const withholdLevyLines: ReadonlyArray<LevyLineRow> = [
	{ line: l1, levy: "SocialSecurity", employeeRate: dec("0.062"), withheld: 31_000n },
	{ line: l1, levy: "Medicare", employeeRate: dec("0.0145"), withheld: 7_250n },
	{ line: l1, levy: "Futa", employeeRate: dec("0"), withheld: 0n },
	{ line: l2, levy: "SocialSecurity", employeeRate: dec("0.062"), withheld: 7_440n },
	{ line: l2, levy: "Medicare", employeeRate: dec("0.0145"), withheld: 1_740n },
	{ line: l2, levy: "Futa", employeeRate: dec("0"), withheld: 0n }
]

/**
 * The Posting member's generated additions (no entry): every line's gross as a debit, its net and its withholding as
 * credits.
 */
type PostingAddition = {
	readonly line: string
	readonly account: string
	readonly side: string
	readonly amount: bigint
}

const withholdPostings: ReadonlyArray<PostingAddition> = [
	{ line: l1, account: "GrossWages", side: "debit", amount: 500_000n },
	{ line: l2, account: "GrossWages", side: "debit", amount: 120_000n },
	{ line: l1, account: "NetPay", side: "credit", amount: 390_000n },
	{ line: l2, account: "NetPay", side: "credit", amount: 98_000n },
	{ line: l1, account: "Withholding", side: "credit", amount: 110_000n },
	{ line: l2, account: "Withholding", side: "credit", amount: 22_000n }
]

/** The entry numbers the database assigns in insertion order, which comparisons treat up to renaming. */
const stateAPostings: ReadonlyArray<PostingAddition & { readonly entry: bigint }> = Arr.map(
	withholdPostings,
	(p, i) => ({ entry: BigInt(i + 1), ...p })
)

/** The state after onboard, logShifts and draftRun. */
export const stateA: Facts = {
	...onboardFacts,
	...logShiftsFacts,
	...draftLinesFacts,
	LevyLine: withholdLevyLines,
	Posting: stateAPostings
}

export interface DirectWriter {
	readonly role: "clerk" | "hr" | "approver"
	/** What the writer does, which names the row. */
	readonly name: string
	/**
	 * The state the row starts from: the state after onboard, logShifts and draftRun (stateA), or another, named as the
	 * outcome table names states.
	 */
	readonly startsFrom:
		| { readonly kind: "stateA" }
		| { readonly kind: "named"; readonly state: string }
	/**
	 * What the row's statements presuppose of that state beyond what it holds, in words, and the statements the harness
	 * runs first, as the row's role and committed, to establish it; none for most rows.
	 */
	readonly precondition:
		| { readonly kind: "none" }
		| {
				readonly kind: "setup"
				readonly description: string
				readonly setup: ReadonlyArray<string>
		  }
	/**
	 * The statements, with psql variables as a psql writer spells them; BEGIN and COMMIT where the row has a
	 * transaction.
	 */
	readonly sql: ReadonlyArray<string>
	readonly outcome: DirectOutcome
}

/**
 * What a direct writer's row meets: acceptance; a refusal naming no constraint; a constraint's refusal; or a
 * residual law's violation at SQLSTATE 23000, with the key texts its DETAIL carries.
 */
type DirectOutcome =
	| { readonly kind: "accepted" }
	| { readonly kind: "refused"; readonly sqlstate: string; readonly at: "statement" | "commit" }
	| {
			readonly kind: "constraint"
			readonly sqlstate: string
			readonly at: "statement" | "commit"
			readonly constraint: ConstraintName
	  }
	| {
			readonly kind: "violated"
			readonly at: "statement" | "commit"
			readonly law: LawId
			readonly detail: Arr.NonEmptyReadonlyArray<string>
	  }

/**
 * The direct psql writers, each with the outcome its writer meets, the state it starts from and what it presupposes. A
 * role moves an identity sequence only through the field's advance function, never setval.
 */
export const directWriters: ReadonlyArray<DirectWriter> = [
	{
		startsFrom: { kind: "stateA" },
		precondition: { kind: "none" },
		role: "clerk",
		name: "a clerk updates an immutable pay line",
		sql: ["UPDATE payroll.pay_line SET net = 0 WHERE id = :'l1'"],
		outcome: { kind: "refused", sqlstate: "42501", at: "statement" }
	},
	{
		startsFrom: { kind: "stateA" },
		precondition: { kind: "none" },
		role: "clerk",
		name: "a clerk truncates the postings",
		sql: ["TRUNCATE payroll.posting"],
		outcome: { kind: "refused", sqlstate: "42501", at: "statement" }
	},
	{
		startsFrom: { kind: "stateA" },
		precondition: { kind: "none" },
		role: "clerk",
		name: "a clerk writes a generated entry",
		sql: [
			"INSERT INTO payroll.posting (entry, line, account, side, amount) VALUES (1, :'l1', 'NetPay', 'credit', 1)"
		],
		outcome: { kind: "refused", sqlstate: "428C9", at: "statement" }
	},
	{
		startsFrom: { kind: "stateA" },
		precondition: { kind: "none" },
		role: "clerk",
		name: "a clerk inserts a second l1",
		sql: [
			"INSERT INTO payroll.pay_line (id, run, employee, gross, net, off_cycle) VALUES (:'l1', :'run1', :'ada', 500000, 390000, false)"
		],
		outcome: {
			kind: "constraint",
			sqlstate: "23505",
			at: "statement",
			constraint: payroll.fieldConstraint({ name: "PayLine" }, "pk", ["id"])
		}
	},
	{
		startsFrom: { kind: "stateA" },
		precondition: { kind: "none" },
		role: "clerk",
		name: "a clerk deletes l1's deposit and commits",
		sql: [
			"BEGIN",
			"DELETE FROM payroll.deposit WHERE line = :'l1' AND account = '000987654321'",
			"COMMIT"
		],
		outcome: { kind: "violated", at: "commit", law: depositAmount, detail: [l1] }
	},
	{
		startsFrom: { kind: "stateA" },
		precondition: { kind: "none" },
		role: "clerk",
		name: "a clerk approves run1 with no approval",
		sql: ["BEGIN", "UPDATE payroll.pay_run SET stage = 'approved' WHERE id = :'run1'", "COMMIT"],
		outcome: { kind: "violated", at: "commit", law: approvedRunApproval, detail: [run1] }
	},
	{
		startsFrom: { kind: "stateA" },
		precondition: { kind: "none" },
		role: "clerk",
		name: "a clerk makes the deposit law immediate and deletes l1's deposit",
		sql: [
			"BEGIN",
			`SET CONSTRAINTS ${Arr.join(payroll.triggers(depositAmount), ", ")} IMMEDIATE`,
			"DELETE FROM payroll.deposit WHERE line = :'l1' AND account = '000987654321'",
			"ROLLBACK"
		],
		outcome: { kind: "violated", at: "statement", law: depositAmount, detail: [l1] }
	},
	{
		startsFrom: { kind: "stateA" },
		precondition: { kind: "none" },
		role: "clerk",
		name: "a clerk inserts a levy line at a rate the levy does not have",
		sql: [
			"INSERT INTO payroll.levy_line (line, levy, employee_rate, withheld) VALUES (:'l1', 'Futa', 0.006, 0)"
		],
		outcome: {
			kind: "constraint",
			sqlstate: "23514",
			at: "statement",
			constraint: payroll.constraintOf(
				payroll.lawOfDesc(
					contained(on("LevyLine", ["levy", "employeeRate"]), on("Levy", ["id", "employeeRate"]))
				),
				"FiniteCheck"
			)
		}
	},
	{
		startsFrom: { kind: "stateA" },
		precondition: { kind: "none" },
		role: "clerk",
		name: "a clerk inserts into a derived relation",
		sql: ["INSERT INTO payroll.run_total (run, lines, gross, net) VALUES (:'run1', 1, 0, 0)"],
		outcome: { kind: "refused", sqlstate: "42501", at: "statement" }
	},
	{
		startsFrom: { kind: "stateA" },
		role: "clerk",
		name: "an explicit entry, and the writer advancing the sequence past it",
		/**
		 * Every line of the state after draftRun has its NetPay posting, so :'line' is a line of a fresh draft run,
		 * lawful with its one remainder deposit and no posting (key(PayLine, ["run", "employee"]) allows one line per
		 * employee per run).
		 */
		precondition: {
			kind: "setup",
			description: "a line with no NetPay posting yet",
			setup: [
				"BEGIN",
				"INSERT INTO payroll.pay_run (id, employer, period, stage) VALUES (:'run5', :'acme', int8range(:p0, :p1), 'draft')",
				"INSERT INTO payroll.pay_line (id, run, employee, gross, net, off_cycle) VALUES (:'line', :'run5', :'ada', 5000, 5000, false)",
				"INSERT INTO payroll.deposit (line, account, amount, remainder) VALUES (:'line', '000123456789', 5000, true)",
				"COMMIT"
			]
		},
		sql: [
			"INSERT INTO payroll.posting (entry, line, account, side, amount) OVERRIDING SYSTEM VALUE VALUES (1000000, :'line', 'NetPay', 'credit', 5000)",
			`SELECT ${payroll.advance({ name: "Posting" }, "entry")}(1000000)`
		],
		outcome: { kind: "accepted" }
	},
	{
		startsFrom: { kind: "stateA" },
		precondition: { kind: "none" },
		role: "clerk",
		name: "a writer advancing the sequence with setval",
		/** No role holds a privilege on an identity sequence. */
		sql: [`SELECT setval('${payroll.sequence({ name: "Posting" }, "entry")}', 1000000)`],
		outcome: { kind: "refused", sqlstate: "42501", at: "statement" }
	},
	{
		startsFrom: { kind: "stateA" },
		precondition: { kind: "none" },
		role: "clerk",
		name: "a mutable run's key change",
		sql: [
			"INSERT INTO payroll.pay_run (id, employer, period, stage) VALUES (:'run5', :'acme', int8range(:p0, :p1), 'draft')",
			"UPDATE payroll.pay_run SET id = :'run6' WHERE id = :'run5'"
		],
		outcome: { kind: "accepted" }
	},
	{
		precondition: { kind: "none" },
		role: "clerk",
		name: "a voided run returned to approved",
		/**
		 * run1 is voided and keeps the Approval of its first approval; from the state after draftRun the UPDATE would
		 * meet the approved-run approval law at COMMIT instead.
		 */
		startsFrom: { kind: "named", state: "after reverse" },
		sql: [
			"BEGIN",
			"DELETE FROM payroll.voiding WHERE run = :'run1'",
			"UPDATE payroll.pay_run SET stage = 'approved' WHERE id = :'run1'",
			"COMMIT"
		],
		outcome: { kind: "accepted" }
	},
	{
		startsFrom: { kind: "stateA" },
		precondition: { kind: "none" },
		role: "hr",
		name: "hr inserts an overlapping employment",
		sql: [
			"INSERT INTO payroll.employment (employee, during, basis) VALUES (:'ada', int8range(:t5, :t12), 'salaried')"
		],
		outcome: {
			kind: "constraint",
			sqlstate: "23P01",
			at: "statement",
			constraint: payroll.fieldConstraint({ name: "Employment" }, "pk", ["employee", "during"])
		}
	},
	{
		startsFrom: { kind: "stateA" },
		precondition: { kind: "none" },
		role: "hr",
		name: "hr inserts a basis outside the closed roster",
		sql: [
			"INSERT INTO payroll.employment (employee, during, basis) VALUES (:'bo', int8range(:t9, :t12), 'contractor')"
		],
		outcome: { kind: "refused", sqlstate: "22P02", at: "statement" }
	},
	{
		startsFrom: { kind: "stateA" },
		precondition: { kind: "none" },
		role: "hr",
		name: "hr deletes the assignment bo's employment needs",
		sql: [
			"BEGIN",
			"DELETE FROM payroll.assignment WHERE employee = :'bo' AND during = int8range(:t5, :t9)",
			"COMMIT"
		],
		outcome: {
			kind: "constraint",
			sqlstate: "23503",
			at: "commit",
			constraint: payroll.fieldConstraint({ name: "Employment" }, "fk", ["employee", "during"])
		}
	},
	{
		startsFrom: { kind: "stateA" },
		precondition: { kind: "none" },
		role: "approver",
		name: "an approver reads salaries",
		sql: ["SELECT * FROM payroll.salary"],
		outcome: { kind: "refused", sqlstate: "42501", at: "statement" }
	},
	{
		startsFrom: { kind: "stateA" },
		precondition: { kind: "none" },
		role: "approver",
		name: "an approver inserts a payment",
		sql: ["INSERT INTO payroll.payment (run, settled) VALUES (:'run1', :now)"],
		outcome: { kind: "refused", sqlstate: "42501", at: "statement" }
	}
]
