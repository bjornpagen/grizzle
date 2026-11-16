/**
 * A rule's NEW probe re-reads the row its write touched by everything it knows of it (analysis/theory/query.ts
 * newProbes): each occurrence of the touched relation a probe holds to the row, at NEW's primary key, is held at NEW's
 * value in every column it reads, so no index PostgreSQL takes reads more of the relation than rows that agree with the
 * touched one on every such column; and the probe's index requests come from the same probe held by its key alone
 * (Probe `requested`), so holding the row by its values asks for no index.
 *
 * Each case draws a rule over a query: a containment of a derived relation D of T, optionally joined with S, in a
 * stored G. T is keyed by k1, or by (k1, k2); D's match of T binds k1 by a variable, k2 by a variable, a literal or not
 * at all, a by the variable D delivers or by a literal, and b by a literal, by a variable it shares with S's a, or not
 * at all, and may match T a second time by a alone. The schema compiles to its law model (test/support/compile.ts
 * testArtifacts), and every rule trigger's table yields its NEW probes (newProbes, as physical/ddl/rules.ts calls it).
 *
 * Oracle: specification, read over the probe IR before any SQL. A match of the touched relation is held where each of
 * its key fields is bound to the parameter that reads NEW's value of that field (Probe `params`), or equated with it
 * by a condition of its rule. In `query` every field a held match binds is so held; in `requested` its key fields are
 * and no other field is. Every probe of a drawn rule holds one match, since no drawn rule negates.
 *
 * Features: a composite key, a key field bound by a literal, a non-key field held by a literal binding, one held by a
 * variable another match binds, and a second occurrence of the touched relation.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { exact } from "@bjornpagen/testing/oracle"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { newProbes, type Probe, type TouchedField } from "#compiler/analysis/theory/query.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { InferredExpr, InferredQuery, InferredRule } from "#compiler/ir/desc.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"

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

const shapeGen: Gen<Shape> = (s) => ({
	composite: s.draw(boolean),
	k2: s.draw(element<KeyBinding>(["variable", "literal", "free"])),
	aDelivered: s.draw(boolean),
	b: s.draw(element<ValueBinding>(["literal", "shared", "free"])),
	second: s.draw(boolean)
})

type Feature =
	| "a composite key"
	| "a key field bound by a literal"
	| "a non-key field held by a literal binding"
	| "a non-key field held by a variable another match binds"
	| "a second occurrence of the touched relation"

const features: Arr.NonEmptyReadonlyArray<Feature> = [
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
		{ k1: pg.integer, k2: pg.integer, a: pg.integer, b: pg.integer },
		shape.composite ? ["k1", "k2"] : ["k1"]
	)
	const S = relation("S", { id: pg.integer, a: pg.integer }, ["id"])
	const G = relation("G", { x: pg.integer }, ["x"])
	const Base = schema("probe_held", [T, S, G], [])
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
	return schema.extend(Base, "probe_held_1", [D], [contained(on(D, "x"), on(G, "x"))])
}

/** The parameter `e` reads NEW's value of, if it is one. */
const newFieldOf = (probe: Probe, e: InferredExpr): string | undefined => {
	if (e.kind !== "param") {
		return undefined
	}
	const read = probe.params.get(e.name)
	return read?.record === "NEW" ? read.field : undefined
}

/** Whether two terms are the same term, by structural equality (exact). */
const sameTerm = (a: InferredExpr, b: InferredExpr): boolean => Option.isNone(exact(a, b))

/** A condition as its conjuncts, every conjunction in it opened. */
const conjuncts = (e: InferredExpr): ReadonlyArray<InferredExpr> =>
	e.kind === "and" ? Arr.flatMap(e.args, conjuncts) : [e]

/** A rule's conditions, every conjunction opened. */
const conditionsOf = (rule: InferredRule): ReadonlyArray<InferredExpr> =>
	Arr.flatMap(rule.where, conjuncts)

/** Whether `bound`, a binding of `field` in `rule`, is held at NEW's value of `field`: bound to it, or equated with it. */
const heldAt = (probe: Probe, rule: InferredRule, field: string, bound: InferredExpr): boolean =>
	newFieldOf(probe, bound) === field ||
	Arr.some(
		conditionsOf(rule),
		(c) =>
			c.kind === "compare" &&
			c.op === "eq" &&
			((newFieldOf(probe, c.right) === field && sameTerm(c.left, bound)) ||
				(newFieldOf(probe, c.left) === field && sameTerm(c.right, bound)))
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

/** The fields each held match of `relation` binds, by the rule that holds it, in `q`. */
const heldMatches = (
	probe: Probe,
	q: InferredQuery,
	relation: string,
	key: ReadonlyArray<TouchedField>
): ReadonlyArray<{
	readonly rule: InferredRule
	readonly bindings: Readonly<Record<string, InferredExpr>>
}> =>
	Arr.flatMap(rulesOf(q), (rule) =>
		Arr.flatMap(rule.matches, (m) =>
			m.source.kind === "relation" &&
			m.source.name === relation &&
			Arr.every(key, (f) => {
				const bound = m.bindings[f.name]
				return bound !== undefined && heldAt(probe, rule, f.name, bound)
			})
				? [{ rule, bindings: m.bindings }]
				: []
		)
	)

/** Judges every NEW probe of every rule trigger's table of `shape`'s schema. */
const judged = (shape: Shape, note: (f: Feature) => void): void => {
	const artifacts = succeeded(testArtifacts(schemaOf(shape), testCompile))
	const rule = defined(artifacts.laws.rules[0], "the containment held by its triggers")
	for (const table of rule.tables) {
		const rel = table.relation
		const key = mapNonEmpty(rel.primaryFields, (f): TouchedField => ({
			name: f.name,
			desc: f.desc
		}))
		const fields = Arr.map(rel.fields, (f): TouchedField => ({ name: f.name, desc: f.desc }))
		const keyNames = new Set(Arr.map(key, (f) => f.name))
		const probes =
			table.touches.kind === "olds" ? [] : newProbes(rule.rule, rel.name, key, fields, rule.law.loc)
		for (const probe of probes) {
			const held = heldMatches(probe, probe.query, rel.name, key)
			assert.ok(held.length > 0, `a NEW probe of ${rel.name} holds a match of it`)
			for (const { rule: within, bindings } of held) {
				for (const [field, bound] of Rec.toEntries(bindings)) {
					assert.ok(
						heldAt(probe, within, field, bound),
						`${rel.name}.${field}, which the held match reads, is held at NEW's value`
					)
					if (rel.name === "T" && !keyNames.has(field) && bound.kind === "literal") {
						note("a non-key field held by a literal binding")
					}
					if (rel.name === "T" && field === "b" && shape.b === "shared") {
						note("a non-key field held by a variable another match binds")
					}
				}
			}
			const requested = heldMatches(probe, probe.requested, rel.name, key)
			assert.ok(
				requested.length > 0,
				`the probe ${rel.name}'s indexes are requested by holds a match of it`
			)
			for (const { rule: within, bindings } of requested) {
				for (const [field, bound] of Rec.toEntries(bindings)) {
					assert.equal(
						heldAt(probe, within, field, bound),
						keyNames.has(field),
						`${rel.name}.${field} is held in the probe its indexes are requested by exactly where it is a key field`
					)
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

describe("a rule's NEW probe", () => {
	it.effect(
		"holds the touched row at NEW's value in every column it reads, and requests its indexes by the key alone",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "a held match of the touched relation, read over the probe IR: every field it binds held at NEW's value in the probe, its key fields alone in the probe its indexes are requested by"
						},
						suite: "unit/analysis/theory/probe-held",
						draw: drawn(shapeGen),
						literal: Formatter.format,
						coverage: required<Feature>(features, { cases: 60, sense: notesOnly }),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					(shape, c) => Effect.sync(() => judged(shape, c.note))
				)
			)
	)
})
