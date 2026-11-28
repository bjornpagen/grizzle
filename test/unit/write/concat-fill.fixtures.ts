/** What the properties of concat-fill.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { StoredRelationName } from "#compiler/core/ids.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { columnIndex } from "#compiler/runtime/write/cells.ts"
import { closedLeaf, filler, hostEvaluator } from "#compiler/runtime/write/fill.ts"
import { own, rostersOf } from "#compiler/schema/own.ts"
import { hostFillOf } from "#compiler/write/program/decide.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	decodedSchema,
	f,
	field,
	fin,
	fold,
	on,
	onWhere,
	ordered,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { compiledModel } from "#test/support/unit/laws/model/natives.ts"

/** The texts a member's piece takes: none, one ASCII letter, and one character past the Basic Multilingual Plane. */
const pieces = ["", "a", "\u{1F600}"] as const

/** Text of at most 64 code points: bounded, so the family's axes, which carry each running text, key it. */
const text = f.regex("^.{0,64}$", "su")

/** The fold's schema: Owner(id, n, joined) and Member(id, owner, at, piece, flag, before, after). */
const schemaOf = (selected: boolean): SchemaDesc => {
	const step = ["owner", "piece", "before", "after"]
	return {
		name: "Joins",
		relations: [
			relation("Owner", { id: f.uuid, n: f.drawn, joined: f.accumulated(text, "") }, ["id"]),
			relation(
				"Member",
				{
					id: f.uuid,
					owner: f.uuid,
					at: f.drawn,
					piece: text,
					flag: f.boolean,
					before: f.accumulated(text, ""),
					after: f.accumulated(text, "")
				},
				["id"]
			)
		],
		statements: [
			ordered(on("Member", ["owner", "at"]), fin("Owner", "n")),
			fold(
				fin("Owner", "n"),
				"concat",
				selected
					? onWhere("Member", step, {
							kind: "compare",
							op: "eq",
							left: field("flag"),
							right: { kind: "literal", value: true }
						})
					: on("Member", step),
				on("Owner", ["id", "joined"])
			)
		],
		bases: []
	}
}

/** Each fold's filler, the selecting one and the other, compiled once. */
export const fills = Object.freeze(
	Arr.map([false, true] as const, (selected) => {
		const desc = schemaOf(selected)
		const model = succeeded(compiledModel(desc), "a concat fold compiles")
		const codes = firstCodebook(rostersOf(succeeded(own(decodedSchema(desc)))))
		const columns = columnIndex()
		return {
			family: defined(model.families[0], "the fold's family"),
			columns,
			fill: filler(
				hostFillOf(model.theory.fill, [
					{ relation: StoredRelationName("Owner"), position: { kind: "top" } }
				]),
				codes,
				hostEvaluator(closedLeaf(new Map()), model.patterns),
				columns
			)
		}
	})
)

interface ConcatCase {
	readonly selected: boolean
	readonly members: ReadonlyArray<{ readonly piece: string; readonly flag: boolean }>
}

export const caseGen: Gen<ConcatCase> = (source) => ({
	selected: source.draw(element([false, true] as const)),
	members: source.draw(
		array(
			(s) => ({ piece: s.draw(element(pieces)), flag: s.draw(element([false, true] as const)) }),
			{ min: 0, max: 3 }
		)
	)
})

export type FillFeature =
	| "an empty family"
	| "a member stepped over"
	| "a supplementary character joined"
