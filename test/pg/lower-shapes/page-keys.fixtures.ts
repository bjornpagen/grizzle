/** What page-keys.test.ts reads: its schema, its windows and one case's run. */

import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert } from "@bjornpagen/testing/assert"
import { type Aimed, aimed, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order, Result } from "effect"
import { windowIntake, windowStatement } from "#adapter/page/execute.ts"
import type { PageRuntime } from "#adapter/page/template.ts"
import { windowCall } from "#adapter/page/window.ts"
import { partRuns } from "#adapter/reader/execution.ts"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import { keptRows } from "#adapter/wire/batch.ts"
import { planNodes, scannedRows } from "#bench/harness/explain.ts"
import type { BenchSession } from "#bench/harness/session.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { type Anchor, RowKey } from "#compiler/live/index.ts"
import { fillStatement } from "#compiler/physical/derived/objects.ts"
import type { Row as DeliveredRow, Param } from "#compiler/plan/common.ts"
import { columnPosition, rowCell, scalarReader } from "#compiler/plan/runtime.ts"
import { Type } from "#compiler/public/compute.ts"
import { closedId, natural, int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	contained,
	context,
	derived,
	key,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { answered, paged } from "#compiler/public/workload.ts"
import type { CreateStoredTable, Delete } from "#compiler/sql/ast.ts"
import {
	and,
	col,
	core,
	derived as derivedTable,
	eq,
	exists,
	operandSelect,
	select,
	setOperation,
	simpleSelect,
	table,
	targetAs
} from "#compiler/sql/build.ts"
import { printObjectName, printStatement } from "#compiler/sql/print.ts"
import {
	advisedExplain,
	apart,
	budgetOfPlan,
	fullWorldRole,
	grownIn,
	lawsHold,
	type PgClassState,
	pgClassStates,
	servedPageRead,
	type StateLoad,
	standIn
} from "#test/support/advice.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { conservativePageRuntime } from "#test/support/conservative.ts"
import { sentSql } from "#test/support/flight/scripted.ts"
import type { Generated, Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { readWork } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { superuserClient } from "#test/support/substrate/shared.ts"
import type { RolledBack } from "#test/support/substrate/substrate.ts"
import { outputRows, textsOfParams } from "#test/support/wire.ts"

/** A Clerk user, as metis's ClerkUser. */
const Clerk = str.regex("^user_[0-9A-Za-z]{1,64}$")

/** A person, as metis's TimebackUser, and a learner as the ledger keys it, of another refinement, as metis's Child. */
const Person = str.bytes(1020, str.regex("^.{1,255}$", "su"))
const Learner = str.bytes(69, str.regex("^.+$", "su"))
const Name = str.bytes(200, str.regex("^.+$", "su"))
const Email = str.bytes(320, str.regex("^.+@.+$", "su"))

/** The signed-in Clerk user, as metis's Session. */
const Session = context("Session", { sub: Clerk })

/**
 * A sitting ledger shaped as metis's assignment level: the people, each Clerk user's person and each person's email
 * where one is held, the tests, each learner's assignments by number (a number holds one assignment, whichever
 * learner's), each with the AlphaTest user id it was assigned to (a learner held under two), each sitting's marks
 * (every sitting holds some, a sitting's tags, each one its learner defines), its events at their steps, and its
 * gradings by revision, each with a percent and the positions it left waiting for a human grader.
 */
const People = relation("Person", { person: Person }, ["person"])
const ClerkAccount = relation("ClerkAccount", { clerk: Clerk, person: Person }, ["clerk"])
const PersonEmail = relation("PersonEmail", { person: Person, email: Email }, ["person"])
const Test = relation("Test", { test: int8, name: Name, grade: int4 }, ["test"])
const Assignment = relation(
	"Assignment",
	{ child: Learner, number: natural, test: int8, assignedAt: int8, user: natural },
	["child", "number"]
)
const Mark = relation("Mark", { child: Learner, number: natural, tag: int4 }, [
	"child",
	"number",
	"tag"
])
/** Each tag a learner defines, with its label: every mark of the learner's sittings carries one of them. */
const TagDefinition = relation("TagDefinition", { child: Learner, tag: int4, label: int4 }, [
	"child",
	"tag"
])
const EventKind = closed.unordered("EventKind", ["start", "pause", "submit", "abandon"])
const SittingEvent = relation(
	"SittingEvent",
	{ child: Learner, number: natural, step: natural, next: natural, kind: closedId(EventKind) },
	["child", "number", "step"]
)
const RecordedRevision = relation("RecordedRevision", { number: natural, revision: natural }, [
	"number",
	"revision"
])
const RecordedScore = relation(
	"RecordedScore",
	{ number: natural, revision: natural, percent: natural },
	["number", "revision"]
)
const RecordedQuestionAwaiting = relation(
	"RecordedQuestionAwaiting",
	{ number: natural, revision: natural, position: natural },
	["number", "revision", "position"]
)

/**
 * Each graded sitting's result as the coach dashboard lists it, as metis's SittingResult: when it was graded, under the
 * learner's unit; and each sitting's test type and origin where its caller stated one.
 */
const SittingResult = relation(
	"SittingResult",
	{ child: Learner, number: natural, at: int8, percent: int4 },
	["child", "number"]
)
const AssignmentTestType = relation("AssignmentTestType", { number: natural, testType: Name }, [
	"number"
])
const AssignmentOrigin = relation("AssignmentOrigin", { number: natural, origin: Name }, ["number"])

/**
 * Each user id's email and grade, as metis's restated users: keyed by the email, so a read of an email's users is a
 * chain from the call's value (metis's email-keyed read of users, METIS-PERFBAR's restatement), and each user's grade.
 */
const UserByEmail = relation("UserByEmail", { email: Email, user: natural }, ["email", "user"])
const UserGrade = relation("UserGrade", { user: natural, grade: int4 }, ["user"])

/**
 * A work queue shaped as den's: each kind's steps by when each is available (the greater of its due time and its
 * lease's end), which a worker takes in that order among those available now (den's law L4).
 */
const Queue = relation("Queue", { kind: int4, step: natural, available: int8 }, ["kind", "step"])
/** The kinds each worker serves, as den's scheduler runs several step kinds at once. */
const QueueWorker = relation("QueueWorker", { worker: natural, kind: int4 }, ["worker", "kind"])

/**
 * A staff ledger shaped as metis's ops level: the capabilities a person may be granted, each person's grants, and the
 * programs an operator runs, each with the capability it needs and those that write.
 */
const Capability = closed.unordered("Capability", ["teacher", "readOnly"])
const Grant = relation("Grant", { person: Person, capability: closedId(Capability) }, [
	"person",
	"capability"
])
const Program = closed.unordered("OpsProgram", [
	"invalidate",
	"coachAssignments",
	"coachAssignmentsOfStatus",
	"coachAssignmentsOfStudent",
	"coachAssignmentsOfGrade",
	"coachAssignmentsWithEmail",
	"coachAssignmentsMarked",
	"coachDashboard",
	"coachDashboardJoined",
	"coachDashboardOf",
	"coachDashboardOfGrade",
	"queue",
	"queueAfter",
	"queueOfKinds"
])
const ProgramNeeds = closed.relation(
	"ProgramNeeds",
	{ program: closedId(Program), capability: closedId(Capability) },
	["program"],
	[
		{ program: "invalidate", capability: "teacher" },
		{ program: "coachAssignments", capability: "teacher" },
		{ program: "coachAssignmentsOfStatus", capability: "teacher" },
		{ program: "coachAssignmentsOfStudent", capability: "teacher" },
		{ program: "coachAssignmentsOfGrade", capability: "teacher" },
		{ program: "coachAssignmentsWithEmail", capability: "teacher" },
		{ program: "coachAssignmentsMarked", capability: "teacher" },
		{ program: "coachDashboard", capability: "teacher" },
		{ program: "coachDashboardJoined", capability: "teacher" },
		{ program: "coachDashboardOf", capability: "teacher" },
		{ program: "coachDashboardOfGrade", capability: "teacher" },
		{ program: "queue", capability: "teacher" },
		{ program: "queueAfter", capability: "teacher" },
		{ program: "queueOfKinds", capability: "teacher" }
	]
)

const ProgramWrites = closed.relation(
	"ProgramWrites",
	{ program: closedId(Program) },
	["program"],
	[{ program: "invalidate" }]
)

const Status = closed.unordered("SittingStatus", [
	"ASSIGNED",
	"IN_PROGRESS",
	"PAUSED",
	"COMPLETED",
	"ABANDONED"
])

/** The coach dashboard's tabs, as metis's DashboardTab, and the status of each state's tab (DashboardTabStatus). */
const DashboardTab = closed.unordered("DashboardTab", [
	"all",
	"completed",
	"ongoing",
	"paused",
	"not-started"
])
const DashboardTabStatus = closed.relation(
	"DashboardTabStatus",
	{ tab: closedId(DashboardTab), status: closedId(Status) },
	["tab"],
	[
		{ tab: "completed", status: "COMPLETED" },
		{ tab: "ongoing", status: "IN_PROGRESS" },
		{ tab: "paused", status: "PAUSED" },
		{ tab: "not-started", status: "ASSIGNED" }
	]
)

const Stored = schema(
	"PageKeys",
	[
		People,
		ClerkAccount,
		PersonEmail,
		Test,
		Assignment,
		Mark,
		TagDefinition,
		EventKind,
		SittingEvent,
		RecordedRevision,
		RecordedScore,
		RecordedQuestionAwaiting,
		SittingResult,
		AssignmentTestType,
		AssignmentOrigin,
		UserByEmail,
		UserGrade,
		Queue,
		QueueWorker,
		Status,
		DashboardTab,
		DashboardTabStatus,
		Capability,
		Grant,
		Program,
		ProgramNeeds,
		ProgramWrites
	],
	[
		key(on(Assignment, "number")),
		unit("Learner", { child: Learner }),
		contained(on(Grant, "person"), on(People, "person")),
		contained(on(ClerkAccount, "person"), on(People, "person")),
		contained(on(PersonEmail, "person"), on(People, "person")),
		contained(on(Assignment, "child"), on(People, "person")),
		contained(on(Assignment, "test"), on(Test, "test")),
		contained(on(Assignment, "child", "number"), on(Mark, "child", "number")),
		contained(on(Mark, "child", "tag"), on(TagDefinition, "child", "tag")),
		contained(on(SittingEvent, "child", "number"), on(Assignment, "child", "number")),
		contained(on(RecordedRevision, "number"), on(Assignment, "number")),
		contained(on(RecordedScore, "number", "revision"), on(RecordedRevision, "number", "revision")),
		contained(
			on(RecordedQuestionAwaiting, "number", "revision"),
			on(RecordedRevision, "number", "revision")
		),
		contained(on(SittingResult, "child", "number"), on(Assignment, "child", "number")),
		contained(on(AssignmentTestType, "number"), on(Assignment, "number")),
		contained(on(AssignmentOrigin, "number"), on(Assignment, "number"))
	]
)

/**
 * Each sitting's status from its events, as metis's AssignmentStatus: a union of five rules, each sitting's (child,
 * number) drawn from its assignment's or its events'.
 */
const statusesOfEvents = () =>
	query(Stored)
		.rule((r) => {
			const { child, number } = v(Assignment, "assignment")
			return r
				.match(Assignment, { child, number })
				.where(r.not(SittingEvent, { child, number }))
				.find({ child, number, status: Status.handle("ASSIGNED") })
		})
		.rule((r) => {
			const { child, number, next } = v(SittingEvent, "latest")
			return r
				.match(SittingEvent, { child, number, next, kind: "start" })
				.where(r.not(SittingEvent, { child, number, step: next }))
				.find({ child, number, status: Status.handle("IN_PROGRESS") })
		})
		.rule((r) => {
			const { child, number, next } = v(SittingEvent, "latest")
			return r
				.match(SittingEvent, { child, number, next, kind: "pause" })
				.where(r.not(SittingEvent, { child, number, step: next }))
				.find({ child, number, status: Status.handle("PAUSED") })
		})
		.rule((r) => {
			const { child, number } = v(SittingEvent, "closing")
			return r
				.match(SittingEvent, { child, number, kind: "submit" })
				.find({ child, number, status: Status.handle("COMPLETED") })
		})
		.rule((r) => {
			const { child, number } = v(SittingEvent, "closing")
			return r
				.match(SittingEvent, { child, number, kind: "abandon" })
				.find({ child, number, status: Status.handle("ABANDONED") })
		})

/**
 * The statuses stored under the learner's unit, keyed by (child, number, status): no key proves one status a sitting,
 * as metis's AssignmentStatus before its laws state one.
 */
const AssignmentStatus = derived("AssignmentStatus", statusesOfEvents())

/**
 * The same statuses as metis's AssignmentStatus once its laws state exactly one status a sitting (METIS-STAFF's ruling):
 * keyed by (child, number), and every assignment holding one, a containment of each assignment in the statuses.
 */
const SittingStatusOne = derived("SittingStatusOne", statusesOfEvents())

const Statuses = schema.extend(
	[Stored],
	"PageKeys_1",
	[AssignmentStatus, SittingStatusOne],
	[
		key(on(SittingStatusOne, "child", "number")),
		contained(on(Assignment, "child", "number"), on(SittingStatusOne, "child", "number"))
	]
)

/**
 * Each sitting on each tab of the coach dashboard with the coordinates of its place in AlphaTest's order, as metis's
 * DashboardEntry (packages/ops/src/coach-views.ts): whether it holds a result, when it was graded where it does, and
 * when it was assigned; `all` every sitting, each state's tab those in its state; and the user id it was assigned to, as
 * metis's restated view carries it (main's ruling: the head widened with child, user and status). metis's view states no
 * learner, which its number determines through its assignment's key, and is stored under the learner's unit once
 * storage reads a unit key through a heading's dependencies; this one states the learner, so it is stored under the unit
 * today.
 */
const DashboardEntry = derived(
	"DashboardEntry",
	query(Statuses)
		.rule((r) => {
			const { child, number, assignedAt, user } = v(Assignment, "listedAll")
			const { at } = v(SittingResult, "listedAllResult")
			return r
				.match(Assignment, { child, number, assignedAt, user })
				.match(SittingResult, { child, number, at })
				.find({
					tab: DashboardTab.handle("all"),
					child,
					number,
					user,
					scored: true,
					at,
					assignedAt
				})
		})
		.rule((r) => {
			const { child, number, assignedAt, user } = v(Assignment, "listedAllUnscored")
			return r
				.match(Assignment, { child, number, assignedAt, user })
				.where(r.not(SittingResult, { child, number }))
				.find({
					tab: DashboardTab.handle("all"),
					child,
					number,
					user,
					scored: false,
					at: Type.literal(int8, 0n),
					assignedAt
				})
		})
		.rule((r) => {
			const { child, number, assignedAt, user } = v(Assignment, "listedState")
			const { status } = v(AssignmentStatus, "listedStateStatus")
			const { tab } = v(DashboardTabStatus, "listedStateTab")
			const { at } = v(SittingResult, "listedStateResult")
			return r
				.match(Assignment, { child, number, assignedAt, user })
				.match(AssignmentStatus, { child, number, status })
				.match(DashboardTabStatus, { tab, status })
				.match(SittingResult, { child, number, at })
				.find({ tab, child, number, user, scored: true, at, assignedAt })
		})
		.rule((r) => {
			const { child, number, assignedAt, user } = v(Assignment, "listedStateUnscored")
			const { status } = v(AssignmentStatus, "listedStateUnscoredStatus")
			const { tab } = v(DashboardTabStatus, "listedStateUnscoredTab")
			return r
				.match(Assignment, { child, number, assignedAt, user })
				.match(AssignmentStatus, { child, number, status })
				.match(DashboardTabStatus, { tab, status })
				.where(r.not(SittingResult, { child, number }))
				.find({
					tab,
					child,
					number,
					user,
					scored: false,
					at: Type.literal(int8, 0n),
					assignedAt
				})
		})
)

/**
 * The dashboard's entries keyed by tab and number, as metis's restated DashboardEntry (main's ruling: stored, keyed
 * (tab, number)): a sitting stands once on each tab it is listed on, its number one assignment's.
 */
const Views = schema.extend(
	[Statuses],
	"PageKeys_2",
	[DashboardEntry],
	[key(on(DashboardEntry, "tab", "number"))]
)

/**
 * The programs each Clerk user may run, as metis's OperatorMay: one whose person holds the capability it needs, and, for a
 * program that writes, holds no grant of reading only. Two rules, a union, which the operator's guard reads as an
 * existence test beside a window's relations, as metis's does.
 */
const OperatorMay = derived(
	"OperatorMay",
	query(Views)
		.rule((r) => {
			const { clerk, person } = v(ClerkAccount, "account")
			const { program, capability } = v(ProgramNeeds, "needs")
			return r
				.match(ClerkAccount, { clerk, person })
				.match(ProgramNeeds, { program, capability })
				.match(Grant, { person, capability })
				.where(r.not(ProgramWrites, { program }))
				.find({ clerk, program })
		})
		.rule((r) => {
			const { clerk, person } = v(ClerkAccount, "account")
			const { program, capability } = v(ProgramNeeds, "needs")
			return r
				.match(ClerkAccount, { clerk, person })
				.match(ProgramNeeds, { program, capability })
				.match(Grant, { person, capability })
				.match(ProgramWrites, { program })
				.where(r.not(Grant, { person, capability: "readOnly" }))
				.find({ clerk, program })
		})
)

const Ops = schema.extend([Views], "PageKeys_3", [OperatorMay], [])

/** The programs the signed-in operator may run, as metis's `may`. */
const may = query(Ops).rule((r) => {
	const { clerk, program } = v(OperatorMay, "may")
	return r.match(Session, { sub: clerk }).match(OperatorMay, { clerk, program }).find({ program })
})

/** Each sitting's gradings superseded by a later one, as metis's supersededRevision. */
const supersededRevision = query(Ops).rule((r) => {
	const { number, revision } = v(RecordedRevision, "earlier")
	const later = v(RecordedRevision, "later")
	return r
		.match(RecordedRevision, { number, revision })
		.match(RecordedRevision, { number, revision: later.revision })
		.where(r.gt(later.revision, revision))
		.find({ number, revision })
})

/** Each graded sitting's grading in force, its greatest revision, as metis's revisionInForce. */
const revisionInForce = query(Ops).rule((r) => {
	const { number, revision } = v(RecordedRevision, "inForce")
	return r
		.match(RecordedRevision, { number, revision })
		.where(r.not(supersededRevision, { number, revision }))
		.find({ number, revision })
})

/** Each position its sitting's grading in force left waiting, as metis's awaitingInForce. */
const awaitingInForce = query(Ops).rule((r) => {
	const { number, revision } = v(revisionInForce, "inForce")
	const { position } = v(RecordedQuestionAwaiting, "waiting")
	return r
		.match(revisionInForce, { number, revision })
		.match(RecordedQuestionAwaiting, { number, revision, position })
		.find({ number, position })
})

/** Each graded sitting's percent, its grading in force's, as metis's percentInForce. */
const percentInForce = query(Ops).rule((r) => {
	const { number, revision } = v(revisionInForce, "inForce")
	const { percent } = v(RecordedScore, "score")
	return r
		.match(revisionInForce, { number, revision })
		.match(RecordedScore, { number, revision, percent })
		.find({ number, revision, percent })
})

/** A person's email, as metis's emailOf. */
const emailOf = query(Ops).rule((r) => {
	const { email } = v(PersonEmail, "email")
	return r.match(PersonEmail, { person: r.param("person", Person), email }).find({ email })
})

/**
 * The windows of metis's coachAssignments and its siblings (`windowOf`): every sitting (`all`), one status's (`status`)
 * and one student's (`student`), which a driver drives; and three a driver must not drive, each held to the unpaged
 * read by the oracle: one filtered by its test's grade, a column of no driver whose test is exactly one a sitting
 * (`grade`), one joining each student's person and email in its body, which no containment proves every person holds
 * and no chain from the call reads (`email`: a person's email is contained in the people, never the people in the
 * emails), and one joining each sitting's marks in its body, several a sitting, each with its tag's definition, which
 * no chain from the call reads (`marked`): the definition reads the mark's tag, so the marks stay a join of the region
 * where alone they would be an existence test, which the driver refuses before it asks how many a sitting holds.
 */
type SittingWindow = "all" | "status" | "student" | "grade" | "email" | "marked"

/**
 * The windows a case reads: the sitting windows (`SittingWindow`); the coach dashboard's tab, its status attached or
 * joined (`dashboard`, `dashboardJoined`), and one student's tab by an email (`dashboardOf`, metis's restated
 * coachDashboardOf: a part for each of the email's users, merged), each driven; the same student's tab of the tests at
 * the user's own grade, which the test, exactly one a sitting, and the email's users' chain both bind
 * (`dashboardOfGrade`), not driven; den's queue of one kind among those available now (`queue`, law L4: the interval
 * of the order's first column), driven; the same past a step (`queueAfter`), a comparison of the order's second
 * column, which no index the take reads bounds, not driven; and the steps available now of every kind one worker serves
 * (`queueOfKinds`), a part for each of the worker's kinds, merged, driven.
 */
export type Window = DrivenWindow | RefusedWindow

/** The windows a driver drives: each read from each start, a seek, an offset and a backward read each the driver's. */
export const drivenWindows = [
	"all",
	"status",
	"student",
	"dashboard",
	"dashboardJoined",
	"dashboardOf",
	"queue",
	"queueOfKinds"
] as const satisfies ReadonlyArray<SittingWindow | DashboardWindow>
export type DrivenWindow = (typeof drivenWindows)[number]

/** The windows a driver must not drive: each read as it stands, from any start. */
export const refusedWindows = [
	"grade",
	"email",
	"marked",
	"dashboardOfGrade",
	"queueAfter"
] as const satisfies ReadonlyArray<SittingWindow | DashboardWindow>
export type RefusedWindow = (typeof refusedWindows)[number]

/** The windows past the sitting windows: the dashboard's and den's queue's. */
type DashboardWindow =
	| "dashboard"
	| "dashboardJoined"
	| "dashboardOf"
	| "dashboardOfGrade"
	| "queue"
	| "queueAfter"
	| "queueOfKinds"

/** The program each sitting window's guard names. */
const programOf: Readonly<Record<SittingWindow, (typeof Program)["handles"][number]>> = {
	all: "coachAssignments",
	status: "coachAssignmentsOfStatus",
	student: "coachAssignmentsOfStudent",
	grade: "coachAssignmentsOfGrade",
	email: "coachAssignmentsWithEmail",
	marked: "coachAssignmentsMarked"
}

/**
 * A window of the coach dashboard, as metis's coachAssignments and its siblings: the guard of the signed-in operator's
 * permission, each sitting with its student, its test's name and its status, a window's own filter or join beside them,
 * newest first; each row with its student's email, its grading in force's percent, a take of one, and its waiting
 * positions attached.
 */
const windowOf = (w: SittingWindow) =>
	query(Ops)
		.rule((r) => {
			const { number, child: student, test } = v(Assignment, "assignment")
			const { name, grade } = v(Test, "test")
			const { status } = v(AssignmentStatus, "status")
			const { email } = v(PersonEmail, "email")
			const { tag } = v(Mark, "mark")
			const { label } = v(TagDefinition, "definition")
			const body = r
				.match(may, { program: programOf[w] })
				.match(Assignment, { number, child: student, test })
				.match(Test, { test, name, grade })
				.match(AssignmentStatus, { child: student, number, status })
			switch (w) {
				case "all":
					return body.find({ number, student, name, status })
				case "status":
					return body
						.where(r.eq(status, r.param("status", closedId(Status))))
						.find({ number, student, name, status })
				case "student":
					return body
						.where(r.eq(student, r.param("student", Learner)))
						.find({ number, student, name, status })
				case "grade":
					return body
						.where(r.eq(grade, r.param("grade", int4)))
						.find({ number, student, name, status })
				case "email":
					return body
						.match(People, { person: student })
						.match(PersonEmail, { person: student, email })
						.find({ number, student, name, status })
				case "marked":
					return body
						.match(Mark, { child: student, number, tag })
						.match(TagDefinition, { child: student, tag, label })
						.find({ number, student, name, status })
			}
		})
		.attach(
			"email",
			(row) =>
				query(Ops).rule((r) => {
					const of = emailOf.bind({ person: row.student })
					const { email } = v(of, "email")
					return r.match(of, { email }).find({ email })
				}),
			"option"
		)
		.attach(
			"percent",
			(row) =>
				query(Ops)
					.rule((r) => {
						const { revision, percent } = v(percentInForce, "percent")
						return r
							.match(percentInForce, { number: row.number, revision, percent })
							.find({ revision, percent })
					})
					.orderBy(["revision", "desc"])
					.take(1),
			"option"
		)
		.attach(
			"awaiting",
			(row) =>
				query(Ops).rule((r) => {
					const { position } = v(awaitingInForce, "waiting")
					return r.match(awaitingInForce, { number: row.number, position }).find({ position })
				}),
			"array"
		)
		.orderBy(["number", "desc"])

/**
 * A window of one tab of the coach dashboard, as metis's coachDashboard (packages/ops/src/coach.ts) in the form its
 * driver reads: each sitting's entry on the tab, its assignment and its test, in AlphaTest's order (the newest result
 * first, then the newest assigned), each row with what the dashboard shows of it, about ten facts: its status (metis's
 * body join of the status, which no key proves one per sitting, read as an attachment), its student's email, its
 * grading in force's percent, its waiting positions, its test type and origin, and its result.
 */
const dashboard = query(Ops)
	.rule((r) => {
		const { child: student, number, scored, at, assignedAt } = v(DashboardEntry, "entry")
		const { test } = v(Assignment, "entryAssignment")
		const { name, grade } = v(Test, "entryTest")
		return r
			.match(may, { program: "coachDashboard" })
			.match(DashboardEntry, {
				tab: r.param("tab", closedId(DashboardTab)),
				child: student,
				number,
				scored,
				at,
				assignedAt
			})
			.match(Assignment, { child: student, number, test })
			.match(Test, { test, name, grade })
			.find({ number, student, name, grade, scored, at, assignedAt })
	})
	.attach(
		"status",
		(row) =>
			query(Ops).rule((r) => {
				const { status } = v(AssignmentStatus, "rowStatus")
				return r
					.match(AssignmentStatus, { child: row.student, number: row.number, status })
					.find({ status })
			}),
		"array"
	)
	.attach(
		"email",
		(row) =>
			query(Ops).rule((r) => {
				const of = emailOf.bind({ person: row.student })
				const { email } = v(of, "email")
				return r.match(of, { email }).find({ email })
			}),
		"option"
	)
	.attach(
		"percent",
		(row) =>
			query(Ops)
				.rule((r) => {
					const { revision, percent } = v(percentInForce, "percent")
					return r
						.match(percentInForce, { number: row.number, revision, percent })
						.find({ revision, percent })
				})
				.orderBy(["revision", "desc"])
				.take(1),
		"option"
	)
	.attach(
		"awaiting",
		(row) =>
			query(Ops).rule((r) => {
				const { position } = v(awaitingInForce, "waiting")
				return r.match(awaitingInForce, { number: row.number, position }).find({ position })
			}),
		"array"
	)
	.attach(
		"testType",
		(row) =>
			query(Ops).rule((r) => {
				const { testType } = v(AssignmentTestType, "testType")
				return r.match(AssignmentTestType, { number: row.number, testType }).find({ testType })
			}),
		"option"
	)
	.attach(
		"origin",
		(row) =>
			query(Ops).rule((r) => {
				const { origin } = v(AssignmentOrigin, "origin")
				return r.match(AssignmentOrigin, { number: row.number, origin }).find({ origin })
			}),
		"option"
	)
	.attach(
		"result",
		(row) =>
			query(Ops).rule((r) => {
				const { at, percent } = v(SittingResult, "result")
				return r
					.match(SittingResult, { child: row.student, number: row.number, at, percent })
					.find({ at, percent })
			}),
		"option"
	)
	.orderBy(["scored", "desc"], ["at", "desc"], ["assignedAt", "desc"])

/**
 * The same tab's window with each sitting's status joined in its body, as metis's coachDashboard reads it once its laws
 * state one status a sitting (METIS-STAFF's ruling): the status's key (child, number) and each assignment's containment
 * in the statuses make it exactly one per entry, so a driver drives it as it drives the attached form.
 */
const dashboardJoined = query(Ops)
	.rule((r) => {
		const { child: student, number, scored, at, assignedAt } = v(DashboardEntry, "entry")
		const { test } = v(Assignment, "entryAssignment")
		const { status } = v(SittingStatusOne, "entryStatus")
		const { name, grade } = v(Test, "entryTest")
		return r
			.match(may, { program: "coachDashboardJoined" })
			.match(DashboardEntry, {
				tab: r.param("tab", closedId(DashboardTab)),
				child: student,
				number,
				scored,
				at,
				assignedAt
			})
			.match(Assignment, { child: student, number, test })
			.match(SittingStatusOne, { child: student, number, status })
			.match(Test, { test, name, grade })
			.find({ number, student, name, grade, status, scored, at, assignedAt })
	})
	.attach(
		"email",
		(row) =>
			query(Ops).rule((r) => {
				const of = emailOf.bind({ person: row.student })
				const { email } = v(of, "email")
				return r.match(of, { email }).find({ email })
			}),
		"option"
	)
	.attach(
		"percent",
		(row) =>
			query(Ops)
				.rule((r) => {
					const { revision, percent } = v(percentInForce, "percent")
					return r
						.match(percentInForce, { number: row.number, revision, percent })
						.find({ revision, percent })
				})
				.orderBy(["revision", "desc"])
				.take(1),
		"option"
	)
	.attach(
		"awaiting",
		(row) =>
			query(Ops).rule((r) => {
				const { position } = v(awaitingInForce, "waiting")
				return r.match(awaitingInForce, { number: row.number, position }).find({ position })
			}),
		"array"
	)
	.attach(
		"testType",
		(row) =>
			query(Ops).rule((r) => {
				const { testType } = v(AssignmentTestType, "testType")
				return r.match(AssignmentTestType, { number: row.number, testType }).find({ testType })
			}),
		"option"
	)
	.attach(
		"origin",
		(row) =>
			query(Ops).rule((r) => {
				const { origin } = v(AssignmentOrigin, "origin")
				return r.match(AssignmentOrigin, { number: row.number, origin }).find({ origin })
			}),
		"option"
	)
	.attach(
		"result",
		(row) =>
			query(Ops).rule((r) => {
				const { at, percent } = v(SittingResult, "result")
				return r
					.match(SittingResult, { child: row.student, number: row.number, at, percent })
					.find({ at, percent })
			}),
		"option"
	)
	.orderBy(["scored", "desc"], ["at", "desc"], ["assignedAt", "desc"])

/**
 * One student's tab of the coach dashboard by an email, as metis's coachDashboardOf restated (packages/ops/src/coach.ts;
 * main's ruling: the entry carries its user, and an email's users are read by the email): each entry of the tab whose
 * user holds the email, with its assignment and test, in AlphaTest's order, its result attached. A driver's value set:
 * the email's users, read from the call by their email, a part of the window for each, merged (`grade`: the same at the
 * user's own grade, which the test binds too, so the users' chain alone states no part's rows).
 */
const dashboardOfWindow = (atGrade: boolean) =>
	query(Ops)
		.rule((r) => {
			const { child: student, number, user, scored, at, assignedAt } = v(DashboardEntry, "entry")
			const { test } = v(Assignment, "entryAssignment")
			const { name, grade } = v(Test, "entryTest")
			const { email } = v(UserByEmail, "searched")
			const body = r
				.match(may, { program: atGrade ? "coachDashboardOfGrade" : "coachDashboardOf" })
				.match(DashboardEntry, {
					tab: r.param("tab", closedId(DashboardTab)),
					child: student,
					number,
					user,
					scored,
					at,
					assignedAt
				})
				.match(Assignment, { child: student, number, test })
				.match(Test, { test, name, grade })
				.match(UserByEmail, { email, user })
				.where(r.eq(email, r.param("email", Email)))
			return (atGrade ? body.match(UserGrade, { user, grade }) : body).find({
				number,
				student,
				user,
				name,
				grade,
				scored,
				at,
				assignedAt
			})
		})
		.attach(
			"result",
			(row) =>
				query(Ops).rule((r) => {
					const { at, percent } = v(SittingResult, "result")
					return r
						.match(SittingResult, { child: row.student, number: row.number, at, percent })
						.find({ at, percent })
				}),
			"option"
		)
		.orderBy(["scored", "desc"], ["at", "desc"], ["assignedAt", "desc"])

/**
 * den's queue (law L4): one kind's steps available now, the earliest available first, as a worker takes them; the
 * driver's interval, its order's first column at most now. `after`: the same past a step, the order's second column,
 * which bounds no index range the take reads in order.
 */
const queueWindow = (after: boolean) =>
	query(Ops)
		.rule((r) => {
			const { step, available } = v(Queue, "queued")
			const body = r
				.match(may, { program: after ? "queueAfter" : "queue" })
				.match(Queue, { kind: r.param("kind", int4), step, available })
			return (
				after
					? body.where(r.le(available, r.param("now", int8)), r.gt(step, r.param("after", natural)))
					: body.where(r.le(available, r.param("now", int8)))
			).find({ step, available })
		})
		.orderBy(["available", "asc"], ["step", "asc"])

/**
 * den's queue over several kinds at once: the steps available now of every kind one worker serves, the earliest first.
 * A driver's value set: the worker's kinds, read from the call by the worker, a part of the window for each, each
 * part's take cut at the window's size and the parts merged in the order, so the window reads at most its size of each
 * kind's steps however many each holds.
 */
const queueOfKindsWindow = query(Ops)
	.rule((r) => {
		const { kind, step, available } = v(Queue, "queued")
		const { worker } = v(QueueWorker, "serves")
		return r
			.match(may, { program: "queueOfKinds" })
			.match(QueueWorker, { worker, kind })
			.match(Queue, { kind, step, available })
			.where(r.eq(worker, r.param("worker", natural)), r.le(available, r.param("now", int8)))
			.find({ kind, step, available })
	})
	.orderBy(["available", "asc"], ["step", "asc"])

const windows: Readonly<Record<Window, unknown>> = {
	all: windowOf("all"),
	status: windowOf("status"),
	student: windowOf("student"),
	grade: windowOf("grade"),
	email: windowOf("email"),
	marked: windowOf("marked"),
	dashboard,
	dashboardJoined,
	dashboardOf: dashboardOfWindow(false),
	dashboardOfGrade: dashboardOfWindow(true),
	queue: queueWindow(false),
	queueAfter: queueWindow(true),
	queueOfKinds: queueOfKindsWindow
}

/** The ledger installed through its first migration, with an operator whose workload pages every window. */
export const pageTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "page keys",
	fixture: Ops,
	programs: {
		all: answered(paged(windowOf("all"))),
		status: answered(paged(windowOf("status"))),
		student: answered(paged(windowOf("student"))),
		grade: answered(paged(windowOf("grade"))),
		email: answered(paged(windowOf("email"))),
		marked: answered(paged(windowOf("marked"))),
		dashboard: answered(paged(dashboard)),
		dashboardJoined: answered(paged(dashboardJoined)),
		dashboardOf: answered(paged(dashboardOfWindow(false))),
		dashboardOfGrade: answered(paged(dashboardOfWindow(true))),
		queue: answered(paged(queueWindow(false))),
		queueAfter: answered(paged(queueWindow(true)))
	},
	contexts: [Session],
	label: "page_keys",
	ambient: ordinarySession
})

/** Where a window starts: the first rows, past an anchor row, the last rows, before an anchor row, or at a position. */
export type Start = "first" | "after" | "last" | "before" | "at"

/**
 * A case: the window read, where it starts and its size; the learners stored, each with `sittings` sittings, their
 * events by place (none, a start, a start and a pause, a start and a submission, an abandonment, which only the first
 * two learners' sittings hold: a status rare however many learners the store holds), each submitted sitting's
 * `revisions` gradings, its marks, and an email for every other learner; the anchor's place in the unpaged read, a
 * fraction of its rows; the learners stored beside them before the window is read again; and the pg_class state every
 * table stands in where its optimized window is read (test/support/advice.ts PgClassState).
 */
export interface PageCase {
	readonly window: Window
	readonly start: Start
	readonly size: number
	readonly learners: number
	readonly sittings: number
	readonly revisions: number
	readonly marks: number
	readonly place: number
	readonly rare: boolean
	readonly more: number
	readonly state: PgClassState
}

/** Where a window may start, each a window's own variant of the page. */
export const starts = [
	"first",
	"after",
	"last",
	"before",
	"at"
] as const satisfies ReadonlyArray<Start>

/**
 * The situations a case is drawn at, each as likely: a driven window from one start, or a refused window, whose start
 * any draw gives (`PageFeature`).
 */
const drawnAt = Arr.appendAll(
	Arr.flatMap(drivenWindows, (window) =>
		Arr.map(starts, (start): Drawn => ({ kind: "driven", window, start }))
	),
	Arr.map(refusedWindows, (window): Drawn => ({ kind: "refused", window }))
)

/** A situation a case is drawn at (`drawnAt`): a driven window from a start, or a refused window. */
type Drawn =
	| { readonly kind: "driven"; readonly window: DrivenWindow; readonly start: Start }
	| { readonly kind: "refused"; readonly window: RefusedWindow }

/** A case at the situation `at`: its window, and its start where `at` names one (a refused window's any start). */
const caseAt =
	(at: Drawn): Gen<PageCase> =>
	(s) => {
		const anyStart = s.draw(element<Start>(starts))
		return {
			window: at.window,
			start: at.kind === "driven" ? at.start : anyStart,
			size: s.draw(int(1, 12)),
			learners: s.draw(int(6, 16)),
			sittings: s.draw(int(3, 8)),
			revisions: s.draw(int(1, 3)),
			marks: s.draw(int(1, 3)),
			place: s.draw(int(0, 100)),
			rare: s.draw(element([true, false])),
			more: s.draw(int(60, 160)),
			state: s.draw(element<PgClassState>(pgClassStates))
		}
	}

/** The feature a case at `at` reaches: its driven window from its start, or its refused window. */
const featureAt = (at: Drawn): PageFeature =>
	at.kind === "driven" ? (`${at.window} from ${at.start}` as const) : at.window

/**
 * The cases: a situation drawn (`drawnAt`) and the rest of a case at it; and where a steered case's turn aims at a
 * situation no case reached yet, a case at that situation (testing gen `aimed`).
 */
export const pageSpace: Aimed<PageCase, PageFeature> = aimed(
	(s) => caseAt(s.draw(element(drawnAt)))(s),
	Arr.appendAll(
		Arr.map(drawnAt, (at) => [featureAt(at), caseAt(at)] as const),
		Arr.map(
			drivenWindows,
			(window) =>
				[
					`${window} over rows` as const,
					caseAt({ kind: "driven", window, start: "first" })
				] as const
		)
	)
)

export type PageFeature =
	| `${DrivenWindow} from ${Start}`
	| RefusedWindow
	| `${DrivenWindow} over rows`
	| `${StoredView} holds rows`
	| "beside a few learners"
	| "beside many learners"
	| `with every table ${PgClassState}`

/**
 * The statements storing learners `from` to `to` (learner c the person `person c`): each one's sittings, numbered so a
 * later learner's are newer, of the case's tests in turn, each assigned to one of the learner's two user ids in turn;
 * their events by place, every fifth sitting abandoned where its learner is one of the first two (the rare status);
 * each submitted sitting's gradings, each with a percent and a waiting position; each learner's three tags and every
 * sitting's marks of them; an email for every other learner; each user id's email, two learners' four ids sharing one
 * (`e1@x.org` learners 1 and 2's), and grade; and each sitting's step in one of two queues, available at a time spread
 * over the sittings, the one worker serving both.
 */
const stored = (
	installed: Installed,
	c: PageCase,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const kind = (handle: (typeof EventKind)["handles"][number]): string =>
		String(names.code(EventKind, handle))
	const learners = `FROM generate_series(${String(from)}, ${String(to)}) AS g(c)`
	const sittings = `${learners}, generate_series(1, ${String(c.sittings)}) AS h(j)`
	const users = `${learners}, generate_series(0, 1) AS u(u)`
	const number = `(g.c - 1) * ${String(c.sittings)} + h.j`
	const event = (step: number, code: string, where: string) =>
		`INSERT INTO ${names.table(SittingEvent)} SELECT 'person ' || g.c, ${number}, ${String(step)}, ${String(step + 1)}, ${code} ${sittings} WHERE ${where}`
	const submitted = `${sittings}, generate_series(1, ${String(c.revisions)}) AS r(v) WHERE h.j % 5 = 3`
	return [
		`INSERT INTO ${names.table(People)} SELECT 'person ' || g.c ${learners}`,
		`INSERT INTO ${names.table(PersonEmail)} SELECT 'person ' || g.c, 'p' || g.c || '@x.org' ${learners} WHERE g.c % 2 = 0`,
		`INSERT INTO ${names.table(Assignment)} SELECT 'person ' || g.c, ${number}, 1 + h.j % 3, (${number}) * 37 % 1009, 2 * g.c + h.j % 2 ${sittings}`,
		`INSERT INTO ${names.table(UserByEmail)} SELECT 'e' || (g.c + 1) / 2 || '@x.org', 2 * g.c + u.u ${users}`,
		`INSERT INTO ${names.table(UserGrade)} SELECT 2 * g.c + u.u, 1 + (g.c + u.u) % 3 ${users}`,
		`INSERT INTO ${names.table(Queue)} SELECT 1 + h.j % 2, ${number}, (${number}) * 53 % 1009 ${sittings}`,
		`INSERT INTO ${names.table(SittingResult)} SELECT 'person ' || g.c, ${number}, 5000 + (${number}) * 13 % 997, 50 + h.j ${sittings} WHERE h.j % 5 = 3`,
		`INSERT INTO ${names.table(AssignmentTestType)} SELECT ${number}, 'type ' || h.j % 2 ${sittings} WHERE h.j % 2 = 0`,
		`INSERT INTO ${names.table(AssignmentOrigin)} SELECT ${number}, 'origin' ${sittings} WHERE h.j % 3 = 0`,
		`INSERT INTO ${names.table(TagDefinition)} SELECT 'person ' || g.c, t.t, 10 * t.t ${learners}, generate_series(1, 3) AS t(t)`,
		`INSERT INTO ${names.table(Mark)} SELECT 'person ' || g.c, ${number}, m ${sittings}, generate_series(1, ${String(c.marks)}) AS k(m)`,
		event(0, kind("start"), "h.j % 5 IN (1, 2, 3)"),
		event(1, kind("pause"), "h.j % 5 = 2"),
		event(1, kind("submit"), "h.j % 5 = 3"),
		event(0, kind("abandon"), "h.j % 5 = 4 AND g.c <= 2"),
		`INSERT INTO ${names.table(RecordedRevision)} SELECT ${number}, r.v ${submitted}`,
		`INSERT INTO ${names.table(RecordedScore)} SELECT ${number}, r.v, 50 + r.v ${submitted}`,
		`INSERT INTO ${names.table(RecordedQuestionAwaiting)} SELECT ${number}, r.v, 1 + h.j % 2 ${submitted}`
	]
}

/**
 * Each derived relation the installation stores brought to its definition over the rows the case stored, in the
 * installation's order, so a stored relation another's definition reads is brought first (storedDifference). The case
 * writes its rows directly, past the write programs that keep a stored relation's rows, so without its fill a stored
 * view holds none, and each window over one reads nothing.
 */
const storedFills = (installed: Installed): ReadonlyArray<string> =>
	Arr.flatMap(installed.installation.statements, (statement) =>
		statement.kind === "createStoredTable" ? storedDifference(statement) : []
	)

/**
 * A stored relation's table brought to its definition by the difference alone, as the write programs that keep its rows
 * write it: each stored row its definition no longer holds deleted, then each row of its definition the table does not
 * hold inserted (physical/derived/objects.ts fillStatement, its query less the table's rows). A batch of learners
 * deletes none, every stored relation here stored under the learner's unit, and inserts the batch's rows alone, so no
 * stored row stands in two versions, one its snapshot does not see, as emptying the table before each fill left every
 * earlier batch's rows (the skewed state's prefix's among them).
 */
const storedDifference = (create: CreateStoredTable): ReadonlyArray<string> => {
	const held = (alias: string) =>
		operandSelect(
			core(
				Arr.map(create.columns, (c) => targetAs(col(alias, c), c)),
				[table(create.name.schema, create.name.name, alias)],
				undefined
			)
		)
	const removed: Delete = {
		kind: "delete",
		with: undefined,
		table: create.name,
		alias: "t",
		using: [],
		where: exists(
			simpleSelect(
				[],
				[derivedTable(select(setOperation("EXCEPT", [held("s"), create.query])), "x", false)],
				and(mapNonEmpty(create.columns, (c) => eq(col("x", c), col("t", c))))
			)
		),
		returning: []
	}
	const fill = fillStatement(create)
	return [
		printStatement(removed),
		printStatement({ ...fill, query: select(setOperation("EXCEPT", [create.query, held("s")])) })
	]
}

/**
 * The derived relations the installation stores, which the windows read (their statuses and the dashboard's entries),
 * each filled after each batch (`storedFills`).
 */
export const storedViews = [AssignmentStatus, SittingStatusOne, DashboardEntry] as const
export type StoredView = (typeof storedViews)[number]["name"]

/**
 * Notes each stored view the windows read that holds rows (`<view> holds rows`), so a run whose stored views stand
 * empty, each window over them comparing two empty reads, reaches none of these required situations; failing where the
 * installation stores a relation the box does not list, whose fill would then go unchecked, or a table for each alias
 * of one definition, which the canonical relation's one table holds (analysis/schema.ts CheckedSchema installedAs).
 */
const notedStoredViews = (installed: Installed, connection: PgConnection, k: Case<PageFeature>) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const stored = Arr.flatMap(installed.installation.statements, (statement) =>
			statement.kind === "createStoredTable" ? [printObjectName(statement.name)] : []
		)
		assert.deepEqual(
			Arr.sort(stored, Order.String),
			Arr.sort(Arr.dedupe(Arr.map(storedViews, (view) => names.table(view))), Order.String),
			"the installation stores the box's stored views alone, one table for AssignmentStatus and SittingStatusOne, two aliases of one definition"
		)
		for (const view of storedViews) {
			const counted = yield* connection.queryValues(
				`SELECT (count(*) > 0)::text FROM ${names.table(view)}`,
				[]
			)
			if (counted[0]?.[0] === "true") {
				k.note(`${view.name} holds rows`)
			}
		}
	})

/** Every stored table a case's rows stand in, each by its quoted name. */
const caseTables = (installed: Installed): Arr.NonEmptyReadonlyArray<string> => {
	const names = namesOf(installed)
	return [
		names.table(AssignmentStatus),
		names.table(SittingStatusOne),
		names.table(DashboardEntry),
		...Arr.map(
			[
				People,
				ClerkAccount,
				PersonEmail,
				Test,
				Assignment,
				Mark,
				SittingEvent,
				RecordedRevision,
				RecordedScore,
				RecordedQuestionAwaiting,
				SittingResult,
				AssignmentTestType,
				AssignmentOrigin,
				UserByEmail,
				UserGrade,
				Queue,
				QueueWorker,
				TagDefinition,
				Grant
			],
			(t) => names.table(t)
		)
	]
}

/**
 * The load of a case's learners 1 to `learners` on `connection` (test/support/advice.ts StateLoad), a learner its unit:
 * each one's rows (`stored`), then every stored view filled again over what the tables hold (`storedFills`).
 */
const learnersLoad = (
	installed: Installed,
	connection: PgConnection,
	c: PageCase,
	learners: number
): StateLoad => ({
	tables: caseTables(installed),
	units: learners,
	load: (from, to) =>
		Effect.forEach(
			[...stored(installed, c, from, to), ...storedFills(installed)],
			(sql) => connection.query(sql, []),
			{ discard: true }
		)
})

/** A case's window where a driver drives it. */
const drivenOf = (c: PageCase): Option.Option<DrivenWindow> =>
	Arr.findFirst(drivenWindows, (w) => w === c.window)

/** The situation a case reaches (`drawnAt`, `featureAt`): its window, driven or refused, from its start. */
const situationOf = (c: PageCase): PageFeature =>
	featureAt(
		Option.match(drivenOf(c), {
			onSome: (window): Drawn => ({ kind: "driven", window, start: c.start }),
			onNone: (): Drawn => ({
				kind: "refused",
				window: defined(
					Option.getOrUndefined(Arr.findFirst(refusedWindows, (w) => w === c.window)),
					"a window, driven or refused"
				)
			})
		})
	)

/** The parameters of a case's window: the status tab's status, rare or common, the student's, the grade's. */
const paramsOf = (c: PageCase): Readonly<Record<string, unknown>> => {
	switch (c.window) {
		case "all":
		case "email":
		case "marked":
			return {}
		case "status":
			return { status: c.rare ? "ABANDONED" : "COMPLETED" }
		case "student":
			return { student: "person 1" }
		case "grade":
			return { grade: 2 }
		case "dashboard":
		case "dashboardJoined":
			return { tab: c.rare ? "completed" : "all" }
		case "dashboardOf":
		case "dashboardOfGrade":
			return { tab: c.rare ? "completed" : "all", email: "e1@x.org" }
		case "queue":
			return { kind: 1, now: c.rare ? 150n : 700n }
		case "queueAfter":
			return { kind: 1, now: c.rare ? 150n : 700n, after: BigInt(2 * c.sittings) }
		case "queueOfKinds":
			return { worker: 1n, now: 700n }
	}
}

/**
 * A window's run: its statement's rows as the wire sends them, part by part, the key of each row its intake delivered,
 * in the window's order, and its SQL and parameters.
 */
interface Run {
	readonly runs: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>
	readonly keys: ReadonlyArray<RowKey>
	readonly sql: string
	readonly params: ReadonlyArray<Param>
}

/** A runtime's window from `anchor`, `size` rows, read on `connection` with `params`. */
const runWindow = (
	runtime: PageRuntime,
	connection: PgConnection,
	params: Readonly<Record<string, unknown>>,
	codes: Codebook,
	anchor: Anchor,
	size: number
) =>
	Effect.gen(function* () {
		const inputs = succeeded(
			Result.mapError(executionInputs(paramCodecs(runtime.params, codes), params), (e) =>
				String(e)
			),
			"the window's parameters encode"
		)
		const call = succeeded(
			Result.mapError(windowCall({ anchor, size }, runtime.anchors), (e) => String(e)),
			"the window's call reads"
		)
		const program = runtime.artifact.requests[call.variant]
		const delivery = program.delivery
		const groups =
			delivery.kind === "concat" ? delivery.groups : Arr.map(delivery.order.groups, (g) => g.group)
		const comparators = Arr.map(runtime.page.comparators, (cmp) => ({
			field: cmp.field,
			value: scalarReader(cmp.type, codes)
		}))
		/** A delivered row's key: its comparators' values, each read from its cell in its part's heading. */
		const keyOf = (row: DeliveredRow): RowKey => {
			const heading = defined(groups[row.group], "a delivered row's heading group").record.part
				.heading
			return RowKey(
				Arr.map(comparators, (cmp) =>
					cmp.value.convert(rowCell(row.cells, columnPosition(heading, cmp.field)))
				)
			)
		}
		const statement = yield* Effect.orDie(windowStatement(runtime, inputs, call, keptRows))
		const sql = sentSql(statement)
		const sent = yield* connection.queryValues(sql, statement.params)
		const raw = outputRows(
			Arr.map(sent, (row) =>
				Arr.map(row, (cell) => (typeof cell === "string" ? cell : String(cell)))
			)
		)
		const delivered: Array<DeliveredRow> = []
		const intake = windowIntake(program, call.size, (row) => {
			delivered.push(row)
		})
		for (const row of raw) {
			intake.take(row)
		}
		succeeded(
			Result.mapError(intake.end(), (e) => String(e)),
			"the window's rows end"
		)
		const runs = Arr.map(partRuns(program.run.parts, raw), (run) =>
			Arr.map(run, (row) => Arr.map(row, (cell) => String(cell)))
		)
		return { runs, keys: Arr.map(delivered, keyOf), sql, params: statement.params } satisfies Run
	})

/**
 * The accounts the guard reads, checked once at the claims' Clerk user: one probe for each rule of OperatorMay, each of
 * which matches the account at the Clerk user once, its union read whole at that user. A guard read per window row
 * reads twice that for each row. The ceiling is one: the second rule, of the programs that write, holds no read
 * program (ProgramWrites is closed and holds none of the windows'), and an existence test of the union stops at its
 * first rule's row; the union's read at the user deduplicates its rules' rows and so runs both (routed to the guard's
 * lowering, lower/shapes/union).
 */
const guardAccountReads = 2

/** A part's rows as a set of texts, in a canonical order. */
const textSet = (rows: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(rows, (row) => Arr.join(row, "\u0000")),
		Order.String
	)

/**
 * A case's transaction opened on `clone` (runPage): the tests and an operator granted teaching, under claims naming the
 * operator's Clerk user.
 */
const opened = (clone: RolledBack<Generated>) => {
	const names = namesOf(clone.value.installed)
	return Effect.forEach(
		[
			`INSERT INTO ${names.table(Test)} SELECT t, 'test ' || t, t FROM generate_series(1, 3) AS t`,
			`INSERT INTO ${names.table(People)} VALUES ('staff')`,
			`INSERT INTO ${names.table(ClerkAccount)} VALUES ('user_staff', 'staff')`,
			`INSERT INTO ${names.table(Grant)} VALUES ('staff', ${String(names.code(Capability, "teacher"))})`,
			`INSERT INTO ${names.table(QueueWorker)} VALUES (1, 1), (1, 2)`,
			`SELECT pg_catalog.set_config('grizzle.claims', '{"Session":{"sub":"user_staff"}}', true)`
		],
		(sql) => clone.connection.query(sql, []),
		{ discard: true }
	)
}

/**
 * The case `apart`'s property reads (stoodApart): a few learners of a few sittings each, every event and grading, read
 * by no window.
 */
const apartCase: PageCase = {
	window: "all",
	start: "first",
	size: 1,
	learners: 6,
	sittings: 5,
	revisions: 1,
	marks: 1,
	place: 0,
	rare: true,
	more: 60,
	state: "never vacuumed"
}

/**
 * Each of a case's tables' pg_class counts and the statistics ANALYZE leaves of it (pg_stats), each by its quoted name: what
 * a state of the tables is to the planner, which a read `apart` from it must leave as it stood.
 */
const plannerState = (session: BenchSession, tables: ReadonlyArray<string>) =>
	Effect.forEach(tables, (t) =>
		Effect.map(
			session.values(
				"SELECT c.relpages::pg_catalog.text, c.reltuples::pg_catalog.text, c.relallvisible::pg_catalog.text, c.relallfrozen::pg_catalog.text, " +
					"(SELECT pg_catalog.count(*) FROM pg_catalog.pg_stats AS s WHERE s.schemaname = n.nspname AND s.tablename = c.relname)::pg_catalog.text " +
					"FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace " +
					"WHERE c.oid = $1::pg_catalog.text::pg_catalog.regclass",
				[t]
			),
			(rows) => [t, Arr.map(rows, Arr.map(String))] as const
		)
	)

/**
 * `apart`'s property's case on `clone`: a case's learners stood in `state` (advice.ts standIn), then a read apart from
 * them that stores more learners beside and ANALYZEs every table (advice.ts apart, grownIn), as the page oracle's
 * baseline reads them; each table's pg_class counts and its statistics stand after it as they stood before, whatever
 * ANALYZE wrote in place.
 */
export const stoodApart = (clone: RolledBack<Generated>, state: PgClassState) =>
	Effect.gen(function* () {
		const installed = clone.value.installed
		const session: BenchSession = { values: clone.connection.queryValues }
		const tables = caseTables(installed)
		const c = { ...apartCase, state }
		yield* opened(clone)
		yield* standIn(session, learnersLoad(installed, clone.connection, c, c.learners), state)
		const before = yield* plannerState(session, tables)
		yield* apart(
			{ values: clone.bare.queryValues },
			"page_keys_apart",
			tables,
			grownIn(
				session,
				learnersLoad(installed, clone.connection, c, c.learners + c.more),
				"analyzed",
				c.learners
			)
		)
		const after = yield* plannerState(session, tables)
		assert.deepEqual(
			after,
			before,
			`every table in the ${state} state stands after a read apart from it as before it`
		)
	})

/**
 * One case in its one transaction, which the case's end rolls back: the tests and an operator granted teaching, under claims naming the operator's Clerk user. The case's window is paged as a served
 * Db of the ledger's full world pages it (test/support/advice.ts servedPageRead: the role's compile, read "page", under
 * the advice its served record ships), and the page oracle's baseline built beside it (test/support/conservative.ts
 * conservativePageRuntime), cost-chosen, the oracle of its rows alone. The case's learners 1 to `learners` are loaded
 * once and stood in its pg_class state (advice.ts standIn), each row in its tables once; each read stands in a
 * savepoint of its own (`apart`): the baseline's ANALYZEd, the unpaged read and the window at the anchor its place
 * names; the optimized window's in the case's state, where the plan laws hold over the page's five variants (lawsHold,
 * which then holds the advice its record ships in force), the window is read, its plan run under that advice keeps its
 * budget (budgetOfPlan: each scan within the pages its plan gives), a driven window's scans read at most 60 rows for
 * each row it holds, 200 more and its offset's skipped entries (judge.ts readWork), and the operator's account is read
 * once; each part's rows the baseline's. Then `more` learners are stored beside them, each newer than the case's own,
 * the tables stood in the case's state again (advice.ts grownIn), and both are read again, the anchor the same row.
 * Where each read loaded the learners afresh in its savepoint, each rolled-back load left its rows as versions no later
 * snapshot sees: floor case 1's skewed window read three heap pages for each of its rows' keys, two of them a rolled-back
 * load's, 9 pages of the 8 its plan gives, where its rows standing once read 3. The baseline reads every entry of
 * the window's tab and each entry's attachments as it stands, which PostgreSQL plans by its statistics, so its reads
 * stand analyzed: under statistics stating each value its own it priced the tab of every sitting, 7,280 entries beside
 * 1,040 learners, at one row and rescanned a hash join of every assignment for each, in the window's body and in each of
 * its six attachments, 53 million rows a copy and 155 s.
 */
export const runPage = (clone: RolledBack<Generated>, c: PageCase, k: Case<PageFeature>) =>
	Effect.gen(function* () {
		const { connection, bare } = clone
		const held: BenchSession = { values: bare.queryValues }
		const installed = clone.value.installed
		const names = namesOf(installed)
		const codes = names.installation.names.codes
		const session: BenchSession = { values: connection.queryValues }
		yield* opened(clone)
		const page = yield* servedPageRead(
			installed,
			fullWorldRole(installed, Ops, [Session]),
			windows[c.window],
			`the ${c.window} window`
		)
		const optimized = page.runtime
		const baseline = succeeded(
			Result.mapError(
				conservativePageRuntime(
					optimized,
					page.compiled.template,
					page.compiled.desc,
					page.artifacts
				),
				(e) => String(e)
			),
			"the page's baseline compiles"
		).runtime
		const params = paramsOf(c)
		/** The window's anchor in a read of every row: the row at the case's place, or its position. */
		const anchorIn = (every: Run): Anchor | undefined => {
			const at = Math.floor((c.place / 100) * Math.max(every.keys.length - 1, 0))
			const anchorKey = Option.fromNullishOr(every.keys[at])
			switch (c.start) {
				case "first":
					return { kind: "start" }
				case "last":
					return { kind: "end" }
				case "at":
					return { kind: "at", position: at }
				case "after":
					return Option.isSome(anchorKey) ? { kind: "after", key: anchorKey.value } : undefined
				case "before":
					return Option.isSome(anchorKey) ? { kind: "before", key: anchorKey.value } : undefined
			}
		}
		const tables = caseTables(installed)
		yield* standIn(session, learnersLoad(installed, connection, c, c.learners), c.state)
		yield* notedStoredViews(installed, connection, k)
		/**
		 * `read`, the page oracle's baseline's, over the learners standing ANALYZEd apart from the case's state: its plan
		 * under the store's own statistics (the first kept case), every count and statistic of the case's state standing
		 * again after it (advice.ts apart).
		 */
		const analyzed = <A, E>(read: Effect.Effect<A, E>) =>
			apart(
				held,
				"page_keys_baseline",
				tables,
				Effect.andThen(
					Effect.forEach(tables, (t) => session.values(`ANALYZE ${t}`, []), { discard: true }),
					read
				)
			)
		const first = yield* analyzed(
			Effect.gen(function* () {
				const every = yield* runWindow(
					baseline,
					connection,
					params,
					codes,
					{ kind: "start" },
					100_000
				)
				const anchor = anchorIn(every)
				if (anchor === undefined) {
					return { every, at: Option.none() }
				}
				const expected = yield* runWindow(baseline, connection, params, codes, anchor, c.size)
				return { every, at: Option.some({ anchor, expected }) }
			})
		)
		if (Option.isNone(first.at)) {
			k.note(situationOf(c))
			return
		}
		const { anchor, expected } = first.at.value
		/**
		 * The windows a driver drives, and those it must not (`Window`): the rule's verdict, which each refusal's kill
		 * turns. A driven window's scans read at most 60 rows for each row it holds and 200 more, and each skipped row of
		 * an offset its driver's index entry; it reads the operator's account once, the guard read at the claims' key. A
		 * position is a rank, the count of rows of the order before the window (docs/reads-and-writes.md "A key or a position"), which no
		 * stored fact holds, every row written before another moving its rank, and no B-tree of PostgreSQL's counts: its
		 * window reads the driver's index in order from its first entry, o + k entries, then D at its k keys, at most
		 * twice the position past a keyset window's bound.
		 */
		const driven = Option.isSome(drivenOf(c))
		assert.equal(
			page.compiled.template.programs.optimized.window.kind,
			driven ? "driven" : "asItStands",
			`${Formatter.format(c)}: the ${c.window} window's driver`
		)
		const bound = 60 * c.size + 200 + (anchor.kind === "at" ? 2 * anchor.position : 0)
		/**
		 * The window read under the page's advice, its plan run under it (advice.ts advisedExplain, one plan for every
		 * position, boundary and size: the generic plan every session runs), each of its parameters a text, since a page
		 * binds no column's array, the one parameter sent in binary (wire.ts textsOfParams): its budget kept, a driven
		 * window's scans within the bound, and the operator's account read once.
		 */
		const judged = (learners: number, expected: Run) =>
			apart(
				held,
				"page_keys_stated",
				tables,
				Effect.gen(function* () {
					yield* lawsHold(session, page.scope)
					const read = yield* runWindow(optimized, connection, params, codes, anchor, c.size)
					const plan = yield* advisedExplain(session, read.sql, textsOfParams(read.params))
					const budget = yield* Effect.scoped(
						Effect.flatMap(
							superuserClient(clone.cluster, clone.database, "page keys heights"),
							(superuser) =>
								budgetOfPlan(
									session,
									(sql) => Effect.orDie(superuser.query(sql, [])),
									`the window beside ${String(learners)} learners`,
									plan,
									new Set(page.scope.catalog)
								)
						)
					)
					assert.deepEqual(
						budget,
						[],
						`${Formatter.format(c)}: the window keeps its plan's budget\n${read.sql}`
					)
					if (driven) {
						const scanned = readWork(plan)
						assert.ok(
							scanned <= bound,
							`${Formatter.format(c)}: the window beside ${String(learners)} learners reads ${String(scanned)} rows, past its bound ${String(bound)}\n${read.sql}`
						)
						const accounts = Arr.reduce(
							Arr.filter(
								[...planNodes(plan)],
								(n) => Option.getOrUndefined(n.relation) === "clerk_account"
							),
							0,
							(sum, n) => sum + scannedRows(n)
						)
						assert.ok(
							accounts <= guardAccountReads,
							`${Formatter.format(c)}: the window reads ${String(accounts)} accounts, the guard once at the claims' Clerk user alone, a probe for each rule of the operator's permissions\n${read.sql}`
						)
					}
					assert.equal(
						read.runs.length,
						expected.runs.length,
						"one part for each of the baseline's"
					)
					for (const [i, run] of read.runs.entries()) {
						assert.deepEqual(
							textSet(run),
							textSet(expected.runs[i] ?? []),
							`${Formatter.format(c)}: part ${String(i)} of the window beside ${String(learners)} learners, the baseline's\n${read.sql}`
						)
					}
				})
			)
		yield* judged(c.learners, expected)
		yield* grownIn(
			session,
			learnersLoad(installed, connection, c, c.learners + c.more),
			c.state,
			c.learners
		)
		const more = yield* analyzed(runWindow(baseline, connection, params, codes, anchor, c.size))
		yield* judged(c.learners + c.more, more)
		k.note(situationOf(c))
		const overRows = Option.getOrUndefined(drivenOf(c))
		if (overRows !== undefined && first.every.keys.length > 0) {
			k.note(`${overRows} over rows`)
		}
		k.note(c.learners < 12 ? "beside a few learners" : "beside many learners")
		k.note(`with every table ${c.state}`)
	})
