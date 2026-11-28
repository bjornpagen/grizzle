/** What the properties of snapshot-levels.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Logic } from "#compiler/public/compute.ts"
import { closedId, domain, bool, int8 } from "#compiler/public/fields.ts"
import { closed, contained, key, on, relation, schema, select } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installationsOf, own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { Id } from "#test/support/ids.ts"

const Kind = closed.ordered("Kind", ["One", "Two"])

const R = relation(
	"R",
	{
		id: Id,
		big: int8,
		label: str.regex("^[a-z]{1,8}$"),
		flag: bool,
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
				[schema("Root", [Kind, B], [])],
				"Upper",
				[R],
				[contained(on(R, "other"), on(B, "id")), selectedKey(c.literal)]
			)
	}
}

/** Where a domain's values are held: by a relation of the root, by one of the level over it, or by one of each. */
const uses = ["root", "level", "both"] as const

export type Use = (typeof uses)[number]

/** Where a key statement stands: at the root over its relation, or at the level over the level's own. */
const keyPlacements = ["root", "level"] as const

export type KeyPlacement = (typeof keyPlacements)[number]

/** What a two-level case reaches: where Cents is used, and where the key statement stands. */
export type LeveledFeature = `Cents used at ${Use}` | `a key at ${KeyPlacement}`

/** The situations a two-level case reaches. */
export const leveledFeatures = (c: LeveledCase): ReadonlyArray<LeveledFeature> => [
	`Cents used at ${c.use}`,
	`a key at ${c.key}`
]

/** A two-level schema of the box: where Cents is used, and where the key statement stands. */
interface LeveledCase {
	readonly use: Use
	readonly key: KeyPlacement
}

export const leveledGen: Gen<LeveledCase> = (source) => ({
	use: source.draw(element(uses)),
	key: source.draw(element(keyPlacements))
})

const centsKey = Symbol("Cents")
const Cents = domain<typeof centsKey>()("Cents", int8, (v) => Logic.ge(v, 0n))

/**
 * The case's two schemas, the root alone and the level over it: Z at the root, A at the level, A contained in Z by its
 * z; Cents typing Z's c, A's c, or both, A's name ordered before Z's so ownership meets A's use of Cents first; the key
 * statement over Z's c at the root, or over A's c at the level.
 */
export const leveledSchemas = (
	c: LeveledCase
): { readonly root: AnySchema; readonly level: AnySchema } => {
	const Z = relation("Z", { id: Id, c: c.use === "level" ? int8 : Cents }, ["id"])
	const A = relation("A", { id: Id, z: Id, c: c.use === "root" ? int8 : Cents }, ["id"])
	const root = schema("Root", [Z], c.key === "root" ? [key(on(Z, "c"))] : [])
	return {
		root,
		level: schema.extend(
			[root],
			"Upper",
			[A],
			[contained(on(A, "z"), on(Z, "id")), ...(c.key === "level" ? [key(on(A, "c"))] : [])]
		)
	}
}

/** The installation of a schema value, owned and compiled with its first codebook. */
export const installationOf = (s: AnySchema): Installation => {
	const owned = succeeded(own(defined(schemaDescOf(s), "the case's description")))
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), [], [], firstCodebook(rostersOf(owned)))
		)
	)
}
