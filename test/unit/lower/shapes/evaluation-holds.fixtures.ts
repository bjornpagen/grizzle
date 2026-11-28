/** What evaluation-holds.test.ts reads: its schema, its box and the optimized statements of a case's read. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { Fn } from "#compiler/public/compute.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import { fn, relation, row, rows, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"

const A = rows({ k: int4, v: int4 })

/** machine: three rows arguments of (k, v), and one row of one field of rows of (k, v). */
const machine = fn("machine", {
	calls: [],
	args: { in0: A, in1: A, in2: A },
	returns: row(rows({ a0: A })),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT NULL`
})

/** A child's item sessions, each at its stage, their attempts, and six relations of an attempt's values. */
const Session = relation("Session", { child: int4, item: int4, stage: int4 }, ["child", "item"])
const Attempt = relation("Attempt", { child: int4, item: int4, at: int4 }, ["child", "item", "at"])
const valueFields = { child: int4, item: int4, at: int4, v: int4 } as const
const values = [
	relation("ValueA", valueFields, ["child", "item", "at", "v"]),
	relation("ValueB", valueFields, ["child", "item", "at", "v"]),
	relation("ValueC", valueFields, ["child", "item", "at", "v"]),
	relation("ValueD", valueFields, ["child", "item", "at", "v"]),
	relation("ValueE", valueFields, ["child", "item", "at", "v"]),
	relation("ValueF", valueFields, ["child", "item", "at", "v"])
] as const
type Values = (typeof values)[number]
const Held = schema("EvaluationHolds", [Session, Attempt, ...values, machine], [])

/** A sitting: a child's stage. */
const sittingHeading = { child: int4, stage: int4 } as const

/**
 * Each session of the sittings at its latest attempt: a fold over the attempts of the sittings' sessions, as edullm's
 * ledger reads a sitting's gradable attempts, built anew at each call, as its ledger builds `gradableOf(gradedSitting)`
 * at every argument that reads it.
 */
const latestOf = () =>
	query(Held).rule((r) => {
		const sittings = r.relation("sittings", sittingHeading)
		const { child, stage } = v(sittings, "sitting")
		const { item } = v(Session, "session")
		const { at } = v(Attempt, "attempt")
		return r
			.match(sittings, { child, stage })
			.match(Session, { child, item, stage })
			.match(Attempt, { child, item, at })
			.find({ child, item, at: r.max(at) })
	})

/** The one fold every read of a case of one object reads. */
const latest = latestOf()

/**
 * How a case's arguments read the fold: one object every read imports, or a factory's Description at each read, every
 * one of one identity, which the checker reads as one query (check/session.ts ResolvedImports).
 */
export type Copies = "one object" | "a factory per read"

/** A rule of an argument: the sittings' latest attempts' values in `held`, the fold read as `copies` says. */
const valuesAtLatest = (held: Values, copies: Copies) => (r: Rule<typeof Held>) => {
	const fold = copies === "one object" ? latest : latestOf()
	const at = fold.bind({ sittings: r.relation("sittings", sittingHeading) })
	const { child, item, at: when } = v(at, "latest")
	const { v: x } = v(held, "value")
	return r
		.match(at, { child, item, at: when })
		.match(held, { child, item, at: when, v: x })
		.find({ k: item, v: x })
}

/** The stage of the session at a child and item: the sittings every argument reads. */
const stageOf = query(Held).rule((r) => {
	const child = r.param("child", int4)
	const { stage } = v(Session, "keyed")
	return r.match(Session, { child, item: r.param("item", int4), stage }).find({ child, stage })
})

/** A child's sessions, the parent rows machine's run is read at. */
const sessions = query(Held).rule((r) => {
	const { child, item, stage } = v(Session, "parent")
	return r
		.match(Session, { child, item, stage })
		.where(r.eq(child, r.param("child", int4)))
		.find({ child, item })
})

/**
 * How many of machine's arguments read the latest attempts, one to three (the others read none of them), how many
 * rules each such argument unites, one or two: the fold's reads, one to six; whether every read imports one fold or a
 * factory's copy of it; and whether the rule that calls machine reads the fold itself beside the call (`beside`), a read
 * outside the call's evaluation, as each of edullm's mark reads reads the latest attempts beside attempt_marks_of.
 */
export interface Box {
	readonly reading: 1 | 2 | 3
	readonly rules: 1 | 2
	readonly copies: Copies
	readonly beside: boolean
}

export const boxGen: Gen<Box> = element<Box>(
	Arr.flatMap([1, 2, 3] as const, (reading) =>
		Arr.flatMap([1, 2] as const, (rules) =>
			Arr.flatMap(["one object", "a factory per read"] as const, (copies) =>
				Arr.map([false, true] as const, (beside) => ({ reading, rules, copies, beside }))
			)
		)
	)
)

/** The reads of the fold, the reads `box` makes of it. */
export const readsOf = (box: Box): number => box.reading * box.rules

/** Argument `i`: the latest attempts' values in one or two relations, or, past `reading`, the sittings' sessions. */
const argumentOf = (box: Box, i: 0 | 1 | 2) => {
	const [first, second] = [values[2 * i], values[2 * i + 1]]
	if (i >= box.reading || first === undefined || second === undefined) {
		return query(Held).rule((r) => {
			const sittings = r.relation("sittings", sittingHeading)
			const { child, stage } = v(sittings, "sitting")
			const { item } = v(Session, "staged")
			return r
				.match(sittings, { child, stage })
				.match(Session, { child, item, stage })
				.find({ k: item, v: stage })
		})
	}
	const one = query(Held).rule(valuesAtLatest(first, box.copies))
	return box.rules === 1 ? one : one.rule(valuesAtLatest(second, box.copies))
}

/** The read of the case: each session of the child, and machine's run at the session's sitting, its field read. */
const readOf = (box: Box) =>
	sessions.attach(
		"marks",
		(parent) =>
			query(Held).rule((r) => {
				const sittings = stageOf.bind({ child: parent.child, item: parent.item })
				const run = Fn.row(machine, {
					in0: argumentOf(box, 0).bind({ sittings }),
					in1: argumentOf(box, 1).bind({ sittings }),
					in2: argumentOf(box, 2).bind({ sittings })
				})
				const { k, v: x } = v(run.a0, "marks")
				const marks = r.match(run.a0, { k, v: x })
				if (!box.beside) {
					return marks.find({ k, v: x })
				}
				const fold = box.copies === "one object" ? latest : latestOf()
				const shown = fold.bind({ sittings })
				const { child, at } = v(shown, "shown")
				return marks.match(shown, { child, item: k, at }).find({ k, v: x })
			}),
		"array"
	)

/** The optimized statements of the case's read, their texts joined. */
export const optimizedOf = (box: Box): string =>
	Arr.join(
		Arr.map(
			succeeded(compileTemplate(readOf(box), undefined, testCompile), "the case's read compiles")
				.optimized,
			(s) => s.sql
		),
		"\n"
	)

/** How many times `sql` scans `table`. */
export const scans = (sql: string, table: "attempt" | "session"): number =>
	Str.split(`"evaluation_holds"."${table}" AS`)(sql).length - 1
