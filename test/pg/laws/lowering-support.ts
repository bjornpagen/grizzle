/**
 * The schemas the lowering differential draws (lowering.test.ts): a containment of a stored source S into a derived
 * target D whose definition reads the stored A, and B where it joins, each D one shape of the definition the theory
 * judges (analysis/theory/laws.ts RuleLowering). Both shapes meet every condition a containment into a derived relation
 * lowers to foreign keys under, and each references a superkey of its target's candidate key, the superkey's UNIQUE
 * serving the containment beside the key: candidatePair's A (grp, v, kind) over key (grp, kind), join's B (grp, tag)
 * over key (grp). Which definitions lower is the theory's to decide, judged in test/unit/laws/lowered-rules.test.ts.
 *
 * A holds a primary key `id` and a candidate key (grp, kind), B a primary key `id` and a candidate key `grp`, and S a
 * primary key `sid`, its `x` and `y` the source terms. A and B are the root level's, D and S the level above's, so S's
 * level is at least every level D's definition matches. A case deletes and updates rows of each, so each is open,
 * mutable inside the unit its key leads with (test/support/open.ts opened), in every version. A history installs the same schema through a migration from an
 * earlier version (Order), so a declared key's index and a lowering's UNIQUE over a superkey of it are created in every
 * order a deployment creates them.
 */
import type { SchemaDesc } from "#compiler/ir/desc.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, key, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { succeeded } from "#test/support/assert.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import { opened } from "#test/support/open.ts"
import { schemaDescIn } from "#test/support/policy.ts"

export const A = relation(
	"A",
	{
		id: pg.integer,
		kind: pg.integer,
		grp: pg.integer,
		v: pg.integer,
		txt: str.regex("^.*$", "su")
	},
	["id"]
)
export const B = relation("B", { id: pg.integer, grp: pg.integer, tag: pg.integer }, ["id"])
export const S = relation("S", { sid: pg.integer, x: pg.integer, y: pg.integer }, ["sid"])

/** The stored relations, every one a case writes. */
export const RELATIONS = ["A", "B", "S"] as const

/** A and B open, as every version of the root level holds them. */
const openRoot = opened([A, B])

/** The root level: A and B with their candidate keys, A's (grp, kind) and B's grp. */
const rootOf = (name: string) =>
	schema(name, [A, B], [key(on(A, "grp", "kind")), key(on(B, "grp")), ...openRoot])

type Root = ReturnType<typeof rootOf>

/** The root level with other candidate keys, A's (v, kind) and B's tag, each inside a superkey a lowering keys on. */
const otherRoot = (name: string) =>
	schema(name, [A, B], [key(on(A, "v", "kind")), key(on(B, "tag")), ...openRoot])

/** The root level with no candidate key: A and B open alone. */
const keylessRoot = (name: string) => schema(name, [A, B], openRoot)

/**
 * `desc` with its root level's statements `statements`, every level above it as it is: the same schema over other
 * candidate keys, or none.
 */
const overRootStatements = (desc: SchemaDesc, statements: SchemaDesc["statements"]): SchemaDesc =>
	desc.bases[0] === undefined
		? { ...desc, statements }
		: { ...desc, bases: [overRootStatements(desc.bases[0], statements)] }

/** Every shape of D. */
export const shapes = ["candidatePair", "join"] as const

export type Shape = (typeof shapes)[number]

/** The fields of A a source row copies into S's `x` and `y`. */
export interface Head {
	readonly x: "id" | "grp"
	readonly y: "grp" | "v"
}

/**
 * The fields of A whose values each shape's target terms take, in the order of the source terms S's `x` and `y`
 * reference them: what a source row copies from an A row to name a fact of D, where the row meets D's other conditions.
 */
export const heads: Readonly<Record<Shape, Head>> = {
	candidatePair: { x: "grp", y: "v" },
	join: { x: "id", y: "grp" }
}

/** The kind each shape's match of A fixes. */
export const fixedKinds: Readonly<Record<Shape, number>> = {
	candidatePair: 2,
	join: 1
}

/** The level above the root under `name`: S and D, and the containment of S in D. */
const above = (root: Root, name: string, shape: Shape) => {
	switch (shape) {
		case "candidatePair": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { grp, v: w } = v(A, "a")
					return r.match(A, { grp, v: w, kind: 2 }).find({ id: grp, g: w })
				})
			)
			return schema.extend(
				[root],
				name,
				[S, D],
				[contained(on(S, "x", "y"), on(D, "id", "g")), ...opened([S])]
			)
		}
		case "join": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { id, grp } = v(A, "a")
					return r.match(A, { id, grp, kind: 1 }).match(B, { grp, tag: 3 }).find({ id, g: grp })
				})
			)
			return schema.extend(
				[root],
				name,
				[S, D],
				[contained(on(S, "x", "y"), on(D, "id", "g")), ...opened([S])]
			)
		}
	}
}

/**
 * The schema of `shape` under `name`: the root level under `name`, the level above under `<name>_1`, as an allocation
 * names its levels (test/support/compile.ts allocatedDesc).
 */
export const loweringSchema = (shape: Shape, name: string) =>
	above(rootOf(name), `${name}_1`, shape)

export type LoweringSchema = ReturnType<typeof loweringSchema>

/**
 * The histories a lowered schema is migrated through, each from its first version: from the root alone, the level
 * above and its lowering added by a migration over the declared keys (aboveLater); from the same levels with no
 * candidate key (keylessRoot), the keys added by a migration beside, or with, the lowering's UNIQUE over a superkey of
 * them (keysLater); or from other candidate keys inside that superkey, replaced by a migration after the lowering's UNIQUE
 * was created (keyChanged).
 */
export const histories = ["aboveLater", "keysLater", "keyChanged"] as const

export type History = (typeof histories)[number]

/** How an installation reached its schema: in one first migration (fresh), or through a history. */
export type Order = "fresh" | History

/** The version a history migrates from to the schema of `shape` under `name`. */
export const firstVersion = (history: History, shape: Shape, name: string): FixtureSchema => {
	switch (history) {
		case "aboveLater":
			return rootOf(name)
		case "keysLater":
			return overRootStatements(
				succeeded(schemaDescIn(loweringSchema(shape, name))),
				succeeded(schemaDescIn(keylessRoot(name))).statements
			)
		case "keyChanged":
			return overRootStatements(
				succeeded(schemaDescIn(loweringSchema(shape, name))),
				succeeded(schemaDescIn(otherRoot(name))).statements
			)
	}
}
