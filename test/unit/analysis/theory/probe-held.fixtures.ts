/** What the properties of probe-held.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { exact } from "@bjornpagen/testing/oracle"
import { Array as Arr, Option, Record as Rec } from "effect"
import { clockOrders, probeRows, proofsOf } from "#compiler/analysis/theory/query.ts"
import type { InferredExpr, InferredQuery, InferredRule } from "#compiler/ir/desc.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, mutable, on, relation, schema, unit } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { probedRule } from "#test/support/probed.ts"

/** How D's match of T binds k2: by a variable of its own, by a literal, or not at all. */
type KeyBinding = "variable" | "literal" | "free"

/** How D's match of T binds b: by a literal, by a variable S's a shares, or not at all. */
type ValueBinding = "literal" | "shared" | "free"

/** One drawn rule: T's key, how D's match of T binds each field, and whether D reads T a second time. */
interface Shape {
	readonly composite: boolean
	readonly k2: KeyBinding
	readonly aDelivered: boolean
	readonly b: ValueBinding
	readonly second: boolean
}

export const shapeGen: Gen<Shape> = (s) => ({
	composite: s.draw(boolean),
	k2: s.draw(element<KeyBinding>(["variable", "literal", "free"])),
	aDelivered: s.draw(boolean),
	b: s.draw(element<ValueBinding>(["literal", "shared", "free"])),
	second: s.draw(boolean)
})

export type Feature =
	| "a composite key"
	| "a key field bound by a literal"
	| "a non-key field held by a literal binding"
	| "a non-key field held by a variable another match binds"
	| "a second occurrence of the touched relation"

export const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"a composite key",
	"a key field bound by a literal",
	"a non-key field held by a literal binding",
	"a non-key field held by a variable another match binds",
	"a second occurrence of the touched relation"
]

/** The schema of a shape: T, S and G on a base level, D over them and its containment in G above. */
const schemaOf = (shape: Shape) => {
	const T = relation(
		"T",
		{ k1: int4, k2: int4, a: int4, b: int4 },
		shape.composite ? ["k1", "k2"] : ["k1"]
	)
	const S = relation("S", { id: int4, a: int4 }, ["id"])
	const G = relation("G", { x: int4 }, ["x"])
	/** Mutable, each under the unit of its key's first field, so the containment over them is no unit-local rule but a
	 * probed one, whose probes the test reads. */
	const Base = schema(
		"probe_held",
		[T, S, G],
		[
			unit("Ts", { k1: int4 }),
			unit("Ss", { id: int4 }),
			unit("Gs", { x: int4 }),
			mutable(T),
			mutable(S),
			mutable(G)
		]
	)
	const D = derived(
		"D",
		query(Base).rule((r) => {
			const { k1, k2, a, b } = v(T, "t")
			const { id } = v(S, "s")
			const second = v(T, "u")
			const k2Bound = shape.k2 === "variable" ? { k2 } : shape.k2 === "literal" ? { k2: 1 } : {}
			const aBound = shape.aDelivered ? { a } : { a: 2 }
			const bBound = shape.b === "literal" ? { b: 3 } : shape.b === "shared" ? { b } : {}
			const first = r.match(T, { k1, ...k2Bound, ...aBound, ...bBound })
			const joined = shape.b === "shared" ? first.match(S, { id, a: b }) : first
			const both = shape.second
				? joined.match(T, { k1: second.k1, a: shape.aDelivered ? a : 2 })
				: joined
			return both.find({ x: shape.aDelivered ? a : k1 })
		})
	)
	return schema.extend([Base], "probe_held_1", [D], [contained(on(D, "x"), on(G, "x"))])
}

/** Whether two terms are the same term, by structural equality (exact). */
const sameTerm = (a: InferredExpr, b: InferredExpr): boolean => Option.isNone(exact(a, b))

/** A condition as its conjuncts, every conjunction in it opened. */
const conjuncts = (e: InferredExpr): ReadonlyArray<InferredExpr> =>
	e.kind === "and" ? Arr.flatMap(e.args, conjuncts) : [e]

/** A rule's conditions, every conjunction opened. */
const conditionsOf = (rule: InferredRule): ReadonlyArray<InferredExpr> =>
	Arr.flatMap(rule.where, conjuncts)

/** The field of the touched row the region variable `e` reads, if it is one: the field `region` binds it at. */
const regionFieldOf = (
	region: Readonly<Record<string, InferredExpr>>,
	e: InferredExpr
): string | undefined =>
	e.kind === "var"
		? Option.getOrUndefined(
				Arr.findFirst(Rec.toEntries(region), ([, r]) => r.kind === "var" && r.var === e.var)
			)?.[0]
		: undefined

/** Whether `bound`, a binding of `field` in `rule`, is held at the region's value of `field`: bound to it, or equated with it. */
const heldAt = (
	region: Readonly<Record<string, InferredExpr>>,
	rule: InferredRule,
	field: string,
	bound: InferredExpr
): boolean =>
	regionFieldOf(region, bound) === field ||
	Arr.some(
		conditionsOf(rule),
		(c) =>
			c.kind === "compare" &&
			c.op === "eq" &&
			((regionFieldOf(region, c.right) === field && sameTerm(c.left, bound)) ||
				(regionFieldOf(region, c.left) === field && sameTerm(c.right, bound)))
	)

/** Every rule a query holds: its own, and those of every query a match or a negation of one imports. */
const rulesOf = (q: InferredQuery): ReadonlyArray<InferredRule> => {
	const stage = q.stage
	const arms: ReadonlyArray<InferredRule> =
		stage.kind === "rules"
			? stage.arms
			: stage.kind === "union"
				? [...rulesOf({ ...q, stage: stage.input }), ...stage.arms]
				: stage.kind === "recursive"
					? [...stage.recursive.base, ...stage.recursive.rec]
					: rulesOf({ ...q, stage: stage.input })
	return Arr.flatMap(arms, (rule) => [
		rule,
		...Arr.flatMap(rule.matches, (m) =>
			m.source.kind === "query" || m.source.kind === "step" ? rulesOf(m.source.query) : []
		),
		...Arr.flatMap(conditionsOf(rule), (c) =>
			c.kind === "absent" && (c.source.kind === "query" || c.source.kind === "step")
				? rulesOf(c.source.query)
				: []
		)
	])
}

/** The matches of `relation` held at the region's value of every key field, by the rule that holds each, in `q`. */
const heldMatches = (
	region: Readonly<Record<string, InferredExpr>>,
	q: InferredQuery,
	relation: string,
	key: ReadonlyArray<string>
): ReadonlyArray<InferredRule> =>
	Arr.flatMap(rulesOf(q), (rule) =>
		Arr.some(
			rule.matches,
			(m) =>
				m.source.kind === "relation" &&
				m.source.name === relation &&
				Arr.every(key, (f) => {
					const bound = m.bindings[f]
					return bound !== undefined && heldAt(region, rule, f, bound)
				})
		)
			? [rule]
			: []
	)

/** Judges every probe of the added side of every rule trigger's table of `shape`'s schema. */
export const judged = (shape: Shape, note: (f: Feature) => void): void => {
	const artifacts = succeeded(testArtifacts(schemaOf(shape), testCompile))
	const rule = defined(artifacts.laws.rules[0], "the containment held by its triggers")
	for (const table of rule.tables) {
		const rel = table.relation
		const key = Arr.map(rel.primaryFields, (f) => f.name)
		const read =
			table.touches.kind === "removed"
				? []
				: probeRows(
						probedRule(rule.rule),
						rel.name,
						"added",
						proofsOf(
							artifacts.laws.theory.regionFacts,
							(relation) => artifacts.laws.theory.relations[relation],
							clockOrders(artifacts.laws.theory.instants)
						),
						rule.law.loc
					)
		for (const within of read) {
			const probe: InferredQuery = { stage: { kind: "rules", arms: [within], loc: within.loc } }
			const region = defined(within.matches[0], "a probe's region, its first match")
			assert.deepEqual(
				region.source,
				{ kind: "delta", side: "added", relation: rel.name },
				`a probe of the rows the transaction adds to ${rel.name} reads them first, as the net write's delta.added`
			)
			assert.deepEqual(
				heldMatches(region.bindings, probe, rel.name, key),
				[],
				`a probe of ${rel.name} reads no match of it at the region's key: the row is read from the transaction's net write, never again from its table`
			)
			for (const [field, bound] of Rec.toEntries(region.bindings)) {
				assert.equal(
					regionFieldOf(region.bindings, bound),
					field,
					`the region binds ${rel.name}.${field} to a variable of its own`
				)
			}
			if (rel.name === "T") {
				assert.ok(
					region.bindings["k1"] !== undefined,
					"the region binds T.k1, which every occurrence of T reads, so the probe reads the row's key from the net write"
				)
				if (
					(shape.b === "literal" && region.bindings["b"] !== undefined) ||
					(!shape.aDelivered && region.bindings["a"] !== undefined)
				) {
					note("a non-key field held by a literal binding")
				}
				if (shape.b === "shared" && region.bindings["b"] !== undefined) {
					note("a non-key field held by a variable another match binds")
				}
			}
		}
	}
	if (shape.composite) {
		note("a composite key")
		if (shape.k2 === "literal") {
			note("a key field bound by a literal")
		}
	}
	if (shape.second) {
		note("a second occurrence of the touched relation")
	}
}
