/** What standing-reads.test.ts reads: its schema, its box, a case's write, the stored state at a scale and the model. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, derived, relation, schema } from "#compiler/public/schema.ts"
import { queryOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"

/** A sitting event's kind, a code: metis's start, submission and abandonment. */
const EventKind = closed.unordered("EventKind", ["start", "submit", "abandon"])

/**
 * metis's assign, reduced (its statement 6): each child's sittings with the user that assigned them, the test and its
 * subject; each sitting's grade; the invalidations of a sitting and the reinstatements that lift one; the sitting
 * events, each of a kind, that close one; and the origin the write records beside each sitting it assigns.
 */
export const Assignment = relation(
	"Assignment",
	{
		child: pg.integer,
		number: pg.integer,
		user: pg.integer,
		test: pg.integer,
		subject: pg.integer
	},
	["child", "number"]
)
export const AssignmentGrade = relation(
	"AssignmentGrade",
	{ number: pg.integer, gradeRank: pg.integer },
	["number"]
)
export const Invalidation = relation(
	"Invalidation",
	{ child: pg.integer, number: pg.integer, change: pg.integer },
	["child", "number", "change"]
)
export const Reinstatement = relation(
	"Reinstatement",
	{ child: pg.integer, number: pg.integer, change: pg.integer },
	["child", "number", "change"]
)
const SittingEvent = relation(
	"SittingEvent",
	{ child: pg.integer, number: pg.integer, step: pg.integer, kind: closedId(EventKind) },
	["child", "number", "step"]
)
export const Origin = relation(
	"Origin",
	{ child: pg.integer, number: pg.integer, origin: pg.integer },
	["child", "number"]
)

const base = (name: string) =>
	schema(
		name,
		[EventKind, Assignment, AssignmentGrade, Invalidation, Reinstatement, SittingEvent, Origin],
		[]
	)

/**
 * The schema and the two views of the active sittings a level above it, as metis's views read them: each open sitting
 * that counts, no standing invalidation of it and no submission or abandonment, with its user and test (Active), and
 * beside its grade (ActiveSlot); each reads the standing invalidations, every invalidation no reinstatement lifts.
 */
export const build = (name: string) => {
	const s = base(name)
	const standing = query(s).rule((r) => {
		const { child, number, change } = v(Invalidation, "standing")
		return r
			.match(Invalidation, { child, number, change })
			.where(r.not(Reinstatement, { child, number, change }))
			.find({ child, number })
	})
	const Active = derived(
		"Active",
		query(s).rule((r) => {
			const { child, number, user, test } = v(Assignment, "assignment")
			return r
				.match(Assignment, { child, number, user, test })
				.where(
					r.not(standing, { child, number }),
					r.not(SittingEvent, { child, number, kind: "submit" }),
					r.not(SittingEvent, { child, number, kind: "abandon" })
				)
				.find({ child, number, user, test })
		})
	)
	const ActiveSlot = derived(
		"ActiveSlot",
		query(s).rule((r) => {
			const { child, number, user, subject } = v(Assignment, "assignment")
			const { gradeRank } = v(AssignmentGrade, "grade")
			return r
				.match(Assignment, { child, number, user, subject })
				.match(AssignmentGrade, { number, gradeRank })
				.where(
					r.not(standing, { child, number }),
					r.not(SittingEvent, { child, number, kind: "submit" }),
					r.not(SittingEvent, { child, number, kind: "abandon" })
				)
				.find({ child, number, user, subject, gradeRank })
		})
	)
	return {
		schema: schema.extend([s], `${name}_1`, [Active, ActiveSlot], []),
		Active,
		ActiveSlot
	}
}

export type Built = ReturnType<typeof build>

/**
 * How the call's user's earlier sitting of the assigned test stands: active, never invalidated; invalidated, its
 * invalidation standing; or invalidated and reinstated. The new sitting is assigned where none of the user's sittings of
 * the test, and none of its subject and grade, is active.
 */
export type Earlier = "active" | "invalidated" | "reinstated"

const earliers = ["active", "invalidated", "reinstated"] as const satisfies ReadonlyArray<Earlier>

/** Each standing of the user's earlier sitting, every one of the closed set. */
export const earlierGen: Gen<Earlier> = element(earliers)

/** The call's parameters: its user, the new sitting's key, its test, subject and grade, and its origin. */
export const call = {
	user: 1,
	child: 1,
	number: 9,
	test: 1,
	subject: 3,
	grade: 2,
	origin: 5
} as const

/**
 * The case's write: the new sitting and its origin, each where the user holds no active sitting of the test and none of
 * its subject and grade, as metis's assign admits a sitting, two inserts each reading both views at the user.
 */
export const changeOf = (b: Built): ChangeSetValue => {
	const s = b.schema
	const admitted = (r: RuleValue) =>
		r.where(
			r.not(b.Active, { user: r.param("user", pg.integer), test: r.param("test", pg.integer) }),
			r.not(b.ActiveSlot, {
				user: r.param("user", pg.integer),
				subject: r.param("subject", pg.integer),
				gradeRank: r.param("grade", pg.integer)
			})
		)
	return ChangeSet.empty(s)
		.insert(
			Assignment,
			queryOver(s).rule((r: RuleValue) =>
				admitted(r).find({
					child: r.param("child", pg.integer),
					number: r.param("number", pg.integer),
					user: r.param("user", pg.integer),
					test: r.param("test", pg.integer),
					subject: r.param("subject", pg.integer)
				})
			)
		)
		.insert(
			Origin,
			queryOver(s).rule((r: RuleValue) =>
				admitted(r).find({
					child: r.param("child", pg.integer),
					number: r.param("number", pg.integer),
					origin: r.param("origin", pg.integer)
				})
			)
		)
}

type AssignmentRow = {
	readonly child: number
	readonly number: number
	readonly user: number
	readonly test: number
	readonly subject: number
}

type Change = { readonly child: number; readonly number: number; readonly change: number }

/**
 * The stored state at a scale: the call's user's earlier sitting of the test, standing as `earlier` says, at the call's
 * grade; and 16 more children's two sittings per scale, each of another user, each invalidated, one of each two
 * reinstated, which no read of the write meets; no sitting event.
 */
export const stateAt = (
	earlier: Earlier,
	scale: number
): {
	readonly assignments: ReadonlyArray<AssignmentRow>
	readonly grades: ReadonlyArray<{ readonly number: number; readonly gradeRank: number }>
	readonly invalidations: ReadonlyArray<Change>
	readonly reinstatements: ReadonlyArray<Change>
} => {
	const mine: AssignmentRow = {
		child: call.child,
		number: 1,
		user: call.user,
		test: call.test,
		subject: call.subject
	}
	const others = Arr.flatMap(
		Array.from({ length: 16 * scale }, (_, i) => i + 100),
		(child): ReadonlyArray<AssignmentRow> => [
			{ child, number: 1, user: child, test: call.test, subject: call.subject },
			{ child, number: 2, user: child, test: call.test, subject: call.subject }
		]
	)
	const invalidated = earlier === "invalidated" || earlier === "reinstated"
	return {
		assignments: [mine, ...others],
		grades: [
			{ number: 1, gradeRank: call.grade },
			{ number: 2, gradeRank: call.grade }
		],
		invalidations: [
			...(invalidated ? [{ child: mine.child, number: mine.number, change: 1 }] : []),
			...Arr.map(others, (a) => ({ child: a.child, number: a.number, change: 1 }))
		],
		reinstatements: [
			...(earlier === "reinstated" ? [{ child: mine.child, number: mine.number, change: 1 }] : []),
			...Arr.flatMap(others, (a) =>
				a.number === 1 ? [{ child: a.child, number: a.number, change: 1 }] : []
			)
		]
	}
}

/**
 * The model's sittings after the call, "child | number | user | test | subject" each, and its origins, "child | number |
 * origin", sorted: the new sitting and its origin where the user's earlier sitting is no active one, none beside.
 */
export const modelOf = (
	earlier: Earlier,
	scale: number
): { readonly assignments: ReadonlyArray<string>; readonly origins: ReadonlyArray<string> } => {
	const { assignments } = stateAt(earlier, scale)
	const admitted = earlier !== "active" && earlier !== "reinstated"
	const rows = admitted
		? [
				...assignments,
				{
					child: call.child,
					number: call.number,
					user: call.user,
					test: call.test,
					subject: call.subject
				}
			]
		: assignments
	return {
		assignments: Arr.sort(
			Arr.map(rows, (a) => `${a.child} | ${a.number} | ${a.user} | ${a.test} | ${a.subject}`),
			Order.String
		),
		origins: admitted ? [`${call.child} | ${call.number} | ${call.origin}`] : []
	}
}
