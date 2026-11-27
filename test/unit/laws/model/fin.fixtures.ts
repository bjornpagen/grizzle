/** What the properties of fin.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import type { AxisKind } from "#compiler/ir/family.ts"
import type { NativeColumn } from "#compiler/ir/law.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { succeeded } from "#test/support/assert.ts"
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
import { assertReferencesServed } from "#test/support/laws/referencing.ts"
import { owning } from "#test/support/policy.ts"
import {
	accepts,
	assertColumnsBeforeConstraints,
	assertWellFormed,
	checksOf,
	drawnColumn,
	familyLaw,
	foreignKeyOrder,
	type ForeignKeyShape,
	foreignKeyShapes,
	generatedColumn,
	generatedOn,
	keySets,
	loweringOf,
	modelOf,
	onRelation,
	reverseSets,
	ridingLaws
} from "#test/unit/laws/model/natives.ts"

type Copy = "caller" | "accumulated"

type Copies = ReadonlyArray<Copy>

/** An axis's copies: a caller copy or none and an accumulated one or none, in that order. */
const copiesGen: Gen<Copies> = subarray(["caller", "accumulated"] as const)

interface Shape {
	readonly order: "ordered" | "counted"
	readonly width: 1 | 2
	readonly owner: Copies
	readonly predecessor: Copies
	readonly last: Copies
}

const orders = ["ordered", "counted"] as const

const widths = [1, 2] as const

/** The box: a family of either order and width, with copies on each axis it admits: a counted family's index is a
 * drawn column no side names, so only its owner axis takes a copy. */
export const shapeGen: Gen<Shape> = (source) => {
	const order = source.draw(element(orders))
	const width = source.draw(element(widths))
	const owner = source.draw(copiesGen)
	return order === "ordered"
		? {
				order,
				width,
				owner,
				predecessor: source.draw(copiesGen),
				last: source.draw(copiesGen)
			}
		: { order, width, owner, predecessor: [], last: [] }
}

export type Feature =
	| "ordered"
	| "counted"
	| "two group fields"
	| "an owner copy"
	| "a predecessor copy"
	| "a last copy"
	| "an accumulated copy"
	| "two copies on one axis"

export const features: Arr.NonEmptyReadonlyArray<Feature> = [
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

export const schemaOf = (s: Shape): SchemaDesc => {
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
		bases: []
	}
}

const sortText = (xs: ReadonlyArray<string>): ReadonlyArray<string> => Arr.sort(xs, Order.String)

/** The owner's key as its owner axis reaches it: its first field where its count is above 0 (‹k⁺›), the rest as they
 * are. */
const holdingKeys = (s: Shape): ReadonlyArray<string> =>
	Arr.map(keys(s), (k, j) => (j === 0 ? `‹generated ${k}›` : k))

/** §2.1's foreign keys for a shape, each as its contract reads it: the owner axis, its holding reference into the
 * owner's key where it holds a member, deferred, and where it carries copies their foreign key beside it, ON UPDATE
 * CASCADE; the predecessor axis pairing each member's index with its predecessor's successor ‹next›; the last axis
 * pairing the owner's last slot with its last member's slot and successor alike. */
export const expectedForeignKeys = (s: Shape): ReadonlyArray<ForeignKeyShape> => {
	const i = s.order === "ordered" ? "at" : "‹index›"
	const p = predOf(s)
	const groupPairs = Arr.map(Arr.zip(group(s), keys(s)), ([g, k]) => ({ g, k }))
	const holdingPairs = Arr.map(Arr.zip(group(s), holdingKeys(s)), ([g, k]) => ({ g, k }))
	const fk = (
		from: string,
		to: string,
		pairs: ReadonlyArray<string>,
		onUpdate: "cascade" | "noAction",
		deferrable: boolean
	): ForeignKeyShape => ({ from, to, pairs: sortText(pairs), onUpdate, deferrable })
	const ownerCopies = named("owner", s.owner)
	return Arr.sort(
		[
			...(Arr.isArrayNonEmpty(ownerCopies)
				? [
						fk(
							"Member",
							"Owner",
							[
								...Arr.map(groupPairs, ({ g, k }) => `${g} → ${k}`),
								...Arr.map(ownerCopies, (c) => `${c.from} → ${c.to}`)
							],
							"cascade",
							false
						)
					]
				: []),
			fk(
				"Member",
				"Owner",
				Arr.map(holdingPairs, ({ g, k }) => `${g} → ${k}`),
				"noAction",
				true
			),
			fk(
				"Member",
				"Member",
				[
					...Arr.map(group(s), (g) => `${g} → ${g}`),
					`${p} → ${i}`,
					`${i} → ‹next›`,
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
					"‹generated n› → ‹next›",
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

/** The generated pred of a shape's index, ‹p›: of `at` when ordered, of the count's ‹i› when counted. */
const predOf = (s: Shape): string => (s.order === "ordered" ? "‹generated at›" : "‹generated n›")

/** §2.1's keys for a shape: the primary keys, the family key, its successor key (g…, ‹p›), each member the predecessor
 * of at most one, one member superkey (g…, i, ‹next›) per distinct carried set, the owner's key beside its copies, and
 * the owner's key where it holds a member. */
const expectedKeys = (s: Shape) => {
	const i = s.order === "ordered" ? "at" : "‹index›"
	const familyKey = [...group(s), i]
	const successors = [...familyKey, "‹next›"]
	return {
		Member: sortText([
			...new Set([
				"id",
				setText(familyKey),
				setText([...group(s), predOf(s)]),
				setText([...successors, ...Arr.map(named("pred", s.predecessor), (c) => c.to)]),
				setText([...successors, ...Arr.map(named("last", s.last), (c) => c.to)])
			])
		]),
		Owner: sortText([
			...new Set([
				setText(keys(s)),
				setText([...keys(s), ...Arr.map(named("owner", s.owner), (c) => c.to)]),
				setText(holdingKeys(s))
			])
		])
	}
}

const naturals = [0n, 1n, 2n, 3n] as const

/**
 * The family's row conditions: none for an ordered family, its index a natural, and for a counted one a CHECK accepting
 * exactly the rows where 0 ≤ ‹i›, its index a law column no natural domain keeps there. No member holds its owner's
 * count, so no CHECK bounds the index by it: the predecessor and last axes do (expectedForeignKeys).
 */
const checkBound = (model: LawModel, s: Shape): void => {
	const law = familyLaw(model, { owner: "Owner", count: "n" })
	const checks = checksOf(model, "Member", law)
	if (s.order === "ordered") {
		assert.equal(checks.length, 0, "an ordered family states no CHECK on its member")
		return
	}
	const [check, ...more] = checks
	assert.ok(
		check !== undefined && more.length === 0,
		"a counted family states one CHECK on its member"
	)
	const index = drawnColumn(model, "Member", "index")
	for (const i of [-1n, ...naturals]) {
		assert.equal(accepts(check, new Map([[index, i]])), i >= 0n, `‹i› = ${i}`)
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
	/** The owner axis's foreign key: its copies' where it carries any, its holding reference where it carries none. */
	const axisOf = (axis: "owner" | "predecessor" | "last") =>
		Arr.filter(fks, (fk) =>
			axis === "owner"
				? fk.target.name === "Owner" &&
					fk.relation.name === "Member" &&
					(Arr.isReadonlyArrayNonEmpty(s.owner) ? fk.onUpdate === "cascade" : fk.deferrable)
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
		for (const r of riding) {
			assert.ok(
				Arr.contains(loweringOf(model, r), fk),
				`a riding copy's lowering is its axis's foreign key`
			)
			/** The copy a riding law states: the one whose source field its left side carries, the theory holding its
			 * laws in its statements' order, never the order the shape declares its copies in. */
			const detail = Option.map(
				Arr.findFirst(model.theory.laws, (l) => l.id === r),
				(l) => l.detail
			)
			const carried =
				Option.isSome(detail) && detail.value.kind === "containment" ? detail.value.from.terms : []
			const copy = Option.getOrUndefined(
				Arr.findFirst(copies, (c) =>
					Arr.some(carried, (t) => t.kind === "field" && t.field === c.from)
				)
			)
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

/** Each axis's reverse index for a shape, over its referencing columns that pair with its target's key, as a set: the
 * owner axis's (g…) and the predecessor's (g…, ‹p›) on the member, the last axis's (k…, ‹pn›) on the owner; never
 * over a copy an axis carries, which every row referencing one target row holds alike. */
const expectedReverse = (s: Shape) => ({
	Member: sortText([setText(group(s)), setText([...group(s), predOf(s)])]),
	Owner: [setText([...keys(s), "‹generated n›"])]
})

export const checkShape = (s: Shape): void => {
	const desc = schemaOf(s)
	const model = modelOf(desc)
	assertWellFormed(model)
	const owned = owning(desc)
	assertReferencesServed(succeeded(compileInstallation(owned, installOptions(owned))).statements)
	assert.deepEqual(foreignKeyShapes(model), expectedForeignKeys(s))
	const expected = expectedKeys(s)
	assert.deepEqual(keySets(model, "Member"), expected.Member)
	assert.deepEqual(keySets(model, "Owner"), expected.Owner)
	const reverse = expectedReverse(s)
	assert.deepEqual(
		reverseSets(model, "Member"),
		reverse.Member,
		"each axis on the member carries its reverse index"
	)
	assert.deepEqual(
		reverseSets(model, "Owner"),
		reverse.Owner,
		"the last axis carries its reverse index"
	)
	checkBound(model, s)
	checkPreds(model, s)
	checkCopies(model, s)
}

/** A family's own lemma on one axis, restated by the schema: the family of a shape with no copies. */
interface Restated {
	readonly shape: Shape
	readonly axis: AxisKind
}

export type RestatedFeature = AxisKind | "counted" | "two group fields"

/** The box: a family of either order and width, restated on an axis its sides can name: a counted family's index is a
 * drawn column no side names, so only its owner axis. */
export const restatedGen: Gen<Restated> = (source) => {
	const order = source.draw(element(orders))
	const shape: Shape = {
		order,
		width: source.draw(element(widths)),
		owner: [],
		predecessor: [],
		last: []
	}
	return {
		shape,
		axis:
			order === "ordered"
				? source.draw(element(["owner", "predecessor", "last"] as const))
				: "owner"
	}
}

/** The lemma a family states on an axis, written as a containment: the member's group into the owner's key, the
 * predecessor's index into the index, and the owner's last index into the index. */
export const lemmaOf = (r: Restated): AuthoredStatementDesc => {
	const g = group(r.shape)
	const k = keys(r.shape)
	switch (r.axis) {
		case "owner":
			return contained(on("Member", g), on("Owner", k))
		case "predecessor":
			return contained(on("Member", [...g, pred("at")]), on("Member", [...g, "at"]))
		case "last":
			return contained(on("Owner", [...k, pred("n")]), on("Member", [...g, "at"]))
	}
}

/** Whether two native columns are one: one field's handle, or one law column's identifier. */
const sameColumn = (a: NativeColumn, b: NativeColumn): boolean =>
	a.kind === "field"
		? b.kind === "field" && a.field === b.field
		: b.kind === "law" && a.column === b.column

/**
 * A member in one to three counted families of distinct owners, each folded by a sum into its owner or not (rows-first
 * §1). A member of a counted family is a member of no sequence: one is written nested under its owner, the other as
 * rows of its own, which the schema refuses as UnwritableRelation, held against its reference by unit/write/fill-order.
 */
type Disjoint = ReadonlyArray<boolean>

/** The box: every member in 1 to 3 counted families, each folded or not. */
export const disjointGen: Gen<Disjoint> = array(boolean, { min: 1, max: 3 })

export type DisjointFeature =
	| "1 counted"
	| "2 counted"
	| "3 counted"
	| "a folded family"
	| "an unfolded family"

export const disjointFeatures: Arr.NonEmptyReadonlyArray<
	DisjointFeature | readonly [DisjointFeature, DisjointFeature]
> = [
	"1 counted",
	"2 counted",
	"3 counted",
	"a folded family",
	"an unfolded family",
	["a folded family", "an unfolded family"]
]

const disjointSchema = (d: Disjoint): SchemaDesc => {
	const owners = Arr.map(d, (folded, j) => ({ name: `C${j}`, folded }))
	return {
		name: "Disjoint",
		relations: [
			...Arr.map(owners, (o) =>
				relation(
					o.name,
					{ id: f.uuid, n: f.drawn, ...(o.folded ? { total: f.accumulated(f.bigint, 0n) } : {}) },
					["id"]
				)
			),
			relation(
				"M",
				{
					id: f.uuid,
					x: f.bigint,
					...Rec.fromEntries(Arr.map(owners, (o) => [`g${o.name}`, f.uuid] as const))
				},
				["id"]
			)
		],
		statements: Arr.flatMap(owners, (o): ReadonlyArray<AuthoredStatementDesc> => [
			counted(on("M", [`g${o.name}`]), fin(o.name, "n")),
			...(o.folded
				? [fold(fin(o.name, "n"), "sum", on("M", [`g${o.name}`, "x"]), on(o.name, ["id", "total"]))]
				: [])
		]),
		bases: []
	}
}

/**
 * Every family's drawn columns are distinct by identity (owner plus count, and fold plus plane), each a law column
 * native of the member, and every family has its own three axes: an owner axis into its own owner, a predecessor axis
 * over its own index, and a last axis from its own owner, so k counted families give k disjoint sets of law columns and
 * axes; every native is well formed, and the installation holds every column before a constraint names it.
 */
export const checkDisjoint = (d: Disjoint): void => {
	const desc = disjointSchema(d)
	const model = modelOf(desc)
	assertWellFormed(model)
	const owned = owning(desc)
	assertColumnsBeforeConstraints(
		succeeded(compileInstallation(owned, installOptions(owned))).statements
	)
	const families = model.families
	assert.equal(families.length, d.length, "one family per counted statement")
	const drawn = Arr.flatMap(families, (family) => [
		family.next,
		...(family.shape.kind === "counted" ? [family.shape.index.column] : []),
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
	const fks = Arr.flatMap(["M", ...Arr.map(d, (_, j) => `C${j}`)], (r) =>
		onRelation(model, "ForeignKey", r)
	)
	assert.equal(
		fks.length,
		3 * families.length,
		"three axes per family, its owner axis its holding reference, which carries no copy, and no other reference"
	)
	for (const family of families) {
		const ownerAxis = Arr.filter(
			fks,
			(fk) =>
				fk.relation.name === family.member.name &&
				fk.target.name === family.owner.name &&
				fk.target.name !== fk.relation.name
		)
		assert.equal(
			ownerAxis.length,
			1,
			`the family ${family.id.owner}.${family.id.count} has its own owner axis, its holding reference`
		)
		/** The predecessor axis runs member to member into the index; the last axis from the owner's key, which the
		 * predecessor's source never reads. */
		const predecessor = Arr.filter(
			fks,
			(fk) =>
				fk.relation.name === family.member.name &&
				fk.target.name === family.member.name &&
				Arr.some(fk.targetColumns, (x) => sameColumn(x, family.shape.index)) &&
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
	}
}
