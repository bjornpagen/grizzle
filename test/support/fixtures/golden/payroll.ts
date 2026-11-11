/**
 * The payroll example's golden state: the facts after onboard, logShifts and draftRun (stateA), which the payroll's
 * race starts from (test/schedules/laws/payroll.test.ts).
 *
 * The example's symbolic constants are fixed here: instants are epoch microseconds from 2026-01-01T00:00Z, with
 * t0 < t5 < t9 a few days apart, the run period [p0, p1) inside [t0, t9), two eight-hour pending shifts inside
 * employment, and weeks counted since the epoch.
 */
import { Array as Arr } from "effect"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { id } from "#test/support/fixtures/golden/types.ts"

const acme = id(1, 1)
export const ada = id(2, 1)
const bo = id(2, 2)
const run1 = id(3, 1)
const l1 = id(4, 1)
const l2 = id(4, 2)

const base = 1_767_225_600_000_000n
const day = 86_400_000_000n
const hour = 3_600_000_000n
export const t0 = base
const t5 = base + 5n * day
const t9 = base + 9n * day
const p0 = base + day
const p1 = base + 8n * day
const s1 = base + day + 9n * hour
const s2 = s1 + 8n * hour
const s3 = base + 2n * day + 9n * hour
const s4 = s3 + 8n * hour
const w1 = 2922n

const span = (start: bigint, end: bigint) => ({ start, end })
const dec = (exact: string): Decimal => Decimal.of(exact)

type Facts = Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>

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
