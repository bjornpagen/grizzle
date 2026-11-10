/**
 * The schemas the lowering differential draws (lowering.test.ts): a containment of a stored source S into a derived
 * target D whose definition reads the stored A, and B where it joins, each D one shape of the definition the theory
 * judges (analysis/theory/laws.ts RuleLowering). Eight shapes meet every condition a containment into a derived
 * relation lowers to foreign keys under; eleven fail exactly one of the seven, each named by the condition it fails.
 *
 * A holds a primary key `id` and a candidate key (grp, kind), B a primary key `id` and a candidate key `grp`, and S a
 * primary key `sid`, its `x` and `y` the source terms. A and B are the root level's, D and S the level above's, so S's
 * level is at least every level D's definition matches. A history installs the same schema through a migration from an
 * earlier version (Order), so a declared key's index and a lowering's UNIQUE over a superkey of it are created in every
 * order a deployment creates them.
 */
import { Option } from "effect"
import type { SchemaDesc } from "#compiler/ir/desc.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, key, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { succeeded } from "#test/support/assert.ts"
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

/** The root level: A and B with their candidate keys, A's (grp, kind) and B's grp. */
const rootOf = (name: string) =>
	schema(name, { A, B }, [key(on(A, "grp", "kind")), key(on(B, "grp"))])

type Root = ReturnType<typeof rootOf>

/** The root level with other candidate keys, A's (v, kind) and B's tag, each inside a superkey a lowering keys on. */
const otherRoot = (name: string) =>
	schema(name, { A, B }, [key(on(A, "v", "kind")), key(on(B, "tag"))])

/**
 * `desc` with its root level's statements `statements`, every level above it as it is: the same schema over other
 * candidate keys, or none.
 */
const overRootStatements = (desc: SchemaDesc, statements: SchemaDesc["statements"]): SchemaDesc =>
	desc.extends === undefined
		? { ...desc, statements }
		: { ...desc, extends: overRootStatements(desc.extends, statements) }

/**
 * A condition of the seven a lowered containment's derived target meets (analysis/theory/laws.ts):
 * 1. one arm, no negation, every match over an ordinary stored relation;
 * 2. every target term a variable a match binds, the terms pairwise distinct;
 * 3. every where-conjunct a variable equal to a literal, which fixes no head variable;
 * 4. every variable outside the head bound once across the matches;
 * 5. every match binding a head variable;
 * 6. no match binding one head variable at two fields;
 * 7. each match's head and constant fields holding a key of its relation, their UNIQUE a provable B-tree entry.
 */
export type Condition = 1 | 2 | 3 | 4 | 5 | 6 | 7

/** Every shape of D, the lowered ones first. */
export const shapes = [
	"key",
	"fixed",
	"fixedTwo",
	"whereFixed",
	"candidate",
	"candidatePair",
	"pair",
	"join",
	"union",
	"negated",
	"computed",
	"repeated",
	"compared",
	"headFixed",
	"existential",
	"headless",
	"doubled",
	"unkeyed",
	"unbounded"
] as const

export type Shape = (typeof shapes)[number]

/**
 * What the theory decides for each shape: lowered to foreign keys where it meets every condition, else kept on its
 * triggers by the one condition it fails.
 */
export const decisions: Readonly<Record<Shape, "lowered" | Condition>> = {
	key: "lowered",
	fixed: "lowered",
	fixedTwo: "lowered",
	whereFixed: "lowered",
	candidate: "lowered",
	candidatePair: "lowered",
	pair: "lowered",
	join: "lowered",
	union: 1,
	negated: 1,
	computed: 2,
	repeated: 2,
	compared: 3,
	headFixed: 3,
	existential: 4,
	headless: 5,
	doubled: 6,
	unkeyed: 7,
	unbounded: 7
}

/** The fields of A a source row copies into S's `x` and `y`. */
export interface Head {
	readonly x: "id" | "grp"
	readonly y: "id" | "grp" | "v"
}

/**
 * The fields of A whose values each shape's target terms take, in the order of the source terms S's `x` and `y`
 * reference them: what a source row copies from an A row to name a fact of D, where the row meets D's other
 * conditions; a shape of one term reads `x` alone.
 */
export const heads: Readonly<Record<Shape, Head>> = {
	key: { x: "id", y: "grp" },
	fixed: { x: "id", y: "grp" },
	fixedTwo: { x: "id", y: "grp" },
	whereFixed: { x: "id", y: "grp" },
	candidate: { x: "grp", y: "grp" },
	candidatePair: { x: "grp", y: "v" },
	pair: { x: "id", y: "grp" },
	join: { x: "id", y: "grp" },
	union: { x: "id", y: "grp" },
	negated: { x: "id", y: "grp" },
	computed: { x: "id", y: "grp" },
	repeated: { x: "id", y: "id" },
	compared: { x: "id", y: "grp" },
	headFixed: { x: "id", y: "grp" },
	existential: { x: "id", y: "grp" },
	headless: { x: "id", y: "grp" },
	doubled: { x: "id", y: "grp" },
	unkeyed: { x: "grp", y: "grp" },
	unbounded: { x: "id", y: "grp" }
}

/** The kind each lowered shape's match of A fixes, where it fixes one. */
export const fixedKinds: Readonly<Record<Shape, Option.Option<number>>> = {
	key: Option.none(),
	fixed: Option.some(1),
	fixedTwo: Option.some(1),
	whereFixed: Option.some(1),
	candidate: Option.some(2),
	candidatePair: Option.some(2),
	pair: Option.some(1),
	join: Option.some(1),
	union: Option.none(),
	negated: Option.none(),
	computed: Option.none(),
	repeated: Option.none(),
	compared: Option.none(),
	headFixed: Option.none(),
	existential: Option.none(),
	headless: Option.none(),
	doubled: Option.none(),
	unkeyed: Option.none(),
	unbounded: Option.none()
}

/** The level above the root under `name`: S and D, and the containment of S in D. */
const above = (root: Root, name: string, shape: Shape) => {
	switch (shape) {
		case "key": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { id } = v(A, "a")
					return r.match(A, { id }).find({ id })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x"), on(D, "id"))])
		}
		case "fixed": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { id } = v(A, "a")
					return r.match(A, { id, kind: 1 }).find({ id })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x"), on(D, "id"))])
		}
		case "fixedTwo": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { id } = v(A, "a")
					return r.match(A, { id, kind: 1, grp: 0 }).find({ id })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x"), on(D, "id"))])
		}
		case "whereFixed": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { id, kind } = v(A, "a")
					return r.match(A, { id, kind }).where(r.eq(kind, 1)).find({ id })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x"), on(D, "id"))])
		}
		case "candidate": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { grp } = v(A, "a")
					return r.match(A, { grp, kind: 2 }).find({ id: grp })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x"), on(D, "id"))])
		}
		case "candidatePair": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { grp, v: w } = v(A, "a")
					return r.match(A, { grp, v: w, kind: 2 }).find({ id: grp, g: w })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x", "y"), on(D, "id", "g"))])
		}
		case "pair": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { id, grp } = v(A, "a")
					return r.match(A, { id, grp, kind: 1 }).find({ id, g: grp })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x", "y"), on(D, "id", "g"))])
		}
		case "join": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { id, grp } = v(A, "a")
					return r.match(A, { id, grp, kind: 1 }).match(B, { grp, tag: 3 }).find({ id, g: grp })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x", "y"), on(D, "id", "g"))])
		}
		case "union": {
			const D = derived(
				"D",
				query(root)
					.rule((r) => {
						const { id } = v(A, "a")
						return r.match(A, { id, kind: 1 }).find({ id })
					})
					.rule((r) => {
						const { id } = v(A, "a")
						return r.match(A, { id, kind: 2 }).find({ id })
					})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x"), on(D, "id"))])
		}
		case "negated": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { id, grp } = v(A, "a")
					return r.match(A, { id, grp, kind: 1 }).where(r.not(B, { grp })).find({ id })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x"), on(D, "id"))])
		}
		case "computed": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { id } = v(A, "a")
					return r
						.match(A, { id, kind: 1 })
						.find({ id: Compute.greatest(id, Compute.literal(pg.integer, 0)) })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x"), on(D, "id"))])
		}
		case "repeated": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { id } = v(A, "a")
					return r.match(A, { id, kind: 1 }).find({ id, id2: id })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x", "y"), on(D, "id", "id2"))])
		}
		case "compared": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { id, v: w } = v(A, "a")
					return r.match(A, { id, kind: 1, v: w }).where(r.gt(w, 0)).find({ id })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x"), on(D, "id"))])
		}
		case "headFixed": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { id } = v(A, "a")
					return r.match(A, { id, kind: 1 }).where(r.eq(id, 1)).find({ id })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x"), on(D, "id"))])
		}
		case "existential": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { id, grp } = v(A, "a")
					const { id: bid } = v(B, "b")
					return r.match(A, { id, grp, kind: 1 }).match(B, { id: bid, grp }).find({ id, bid })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x", "y"), on(D, "id", "bid"))])
		}
		case "headless": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { id } = v(A, "a")
					return r.match(A, { id, kind: 1 }).match(B, { id: 0 }).find({ id })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x"), on(D, "id"))])
		}
		case "doubled": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { id } = v(A, "a")
					return r.match(A, { id, grp: id, kind: 1 }).find({ id })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x"), on(D, "id"))])
		}
		case "unkeyed": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { grp } = v(A, "a")
					return r.match(A, { grp, v: 1 }).find({ id: grp })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x"), on(D, "id"))])
		}
		case "unbounded": {
			const D = derived(
				"D",
				query(root).rule((r) => {
					const { id } = v(A, "a")
					return r.match(A, { id, txt: "a" }).find({ id })
				})
			)
			return schema.extend(root, name, { S, D }, [contained(on(S, "x"), on(D, "id"))])
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
 * candidate key, the keys added by a migration beside, or with, the lowering's UNIQUE over a superkey of them
 * (keysLater); or from other candidate keys inside that superkey, replaced by a migration after the lowering's UNIQUE
 * was created (keyChanged).
 */
export const histories = ["aboveLater", "keysLater", "keyChanged"] as const

export type History = (typeof histories)[number]

/** How an installation reached its schema: in one first migration (fresh), or through a history. */
export const orders = ["fresh", ...histories] as const

export type Order = (typeof orders)[number]

/** The version a history migrates from to the schema of `shape` under `name`. */
export const firstVersion = (history: History, shape: Shape, name: string): unknown => {
	switch (history) {
		case "aboveLater":
			return rootOf(name)
		case "keysLater":
			return overRootStatements(succeeded(schemaDescIn(loweringSchema(shape, name))), [])
		case "keyChanged":
			return overRootStatements(
				succeeded(schemaDescIn(loweringSchema(shape, name))),
				succeeded(schemaDescIn(otherRoot(name))).statements
			)
	}
}
