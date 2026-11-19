/** What the properties of snapshot-levels.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { closedId, pg } from "#compiler/public/fields.ts"
import { closed, contained, key, on, relation, schema, select } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { Id } from "#test/support/ids.ts"

const Kind = closed.ordered("Kind", ["One", "Two"])

const R = relation(
	"R",
	{
		id: Id,
		big: pg.bigint,
		label: str.regex("^[a-z]{1,8}$"),
		flag: pg.boolean,
		other: Id,
		kind: closedId(Kind)
	},
	["id"]
)

const B = relation("B", { id: Id }, ["id"])

const literals = ["bigint", "text", "boolean", "uuid", "closed id"] as const

type Literal = (typeof literals)[number]

const placements = ["root", "level"] as const

export type Placement = (typeof placements)[number]

interface Case {
	readonly literal: Literal
	readonly placement: Placement
}

export const caseGen: Gen<Case> = (source) => ({
	literal: source.draw(element(literals)),
	placement: source.draw(element(placements))
})

/** The key over R's facts the case's literal selects. */
const selectedKey = (literal: Literal) => {
	switch (literal) {
		case "bigint":
			return key(
				on(
					select(R, (r) => r.gt(r.big, 0n)),
					"other"
				)
			)
		case "text":
			return key(
				on(
					select(R, (r) => r.eq(r.label, "ab")),
					"other"
				)
			)
		case "boolean":
			return key(
				on(
					select(R, (r) => r.eq(r.flag, true)),
					"other"
				)
			)
		case "uuid":
			return key(
				on(
					select(R, (r) => r.ne(r.other, "00000000-0000-4000-8000-000000000000")),
					"big"
				)
			)
		case "closed id":
			return key(
				on(
					select(R, (r) => r.eq(r.kind, "Two")),
					"other"
				)
			)
	}
}

/**
 * The schema of a case: the key at the root, or at a level over a root of B, R there contained in B by its other and
 * typed by the root's roster.
 */
export const schemaOf = (c: Case): AnySchema => {
	switch (c.placement) {
		case "root":
			return schema("Root", [Kind, R], [selectedKey(c.literal)])
		case "level":
			return schema.extend(
				schema("Root", [Kind, B], []),
				"Upper",
				[R],
				[contained(on(R, "other"), on(B, "id")), selectedKey(c.literal)]
			)
	}
}
