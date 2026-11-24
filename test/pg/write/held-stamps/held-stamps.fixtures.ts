/** What held-stamps.test.ts reads: its schema, its box, a case's write, the stored state at a scale and the model. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"

/**
 * metis's hold gate, reduced (METISPERF's heldOnAssign repro): each child's assignments with the user that assigned
 * them, the test and when it expires; the sitting events and the expiry holds that close one; each test's subject and
 * grade; each person's read-aloud need; and the read-aloud stamp the write gives each due assignment.
 */
export const Assignment = relation(
	"Assignment",
	{
		child: pg.integer,
		number: pg.integer,
		user: pg.integer,
		test: pg.integer,
		expiresAt: pg.integer
	},
	["child", "number"]
)
const SittingEvent = relation(
	"SittingEvent",
	{ child: pg.integer, number: pg.integer, step: pg.integer },
	["child", "number", "step"]
)
export const ExpiryHeld = relation(
	"ExpiryHeld",
	{ child: pg.integer, number: pg.integer, at: pg.integer },
	["child", "number"]
)
export const Test = relation(
	"Test",
	{ test: pg.integer, subject: pg.integer, gradeRank: pg.integer },
	["test"]
)
export const ReadAloudNeed = relation("ReadAloudNeed", { person: pg.integer, on: pg.boolean }, [
	"person"
])
export const AssignmentReadAloud = relation(
	"AssignmentReadAloud",
	{ child: pg.integer, number: pg.integer, on: pg.boolean },
	["child", "number"]
)

export const build = (name: string) =>
	schema(name, [Assignment, SittingEvent, ExpiryHeld, Test, ReadAloudNeed, AssignmentReadAloud], [])

export type Schema = ReturnType<typeof build>

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
 * a navigation equating the open row to the values its reader passes in, or with the two negations of their own.
 */
export type Due = "through the open assignments" | "by negations of its own"

export const dues = [
	"through the open assignments",
	"by negations of its own"
] as const satisfies ReadonlyArray<Due>

export const dueGen: Gen<Due> = element<Due>(dues)

/** The call's user's assignments expired by the call's instant, read as `due` says. */
const dueOf = (s: Schema, due: Due): QueryValue =>
	queryOver(s).rule((r: RuleValue) => {
		const { child, number, expiresAt } = varsOver(Assignment, "due")
		const expired = r.match(Assignment, {
			child,
			number,
			user: r.param("user", pg.integer),
			expiresAt
		})
		switch (due) {
			case "through the open assignments":
				return expired
					.match(openOf(s), { child, number })
					.where(r.le(expiresAt, r.param("now", pg.integer)))
					.find({ child, number })
			case "by negations of its own":
				return expired
					.where(
						r.not(SittingEvent, { child, number }),
						r.not(ExpiryHeld, { child, number }),
						r.le(expiresAt, r.param("now", pg.integer))
					)
					.find({ child, number })
		}
	})

/**
 * The case's write: each due assignment unstamped gets its read-aloud stamp, beside the test the call names, as metis's
 * hold gate inserts it.
 */
export const changeOf = (s: Schema, due: Due): ChangeSetValue =>
	ChangeSet.empty(s)
		.insert(
			AssignmentReadAloud,
			queryOver(s).rule((r: RuleValue) => {
				const d = dueOf(s, due).bind({
					user: r.param("user", pg.integer),
					now: r.param("now", pg.integer)
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
			target: queryOver(s).rule((r: RuleValue) => r.find({ test: r.param("test", pg.integer) }))
		})

/** The test the call names, as metis's hold gate binds the assigned test. */
const targetHeading = { test: pg.integer } as const

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
