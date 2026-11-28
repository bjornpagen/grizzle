/** What held-stamps.test.ts reads: its schema, its box, a case's write, the stored state at a scale and the model. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { closedId, bool, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, derived, relation, schema } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"

/** A sitting event's kind, a code: metis's start, submission, abandonment and expiry. */
const EventKind = closed.unordered("EventKind", ["start", "submit", "abandon", "expire"])

/**
 * metis's hold gate, reduced (METISPERF's heldOnAssign repro): each child's assignments with the user that assigned
 * them, the test and when it expires; the sitting events, each of a kind, and the expiry holds that close one; the
 * invalidations of a sitting and the reinstatements that lift one; each test's subject and grade; each person's
 * read-aloud need; and the read-aloud stamp the write gives each due assignment.
 */
export const Assignment = relation(
	"Assignment",
	{
		child: int4,
		number: int4,
		user: int4,
		test: int4,
		expiresAt: int4
	},
	["child", "number"]
)
const SittingEvent = relation(
	"SittingEvent",
	{ child: int4, number: int4, step: int4, kind: closedId(EventKind) },
	["child", "number", "step"]
)
const Invalidation = relation("Invalidation", { child: int4, number: int4, change: int4 }, [
	"child",
	"number",
	"change"
])
const Reinstatement = relation("Reinstatement", { child: int4, number: int4, change: int4 }, [
	"child",
	"number",
	"change"
])
export const ExpiryHeld = relation("ExpiryHeld", { child: int4, number: int4, at: int4 }, [
	"child",
	"number"
])
export const Test = relation("Test", { test: int4, subject: int4, gradeRank: int4 }, ["test"])
export const ReadAloudNeed = relation("ReadAloudNeed", { person: int4, on: bool }, ["person"])
export const AssignmentReadAloud = relation(
	"AssignmentReadAloud",
	{ child: int4, number: int4, on: bool },
	["child", "number"]
)

const base = (name: string) =>
	schema(
		name,
		[
			EventKind,
			Assignment,
			SittingEvent,
			ExpiryHeld,
			Invalidation,
			Reinstatement,
			Test,
			ReadAloudNeed,
			AssignmentReadAloud
		],
		[]
	)

type Base = ReturnType<typeof base>

/**
 * metis's Open, as its views declare it: each assignment no submission, abandonment or expiry event closes, a code's
 * value in each negation, and no expiry hold.
 */
const openViewOf = (s: Base) =>
	derived(
		"OpenView",
		query(s).rule((r) => {
			const { child, number } = v(Assignment, "assignment")
			return r
				.match(Assignment, { child, number })
				.where(
					r.not(SittingEvent, { child, number, kind: "submit" }),
					r.not(SittingEvent, { child, number, kind: "abandon" }),
					r.not(SittingEvent, { child, number, kind: "expire" }),
					r.not(ExpiryHeld, { child, number })
				)
				.find({ child, number })
		})
	)

/** metis's Valid, as its views declare it: each assignment no standing invalidation (one no reinstatement lifts) holds. */
const validViewOf = (s: Base) => {
	const standing = query(s).rule((r) => {
		const { child, number, change } = v(Invalidation, "standing")
		return r
			.match(Invalidation, { child, number, change })
			.where(r.not(Reinstatement, { child, number, change }))
			.find({ child, number })
	})
	return derived(
		"ValidView",
		query(s).rule((r) => {
			const { child, number } = v(Assignment, "assignment")
			return r
				.match(Assignment, { child, number })
				.where(r.not(standing, { child, number }))
				.find({ child, number })
		})
	)
}

/** The relations and metis's two views over them, a level above. */
export const build = (name: string) => {
	const s = base(name)
	const OpenView = openViewOf(s)
	const ValidView = validViewOf(s)
	return { schema: schema.extend([s], `${name}_1`, [OpenView, ValidView], []), OpenView, ValidView }
}

export type Built = ReturnType<typeof build>
type Schema = Built["schema"]

/**
 * Each assignment's read-aloud: its stamp; or, unstamped, on for a test of subject 7 at grade 2 or below; or, unstamped,
 * its child's need for a test of any other subject. A union of three rules, each a navigation's chain whose first step
 * reads every assignment or every test, as metis's AssignmentReadAloud view reads them.
 */
const readAloudOf = (s: Schema): QueryValue =>
	queryOver(s)
		.rule((r: RuleValue) => {
			const { child, number, on } = varsOver(AssignmentReadAloud, "stamp")
			return r.match(AssignmentReadAloud, { child, number, on }).find({ child, number, on })
		})
		.rule((r: RuleValue) => {
			const { child, number, test } = varsOver(Assignment, "assignment")
			const { subject, gradeRank } = varsOver(Test, "test")
			return r
				.match(Assignment, { child, number, test })
				.match(Test, { test, subject, gradeRank })
				.where(r.not(AssignmentReadAloud, { child, number }), r.eq(subject, 7), r.le(gradeRank, 2))
				.find({ child, number, on: true })
		})
		.rule((r: RuleValue) => {
			const { child, number, test } = varsOver(Assignment, "assignment")
			const { subject } = varsOver(Test, "test")
			const { on } = varsOver(ReadAloudNeed, "need")
			return r
				.match(Assignment, { child, number, test })
				.match(Test, { test, subject })
				.match(ReadAloudNeed, { person: child, on })
				.where(r.not(AssignmentReadAloud, { child, number }), r.ne(subject, 7))
				.find({ child, number, on })
		})

/** The open assignments: those no sitting event and no expiry hold closes, as metis's Open view reads them. */
const openOf = (s: Schema): QueryValue =>
	queryOver(s).rule((r: RuleValue) => {
		const { child, number } = varsOver(Assignment, "assignment")
		return r
			.match(Assignment, { child, number })
			.where(r.not(SittingEvent, { child, number }), r.not(ExpiryHeld, { child, number }))
			.find({ child, number })
	})

/**
 * How the due assignments are read: the user's expired ones read again in the open assignments by their key, a step of
 * a navigation equating the open row to the values its reader passes in; with the two negations of their own; or as
 * metis's dueOfCall reads them, through its declared Open and Valid views, each a step whose one occurrence is the
 * view's rows held at the outer row's key, and a negation of every sitting event of its own.
 */
export type Due =
	| "through the open assignments"
	| "by negations of its own"
	| "through metis's views"

export const dues = [
	"through the open assignments",
	"by negations of its own",
	"through metis's views"
] as const satisfies ReadonlyArray<Due>

export const dueGen: Gen<Due> = element<Due>(dues)

/** The call's user's assignments expired by the call's instant, read as `due` says. */
const dueOf = (b: Built, due: Due): QueryValue => {
	const s = b.schema
	return queryOver(s).rule((r: RuleValue) => {
		const { child, number, expiresAt } = varsOver(Assignment, "due")
		const expired = r.match(Assignment, {
			child,
			number,
			user: r.param("user", int4),
			expiresAt
		})
		switch (due) {
			case "through the open assignments":
				return expired
					.match(openOf(s), { child, number })
					.where(r.le(expiresAt, r.param("now", int4)))
					.find({ child, number })
			case "by negations of its own":
				return expired
					.where(
						r.not(SittingEvent, { child, number }),
						r.not(ExpiryHeld, { child, number }),
						r.le(expiresAt, r.param("now", int4))
					)
					.find({ child, number })
			case "through metis's views":
				return expired
					.match(b.OpenView, { child, number })
					.match(b.ValidView, { child, number })
					.where(r.not(SittingEvent, { child, number }), r.le(expiresAt, r.param("now", int4)))
					.find({ child, number })
		}
	})
}

/**
 * The case's write: each due assignment unstamped gets its read-aloud stamp, beside the test the call names, as metis's
 * hold gate inserts it.
 */
export const changeOf = (b: Built, due: Due): ChangeSetValue => {
	const s = b.schema
	return ChangeSet.empty(s)
		.insert(
			AssignmentReadAloud,
			queryOver(s).rule((r: RuleValue) => {
				const d = dueOf(b, due).bind({
					user: r.param("user", int4),
					now: r.param("now", int4)
				})
				const { child, number } = varsOver(d, "due")
				const readAloud = readAloudOf(s)
				const { on } = varsOver(readAloud, "read")
				const target = r.relation("target", targetHeading)
				const { test } = varsOver(target, "target")
				return r
					.match(target, { test })
					.match(d, { child, number })
					.match(readAloud, { child, number, on })
					.where(r.not(AssignmentReadAloud, { child, number }))
					.find({ child, number, on })
			})
		)
		.bind({
			target: queryOver(s).rule((r: RuleValue) => r.find({ test: r.param("test", int4) }))
		})
}

/** The test the call names, as metis's hold gate binds the assigned test. */
const targetHeading = { test: int4 } as const

/** The call's user and instant. */
export const user = 1
export const now = 10

type AssignmentRow = {
	readonly child: number
	readonly number: number
	readonly user: number
	readonly test: number
	readonly expiresAt: number
}

/**
 * The stored state at a scale: the call's user's four assignments, the first two due, the third held at its expiry and
 * the fourth not yet expired; and 16 more children's two per scale, each of another user and expired too, which no read
 * of the write meets; two tests, one of subject 7 at grade 1 and one of subject 3; every child's need.
 */
export const stateAt = (
	scale: number
): {
	readonly assignments: ReadonlyArray<AssignmentRow>
	readonly held: ReadonlyArray<{ readonly child: number; readonly number: number }>
	readonly tests: ReadonlyArray<{
		readonly test: number
		readonly subject: number
		readonly gradeRank: number
	}>
	readonly needs: ReadonlyArray<{ readonly person: number; readonly on: boolean }>
} => {
	const mine: ReadonlyArray<AssignmentRow> = [
		{ child: 1, number: 1, user, test: 1, expiresAt: 0 },
		{ child: 1, number: 2, user, test: 2, expiresAt: 0 },
		{ child: 2, number: 1, user, test: 2, expiresAt: 0 },
		{ child: 2, number: 2, user, test: 1, expiresAt: now + 1 }
	]
	const others = Arr.flatMap(
		Array.from({ length: 16 * scale }, (_, i) => i + 100),
		(child): ReadonlyArray<AssignmentRow> => [
			{ child, number: 1, user: child, test: 1, expiresAt: 0 },
			{ child, number: 2, user: child, test: 2, expiresAt: 0 }
		]
	)
	const assignments = [...mine, ...others]
	return {
		assignments,
		held: [{ child: 2, number: 1 }],
		tests: [
			{ test: 1, subject: 7, gradeRank: 1 },
			{ test: 2, subject: 3, gradeRank: 1 }
		],
		needs: Arr.map(Arr.dedupe(Arr.map(assignments, (a) => a.child)), (person) => ({
			person,
			on: person % 2 === 0
		}))
	}
}

/**
 * The model's stamps after the call, "child | number | on", sorted: each of the call's user's assignments expired by
 * its instant and not held, on for a test of subject 7 at grade 2 or below, its child's need for any other subject.
 */
export const modelOf = (scale: number): ReadonlyArray<string> => {
	const { assignments, held, tests, needs } = stateAt(scale)
	const testOf = new Map(Arr.map(tests, (t) => [t.test, t] as const))
	const needOf = new Map(Arr.map(needs, (n) => [n.person, n.on] as const))
	return Arr.sort(
		Arr.flatMap(assignments, (a) => {
			const test = testOf.get(a.test)
			if (
				a.user !== user ||
				a.expiresAt > now ||
				Arr.some(held, (h) => h.child === a.child && h.number === a.number) ||
				test === undefined
			) {
				return []
			}
			const on = test.subject === 7 ? (test.gradeRank <= 2 ? true : undefined) : needOf.get(a.child)
			return on === undefined ? [] : [`${a.child} | ${a.number} | ${on}`]
		}),
		Order.String
	)
}
