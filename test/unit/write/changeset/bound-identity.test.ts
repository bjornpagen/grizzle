import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { maxStringLength } from "#compiler/core/limits.ts"
import { isRecord } from "#compiler/core/record.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet, type ChangeSetValue } from "#compiler/write/changeset/value.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { descOf, parsedOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A ChangeSet's bound values are keyed by their canonical tokens (core/canonical.ts canonicalTokens), never by one
 * canonical text (write/changeset/value.ts boundKey): two ChangeSets that bind one name to equal values combine into
 * one private parameter, and to different values into two, named in the order of the values' canonical texts, whatever
 * order the union takes them in. A bound relation input whose texts sum past the longest string V8 holds
 * (maxStringLength) is keyed as any other, where its text was once refused and the value left unkeyed, so two equal
 * ones stayed two parameters.
 *
 * The box: a relation input of seven notes, each a body of a's, the last ending in a or b, at a length of 4 and at
 * the least length whose seven bodies sum past the longest string (maxStringLength); bound in two ChangeSets to equal
 * values or to the a- and the b-ending ones, combined by union in either order. The oracle is the specification: equal
 * values are one binding; different ones are two, and the Description's bindings, read in their order, hold the
 * a-ending value first, its canonical text the lesser. The private names themselves are the ChangeSet's own, never
 * spelled here.
 *
 * Features: past the longest string, equal values, different values, either order.
 *
 * Plants (~/.cache/grizzle-release/BR02/plants): bound-order-reversed, private parameters named against their canonical
 * texts' order; bound-key-unkeyed-long, a value past the longest string left opaque.
 */
const Note = relation("Note", { id: pg.int4, body: str.regex("^[ab]*$") }, ["id"])
const Notes = schema("BoundNotes", { Note }, [])

/** The notes inserted as the relation parameter `notes` binds them. */
const inserted = (): ChangeSetValue =>
	ChangeSet.empty(Notes).insert(
		Note,
		query(Notes).rule((r: RuleValue) => {
			const { id, body } = v(Note, "note")
			return r.match(r.relation("notes", Note), { id, body }).find({ id, body })
		})
	)

/** The notes' count, each body's length, and the box's lengths: one small, and the least whose seven bodies pass the
 * longest string. */
const count = 7
const lengths = [4, Math.floor(maxStringLength.value / count) + 1] as const

interface BoundCase {
	readonly length: (typeof lengths)[number]
	readonly values: "equal" | "different"
	readonly order: "a-ending first" | "b-ending first"
}

/** Seven notes at `length`, the last ending in `last`, every other body one shared string of a's. */
const notesOf = (
	shared: string,
	last: "a" | "b"
): ReadonlyArray<{ readonly id: number; readonly body: string }> =>
	Arr.makeBy(count, (i) => ({
		id: i + 1,
		body: i === count - 1 ? `${Str.slice(1)(shared)}${last}` : shared
	}))

/** The last letter of the last note's body of a bound relation input. */
const lastLetter = (value: unknown): string => {
	if (!Arr.isArray(value)) {
		return assert.fail("a relation input's notes")
	}
	const last: unknown = value.at(-1)
	const body = isRecord(last) ? last["body"] : undefined
	return typeof body === "string" ? Str.slice(-1)(body) : assert.fail("a note's body")
}

type BoundFeature = "past the longest string" | "equal values" | "different values" | "either order"

describe("a ChangeSet's bound values", () => {
	it.effect(
		"are one parameter when equal and two named in their canonical texts' order otherwise, past the longest string too",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/changeset/bound-identity",
						generator: (source): BoundCase => ({
							length: source.draw(element(lengths)),
							values: source.draw(element(["equal", "different"] as const)),
							order: source.draw(element(["a-ending first", "b-ending first"] as const))
						}),
						literal: Formatter.format,
						coverage: requiredInSpace<BoundFeature>([
							"past the longest string",
							"equal values",
							"different values",
							"either order"
						]),
						caseHang,
						box: "seven notes at a body length of 4 and at the least whose seven bodies pass the longest string, bound to equal or different values, combined in either order",
						oracle: {
							kind: "specification",
							name: "bound values are one parameter when equal, and otherwise named in their canonical texts' order"
						}
					},
					(box, c) =>
						Effect.sync(() => {
							const shared = Str.repeat(box.length)("a")
							if (count * box.length > maxStringLength.value) {
								c.note("past the longest string")
							}
							const lesser = notesOf(shared, "a")
							const greater = box.values === "equal" ? notesOf(shared, "a") : notesOf(shared, "b")
							const [first, second] =
								box.order === "a-ending first" ? [lesser, greater] : [greater, lesser]
							if (box.order === "b-ending first") {
								c.note("either order")
							}
							const combined = ChangeSet.union(
								inserted().bind({ notes: first }),
								inserted().bind({ notes: second })
							)
							const values = parsedOf(combined).values
							const bound = Arr.map(descOf(combined).bindings, (name) =>
								lastLetter(values.get(name))
							)
							if (box.values === "equal") {
								c.note("equal values")
								assert.deepEqual(bound, ["a"], "equal values are one parameter")
								return
							}
							c.note("different values")
							assert.deepEqual(
								bound,
								["a", "b"],
								"different values are two parameters, the lesser text's first"
							)
						})
				)
			)
	)
})
