/** What the properties of probed-target.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, shuffled, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option, Order, Record as Rec } from "effect"
import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import type { ColumnIdent, LawId } from "#compiler/core/ids.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import type { ExprDesc, SideDesc, TermDesc } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { type NativeColumn, columnKey, type NativeObject, type NativeOf } from "#compiler/ir/law.ts"
import { sameIndexOpclass } from "#compiler/ir/products.ts"
import { compileLaws } from "#compiler/laws/model/model.ts"
import type { PartRef } from "#compiler/laws/model/plan.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { keyTermText, type IndexKey, type PlannedIndex } from "#compiler/physical/indexes/engine.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { type InstallBasis, installBasis } from "#compiler/physical/install/plan.ts"
import { compileInstallation, installationOver } from "#compiler/program/install.ts"
import { installationsOf, rostersOf } from "#compiler/schema/own.ts"
import { succeeded } from "#test/support/assert.ts"
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
import { openedDescs } from "#test/support/open.ts"
import type { ModelValue } from "#test/support/oracle/evaluate/catalog.ts"
import { ownedInput } from "#test/support/policy.ts"
import { generatedOn, lawColumnsOf } from "#test/support/unit/laws/model/natives.ts"

/**
 * A fixed target's references, in the index set and columns the installation plans. A fixed target, a containment's
 * target whose selection fixes a field beyond its terms, is held by a key K of its relation over a selection within its
 * own, K's terms among its terms and that field, and K implies two UNIQUEs a reference into it may land on: one over its
 * terms and the fixed field, which every target fixing that field to another value shares and which the source meets
 * by a constant column of each value; and one over its own columns, its terms under its selection, which keeps the
 * fixed field at one value, with no constant. The law model takes whichever adds fewer indexes and columns to the whole
 * schema, the superkey where both cost the same (laws/model/plan.ts `sharedTargets`, `#reference`).
 *
 * A case draws T(id, a, b, c, kind), keyed by K over every row or over select(T, c = 1), on a and kind, a, or a and b in
 * a drawn order; one to three fixed targets, each select(K's selection, b = 0 at one draw in three, and kind = v) over
 * terms that hold K's beyond kind in a drawn order, each the target of a containment from a relation of its own that
 * holds no kind; and up to three containments out of a selection of T, out of such a selection or out of K's, over a
 * drawn list of id, a and b, each into a relation keyed by exactly its terms. b = 0 is a guard where b is a target's
 * term, which keeps the superkey's columns under a selection nothing else reads, and a second fixed field where it is
 * not, a second constant on the source: either way the superkey costs more than the target's own columns.
 *
 * The oracle is the installation's planned index set (Installation.indexes: every index a key installs and every index
 * the install creates) and its law columns, read against the law model's foreign keys and key natives:
 *
 * - no relation holds a redundant pair, an index whose keys lead another's of its relation and access method, key for
 *   key, direction and class alike: the other serves every probe it serves, unless both are unique over two lists, each
 *   holding apart rows the other does not;
 * - every foreign key references the column set of exactly one unique index of its target;
 * - every unique index holds the column set of a key a key law states, or of a foreign key's referenced columns;
 * - the keys K implies cost nothing to leave unstated: the schema with K beside, for each fixed target, the key over its
 *   selection and terms that K implies (the restated keys a downstream schema states instead of K, under which a
 *   target's own columns are planned already, so it takes its superkey only where that costs no more, as where the
 *   superkey's UNIQUE serves a reverse probe that would take a B-tree of its own) plans at least as many objects,
 *   indexes and law columns over every relation, constant columns among them;
 * - the law model's placement of its fixed targets plans the fewest objects of any, by exhaustion: K alone's
 *   installation against the installations of every placement, each subset of its containments into T at their
 *   superkey and the rest at their own columns, each installed by a law model that reads that placement as its recorded
 *   reference choice, so the engine itself costs each one as it drafts its UNIQUEs, law columns and reverse probes'
 *   B-trees (placementsOf), and the model's own choice, installed again so, plans what the model planned;
 * - every unique index of T reports a key that every pair of rows it refuses together breaks. Over every pair of a box
 *   of T's rows, id, a, b and c each 0 or 1 and kind 0, 1 or 2, where each column of the index, a field's value or a law
 *   column's generated value by the reference evaluator, is NULL on neither row and equal, the law its constraint
 *   reports (laws/model/model.ts reportedLaw, its first) is a key's whose statement holds the two rows apart: equal at a
 *   declared key's fields, or both in a projected key's selection and equal at its terms. Every index is judged, so the
 *   order PostgreSQL checks them in is no input: a duplicate that breaks K is named a key whichever index refuses it
 *   first, as after a migration that creates K's index after a UNIQUE K implies.
 *
 * Enforcement is the law suites': the tagged arms families (test/support/laws/boxes.ts) and the families in
 * test/pg/laws/families draw every arm of one handle, a target its parent's tag fixes whose own columns the reverse
 * containment out of the same selection probes, and test/pg/laws/target-keys.test.ts draws such a probe beside every
 * key a target may be held by, over a selection or not, its terms holding a fixed field or not.
 *
 * Features: a target a probe out of its selection reads at its own columns, leading the probe or within it; a target no
 * containment out of its selection probes, and one a probe out of its selection misses a term of; a lone target fixing
 * kind by a literal, from a source that holds no kind, that no probe reads; two such targets fixing kind to two values
 * over one set of terms; one that also selects b = 0; a probe out of another selection; K over a selection or over every row, its terms holding the
 * fixed field; a probed target beside an unprobed one; a target's own UNIQUE K implies through the field its selection
 * fixes; a generated UNIQUE refusing a pair, reported as K over a selection; constant columns that cost the schema no
 * more objects; and the case the count of reverse probes decides (`chained`): one target three sources reference beside
 * two probes out of K's selection, over a and over (a, b), which one B-tree serves where the target's own columns,
 * guarded by its selection of their own, serve neither and its superkey, guarded as K's selection guards a, both.
 */

/** A term of a fixed target, a field of T beside the fixed `kind`. */
type Term = "a" | "b"

/** A term of a probe out of a selection of T. */
type ProbeTerm = "id" | Term

/** A term of K: a target's term, or the field each target fixes. */
type KeyTerm = Term | "kind"

/** The value a target's selection fixes `kind` to. */
type Value = 0 | 1 | 2

const VALUES = [0, 1, 2] as const

/**
 * A selection of T within K's: K's conjuncts, then b = 0 where `guarded`, a guard where b is one of a target's terms and
 * a second field it fixes where it is not, then kind = value.
 */
interface Narrow {
	readonly value: Value
	readonly guarded: boolean
}

/** Whether two narrow selections are one. */
const sameNarrow = (x: Narrow, y: Narrow): boolean => x.value === y.value && x.guarded === y.guarded

/** A fixed target: a narrow selection of T over its terms. */
interface Target extends Narrow {
	readonly terms: Arr.NonEmptyReadonlyArray<Term>
}

/** Where a probe's containment reads T: a narrow selection, or K's own selection. */
type ProbeAt = ({ readonly kind: "fixed" } & Narrow) | { readonly kind: "key" }

/** Whether a narrow selection holds b = 0, at one draw in three. */
const guardedGen: Gen<boolean> = weighted<boolean>([
	[2, () => false],
	[1, () => true]
])

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

/**
 * A target's terms, which hold K's beyond the field it fixes: a alone, where K holds no b, at one draw in two; otherwise
 * a and b in a drawn order, a first at the simplest, so every K draws them alike.
 */
const termsGen =
	(k: Arr.NonEmptyReadonlyArray<KeyTerm>): Gen<Arr.NonEmptyReadonlyArray<Term>> =>
	(source) => {
		if (!k.includes("b") && source.draw(boolean)) {
			return ["a"]
		}
		return source.draw(boolean) ? ["b", "a"] : ["a", "b"]
	}

/** A fixed target of K: its terms (termsGen), the value it fixes kind to, and whether it also selects b = 0. */
const targetGen =
	(k: Arr.NonEmptyReadonlyArray<KeyTerm>): Gen<Target> =>
	(source) => {
		const terms = source.draw(termsGen(k))
		return { value: source.draw(element(VALUES)), guarded: source.draw(guardedGen), terms }
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
				[
					3,
					(s) => {
						const t = s.draw(element(targets))
						return { kind: "fixed", value: t.value, guarded: t.guarded }
					}
				],
				[
					1,
					(s) => ({ kind: "fixed", value: s.draw(element(VALUES)), guarded: s.draw(guardedGen) })
				],
				[1, () => ({ kind: "key" })]
			])
		)
		return { at, terms: source.draw(probeTermsGen) }
	}

export const sketchGen: Gen<Sketch> = (source) => {
	const k = source.draw(element(KEYS))
	const first = source.draw(targetGen(k))
	const more = source.draw(array(targetGen(k), { min: 0, max: 2 }))
	const drawn: Arr.NonEmptyReadonlyArray<Target> = [first, ...more]
	const selected = source.draw(boolean)
	const probes = source.draw(array(probeGen(drawn), { min: 0, max: 3 }))
	/**
	 * Drawn last, so every earlier case draws as it did: the first target again from one or two sources of their own,
	 * one target several sources reference, each by its own constant where they take its superkey; or the case the
	 * count of reverse probes decides (`chained`), at the first target's value.
	 */
	const again = source.draw(element([0, 1, 2, "chained"] as const))
	return again === "chained"
		? {
				selected: true,
				key: ["kind", "a"],
				targets: Arr.makeBy(3, () => ({
					value: first.value,
					guarded: false,
					terms: ["a", "b"] as const
				})),
				probes: [
					{ at: { kind: "key" }, terms: ["a"] },
					{ at: { kind: "key" }, terms: ["a", "b"] }
				]
			}
		: {
				selected,
				key: k,
				targets: [...drawn, ...Array.from({ length: again }, () => first)],
				probes
			}
}

/** K's selection: c = 1, or every row. */
const keySelection = (s: Sketch): ReadonlyArray<ExprDesc> =>
	s.selected ? [eq(field("c"), literal(1))] : []

/** A selection of T a probe or a target reads: K's, then b = 0 where guarded and kind = value where it is narrow. */
const selectionAt = (s: Sketch, at: ProbeAt): ReadonlyArray<ExprDesc> =>
	at.kind === "key"
		? keySelection(s)
		: [
				...keySelection(s),
				...(at.guarded ? [eq(field("b"), literal(0))] : []),
				eq(field("kind"), literal(at.value))
			]

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
	sideOfT(selectionAt(s, { kind: "fixed", value: t.value, guarded: t.guarded }), t.terms)

/** Whether a probe's containment reads a target's selection over every one of its terms. */
const reads = (p: Probe, t: Target): boolean =>
	p.at.kind === "fixed" && sameNarrow(p.at, t) && Arr.every(t.terms, (x) => p.terms.includes(x))

/** Whether a probe's terms lead with a target's, in its order. */
const leads = (p: Probe, t: Target): boolean => Arr.every(t.terms, (x, i) => p.terms[i] === x)

/** Whether a probe out of a target's selection reads its own columns, which its reference then lands on. */
const probed = (s: Sketch, t: Target): boolean => Arr.some(s.probes, (p) => reads(p, t))

/** A list of names as one text, in code-unit order: a column set. */
const setText = (names: ReadonlyArray<string>): string =>
	Arr.join(Arr.sort(names, Order.String), ",")

/**
 * The keys K implies that a downstream schema restates instead of K: for each fixed target, the key over its selection
 * and terms, each selection and term set once.
 */
export const restated = (s: Sketch): ReadonlyArray<SideDesc> =>
	Arr.map(
		Arr.dedupeWith(
			s.targets,
			(x: Target, y: Target) => sameNarrow(x, y) && setText(x.terms) === setText(y.terms)
		),
		(t) => targetSide(s, t)
	)

const SOURCE_FIELDS = ["x0", "x1"] as const
const PROBED_FIELDS = ["y0", "y1", "y2"] as const

/**
 * The schema of a case: T, K, each target's containment from U<i>, each probe's into V<j>, and the keys `restating`,
 * every relation open: a containment between immutable relations that joins within one unit, a probe out of T at its
 * id among them, is judged whole and installs no reverse probe (laws/model/plan.ts containmentDischarge), and this box
 * reads the native placement of the probes.
 */
export const schemaOf = (s: Sketch, restating: ReadonlyArray<SideDesc>): SchemaDesc => {
	const relations = [
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
	]
	return {
		name: "ProbedTarget",
		relations,
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
			),
			...openedDescs(relations)
		],
		bases: []
	}
}

export const installationOf = (desc: SchemaDesc): Installation => {
	const owned = succeeded(ownedInput(desc), "the drawn schema is owned")
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), [], [], firstCodebook(rostersOf(owned)))
		),
		"every target a key holds compiles"
	)
}

/**
 * A schema's installation under the law model's own placement of its fixed targets, beside the fewest objects of any
 * placement (`placementsOf`).
 */
interface Placements {
	readonly chosen: Installation
	/** The objects of the model's own choice installed again as a recorded placement, the harness's own check. */
	readonly again: number
	readonly least: number
}

/**
 * The installations of `desc` under every placement of its fixed targets: each subset of its containments into T at
 * their shared superkey, the rest at their own columns, each installed by a law model that reads that subset as its
 * recorded reference choice (laws/model/model.ts CycleSource), its foreign key cycles the planned model's, over the
 * basis the installation compiles. The engine itself costs each placement, drafting its UNIQUEs, law columns and
 * reverse probes' B-trees as it installs them, so the least of them judges the choice the law model makes
 * (laws/model/plan.ts takingShared) without restating its count.
 */
export const placementsOf = (desc: SchemaDesc): Placements => {
	const owned = succeeded(ownedInput(desc), "the drawn schema is owned")
	const options = completeInstallOptions(
		owned,
		installationsOf(owned),
		[],
		[],
		firstCodebook(rostersOf(owned))
	)
	const basis = succeeded(
		installBasis(owned, options.codes, new Set()),
		"every target a key holds compiles"
	)
	const installed = (b: InstallBasis): Installation =>
		succeeded(
			installationOver(b, options, silentPhases),
			"every placement of the fixed targets installs"
		)
	const parts = Arr.flatMap(basis.model.theory.laws, (law): ReadonlyArray<PartRef> =>
		law.detail.kind === "containment" && law.detail.to.relation === "T"
			? [{ law: law.id, part: 0 }]
			: []
	)
	const none: ReadonlyArray<PartRef> = []
	const choices = Arr.reduce(
		parts,
		Arr.of(none),
		(sets: Arr.NonEmptyReadonlyArray<ReadonlyArray<PartRef>>, part) =>
			Arr.flatMap(sets, (set): Arr.NonEmptyReadonlyArray<ReadonlyArray<PartRef>> => [
				set,
				[...set, part]
			])
	)
	const placed = (choice: ReadonlyArray<PartRef>): number =>
		objectsOf(
			installed({
				...basis,
				model: succeeded(
					compileLaws(owned, {
						kind: "recorded",
						cycles: basis.model.fkCycles,
						references: choice
					}),
					"the law model under a recorded placement"
				)
			})
		).objects
	return {
		chosen: installed(basis),
		again: placed(basis.model.references),
		least: Arr.min(Arr.map(choices, placed), Order.Number)
	}
}

/** Whether two index keys are one: one column, one direction, one operator class. */
const sameKey = (x: IndexKey, y: IndexKey): boolean =>
	keyTermText(x.column) === keyTermText(y.column) &&
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
const indexSet = (i: PlannedIndex): string => setText(Arr.map(i.keys, (k) => keyTermText(k.column)))

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
			return [[o.relation.name, setText(Arr.map(o.columns, columnKey))]]
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
			? [[n.object.target.name, setText(Arr.map(n.object.targetColumns, columnKey))] as const]
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
export const checkIndexes = (installation: Installation, what: string): void => {
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

/** What an installation plans over every relation: its indexes and law columns, and its constant columns among them. */
interface Objects {
	readonly objects: number
	readonly constants: number
}

export const objectsOf = (installation: Installation): Objects => {
	const columns = Arr.flatMap(installation.laws.natives, (n) =>
		n.namespace === "column" ? [n.plan] : []
	)
	return {
		objects: installation.indexes.length + columns.length,
		constants: Arr.filter(columns, (c) => c.kind === "constant").length
	}
}

/** A row of T in the box: each field by its name, at its carrier's value. */
type Row = ReadonlyMap<string, ModelValue>

const BITS = [0n, 1n] as const

/** Every row of the box: id, a, b and c each 0 or 1, and kind 0, 1 or 2, each value a selection or a key reads. */
const ROWS: ReadonlyArray<Row> = Arr.flatMap(BITS, (id) =>
	Arr.flatMap(BITS, (a) =>
		Arr.flatMap(BITS, (b) =>
			Arr.flatMap(BITS, (c) =>
				Arr.map(
					[0n, 1n, 2n],
					(kind): Row =>
						new Map<string, ModelValue>([
							["id", id],
							["a", a],
							["b", b],
							["c", c],
							["kind", kind]
						])
				)
			)
		)
	)
)

/** A literal of the box's selections: an integer's. */
const boxValue = (l: TypedLiteral): ModelValue =>
	l.kind === "int" ? l.value : assert.fail(`an integer literal of the box, not ${l.kind}`)

/**
 * The pairs of T's rows a law's statement holds apart, where it is a key: a declared key's, equal at its fields; a
 * projected key's, both in its selection, each conjunct of which fixes a field of the box to a literal, and equal at
 * its terms. None for a law of any other kind.
 */
const heldApartBy = (law: TheoryLaw): ((x: Row, y: Row) => boolean) | undefined => {
	const d = law.detail
	switch (d.kind) {
		case "key": {
			const fields = Arr.map(d.key.fields, (f) => f.name)
			return (x, y) => Arr.every(fields, (f) => x.get(f) === y.get(f))
		}
		case "projectedKey": {
			const side = d.side
			const selects = (row: Row): boolean =>
				Arr.every(side.selection.conjuncts, (c) =>
					c.kind === "fixed"
						? row.get(c.selector.col.name) === boxValue(c.selector.value)
						: assert.fail(`a conjunct of the box fixes a field to a literal; ${c.text} does not`)
				)
			return (x, y) =>
				selects(x) &&
				selects(y) &&
				Arr.every(side.terms, (t) =>
					t.kind === "field"
						? x.get(t.column.name) === y.get(t.column.name)
						: assert.fail("a field term of the box")
				)
		}
		case "check":
		case "contract":
		case "containment":
		case "rule":
		case "family":
		case "tree":
		case "fold":
			return undefined
	}
}

/** Whether a law is a key's: a declared one, the primary key among them, or one over a projected side. */
const isKey = (law: TheoryLaw): boolean =>
	law.detail.kind === "key" || law.detail.kind === "projectedKey"

/** A unique native of T: its columns and the laws it discharges, the one its constraint reports first. */
interface UniqueOfT {
	readonly columns: Arr.NonEmptyReadonlyArray<NativeColumn>
	readonly laws: Arr.NonEmptyReadonlyArray<LawId>
}

const uniquesOfT = (installation: Installation): ReadonlyArray<UniqueOfT> =>
	Arr.flatMap(installation.laws.natives, ({ object: o }): ReadonlyArray<UniqueOfT> => {
		if (o.kind === "PrimaryKey" && o.relation.name === "T") {
			return [
				{
					columns: Arr.map(o.columns, (field): NativeColumn => ({ kind: "field", field })),
					laws: o.lawIds
				}
			]
		}
		return o.kind === "Unique" && o.relation.name === "T"
			? [{ columns: o.columns, laws: o.lawIds }]
			: []
	})

/** A column's value on a row: a field's own, or a law column's generated value, NULL as undefined. */
const valueAt = (
	lawColumns: ReadonlyMap<ColumnIdent, NativeOf<"LawColumn">>,
	row: Row,
	c: NativeColumn
): ModelValue | undefined =>
	c.kind === "field"
		? row.get(c.field.name)
		: generatedOn(defined(lawColumns.get(c.column), `the law column ${c.column} of T`), row)

/** Whether a unique index holds two rows apart: each of its columns NULL on neither and equal. */
const refusesTogether = (
	x: ReadonlyArray<ModelValue | undefined>,
	y: ReadonlyArray<ModelValue | undefined>
): boolean => Arr.every(x, (v, i) => v !== undefined && v === y[i])

/**
 * The header's fifth rule: each unique index of T reports a key every pair of the box it refuses breaks. Notes each
 * generated UNIQUE, one that discharges a law besides keys, reported as a key over a projected side for a pair it
 * refuses.
 */
export const checkReports = (
	installation: Installation,
	what: string,
	note: (feature: Feature) => void
): void => {
	const laws = [
		...installation.laws.theory.laws,
		...Arr.map(installation.laws.theory.primaryKeys, (pk) => pk.law)
	]
	const lawOf = (id: LawId): TheoryLaw =>
		Option.getOrThrowWith(
			Arr.findFirst(laws, (l) => l.id === id),
			() => new Error(`${what}: the law ${id} a native discharges is one of the theory's`)
		)
	const lawColumns = lawColumnsOf(installation.laws, "T")
	for (const u of uniquesOfT(installation)) {
		const reported = lawOf(u.laws[0])
		const meaning = heldApartBy(reported)
		const generated = Arr.some(u.laws, (l) => !isKey(lawOf(l)))
		const keyed = Arr.map(ROWS, (row) => ({
			row,
			key: Arr.map(u.columns, (c) => valueAt(lawColumns, row, c))
		}))
		const index = setText(Arr.map(u.columns, columnKey))
		for (const [i, x] of keyed.entries()) {
			for (const y of keyed.slice(i + 1)) {
				if (!refusesTogether(x.key, y.key)) {
					continue
				}
				assert.ok(
					meaning?.(x.row, y.row) === true,
					`${what}: the unique index of T over (${index}) refuses ${Formatter.format([x.row, y.row])} together and reports ${reported.detail.kind} ${reported.id}, which they do not break`
				)
				if (generated && reported.detail.kind === "projectedKey") {
					note("a generated UNIQUE refusing a pair, reported as K over a selection")
				}
			}
		}
	}
}

export type Feature =
	| "a target a probe reads at its own columns, leading the probe"
	| "a target a probe reads at its own columns, within the probe"
	| "a target no containment out of its selection probes"
	| "a target a probe out of its selection misses a term of"
	| "a lone target fixing kind by a literal, from a source that holds no kind, that no probe reads"
	| "two targets fixing kind to two values over one set of terms, that no probe reads"
	| "a target that also selects b = 0, that no probe reads"
	| "a probe out of another selection of T"
	| "K over a selection"
	| "K over every row"
	| "K's terms holding the fixed field"
	| "a probed target beside an unprobed one"
	| "a target's own UNIQUE, K implying it through the field its selection fixes"
	| "a generated UNIQUE refusing a pair, reported as K over a selection"
	| "constant columns that cost the schema no more objects"
	| "one target three sources reference beside a chain of probes out of K's selection its superkey serves"

export const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = [
	"a target a probe reads at its own columns, leading the probe",
	"a target a probe reads at its own columns, within the probe",
	"a target no containment out of its selection probes",
	"a target a probe out of its selection misses a term of",
	"a lone target fixing kind by a literal, from a source that holds no kind, that no probe reads",
	"two targets fixing kind to two values over one set of terms, that no probe reads",
	"a target that also selects b = 0, that no probe reads",
	"a probe out of another selection of T",
	"K over a selection",
	"K over every row",
	"K's terms holding the fixed field",
	"a probed target beside an unprobed one",
	"a target's own UNIQUE, K implying it through the field its selection fixes",
	"a generated UNIQUE refusing a pair, reported as K over a selection",
	"constant columns that cost the schema no more objects",
	"one target three sources reference beside a chain of probes out of K's selection its superkey serves"
]

/** What a case holds, from the sketch alone. */
export const featuresOf = (s: Sketch): ReadonlyArray<Feature> => {
	const own = Arr.filter(s.targets, (t) => probed(s, t))
	const unprobed = Arr.filter(s.targets, (t) => !probed(s, t))
	const outOf = (t: Target) =>
		Arr.filter(s.probes, (p) => p.at.kind === "fixed" && sameNarrow(p.at, t))
	const partners = (t: Target) =>
		Arr.filter(
			unprobed,
			(u) => u.guarded === t.guarded && u.value !== t.value && setText(u.terms) === setText(t.terms)
		)
	return [
		...(Arr.some(own, (t) => Arr.some(s.probes, (p) => reads(p, t) && leads(p, t)))
			? ["a target a probe reads at its own columns, leading the probe" as const]
			: []),
		...(Arr.some(own, (t) => Arr.some(s.probes, (p) => reads(p, t) && !leads(p, t)))
			? ["a target a probe reads at its own columns, within the probe" as const]
			: []),
		...(Arr.some(unprobed, (t) => outOf(t).length === 0)
			? ["a target no containment out of its selection probes" as const]
			: []),
		...(Arr.some(unprobed, (t) => outOf(t).length > 0)
			? ["a target a probe out of its selection misses a term of" as const]
			: []),
		...(Arr.some(unprobed, (t) => partners(t).length === 0)
			? [
					"a lone target fixing kind by a literal, from a source that holds no kind, that no probe reads" as const
				]
			: []),
		...(Arr.some(unprobed, (t) => partners(t).length > 0)
			? [
					"two targets fixing kind to two values over one set of terms, that no probe reads" as const
				]
			: []),
		...(Arr.some(unprobed, (t) => t.guarded)
			? ["a target that also selects b = 0, that no probe reads" as const]
			: []),
		...(Arr.some(s.probes, (p) => {
			const at = p.at
			return at.kind === "key" || !Arr.some(s.targets, (t) => sameNarrow(t, at))
		})
			? ["a probe out of another selection of T" as const]
			: []),
		s.selected ? "K over a selection" : "K over every row",
		...(s.key.includes("kind") ? ["K's terms holding the fixed field" as const] : []),
		...(own.length > 0 && unprobed.length > 0
			? ["a probed target beside an unprobed one" as const]
			: []),
		...(own.length > 0 && s.key.includes("kind")
			? ["a target's own UNIQUE, K implying it through the field its selection fixes" as const]
			: []),
		...(chained(s)
			? [
					"one target three sources reference beside a chain of probes out of K's selection its superkey serves" as const
				]
			: [])
	]
}

/**
 * Whether a case is the one the reference choice's count of reverse probes decides (laws/model/plan.ts probeIndexes):
 * K over a selection, led by kind, so its UNIQUE serves no probe of a; one unguarded target over (a, b) that three sources
 * reference, so its superkey costs three constants and its own columns a guard of its own and their UNIQUE; and two
 * probes out of K's selection over a and over (a, b), which one B-tree serves where the target's own columns serve
 * neither, the superkey both. Its own columns cost the schema one object fewer than its superkey, the chain's one B-tree
 * counted once; counted once a probe, the superkey ties them and is taken.
 */
const chained = (s: Sketch): boolean => {
	const [first, ...rest] = s.targets
	return (
		s.selected &&
		s.key[0] === "kind" &&
		rest.length === 2 &&
		!first.guarded &&
		setText(first.terms) === "a,b" &&
		first.terms[0] === "a" &&
		Arr.every(
			rest,
			(t) => sameNarrow(t, first) && Arr.join(t.terms, ",") === Arr.join(first.terms, ",")
		) &&
		Arr.some(s.probes, (p) => p.at.kind === "key" && Arr.join(p.terms, ",") === "a") &&
		Arr.some(s.probes, (p) => p.at.kind === "key" && Arr.join(p.terms, ",") === "a,b")
	)
}
