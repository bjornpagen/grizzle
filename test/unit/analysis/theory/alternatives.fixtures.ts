/** What the properties of alternatives.test.ts read: its spaces, models and helpers. */

import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { type ExprDesc } from "#compiler/ir/desc.ts"
import { assert, defined } from "#test/support/assert.ts"
import {
	alternatives,
	closed,
	contained,
	f,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { upTo } from "#test/support/up-to.ts"
import { schemaOf } from "#test/unit/analysis/theory/support.ts"

/** Which arm relation each handle of the roster is the arm of, or none. */
type Assignment = ReadonlyArray<"A" | "B" | undefined>

/**
 * A roster of 1 to 4 handles, each the arm of A, of B or of none, at least one armed, built by its first armed handle:
 * the handles before it unarmed, it the arm of A or B, and every one after it any of the three.
 */
export const assignment: Gen<{ readonly arms: Assignment; readonly restated: boolean }> = (
	source
) => {
	const size = source.draw(int(1, 4))
	const first = source.draw(int(0, size - 1))
	const after = size - first - 1
	return {
		arms: [
			...upTo(first, (): "A" | "B" | undefined => undefined),
			source.draw(element(["A", "B"] as const)),
			...source.draw(array(element(["A", "B", undefined] as const), { min: after, max: after }))
		],
		restated: source.draw(boolean)
	}
}

const handleOf = (i: number): string => `h${i}`

/** The schema: roster R, parent P(id, tag: closedId(R)), arm relations A and B, the alternatives over P.tag. */
export const alternativesSchema = (arms: Assignment, restated: boolean): SchemaDesc => {
	const handles = upTo(arms.length, handleOf)
	const armOf = Rec.fromEntries(
		Arr.flatMap(arms, (a, i) =>
			a === undefined ? [] : [[handleOf(i), { name: a, primaryKey: ["id"] }] as const]
		)
	)
	const statement = alternatives(
		{ name: "P", primaryKey: ["id"] },
		"tag",
		{ name: "R", handles },
		armOf
	)
	const firstArmed = Arr.findFirstIndex(arms, (a) => a !== undefined).pipe(
		Option.getOrElse(() => assert.fail("an assignment arms a handle"))
	)
	const restatement = contained(
		onWhere("P", ["id"], {
			kind: "compare",
			op: "eq",
			left: { kind: "field", field: "tag" },
			right: { kind: "literal", value: handleOf(firstArmed) }
		}),
		on(defined(arms[firstArmed]), ["id"])
	)
	return schemaOf(
		[
			closed("R", handles),
			relation("P", { id: f.uuid, tag: f.closedId("R") }, ["id"]),
			relation("A", { id: f.uuid }, ["id"]),
			relation("B", { id: f.uuid }, ["id"])
		],
		restated ? [statement, restatement] : [statement]
	)
}

/** A containment by what it states: its two relations and each side's selection, by its conjuncts' canonical texts. */
export const containmentText = (
	from: string,
	fromSelection: ReadonlyArray<ExprDesc>,
	to: string,
	toSelection: ReadonlyArray<ExprDesc>
): string =>
	`${from}[${Arr.join(Arr.map(fromSelection, canonicalTextOf), ";")}] in ${to}[${Arr.join(Arr.map(toSelection, canonicalTextOf), ";")}]`

/** The discriminator among `handles`: `eq` for one, `in` for several, as fin.md §7 spells an arm's selection. */
const tagAmong = (handles: ReadonlyArray<string>): ExprDesc => {
	const tag: ExprDesc = { kind: "field", field: "tag" }
	const [only, ...more] = handles
	return more.length === 0
		? {
				kind: "compare",
				op: "eq",
				left: tag,
				right: { kind: "literal", value: defined(only) }
			}
		: { kind: "in", arg: tag, values: handles }
}

/**
 * fin.md §7's expansion, as its own checker: per arm relation, its key in P selected by the handles it is the arm of;
 * per armed handle, P selected by it in its arm. No containment reads the roster: there is no head.
 */
export const expectedContainments = (arms: Assignment): ReadonlyArray<string> => {
	const relations = Arr.dedupe(Arr.filter(arms, (a): a is "A" | "B" => a !== undefined))
	const forward = Arr.map(relations, (rel) =>
		containmentText(rel, [], "P", [
			tagAmong(Arr.flatMap(arms, (a, i) => (a === rel ? [handleOf(i)] : [])))
		])
	)
	const reverse = Arr.flatMap(arms, (a, i) =>
		a === undefined ? [] : [containmentText("P", [tagAmong([handleOf(i)])], a, [])]
	)
	return Arr.sort([...forward, ...reverse], Order.String)
}

export type Feature =
	| "one handle per arm"
	| "an arm of several handles"
	| "an unarmed handle"
	| "a restated containment"
