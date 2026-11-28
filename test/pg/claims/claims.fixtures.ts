/** What the properties of claims.test.ts read: their schema, roles and template, their space of states, sessions and
 * writes, and their models. */

import { element, type Gen, int, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { closedId, drawn, natural, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	contained,
	context,
	counted,
	derived,
	fin,
	key,
	login,
	mutable,
	on,
	ordered,
	relation,
	role,
	schema,
	unit,
	wholeEntriesOf,
	wholeWritesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { clocked, workload } from "#compiler/public/workload.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { generatedTemplate } from "#test/support/install-migrate.ts"

/**
 * Claims-scoped reads over PostgreSQL (schema/scope.ts, ir/derived.ts servedDag): a sitting's schema as metis keys it,
 * every fact of a child's sittings in the Learner unit, keyed leading with `child`: Assignment(child, number), whose
 * number is also a key of its own, as metis's series makes it; SittingEvent(child, number, step) and
 * Invalidation(child, number, change) of an assignment; TestSession(child, stage), owning the sequence of its Visits and
 * the counted family of its ItemSessions; and a sitting's moments and presentations, Moment(child, stage, at) and
 * Presented(child, stage, at), qti-pie's TestMoment and TestPresented, whose presentedSpans reads each presentation's
 * end as the sitting's next moment after it. Grade(number) and Enrolled(class, child) are no member: neither leads its
 * key with the child. ClerkAccount signs a Clerk user in as a child; CoachOf grants a coach children.
 *
 * Two roles of one login hold every relation whole, and Firsts, each presentation at its first mark (k = 0), a writable
 * query entry over Presented, and declare one scope each: `student`, the children the session's Clerk user signs in as
 * (Session ⋈ ClerkAccount, at most one), and `coach`, the children the session's coach is granted (Session ⋈ CoachOf, a
 * key prefix, any number). Their workload is the base's own programs: a read of each member, of the live derived
 * relations Status (a union of rules, one a negation) and Graded (a member joined to a non-member), a count of each
 * assignment's events, the latest assignment by number, the assignments with no event (a negation), an import, one
 * assignment by its number, each presentation's span (an aggregate over a range of moments: qti-pie's presentedSpans,
 * which read test_moment by stage alone, the child bound nowhere), and the whole Grade; and writes of members from raw
 * facts, each held to the claims by its precheck, a write of events for every eventless assignment the world holds
 * (proven inside the claims, so it is held to nothing), an assign of a class's enrolled children (its child read from
 * no member, so prechecked), a delete of invalidations, of items, and of sessions, units their Visits and items go
 * with, from raw facts and from a query whose child no member gives. Each role also reads Firsts and inserts through it,
 * the entry's write held to the claims as a whole write is. `staff` holds every relation whole, with no scope, and seeds
 * each case.
 *
 * A case draws a lawful state over small domains (three children, three numbers, two steps), a session (the role, and
 * its Clerk user or coach), and one write. The models: the world, each member's rows at the children the claims bind
 * (`worldOf`); each read's rows over it, a second implementation of the program in JavaScript; and each write's
 * outcome and the state after it, the laws judged over every row: a fact outside the claimed children is outsideWorld,
 * a key a row outside the world holds refuses the write on that key, and where both hold either is the answer.
 */

const Name = str.regex("^[a-z]{1,8}$")
/** A child, the Learner unit's key. */
const Child = str.regex("^[a-z]{1,8}$")

export const Kind = closed.unordered("Kind", ["start", "pause", "submit"])
const Status = closed.unordered("Status", ["assigned", "started", "done"])

const ClerkAccount = relation("ClerkAccount", { clerk: Name, child: Child }, ["clerk"])
const CoachOf = relation("CoachOf", { coach: Name, child: Child }, ["coach", "child"])
export const Assignment = relation("Assignment", { child: Child, number: natural, test: Name }, [
	"child",
	"number"
])
export const SittingEvent = relation(
	"SittingEvent",
	{ child: Child, number: natural, step: natural, kind: closedId(Kind) },
	["child", "number", "step"]
)
export const Invalidation = relation(
	"Invalidation",
	{ child: Child, number: natural, change: natural },
	["child", "number", "change"]
)
const Grade = relation("Grade", { number: natural, grade: int4 }, ["number"])
const Enrolled = relation("Enrolled", { class: Name, child: Child }, ["class", "child"])
export const TestSession = relation(
	"TestSession",
	{ child: Child, stage: natural, pkg: Name, visits: drawn(natural), items: drawn(natural) },
	["child", "stage"]
)
export const Visit = relation(
	"Visit",
	{ child: Child, stage: natural, at: drawn(natural), note: Name },
	["child", "stage", "at"]
)
export const ItemSession = relation("ItemSession", { child: Child, stage: natural, item: Name }, [
	"child",
	"stage",
	"item"
])
const Moment = relation("Moment", { child: Child, stage: natural, at: natural }, [
	"child",
	"stage",
	"at"
])
export const Presented = relation(
	"Presented",
	{ child: Child, stage: natural, at: natural, k: natural },
	["child", "stage", "at"]
)

const Session = context("Session", { sub: Name })

/** The schema under `name`, its roles, logins and programs, built once per call as a template builds it. */
export const claimsAt = (name: string) => {
	/** Every number one assignment's: metis's series makes the number a key of its own. */
	const numberKey = key(on(Assignment, "number"))
	const base = schema(
		name,
		[
			Kind,
			ClerkAccount,
			CoachOf,
			Assignment,
			SittingEvent,
			Invalidation,
			Grade,
			Enrolled,
			TestSession,
			Visit,
			ItemSession,
			Moment,
			Presented
		],
		[
			unit("Learner", { child: Child }),
			numberKey,
			contained(on(SittingEvent, "child", "number"), on(Assignment, "child", "number")),
			contained(on(Invalidation, "child", "number"), on(Assignment, "child", "number")),
			contained(on(Grade, "number"), on(Assignment, "number")),
			mutable(Invalidation),
			mutable(TestSession),
			mutable(Visit),
			mutable(ItemSession),
			ordered(on(Visit, "child", "stage", "at"), fin(TestSession, "visits")),
			counted(on(ItemSession, "child", "stage"), fin(TestSession, "items"))
		]
	)
	/** Each assignment's status: assigned while it has no event, started while it has no submission, done after one. */
	const AssignmentStatus = derived(
		"AssignmentStatus",
		query(base)
			.rule((r) => {
				const { child, number } = v(Assignment, "a")
				return r
					.match(Assignment, { child, number })
					.where(r.not(SittingEvent, { child, number }))
					.find({ child, number, status: Status.handle("assigned") })
			})
			.rule((r) => {
				const { child, number } = v(SittingEvent, "e")
				return r
					.match(SittingEvent, { child, number, kind: "start" })
					.where(r.not(SittingEvent, { child, number, kind: "submit" }))
					.find({ child, number, status: Status.handle("started") })
			})
			.rule((r) => {
				const { child, number } = v(SittingEvent, "e")
				return r
					.match(SittingEvent, { child, number, kind: "submit" })
					.find({ child, number, status: Status.handle("done") })
			})
	)
	/** Each graded assignment with its grade: a member joined to a relation of no unit, read live. */
	const Graded = derived(
		"Graded",
		query(base).rule((r) => {
			const { child, number } = v(Assignment, "a")
			const { grade } = v(Grade, "g")
			return r
				.match(Assignment, { child, number })
				.match(Grade, { number, grade })
				.find({ child, number, grade })
		})
	)
	const views = schema.extend([base], `${name}_views`, [Status, AssignmentStatus, Graded], [])
	/** The children the session's Clerk user signs in as: one at most, by the sign-in's key. */
	const learners = query(views).rule((r) => {
		const { sub } = v(Session, "s")
		const { child } = v(ClerkAccount, "account")
		return r.match(Session, { sub }).match(ClerkAccount, { clerk: sub, child }).find({ child })
	})
	/** The children the session's coach is granted: any number, a prefix of the grant's key. */
	const coached = query(views).rule((r) => {
		const { sub } = v(Session, "s")
		const { child } = v(CoachOf, "grant")
		return r.match(Session, { sub }).match(CoachOf, { coach: sub, child }).find({ child })
	})
	/** Each presentation at its first mark: a writable query entry over a member, whose inserts fill `k`. */
	const firsts = query(views).rule((r) => {
		const { child, stage, at } = v(Presented, "p")
		return r.match(Presented, { child, stage, at, k: 0n }).find({ child, stage, at })
	})
	const entries = { ...wholeEntriesOf(views), Firsts: firsts }
	const writes = {
		insert: ["Assignment", "SittingEvent", "Firsts"],
		write: ["Invalidation", "TestSession", "Visit", "ItemSession"]
	} as const
	const student = role(views, "student", entries, {
		...writes,
		contexts: [Session],
		scope: [learners]
	})
	const coach = role(views, "coach", entries, {
		...writes,
		contexts: [Session],
		scope: [coached]
	})
	/** Each role's read of its entry and its write through it, a program over the role that holds the entry. */
	const studentFirsts = {
		read: query(student).rule((r) => {
			const { child, stage, at } = v(student.relations.Firsts, "f")
			return r.match(student.relations.Firsts, { child, stage, at }).find({ child, stage, at })
		}),
		present: ChangeSet.empty(student).insert(student.relations.Firsts, [])
	}
	const coachFirsts = {
		read: query(coach).rule((r) => {
			const { child, stage, at } = v(coach.relations.Firsts, "f")
			return r.match(coach.relations.Firsts, { child, stage, at }).find({ child, stage, at })
		}),
		present: ChangeSet.empty(coach).insert(coach.relations.Firsts, [])
	}
	const staff = role(views, "staff", wholeEntriesOf(views), wholeWritesOf(views))
	const assignments = query(views).rule((r) => {
		const { child, number, test } = v(Assignment, "a")
		return r.match(Assignment, { child, number, test }).find({ child, number, test })
	})
	const events = query(views).rule((r) => {
		const { child, number, step, kind } = v(SittingEvent, "e")
		return r.match(SittingEvent, { child, number, step, kind }).find({ child, number, step, kind })
	})
	const statuses = query(views).rule((r) => {
		const { child, number, status } = v(AssignmentStatus, "s")
		return r.match(AssignmentStatus, { child, number, status }).find({ child, number, status })
	})
	const graded = query(views).rule((r) => {
		const { child, number, grade } = v(Graded, "g")
		return r.match(Graded, { child, number, grade }).find({ child, number, grade })
	})
	/** The whole Grade: no member, so every row whatever the claims. */
	const grades = query(views).rule((r) => {
		const { number, grade } = v(Grade, "g")
		return r.match(Grade, { number, grade }).find({ number, grade })
	})
	const eventCounts = query(views).rule((r) => {
		const { child, number } = v(Assignment, "a")
		const { step } = v(SittingEvent, "e")
		return r
			.match(Assignment, { child, number })
			.match(SittingEvent, { child, number, step })
			.find({ child, number, events: r.count() })
	})
	const latest = query(views)
		.rule((r) => {
			const { child, number, test } = v(Assignment, "a")
			return r.match(Assignment, { child, number, test }).find({ child, number, test })
		})
		.orderBy(["number", "desc"])
		.take(1)
	const eventless = query(views).rule((r) => {
		const { child, number } = v(Assignment, "a")
		return r
			.match(Assignment, { child, number })
			.where(r.not(SittingEvent, { child, number }))
			.find({ child, number })
	})
	/** Each assignment with an invalidation, through an import of the invalidations. */
	const invalidated = query(views).rule((r) => {
		const { child, number } = v(Assignment, "a")
		const standing = query(views).rule((q) => {
			const i = v(Invalidation, "i")
			return q
				.match(Invalidation, { child: i.child, number: i.number })
				.find({ child: i.child, number: i.number })
		})
		return r
			.match(Assignment, { child, number })
			.match(standing, { child, number })
			.find({ child, number })
	})
	/** One assignment by its number, with its status: metis's myAssignment, the child bound nowhere. */
	const assignmentOf = query(views).rule((r) => {
		const { child, number, test } = v(Assignment, "a")
		const { status } = v(AssignmentStatus, "s")
		return r
			.match(Assignment, { child, number, test })
			.match(AssignmentStatus, { child, number, status })
			.where(r.eq(number, r.param("number", natural)))
			.find({ child, number, test, status })
	})
	const sessions = query(views).rule((r) => {
		const { child, stage, pkg, visits, items } = v(TestSession, "s")
		return r
			.match(TestSession, { child, stage, pkg, visits, items })
			.find({ child, stage, pkg, visits, items })
	})
	const visitsRead = query(views).rule((r) => {
		const { child, stage, at, note } = v(Visit, "w")
		return r.match(Visit, { child, stage, at, note }).find({ child, stage, at, note })
	})
	const itemsRead = query(views).rule((r) => {
		const { child, stage, item } = v(ItemSession, "i")
		return r.match(ItemSession, { child, stage, item }).find({ child, stage, item })
	})
	/** Each assignment with its events attached: metis's listing's shape, each attachment read at its row's keys. */
	const withEvents = query(views)
		.rule((r) => {
			const { child, number } = v(Assignment, "a")
			return r.match(Assignment, { child, number }).find({ child, number })
		})
		.attach(
			"events",
			(head) =>
				query(views).rule((r) => {
					const { step, kind } = v(SittingEvent, "e")
					return r
						.match(SittingEvent, { child: head.child, number: head.number, step, kind })
						.find({ step, kind })
				}),
			"array"
		)
	/** Each presentation with the sitting's next moment after it: qti-pie's presentedSpans. */
	const spans = query(views).rule((r) => {
		const { child, stage, at, k } = v(Presented, "p")
		const { at: next } = v(Moment, "m")
		return r
			.match(Presented, { child, stage, at, k })
			.match(Moment, { child, stage, at: next })
			.where(r.gt(next, at))
			.find({ child, stage, at, k, end: r.min(next) })
	})
	/** A child's presentations at a stage before the call's instant: a clocked read whose child and stage are its caller's
	 * parameters, as qti-pie's grade reads are, so the world alone, not the parameter, keeps another child's rows out. */
	const presentedOf = clocked(
		query(views).rule((r) => {
			const { at, k } = v(Presented, "p")
			const child = r.param("child", Child)
			const stage = r.param("stage", natural)
			return r
				.match(Presented, { child, stage, at, k })
				.where(r.lt(at, r.param("now", natural)))
				.find({ child, stage, at, k })
		}),
		{ now: "micros" }
	)
	/** An event of step 0 started for every assignment of the world with none: its child read from a member. */
	const startEventless = ChangeSet.empty(views).insert(
		SittingEvent,
		query(views).rule((r) => {
			const { child, number } = v(Assignment, "a")
			return r
				.match(Assignment, { child, number })
				.where(r.not(SittingEvent, { child, number }))
				.find({ child, number, step: 0n, kind: Kind.handle("start") })
		})
	)
	/** An assignment of a test for each child enrolled in a class, at a number of its own: its child read from no member. */
	const assignClass = ChangeSet.empty(views).insert(
		Assignment,
		query(views).rule((r) => {
			const { child } = v(Enrolled, "e")
			return r
				.match(Enrolled, { class: r.param("class", Name), child })
				.find({ child, number: r.param("number", natural), test: r.param("test", Name) })
		})
	)
	/** A stage's sessions of a test closed for each child enrolled in a class: units deleted whole from a query whose
	 * child no member gives, so prechecked, the delete reading the one evaluation its precheck reads. */
	const closeClass = ChangeSet.empty(views).delete(
		TestSession,
		query(views).rule((r) => {
			const { child } = v(Enrolled, "e")
			return r
				.match(Enrolled, { class: r.param("class", Name), child })
				.find({ child, stage: r.param("stage", natural), pkg: r.param("pkg", Name) })
		})
	)
	const reads = {
		assignments,
		events,
		statuses,
		graded,
		grades,
		eventCounts,
		latest,
		eventless,
		invalidated,
		assignmentOf,
		sessions,
		visitsRead,
		itemsRead,
		spans,
		withEvents,
		presentedOf
	}
	const app = login(views, "app", [student, coach], {
		workload: [
			workload(views, {
				...reads,
				addAssignment: ChangeSet.empty(views).insert(Assignment, []),
				addEvent: ChangeSet.empty(views).insert(SittingEvent, []),
				openSession: ChangeSet.empty(views).insert(TestSession, []),
				addItem: ChangeSet.empty(views).insert(ItemSession, []),
				removeInvalidation: ChangeSet.empty(views).delete(Invalidation, []),
				startEventless,
				assignClass,
				closeSession: ChangeSet.empty(views).delete(TestSession, []),
				dropItem: ChangeSet.empty(views).delete(ItemSession, []),
				closeClass
			}),
			workload(student, {
				studentFirsts: studentFirsts.read,
				studentPresents: studentFirsts.present
			}),
			workload(coach, { coachFirsts: coachFirsts.read, coachPresents: coachFirsts.present })
		]
	})
	const desk = login(views, "desk", [staff], {
		workload: [
			workload(staff, {
				seedPeople: ChangeSet.empty(staff)
					.insert(ClerkAccount, [])
					.insert(CoachOf, [])
					.insert(Enrolled, []),
				seedAssignments: ChangeSet.empty(staff).insert(Assignment, []),
				seedFacts: ChangeSet.empty(staff)
					.insert(SittingEvent, [])
					.insert(Invalidation, [])
					.insert(Grade, [])
					.insert(TestSession, []),
				seedItems: ChangeSet.empty(staff)
					.insert(ItemSession, [])
					.insert(Moment, [])
					.insert(Presented, [])
			})
		]
	})
	return {
		base,
		views,
		student,
		coach,
		staff,
		app,
		desk,
		numberKey,
		/** The app's reads every role of it serves, and each scoped role's read of its own entry. */
		reads,
		firsts: { student: studentFirsts.read, coach: coachFirsts.read },
		/**
		 * The Learner unit's members, each keyed leading with `child`, with each of its keys that holds no `child`: a probe
		 * that binds one whole reads one row, which the world then holds to the claimed child or drops.
		 */
		members: [
			{ relation: Assignment, keys: [["number"]] },
			{ relation: SittingEvent, keys: [] },
			{ relation: Invalidation, keys: [] },
			{ relation: TestSession, keys: [] },
			{ relation: Visit, keys: [] },
			{ relation: ItemSession, keys: [] },
			{ relation: Moment, keys: [] },
			{ relation: Presented, keys: [] }
		] as const
	}
}

/**
 * The schema drafted and served as `grizzle generate` does, installed once per member, each case a clone of its own
 * (claimsAt): every worker plans its draft and both logins' served files once, which each case serves over its clone.
 */
export const claimsTemplate = generatedTemplate({
	declaredIn: import.meta,
	name: "claims-scoped reads",
	content: {
		schema: "claims",
		logins: [
			"app: a student and a coach, each scoped by its claims",
			"desk: staff, every relation whole"
		]
	},
	build: (name) => {
		const s = claimsAt(name)
		return { schema: s.views, logins: [s.app, s.desk] }
	},
	ambient: ordinarySession
})

const children = ["ann", "bob", "cat"] as const
export type Child = (typeof children)[number]
/** The Clerk users, each signing in as its child; `cnone` signs in as no one. */
const clerks = ["cann", "cbob", "cnone"] as const
const clerkChild: Readonly<Record<(typeof clerks)[number], Child | undefined>> = {
	cann: "ann",
	cbob: "bob",
	cnone: undefined
}
/** The coaches: `kim` holds the grants a case draws, `ned` none. */
const coaches = ["kim", "ned"] as const
const kinds = ["start", "pause", "submit"] as const
const words = ["a", "b"] as const

export interface AssignmentRow {
	readonly child: Child
	readonly number: bigint
	readonly test: string
}
export interface EventRow {
	readonly child: Child
	readonly number: bigint
	readonly step: bigint
	readonly kind: (typeof kinds)[number]
}
export interface InvalidationRow {
	readonly child: Child
	readonly number: bigint
	readonly change: bigint
}
export interface GradeRow {
	readonly number: bigint
	readonly grade: number
}
export interface SessionRow {
	readonly child: Child
	readonly stage: bigint
	readonly pkg: string
	/** Its Visits' notes, in order: the sequence nested under it. */
	readonly notes: ReadonlyArray<string>
}
export interface ItemRow {
	readonly child: Child
	readonly stage: bigint
	readonly item: string
}
export interface MomentRow {
	readonly child: Child
	readonly stage: bigint
	readonly at: bigint
}
export interface PresentedRow extends MomentRow {
	readonly k: bigint
}

/** A lawful state: every containment and family holds, every number held once. */
export interface State {
	readonly assignments: ReadonlyArray<AssignmentRow>
	readonly events: ReadonlyArray<EventRow>
	readonly invalidations: ReadonlyArray<InvalidationRow>
	readonly grades: ReadonlyArray<GradeRow>
	readonly sessions: ReadonlyArray<SessionRow>
	readonly items: ReadonlyArray<ItemRow>
	readonly moments: ReadonlyArray<MomentRow>
	readonly presented: ReadonlyArray<PresentedRow>
	/** The children kim coaches, and the children enrolled in class `a`. */
	readonly coached: ReadonlyArray<Child>
	readonly enrolled: ReadonlyArray<Child>
}

/** Whose claims a case reads under: a student's Clerk user, or a coach. */
export type Claims =
	| { readonly role: "student"; readonly clerk: (typeof clerks)[number] }
	| { readonly role: "coach"; readonly coach: (typeof coaches)[number] }

/** The token's subject of a session. */
export const subOf = (claims: Claims): string =>
	claims.role === "student" ? claims.clerk : claims.coach

/** One write of the role's, its member and what it gives. */
export type Write =
	| { readonly kind: "addAssignment"; readonly row: AssignmentRow }
	| { readonly kind: "addEvent"; readonly row: EventRow }
	| { readonly kind: "openSession"; readonly row: SessionRow }
	| { readonly kind: "addItem"; readonly row: ItemRow }
	| { readonly kind: "removeInvalidation"; readonly row: InvalidationRow }
	| { readonly kind: "startEventless" }
	| { readonly kind: "assignClass"; readonly number: bigint; readonly test: string }
	| { readonly kind: "present"; readonly row: MomentRow }
	| { readonly kind: "closeSession"; readonly row: Omit<SessionRow, "notes"> }
	| { readonly kind: "dropItem"; readonly row: ItemRow }
	| { readonly kind: "closeClass"; readonly stage: bigint; readonly pkg: string }

export interface ClaimsCase {
	readonly state: State
	readonly claims: Claims
	readonly write: Write
}

const numberGen: Gen<bigint> = (s) => BigInt(s.draw(int(1, 3)))
const stepGen: Gen<bigint> = (s) => BigInt(s.draw(int(1, 2)))

/** Rows each its key's once, the first drawn kept. */
const uniqueBy = <A>(rows: ReadonlyArray<A>, rowKey: (a: A) => string): ReadonlyArray<A> => {
	const seen = new Set<string>()
	return Arr.filter(rows, (a) => {
		const k = rowKey(a)
		const fresh = !seen.has(k)
		seen.add(k)
		return fresh
	})
}

const numberKey = (a: { readonly number: bigint }): string => String(a.number)
const eventKey = (e: EventRow): string => `${e.child} ${e.number} ${e.step}`
const invalidationKey = (i: InvalidationRow): string => `${i.child} ${i.number} ${i.change}`
const sessionKey = (x: { readonly child: string; readonly stage: bigint }): string =>
	`${x.child} ${x.stage}`
const itemKey = (x: ItemRow): string => `${x.child} ${x.stage} ${x.item}`
const momentKey = (x: MomentRow): string => `${x.child} ${x.stage} ${x.at}`
const momentGen: Gen<MomentRow> = (t) => ({
	child: t.draw(element(children)),
	stage: t.draw(stepGen),
	at: BigInt(t.draw(int(1, 4)))
})

/**
 * A lawful state: assignments of drawn numbers, each number once, of drawn children; events, invalidations and
 * grades of assigned numbers, each event and invalidation at its assignment's child; sessions of drawn children and
 * stages, each with up to two Visits; items of stored sessions; kim's grants and class a's enrolment, each a subset of
 * the children.
 */
const stateGen: Gen<State> = (s) => {
	const assignments = uniqueBy(
		Array.from({ length: s.draw(int(0, 3)) }, () => ({
			child: s.draw(element(children)),
			number: s.draw(numberGen),
			test: s.draw(element(words))
		})),
		numberKey
	)
	const assigned = Arr.isReadonlyArrayNonEmpty(assignments) ? assignments : undefined
	const events =
		assigned === undefined
			? []
			: uniqueBy(
					Array.from({ length: s.draw(int(0, 4)) }, () => {
						const a = s.draw(element(assigned))
						return {
							child: a.child,
							number: a.number,
							step: s.draw(stepGen),
							kind: s.draw(element(kinds))
						}
					}),
					eventKey
				)
	const invalidations =
		assigned === undefined
			? []
			: uniqueBy(
					Array.from({ length: s.draw(int(0, 2)) }, () => {
						const a = s.draw(element(assigned))
						return { child: a.child, number: a.number, change: s.draw(stepGen) }
					}),
					invalidationKey
				)
	const grades = Arr.map(s.draw(subarray(assignments)), (a) => ({
		number: a.number,
		grade: s.draw(int(0, 9))
	}))
	const sessions = uniqueBy(
		Array.from({ length: s.draw(int(0, 3)) }, () => ({
			child: s.draw(element(children)),
			stage: s.draw(stepGen),
			pkg: s.draw(element(words)),
			notes: Array.from({ length: s.draw(int(0, 2)) }, () => s.draw(element(words)))
		})),
		sessionKey
	)
	const items = Arr.isReadonlyArrayNonEmpty(sessions)
		? uniqueBy(
				Array.from({ length: s.draw(int(0, 3)) }, () => {
					const at = s.draw(element(sessions))
					return { child: at.child, stage: at.stage, item: s.draw(element(words)) }
				}),
				itemKey
			)
		: []
	const moments = uniqueBy(
		Array.from({ length: s.draw(int(0, 4)) }, () => s.draw(momentGen)),
		momentKey
	)
	const presented = uniqueBy(
		Array.from({ length: s.draw(int(0, 3)) }, () => ({
			...s.draw(momentGen),
			k: BigInt(s.draw(int(0, 2)))
		})),
		momentKey
	)
	return {
		assignments,
		events,
		invalidations,
		grades,
		sessions,
		items,
		moments,
		presented,
		coached: s.draw(subarray(children)),
		enrolled: s.draw(subarray(children))
	}
}

const claimsGen: Gen<Claims> = (s) =>
	s.draw(element(["student", "coach"] as const)) === "student"
		? { role: "student", clerk: s.draw(element(clerks)) }
		: { role: "coach", coach: s.draw(element(coaches)) }

/** The children a session's claims bind: its Clerk user's child, or its coach's grants. */
export const claimedOf = (state: State, claims: Claims): ReadonlySet<Child> => {
	if (claims.role === "student") {
		const child = clerkChild[claims.clerk]
		return new Set(child === undefined ? [] : [child])
	}
	return new Set(claims.coach === "kim" ? state.coached : [])
}

/**
 * A write, drawn near the state so each kind meets its laws: an assignment at a drawn number, held or free, of any
 * child; an event of a stored assignment, or of a drawn one; a session of any child at a drawn stage; an item of a
 * stored session or of a drawn one; a delete of a stored invalidation or of a drawn one; the events of every eventless
 * assignment; an assign of class a at a drawn number; a first mark through Firsts at a stored presentation's place
 * or at a drawn one; a delete of a stored session or of a drawn one, its rows nested under it with it; a delete of a
 * stored item or of a drawn one; or a delete of class a's sessions of a drawn stage and test.
 */
const writeGen =
	(state: State): Gen<Write> =>
	(s) => {
		const kind = s.draw(
			element([
				"addAssignment",
				"addEvent",
				"openSession",
				"addItem",
				"removeInvalidation",
				"startEventless",
				"assignClass",
				"present",
				"closeSession",
				"dropItem",
				"closeClass"
			] as const)
		)
		const stored = <A>(rows: ReadonlyArray<A>, drawnRow: Gen<A>): A =>
			Arr.isReadonlyArrayNonEmpty(rows) && s.draw(element([true, false] as const))
				? s.draw(element(rows))
				: s.draw(drawnRow)
		switch (kind) {
			case "addAssignment":
				return {
					kind,
					row: {
						child: s.draw(element(children)),
						number: s.draw(numberGen),
						test: s.draw(element(words))
					}
				}
			case "addEvent": {
				const at = stored(state.assignments, (t) => ({
					child: t.draw(element(children)),
					number: t.draw(numberGen),
					test: "a"
				}))
				return {
					kind,
					row: {
						child: at.child,
						number: at.number,
						step: s.draw(stepGen),
						kind: s.draw(element(kinds))
					}
				}
			}
			case "openSession":
				return {
					kind,
					row: {
						child: s.draw(element(children)),
						stage: s.draw(stepGen),
						pkg: s.draw(element(words)),
						notes: Array.from({ length: s.draw(int(0, 2)) }, () => s.draw(element(words)))
					}
				}
			case "addItem": {
				const at = stored(state.sessions, (t) => ({
					child: t.draw(element(children)),
					stage: t.draw(stepGen),
					pkg: "a",
					notes: []
				}))
				return { kind, row: { child: at.child, stage: at.stage, item: s.draw(element(words)) } }
			}
			case "removeInvalidation":
				return {
					kind,
					row: stored(state.invalidations, (t) => ({
						child: t.draw(element(children)),
						number: t.draw(numberGen),
						change: t.draw(stepGen)
					}))
				}
			case "startEventless":
				return { kind }
			case "assignClass":
				return { kind, number: s.draw(numberGen), test: s.draw(element(words)) }
			case "present": {
				const at = stored(state.presented, momentGen)
				return { kind, row: { child: at.child, stage: at.stage, at: at.at } }
			}
			case "closeSession": {
				const at = stored(state.sessions, (t) => ({
					child: t.draw(element(children)),
					stage: t.draw(stepGen),
					pkg: t.draw(element(words)),
					notes: []
				}))
				return { kind, row: { child: at.child, stage: at.stage, pkg: at.pkg } }
			}
			case "dropItem":
				return {
					kind,
					row: stored(state.items, (t) => ({
						child: t.draw(element(children)),
						stage: t.draw(stepGen),
						item: t.draw(element(words))
					}))
				}
			case "closeClass":
				return { kind, stage: s.draw(stepGen), pkg: s.draw(element(words)) }
		}
	}

export const claimsCaseGen: Gen<ClaimsCase> = (s) => {
	const state = s.draw(stateGen)
	return { state, claims: s.draw(claimsGen), write: s.draw(writeGen(state)) }
}

/** The world a session's claims bind: each member's rows at the claimed children; every other relation whole. */
export const worldOf = (state: State, claimed: ReadonlySet<Child>): State => ({
	...state,
	assignments: Arr.filter(state.assignments, (a) => claimed.has(a.child)),
	events: Arr.filter(state.events, (e) => claimed.has(e.child)),
	invalidations: Arr.filter(state.invalidations, (i) => claimed.has(i.child)),
	sessions: Arr.filter(state.sessions, (x) => claimed.has(x.child)),
	items: Arr.filter(state.items, (x) => claimed.has(x.child)),
	moments: Arr.filter(state.moments, (x) => claimed.has(x.child)),
	presented: Arr.filter(state.presented, (x) => claimed.has(x.child))
})

/** A row as text: its values in the read's column order, apart by a space. */
export const rowText = (values: ReadonlyArray<unknown>): string =>
	Arr.join(
		Arr.map(values, (x) => String(x)),
		" "
	)

const sorted = (rows: ReadonlyArray<string>): ReadonlyArray<string> => Arr.sort(rows, Order.String)

/** An assignment's status over a state: assigned with no event, done with a submission, started otherwise. */
const statusOf = (state: State, a: AssignmentRow): string | undefined => {
	const own = Arr.filter(state.events, (e) => e.child === a.child && e.number === a.number)
	const submitted = Arr.some(own, (e) => e.kind === "submit")
	const started = Arr.some(own, (e) => e.kind === "start")
	if (own.length === 0) {
		return "assigned"
	}
	if (submitted) {
		return "done"
	}
	return started ? "started" : undefined
}

/**
 * Each read's rows over `world`, as text rows in order, each the read's columns: the second implementation of every
 * program of the workload, over the world's rows alone.
 */
export const readsOver = (world: State): Readonly<Record<string, ReadonlyArray<string>>> => {
	const numbers = (rows: ReadonlyArray<{ readonly child: Child; readonly number: bigint }>) =>
		sorted(Arr.map(rows, (r) => rowText([r.child, r.number])))
	const eventless = Arr.filter(
		world.assignments,
		(a) => !Arr.some(world.events, (e) => e.child === a.child && e.number === a.number)
	)
	const latest = Arr.take(
		Arr.sort(
			world.assignments,
			Order.mapInput(Order.flip(Order.BigInt), (a: AssignmentRow) => a.number)
		),
		1
	)
	return {
		assignments: sorted(Arr.map(world.assignments, (a) => rowText([a.child, a.number, a.test]))),
		events: sorted(Arr.map(world.events, (e) => rowText([e.child, e.number, e.step, e.kind]))),
		statuses: sorted(
			Arr.flatMap(world.assignments, (a) => {
				const status = statusOf(world, a)
				return status === undefined ? [] : [rowText([a.child, a.number, status])]
			})
		),
		graded: sorted(
			Arr.flatMap(world.assignments, (a) =>
				Arr.flatMap(world.grades, (g) =>
					g.number === a.number ? [rowText([a.child, a.number, g.grade])] : []
				)
			)
		),
		grades: sorted(Arr.map(world.grades, (g) => rowText([g.number, g.grade]))),
		eventCounts: sorted(
			Arr.flatMap(world.assignments, (a) => {
				const n = Arr.filter(
					world.events,
					(e) => e.child === a.child && e.number === a.number
				).length
				return n === 0 ? [] : [rowText([a.child, a.number, n])]
			})
		),
		latest: sorted(Arr.map(latest, (a) => rowText([a.child, a.number, a.test]))),
		eventless: numbers(eventless),
		invalidated: numbers(
			Arr.filter(world.assignments, (a) =>
				Arr.some(world.invalidations, (i) => i.child === a.child && i.number === a.number)
			)
		),
		sessions: sorted(
			Arr.map(world.sessions, (x) =>
				rowText([
					x.child,
					x.stage,
					x.pkg,
					x.notes.length,
					Arr.filter(world.items, (i) => sessionKey(i) === sessionKey(x)).length
				])
			)
		),
		visitsRead: sorted(
			Arr.flatMap(world.sessions, (x) =>
				Arr.map(x.notes, (note, at) => rowText([x.child, x.stage, at, note]))
			)
		),
		itemsRead: sorted(Arr.map(world.items, (i) => rowText([i.child, i.stage, i.item]))),
		firsts: sorted(
			Arr.flatMap(world.presented, (p) => (p.k === 0n ? [rowText([p.child, p.stage, p.at])] : []))
		),
		withEvents: sorted(
			Arr.map(world.assignments, (a) =>
				rowText([
					a.child,
					a.number,
					Arr.join(
						sorted(
							Arr.flatMap(world.events, (e) =>
								e.child === a.child && e.number === a.number ? [rowText([e.step, e.kind])] : []
							)
						),
						"/"
					)
				])
			)
		),
		spans: sorted(
			Arr.flatMap(world.presented, (p) => {
				const later = Arr.filter(
					world.moments,
					(m) => m.child === p.child && m.stage === p.stage && m.at > p.at
				)
				return Arr.isReadonlyArrayNonEmpty(later)
					? [
							rowText([
								p.child,
								p.stage,
								p.at,
								p.k,
								Arr.reduce(later, later[0].at, (least, m) => (m.at < least ? m.at : least))
							])
						]
					: []
			})
		)
	}
}

/** The presentations of `child` at `stage` over `world` (presentedOf): every drawn moment lies before any call's
 * instant, so the clock passes each, and a child the world does not hold has none. */
export const presentedOver = (world: State, child: string, stage: bigint): ReadonlyArray<string> =>
	sorted(
		Arr.flatMap(world.presented, (p) =>
			p.child === child && p.stage === stage ? [rowText([p.child, p.stage, p.at, p.k])] : []
		)
	)

/** One assignment's row by its number over `world` (assignmentOf), with its status. */
export const assignmentOver = (world: State, number: bigint): ReadonlyArray<string> =>
	sorted(
		Arr.flatMap(world.assignments, (a) => {
			const status = statusOf(world, a)
			return a.number === number && status !== undefined
				? [rowText([a.child, a.number, a.test, status])]
				: []
		})
	)

/** A relation a write of the model is refused on. */
export type Refusing =
	| typeof Assignment
	| typeof SittingEvent
	| typeof TestSession
	| typeof ItemSession
	| typeof Presented

/** What a write answers by the model: accepted with the state after it, unchanged, refused on a relation's primary key,
 * on Assignment's number key or on some other law, or outsideWorld; or either of the last two, where a fact outside the
 * world breaks a law too. */
export type Expected =
	| { readonly kind: "accepted"; readonly after: State }
	| { readonly kind: "unchanged" }
	| {
			readonly kind: "refused"
			readonly law: "primary" | "number" | "other"
			readonly relation: Refusing
	  }
	| { readonly kind: "outsideWorld" }
	| { readonly kind: "either" }

/**
 * The model of a delete of sessions, each a unit its rows nested under it go with: outsideWorld where one is of a child
 * outside the claims, the state without every stored session one names at each of its fields otherwise, unchanged where
 * none names a stored one.
 */
const closedOver = (
	state: State,
	claimed: ReadonlySet<Child>,
	rows: ReadonlyArray<Omit<SessionRow, "notes">>
): Expected => {
	if (Arr.some(rows, (r) => !claimed.has(r.child))) {
		return { kind: "outsideWorld" }
	}
	const closed = (x: Omit<SessionRow, "notes">): boolean =>
		Arr.some(rows, (r) => sessionKey(r) === sessionKey(x) && r.pkg === x.pkg)
	const gone = Arr.filter(state.sessions, closed)
	if (!Arr.isReadonlyArrayNonEmpty(gone)) {
		return { kind: "unchanged" }
	}
	return {
		kind: "accepted",
		after: {
			...state,
			sessions: Arr.filter(state.sessions, (x) => !closed(x)),
			items: Arr.filter(state.items, (i) => !Arr.some(gone, (x) => sessionKey(x) === sessionKey(i)))
		}
	}
}

/**
 * The model of a write under the claims `claimed` binds: a fact of a member at a child outside them is outsideWorld,
 * its laws judged over every row, so a number another child's assignment holds refuses an assignment on Assignment's
 * number key, and the state after it.
 */
export const writeOutcome = (c: ClaimsCase, claimed: ReadonlySet<Child>): Expected => {
	const { state } = c
	const holder = (number: bigint) =>
		Option.getOrUndefined(Arr.findFirst(state.assignments, (a) => a.number === number))
	const accepted = (after: State): Expected => ({ kind: "accepted", after })
	switch (c.write.kind) {
		case "addAssignment": {
			const row = c.write.row
			const held = holder(row.number)
			const outside = !claimed.has(row.child)
			if (held !== undefined) {
				if (held.child === row.child && held.test === row.test) {
					return outside ? { kind: "outsideWorld" } : { kind: "unchanged" }
				}
				return outside
					? { kind: "either" }
					: {
							kind: "refused",
							law: held.child === row.child ? "primary" : "number",
							relation: Assignment
						}
			}
			return outside
				? { kind: "outsideWorld" }
				: accepted({ ...state, assignments: [...state.assignments, row] })
		}
		case "addEvent": {
			const row = c.write.row
			const outside = !claimed.has(row.child)
			const assignment = holder(row.number)
			if (assignment === undefined || assignment.child !== row.child) {
				return outside
					? { kind: "either" }
					: { kind: "refused", law: "other", relation: SittingEvent }
			}
			if (outside) {
				return { kind: "outsideWorld" }
			}
			const held = Option.getOrUndefined(
				Arr.findFirst(state.events, (e) => eventKey(e) === eventKey(row))
			)
			if (held !== undefined) {
				return held.kind === row.kind
					? { kind: "unchanged" }
					: { kind: "refused", law: "primary", relation: SittingEvent }
			}
			return accepted({ ...state, events: [...state.events, row] })
		}
		case "openSession": {
			const row = c.write.row
			if (!claimed.has(row.child)) {
				return { kind: "outsideWorld" }
			}
			return Arr.some(state.sessions, (x) => sessionKey(x) === sessionKey(row))
				? { kind: "refused", law: "primary", relation: TestSession }
				: accepted({ ...state, sessions: [...state.sessions, row] })
		}
		case "addItem": {
			const row = c.write.row
			const owner = Arr.some(state.sessions, (x) => sessionKey(x) === sessionKey(row))
			if (!claimed.has(row.child)) {
				return owner ? { kind: "outsideWorld" } : { kind: "either" }
			}
			if (!owner) {
				return { kind: "refused", law: "other", relation: ItemSession }
			}
			return Arr.some(state.items, (x) => itemKey(x) === itemKey(row))
				? { kind: "unchanged" }
				: accepted({ ...state, items: [...state.items, row] })
		}
		case "removeInvalidation": {
			const row = c.write.row
			if (!claimed.has(row.child)) {
				return { kind: "outsideWorld" }
			}
			const left = Arr.filter(
				state.invalidations,
				(i) => invalidationKey(i) !== invalidationKey(row)
			)
			return left.length === state.invalidations.length
				? { kind: "unchanged" }
				: accepted({ ...state, invalidations: left })
		}
		case "startEventless": {
			const started = Arr.flatMap(state.assignments, (a) =>
				claimed.has(a.child) &&
				!Arr.some(state.events, (e) => e.child === a.child && e.number === a.number)
					? [{ child: a.child, number: a.number, step: 0n, kind: "start" as const }]
					: []
			)
			return Arr.isReadonlyArrayNonEmpty(started)
				? accepted({ ...state, events: [...state.events, ...started] })
				: { kind: "unchanged" }
		}
		case "assignClass": {
			const { number, test } = c.write
			const rows = Arr.map(state.enrolled, (child) => ({ child, number, test }))
			if (!Arr.isReadonlyArrayNonEmpty(rows)) {
				return { kind: "unchanged" }
			}
			const outside = Arr.some(rows, (r) => !claimed.has(r.child))
			const held = holder(number)
			/** Two children at one number, or the number another child's: the number's key; the child's own number
			 * of another test: the primary key. */
			const clash: Extract<Expected, { readonly kind: "refused" }>["law"] | undefined =
				rows.length > 1 || (held !== undefined && held.child !== rows[0].child)
					? "number"
					: held !== undefined && held.test !== test
						? "primary"
						: undefined
			if (outside) {
				return clash === undefined ? { kind: "outsideWorld" } : { kind: "either" }
			}
			if (clash !== undefined) {
				return { kind: "refused", law: clash, relation: Assignment }
			}
			return held === undefined
				? accepted({ ...state, assignments: [...state.assignments, rows[0]] })
				: { kind: "unchanged" }
		}
		case "present": {
			/** The entry fills k, its first mark; a presentation at the place of another mark is outside the entry. */
			const row = { ...c.write.row, k: 0n }
			const outside = !claimed.has(row.child)
			const held = Option.getOrUndefined(
				Arr.findFirst(state.presented, (p) => momentKey(p) === momentKey(row))
			)
			if (held !== undefined) {
				if (held.k === row.k) {
					return outside ? { kind: "outsideWorld" } : { kind: "unchanged" }
				}
				return outside
					? { kind: "either" }
					: { kind: "refused", law: "primary", relation: Presented }
			}
			return outside
				? { kind: "outsideWorld" }
				: accepted({ ...state, presented: [...state.presented, row] })
		}
		case "closeSession":
			return closedOver(state, claimed, [c.write.row])
		case "dropItem": {
			const row = c.write.row
			if (!claimed.has(row.child)) {
				return { kind: "outsideWorld" }
			}
			const left = Arr.filter(state.items, (i) => itemKey(i) !== itemKey(row))
			return left.length === state.items.length
				? { kind: "unchanged" }
				: accepted({ ...state, items: left })
		}
		case "closeClass": {
			const { stage, pkg } = c.write
			return closedOver(
				state,
				claimed,
				Arr.map(state.enrolled, (child) => ({ child, stage, pkg }))
			)
		}
	}
}

/** A state's rows as the property compares them, each relation's as text rows in order. */
export interface Tables {
	readonly assignments: ReadonlyArray<string>
	readonly events: ReadonlyArray<string>
	readonly invalidations: ReadonlyArray<string>
	readonly sessions: ReadonlyArray<string>
	readonly visits: ReadonlyArray<string>
	readonly items: ReadonlyArray<string>
	readonly presented: ReadonlyArray<string>
}

/** The tables of a state, each event's kind by the code the installation holds it at (`code`): each session with its
 * drawn Visit count and item count, each Visit at its drawn place. */
export const tablesOf = (state: State, code: (kind: EventRow["kind"]) => number): Tables => ({
	assignments: sorted(Arr.map(state.assignments, (a) => rowText([a.child, a.number, a.test]))),
	events: sorted(Arr.map(state.events, (e) => rowText([e.child, e.number, e.step, code(e.kind)]))),
	invalidations: sorted(
		Arr.map(state.invalidations, (i) => rowText([i.child, i.number, i.change]))
	),
	sessions: sorted(
		Arr.map(state.sessions, (x) =>
			rowText([
				x.child,
				x.stage,
				x.pkg,
				x.notes.length,
				Arr.filter(state.items, (i) => sessionKey(i) === sessionKey(x)).length
			])
		)
	),
	visits: sorted(
		Arr.flatMap(state.sessions, (x) =>
			Arr.map(x.notes, (note, at) => rowText([x.child, x.stage, at, note]))
		)
	),
	items: sorted(Arr.map(state.items, (i) => rowText([i.child, i.stage, i.item]))),
	presented: sorted(Arr.map(state.presented, (p) => rowText([p.child, p.stage, p.at, p.k])))
})

/** The seeding ChangeSets' facts, each its staff member's: sign-ins, grants and enrolment; assignments; their facts
 * with sessions and their Visits nested; then items. */
export const seedFacts = (state: State) => ({
	people: {
		ClerkAccount: Arr.flatMap(clerks, (clerk) => {
			const child = clerkChild[clerk]
			return child === undefined ? [] : [{ clerk, child }]
		}),
		CoachOf: Arr.map(state.coached, (child) => ({ coach: "kim", child })),
		Enrolled: Arr.map(state.enrolled, (child) => ({ class: "a", child }))
	},
	assignments: { Assignment: state.assignments },
	facts: {
		SittingEvent: state.events,
		Invalidation: state.invalidations,
		Grade: state.grades,
		TestSession: Arr.map(state.sessions, (x) => ({
			child: x.child,
			stage: x.stage,
			pkg: x.pkg,
			visits: Arr.map(x.notes, (note) => ({ note }))
		}))
	},
	items: { ItemSession: state.items, Moment: state.moments, Presented: state.presented }
})

export type ClaimsFeature =
	| "a student's reads of their child's rows"
	| "a clocked read of a child the claims do not bind reads nothing"
	| "a student signed in as no one reads no member's row"
	| "a coach's reads of several children's rows"
	| "a read of a relation in no unit, whole"
	| "a raw fact outside the claims refused outsideWorld"
	| "an assignment refused at another child's number"
	| "a sequence's owner inserted with its members"
	| "a counted member appended"
	| "a delete outside the claims refused outsideWorld"
	| "a write proven inside the claims accepted"
	| "a write whose child no member gives prechecked"
	| "a write through a query entry outside the claims refused outsideWorld"
	| "a write through a query entry accepted"
	| "a unit's delete outside the claims refused outsideWorld"
	| "a unit deleted whole with its nested rows"
	| "a family member's delete outside the claims refused outsideWorld"
	| "a counted member removed"
	| "a unit delete whose child no member gives prechecked"
