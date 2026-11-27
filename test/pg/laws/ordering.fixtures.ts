/** What the property of ordering.test.ts reads: its schema and template, its cases and aims, and its judge. */
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Effect, Equivalence, Formatter, Option, Order, Result } from "effect"
import { rowEvaluator } from "#adapter/public/host.ts"
import { constraintNamesOf } from "#compiler/program/laws.ts"
import { Range } from "#compiler/public/compute.ts"
import { contract, mintOf, pg, span } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, derived, relation, schema } from "#compiler/public/schema.ts"
import {
	type Seat,
	type SeatCase,
	type SeatTemplate,
	seatIn,
	seatTemplate
} from "#test/pg/fin/installed.ts"
import { succeeded } from "#test/support/assert.ts"
import { asDataStep } from "#test/support/data-step.ts"
import type { PgErrorFields } from "#test/support/pg.ts"
import { firstRefusalOf, refusalOf } from "#test/support/substrate.ts"

const secondsKey = Symbol("Seconds")
/** A point of a sitting's timeline, whole seconds. */
const Seconds = contract<typeof secondsKey>()("Seconds", pg.bigint)
const toSeconds = mintOf(secondsKey)

/** A sitting's start, at most one. */
const Began = relation("Began", { sitting: pg.integer, at: Seconds }, ["sitting"])

/** A sitting's end, at most one, none while it is open. */
const EndedAt = relation("EndedAt", { sitting: pg.integer, at: Seconds }, ["sitting"])

/** A sitting's closed visits, no two of one sitting overlapping. */
const Visit = relation("Visit", { sitting: pg.integer, during: span(Seconds) }, [
	"sitting",
	"during"
])

const RELATIONS = ["Began", "EndedAt", "Visit"] as const
type Table = (typeof RELATIONS)[number]

/** The checks, by name: a visit at or after its sitting's start, and at or before its end. */
const CHECKS = ["VisitAfterStart", "VisitBeforeEnd"] as const
type CheckName = (typeof CHECKS)[number]

/**
 * The schema under `name`: Began, EndedAt and Visit stored, the visits immutable, so the judge reads each sitting a
 * transaction wrote whole, and over them, a level above, the joins AfterStart (each visit beside its sitting's start)
 * and BeforeEnd (each visit beside its sitting's end), each with its row check: the visit's lower end at or after the
 * start, its upper end at or before the end. A sitting with no end has no fact of BeforeEnd, so its end bound asks
 * nothing of it: an open sitting is the absence of its end.
 */
const orderingOf = (name: string) => {
	const Base = schema(name, [Began, EndedAt, Visit], [])
	const AfterStart = derived(
		"AfterStart",
		query(Base).rule((r) => {
			const { sitting, during } = v(Visit, "visit")
			const { at } = v(Began, "began")
			return r
				.match(Visit, { sitting, during })
				.match(Began, { sitting, at })
				.find({ sitting, during, at })
		})
	)
	const BeforeEnd = derived(
		"BeforeEnd",
		query(Base).rule((r) => {
			const { sitting, during } = v(Visit, "visit")
			const { at } = v(EndedAt, "ended")
			return r
				.match(Visit, { sitting, during })
				.match(EndedAt, { sitting, at })
				.find({ sitting, during, at })
		})
	)
	const Ordered = schema.extend(
		[Base],
		`${name}_1`,
		[AfterStart, BeforeEnd],
		[
			check("VisitAfterStart", AfterStart, (s) => s.ge(Range.lower(s.during, Seconds), s.at)),
			check("VisitBeforeEnd", BeforeEnd, (s) => s.le(Range.upper(s.during, Seconds), s.at))
		]
	)
	return { Ordered, AfterStart, BeforeEnd }
}

/** The schema installed once per member, under the name its seat is read by. */
export const orderingTemplate: SeatTemplate = seatTemplate(
	import.meta,
	orderingOf("Order_in").Ordered,
	"ordering_in"
)

/** A visit of a sitting, its span [start, end). */
interface VisitSpan {
	readonly start: number
	readonly end: number
}

/** The facts the host holds: each sitting's start and end, where it has one, and its visits. */
interface State {
	readonly began: ReadonlyMap<number, number>
	readonly ended: ReadonlyMap<number, number>
	readonly visits: ReadonlyArray<{ readonly sitting: number; readonly during: VisitSpan }>
}

const emptyState: State = { began: new Map(), ended: new Map(), visits: [] }

/** One write of a transaction, as drawn: the visit an `unvisit` names is its sitting's visits' `pick`-th. */
export type Op =
	| { readonly kind: "begin" | "end"; readonly sitting: number; readonly at: number }
	| { readonly kind: "unbegin" | "unend"; readonly sitting: number }
	| {
			readonly kind: "visit"
			readonly sitting: number
			readonly start: number
			readonly length: number
	  }
	| { readonly kind: "unvisit"; readonly sitting: number; readonly pick: number }

/** A history: transactions of a few writes each. */
export interface Case {
	readonly history: ReadonlyArray<ReadonlyArray<Op>>
}

const sittingGen = int(1, 2)
const pointGen = int(0, 8)
const lengthGen = int(1, 3)

const pointOpGen: Gen<Op> = (s) => ({
	kind: s.draw(element(["begin", "end"] as const)),
	sitting: s.draw(sittingGen),
	at: s.draw(pointGen)
})

const unpointOpGen: Gen<Op> = (s) => ({
	kind: s.draw(element(["unbegin", "unend"] as const)),
	sitting: s.draw(sittingGen)
})

const visitOpGen: Gen<Op> = (s) => ({
	kind: "visit",
	sitting: s.draw(sittingGen),
	start: s.draw(pointGen),
	length: s.draw(lengthGen)
})

const unvisitOpGen: Gen<Op> = (s) => ({
	kind: "unvisit",
	sitting: s.draw(sittingGen),
	pick: s.draw(int(0, 2))
})

/** A write of a history: a point, a visit, or a deletion of either. */
const opGen: Gen<Op> = weighted<Op>([
	[5, pointOpGen],
	[1, unpointOpGen],
	[4, visitOpGen],
	[1, unvisitOpGen]
])

/** A case: a history drawn. */
export const caseGen: Gen<Case> = (s) => ({
	history: s.draw(array(array(opGen, { min: 1, max: 3 }), { min: 2, max: 8 }))
})

export type Feature =
	| "committed"
	| "an open sitting's visit committed"
	| "refused before its start"
	| "refused past its end"
	| "a start written after its visits refused"
	| "an end written before a visit's end refused"
	| "committed at a bound"

/** Each situation the search must reach that a drawn history reaches rarely, with the case constructed to reach it. */
export const aims: ReadonlyArray<readonly [Feature, Gen<Case>]> = [
	[
		"a start written after its visits refused",
		(s) => {
			const sitting = s.draw(sittingGen)
			const start = s.draw(int(0, 4))
			return {
				history: [
					[{ kind: "visit", sitting, start, length: s.draw(lengthGen) }],
					[{ kind: "begin", sitting, at: start + s.draw(int(1, 3)) }]
				]
			}
		}
	],
	[
		"an end written before a visit's end refused",
		(s) => {
			const sitting = s.draw(sittingGen)
			const start = s.draw(int(1, 4))
			const length = s.draw(int(2, 3))
			return {
				history: [
					[
						{ kind: "begin", sitting, at: start - 1 },
						{ kind: "visit", sitting, start, length }
					],
					[{ kind: "end", sitting, at: start + length - 1 }]
				]
			}
		}
	],
	[
		"an open sitting's visit committed",
		(s) => {
			const sitting = s.draw(sittingGen)
			const at = s.draw(int(0, 4))
			return {
				history: [
					[
						{ kind: "begin", sitting, at },
						{ kind: "visit", sitting, start: at + 1, length: s.draw(lengthGen) }
					]
				]
			}
		}
	],
	[
		"committed at a bound",
		(s) => {
			const sitting = s.draw(sittingGen)
			const at = s.draw(int(0, 4))
			const length = s.draw(lengthGen)
			return {
				history: [
					[
						{ kind: "begin", sitting, at },
						{ kind: "visit", sitting, start: at, length },
						{ kind: "end", sitting, at: at + length }
					]
				]
			}
		}
	]
]

/** The situations the search must reach. */
export const required: NonEmptyReadonlyArray<Feature> = [
	"committed",
	"an open sitting's visit committed",
	"refused before its start",
	"refused past its end",
	"a start written after its visits refused",
	"an end written before a visit's end refused",
	"committed at a bound"
]

/** Whether two spans of one sitting share a point. */
const overlaps = (a: VisitSpan, b: VisitSpan): boolean => a.start < b.end && b.start < a.end

/** The visits of `sitting` in `s`, in the order they were written. */
const visitsOf = (s: State, sitting: number) => Arr.filter(s.visits, (v) => v.sitting === sitting)

/**
 * A write resolved against the state it meets: its statements, the state it leaves, and whether it removes a fact, which
 * a closed relation loses only in a data step; none for a write it makes moot.
 */
interface Resolved {
	readonly statements: ReadonlyArray<string>
	readonly next: State
	readonly removes: boolean
}

/** `op` resolved against `s` on `seat`: an insert of a fact the state holds at its key, an overlap, or a delete of none is moot. */
const resolve = (seat: Seat, s: State, op: Op): Resolved | undefined => {
	const t = (r: Table) => seat.table(r)
	const c = (r: Table, f: string) => seat.column(r, f)
	const range = (d: VisitSpan) => `int8range(${d.start}, ${d.end})`
	const point = (r: "Began" | "EndedAt", kind: "began" | "ended", sitting: number, at: number) =>
		s[kind].has(sitting)
			? undefined
			: {
					statements: [
						`INSERT INTO ${t(r)} (${c(r, "sitting")}, ${c(r, "at")}) VALUES (${sitting}, ${at})`
					],
					next: { ...s, [kind]: new Map([...s[kind], [sitting, at]]) },
					removes: false
				}
	const unpoint = (r: "Began" | "EndedAt", kind: "began" | "ended", sitting: number) => {
		if (!s[kind].has(sitting)) {
			return undefined
		}
		const rest = new Map(s[kind])
		rest.delete(sitting)
		return {
			statements: [`DELETE FROM ${t(r)} WHERE ${c(r, "sitting")} = ${sitting}`],
			next: { ...s, [kind]: rest },
			removes: true
		}
	}
	switch (op.kind) {
		case "begin":
			return point("Began", "began", op.sitting, op.at)
		case "end":
			return point("EndedAt", "ended", op.sitting, op.at)
		case "unbegin":
			return unpoint("Began", "began", op.sitting)
		case "unend":
			return unpoint("EndedAt", "ended", op.sitting)
		case "visit": {
			const during = { start: op.start, end: op.start + op.length }
			if (Arr.some(visitsOf(s, op.sitting), (v) => overlaps(v.during, during))) {
				return undefined
			}
			return {
				statements: [
					`INSERT INTO ${t("Visit")} (${c("Visit", "sitting")}, ${c("Visit", "during")}) VALUES (${op.sitting}, ${range(during)})`
				],
				next: { ...s, visits: [...s.visits, { sitting: op.sitting, during }] },
				removes: false
			}
		}
		case "unvisit": {
			const mine = visitsOf(s, op.sitting)
			const gone = mine[op.pick % Math.max(mine.length, 1)]
			if (gone === undefined) {
				return undefined
			}
			return {
				statements: [
					`DELETE FROM ${t("Visit")} WHERE ${c("Visit", "sitting")} = ${op.sitting} AND ${c("Visit", "during")} = ${range(gone.during)}`
				],
				next: { ...s, visits: Arr.filter(s.visits, (v) => v !== gone) },
				removes: true
			}
		}
	}
}

/** A fact of AfterStart or BeforeEnd: a visit and the point beside it, and whether its check holds of it. */
interface Joined {
	readonly sitting: number
	readonly during: VisitSpan
	readonly at: number
}

const joinedText = (j: Joined): string =>
	`${j.sitting} [${j.during.start}, ${j.during.end}) ${j.at}`

/** The facts of each check's derived relation in `s`, the host's restatement of each definition. */
const factsOf = (s: State): { readonly [C in CheckName]: ReadonlyArray<Joined> } => {
	const beside = (points: ReadonlyMap<number, number>) =>
		Arr.flatMap(s.visits, (v) => {
			const at = points.get(v.sitting)
			return at === undefined ? [] : [{ sitting: v.sitting, during: v.during, at }]
		})
	return { VisitAfterStart: beside(s.began), VisitBeforeEnd: beside(s.ended) }
}

/** The ordering restated: a visit's lower end at or after the start and its upper end at or before the end. */
const holds = (check: CheckName, j: Joined): boolean => {
	switch (check) {
		case "VisitAfterStart":
			return j.during.start >= j.at
		case "VisitBeforeEnd":
			return j.during.end <= j.at
	}
}

/** The checks `s` breaks, each at some fact of its relation. */
const brokenOf = (s: State): ReadonlyArray<CheckName> => {
	const facts = factsOf(s)
	return Arr.filter(CHECKS, (check) => Arr.some(facts[check], (j) => !holds(check, j)))
}

/** Whether a fact of `s` meets its point exactly: a visit starting at its start or ending at its end. */
const atBound = (s: State): boolean => {
	const facts = factsOf(s)
	return Arr.some(CHECKS, (check) =>
		Arr.some(
			facts[check],
			(j) => (check === "VisitAfterStart" ? j.during.start : j.during.end) === j.at
		)
	)
}

/** Two lists of texts that hold the same texts in the same order. */
const sameTexts = Arr.makeEquivalence(Equivalence.String)

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** The integer in a cell PostgreSQL answers as text. */
const intOf = (cell: unknown): number =>
	typeof cell === "string" ? Number(cell) : assert.fail(`a cell of text, not ${String(cell)}`)

/**
 * A history on its seat: each transaction's writes resolved against the host's state, then each derived row
 * read from the tables as they stand mid-transaction and judged by the host (rowEvaluator, the one evaluation grizzle
 * judges a refused write's rows by), which must hold exactly the restated facts and verdicts; then SET CONSTRAINTS ALL
 * IMMEDIATE runs the judge, which refuses exactly when the restatement finds a check broken, by 23514 naming one of the
 * broken checks' names, and the transaction commits otherwise.
 */
export const judgeHistory = (taken: SeatCase, c: Case, note: (f: Feature) => void) =>
	Effect.gen(function* () {
		const seat = yield* seatIn(taken, RELATIONS, "ordering_inclusive")
		const { Ordered, AfterStart, BeforeEnd } = orderingOf("Order_host")
		const evaluate = succeeded(rowEvaluator(Ordered), "the schema compiles")
		const nameOf = constraintNamesOf(Ordered)
		const derivedOf = { VisitAfterStart: AfterStart, VisitBeforeEnd: BeforeEnd } as const
		const pointOf = { VisitAfterStart: "Began", VisitBeforeEnd: "EndedAt" } as const
		const session = seat.session
		let state = emptyState
		for (const [at, ops] of c.history.entries()) {
			const where = `transaction ${at} of ${Formatter.format(c)}`
			let next = state
			const statements: Array<string> = []
			let removes = false
			for (const op of ops) {
				const resolved = resolve(seat, next, op)
				if (resolved === undefined) {
					continue
				}
				for (const sql of resolved.statements) {
					statements.push(sql)
				}
				next = resolved.next
				removes = removes || resolved.removes
			}
			if (statements.length === 0) {
				continue
			}
			yield* session.begin
			/** A refusal of the transaction's data step at its bracket, which runs the judge and the installation's re-check
			 * after the step's statements (test/support/data-step.ts asDataStep), as a migration's runner does: the
			 * transaction's refusal, as SET CONSTRAINTS ALL IMMEDIATE's is otherwise. */
			let bracketed: Option.Option<PgErrorFields> = Option.none()
			if (removes) {
				bracketed = yield* firstRefusalOf(
					asDataStep(seat.installed.installation, statements),
					(sql) => session.query(sql, [])
				)
			} else {
				for (const sql of statements) {
					yield* Effect.onError(session.query(sql, []), () => Effect.ignore(session.rollback))
				}
			}
			if (Option.isNone(bracketed)) {
				const restated = factsOf(next)
				for (const check of CHECKS) {
					const point = pointOf[check]
					const rows = yield* Effect.onError(
						session.values(
							`SELECT v.${seat.column("Visit", "sitting")}::text, lower(v.${seat.column("Visit", "during")})::text, upper(v.${seat.column("Visit", "during")})::text, p.${seat.column(point, "at")}::text FROM ${seat.table("Visit")} v JOIN ${seat.table(point)} p ON p.${seat.column(point, "sitting")} = v.${seat.column("Visit", "sitting")}`,
							[]
						),
						() => Effect.ignore(session.rollback)
					)
					const read = Arr.map(rows, (r) => ({
						sitting: intOf(r[0]),
						during: { start: intOf(r[1]), end: intOf(r[2]) },
						at: intOf(r[3])
					}))
					const judged = (j: Joined): string => {
						const admitted = succeeded(
							evaluate.admit(derivedOf[check], {
								sitting: j.sitting,
								during: {
									start: toSeconds(BigInt(j.during.start)),
									end: toSeconds(BigInt(j.during.end))
								},
								at: toSeconds(BigInt(j.at))
							}),
							`the host admits ${joinedText(j)}`
						)
						const verdict = evaluate(derivedOf[check], admitted).checks[check]
						return `${joinedText(j)} ${Result.isSuccess(verdict) ? verdict.success : "unevaluated"}`
					}
					const host = Arr.sort(Arr.map(read, judged), Order.String)
					const spec = Arr.sort(
						Arr.map(
							restated[check],
							(j) => `${joinedText(j)} ${holds(check, j) ? "holds" : "breaks"}`
						),
						Order.String
					)
					if (!sameTexts(host, spec)) {
						yield* Effect.ignore(session.rollback)
						return yield* new Disagreed({
							message: `${check}: the host judges the rows the database holds as\n${Arr.join(host, "\n")}\nwhere the restatement judges\n${Arr.join(spec, "\n")}\n${where}`
						})
					}
				}
			}
			const broken = brokenOf(next)
			const refused = Option.isSome(bracketed)
				? bracketed
				: yield* refusalOf(session.query("SET CONSTRAINTS ALL IMMEDIATE", []))
			if (Option.isNone(refused)) {
				if (broken.length > 0) {
					yield* Effect.ignore(session.rollback)
					return yield* new Disagreed({
						message: `the judge accepted a state that breaks ${Arr.join(broken, " and ")}, ${where}`
					})
				}
				yield* session.commit
				state = next
				note("committed")
				if (atBound(next)) {
					note("committed at a bound")
				}
				if (Arr.some(next.visits, (v) => next.began.has(v.sitting) && !next.ended.has(v.sitting))) {
					note("an open sitting's visit committed")
				}
				continue
			}
			yield* session.rollback
			const fields = refused.value
			const names = Arr.map(broken, (check) =>
				nameOf({ kind: "check", relation: derivedOf[check].name, name: check })
			)
			if (fields.code !== "23514" || !Arr.contains(names, fields.constraint ?? "")) {
				return yield* new Disagreed({
					message: `refused by ${fields.code} ${fields.constraint ?? "naming no constraint"} where the restatement finds ${broken.length === 0 ? "nothing broken" : `${Arr.join(broken, " and ")} broken, named ${Arr.join(names, ", ")}`}, ${where}`
				})
			}
			if (Arr.contains(broken, "VisitAfterStart")) {
				note("refused before its start")
			}
			if (Arr.contains(broken, "VisitBeforeEnd")) {
				note("refused past its end")
			}
			if (Arr.every(ops, (op) => op.kind === "begin")) {
				note("a start written after its visits refused")
			}
			if (Arr.every(ops, (op) => op.kind === "end")) {
				note("an end written before a visit's end refused")
			}
		}
	})
