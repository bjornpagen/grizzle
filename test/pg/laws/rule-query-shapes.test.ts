/**
 * The downstream shapes of rules over queries on PostgreSQL 19rc2, kept beside the search of rule-query.test.ts: each
 * exhausted over a box of states, every state written whole by a served ChangeSet of grizzle's into empty tables.
 *
 * - **A join as a rule's side**, a typed href: ResourceHref ⋈ ResourceTyped on node is TypedHref, a live derived
 *   relation in place of a stored copy kept in step by containments both ways. A check over it (an item's href is
 *   internal), a selection of it contained in Entry (an item's href names an entry), and LomObject contained in it.
 * - **A semijoin as a containment's source**, a title of a record that names an object: LomTitle ⋉ RecordObject on
 *   record is contained in ObjectTitle, so a title of a record that names none forces nothing.
 * - **A semijoin of two selections**, a held type: the variable references that hold a type ⋉ the held expressions
 *   under them on node, projected on node, is contained in HeldType, so a setter with two held expressions forces one
 *   row and a setter with none forces none.
 * - **An anti-join as a containment's source**, a probe row: the items no key holds a k for are contained in Flag.
 *
 * The oracle is each rule restated over the rows: a write is accepted exactly when its state keeps every rule, and
 * refused `invariant-rejected` otherwise, naming rules the state breaks, its witness `unreported`. The box is every
 * state of each shape over one or two nodes, records, items and keys, which reaches each rule broken alone.
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Layer } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, contained, derived, on, relation, schema, select } from "#compiler/public/schema.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import { cleared, seatOfInstalled } from "#test/pg/fin/installed.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { nonEmpty } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { servedFixture } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

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
const shapes = (name: string) => {
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

const RELATIONS = nonEmpty([
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

const rules = [
	"DocumentEntry",
	"documentHrefs",
	"lomObject",
	"titledObject",
	"heldSetter",
	"unmatched"
] as const
type Rule = (typeof rules)[number]

/** The rule an outcome's law is, by what it states. */
const ruleOf = (law: Law): Rule | undefined => {
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

const sketchGen: Gen<Sketch> = (s) => {
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
const brokenOf = (sketch: Sketch): ReadonlyArray<Rule> => {
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
const rowsOf = (sketch: Sketch): Rows => {
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
const programsOf = (value: ReturnType<typeof shapes>) => ({
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
type Feature =
	| `${Shape}: accepted`
	| `refused by ${Rule}`
	| "a setter with two held expressions forces one held type"
	| "a typed href's lom object accepted"

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

layer(Substrate.layer, { excludeTestServices: true })(
	"downstream's rules over queries on PostgreSQL 19rc2",
	(it) => {
		it.effect(
			"accept exactly the states of each downstream shape that keep its rules, refusing the rest naming a rule they break",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const declared = shapes("RuleShapes")
						const done = yield* installMigrated(declared, {
							ambient: ordinarySession,
							label: "rule_shapes",
							logins: [fullWorld(declared, {}).server],
							extensions: []
						})
						const value = shapes(done.schema)
						const world = fullWorld(value, programsOf(value))
						const seat = yield* seatOfInstalled(done, RELATIONS, "rule_shapes")
						const served = yield* servedFixture(done, world.server)
						const context = yield* Layer.build(served.layer)
						const db = yield* Db.open(served.login.roles.app, {}).pipe(
							Effect.provideContext(context)
						)
						return yield* exhaust(
							{
								suite: "laws/rule-query-shapes",
								generator: sketchGen,
								literal: Formatter.format,
								box: "every state of a typed href over one resource, two paths and two types, of titles over two records, of a held type over one setter with up to two expressions under two nodes, and of probe rows over two items and two keys",
								oracle: {
									kind: "specification",
									name: "each downstream rule restated over the rows: a state is accepted exactly when it keeps every rule"
								},
								coverage: requiredInSpace<Feature>(
									nonEmpty([
										"typedHref: accepted",
										"titledObject: accepted",
										"heldSetter: accepted",
										"unmatched: accepted",
										...Arr.map(rules, (r) => `refused by ${r}` as const),
										"a setter with two held expressions forces one held type",
										"a typed href's lom object accepted"
									])
								),
								caseHang,
								concurrency: 1
							},
							(sketch, c) =>
								Effect.gen(function* () {
									yield* cleared(seat, RELATIONS)
									const rows = rowsOf(sketch)
									const outcome = yield* answered(
										db.workload.insertAll.once({ params: {}, facts: { insert: rows } })
									)
									const breaks = brokenOf(sketch)
									if (outcome.kind === "accepted" || outcome.kind === "unchanged") {
										if (breaks.length > 0) {
											return yield* new Disagreed({
												message: `accepted a state breaking ${Arr.join(breaks, ", ")}: ${Formatter.format(sketch)}`
											})
										}
										c.note(`${sketch.shape}: accepted`)
										if (
											sketch.shape === "heldSetter" &&
											sketch.heldType &&
											Arr.filter(sketch.expressions, (e) => e.parent === 1 && e.held).length === 2
										) {
											c.note("a setter with two held expressions forces one held type")
										}
										if (sketch.shape === "typedHref" && sketch.lom !== "none") {
											c.note("a typed href's lom object accepted")
										}
										return
									}
									const named =
										outcome.kind === "refused" ? Arr.map(refusedLaws(outcome.refused), ruleOf) : []
									const broke = (r: Rule | undefined): r is Rule =>
										r !== undefined && breaks.includes(r)
									if (
										outcome.kind !== "refused" ||
										outcome.witness.kind !== "unreported" ||
										!(outcome.refused.kind === "some"
											? Arr.some(named, broke)
											: Arr.isReadonlyArrayNonEmpty(named) && Arr.every(named, broke))
									) {
										return yield* new Disagreed({
											message: `answered ${Formatter.format(outcome)} where the state breaks ${Arr.join(breaks, ", ") || "nothing"}: ${Formatter.format(sketch)}`
										})
									}
									for (const r of Arr.filter(named, broke)) {
										c.note(`refused by ${r}`)
									}
								})
						)
					})
				)
		)
	}
)
