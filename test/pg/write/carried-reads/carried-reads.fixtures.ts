/** What the property of carried-reads.test.ts reads: its schema, its box, the ChangeSet of a case and its model. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema, unit } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"

/** An attempt of a child, its `n`th, under the child's unit, as edullm's Attempt is a snapshot of an item session. */
export const Attempt = relation("Attempt", { child: pg.integer, n: pg.integer }, ["child", "n"])

/** An attempt's grade, the sidecar a grading stratum writes, as edullm's ProcessedAttempt is. */
export const Graded = relation("Graded", { child: pg.integer, n: pg.integer, score: pg.integer }, [
	"child",
	"n"
])

const base = (name: string) =>
	schema(
		name,
		[Attempt, Graded],
		[
			unit("Learner", { child: pg.integer }),
			contained(on(Graded, "child", "n"), on(Attempt, "child", "n"))
		]
	)

/**
 * Each attempt's status, derived from Attempt and Graded as edullm's ItemSessionStatus is: 0 while it has no grade, 1
 * once it has one, so a read of it reads Attempt itself.
 */
const statusOf = (s: ReturnType<typeof base>) =>
	derived(
		"Status",
		query(s)
			.rule((r) => {
				const { child, n } = v(Attempt, "pending")
				return r
					.match(Attempt, { child, n })
					.where(r.not(Graded, { child, n }))
					.find({ child, n, status: 0 })
			})
			.rule((r) => {
				const { child, n } = v(Graded, "final")
				return r.match(Graded, { child, n }).find({ child, n, status: 1 })
			})
	)

export const build = (name: string) => {
	const s = base(name)
	const Status = statusOf(s)
	return { schema: schema.extend([s], `${name}_1`, [Status], []), Status }
}

type Built = ReturnType<typeof build>

/** A fact of Attempt. */
interface AttemptFact {
	readonly child: number
	readonly n: number
}

/** A fact of Graded. */
interface GradeFact {
	readonly child: number
	readonly n: number
	readonly score: number
}

/** The stored attempts: child 1's first, graded, and second, not, and child 2's first, not graded. */
export const storedAttempts: ReadonlyArray<AttemptFact> = [
	{ child: 1, n: 1 },
	{ child: 1, n: 2 },
	{ child: 2, n: 1 }
]

/** The stored grades. */
export const storedGrades: ReadonlyArray<GradeFact> = [{ child: 1, n: 1, score: 5 }]

/** The attempt every case records afresh, and one of child 2 a case may record beside it. */
const fresh: AttemptFact = { child: 1, n: 3 }
const freshOther: AttemptFact = { child: 2, n: 2 }

/**
 * Where the call grades: in a stratum sequenced after the one recording the attempts, edullm's grading; in the
 * attempts' own stratum, where the containment orders the grades' insert after the attempts'; or in a stratum before
 * the attempts', grading stored attempts alone, so the attempts' read-back reads state no later statement writes.
 */
type Grading = "in a later stratum" | "in the attempts' own stratum" | "in a stratum before"

/** What the call records: the fresh attempt; it and child 2's next; or it and a stored attempt again, which it meets. */
type Recorded = "the fresh attempt" | "two fresh attempts" | "a stored attempt again"

/**
 * What the call grades: child 2's stored first attempt, or that and every attempt it records afresh, which grading
 * before the attempts cannot.
 */
type Grades = "a stored attempt" | "the recorded attempts too"

/**
 * The read-back of the attempts the call recorded, delta.added(Attempt): with its grade, Graded the later write
 * writes; with its status, the derived Status over Attempt itself; or as edullm's answerTestItem reads its attempt,
 * with its grade and its status both.
 */
type Read = "its grade" | "its status" | "its grade and status"

interface CarriedCase {
	readonly grading: Grading
	readonly recorded: Recorded
	readonly grades: Grades
	readonly read: Read
}

export const carriedGen: Gen<CarriedCase> = (source) => ({
	grading: source.draw(
		element(["in a later stratum", "in the attempts' own stratum", "in a stratum before"] as const)
	),
	recorded: source.draw(
		element(["the fresh attempt", "two fresh attempts", "a stored attempt again"] as const)
	),
	grades: source.draw(element(["a stored attempt", "the recorded attempts too"] as const)),
	read: source.draw(element(["its grade", "its status", "its grade and status"] as const))
})

export const situations = [
	"in a later stratum",
	"in the attempts' own stratum",
	"in a stratum before",
	"the fresh attempt",
	"two fresh attempts",
	"a stored attempt again",
	"a stored attempt",
	"the recorded attempts too",
	"its grade",
	"its status",
	"its grade and status",
	"carried to the end of the write",
	"riding the attempts' statement"
] as const

export type Situation = (typeof situations)[number]

/** The attempts a case's call records. */
const recordedOf = (c: CarriedCase): ReadonlyArray<AttemptFact> => {
	switch (c.recorded) {
		case "the fresh attempt":
			return [fresh]
		case "two fresh attempts":
			return [fresh, freshOther]
		case "a stored attempt again":
			return [fresh, { child: 1, n: 2 }]
	}
}

/** The grade of an attempt a case grades: its child and n, scored apart. */
const gradeOf = (a: AttemptFact): GradeFact => ({ ...a, score: 10 * a.child + a.n })

/** The attempts the call records afresh: those it records that no stored attempt is, the delta it reads back. */
const addedOf = (c: CarriedCase): ReadonlyArray<AttemptFact> =>
	Arr.filter(
		recordedOf(c),
		(a) => !Arr.some(storedAttempts, (s) => s.child === a.child && s.n === a.n)
	)

/** The grades a case's call writes: child 2's stored first attempt, and, where it grades them and may, every attempt it
 * records afresh. */
const gradesOf = (c: CarriedCase): ReadonlyArray<GradeFact> => [
	gradeOf({ child: 2, n: 1 }),
	...(c.grades === "the recorded attempts too" && c.grading !== "in a stratum before"
		? Arr.map(addedOf(c), gradeOf)
		: [])
]

/** Whether the case's read-back reads state the attempts' statement or a later one writes, so it runs after the writes
 * over the delta carried there: a grade written after the attempts, in their stratum or a later one, or a status,
 * derived from Attempt, which that statement itself writes. */
export const carried = (c: CarriedCase): boolean =>
	c.grading !== "in a stratum before" || c.read !== "its grade"

/** A row of the read-back as the property compares it: its child, n, and the grade and status it reads, as text. */
const rowOf = (a: AttemptFact, score: number | undefined, status: number | undefined): string =>
	Arr.join(
		Arr.map(
			[
				a.child,
				a.n,
				...(score === undefined ? [] : [score]),
				...(status === undefined ? [] : [status])
			],
			String
		),
		" | "
	)

/** The read-back's query over the delta, the fields it delivers by name. */
const readOf =
	(b: Built, c: CarriedCase) =>
	(d: DeltaValue): QueryValue =>
		queryOver(b.schema).rule((r: RuleValue) => {
			const { child, n } = varsOver(Attempt, "written")
			const { score } = varsOver(Graded, "grade")
			const { status } = varsOver(b.Status, "status")
			const written = r.match(d.added(Attempt), { child, n })
			switch (c.read) {
				case "its grade":
					return written.match(Graded, { child, n, score }).find({ child, n, score })
				case "its status":
					return written.match(b.Status, { child, n, status }).find({ child, n, status })
				case "its grade and status":
					return written
						.match(Graded, { child, n, score })
						.match(b.Status, { child, n, status })
						.find({ child, n, score, status })
			}
		})

/** The case's ChangeSet: the attempts recorded and the grades written as its grading says, then `written` read back. */
export const changeOf = (b: Built, c: CarriedCase): ChangeSetValue => {
	const record = ChangeSet.empty(b.schema).insert(Attempt, recordedOf(c))
	const grade = ChangeSet.empty(b.schema).insert(Graded, gradesOf(c))
	const strata = (() => {
		switch (c.grading) {
			case "in a later stratum":
				return ChangeSet.sequence(record, grade)
			case "in the attempts' own stratum":
				return ChangeSet.union(record, grade)
			case "in a stratum before":
				return ChangeSet.sequence(grade, record)
		}
	})()
	return strata.read("written", readOf(b, c))
}

/**
 * The model: the attempts and grades after the whole call, the stored ones and those it writes, each attempt's status 1
 * where it has a grade and 0 where not; `written` reads each attempt the call recorded afresh, never one it met stored,
 * with its grade and its status as the whole call leaves them, a row only where each relation it reads holds one.
 */
export const modelOf = (c: CarriedCase): ReadonlyArray<string> => {
	const grades = [...storedGrades, ...gradesOf(c)]
	const gradeAt = (a: AttemptFact) =>
		Arr.findFirst(grades, (g) => g.child === a.child && g.n === a.n)
	return Arr.sort(
		Arr.flatMap(addedOf(c), (a): ReadonlyArray<string> => {
			const grade = Option.getOrUndefined(gradeAt(a))
			const status = grade === undefined ? 0 : 1
			switch (c.read) {
				case "its grade":
					return grade === undefined ? [] : [rowOf(a, grade.score, undefined)]
				case "its status":
					return [rowOf(a, undefined, status)]
				case "its grade and status":
					return grade === undefined ? [] : [rowOf(a, grade.score, status)]
			}
		}),
		Order.String
	)
}
