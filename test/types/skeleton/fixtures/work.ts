import { Compute } from "#compiler/public/compute.ts"
import { closedId, contract, pg, uuid } from "#compiler/public/fields.ts"
import {
	closed,
	contained,
	key,
	login,
	mutable,
	on,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { derived, query, v } from "#index.ts"

/**
 * Declare-only fixture schemas: the Work schema (NULL is banned throughout), the payroll contracts, and the Edu/Reports
 * derived levels.
 * Typechecked only; every value is a call to a declare-only constructor.
 */
export const Cents = contract("Cents", pg.bigint, (cents) => cents.ge(0n))
export const EpochDay = contract("EpochDay", pg.bigint)
export const Rate = contract("Rate", pg.numeric(7, 6), (rate) => rate.between(0n, 1n))
export const Ein = contract("Ein", str.regex("^\\d{2}-\\d{7}$"))
export const Instant = contract("Instant", pg.bigint)

export const Kind = closed("Kind", ["Automatic", "Manual"])
export const Label = str.regex("^[a-z][a-z0-9-]{0,62}$")
export const Account = relation("Account", { id: uuid, name: str.regex("^.*$", "su") }, ["id"])
export const Task = relation("Task", { id: uuid, account: uuid, kind: closedId(Kind) }, ["id"])
export const AccountLabel = relation("AccountLabel", { account: uuid, label: Label }, [
	"account",
	"label"
])

export const TaskNote = relation("TaskNote", { task: uuid, note: str.regex("^.*$", "su") }, [
	"task"
])
export const Ticket = relation("Ticket", { id: pg.bigserial, account: uuid, amount: Cents }, ["id"])
export const Tier = closed("Tier", ["Free", "Pro"]).with(
	{ budget: Cents },
	{ Free: { budget: Cents(100n) }, Pro: { budget: Cents(1000n) } }
)

export const byName = key(Account, ["name"])
export const noteOwner = contained(on(TaskNote, "task"), on(Task, "id"))

export const Work = schema("Work", { Kind, Tier, Account, Task, AccountLabel, TaskNote, Ticket }, [
	noteOwner,
	byName,
	contained(on(Task, "account"), on(Account, "id")),
	contained(on(Task, "kind"), on(Kind, "id")),
	mutable(Account)
])

/** Work's worlds: a reader and a writer, full roles, in one login. */
export const Reader = role(Work, "reader", Work.relations)
export const Writer = role(Work, "writer", Work.relations, {
	write: ["Task", "TaskNote", "Ticket"]
})
export const Server = login(Work, "server", [Reader, Writer])

export const Student = relation("Student", { id: uuid }, ["id"])
export const Sitting = relation(
	"Sitting",
	{ id: uuid, student: uuid, day: EpochDay, sat: Instant, passed: pg.boolean },
	["id"]
)
export const SchoolCalendar = relation("SchoolCalendar", { day: EpochDay, week: EpochDay }, ["day"])
export const Moment = closed("Moment", ["current"])
export const Clock = relation("Clock", { id: closedId(Moment), at: Instant }, ["id"])
export const Edu = schema("Edu", { Moment, Student, Sitting, SchoolCalendar, Clock }, [])

export const studentWeekly = query(Edu).rule((r) => {
	const { id, student, day, passed } = v(Sitting, "sitting")
	const { week } = v(SchoolCalendar, "schoolCalendar")
	return r
		.match(Sitting, { id, student, day, passed })
		.match(SchoolCalendar, { day, week })
		.find({
			student,
			week,
			sittings: r.count(),
			passes: r.sum(Compute.cond(passed, Compute.literal(pg.integer, 1), 0))
		})
})
export const StudentWeekly = derived("StudentWeekly", studentWeekly)

export const recentSittings = query(Edu).rule((r) => {
	const { at } = v(Clock, "clock")
	const { id, student, sat } = v(Sitting, "sitting")
	return r
		.match(Clock, { id: "current", at })
		.match(Sitting, { id, student, sat })
		.where(r.ge(sat, Compute.cast(Compute.sub(at, 604_800_000_000n), Instant)))
		.find({ student, recent: r.count() })
})
export const RecentSittings = derived("RecentSittings", recentSittings)

export const Reports = schema.extend(Edu, { StudentWeekly, RecentSittings }, [])

/** Reports' worlds: a reporter, and a refresher that also keeps the clock, full roles, in one login. */
export const Reporter = role(Reports, "reporter", Reports.relations)
export const Refresher = role(Reports, "refresher", Reports.relations, {
	write: ["Clock"],
	refresh: ["StudentWeekly", "RecentSittings"]
})
export const ReportsServer = login(Reports, "server", [Reporter, Refresher])
