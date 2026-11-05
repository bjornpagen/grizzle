import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, Record as Rec } from "effect"
import type { NativeColumn, NativeOf } from "#compiler/ir/law.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import {
	type AuthoredStatementDesc,
	contained,
	counted,
	f,
	fin,
	fold,
	on,
	ordered,
	pred,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { PayrollDesc } from "#test/support/fixtures/ir/payroll.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"
import {
	accepts,
	assertColumnsBeforeConstraints,
	assertWellFormed,
	checksOf,
	drawnColumn,
	familyLaw,
	type ForeignKeyShape,
	foreignKeyOrder,
	foreignKeyShapes,
	generatedOn,
	generatedColumn,
	keySets,
	loweringOf,
	modelOf,
	onRelation,
	ridingLaws
} from "#test/unit/laws/model/natives.ts"
import { owner } from "#test/unit/physical/fixtures.ts"

/**
 * A family's natives are exactly fin.md §5.2's lemmas on w4-w7 §2.1's three axes, read from the law model's native
 * objects, never from SQL text. The oracle is the specification turned into a checker: §2.1's table states, for each
 * shape, the foreign keys (their pairs as a set, their update action and their deferral), the keys and the CHECKs, and
 * the checker builds that expectation from the shape alone.
 *
 * - **owner:** Member(g…, ‹n›, carried…) → Owner(k…, n, carried…), ON UPDATE CASCADE, immediate (the owner is
 *   immutable, so no cascade feeds its target);
 * - **predecessor:** Member(g…, ‹p›, carried…) → Member(g…, i, carried…), immediate when ordered and deferred when
 *   counted;
 * - **last:** Owner(k…, ‹pn›, carried…) → Member(g…, i, carried…), deferred (the owner ↔ family cycle);
 * - **keys:** `UNIQUE (g…, i)`, a superkey per distinct carried set on each target, and no other;
 * - **merging:** every containment that rides an axis has no native of its own: its pairs are the axis's, its law is
 *   among the axis's laws after the family's, and its lowering lists the axis's foreign key;
 * - **the bound:** the family's CHECK accepts exactly the rows where `i < ‹n›`, and for a counted index `0 ≤ i < ‹n›`,
 *   since a law column has no natural domain;
 * - **the pins:** an accumulated copy's containment states the base pin `base > 0 OR f = start` on its source, the
 *   index on the predecessor axis and the count on the last; the owner axis of a family over every fact has no base;
 * - **the generated columns:** ‹p› is pred of the index and ‹pn› pred of the count, NULL at 0.
 *
 * Bound: every family of group width 1 or 2, ordered or counted, with 0 to 2 copies on each axis it admits, each copy
 * a caller field or an accumulated one: 2 × 4³ ordered and 2 × 4 counted, 136 schemas, exhausted. A CHECK is judged
 * on every index and count in 0 … 3, the index from −1 when counted, and a pin on every base in 0 … 2 against its
 * start and another value. The payroll fixture's whole IR is one more case of the installation's well-formedness.
 */

type Copy = "caller" | "accumulated"
type Copies = ReadonlyArray<Copy>
const copyings: Arr.NonEmptyReadonlyArray<Copies> = [
	[],
	["caller"],
	["accumulated"],
	["caller", "accumulated"]
]

interface Shape {
	readonly order: "ordered" | "counted"
	readonly width: 1 | 2
	readonly owner: Copies
	readonly predecessor: Copies
	readonly last: Copies
}

const shapes: Arr.NonEmptyReadonlyArray<Shape> = nonEmpty([
	...Arr.flatMap([1, 2] as const, (width) =>
		Arr.flatMap(copyings, (owner) =>
			Arr.flatMap(copyings, (predecessor) =>
				Arr.map(copyings, (last): Shape => ({ order: "ordered", width, owner, predecessor, last }))
			)
		)
	),
	...Arr.flatMap([1, 2] as const, (width) =>
		Arr.map(copyings, (owner): Shape => ({
			order: "counted",
			width,
			owner,
			predecessor: [],
			last: []
		}))
	)
])

type Feature =
	| "ordered"
	| "counted"
	| "two group fields"
	| "an owner copy"
	| "a predecessor copy"
	| "a last copy"
	| "an accumulated copy"
	| "two copies on one axis"

const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"ordered",
	"counted",
	"two group fields",
	"an owner copy",
	"a predecessor copy",
	"a last copy",
	"an accumulated copy",
	"two copies on one axis"
]

const group = (s: Shape): ReadonlyArray<string> => (s.width === 1 ? ["g1"] : ["g1", "g2"])
const keys = (s: Shape): ReadonlyArray<string> => (s.width === 1 ? ["k1"] : ["k1", "k2"])

/** A copy's source field: a caller's bigint, or one accumulated from 0. */
const source = (copy: Copy) => (copy === "caller" ? f.bigint : f.accumulated(f.bigint, 0n))

/**
 * The fields of one axis's copies, `from` on its source and `to` on its target, by the copy's position: the targets
 * are numbered against the sources, so the two sort in opposite orders and an axis that paired its columns by sorting
 * each side alone would pair them wrongly.
 */
const named = (prefix: string, copies: Copies) =>
	Arr.map(copies, (copy, j) => ({
		copy,
		from: `${prefix}From${j}`,
		to: `${prefix}To${copies.length - 1 - j}`
	}))

const schemaOf = (s: Shape): SchemaDesc => {
	const owner = named("owner", s.owner)
	const preceding = named("pred", s.predecessor)
	const closing = named("last", s.last)
	const index = s.order === "ordered" ? ["at"] : []
	const ownerFields = {
		...Rec.fromEntries(Arr.map(keys(s), (k) => [k, f.uuid] as const)),
		n: f.drawn,
		...Rec.fromEntries(Arr.map(owner, (c) => [c.to, f.bigint] as const)),
		...Rec.fromEntries(Arr.map(closing, (c) => [c.from, source(c.copy)] as const))
	}
	const memberFields = {
		id: f.uuid,
		...Rec.fromEntries(Arr.map(group(s), (g) => [g, f.uuid] as const)),
		...(s.order === "ordered" ? { at: f.drawn } : {}),
		...Rec.fromEntries(Arr.map(owner, (c) => [c.from, source(c.copy)] as const)),
		...Rec.fromEntries(
			Arr.flatMap(preceding, (c) => [[c.from, source(c.copy)] as const, [c.to, f.bigint] as const])
		),
		...Rec.fromEntries(Arr.map(closing, (c) => [c.to, f.bigint] as const))
	}
	const family =
		s.order === "ordered"
			? ordered(on("Member", [...group(s), ...index]), fin("Owner", "n"))
			: counted(on("Member", group(s)), fin("Owner", "n"))
	const statements: ReadonlyArray<AuthoredStatementDesc> = [
		family,
		...Arr.map(owner, (c) =>
			contained(on("Member", [...group(s), c.from]), on("Owner", [...keys(s), c.to]))
		),
		...Arr.map(preceding, (c) =>
			contained(
				on("Member", [...group(s), pred("at"), c.from]),
				on("Member", [...group(s), "at", c.to])
			)
		),
		...Arr.map(closing, (c) =>
			contained(
				on("Owner", [...keys(s), pred("n"), c.from]),
				on("Member", [...group(s), "at", c.to])
			)
		)
	]
	return {
		name: "Families",
		relations: [relation("Owner", ownerFields, keys(s)), relation("Member", memberFields, ["id"])],
		statements,
		extends: undefined
	}
}

const sortText = (xs: ReadonlyArray<string>): ReadonlyArray<string> => Arr.sort(xs, Order.String)

/** §2.1's three foreign keys for a shape, each as its contract reads it. */
const expectedForeignKeys = (s: Shape): ReadonlyArray<ForeignKeyShape> => {
	const i = s.order === "ordered" ? "at" : "‹index›"
	const p = s.order === "ordered" ? "‹generated at›" : "‹generated n›"
	const groupPairs = Arr.map(Arr.zip(group(s), keys(s)), ([g, k]) => ({ g, k }))
	const fk = (
		from: string,
		to: string,
		pairs: ReadonlyArray<string>,
		onUpdate: "cascade" | "noAction",
		deferrable: boolean
	): ForeignKeyShape => ({ from, to, pairs: sortText(pairs), onUpdate, deferrable })
	return Arr.sort(
		[
			fk(
				"Member",
				"Owner",
				[
					...Arr.map(groupPairs, ({ g, k }) => `${g} → ${k}`),
					"‹copy› → n",
					...Arr.map(named("owner", s.owner), (c) => `${c.from} → ${c.to}`)
				],
				"cascade",
				false
			),
			fk(
				"Member",
				"Member",
				[
					...Arr.map(group(s), (g) => `${g} → ${g}`),
					`${p} → ${i}`,
					...Arr.map(named("pred", s.predecessor), (c) => `${c.from} → ${c.to}`)
				],
				"noAction",
				s.order === "counted"
			),
			fk(
				"Owner",
				"Member",
				[
					...Arr.map(groupPairs, ({ g, k }) => `${k} → ${g}`),
					`‹generated n› → ${i}`,
					...Arr.map(named("last", s.last), (c) => `${c.from} → ${c.to}`)
				],
				"noAction",
				true
			)
		],
		foreignKeyOrder
	)
}

const setText = (xs: ReadonlyArray<string>): string => Arr.join(sortText(xs), ", ")

/** §2.1's keys for a shape: the primary keys, the family key, and one superkey per distinct carried set. */
const expectedKeys = (s: Shape) => {
	const i = s.order === "ordered" ? "at" : "‹index›"
	const familyKey = [...group(s), i]
	return {
		Member: sortText([
			...new Set([
				"id",
				setText(familyKey),
				setText([...familyKey, ...Arr.map(named("pred", s.predecessor), (c) => c.to)]),
				setText([...familyKey, ...Arr.map(named("last", s.last), (c) => c.to)])
			])
		]),
		Owner: sortText([
			...new Set([
				setText(keys(s)),
				setText([...keys(s), "n", ...Arr.map(named("owner", s.owner), (c) => c.to)])
			])
		])
	}
}

const naturals = [0n, 1n, 2n, 3n] as const

/** The family's bound: its CHECK accepts exactly the rows where 0 ≤ i < ‹n›. */
const checkBound = (model: LawModel, s: Shape): void => {
	const law = familyLaw(model, { owner: "Owner", count: "n" })
	const [check, ...more] = checksOf(model, "Member", law)
	assert.ok(check !== undefined && more.length === 0, "the family states one CHECK on its member")
	const copy = drawnColumn(model, "Member", "copy")
	const index = s.order === "ordered" ? "at" : drawnColumn(model, "Member", "index")
	const indices = s.order === "ordered" ? naturals : ([-1n, ...naturals] as const)
	for (const n of naturals) {
		for (const i of indices) {
			const row = new Map<string, bigint>([
				[copy, n],
				[index, i]
			])
			assert.equal(accepts(check, row), i >= 0n && i < n, `i = ${i}, ‹n› = ${n}`)
		}
	}
}

/** ‹p› and ‹pn>: pred of the index and of the count, NULL at 0. */
const checkPreds = (model: LawModel, s: Shape): void => {
	const index = s.order === "ordered" ? "at" : drawnColumn(model, "Member", "index")
	const p = generatedColumn(model, "Member", s.order === "ordered" ? "at" : "n")
	const pn = generatedColumn(model, "Owner", "n")
	for (const x of naturals) {
		const expected = x > 0n ? x - 1n : undefined
		assert.equal(generatedOn(p, new Map([[index, x]])), expected, `‹p› at ${x}`)
		assert.equal(generatedOn(pn, new Map([["n", x]])), expected, `‹pn› at ${x}`)
	}
}

/**
 * Each copy's containment: it rides its axis, so it plans no native of its own, its law is among the axis foreign
 * key's laws after the family's, and an accumulated copy's law states its base pin on the axis's source.
 */
const checkCopies = (model: LawModel, s: Shape): void => {
	const law = familyLaw(model, { owner: "Owner", count: "n" })
	const fks = onRelation(model, "ForeignKey", "Member").concat(
		onRelation(model, "ForeignKey", "Owner")
	)
	const axisOf = (axis: "owner" | "predecessor" | "last") =>
		Arr.filter(fks, (fk) =>
			axis === "owner"
				? fk.target.name === "Owner"
				: axis === "last"
					? fk.relation.name === "Owner"
					: fk.relation.name === "Member" && fk.target.name === "Member"
		)
	const indexOrUndefined = s.order === "ordered" ? "at" : drawnColumn(model, "Member", "index")
	for (const axis of ["owner", "predecessor", "last"] as const) {
		const [fk, ...more] = axisOf(axis)
		assert.ok(fk !== undefined && more.length === 0, `one ${axis} axis foreign key`)
		const riding = ridingLaws(model, axis)
		assert.equal(riding.length, s[axis].length, `every ${axis} copy rides its axis`)
		assert.equal(fk.lawIds[0], law, `the ${axis} axis reports the family's law first`)
		assert.deepEqual(
			sortText(fk.lawIds),
			sortText([law, ...riding]),
			`the ${axis} axis states its copies' laws`
		)
		const copies = named(axis === "predecessor" ? "pred" : axis, s[axis])
		for (const [j, r] of riding.entries()) {
			assert.ok(
				Arr.contains(loweringOf(model, r), fk),
				`a riding copy's lowering is its axis's foreign key`
			)
			const copy = copies[j]
			const sourceRelation = axis === "last" ? "Owner" : "Member"
			const pins = checksOf(model, sourceRelation, r)
			if (copy === undefined || copy.copy === "caller" || axis === "owner") {
				assert.equal(
					pins.length,
					0,
					`a ${copy?.copy ?? "missing"} copy on the ${axis} axis states no pin`
				)
				continue
			}
			const [pin, ...extra] = pins
			assert.ok(
				pin !== undefined && extra.length === 0,
				`an accumulated copy on the ${axis} axis states one pin`
			)
			const base = axis === "last" ? "n" : indexOrUndefined
			for (const b of [0n, 1n, 2n]) {
				for (const v of [0n, 5n]) {
					assert.equal(
						accepts(
							pin,
							new Map([
								[base, b],
								[copy.from, v]
							])
						),
						b > 0n || v === 0n,
						`${axis} base ${b}, copy ${v}`
					)
				}
			}
		}
	}
}

const checkShape = (s: Shape): void => {
	const model = modelOf(schemaOf(s))
	assertWellFormed(model)
	assert.deepEqual(foreignKeyShapes(model), expectedForeignKeys(s))
	const expected = expectedKeys(s)
	assert.deepEqual(keySets(model, "Member"), expected.Member)
	assert.deepEqual(keySets(model, "Owner"), expected.Owner)
	assert.deepEqual(
		[...onRelation(model, "ReverseIndex", "Member"), ...onRelation(model, "ReverseIndex", "Owner")],
		[],
		"an axis is indexed by its target's key prefix, and needs no reverse index"
	)
	checkBound(model, s)
	checkPreds(model, s)
	checkCopies(model, s)
}

/** Whether two native columns are one: one field's handle, or one law column's identifier. */
const sameColumn = (a: NativeColumn, b: NativeColumn): boolean =>
	a.kind === "field"
		? b.kind === "field" && a.field === b.field
		: b.kind === "law" && a.column === b.column

/** A member in `counted` counted families, each folded by a sum or not, beside at most one sequence (rows-first §1). */
interface Disjoint {
	readonly counted: 1 | 2 | 3
	readonly folded: boolean
	readonly sequence: "none" | "ordered" | "tree"
}

const disjointShapes: Arr.NonEmptyReadonlyArray<Disjoint> = nonEmpty(
	Arr.flatMap([1, 2, 3] as const, (counted) =>
		Arr.flatMap([false, true], (folded) =>
			Arr.map(["none", "ordered", "tree"] as const, (sequence): Disjoint => ({
				counted,
				folded,
				sequence
			}))
		)
	)
)

type DisjointFeature =
	| "1 counted"
	| "2 counted"
	| "3 counted"
	| "folded"
	| `sequence ${Disjoint["sequence"]}`
const disjointFeatures: Arr.NonEmptyReadonlyArray<DisjointFeature> = [
	"1 counted",
	"2 counted",
	"3 counted",
	"folded",
	"sequence none",
	"sequence ordered",
	"sequence tree"
]

const disjointSchema = (d: Disjoint): SchemaDesc => {
	const owners = Arr.makeBy(d.counted, (j) => `C${j}`)
	const treeFields =
		d.sequence === "tree"
			? {
					parent: f.uuid,
					doc: f.uuid,
					at: f.drawn,
					children: f.drawn,
					start: f.drawn,
					end: f.drawn
				}
			: d.sequence === "ordered"
				? { s: f.uuid, at: f.drawn }
				: {}
	const sequence: ReadonlyArray<AuthoredStatementDesc> =
		d.sequence === "tree"
			? [
					{
						kind: "tree",
						member: on("M", ["parent", "at"]),
						slots: fin("M", "children"),
						root: "doc"
					}
				]
			: d.sequence === "ordered"
				? [ordered(on("M", ["s", "at"]), fin("S", "n"))]
				: []
	return {
		name: "Disjoint",
		relations: [
			...Arr.map(owners, (o) =>
				relation(
					o,
					{ id: f.uuid, n: f.drawn, ...(d.folded ? { total: f.accumulated(f.bigint, 0n) } : {}) },
					["id"]
				)
			),
			...(d.sequence === "ordered" ? [relation("S", { id: f.uuid, n: f.drawn }, ["id"])] : []),
			relation(
				"M",
				{
					id: f.uuid,
					x: f.bigint,
					...Rec.fromEntries(Arr.map(owners, (o) => [`g${o}`, f.uuid] as const)),
					...treeFields
				},
				["id"]
			)
		],
		statements: [
			...Arr.flatMap(owners, (o): ReadonlyArray<AuthoredStatementDesc> => [
				counted(on("M", [`g${o}`]), fin(o, "n")),
				...(d.folded
					? [fold(fin(o, "n"), "sum", on("M", [`g${o}`, "x"]), on(o, ["id", "total"]))]
					: [])
			]),
			...sequence
		],
		extends: undefined
	}
}

/**
 * Every family's drawn columns are distinct by identity (owner plus count, and fold plus plane), each a law column
 * native of the member, and every family has its own three axes: an owner axis into its own owner, a predecessor axis
 * over its own index, and a last axis from its own owner, so k counted families give k disjoint sets of law columns and
 * axes; every native is well formed, and the installation holds every column before a constraint names it.
 */
const checkDisjoint = (d: Disjoint): void => {
	const desc = disjointSchema(d)
	const model = modelOf(desc)
	assertWellFormed(model)
	const owned = owning(desc)
	assertColumnsBeforeConstraints(
		succeeded(compileInstallation(owned, installOptions(owned, owner))).statements
	)
	const families = model.families
	assert.equal(
		families.length,
		d.counted + (d.sequence === "none" ? 0 : 1),
		"one family per statement"
	)
	const drawn = Arr.flatMap(families, (family) => [
		family.copy,
		...(family.index.kind === "law" ? [family.index.column] : []),
		...(family.members.kind === "tree" ? [family.members.parentStart] : []),
		...Arr.flatMap(family.folds, (fl) =>
			Arr.flatMap(fl.planes, (p) =>
				Arr.flatMap([p.before, p.after], (x) => (x.kind === "law" ? [x.column] : []))
			)
		)
	])
	assert.equal(
		new Set(drawn).size,
		drawn.length,
		"every family's drawn columns are distinct by identity"
	)
	const natives = new Set(Arr.map(onRelation(model, "LawColumn", "M"), (x) => x.column))
	assert.ok(
		Arr.every(drawn, (x) => natives.has(x)),
		"every drawn column is a law column native of the member"
	)
	const fks = Arr.flatMap(["M", "S", ...Arr.makeBy(d.counted, (j) => `C${j}`)], (r) =>
		onRelation(model, "ForeignKey", r)
	)
	assert.equal(fks.length, 3 * families.length, "three axes per family, and no other reference")
	for (const family of families) {
		const intoOwner = Arr.filter(
			fks,
			(fk) =>
				fk.relation.name === family.member.name &&
				fk.target.name === family.owner.name &&
				fk.target.name !== fk.relation.name
		)
		const ownerAxis = Arr.filter(
			fks,
			(fk) =>
				fk.relation.name === family.member.name &&
				fk.target.name === family.owner.name &&
				Arr.some(fk.columns, (x) => x.kind === "law" && x.column === family.copy)
		)
		assert.equal(
			ownerAxis.length,
			1,
			`the family ${family.id.owner}.${family.id.count} has its own owner axis`
		)
		/** The predecessor axis runs member to member into the index; the last axis, a tree's included, from the owner's
		 * key, which the predecessor's source never reads. */
		const predecessor = Arr.filter(
			fks,
			(fk) =>
				fk.relation.name === family.member.name &&
				fk.target.name === family.member.name &&
				Arr.some(fk.targetColumns, (x) => sameColumn(x, family.index)) &&
				!Arr.some(
					fk.columns,
					(x) => x.kind === "field" && Arr.some(family.group, (g) => g.owner === x.field)
				)
		)
		assert.equal(
			predecessor.length,
			1,
			`the family ${family.id.owner}.${family.id.count} has its own predecessor axis`
		)
		assert.ok(intoOwner.length <= 1, "one reference from the member into each other owner")
	}
}

describe("a family's natives are §2.1's three axes", () => {
	it.effect(
		"every family of group width 1 or 2, ordered or counted, with 0 to 2 copies on each axis",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/model/fin",
						generator: element(shapes),
						literal: Formatter.format,
						/** The space: 2 widths × 4³ copy sets ordered, and 2 widths × 4 owner copy sets counted. */
						limit: 136,
						coverage: requiredInSpace<Feature>(features),
						caseHang,
						box: "every family of group width 1 or 2, ordered or counted, with 0 to 2 copies on each axis it admits",
						oracle: {
							kind: "specification",
							name: "w4-w7 §2.1's axis table as a checker, its CHECKs by the reference evaluator"
						}
					},
					(s, c) =>
						Effect.sync(() => {
							c.note(s.order)
							if (s.width === 2) {
								c.note("two group fields")
							}
							for (const [axis, feature] of [
								["owner", "an owner copy"],
								["predecessor", "a predecessor copy"],
								["last", "a last copy"]
							] as const) {
								if (s[axis].length > 0) {
									c.note(feature)
								}
								if (s[axis].length > 1) {
									c.note("two copies on one axis")
								}
								if (Arr.contains(s[axis], "accumulated")) {
									c.note("an accumulated copy")
								}
							}
							checkShape(s)
						})
				)
			)
	)

	it.effect(
		"a restated lemma rides its axis with no pair: its law is on the axis's foreign key, which names it",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/model/fin-restated",
						generator: element(["owner", "predecessor", "last"] as const),
						literal: Formatter.format,
						/** The space: the three axes, each restated by its own lemma. */
						limit: 3,
						coverage: requiredInSpace<"owner" | "predecessor" | "last">([
							"owner",
							"predecessor",
							"last"
						]),
						caseHang,
						box: "an ordered family of one group field with its lemma restated on each axis",
						oracle: { kind: "specification", name: "w4-w7 §2.1's merging rule" }
					},
					(axis, c) =>
						Effect.sync(() => {
							c.note(axis)
							const s: Shape = { order: "ordered", width: 1, owner: [], predecessor: [], last: [] }
							const desc = schemaOf(s)
							const lemma = {
								owner: contained(on("Member", ["g1"]), on("Owner", ["k1"])),
								predecessor: contained(
									on("Member", ["g1", pred("at")]),
									on("Member", ["g1", "at"])
								),
								last: contained(on("Owner", ["k1", pred("n")]), on("Member", ["g1", "at"]))
							}[axis]
							const model = modelOf({ ...desc, statements: [...desc.statements, lemma] })
							assert.deepEqual(
								foreignKeyShapes(model),
								expectedForeignKeys(s),
								"a restated lemma adds no foreign key"
							)
							const law = familyLaw(model, { owner: "Owner", count: "n" })
							const [riding, ...more] = ridingLaws(model, axis)
							assert.ok(
								riding !== undefined && more.length === 0,
								`the restated ${axis} lemma rides its axis`
							)
							const [fk, ...others] = Arr.filter(
								loweringOf(model, riding),
								(o): o is NativeOf<"ForeignKey"> => o.kind === "ForeignKey"
							)
							assert.ok(
								fk !== undefined && others.length === 0,
								`the restated ${axis} lemma lowers to its axis's foreign key`
							)
							assert.equal(fk.lawIds[0], law, "the axis reports the family's law first")
							assert.ok(
								Arr.contains(fk.lawIds, riding),
								`the ${axis} axis names the restated lemma`
							)
						})
				)
			)
	)

	it.effect(
		"a member in several counted families beside one sequence: every family's columns and axes its own",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/model/fin-disjoint",
						generator: element(disjointShapes),
						literal: Formatter.format,
						/** The space: 1 to 3 counted families, a sum fold over each or none, beside no sequence, an ordered one or a tree. */
						limit: 18,
						coverage: requiredInSpace<DisjointFeature>(disjointFeatures),
						caseHang,
						box: "a member in 1 to 3 counted families, each folded by a sum or not, beside no sequence, an ordered family or a tree",
						oracle: {
							kind: "specification",
							name: "rows-first §1: each family's drawn columns and axes distinct by identity"
						}
					},
					(d, c) =>
						Effect.sync(() => {
							c.note(`${d.counted} counted`)
							c.note(`sequence ${d.sequence}`)
							if (d.folded) {
								c.note("folded")
							}
							checkDisjoint(d)
						})
				)
			)
	)

	it("the payroll fixture's whole IR compiles to a well-formed installation", () => {
		assertWellFormed(ownedFixture(PayrollDesc).laws)
		const owned = owning(PayrollDesc)
		const installed = succeeded(compileInstallation(owned, installOptions(owned, owner)))
		assertColumnsBeforeConstraints(installed.statements)
	})
})
