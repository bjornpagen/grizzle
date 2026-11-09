import { Effect } from "effect"
import { type Fixture, fill, settle } from "#bench/query/support/kit.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	derived,
	login,
	on,
	relation,
	role,
	schema,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import type { SqlError } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Student = relation("Student", { id: pg.integer, cohort: pg.integer }, ["id"])
const Sitting = relation(
	"Sitting",
	{
		id: pg.bigint,
		student: pg.integer,
		day: pg.integer,
		score: pg["double precision"],
		points: pg.integer,
		room: pg.integer
	},
	["id"]
)

const Price = relation(
	"Price",
	{ id: pg.bigint, student: pg.integer, day: pg.integer, amount: pg.bigint },
	["id"]
)

/**
 * The Lab fixture of the catalog and bounded-subset gates (R24, R26-R31, R41, R42), in public-API form: the
 * compositions of the language's worked examples, each an ordinary query of the language, which the compile-target
 * catalog's recognizers decide on.
 *
 * Sitting(id, student, day, score) is the ordered fact: ties on the day are broken by the key, and scores are dyadic
 * fractions, so every double-precision sum is exact and the composed and native forms deliver one spelling; its rooms
 * hold 100 sittings each, the last fewer, for the percentile counterexample. Price(id, student, day, amount) is the
 * as-of source. Student(id, cohort) is the parent relation every per-student take correlates to.
 * LabReports extends Lab with BestThree, the every-student take as a derived relation (R20's refresh-evaluated
 * definition).
 */
export const Lab = schema("Lab", { Student, Sitting, Price }, [
	contained(on(Sitting, "student"), on(Student, "id")),
	contained(on(Price, "student"), on(Student, "id"))
])

const f8 = (x: number) => Compute.literal(pg["double precision"], x)

/**
 * R26 and R41: each sitting's ordinal within its student by (day, id), its running total of scores and its running
 * conditional count of scores above 3.
 */
export const runningPerStudent = query(Lab).rule((r) => {
	const { id, student, day } = v(Sitting, "sitting")
	const t = v(Sitting, "earlier")
	return r
		.match(Sitting, { id, student, day })
		.match(Sitting, { id: t.id, student, day: t.day, score: t.score })
		.where(r.or(r.lt(t.day, day), r.and(r.eq(t.day, day), r.le(t.id, id))))
		.find({
			student,
			id,
			ordinal: r.count(),
			total: r.sum(t.score),
			top: r.max(t.score),
			above: r.sum(Compute.cond(Compute.gt(t.score, f8(3)), Compute.literal(pg.integer, 1), 0))
		})
})

/** R26 without R41: the ordinal alone. */
export const ordinalPerStudent = query(Lab).rule((r) => {
	const { id, student, day } = v(Sitting, "sitting")
	const t = v(Sitting, "earlier")
	return r
		.match(Sitting, { id, student, day })
		.match(Sitting, { id: t.id, student, day: t.day })
		.where(r.or(r.lt(t.day, day), r.and(r.eq(t.day, day), r.le(t.id, id))))
		.find({ student, id, ordinal: r.count() })
})

/**
 * R41's refusal: a running maximum over the qualifying rows only makes the group possibly empty, so it keeps the
 * composed self-join.
 */
export const runningQualified = query(Lab).rule((r) => {
	const { id, student, day } = v(Sitting, "sitting")
	const t = v(Sitting, "earlier")
	return r
		.match(Sitting, { id, student, day })
		.match(Sitting, { id: t.id, student, day: t.day, score: t.score })
		.where(r.or(r.lt(t.day, day), r.and(r.eq(t.day, day), r.le(t.id, id))), r.gt(t.score, f8(3)))
		.find({ student, id, top: r.max(t.score) })
})

/** R24: per student, a conditional count, a conditional sum of scores and a bigint conditional count. */
export const conditionalPerStudent = (threshold: number) =>
	query(Lab).rule((r) => {
		const { id, student, score } = v(Sitting, "sitting")
		return r.match(Sitting, { id, student, score }).find({
			student,
			passed: r.sum(
				Compute.cond(Compute.gt(score, f8(threshold)), Compute.literal(pg.integer, 1), 0)
			),
			points: r.sum(Compute.cond(Compute.gt(score, f8(threshold)), score, f8(0)))
		})
	})

/** R28: each student's count beside the total count. */
const perStudent = query(Lab).rule((r) => {
	const { id, student } = v(Sitting, "sitting")
	return r.match(Sitting, { id, student }).find({ student, n: r.count() })
})

const total = query(Lab).rule((r) => {
	const { id } = v(Sitting, "sitting")
	return r.match(Sitting, { id }).find({ n: r.count() })
})

export const groupedShare = query(Lab).rule((r) => {
	const { student, n } = v(perStudent, "perStudent")
	const { n: all } = v(total, "total")
	return r.match(perStudent, { student, n }).match(total, { n: all }).find({ student, n, all })
})

/** R28: each sitting with its student's count. */
export const keyedShare = query(Lab).rule((r) => {
	const { id, student, day } = v(Sitting, "sitting")
	const { n } = v(perStudent, "perStudent")
	return r
		.match(Sitting, { id, student, day })
		.match(perStudent, { student, n })
		.find({ id, student, day, n })
})

/** The ordinal of each sitting by score within its student, ties broken by id: the ordinal stage of a percentile. */
const scoreOrdinals = query(Lab).rule((r) => {
	const { id, student, score } = v(Sitting, "sitting")
	const t = v(Sitting, "lower")
	return r
		.match(Sitting, { id, student, score })
		.match(Sitting, { id: t.id, student, score: t.score })
		.where(r.or(r.lt(t.score, score), r.and(r.eq(t.score, score), r.le(t.id, id))))
		.find({ student, id, score, ord: r.count() })
})

/** R29: the scores at ordinal ceil(p · n) of each student, for p = 1/2 and 1/4, dyadic fractions. */
export const discretePercentiles = query(Lab).rule((r) => {
	const { student, n } = v(perStudent, "perStudent")
	const half = v(scoreOrdinals, "half")
	const quarter = v(scoreOrdinals, "quarter")
	const at = (p: number) =>
		Compute.ceil(Compute.numeric(Compute.mul(f8(p), Compute.cast(n, pg["double precision"]))))
	return r
		.match(perStudent, { student, n })
		.match(scoreOrdinals, { student, score: half.score, ord: half.ord })
		.match(scoreOrdinals, { student, score: quarter.score, ord: quarter.ord })
		.where(r.eq(Compute.numeric(half.ord), at(0.5)), r.eq(Compute.numeric(quarter.ord), at(0.25)))
		.find({ student, median: half.score, lowerQuartile: quarter.score })
})

/**
 * R29's counterexamples: the score at ordinal ceil(p · n) by (score, id) per room of 100 sittings, for a fraction that
 * is not dyadic (0.07 · 100 is 7.000000000000001 in double precision, where the composition's numeric ceil takes the
 * seventh value and the native aggregate the eighth) and for p = 0 (ceil(0) selects no ordinal, while the native
 * aggregate returns the first value). Neither admits the rewrite.
 */
const perRoom = query(Lab).rule((r) => {
	const { id, room } = v(Sitting, "sitting")
	return r.match(Sitting, { id, room }).find({ room, n: r.count() })
})

const roomOrdinals = query(Lab).rule((r) => {
	const { id, room, score } = v(Sitting, "sitting")
	const t = v(Sitting, "lower")
	return r
		.match(Sitting, { id, room, score })
		.match(Sitting, { id: t.id, room, score: t.score })
		.where(r.or(r.lt(t.score, score), r.and(r.eq(t.score, score), r.le(t.id, id))))
		.find({ room, id, score, ord: r.count() })
})

export const roomPercentile = (p: number) =>
	query(Lab).rule((r) => {
		const { room, n } = v(perRoom, "perRoom")
		const o = v(roomOrdinals, "roomOrdinals")
		const at = Compute.ceil(
			Compute.numeric(Compute.mul(f8(p), Compute.cast(n, pg["double precision"])))
		)
		return r
			.match(perRoom, { room, n })
			.match(roomOrdinals, { room, score: o.score, ord: o.ord })
			.where(r.eq(Compute.numeric(o.ord), at))
			.find({ room, value: o.score })
	})

/** R30: the median interpolated between the ordinals floor(1 + (n - 1)/2) and ceil(1 + (n - 1)/2). */
export const continuousMedian = query(Lab).rule((r) => {
	const { student, n } = v(perStudent, "perStudent")
	const a = v(scoreOrdinals, "floor")
	const b = v(scoreOrdinals, "ceil")
	const h = Compute.mul(f8(0.5), Compute.cast(Compute.sub(n, 1n), pg["double precision"]))
	const position = (fn: "floor" | "ceil") =>
		fn === "floor"
			? Compute.floor(Compute.numeric(Compute.add(f8(1), h)))
			: Compute.ceil(Compute.numeric(Compute.add(f8(1), h)))
	const frac = Compute.sub(
		h,
		Compute.cast(Compute.floor(Compute.numeric(h)), pg["double precision"])
	)
	return r
		.match(perStudent, { student, n })
		.match(scoreOrdinals, { student, score: a.score, ord: a.ord })
		.match(scoreOrdinals, { student, score: b.score, ord: b.ord })
		.where(
			r.eq(Compute.numeric(a.ord), position("floor")),
			r.eq(Compute.numeric(b.ord), position("ceil"))
		)
		.find({
			student,
			median: Compute.add(a.score, Compute.mul(frac, Compute.sub(b.score, a.score)))
		})
})

/** R31: the most frequent day of each student's sittings, ties to the earliest day. */
const dayCounts = query(Lab)
	.rule((r) => {
		const { id, day } = v(Sitting, "sitting")
		return r
			.match(Sitting, { id, student: r.param("student", Sitting.fields.student), day })
			.find({ day, n: r.count() })
	})
	.orderBy(["n", "desc"], ["day", "asc"])
	.take(1)

export const modalDay = query(Lab).rule((r) => {
	const { id: student } = v(Student, "student")
	const top = dayCounts.bind({ student })
	const { day } = v(top, "top")
	return r.match(Student, { id: student }).match(top, { day }).find({ student, mode: day })
})

/** R31 over every sitting, uncorrelated: the most frequent day overall. */
const allDayCounts = query(Lab)
	.rule((r) => {
		const { id, day } = v(Sitting, "sitting")
		return r.match(Sitting, { id, day }).find({ day, n: r.count() })
	})
	.orderBy(["n", "desc"], ["day", "asc"])
	.take(1)

export const modeOfDays = query(Lab).rule((r) => {
	const { day } = v(allDayCounts, "allDayCounts")
	return r.match(allDayCounts, { day }).find({ mode: day })
})

/** R27: every sitting with its student's next sitting by (day, id), bound. */
const nextSitting = query(Lab)
	.rule((r) => {
		const n = v(Sitting, "sitting")
		return r
			.match(Sitting, {
				id: n.id,
				student: r.param("st", Sitting.fields.student),
				day: n.day,
				score: n.score
			})
			.where(
				r.or(
					r.gt(n.day, r.param("d", pg.integer)),
					r.and(r.eq(n.day, r.param("d", pg.integer)), r.gt(n.id, r.param("i", pg.bigint)))
				)
			)
			.find({ nid: n.id, nday: n.day, nscore: n.score })
	})
	.orderBy(["nday", "asc"], ["nid", "asc"])
	.take(1)

export const withNext = query(Lab).rule((r) => {
	const { id, student, day } = v(Sitting, "sitting")
	const next = nextSitting.bind({ st: student, d: day, i: id })
	const { nid, nscore } = v(next, "next")
	return r
		.match(Sitting, { id, student, day })
		.match(next, { nid, nscore })
		.find({ id, nid, nscore })
})

/** R42: every sitting with its student's latest price at or before its day. */
const latestPrice = query(Lab)
	.rule((r) => {
		const p = v(Price, "price")
		return r
			.match(Price, {
				id: p.id,
				student: r.param("st", Price.fields.student),
				day: p.day,
				amount: p.amount
			})
			.where(r.le(p.day, r.param("d", pg.integer)))
			.find({ pid: p.id, pday: p.day, amount: p.amount })
	})
	.orderBy(["pday", "desc"], ["pid", "desc"])
	.take(1)

export const withPrice = query(Lab).rule((r) => {
	const { id, student, day } = v(Sitting, "sitting")
	const price = latestPrice.bind({ st: student, d: day })
	const { pid, amount } = v(price, "price")
	return r
		.match(Sitting, { id, student, day })
		.match(price, { pid, amount })
		.find({ id, pid, amount })
})

/** R42's mirror: every sitting with its student's earliest price at or after its day. */
const earliestPrice = query(Lab)
	.rule((r) => {
		const p = v(Price, "price")
		return r
			.match(Price, {
				id: p.id,
				student: r.param("st", Price.fields.student),
				day: p.day,
				amount: p.amount
			})
			.where(r.ge(p.day, r.param("d", pg.integer)))
			.find({ pid: p.id, pday: p.day, amount: p.amount })
	})
	.orderBy(["pday", "asc"], ["pid", "asc"])
	.take(1)

export const withNextPrice = query(Lab).rule((r) => {
	const { id, student, day } = v(Sitting, "sitting")
	const price = earliestPrice.bind({ st: student, d: day })
	const { pid, amount } = v(price, "price")
	return r
		.match(Sitting, { id, student, day })
		.match(price, { pid, amount })
		.find({ id, pid, amount })
})

/** R42 for a bound parent set: the sittings of the students a relation parameter names, with their as-of price. */
export const withPriceFor = query(Lab).rule((r) => {
	const wanted = r.relation("students", { id: pg.integer })
	const { id: student } = v(wanted, "wanted")
	const { id, day } = v(Sitting, "sitting")
	const price = latestPrice.bind({ st: student, d: day })
	const { pid, amount } = v(price, "price")
	return r
		.match(wanted, { id: student })
		.match(Sitting, { id, student, day })
		.match(price, { pid, amount })
		.find({ id, pid, amount })
})

/** R20: the three best-scored sittings per student, over every student and for a relation parameter's students. */
const bestThree = query(Lab)
	.rule((r) => {
		const { id, score } = v(Sitting, "sitting")
		return r
			.match(Sitting, { id, student: r.param("st", Sitting.fields.student), score })
			.find({ id, score })
	})
	.orderBy(["score", "desc"], ["id", "asc"])
	.take(3)

export const bestPerStudent = query(Lab).rule((r) => {
	const { id: student } = v(Student, "student")
	const top = bestThree.bind({ st: student })
	const { id, score } = v(top, "top")
	return r.match(Student, { id: student }).match(top, { id, score }).find({ student, id, score })
})

export const bestForStudents = query(Lab).rule((r) => {
	const wanted = r.relation("students", { id: pg.integer })
	const { id: student } = v(wanted, "wanted")
	const top = bestThree.bind({ st: student })
	const { id, score } = v(top, "top")
	return r.match(wanted, { id: student }).match(top, { id, score }).find({ student, id, score })
})

/** R20, k = 1: each student's best sitting. */
const bestOne = query(Lab)
	.rule((r) => {
		const { id, score } = v(Sitting, "sitting")
		return r
			.match(Sitting, { id, student: r.param("st", Sitting.fields.student), score })
			.find({ id, score })
	})
	.orderBy(["score", "desc"], ["id", "asc"])
	.take(1)

export const topPerStudent = query(Lab).rule((r) => {
	const { id: student } = v(Student, "student")
	const top = bestOne.bind({ st: student })
	const { id, score } = v(top, "top")
	return r.match(Student, { id: student }).match(top, { id, score }).find({ student, id, score })
})

/** R20 through an attachment: each cohort's students with their three best sittings attached. */
const cohortCards = query(Lab)
	.rule((r) => {
		const { id, cohort } = v(Student, "student")
		return r
			.match(Student, { id, cohort })
			.where(r.eq(cohort, r.param("cohort", pg.integer)))
			.find({ id })
	})
	.attach(
		"best",
		(s) =>
			query(Lab)
				.rule((r) => {
					const { id, score } = v(Sitting, "sitting")
					return r.match(Sitting, { id, student: s.id, score }).find({ id, score })
				})
				.orderBy(["score", "desc"], ["id", "asc"])
				.take(3),
		"array"
	)

/**
 * R20 through a pipelined attachment: students with their three best sittings attached, five array fields, over exact
 * parents, so the child is its own statement, which computes its parents' rows itself in the same flight. A
 * pipelined attachment's form is fixed by its parent rows' bound: the parents of a key lookup are bounded at one row,
 * so studentSheetOne's take is the LATERAL form, and a parent statement with no bound, studentSheets', is read for
 * every group. A take chooses its form per execution only by a relation parameter's distinct count or a page's size.
 */
export const studentSheets = query(Lab)
	.rule((r) => {
		const { id } = v(Student, "student")
		return r
			.match(Student, { id })
			.where(r.le(id, r.param("upto", pg.integer)))
			.find({ id })
	})
	.attach(
		"best",
		(s) =>
			query(Lab)
				.rule((r) => {
					const { id, day, score, points, room } = v(Sitting, "sitting")
					return r
						.match(Sitting, { id, student: s.id, day, score, points, room })
						.find({ id, day, score, points, room })
				})
				.orderBy(["score", "desc"], ["id", "asc"])
				.take(3),
		"array"
	)

export const studentSheetOne = query(Lab)
	.rule((r) => {
		const { id } = v(Student, "student")
		return r
			.match(Student, { id })
			.where(r.eq(id, r.param("id", pg.integer)))
			.find({ id })
	})
	.attach(
		"best",
		(s) =>
			query(Lab)
				.rule((r) => {
					const { id, day, score, points, room } = v(Sitting, "sitting")
					return r
						.match(Sitting, { id, student: s.id, day, score, points, room })
						.find({ id, day, score, points, room })
				})
				.orderBy(["score", "desc"], ["id", "asc"])
				.take(3),
		"array"
	)

/**
 * R08: per cohort, the number of sittings and the sum of their points: the sitting's key is bound, so every sitting
 * contributes.
 */
export const pointsPerCohort = query(Lab).rule((r) => {
	const { id: student, cohort } = v(Student, "student")
	const { id, points } = v(Sitting, "sitting")
	return r
		.match(Student, { id: student, cohort })
		.match(Sitting, { id, student, points })
		.find({ cohort, sittings: r.count(), points: r.sum(points) })
})

/**
 * R08's counterexample: the sum of each cohort's distinct (student, points) values, so equal values of one student
 * contribute once. A fold reads each fact it matches once, by its key, so the distinct values are a stage of their own,
 * a set keyed by its heading, matched whole.
 */
export const distinctPointsPerCohort = query(Lab).rule((r) => {
	const values = r.interior((inner) => {
		const { id: student, cohort } = v(Student, "student")
		const { points } = v(Sitting, "sitting")
		return inner
			.match(Student, { id: student, cohort })
			.match(Sitting, { student, points })
			.find({ cohort, student, points })
	})
	const { cohort, student, points } = v(values, "value")
	return r.match(values, { cohort, student, points }).find({ cohort, points: r.sum(points) })
})

/**
 * R20's refresh-evaluated definition: the every-student take(3) as a derived relation. "A derived-relation definition
 * always wants every group, so it never takes the correlated form".
 */
export const BestThree = derived.materialized("BestThree", bestPerStudent)
export const LabReports = schema.extend(Lab, "LabReports", { BestThree }, [])
/** The refresher: a full role over LabReports refreshing BestThree, in a login of its own. */
export const labRefresher = role(LabReports, "refresher", wholeEntriesOf(LabReports), {
	refresh: ["BestThree"]
})
export const labRefreshers = login(LabReports, "refreshers", [labRefresher])
/** The refreshed relation read back. */
export const bestThreeRows = query(LabReports).rule((r) => {
	const { student, id, score } = v(BestThree, "bestThree")
	return r.match(BestThree, { student, id, score }).find({ student, id, score })
})

export const labPrograms = {
	runningPerStudent,
	ordinalPerStudent,
	runningQualified,
	conditionalPerStudent: conditionalPerStudent(3),
	groupedShare,
	keyedShare,
	discretePercentiles,
	continuousMedian,
	modalDay,
	modeOfDays,
	withNext,
	withPrice,
	withPriceFor,
	bestPerStudent,
	bestForStudents,
	topPerStudent,
	cohortCards,
	studentSheets,
	studentSheetOne,
	pointsPerCohort,
	distinctPointsPerCohort
} as const

interface LabSize {
	readonly students: number
	readonly perStudent: number
}

export const labSittings = (size: LabSize): number => (size.students - 1) * size.perStudent + 1
export const labPrices = (size: LabSize): number =>
	size.students * 6 - Math.floor(size.students / 7) * 6

/**
 * Deterministic facts: `students` students in ten cohorts, each with `perStudent` sittings on days that repeat (so the
 * day ties are broken by the key) and dyadic scores from a small set (so scores tie too); student 1 has a single
 * sitting; two prices on each of days 2, 5 and 8 for every student but those whose id is divisible by 7, which have
 * none (so prices tie on the day, sittings fall before, on and after them, and some parents have no as-of row).
 */
export const loadLab = Effect.fn("loadLab")(function* <S>(
	fixture: Fixture<S>,
	size: LabSize
): Effect.fn.Return<void, SqlError, Substrate> {
	const s = yield* Substrate
	const { students, perStudent: sittingsEach } = size
	yield* fill(fixture, "Student", students, { id: "g::int4", cohort: "(g % 10)::int4" })
	yield* fill(fixture, "Sitting", labSittings(size), {
		id: "g::int8",
		student: `(CASE WHEN g = 1 THEN 1 ELSE 2 + (g - 2) / ${sittingsEach} END)::int4`,
		day: `(1 + ((g * 7) % ${Math.max(2, Math.floor(sittingsEach / 2))}))::int4`,
		score: "(((pg_catalog.hashint8(g) & 2147483647) % 33)::float8 / 4::float8)",
		points: "((pg_catalog.hashint8(g + 1) & 2147483647) % 100)::int4",
		room: "(1 + (g - 1) / 100)::int4"
	})
	yield* fill(fixture, "Price", students * 6, {
		id: "g::int8",
		student: `(1 + (g - 1) % ${students})::int4`,
		day: `(2 + 3 * ((g - 1) / ${2 * students}))::int4`,
		amount: "(100 + (pg_catalog.hashint8(g) & 2147483647) % 900)::int8"
	})
	yield* s.admin.query(
		`DELETE FROM ${fixture.table("Price")} WHERE ${fixture.column("Price", "student")} % 7 = 0`,
		[]
	)
	yield* settle(fixture)
})

export const labData = (size: LabSize): string =>
	`${size.students} students in 10 cohorts; ${labSittings(size)} sittings (${size.perStudent} per student, student 1 a single one) with repeating days and dyadic scores; ${labPrices(size)} prices, two on each of days 2, 5 and 8 per student, none for every seventh student; rooms of 100 sittings`
