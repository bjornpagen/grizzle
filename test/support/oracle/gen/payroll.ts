import { array, boolean, type Gen, int } from "@grizzle/testing/gen"
import { Array as Arr, pipe, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { id } from "#test/support/fixtures/golden/types.ts"
import { toastText } from "#test/support/oracle/gen/toast.ts"
import { at } from "#test/support/oracle/pick.ts"

type Fact = Readonly<Record<string, unknown>>
export type PayrollFacts = Readonly<Record<string, ReadonlyArray<Fact>>>

/** 2026-01-01T00:00Z in epoch microseconds, a day and an hour. */
const base = 1_767_225_600_000_000n
const day = 86_400_000_000n
const hour = 3_600_000_000n
const firstWeek = 2922n

const instant = (days: number, hours: number): bigint =>
	base + BigInt(days) * day + BigInt(hours) * hour
/** Midnight of a day. */
const midnight = (days: number): bigint => instant(days, 0)
const span = (start: bigint, end: bigint) => ({ start, end })

const names: ReadonlyArray<string> = [
	"Ada Byron",
	"Ada King",
	"Bo Diaz",
	"Cy Ng",
	"Émile Zola",
	"ada lower",
	"Zoë \u{1F600}",
	"Dee Roe"
]
const employerNames: ReadonlyArray<string> = ["Acme Tools LLC", "Bolt & Nut", "Ünïcode Co"]
const costCenters: ReadonlyArray<string> = ["CC-0100", "CC-0200", "CC-0300"]
const filings: ReadonlyArray<string> = ["single", "joint", "head"]
const stages: ReadonlyArray<string> = ["draft", "approved", "paid", "voided"]
const reasons: ReadonlyArray<string> = ["vacation", "sick", "unpaid"]
const accounts: ReadonlyArray<string> = ["GrossWages", "NetPay", "Withholding"]
const sides: ReadonlyArray<string> = ["debit", "credit"]
const levies: ReadonlyArray<{ readonly levy: string; readonly rate: Decimal }> = [
	{ levy: "SocialSecurity", rate: Decimal.of("0.062") },
	{ levy: "Medicare", rate: Decimal.of("0.0145") },
	{ levy: "Futa", rate: Decimal.of("0") }
]

/** A memo: empty, short, or TOAST-sized and incompressible. */
const memo = (pick: number, seed: number): string => {
	switch (pick % 5) {
		case 0:
			return "wrong period"
		case 1:
			return ""
		case 2:
			return "bank returned the batch"
		case 3:
			return toastText(seed, 2_100)
		default:
			return toastText(seed, 6_000)
	}
}

const digest = (n: number): string => pipe((n % 16).toString(16), Str.repeat(64))

interface SpellSketch {
	readonly gap: number
	readonly length: number
	readonly salaried: boolean
	readonly split: number
	readonly costCenter: number
	readonly salary: number
	readonly leave: number
}

interface ShiftSketch {
	readonly day: number
	readonly hours: number
	readonly approved: boolean
}

interface EmployeeSketch {
	readonly employer: number
	readonly name: number
	readonly manager: number
	readonly filing: number
	readonly extra: number
	readonly spells: ReadonlyArray<SpellSketch>
	readonly shifts: ReadonlyArray<ShiftSketch>
	readonly slack: number
}

interface LineSketch {
	readonly employee: number
	readonly gross: number
	readonly net: number
	readonly offCycle: boolean
	readonly reason: number
	readonly deposits: number
	readonly remainder: number
	readonly levies: number
	readonly withheld: number
	readonly postings: number
	readonly side: number
}

interface RunSketch {
	readonly employer: number
	readonly start: number
	readonly length: number
	readonly stage: number
	readonly approval: boolean
	readonly approver: number
	readonly memo: number
	readonly reissue: number
	readonly lines: ReadonlyArray<LineSketch>
}

export interface PayrollSketch {
	readonly employers: number
	readonly employees: ReadonlyArray<EmployeeSketch>
	readonly approvers: ReadonlyArray<number>
	readonly runs: ReadonlyArray<RunSketch>
	readonly requests: ReadonlyArray<{ readonly digest: number; readonly memo: number }>
}

const spellGen: Gen<SpellSketch> = (source) => ({
	gap: source.draw(int(0, 2)),
	length: source.draw(int(1, 9)),
	salaried: source.draw(boolean),
	split: source.draw(int(0, 8)),
	costCenter: source.draw(int(0, 2)),
	salary: source.draw(int(0, 3)),
	leave: source.draw(int(0, 3))
})

const shiftGen: Gen<ShiftSketch> = (source) => ({
	day: source.draw(int(0, 20)),
	hours: source.draw(int(1, 12)),
	approved: source.draw(boolean)
})

const employeeGen: Gen<EmployeeSketch> = (source) => ({
	employer: source.draw(int(0, 2)),
	name: source.draw(int(0, 7)),
	manager: source.draw(int(0, 5)),
	filing: source.draw(int(0, 2)),
	extra: source.draw(int(0, 3)),
	spells: source.draw(array(spellGen, { min: 0, max: 3 })),
	shifts: source.draw(array(shiftGen, { min: 0, max: 4 })),
	slack: source.draw(int(0, 3))
})

const lineGen: Gen<LineSketch> = (source) => ({
	employee: source.draw(int(0, 5)),
	gross: source.draw(int(0, 5)),
	net: source.draw(int(0, 4)),
	offCycle: source.draw(boolean),
	reason: source.draw(int(0, 4)),
	deposits: source.draw(int(0, 4)),
	remainder: source.draw(int(0, 4)),
	levies: source.draw(int(0, 7)),
	withheld: source.draw(int(0, 3)),
	postings: source.draw(int(0, 7)),
	side: source.draw(int(0, 7))
})

const runGen: Gen<RunSketch> = (source) => ({
	employer: source.draw(int(0, 2)),
	start: source.draw(int(0, 12)),
	length: source.draw(int(1, 8)),
	stage: source.draw(int(0, 3)),
	approval: source.draw(boolean),
	approver: source.draw(int(0, 5)),
	memo: source.draw(int(0, 4)),
	reissue: source.draw(int(0, 3)),
	lines: source.draw(array(lineGen, { min: 0, max: 4 }))
})

/**
 * Generated payroll facts: lawful states of the payroll ledger fixture (test/support/fixtures/api/payroll.ts), for the
 * differential suite that runs every payroll program through the optimized artifact against the conservative
 * lowering.
 *
 * The optimized lowering may rely on every law the schema declares, so every generated state satisfies all of them,
 * by construction:
 *
 * - keys: every id is fresh, every candidate key distinct (an employee code is unique across the state, an account
 *   unique per line), and the spans of one employee in a span-keyed relation never overlap;
 * - containments: every referenced id names a fact the state holds, a levy line carries its levy's own rate, a
 *   shift has a timesheet for its week, a reissue replaces a voided run;
 * - families: a timesheet's shifts, a line's deposits and an employer's approvers are each a counted family of their
 *   owner, every member under an owner the state holds, whose drawn values the loader fills;
 * - mirrors: every employee has a tax profile, every off-cycle line a reason and only those, and each employee's
 *   assignments cover exactly the time their employment covers (each spell is split into one or two assignments);
 * - span coverage: leave lies inside employment, salary inside salaried employment, an approved shift inside
 *   employment;
 * - alternatives: a paid run has a payment and no voiding, a voided run a voiding and no payment, a draft or approved
 *   run neither; an approved or paid run has an approval;
 * - capacities: every employer lists an approver, a run is replaced at most once, a line has at most four deposits
 *   and at most one remainder, its deposits sum to exactly its net, its net is at most its gross, and the approved
 *   shifts of a week fit its timesheet's ceiling;
 * - contracts and refinements: amounts are nonnegative, codes, accounts, digests and EINs match their patterns.
 *
 * The suite loads a state as the owner in one transaction and makes every deferred law judge it at once (SET
 * CONSTRAINTS ALL IMMEDIATE), so a state the generator gets wrong fails loudly instead of feeding the comparison.
 *
 * Values come from small grids, so joins fan out and keys collide where laws allow: instants on a day grid with
 * adjacent spells, shared name prefixes for the name-range read, run periods that overlap salary segments in every
 * Allen relation, memos that are empty, short or TOAST-sized (toast.ts). Every choice is a number in a flat sketch
 * reduced modulo what is available, so every sketch resolves and shrinking toward zero keeps a state lawful.
 */
export const payrollSketchGen: Gen<PayrollSketch> = (source) => ({
	employers: source.draw(int(1, 2)),
	employees: source.draw(array(employeeGen, { min: 1, max: 5 })),
	approvers: source.draw(array(int(0, 5), { min: 0, max: 2 })),
	runs: source.draw(array(runGen, { min: 0, max: 4 })),
	requests: source.draw(
		array((inner) => ({ digest: inner.draw(int(0, 15)), memo: inner.draw(int(0, 4)) }), {
			min: 0,
			max: 2
		})
	)
})

const grossGrid: ReadonlyArray<bigint> = [0n, 1_000n, 120_000n, 500_000n, 999_999n, 7n]
const extraGrid: ReadonlyArray<bigint> = [0n, 2_500n, 1n, 100_000n]
const annualGrid: ReadonlyArray<bigint> = [12_000_000n, 9_000_000n, 0n, 6_000_000n]
const withheldGrid: ReadonlyArray<bigint> = [0n, 31_000n, 7_250n, 1n]

/**
 * A lawful payroll state from its sketch.
 *
 * A salary segment inside a salaried spell, the whole spell or a part of it.
 *
 * Leave inside the spell.
 *
 * A timesheet with no approved shift under it.
 *
 * A run replaces a voided run that no other run replaces yet.
 *
 * Levy lines at their levy's own rate.
 *
 * Postings, one per account the mask names.
 */
export const resolvePayroll = (sketch: PayrollSketch): PayrollFacts => {
	const employerIds = Arr.map(indices(sketch.employers), (i) => id(1, i + 1))
	const Employer = Arr.map(employerIds, (employer, i) => ({
		id: employer,
		ein: `${10 + i}-${String(1_000_000 + i)}`,
		name: at(employerNames, i)
	}))
	const employeeIds = Arr.map(indices(sketch.employees.length), (i) => id(2, i + 1))
	const employerOf = new Map<string, string>()
	const Employee = Arr.map(sketch.employees, (e, i) => {
		const employer = at(employerIds, e.employer)
		const employee = at(employeeIds, i)
		employerOf.set(employee, employer)
		return {
			id: employee,
			employer,
			code: `E${pipe(String(i + 1), Str.padStart(6, "0"))}`,
			name: at(names, e.name)
		}
	})
	const TaxProfile = Arr.map(sketch.employees, (e, i) => ({
		employee: at(employeeIds, i),
		filing: at(filings, e.filing),
		extra: at(extraGrid, e.extra)
	}))
	/** A manager is any other employee, so reporting cycles occur, which no law forbids. */
	const ReportsTo = Arr.flatMap(sketch.employees, (e, i) => {
		const m = e.manager % (employeeIds.length + 1)
		if (m === 0 || m - 1 === i) {
			return []
		}
		return [{ employee: at(employeeIds, i), manager: at(employeeIds, m - 1) }]
	})
	/** Every employer lists an approver: an employee of its own when it has one. */
	const approverKeys = new Set<string>()
	const Approver: Array<Fact> = []
	const addApprover = (employer: string, approver: string) => {
		const k = `${employer} ${approver}`
		if (approverKeys.has(k)) {
			return
		}
		approverKeys.add(k)
		Approver.push({ employer, approver })
	}
	for (const [i, employer] of employerIds.entries()) {
		const own = Arr.filter(employeeIds, (e) => employerOf.get(e) === employer)
		addApprover(employer, own.length > 0 ? at(own, i) : at(employeeIds, i))
	}
	for (const pick of sketch.approvers) {
		const approver = at(employeeIds, pick)
		addApprover(employerOf.get(approver) ?? at(employerIds, 0), approver)
	}

	const Employment: Array<Fact> = []
	const Assignment: Array<Fact> = []
	const Salary: Array<Fact> = []
	const Leave: Array<Fact> = []
	const Timesheet: Array<Fact> = []
	const Shift: Array<Fact> = []
	for (const [i, e] of sketch.employees.entries()) {
		const employee = at(employeeIds, i)
		/** Spells in day order, adjacent when the gap is 0, never overlapping. */
		const spells: Array<{ readonly start: number; readonly end: number }> = []
		let cursor = 0
		for (const s of e.spells) {
			const start = cursor + s.gap
			const end = start + s.length
			cursor = end
			spells.push({ start, end })
			Employment.push({
				employee,
				during: span(midnight(start), midnight(end)),
				basis: s.salaried ? "salaried" : "hourly"
			})
			/** One or two assignments covering the spell exactly. */
			const cut = s.length > 1 ? start + 1 + (s.split % (s.length - 1)) : end
			const split = s.split % 3 !== 0 && cut < end
			Assignment.push({
				employee,
				during: span(midnight(start), midnight(split ? cut : end)),
				costCenter: at(costCenters, s.costCenter)
			})
			if (split) {
				Assignment.push({
					employee,
					during: span(midnight(cut), midnight(end)),
					costCenter: at(costCenters, s.costCenter + 1)
				})
			}
			if (s.salaried && s.salary > 0) {
				const from = s.salary === 2 && s.length > 1 ? start + 1 : start
				const to = s.salary === 3 && end - 1 > from ? end - 1 : end
				Salary.push({
					employee,
					during: span(midnight(from), midnight(to)),
					annual: at(annualGrid, s.split)
				})
			}
			if (s.leave > 0) {
				const from = start + (s.leave === 2 && s.length > 1 ? 1 : 0)
				Leave.push({
					employee,
					during: span(midnight(from), midnight(from + 1 > end ? end : from + 1)),
					reason: at(reasons, s.leave)
				})
			}
		}
		/**
		 * Shifts on distinct days inside a spell, from 09:00, each a member of its week's timesheet, whose counted family
		 * its shifts are; the approved ones fit its ceiling.
		 */
		const days = new Set<number>()
		const weekly = new Map<bigint, bigint>()
		for (const sh of e.shifts) {
			const inSpell = Arr.some(spells, (s) => sh.day >= s.start && sh.day < s.end)
			if (!inSpell || days.has(sh.day)) {
				continue
			}
			days.add(sh.day)
			const hours = Math.min(sh.hours, 15)
			const week = firstWeek + BigInt(Math.floor(sh.day / 7))
			Shift.push({
				employee,
				during: span(instant(sh.day, 9), instant(sh.day, 9 + hours)),
				week,
				status: sh.approved ? "approved" : "pending"
			})
			weekly.set(week, (weekly.get(week) ?? 0n) + (sh.approved ? BigInt(hours) * hour : 0n))
		}
		for (const [week, used] of weekly) {
			Timesheet.push({
				employee,
				week,
				ceiling: e.slack === 0 ? used : used + BigInt(e.slack) * hour
			})
		}
		if (e.slack === 3 && !weekly.has(firstWeek + 3n)) {
			Timesheet.push({ employee, week: firstWeek + 3n, ceiling: 144_000_000_000n })
		}
	}

	const PayRun: Array<Fact> = []
	const Approval: Array<Fact> = []
	const Payment: Array<Fact> = []
	const Voiding: Array<Fact> = []
	const Reissue: Array<Fact> = []
	const PayLine: Array<Fact> = []
	const OffCycleReason: Array<Fact> = []
	const Deposit: Array<Fact> = []
	const LevyLine: Array<Fact> = []
	const Posting: Array<Fact> = []
	const runIds = Arr.map(indices(sketch.runs.length), (j) => id(3, j + 1))
	const stageOf = Arr.map(sketch.runs, (r) => at(stages, r.stage))
	const voided = Arr.flatMap(runIds, (runId, j) => (stageOf[j] === "voided" ? [runId] : []))
	const replaced = new Set<string>()
	let lineCount = 0
	let entry = 0n
	for (const [j, r] of sketch.runs.entries()) {
		const run = at(runIds, j)
		const stage = at(stageOf, j)
		const employer = at(employerIds, r.employer)
		PayRun.push({
			id: run,
			employer,
			period: span(midnight(r.start), midnight(r.start + r.length)),
			stage
		})
		if (stage === "approved" || stage === "paid" || r.approval) {
			Approval.push({
				run,
				approver: at(employeeIds, r.approver),
				at: instant(r.start + r.length, 1)
			})
		}
		if (stage === "paid") {
			Payment.push({ run, settled: instant(r.start + r.length, 2) })
		}
		if (stage === "voided") {
			Voiding.push({ run, reason: memo(r.memo, j) })
		}
		if (r.reissue > 0 && voided.length > 0) {
			const target = at(voided, r.reissue)
			if (target !== run && !replaced.has(target)) {
				replaced.add(target)
				Reissue.push({ run, replaces: target })
			}
		}
		const employees = new Set<string>()
		for (const l of r.lines) {
			const employee = at(employeeIds, l.employee)
			if (employees.has(employee)) {
				continue
			}
			employees.add(employee)
			lineCount++
			const line = id(4, lineCount)
			const gross = at(grossGrid, l.gross)
			/** Deposits: up to four, distinct accounts, at most one remainder, summing to exactly the net. */
			const count = l.deposits
			const net = count === 0 ? 0n : (gross * BigInt(l.net)) / 4n
			PayLine.push({ id: line, run, employee, gross, net, offCycle: l.offCycle })
			if (l.offCycle) {
				OffCycleReason.push({ line, reason: memo(l.reason, 100 + lineCount) })
			}
			let left = net
			for (let k = 0; k < count; k++) {
				const amount = k === count - 1 ? left : left / 2n
				left -= amount
				Deposit.push({
					line,
					account: `${pipe(String(k), Str.padStart(4, "0"))}${pipe(String(lineCount), Str.padStart(8, "0"))}`,
					amount,
					remainder: k === l.remainder
				})
			}
			for (const [k, v] of levies.entries()) {
				if (((l.levies >> k) & 1) === 1) {
					LevyLine.push({
						line,
						levy: v.levy,
						employeeRate: v.rate,
						withheld: at(withheldGrid, l.withheld + k)
					})
				}
			}
			for (const [k, account] of accounts.entries()) {
				if (((l.postings >> k) & 1) === 0) {
					continue
				}
				entry++
				Posting.push({
					entry,
					line,
					account,
					side: at(sides, l.side >> k),
					amount: k === 0 ? gross : k === 1 ? net : gross - net
				})
			}
		}
	}
	const Request = Arr.map(sketch.requests, (q, i) => ({
		id: id(5, i + 1),
		digest: digest(q.digest),
		result: memo(q.memo, 200 + i)
	}))
	return {
		Employer,
		Employee,
		ReportsTo,
		Approver,
		TaxProfile,
		Employment,
		Assignment,
		Salary,
		Leave,
		Timesheet,
		Shift,
		PayRun,
		Approval,
		Payment,
		Voiding,
		Reissue,
		PayLine,
		OffCycleReason,
		Deposit,
		LevyLine,
		Posting,
		Request
	}
}

/**
 * The parameter values a payroll program is run with, chosen from the state so that most bindings find facts and
 * some find none: an id the state holds or a fresh one, a week of its shifts, a name bound from the names' grid.
 */
export interface ParamSketch {
	readonly pick: number
	readonly absent: boolean
}

export const paramSketchGen: Gen<ParamSketch> = (source) => ({
	pick: source.draw(int(0, 15)),
	absent: source.draw(boolean)
})

const nameBounds: ReadonlyArray<string> = [
	"A",
	"Ada",
	"Ada C",
	"B",
	"C",
	"É",
	"a",
	"Z",
	"\u{10FFFF}",
	""
]

const idsOf = (facts: PayrollFacts, relation: string, field: string): ReadonlyArray<string> =>
	Arr.flatMap(facts[relation] ?? [], (f) => {
		const v = f[field]
		return typeof v === "string" ? [v] : []
	})

/** The value of one named parameter of a payroll program, as the input text a placeholder takes. */
export const payrollParam = (facts: PayrollFacts, name: string, sketch: ParamSketch): string => {
	const pickId = (relation: string, field: string, group: number) => {
		const ids = idsOf(facts, relation, field)
		return sketch.absent || ids.length === 0 ? id(group, 0x900 + sketch.pick) : at(ids, sketch.pick)
	}
	switch (name) {
		case "run":
			return pickId("PayRun", "id", 3)
		case "employer":
			return pickId("Employer", "id", 1)
		case "line":
			return pickId("PayLine", "id", 4)
		case "manager":
		case "employee":
			return pickId("Employee", "id", 2)
		case "week": {
			const weeks = Arr.flatMap(facts["Shift"] ?? [], (f) =>
				typeof f["week"] === "bigint" ? [f["week"]] : []
			)
			return String(sketch.absent || weeks.length === 0 ? firstWeek + 9n : at(weeks, sketch.pick))
		}
		case "lo":
		case "hi":
			return at(nameBounds, sketch.pick)
		case "now":
			return String(instant(30, sketch.pick))
		case "reason":
			return memo(sketch.pick, 300)
		default:
			throw new Error(`no generated value for the payroll parameter ${name}`)
	}
}
