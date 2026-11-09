import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { own, rostersOf } from "#compiler/schema/own.ts"
import {
	closedLeaf,
	columnKey,
	fieldKey,
	filler,
	type HostNode,
	hostEvaluator
} from "#compiler/write/family/fold.ts"
import { hostFillOf } from "#compiler/write/program/decide.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
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
import { caseHang } from "#test/support/limits.ts"
import { compiledModel } from "#test/unit/laws/model/natives.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * The host's fill of a concat fold (write/family/fold.ts `filler`, combineHost's concat): every member's before and
 * after, and the owner's end, over an ordered family whose (before, after) pair is named, stepping over every member
 * or those a selection holds of.
 *
 * The oracle: a naive left fold of the slots' texts, the empty text first, each after its before then its piece where
 * the member is selected and its before elsewhere, the end the last after, the empty text for no member. The box,
 * exhausted: families of up to three members, each piece the empty text, an ASCII letter or a supplementary-plane
 * character, each selected or not, under a fold that selects and one that does not.
 */

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
							right: { kind: "literal", value: true, type: undefined }
						})
					: on("Member", step),
				on("Owner", ["id", "joined"])
			)
		],
		extends: undefined
	}
}

/** Each fold's filler, the selecting one and the other, compiled once. */
const fills = Arr.map([false, true] as const, (selected) => {
	const desc = schemaOf(selected)
	const model = succeeded(compiledModel(desc), "a concat fold compiles")
	const codes = firstCodebook(rostersOf(succeeded(own(decodedSchema(desc)))))
	return {
		family: defined(model.families[0], "the fold's family"),
		fill: filler(
			hostFillOf(model.theory.fill, [{ relation: "Owner", position: { kind: "top" } }]),
			codes,
			hostEvaluator(codes, closedLeaf(new Map()), model.patterns)
		)
	}
})

interface ConcatCase {
	readonly selected: boolean
	readonly members: ReadonlyArray<{ readonly piece: string; readonly flag: boolean }>
}

const caseGen: Gen<ConcatCase> = (source) => ({
	selected: source.draw(element([false, true] as const)),
	members: source.draw(
		array(
			(s) => ({ piece: s.draw(element(pieces)), flag: s.draw(element([false, true] as const)) }),
			{ min: 0, max: 3 }
		)
	)
})

type FillFeature = "an empty family" | "a member stepped over" | "a supplementary character joined"

describe("the host fill of a concat fold", () => {
	it.effect("draws the naive left fold of its slots' texts", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/write/concat-fill",
					generator: caseGen,
					literal: Formatter.format,
					limit: 3_000,
					box: "families of up to three members, pieces '', 'a' and U+1F600, each selected or not, under a selecting fold and one that does not select",
					oracle: { kind: "second-implementation", name: "a naive left fold of the slots' texts" },
					coverage: requiredInSpace<FillFeature>([
						"an empty family",
						"a member stepped over",
						"a supplementary character joined"
					]),
					caseHang
				},
				(c, k) =>
					Effect.sync(() => {
						const { family, fill } = defined(fills[c.selected ? 1 : 0])
						const nesting: HostNode = {
							relation: "Owner",
							values: new Map([[fieldKey("id"), uuidOf(0)]]),
							families: [
								{
									family: { owner: "Owner", count: "n" },
									members: Arr.map(c.members, (m, i) => ({
										relation: "Member",
										values: new Map<ReturnType<typeof fieldKey>, unknown>([
											[fieldKey("id"), uuidOf(i + 1)],
											[fieldKey("piece"), m.piece],
											[fieldKey("flag"), m.flag]
										]),
										families: []
									}))
								}
							]
						}
						const filled = succeeded(fill(nesting, { kind: "top" }), "a family of texts fills")
						const plane = defined(defined(family.folds[0]).planes[0])
						const rows = defined(filled.families[0], "the owner's family").members
						let running = ""
						for (const [slot, m] of c.members.entries()) {
							const row = defined(rows[slot], `slot ${slot}`)
							const stepped = !c.selected || m.flag
							const after = stepped ? `${running}${m.piece}` : running
							assert.equal(
								row.values.get(columnKey(plane.before)),
								running,
								`slot ${slot}'s before`
							)
							assert.equal(row.values.get(columnKey(plane.after)), after, `slot ${slot}'s after`)
							if (!stepped) {
								k.note("a member stepped over")
							}
							if (stepped && m.piece === "\u{1F600}") {
								k.note("a supplementary character joined")
							}
							running = after
						}
						if (c.members.length === 0) {
							k.note("an empty family")
						}
						assert.equal(filled.values.get(fieldKey("joined")), running, "the owner's end")
					})
			)
		)
	)
})
