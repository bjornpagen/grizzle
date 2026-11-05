import { Array as Arr } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import {
	type AuthoredStatementDesc as StatementDesc,
	capacity,
	contained,
	eq,
	f,
	field,
	literal,
	mutable,
	on,
	onWhere,
	relation,
	type SchemaDesc,
	within
} from "#test/support/fixtures/ir/desc.ts"
import { lawNamesOf } from "#test/support/kernel/naming.ts"

const mutables = (
	onSide: boolean,
	relations: ReadonlyArray<string>
): ReadonlyArray<StatementDesc> => (onSide ? Arr.map(relations, mutable) : [])

const budgetSpend = capacity(
	onWhere("Budget", ["id"], eq(field("open"), literal(true))),
	onWhere("Spend", ["budget"], eq(field("posted"), literal(true))),
	within(0n, "cap"),
	{ kind: "field", field: "amount" }
)

/**
 * Budgets: a field-weighted sum against a `ref` bound with selectors on both sides, `capacity(on(select(Budget, (b) =>
 * b.eq(b.open, true)), "id"), { from: on(select(Spend, (s) => s.eq(s.posted, true)), "budget"), weight:
 * weigh("amount"), within: within(0n, ref("cap")) })`. An integer weight sums to bigint and may be negative, so the
 * literal lower bound of zero is checked too.
 *
 * Every capacity here also declares the containment of its sources into its target: a plain foreign key from the source
 * projection, so no source stands in a group without a target, and one written beside an uncommitted target fails that
 * key's check. The generated families (test/pg/laws/families generated.ts) draw capacities without it. Each law is read
 * through the naming door from the capacity statement that declares it.
 */
export const budgets = (options: { readonly mutable: boolean }): SchemaDesc => ({
	name: "Budgets",
	relations: [
		relation("Budget", { id: f.integer, cap: f.bigint, open: f.boolean }, ["id"]),
		relation("Spend", { id: f.integer, budget: f.integer, amount: f.integer, posted: f.boolean }, [
			"id"
		])
	],
	statements: [
		budgetSpend,
		contained(on("Spend", ["budget"]), on("Budget", ["id"])),
		...mutables(options.mutable, ["Budget", "Spend"])
	],
	extends: undefined
})

export const budgetsLaw: LawId = lawNamesOf(budgets({ mutable: false })).lawOfDesc(budgetSpend)

const lineDeposits = capacity(on("Line", ["id"]), on("Deposit", ["line"]), within("net", "net"), {
	kind: "field",
	field: "amount"
})

/**
 * Lines: an exact `ref` bound, `within(ref("net"), ref("net"))` over a bigint weight, which sums to numeric and is
 * compared with the bound cast to numeric.
 */
export const lines = (): SchemaDesc => ({
	name: "Lines",
	relations: [
		relation("Line", { id: f.uuid, net: f.bigint }, ["id"]),
		relation("Deposit", { id: f.uuid, line: f.uuid, amount: f.bigint }, ["id"])
	],
	statements: [lineDeposits, contained(on("Deposit", ["line"]), on("Line", ["id"]))],
	extends: undefined
})

export const linesLaw: LawId = lawNamesOf(lines()).lawOfDesc(lineDeposits)

const quotaSeats = capacity(on("Quota", ["id"]), on("Seat", ["quota"]), within(0n, "limit"), {
	kind: "count"
})

/**
 * Quotas: a count against a numeric(6,1) `ref` bound, wider than the count's bigint, so the comparison is made in
 * numeric and a bound of 2.5 admits two members, not three.
 */
export const quotas = (): SchemaDesc => ({
	name: "Quotas",
	relations: [
		relation("Quota", { id: f.integer, limit: f.numeric(6, 1) }, ["id"]),
		relation("Seat", { id: f.integer, quota: f.integer }, ["id"])
	],
	statements: [quotaSeats, contained(on("Seat", ["quota"]), on("Quota", ["id"]))],
	extends: undefined
})

export const quotasLaw: LawId = lawNamesOf(quotas()).lawOfDesc(quotaSeats)

const roomBookings = capacity(on("Room", ["id"]), on("Booking", ["room"]), within(0n, "ceiling"), {
	kind: "duration",
	field: "during"
})

/**
 * Rooms: a duration weight, `weight: weigh(duration("during"))` over a bigint span, against `ref("ceiling")`
 * ([0,10) and [5,15) weigh 20).
 */
export const rooms = (options: { readonly mutable: boolean }): SchemaDesc => ({
	name: "Rooms",
	relations: [
		relation("Room", { id: f.integer, ceiling: f.bigint }, ["id"]),
		relation("Booking", { id: f.integer, room: f.integer, during: f.span(f.bigint, undefined) }, [
			"id"
		])
	],
	statements: [
		roomBookings,
		contained(on("Booking", ["room"]), on("Room", ["id"])),
		...mutables(options.mutable, ["Room", "Booking"])
	],
	extends: undefined
})

export const roomsLaw: LawId = lawNamesOf(rooms({ mutable: false })).lawOfDesc(roomBookings)

const orderInvoice = capacity(on("Order", ["id"]), on("Invoice", ["order"]), within(1n, 1n), {
	kind: "count"
})

const employerApprovers = capacity(
	on("Employer", ["id"]),
	on("Approver", ["employer"]),
	within(1n, "*"),
	{
		kind: "count"
	}
)

/**
 * Orders: exactly one invoice per order, `within(1n, 1n)`: the partial UNIQUE plus the residual existence law for the
 * lower bound. Employers: at least one approver, `within(1n, "*")`.
 */
export const orders = (): SchemaDesc => ({
	name: "Orders",
	relations: [
		relation("Order", { id: f.integer }, ["id"]),
		relation("Invoice", { id: f.integer, order: f.integer }, ["id"]),
		relation("Employer", { id: f.integer }, ["id"]),
		relation("Approver", { id: f.integer, employer: f.integer }, ["id"])
	],
	statements: [
		orderInvoice,
		employerApprovers,
		contained(on("Invoice", ["order"]), on("Order", ["id"])),
		contained(on("Approver", ["employer"]), on("Employer", ["id"]))
	],
	extends: undefined
})

export const ordersLaw: LawId = lawNamesOf(orders()).lawOfDesc(orderInvoice)
export const employersLaw: LawId = lawNamesOf(orders()).lawOfDesc(employerApprovers)

const firmSigners = capacity(
	on("Firm", ["id"]),
	onWhere("Signer", ["firm"], eq(field("active"), literal(true))),
	within(1n, "*"),
	{
		kind: "count"
	}
)

/**
 * Firms: the existence variant over a selected source, at least one active signer per firm: an inactive signer never
 * satisfies it.
 */
export const firms = (): SchemaDesc => ({
	name: "Firms",
	relations: [
		relation("Firm", { id: f.integer }, ["id"]),
		relation("Signer", { id: f.integer, firm: f.integer, active: f.boolean }, ["id"])
	],
	statements: [firmSigners, contained(on("Signer", ["firm"]), on("Firm", ["id"]))],
	extends: undefined
})

export const firmsLaw: LawId = lawNamesOf(firms()).lawOfDesc(firmSigners)
