/**
 * A fixed target's UNIQUE beside the reverse probes out of its selection, in the index set the installation plans. A
 * fixed target, a containment's target whose selection fixes a field beyond its terms, is held by a key K of its
 * relation over a selection within its own, K's terms among its terms and that field, and K implies two UNIQUEs a
 * reference into it may land on: one over its terms and the fixed field, which every target fixing that field to another
 * value shares, and one over its own columns, its terms under its selection, which keeps the fixed field at one value.
 * Where a containment out of the target's selection probes a B-tree that reads every one of the target's own columns,
 * the reference lands on the second, which serves that probe too; elsewhere on the first (laws/model/plan.ts
 * `#reference`).
 *
 * A case draws T(id, a, b, c, kind), keyed by K over every row or over select(T, c = 1), on a and kind, a, or a and b in
 * a drawn order; one to three fixed targets, each select(K's selection and kind = v) over terms that hold K's beyond
 * kind in a drawn order, each the target of a containment from a relation of its own; and up to three containments out
 * of a selection of T, out of select(K's selection and kind = v) for a drawn v or out of K's selection, over a drawn
 * list of id, a and b, each into a relation keyed by exactly its terms.
 *
 * The oracle is the installation's planned index set (Installation.indexes: every index a key installs and every index
 * the install creates), read against the law model's foreign keys and key natives:
 *
 * - no relation holds a redundant pair, an index whose keys lead another's of its relation and access method, key for
 *   key, direction and class alike: the other serves every probe it serves, unless both are unique over two lists, each
 *   holding apart rows the other does not;
 * - every foreign key references the column set of exactly one unique index of its target;
 * - every unique index holds the column set of a key a key law states, or of a foreign key's referenced columns;
 * - an implied key is free where a probe out of a target's selection reads its own columns: the schema with K beside,
 *   for each such target, the key over its selection and terms that K implies (the restated keys a downstream schema
 *   states instead of K) plans T's index set exactly, each index's method, uniqueness and column set.
 *
 * Enforcement is the law suites': test/pg/laws/alternatives.test.ts and the families in test/pg/laws/families draw every
 * arm of one handle, a target its parent's discriminator fixes whose own columns the reverse containment out of the
 * same selection probes, and test/pg/laws/target-keys.test.ts draws such a probe beside every key a target may be held
 * by, over a selection or not, its terms holding a fixed field or not.
 *
 * Plants (~/.cache/grizzle-release/R10/plants): probed-target-shared-always (every fixed target referenced at its terms
 * and fixed field, its UNIQUE never the probe's: caught by the implied key's index set), probed-target-probe-beside
 * (each reverse probe a B-tree of its own beside a unique index that serves it: caught by the redundant pair), and
 * probed-target-unique-dropped (no UNIQUE beside a reference at a target's own columns: caught by the foreign key that
 * references no unique index).
 *
 * Features: a target referenced at its own columns, leading the probe or within it; a target referenced at its terms and
 * fixed field, with no probe out of its selection or a probe missing one of its terms; a probe out of another
 * selection; K over a selection or over every row, its terms holding the fixed field; two targets sharing the UNIQUE
 * over their terms and fixed field; and a target of each reference beside one another.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, shuffled, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, Record as Rec } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { ExprDesc, SideDesc, TermDesc } from "#compiler/ir/desc.ts"
import { nativeColumnText, type NativeObject } from "#compiler/ir/law.ts"
import { sameIndexOpclass } from "#compiler/ir/products.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import type { IndexColumn } from "#compiler/physical/ddl/context.ts"
import type { IndexKey, PlannedIndex } from "#compiler/physical/indexes/engine.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { installationsOf, rostersOf } from "#compiler/schema/own.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import {
	contained,
	eq,
	f,
	field,
	key,
	literal,
	on,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownedInput } from "#test/support/policy.ts"

/** A term of a fixed target, a field of T beside the fixed `kind`. */
type Term = "a" | "b"

/** A term of a probe out of a selection of T. */
type ProbeTerm = "id" | Term

/** A term of K: a target's term, or the field each target fixes. */
type KeyTerm = Term | "kind"

/** The value a target's selection fixes `kind` to. */
type Value = 0 | 1 | 2

const VALUES = [0, 1, 2] as const

/** A fixed target: select(K's selection and kind = value) over its terms. */
interface Target {
	readonly value: Value
	readonly terms: Arr.NonEmptyReadonlyArray<Term>
}

/** Where a probe's containment reads T: a target's selection, at kind = value, or K's own selection. */
type ProbeAt = { readonly kind: "fixed"; readonly value: Value } | { readonly kind: "key" }

/** A containment out of a selection of T over its terms, into a relation keyed by exactly them. */
interface Probe {
	readonly at: ProbeAt
	readonly terms: Arr.NonEmptyReadonlyArray<ProbeTerm>
}

/** A case: K over select(T, c = 1) or over every row, on its terms, the fixed targets, and the probes. */
interface Sketch {
	readonly selected: boolean
	readonly key: Arr.NonEmptyReadonlyArray<KeyTerm>
	readonly targets: Arr.NonEmptyReadonlyArray<Target>
	readonly probes: ReadonlyArray<Probe>
}

/** K's terms: a with the fixed field, or with b, in either order, or a alone. */
const KEYS: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<KeyTerm>> = [
	["a"],
	["a", "kind"],
	["kind", "a"],
	["a", "b"],
	["b", "a"]
]

/** A target's terms, which hold K's beyond the field it fixes, in a drawn order. */
const targetGen =
	(k: Arr.NonEmptyReadonlyArray<KeyTerm>): Gen<Target> =>
	(source) => {
		const terms = k.includes("b")
			? source.draw(
					element<Arr.NonEmptyReadonlyArray<Term>>([
						["a", "b"],
						["b", "a"]
					])
				)
			: source.draw(element<Arr.NonEmptyReadonlyArray<Term>>([["a"], ["a", "b"], ["b", "a"]]))
		return { value: source.draw(element(VALUES)), terms }
	}

const PROBE_TERMS: Arr.NonEmptyReadonlyArray<ProbeTerm> = ["id", "a", "b"]

/** A probe's terms: one of id, a and b first, then some of the others in a drawn order. */
const probeTermsGen: Gen<Arr.NonEmptyReadonlyArray<ProbeTerm>> = (source) => {
	const first = source.draw(element(PROBE_TERMS))
	const others = Arr.filter(PROBE_TERMS, (t) => t !== first)
	return [first, ...source.draw(shuffled(others, { min: 0, max: others.length }))]
}

/** A probe out of a target's selection, out of another selection kind = v, or out of K's. */
const probeGen =
	(targets: Arr.NonEmptyReadonlyArray<Target>): Gen<Probe> =>
	(source) => {
		const at = source.draw(
			weighted<ProbeAt>([
				[3, (s) => ({ kind: "fixed", value: s.draw(element(targets)).value })],
				[1, (s) => ({ kind: "fixed", value: s.draw(element(VALUES)) })],
				[1, () => ({ kind: "key" })]
			])
		)
		return { at, terms: source.draw(probeTermsGen) }
	}

const sketchGen: Gen<Sketch> = (source) => {
	const k = source.draw(element(KEYS))
	const first = source.draw(targetGen(k))
	const more = source.draw(array(targetGen(k), { min: 0, max: 2 }))
	const targets: Arr.NonEmptyReadonlyArray<Target> = [first, ...more]
	return {
		selected: source.draw(boolean),
		key: k,
		targets,
		probes: source.draw(array(probeGen(targets), { min: 0, max: 3 }))
	}
}

/** K's selection: c = 1, or every row. */
const keySelection = (s: Sketch): ReadonlyArray<ExprDesc> =>
	s.selected ? [eq(field("c"), literal(1))] : []

/** A selection of T a probe or a target reads: K's, then kind = value where it fixes kind. */
const selectionAt = (s: Sketch, at: ProbeAt): ReadonlyArray<ExprDesc> =>
	at.kind === "key" ? keySelection(s) : [...keySelection(s), eq(field("kind"), literal(at.value))]

/** A side of T over `terms` under `selection`. */
const sideOfT = (
	selection: ReadonlyArray<ExprDesc>,
	terms: Arr.NonEmptyReadonlyArray<string>
): SideDesc => ({
	relation: "T",
	terms: Arr.map(terms, (t): TermDesc => ({ kind: "field", field: t })),
	selection: { conjuncts: selection }
})

/** A target's side: its terms under K's selection and kind = its value. */
const targetSide = (s: Sketch, t: Target): SideDesc =>
	sideOfT(selectionAt(s, { kind: "fixed", value: t.value }), t.terms)

/** Whether a probe's containment reads a target's selection over every one of its terms. */
const reads = (p: Probe, t: Target): boolean =>
	p.at.kind === "fixed" && p.at.value === t.value && Arr.every(t.terms, (x) => p.terms.includes(x))

/** Whether a probe's terms lead with a target's, in its order. */
const leads = (p: Probe, t: Target): boolean => Arr.every(t.terms, (x, i) => p.terms[i] === x)

/** Whether a probe out of a target's selection reads its own columns, which its reference then lands on. */
const probed = (s: Sketch, t: Target): boolean => Arr.some(s.probes, (p) => reads(p, t))

/** A list of names as one text, in code-unit order: a column set. */
const setText = (names: ReadonlyArray<string>): string =>
	Arr.join(Arr.sort(names, Order.String), ",")

/**
 * The keys K implies that a downstream schema restates instead of K: for each target whose own columns a probe reads,
 * the key over its selection and terms, each selection and term set once.
 */
const restated = (s: Sketch): ReadonlyArray<SideDesc> =>
	Arr.map(
		Arr.dedupeWith(
			Arr.filter(s.targets, (t) => probed(s, t)),
			(x: Target, y: Target) => x.value === y.value && setText(x.terms) === setText(y.terms)
		),
		(t) => targetSide(s, t)
	)

const SOURCE_FIELDS = ["x0", "x1"] as const
const PROBED_FIELDS = ["y0", "y1", "y2"] as const

/** The schema of a case: T, K, each target's containment from U<i>, each probe's into V<j>, and the keys `restating`. */
const schemaOf = (s: Sketch, restating: ReadonlyArray<SideDesc>): SchemaDesc => ({
	name: "ProbedTarget",
	relations: [
		relation("T", { id: f.integer, a: f.integer, b: f.integer, c: f.integer, kind: f.integer }, [
			"id"
		]),
		...Arr.map(s.targets, (_, i) =>
			relation(`U${i}`, { u: f.integer, x0: f.integer, x1: f.integer }, ["u"])
		),
		...Arr.map(s.probes, (p, j) => {
			const fields = Arr.take(PROBED_FIELDS, p.terms.length)
			return relation(
				`V${j}`,
				Rec.fromEntries(Arr.map(fields, (y) => [y, f.integer] as const)),
				fields
			)
		})
	],
	statements: [
		key(sideOfT(keySelection(s), s.key)),
		...Arr.map(restating, key),
		...Arr.map(s.targets, (t, i) =>
			contained(on(`U${i}`, Arr.take(SOURCE_FIELDS, t.terms.length)), targetSide(s, t))
		),
		...Arr.map(s.probes, (p, j) =>
			contained(
				sideOfT(selectionAt(s, p.at), p.terms),
				on(`V${j}`, Arr.take(PROBED_FIELDS, p.terms.length))
			)
		)
	],
	extends: undefined
})

const installationOf = (desc: SchemaDesc): Installation => {
	const owned = succeeded(ownedInput(desc), "the drawn schema is owned")
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), [], [], firstCodebook(rostersOf(owned)))
		),
		"every target a key holds compiles"
	)
}

/** An index's column as its relation's columns are told apart: a field by its name, a law column by its identifier. */
const indexColumnText = (c: IndexColumn): string => (c.kind === "field" ? c.field : c.column)

/** Whether two index keys are one: one column, one direction, one operator class. */
const sameKey = (x: IndexKey, y: IndexKey): boolean =>
	indexColumnText(x.column) === indexColumnText(y.column) &&
	x.dir === y.dir &&
	sameIndexOpclass(x.opclass, y.opclass)

/** Whether `x`'s keys lead `y`'s, of one relation and access method: as many or fewer, each one of `y`'s at its place. */
const leadsIndex = (x: PlannedIndex, y: PlannedIndex): boolean =>
	x.relation === y.relation &&
	x.method === y.method &&
	x.keys.length <= y.keys.length &&
	Arr.every(x.keys, (k, i) => {
		const l = y.keys[i]
		return l !== undefined && sameKey(k, l)
	})

/** A planned index's column set. */
const indexSet = (i: PlannedIndex): string =>
	setText(Arr.map(i.keys, (k) => indexColumnText(k.column)))

/** A planned index as the implied key's comparison reads it: its relation, method, uniqueness and column set. */
const indexShape = (i: PlannedIndex): string =>
	`${i.relation} ${i.method} ${i.unique ? "unique" : "plain"} (${indexSet(i)})`

/** Every redundant pair of an installation's planned indexes, each named by its two shapes. */
const redundantPairs = (installation: Installation): ReadonlyArray<string> =>
	Arr.flatMap(installation.indexes, (x, i) =>
		Arr.flatMap(installation.indexes, (y, j) =>
			i !== j &&
			leadsIndex(x, y) &&
			!(x.unique && y.unique && x.keys.length < y.keys.length) &&
			(x.keys.length < y.keys.length || i < j)
				? [`${indexShape(x)} leads ${indexShape(y)}`]
				: []
		)
	)

/** A key native's column set: a primary key's fields, or a UNIQUE's columns; none for any other native. */
const keyNativeSet = (o: NativeObject): ReadonlyArray<readonly [string, string]> => {
	switch (o.kind) {
		case "PrimaryKey":
			return [[o.relation.name, setText(Arr.map(o.columns, (c) => c.name))]]
		case "Unique":
			return [[o.relation.name, setText(Arr.map(o.columns, nativeColumnText))]]
		case "WithoutOverlaps":
		case "Domain":
		case "TableCheck":
		case "RosterDomain":
		case "ClosedCheck":
		case "ForeignKey":
		case "LawColumn":
		case "PeriodForeignKey":
		case "ReverseIndex":
			return []
	}
}

/** Each foreign key's target and referenced column set. */
const referencedSets = (installation: Installation): ReadonlyArray<readonly [string, string]> =>
	Arr.flatMap(installation.laws.natives, (n) =>
		n.object.kind === "ForeignKey"
			? [
					[
						n.object.target.name,
						setText(Arr.map(n.object.targetColumns, nativeColumnText))
					] as const
				]
			: []
	)

/** The relation and column set of each key a key law states, a primary key's among them. */
const keySets = (installation: Installation): ReadonlyArray<readonly [string, string]> => {
	const keyLaws: ReadonlyArray<LawId> = Arr.flatMap(installation.laws.theory.laws, (l) =>
		l.detail.kind === "key" || l.detail.kind === "projectedKey" ? [l.id] : []
	)
	return Arr.flatMap(installation.laws.natives, (n) =>
		Arr.some(n.object.lawIds, (l) => keyLaws.includes(l)) ? keyNativeSet(n.object) : []
	)
}

/** The planned index set's three rules every installation keeps (the header's first three). */
const checkIndexes = (installation: Installation, what: string): void => {
	assert.deepEqual(redundantPairs(installation), [], `${what}: no relation holds a redundant pair`)
	const uniques = Arr.filter(installation.indexes, (i) => i.unique)
	const referenced = referencedSets(installation)
	for (const [target, set] of referenced) {
		assert.equal(
			Arr.filter(uniques, (u) => u.relation === target && indexSet(u) === set).length,
			1,
			`${what}: a foreign key into ${target} over (${set}) references exactly one unique index`
		)
	}
	const held = [...keySets(installation), ...referenced]
	for (const u of uniques) {
		assert.ok(
			Arr.some(held, ([relation, set]) => relation === u.relation && set === indexSet(u)),
			`${what}: the unique index ${indexShape(u)} is a key a law states or a foreign key references`
		)
	}
}

/** T's planned indexes, each by its shape, in code-unit order. */
const shapesOfT = (installation: Installation): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(
			Arr.filter(installation.indexes, (i) => i.relation === "T"),
			indexShape
		),
		Order.String
	)

type Feature =
	| "a target referenced at its own columns, leading a probe"
	| "a target referenced at its own columns, within a probe"
	| "a target at its terms and fixed field, with no probe out of its selection"
	| "a target at its terms and fixed field, a probe out of its selection missing one of its terms"
	| "a probe out of another selection of T"
	| "K over a selection"
	| "K over every row"
	| "K's terms holding the fixed field"
	| "two targets sharing the UNIQUE over their terms and fixed field"
	| "a target at its own columns beside one at its terms and fixed field"

const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = [
	"a target referenced at its own columns, leading a probe",
	"a target referenced at its own columns, within a probe",
	"a target at its terms and fixed field, with no probe out of its selection",
	"a target at its terms and fixed field, a probe out of its selection missing one of its terms",
	"a probe out of another selection of T",
	"K over a selection",
	"K over every row",
	"K's terms holding the fixed field",
	"two targets sharing the UNIQUE over their terms and fixed field",
	"a target at its own columns beside one at its terms and fixed field"
]

/** What a case holds, from the sketch alone. */
const featuresOf = (s: Sketch): ReadonlyArray<Feature> => {
	const own = Arr.filter(s.targets, (t) => probed(s, t))
	const shared = Arr.filter(s.targets, (t) => !probed(s, t))
	const outOf = (t: Target) =>
		Arr.filter(s.probes, (p) => p.at.kind === "fixed" && p.at.value === t.value)
	return [
		...(Arr.some(own, (t) => Arr.some(s.probes, (p) => reads(p, t) && leads(p, t)))
			? ["a target referenced at its own columns, leading a probe" as const]
			: []),
		...(Arr.some(own, (t) => Arr.some(s.probes, (p) => reads(p, t) && !leads(p, t)))
			? ["a target referenced at its own columns, within a probe" as const]
			: []),
		...(Arr.some(shared, (t) => outOf(t).length === 0)
			? ["a target at its terms and fixed field, with no probe out of its selection" as const]
			: []),
		...(Arr.some(shared, (t) => outOf(t).length > 0)
			? [
					"a target at its terms and fixed field, a probe out of its selection missing one of its terms" as const
				]
			: []),
		...(Arr.some(s.probes, (p) => {
			const at = p.at
			return at.kind === "key" || !Arr.some(s.targets, (t) => t.value === at.value)
		})
			? ["a probe out of another selection of T" as const]
			: []),
		s.selected ? "K over a selection" : "K over every row",
		...(s.key.includes("kind") ? ["K's terms holding the fixed field" as const] : []),
		...(Arr.some(shared, (t, i) =>
			Arr.some(shared.slice(i + 1), (u) => setText(u.terms) === setText(t.terms))
		)
			? ["two targets sharing the UNIQUE over their terms and fixed field" as const]
			: []),
		...(own.length > 0 && shared.length > 0
			? ["a target at its own columns beside one at its terms and fixed field" as const]
			: [])
	]
}

describe("a fixed target's UNIQUE beside the reverse probes out of its selection", () => {
	it.effect(
		"plans no redundant pair, a unique index per referenced set and none beyond the keys and references, and leaves T's indexes as the implied keys restated would",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the planned index set: no redundant pair, one unique index per referenced set, none a law needs no more, and an implied key restated free where a probe reads a target's own columns"
						},
						suite: "unit/laws/model/probed-target",
						draw: drawn(sketchGen),
						literal: Formatter.format,
						coverage: required<Feature>(FEATURES, { cases: 300, sense: notesOnly }),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							c.noteAll(featuresOf(s))
							const plain = installationOf(schemaOf(s, []))
							checkIndexes(plain, "the schema with K alone")
							const keys = restated(s)
							if (keys.length === 0) {
								return
							}
							const restating = installationOf(schemaOf(s, keys))
							checkIndexes(restating, "the schema with the implied keys restated")
							assert.deepEqual(
								shapesOfT(restating),
								shapesOfT(plain),
								"restating the keys K implies over the targets a probe reads at their own columns plans T's indexes as K alone does"
							)
						})
				)
			)
	)
})
