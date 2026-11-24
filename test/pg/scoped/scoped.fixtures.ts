/** What the property of scoped.test.ts reads: its schema, roles and template, its space of states, sessions and writes,
 * and its models. */

import { element, type Gen, int, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn, natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	context,
	counted,
	fin,
	login,
	mutable,
	on,
	ordered,
	relation,
	role,
	schema,
	scopedEntriesOf,
	unit,
	wholeEntriesOf,
	wholeWritesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { generatedTemplate } from "#test/support/install-migrate.ts"

/**
 * Scoped entries over PostgreSQL (schema/scope.ts, physical/ddl/roles.ts, program/slice.ts): a sitting's schema, as
 * metis's student holds it. Assignment(number) is rooted by its `student`, its key holding no field of the owner's, so a
 * write of it is probed at the key; SittingEvent(number, step) is reached by its number through Assignment's key, and
 * EventAt, contained in SittingEvent's key, in its shortest form through Assignment's too; TestSession(child, stage),
 * rooted by its `child`, owns the sequence of its Visits and the counted family of its ItemSessions, each rooted by its
 * child; Content is whole. The owner is the persons a session's Clerk user signs in as (Session ⋈ ClerkAccount).
 *
 * `student` holds scopedEntriesOf(S) and writes every scoped relation; `staff` holds every relation whole and seeds
 * each case's state through its own ChangeSets, so every drawn value of a family is grizzle's. The student's workload is
 * the schema's own programs: a read of each scoped relation, a pinned negation (SittingEvent at a number with no EventAt
 * at its step), and a write of each, the sequence owner's with its nested Visits and the counted member's appended to
 * a stored owner.
 *
 * A case draws a lawful state over small domains (two persons, three numbers, two steps), the session's Clerk user, and
 * one write. The models: each relation's slice, its rows whose owner the session signs in as (`sliceOf`); and each
 * write's outcome and the state after it (`writeOutcome`), the laws judged over every row: a key a row outside the
 * owner's rows holds refuses the write on that key, a row outside the owner's rows is outsideWorld, and where both
 * hold either is the answer.
 */

const Name = str.regex("^[a-z]{1,8}$")

const Person = relation("Person", { person: Name }, ["person"])
const ClerkAccount = relation("ClerkAccount", { clerk: Name, person: Name }, ["clerk"])
export const Assignment = relation("Assignment", { number: pg.bigint, student: Name, test: Name }, [
	"number"
])
export const SittingEvent = relation(
	"SittingEvent",
	{ number: pg.bigint, step: pg.bigint, kind: Name },
	["number", "step"]
)
export const EventAt = relation("EventAt", { number: pg.bigint, step: pg.bigint, at: pg.bigint }, [
	"number",
	"step"
])
export const TestSession = relation(
	"TestSession",
	{ child: Name, stage: pg.bigint, pkg: Name, visits: drawn(natural), items: drawn(natural) },
	["child", "stage"]
)
export const Visit = relation(
	"Visit",
	{ child: Name, stage: pg.bigint, at: drawn(natural), note: Name },
	["child", "stage", "at"]
)
export const ItemSession = relation("ItemSession", { child: Name, stage: pg.bigint, item: Name }, [
	"child",
	"stage",
	"item"
])
const Content = relation("Content", { pkg: Name, title: Name }, ["pkg"])

const Session = context("Session", { sub: Name })

/** The roots: each relation of one owner a field names, the rest reached along declared containments. */
const roots = {
	Assignment: "student",
	TestSession: "child",
	Visit: "child",
	ItemSession: "child"
} as const

/** The schema under `name`, its roles, logins and programs, built once per call as a template builds it. */
export const scopedAt = (name: string) => {
	const base = schema(
		name,
		[
			Person,
			ClerkAccount,
			Assignment,
			SittingEvent,
			EventAt,
			TestSession,
			Visit,
			ItemSession,
			Content
		],
		[
			contained(on(ClerkAccount, "person"), on(Person, "person")),
			contained(on(Assignment, "student"), on(Person, "person")),
			contained(on(SittingEvent, "number"), on(Assignment, "number")),
			contained(on(EventAt, "number", "step"), on(SittingEvent, "number", "step")),
			mutable(TestSession),
			ordered(on(Visit, "child", "stage", "at"), fin(TestSession, "visits")),
			counted(on(ItemSession, "child", "stage"), fin(TestSession, "items")),
			unit("Learner", { child: Name })
		]
	)
	const persons = query(base).rule((r) => {
		const { sub } = v(Session, "session")
		const { person } = v(ClerkAccount, "account")
		return r.match(Session, { sub }).match(ClerkAccount, { clerk: sub, person }).find({ person })
	})
	const student = role(base, "student", scopedEntriesOf(base, { owner: persons, roots }), {
		contexts: [Session],
		insert: ["Assignment", "SittingEvent", "EventAt", "Visit", "ItemSession"],
		write: ["TestSession"]
	})
	const staff = role(base, "staff", wholeEntriesOf(base), wholeWritesOf(base))
	const assignments = query(base).rule((r) => {
		const { number, student, test } = v(Assignment, "a")
		return r.match(Assignment, { number, student, test }).find({ number, student, test })
	})
	const events = query(base).rule((r) => {
		const { number, step, kind } = v(SittingEvent, "e")
		return r.match(SittingEvent, { number, step, kind }).find({ number, step, kind })
	})
	const eventsAt = query(base).rule((r) => {
		const { number, step, at } = v(EventAt, "t")
		return r.match(EventAt, { number, step, at }).find({ number, step, at })
	})
	const sessions = query(base).rule((r) => {
		const { child, stage, pkg, visits, items } = v(TestSession, "s")
		return r
			.match(TestSession, { child, stage, pkg, visits, items })
			.find({ child, stage, pkg, visits, items })
	})
	const visitsRead = query(base).rule((r) => {
		const { child, stage, at, note } = v(Visit, "w")
		return r.match(Visit, { child, stage, at, note }).find({ child, stage, at, note })
	})
	const itemsRead = query(base).rule((r) => {
		const { child, stage, item } = v(ItemSession, "i")
		return r.match(ItemSession, { child, stage, item }).find({ child, stage, item })
	})
	/** The steps of the number a call names with no EventAt: a negation its positive match pins, admitted on the role. */
	const unstamped = query(base).rule((r) => {
		const number = r.param("number", Assignment.fields.number)
		const { step } = v(SittingEvent, "e")
		return r
			.match(SittingEvent, { number, step })
			.where(r.not(EventAt, { number, step }))
			.find({ step })
	})
	const app = login(base, "app", [student], {
		workload: [
			workload(base, {
				assignments,
				events,
				eventsAt,
				sessions,
				visitsRead,
				itemsRead,
				unstamped,
				addAssignment: ChangeSet.empty(base).insert(Assignment, []),
				addEvent: ChangeSet.empty(base).insert(SittingEvent, []),
				addEventAt: ChangeSet.empty(base).insert(SittingEvent, []).insert(EventAt, []),
				openSession: ChangeSet.empty(base).insert(TestSession, []),
				addItem: ChangeSet.empty(base).insert(ItemSession, [])
			})
		]
	})
	const desk = login(base, "desk", [staff], {
		workload: [
			workload(staff, {
				seedPeople: ChangeSet.empty(staff).insert(Person, []).insert(ClerkAccount, []),
				seedAssignments: ChangeSet.empty(staff).insert(Assignment, []),
				seedEvents: ChangeSet.empty(staff).insert(SittingEvent, []).insert(TestSession, []),
				seedLater: ChangeSet.empty(staff).insert(EventAt, []).insert(ItemSession, [])
			})
		]
	})
	return { base, student, staff, app, desk }
}

/**
 * The schema drafted and served as `grizzle generate` does, installed once per member, each case a clone of its own
 * (scopedAt): every worker plans its draft and both logins' served files once, which each case serves over its clone
 * (served-db.ts servedGenerated).
 */
export const scopedTemplate = generatedTemplate({
	declaredIn: import.meta,
	name: "scoped entries",
	content: {
		schema: "scoped",
		logins: ["app: the student's scoped entries", "desk: staff, every relation whole"]
	},
	build: (name) => {
		const s = scopedAt(name)
		return { schema: s.base, logins: [s.app, s.desk] }
	},
	ambient: ordinarySession
})

const people = ["ann", "bob"] as const
export type Person = (typeof people)[number]
/** Each person's one Clerk user. */
export const clerkOf: Readonly<Record<Person, string>> = { ann: "cann", bob: "cbob" }

export interface AssignmentRow {
	readonly number: bigint
	readonly student: Person
	readonly test: string
}
export interface EventRow {
	readonly number: bigint
	readonly step: bigint
	readonly kind: string
}
export interface EventAtRow {
	readonly number: bigint
	readonly step: bigint
	readonly at: bigint
}
export interface SessionRow {
	readonly child: Person
	readonly stage: bigint
	readonly pkg: string
	/** Its Visits' notes, in order: the sequence nested under it. */
	readonly notes: ReadonlyArray<string>
}
export interface ItemRow {
	readonly child: Person
	readonly stage: bigint
	readonly item: string
}

/** A lawful state: every containment and family holds. */
export interface State {
	readonly assignments: ReadonlyArray<AssignmentRow>
	readonly events: ReadonlyArray<EventRow>
	readonly eventsAt: ReadonlyArray<EventAtRow>
	readonly sessions: ReadonlyArray<SessionRow>
	readonly items: ReadonlyArray<ItemRow>
}

/** One write of the student's: its member and the facts it gives. */
export type Write =
	| { readonly kind: "addAssignment"; readonly row: AssignmentRow }
	| { readonly kind: "addEvent"; readonly row: EventRow }
	| { readonly kind: "addEventAt"; readonly event: EventRow; readonly at: bigint }
	| { readonly kind: "openSession"; readonly row: SessionRow }
	| { readonly kind: "addItem"; readonly row: ItemRow }

export interface ScopedCase {
	readonly state: State
	readonly person: Person
	readonly write: Write
}

const words = ["a", "b"] as const
const numberGen: Gen<bigint> = (s) => BigInt(s.draw(int(1, 3)))
const stepGen: Gen<bigint> = (s) => BigInt(s.draw(int(1, 2)))

/** Rows each its key's once, the first drawn kept. */
const uniqueBy = <A>(rows: ReadonlyArray<A>, key: (a: A) => string): ReadonlyArray<A> => {
	const seen = new Set<string>()
	return Arr.filter(rows, (a) => {
		const k = key(a)
		const fresh = !seen.has(k)
		seen.add(k)
		return fresh
	})
}

const assignmentKey = (a: { readonly number: bigint }): string => String(a.number)
const eventKey = (e: { readonly number: bigint; readonly step: bigint }): string =>
	`${e.number} ${e.step}`
const sessionKey = (x: { readonly child: string; readonly stage: bigint }): string =>
	`${x.child} ${x.stage}`
const itemKey = (x: ItemRow): string => `${x.child} ${x.stage} ${x.item}`

/**
 * A lawful state: assignments of drawn numbers and students; events and stamps of assigned numbers, each stamp of an
 * event; sessions of drawn children and stages, each with up to two Visits; items of stored sessions.
 */
const stateGen: Gen<State> = (s) => {
	const assignments = uniqueBy(
		Array.from({ length: s.draw(int(1, 3)) }, () => ({
			number: s.draw(numberGen),
			student: s.draw(element(people)),
			test: s.draw(element(words))
		})),
		assignmentKey
	)
	const numbers = Arr.map(assignments, (a) => a.number)
	const assigned = Arr.isReadonlyArrayNonEmpty(numbers) ? numbers : undefined
	const events =
		assigned === undefined
			? []
			: uniqueBy(
					Array.from({ length: s.draw(int(1, 4)) }, () => ({
						number: s.draw(element(assigned)),
						step: s.draw(stepGen),
						kind: s.draw(element(words))
					})),
					eventKey
				)
	const eventsAt = Arr.map(s.draw(subarray(events)), (e) => ({
		number: e.number,
		step: e.step,
		at: BigInt(s.draw(int(1, 9)))
	}))
	const sessions = uniqueBy(
		Array.from({ length: s.draw(int(1, 3)) }, () => ({
			child: s.draw(element(people)),
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
	return { assignments, events, eventsAt, sessions, items }
}

/**
 * A write, drawn near the state so each kind meets its laws: an assignment at a drawn number, held or free, of either
 * student; an event at a drawn number, assigned or not, at a drawn step; an event with its stamp at a number of the
 * session's own person, at a step it holds no event at, where there is one; a session of the owner's at a stage it
 * holds none at, or of the other person's, with up to two Visits; an item of a stored session or of a drawn one.
 */
const writeGen =
	(state: State, person: Person): Gen<Write> =>
	(s) => {
		const own = Arr.filter(state.assignments, (a) => a.student === person)
		const freeAt = Arr.flatMap(own, (a) =>
			Arr.flatMap([1n, 2n], (step): ReadonlyArray<EventRow> =>
				Arr.some(state.events, (e) => e.number === a.number && e.step === step)
					? []
					: [{ number: a.number, step, kind: "a" }]
			)
		)
		const kind = s.draw(
			element(["addAssignment", "addEvent", "addEventAt", "openSession", "addItem"] as const)
		)
		switch (kind) {
			case "addAssignment":
				return {
					kind,
					row: {
						number: s.draw(numberGen),
						student: s.draw(element(people)),
						test: s.draw(element(words))
					}
				}
			case "addEventAt":
				if (Arr.isReadonlyArrayNonEmpty(freeAt)) {
					return { kind, event: s.draw(element(freeAt)), at: BigInt(s.draw(int(1, 9))) }
				}
				return {
					kind: "addEvent",
					row: { number: s.draw(numberGen), step: s.draw(stepGen), kind: "b" }
				}
			case "addEvent":
				return {
					kind,
					row: { number: s.draw(numberGen), step: s.draw(stepGen), kind: s.draw(element(words)) }
				}
			case "openSession": {
				const free = Arr.filter(
					[1n, 2n],
					(stage) => !Arr.some(state.sessions, (x) => x.child === person && x.stage === stage)
				)
				const other: Person = person === "ann" ? "bob" : "ann"
				const ownStage =
					Arr.isReadonlyArrayNonEmpty(free) && s.draw(element([true, false] as const))
						? s.draw(element(free))
						: undefined
				return {
					kind,
					row: {
						child: ownStage === undefined ? other : person,
						stage: ownStage ?? s.draw(stepGen),
						pkg: s.draw(element(words)),
						notes: Array.from({ length: s.draw(int(0, 2)) }, () => s.draw(element(words)))
					}
				}
			}
			case "addItem": {
				const stored = Arr.map(state.sessions, (x) => ({ child: x.child, stage: x.stage }))
				const at =
					Arr.isReadonlyArrayNonEmpty(stored) && s.draw(element([true, false] as const))
						? s.draw(element(stored))
						: { child: s.draw(element(people)), stage: s.draw(stepGen) }
				return { kind, row: { child: at.child, stage: at.stage, item: s.draw(element(words)) } }
			}
		}
	}

export const scopedCaseGen: Gen<ScopedCase> = (s) => {
	const state = s.draw(stateGen)
	const person = s.draw(element(people))
	return { state, person, write: s.draw(writeGen(state, person)) }
}

/** The slice of a state the session of `person` reads: each scoped relation's rows whose owner is `person`. */
export const sliceOf = (state: State, person: Person): State => {
	const owned = new Set(
		Arr.map(
			Arr.filter(state.assignments, (a) => a.student === person),
			(a) => a.number
		)
	)
	return {
		assignments: Arr.filter(state.assignments, (a) => a.student === person),
		events: Arr.filter(state.events, (e) => owned.has(e.number)),
		eventsAt: Arr.filter(state.eventsAt, (e) => owned.has(e.number)),
		sessions: Arr.filter(state.sessions, (x) => x.child === person),
		items: Arr.filter(state.items, (x) => x.child === person)
	}
}

/** What a write answers by the model: accepted with the state after it, unchanged, refused on a relation's primary key
 * or on some other law, or outsideWorld; or any of `either`, where a row outside the owner's breaks a law too. */
export type Expected =
	| { readonly kind: "accepted"; readonly after: State }
	| { readonly kind: "unchanged" }
	| { readonly kind: "refused"; readonly law: "key" | "other"; readonly relation: string }
	| { readonly kind: "outsideWorld" }
	| { readonly kind: "either"; readonly refused: string }

const sameEvent = (a: EventRow, b: EventRow): boolean =>
	a.number === b.number && a.step === b.step && a.kind === b.kind

/**
 * The model of a write: its laws judged over every row (a key another owner's row holds refuses it), its rows held to
 * the owner's (a row outside them is outsideWorld), and the state after it.
 */
export const writeOutcome = (c: ScopedCase): Expected => {
	const { state, person } = c
	const assignmentOf = (number: bigint) =>
		Option.getOrUndefined(Arr.findFirst(state.assignments, (a) => a.number === number))
	const ownsNumber = (number: bigint): boolean => assignmentOf(number)?.student === person
	switch (c.write.kind) {
		case "addAssignment": {
			const row = c.write.row
			const held = assignmentOf(row.number)
			const outside = row.student !== person
			if (held !== undefined) {
				if (outside) {
					return { kind: "either", refused: "Assignment" }
				}
				return held.student === row.student && held.test === row.test
					? { kind: "unchanged" }
					: { kind: "refused", law: "key", relation: "Assignment" }
			}
			return outside
				? { kind: "outsideWorld" }
				: { kind: "accepted", after: { ...state, assignments: [...state.assignments, row] } }
		}
		case "addEvent": {
			const row = c.write.row
			if (assignmentOf(row.number) === undefined) {
				return { kind: "either", refused: "SittingEvent" }
			}
			if (!ownsNumber(row.number)) {
				return { kind: "outsideWorld" }
			}
			const held = Option.getOrUndefined(
				Arr.findFirst(state.events, (e) => eventKey(e) === eventKey(row))
			)
			if (held !== undefined) {
				return sameEvent(held, row)
					? { kind: "unchanged" }
					: { kind: "refused", law: "key", relation: "SittingEvent" }
			}
			return { kind: "accepted", after: { ...state, events: [...state.events, row] } }
		}
		case "addEventAt": {
			const { event, at } = c.write
			return {
				kind: "accepted",
				after: {
					...state,
					events: [...state.events, event],
					eventsAt: [...state.eventsAt, { number: event.number, step: event.step, at }]
				}
			}
		}
		case "openSession": {
			const row = c.write.row
			if (row.child !== person) {
				return { kind: "outsideWorld" }
			}
			const held = Option.getOrUndefined(
				Arr.findFirst(state.sessions, (x) => sessionKey(x) === sessionKey(row))
			)
			if (held !== undefined) {
				return { kind: "refused", law: "key", relation: "TestSession" }
			}
			return { kind: "accepted", after: { ...state, sessions: [...state.sessions, row] } }
		}
		case "addItem": {
			const row = c.write.row
			const owner = Arr.some(state.sessions, (x) => sessionKey(x) === sessionKey(row))
			if (row.child !== person) {
				return owner ? { kind: "outsideWorld" } : { kind: "either", refused: "ItemSession" }
			}
			if (!owner) {
				return { kind: "refused", law: "other", relation: "ItemSession" }
			}
			if (Arr.some(state.items, (x) => itemKey(x) === itemKey(row))) {
				return { kind: "unchanged" }
			}
			return { kind: "accepted", after: { ...state, items: [...state.items, row] } }
		}
	}
}

/** A state's rows as the property compares them, each relation's as text rows in order: the read programs' columns. */
export interface Tables {
	readonly assignments: ReadonlyArray<string>
	readonly events: ReadonlyArray<string>
	readonly eventsAt: ReadonlyArray<string>
	readonly sessions: ReadonlyArray<string>
	readonly visits: ReadonlyArray<string>
	readonly items: ReadonlyArray<string>
}

/** A row as text: its values in the read's column order, apart by a space. */
export const rowText = (values: ReadonlyArray<unknown>): string =>
	Arr.join(
		Arr.map(values, (x) => String(x)),
		" "
	)

const sorted = (rows: ReadonlyArray<string>): ReadonlyArray<string> => Arr.sort(rows, Order.String)

/** The tables of a state: each session with its drawn Visit count and item count, each Visit at its drawn place. */
export const tablesOf = (state: State): Tables => ({
	assignments: sorted(Arr.map(state.assignments, (a) => rowText([a.number, a.student, a.test]))),
	events: sorted(Arr.map(state.events, (e) => rowText([e.number, e.step, e.kind]))),
	eventsAt: sorted(Arr.map(state.eventsAt, (e) => rowText([e.number, e.step, e.at]))),
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
	items: sorted(Arr.map(state.items, (i) => rowText([i.child, i.stage, i.item])))
})

/** The seeding ChangeSets' facts, each its staff member's: people, assignments, events with sessions and their
 * Visits nested, then stamps with items. */
export const seedFacts = (state: State) => ({
	people: {
		Person: Arr.map(people, (person) => ({ person })),
		ClerkAccount: Arr.map(people, (person) => ({ clerk: clerkOf[person], person }))
	},
	assignments: { Assignment: state.assignments },
	events: {
		SittingEvent: state.events,
		TestSession: Arr.map(state.sessions, (x) => ({
			child: x.child,
			stage: x.stage,
			pkg: x.pkg,
			visits: Arr.map(x.notes, (note) => ({ note }))
		}))
	},
	later: { EventAt: state.eventsAt, ItemSession: state.items }
})

export type ScopedFeature =
	| "a read of the owner's rows"
	| "an assignment refused at another owner's key"
	| "an outsideWorld write"
	| "an event refused at its own key"
	| "an event and its stamp in one stratum"
	| "a sequence's owner inserted with its members"
	| "a counted member appended"
	| "a direct write outside the owner's rows refused"
