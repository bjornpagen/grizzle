import { Array as Arr } from "effect"
import {
	closed,
	contained,
	f,
	mutable,
	on,
	onSelected,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"

const assignmentActive = contained(
	onSelected("Assignment", ["worker"], { active: true }),
	on("Worker", ["id"])
)
const badgeIssued = contained(onSelected("Badge", ["desk"], { issued: true }), on("Desk", ["id"]))

/**
 * Staffing: `contained(on(select(Assignment, { active: true }), "worker"), on(Worker, "id"))`, the canonical
 * schedule's law, with a second, independent law of the same family, `Badge` into `Desk`, for the cross-law deadlock
 * schedule. Immutable by default; `mutable` adds both relations' UPDATE events. Each law of these schemas is read
 * through the naming door from the containment that declares it.
 */
export const staffing = (options: { readonly mutable: boolean }): SchemaDesc => ({
	name: "Staffing",
	relations: [
		relation("Worker", { id: f.integer, name: f.wildcard }, ["id"]),
		relation(
			"Assignment",
			{ id: f.integer, worker: f.integer, active: f.boolean, note: f.wildcard },
			["id"]
		),
		relation("Desk", { id: f.integer }, ["id"]),
		relation("Badge", { id: f.integer, desk: f.integer, issued: f.boolean }, ["id"])
	],
	statements: [
		assignmentActive,
		badgeIssued,
		...(options.mutable ? Arr.map(["Worker", "Assignment", "Desk", "Badge"], mutable) : [])
	],
	extends: undefined
})

/**
 * Printable ASCII, bounded, so the composite key passes the B-tree entry-size check; quotes, brackets and
 * backslashes included, which the DETAIL must carry intact.
 */
const Week = f.regex("^[ -~]{1,40}$", "u")

const shiftApproved = contained(
	onSelected("Shift", ["employee", "week"], { status: "approved" }),
	on("Sheet", ["employee", "week"])
)

/**
 * Rota: a composite text and uuid anchor, `contained(on(select(Shift, { status: "approved" }), "employee", "week"),
 * on(Sheet, "employee", "week"))`, whose projection is no key of Shift, so its DETAIL is Shift's primary key,
 * mirroring the payroll ledger's `shift_status_approved_timesheet`.
 */
export const rota = (options: { readonly mutable: boolean }): SchemaDesc => ({
	name: "Rota",
	relations: [
		closed("Status", ["pending", "approved"]),
		relation("Sheet", { employee: f.uuid, week: Week, ceiling: f.integer }, ["employee", "week"]),
		relation("Shift", { id: f.uuid, employee: f.uuid, week: Week, status: f.closedId("Status") }, [
			"id"
		])
	],
	statements: [shiftApproved, ...(options.mutable ? [mutable("Sheet"), mutable("Shift")] : [])],
	extends: undefined
})

const nodeLive = contained(onSelected("Node", ["parent"], { live: true }), on("Node", ["id"]))

/**
 * Tree: a selected source into its own relation, `contained(on(select(Node, { live: true }), "parent"),
 * on(Node, "id"))`, one participating table that is both source and target.
 */
export const tree = (options: { readonly mutable: boolean }): SchemaDesc => ({
	name: "Tree",
	relations: [relation("Node", { id: f.integer, parent: f.integer, live: f.boolean }, ["id"])],
	statements: [nodeLive, ...(options.mutable ? [mutable("Node")] : [])],
	extends: undefined
})
