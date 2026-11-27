/** What attached-union.test.ts reads: its schema, its box and the optimized statements of a case's read. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"

/** A test's assignments, each by its number, and each assignment's sitting events, as metis's assignment views hold them. */
const Assignment = relation("Assignment", { number: pg.bigint, test: pg.integer }, ["number"])
const Event = relation("Event", { number: pg.bigint, step: pg.integer, kind: pg.smallint }, [
	"number",
	"step"
])
const Assignments = schema("AttachedUnion", [Assignment, Event], [])

/**
 * Each assignment's status, a union of three rules: 1 where it has no event, 3 for an event of kind 4, 2 for one of
 * kind 5, as metis's `activeAfter` attaches a status to each assignment.
 */
const status = query(Assignments)
	.rule((r) => {
		const { number } = v(Assignment, "assignment")
		return r
			.match(Assignment, { number })
			.where(r.not(Event, { number }))
			.find({ number, status: 1 })
	})
	.rule((r) => {
		const { number, step } = v(Event, "event")
		return r.match(Event, { number, step, kind: 4 }).find({ number, status: 3 })
	})
	.rule((r) => {
		const { number, step } = v(Event, "event")
		return r.match(Event, { number, step, kind: 5 }).find({ number, status: 2 })
	})

/** The asked test's assignments. */
const ofTest = query(Assignments).rule((r) => {
	const { number, test } = v(Assignment, "assignment")
	return r
		.match(Assignment, { number, test })
		.where(r.eq(test, r.param("test", pg.integer)))
		.find({ number })
})

/**
 * How the status is attached to each assignment: by its number, the status read through a rule that matches the union
 * at the number, or not at all, the assignments alone.
 */
export type Attached = "by the number" | "no attachment"

export interface Box {
	readonly attached: Attached
}

export const boxGen: Gen<Box> = element<Box>([
	{ attached: "by the number" },
	{ attached: "no attachment" }
])

const readOf = (box: Box) => {
	switch (box.attached) {
		case "no attachment":
			return ofTest
		case "by the number":
			return ofTest.attach(
				"status",
				(assignment) =>
					query(Assignments).rule((r) => {
						const { status: s } = v(status, "status")
						return r.match(status, { number: assignment.number, status: s }).find({ status: s })
					}),
				"array"
			)
	}
}

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

/** The bodies of the MATERIALIZED CTEs of `sql` that hold a UNION. */
const unionBodies = (sql: string): ReadonlyArray<string> =>
	Arr.filter(
		Arr.map(Arr.drop(Str.split("AS MATERIALIZED (")(sql), 1), (rest) => {
			const [body] = Str.split("\n)")(rest)
			return body
		}),
		Str.includes(" UNION ")
	)

/** How many MATERIALIZED CTEs of `sql` hold the status union whole: derived for the statement over every row. */
export const wholeUnionCtes = (sql: string): number => unionBodies(sql).length

/**
 * Whether the status union is read at each parent's number inside the attachment's LATERAL: each of its three arms
 * compares one outer reference, the parent key's number, the arms read at it alone.
 */
export const unionPerParentKey = (sql: string): boolean => {
	const [, lateral] = Str.split(" CROSS JOIN LATERAL (SELECT DISTINCT ")(sql)
	if (lateral === undefined) {
		return false
	}
	const arms = Str.split(" UNION ")(lateral)
	/** The column references an arm compares a column with: each text after ` = ` up to its closing quote. */
	const compared = Arr.map(
		arms,
		(arm) =>
			new Set(
				Arr.flatMap(Arr.drop(Str.split(' = "')(arm), 1), (rest) => {
					const [table, column] = Str.split('"."')(rest)
					return column === undefined ? [] : [`${table}.${Str.split('"')(column)[0]}`]
				})
			)
	)
	const [first, ...rest] = compared
	return (
		arms.length === 3 && Arr.some([...first], (ref) => Arr.every(rest, (others) => others.has(ref)))
	)
}
