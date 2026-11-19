/** What the properties of rule-query-shapes.test.ts read: its spaces, models and helpers. */

import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Data } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, contained, derived, on, relation, schema, select } from "#compiler/public/schema.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import { nonEmpty } from "#test/support/assert.ts"

/** A resource type's code: an item's, or a web content's. */
const ITEM = 1

const WEB = 2

const ResourceHref = relation(
	"ResourceHref",
	{ node: pg.integer, path: pg.integer, internal: pg.boolean },
	["node"]
)

const ResourceTyped = relation("ResourceTyped", { node: pg.integer, type: pg.integer }, ["node"])

const Entry = relation("Entry", { path: pg.integer }, ["path"])

const LomObject = relation("LomObject", { node: pg.integer, path: pg.integer, type: pg.integer }, [
	"node"
])

const LomTitle = relation("LomTitle", { id: pg.integer, record: pg.integer }, ["id"])

const RecordObject = relation("RecordObject", { record: pg.integer }, ["record"])

const ObjectTitle = relation("ObjectTitle", { record: pg.integer }, ["record"])

const VariableRef = relation("VariableRef", { node: pg.integer, held: pg.boolean }, ["node"])

const Expression = relation(
	"Expression",
	{ id: pg.integer, parent: pg.integer, held: pg.boolean },
	["id"]
)

const HeldType = relation("HeldType", { node: pg.integer }, ["node"])

const Item = relation("Item", { id: pg.integer, k: pg.integer }, ["id"])

const ItemKey = relation("ItemKey", { k: pg.integer }, ["k"])

const Flag = relation("Flag", { id: pg.integer }, ["id"])

/** The schema under `name`: the four shapes' stored relations, their queries derived live, and the rules over them. */
export const shapes = (name: string) => {
	const Base = schema(
		name,
		[
			ResourceHref,
			ResourceTyped,
			Entry,
			LomObject,
			LomTitle,
			RecordObject,
			ObjectTitle,
			VariableRef,
			Expression,
			HeldType,
			Item,
			ItemKey,
			Flag
		],
		[]
	)
	const TypedHref = derived(
		"TypedHref",
		query(Base).rule((r) => {
			const { node, path, internal } = v(ResourceHref, "h")
			const { type } = v(ResourceTyped, "t")
			return r
				.match(ResourceHref, { node, path, internal })
				.match(ResourceTyped, { node, type })
				.find({ node, path, internal, type })
		})
	)
	const TitledObject = derived(
		"TitledObject",
		query(Base).rule((r) => {
			const { record } = v(LomTitle, "t")
			return r.match(LomTitle, { record }).match(RecordObject, { record }).find({ record })
		})
	)
	const HeldSetter = derived(
		"HeldSetter",
		query(Base).rule((r) => {
			const { node } = v(VariableRef, "r")
			return r
				.match(VariableRef, { node, held: true })
				.match(Expression, { parent: node, held: true })
				.find({ node })
		})
	)
	const Unmatched = derived(
		"Unmatched",
		query(Base).rule((r) => {
			const { id, k } = v(Item, "i")
			return r.match(Item, { id, k }).where(r.not(ItemKey, { k })).find({ id })
		})
	)
	return schema.extend(
		Base,
		`${name}_1`,
		[TypedHref, TitledObject, HeldSetter, Unmatched],
		[
			check("DocumentEntry", TypedHref, (t) =>
				t.not(t.and(t.eq(t.type, ITEM), t.eq(t.internal, false)))
			),
			contained(
				on(
					select(TypedHref, (t) => t.eq(t.type, ITEM)),
					"path"
				),
				on(Entry, "path")
			),
			contained(on(LomObject, "node", "path", "type"), on(TypedHref, "node", "path", "type")),
			contained(on(TitledObject, "record"), on(ObjectTitle, "record")),
			contained(on(HeldSetter, "node"), on(HeldType, "node")),
			contained(on(Unmatched, "id"), on(Flag, "id"))
		]
	)
}

export const RELATIONS = nonEmpty([
	"ResourceHref",
	"ResourceTyped",
	"Entry",
	"LomObject",
	"LomTitle",
	"RecordObject",
	"ObjectTitle",
	"VariableRef",
	"Expression",
	"HeldType",
	"Item",
	"ItemKey",
	"Flag"
])

export const rules = [
	"DocumentEntry",
	"documentHrefs",
	"lomObject",
	"titledObject",
	"heldSetter",
	"unmatched"
] as const

export type Rule = (typeof rules)[number]

/** The rule an outcome's law is, by what it states. */
export const ruleOf = (law: Law): Rule | undefined => {
	switch (law.kind) {
		case "check":
			return law.name === "DocumentEntry" ? "DocumentEntry" : undefined
		case "contained":
			return law.from.relation === "TypedHref"
				? "documentHrefs"
				: law.from.relation === "LomObject"
					? "lomObject"
					: law.from.relation === "TitledObject"
						? "titledObject"
						: law.from.relation === "HeldSetter"
							? "heldSetter"
							: law.from.relation === "Unmatched"
								? "unmatched"
								: undefined
		case "contract":
		case "coverage":
		case "family":
		case "above":
		case "fold":
		case "generated":
		case "key":
		case "pattern":
		case "primaryKey":
		case "tree":
			return undefined
	}
}

/** A resource's href: none, or its path and whether it is internal. */
type Href =
	| { readonly kind: "none" }
	| { readonly kind: "at"; readonly path: number; readonly internal: boolean }

/** One state of one shape, as drawn. */
type Sketch =
	| {
			readonly shape: "typedHref"
			readonly href: Href
			/** The resource's type: none, or the code it spells. */
			readonly typed: number | "none"
			/** Whether Entry holds path 1 and path 2. */
			readonly entries: readonly [boolean, boolean]
			/** The resource's LomObject: none, or its type at path 1. */
			readonly lom: number | "none"
	  }
	| {
			readonly shape: "titledObject"
			/** For records 1 and 2: whether it has a title, names an object, and has that object's title. */
			readonly records: ReadonlyArray<{
				readonly titled: boolean
				readonly object: boolean
				readonly objectTitle: boolean
			}>
	  }
	| {
			readonly shape: "heldSetter"
			/** Node 1's variable reference: none, or whether it holds a type. */
			readonly ref: boolean | "none"
			readonly expressions: ReadonlyArray<{ readonly parent: number; readonly held: boolean }>
			readonly heldType: boolean
	  }
	| {
			readonly shape: "unmatched"
			/** Items 1 and 2: absent, or the k each holds. */
			readonly items: ReadonlyArray<number | "none">
			/** Whether ItemKey holds k 1 and k 2. */
			readonly keys: readonly [boolean, boolean]
			/** Whether Flag holds item 1 and item 2. */
			readonly flags: readonly [boolean, boolean]
	  }

const typeGen: Gen<number | "none"> = element(["none", ITEM, WEB] as const)

const pairGen: Gen<readonly [boolean, boolean]> = (s) => [s.draw(boolean), s.draw(boolean)]

export const sketchGen: Gen<Sketch> = (s) => {
	const shape = s.draw(element(["typedHref", "titledObject", "heldSetter", "unmatched"] as const))
	switch (shape) {
		case "typedHref":
			return {
				shape,
				href: s.draw(boolean)
					? { kind: "at", path: s.draw(int(1, 2)), internal: s.draw(boolean) }
					: { kind: "none" },
				typed: s.draw(typeGen),
				entries: s.draw(pairGen),
				lom: s.draw(typeGen)
			}
		case "titledObject":
			return {
				shape,
				records: Arr.map([1, 2], () => ({
					titled: s.draw(boolean),
					object: s.draw(boolean),
					objectTitle: s.draw(boolean)
				}))
			}
		case "heldSetter":
			return {
				shape,
				ref: s.draw(element(["none", false, true] as const)),
				expressions: s.draw(
					array((x) => ({ parent: x.draw(int(1, 2)), held: x.draw(boolean) }), { min: 0, max: 2 })
				),
				heldType: s.draw(boolean)
			}
		case "unmatched":
			return {
				shape,
				items: Arr.map([1, 2], () => s.draw(element(["none", 1, 2] as const))),
				keys: s.draw(pairGen),
				flags: s.draw(pairGen)
			}
	}
}

/** Every rule the sketch's state breaks. */
export const brokenOf = (sketch: Sketch): ReadonlyArray<Rule> => {
	switch (sketch.shape) {
		case "typedHref": {
			const { href, typed, entries, lom } = sketch
			const join = href.kind === "at" && typed !== "none" ? { ...href, type: typed } : undefined
			return Arr.filter(rules, (rule) => {
				switch (rule) {
					case "DocumentEntry":
						return join?.type === ITEM && !join.internal
					case "documentHrefs":
						return join?.type === ITEM && entries[join.path - 1] !== true
					case "lomObject":
						return lom !== "none" && !(join?.path === 1 && join.type === lom)
					case "titledObject":
					case "heldSetter":
					case "unmatched":
						return false
				}
			})
		}
		case "titledObject":
			return Arr.some(sketch.records, (r) => r.titled && r.object && !r.objectTitle)
				? ["titledObject"]
				: []
		case "heldSetter":
			return sketch.ref === true &&
				Arr.some(sketch.expressions, (e) => e.parent === 1 && e.held) &&
				!sketch.heldType
				? ["heldSetter"]
				: []
		case "unmatched":
			return Arr.some(
				sketch.items,
				(k, i) => k !== "none" && sketch.keys[k - 1] !== true && sketch.flags[i] !== true
			)
				? ["unmatched"]
				: []
	}
}

/** The rows a state holds of each relation. */
interface Rows {
	readonly ResourceHref: ReadonlyArray<{ node: number; path: number; internal: boolean }>
	readonly ResourceTyped: ReadonlyArray<{ node: number; type: number }>
	readonly Entry: ReadonlyArray<{ path: number }>
	readonly LomObject: ReadonlyArray<{ node: number; path: number; type: number }>
	readonly LomTitle: ReadonlyArray<{ id: number; record: number }>
	readonly RecordObject: ReadonlyArray<{ record: number }>
	readonly ObjectTitle: ReadonlyArray<{ record: number }>
	readonly VariableRef: ReadonlyArray<{ node: number; held: boolean }>
	readonly Expression: ReadonlyArray<{ id: number; parent: number; held: boolean }>
	readonly HeldType: ReadonlyArray<{ node: number }>
	readonly Item: ReadonlyArray<{ id: number; k: number }>
	readonly ItemKey: ReadonlyArray<{ k: number }>
	readonly Flag: ReadonlyArray<{ id: number }>
}

const empty: Rows = {
	ResourceHref: [],
	ResourceTyped: [],
	Entry: [],
	LomObject: [],
	LomTitle: [],
	RecordObject: [],
	ObjectTitle: [],
	VariableRef: [],
	Expression: [],
	HeldType: [],
	Item: [],
	ItemKey: [],
	Flag: []
}

/** The 1-based numbers whose flag is set. */
const numbered = (flags: ReadonlyArray<boolean>): ReadonlyArray<number> =>
	Arr.flatMap(flags, (set, i) => (set ? [i + 1] : []))

/** The rows of every relation the sketch's state holds. */
export const rowsOf = (sketch: Sketch): Rows => {
	switch (sketch.shape) {
		case "typedHref": {
			const { href, typed, entries, lom } = sketch
			return {
				...empty,
				ResourceHref:
					href.kind === "at" ? [{ node: 1, path: href.path, internal: href.internal }] : [],
				ResourceTyped: typed === "none" ? [] : [{ node: 1, type: typed }],
				Entry: Arr.map(numbered(entries), (path) => ({ path })),
				LomObject: lom === "none" ? [] : [{ node: 1, path: 1, type: lom }]
			}
		}
		case "titledObject":
			return {
				...empty,
				LomTitle: Arr.flatMap(sketch.records, (r, i) =>
					r.titled ? [{ id: i + 1, record: i + 1 }] : []
				),
				RecordObject: Arr.map(numbered(Arr.map(sketch.records, (r) => r.object)), (record) => ({
					record
				})),
				ObjectTitle: Arr.map(numbered(Arr.map(sketch.records, (r) => r.objectTitle)), (record) => ({
					record
				}))
			}
		case "heldSetter":
			return {
				...empty,
				VariableRef: sketch.ref === "none" ? [] : [{ node: 1, held: sketch.ref }],
				Expression: Arr.map(sketch.expressions, (e, i) => ({ id: i + 1, ...e })),
				HeldType: sketch.heldType ? [{ node: 1 }] : []
			}
		case "unmatched":
			return {
				...empty,
				Item: Arr.flatMap(sketch.items, (k, i) => (k === "none" ? [] : [{ id: i + 1, k }])),
				ItemKey: Arr.map(numbered(sketch.keys), (k) => ({ k })),
				Flag: Arr.map(numbered(sketch.flags), (id) => ({ id }))
			}
	}
}

/** The full role's workload: the ChangeSet inserting every row of a state, each relation's from its call's facts. */
export const programsOf = (value: ReturnType<typeof shapes>) => ({
	insertAll: ChangeSet.empty(value)
		.insert(ResourceHref, [])
		.insert(ResourceTyped, [])
		.insert(Entry, [])
		.insert(LomObject, [])
		.insert(LomTitle, [])
		.insert(RecordObject, [])
		.insert(ObjectTitle, [])
		.insert(VariableRef, [])
		.insert(Expression, [])
		.insert(HeldType, [])
		.insert(Item, [])
		.insert(ItemKey, [])
		.insert(Flag, [])
})

type Shape = Sketch["shape"]

export type Feature =
	| `${Shape}: accepted`
	| `refused by ${Rule}`
	| "a setter with two held expressions forces one held type"
	| "a typed href's lom object accepted"

export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

export const declared = shapes("RuleShapes")
