/**
 * The plan contracts' space of schemas and workloads, and the model each contract reads the other half of its claim
 * from: what every read binds of each relation it scans, how many times its definition reads each, and how many strata
 * and carried bindings each write orders.
 *
 * A shape is a unit Doc of one field, `doc`, and one to three of its members, each keyed by `doc` and one or two fields
 * of its own, `k0` and `k1`, holding one or two values, `v0` and `v1`, closed or mutable inside the unit; a member keyed
 * by `doc` and `k0` alone may be a parent, and a later member may hold its `k0` as a reference into it, a containment
 * PostgreSQL states as a foreign key. Above them stand up to two derived relations, each a join of one or two members on
 * `doc` and `k0`, half the time without the rows of a member a negation finds at them, delivering every match's `v0`
 * beside `doc` and `k0` or beside `doc` alone, or a count of the join's rows by `doc` and `k0` or by `doc` alone; or a
 * union of two members' `(doc, k0, v0)`, and half the time an alias of the first, a derived relation of its
 * definition. Above those stands, half the time, a derived relation over the first: it read
 * once or joined to itself on `doc` and `k0`, delivering its keys, or counted by `doc`. Half the shapes also hold
 * published content: a sealed unit Pkg of two closed relations keyed by `(pkg, item)`, the publication fact F, the
 * count of their join's items by package, which only the package's founding write can change, and a member Seen of Doc
 * whose rows name an item, read through L, each of a document's rows joined to F at its package. The installation stores a derived relation or reads it live, as its storage analysis decides
 * (analysis/derived/storage.ts), and the model states each reading.
 *
 * The workload reads each relation of Doc by its `doc`, a parameter or the document of the row of Owner, a relation of
 * no unit, a parameter keys, and, half the time where its heading holds `k0`, by `k0` too, delivering the rest of its
 * heading; it reads L by `doc`; and it writes every member in one stratum, each
 * parent written by the write that writes a child of it; where a member has a parent, the parents and then the children
 * in two strata (ChangeSet.sequence); the first member, then a member's rows from a binding carried past the first
 * stratum (`writeCarried`); and the content: a package's items in one write, a document's sightings in another.
 */

import { defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Record as Rec, Result } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { contained, key, mutable, on, schema, sealed, unit } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { derivedBuilder, relationBuilder } from "#compiler/schema/relation.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { Relation } from "#compiler/types/schema/relation.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** A member of the unit: its own key fields and values, whether it is mutable, and the parent it references, if any. */
interface MemberSketch {
	readonly keys: 1 | 2
	readonly values: 1 | 2
	readonly mutable: boolean
	readonly parent: Option.Option<number>
}

/**
 * A derived relation over the members (level 1): a join of members on `doc` and `k0`, without the rows of the member
 * `without` finds at them where it names one, delivering each match's `v0` beside `doc` and `k0` (`whole`) or beside
 * `doc` alone (`values`), a count of its rows by `doc` and `k0` (`byKey`) or by `doc` alone (`byDoc`); or a union of
 * two members' `(doc, k0, v0)`. Over the first of them (level 2), `over`: it read once or `twice`, joined to itself on
 * `doc` and `k0`, delivering its keys, or counted by `doc` (`byDoc`).
 */
type DerivedSketch =
	| {
			readonly kind: "join"
			readonly members: Arr.NonEmptyReadonlyArray<number>
			readonly without: Option.Option<number>
			readonly head: "whole" | "values" | "byKey" | "byDoc"
	  }
	| { readonly kind: "union"; readonly members: readonly [number, number] }
	| { readonly kind: "over"; readonly twice: boolean; readonly head: "keys" | "byDoc" }

/**
 * A read of a relation of Doc, a member's or a derived one's, by `doc` and, where `byKey`, by `k0`: its `doc` a
 * parameter, or the document of the row of Owner a parameter keys (`owner`), a document a row in hand binds, as a
 * login's claims bind a learner's unit through the account row they name; or, where its heading holds `k0`, by `k0`
 * alone (`key`), its `doc` delivered, as metis's home read matched AssignmentStatus by its number alone (edullm's Q01)
 * and submit's duration reached test_moment by its stage without its child (Q05): a key of the first member's where
 * the shape declares one (`globalKey`), as `number` is Assignment's and `stage` a sitting's. Each binding is stated in
 * the match, the field at its value, or in a where, the field at a variable the where equates to its value
 * (`stated`), a filter above the relation, which PostgreSQL pushes toward its sources.
 */
interface ReadSketch {
	readonly relation: { readonly kind: "member" | "derived"; readonly at: number }
	readonly byKey: boolean
	readonly via: "param" | "owner" | "key"
	readonly stated: "match" | "where"
}

export interface ShapeSketch {
	readonly members: Arr.NonEmptyReadonlyArray<MemberSketch>
	readonly derived: ReadonlyArray<DerivedSketch>
	readonly reads: ReadonlyArray<ReadSketch>
	readonly content: boolean
	readonly globalKey: boolean
}

/** A member among the earlier `before`: half the time a parent among those keyed by `k0` alone. */
const memberGen =
	(before: ReadonlyArray<MemberSketch>): Gen<MemberSketch> =>
	(source) => {
		const [first, ...rest] = Arr.filterMap(before, (m, at) =>
			m.keys === 1 ? Result.succeed(at) : Result.failVoid
		)
		return {
			keys: source.draw(element([1, 2] as const)),
			values: source.draw(element([1, 2] as const)),
			mutable: source.draw(
				weighted([
					[1, () => true],
					[2, () => false]
				])
			),
			parent:
				first !== undefined && source.draw(boolean)
					? Option.some(source.draw(element([first, ...rest])))
					: Option.none()
		}
	}

/** A derived relation over `count` members (level 1). */
const derivedGen =
	(count: number): Gen<DerivedSketch> =>
	(source) => {
		const member = int(0, count - 1)
		return source.draw(
			weighted<DerivedSketch>([
				[
					3,
					() => ({
						kind: "join",
						members:
							count > 1 && source.draw(boolean)
								? [source.draw(member), source.draw(member)]
								: [source.draw(member)],
						without: source.draw(boolean) ? Option.some(source.draw(member)) : Option.none(),
						head: source.draw(element(["whole", "values", "byKey", "byDoc"] as const))
					})
				],
				[1, () => ({ kind: "union", members: [source.draw(member), source.draw(member)] })]
			])
		)
	}

/**
 * The space over reads of the ways `vias` names (ReadSketch `via`), each binding stated as `stateds` names: `shapeGen`
 * draws a read's `doc` bound by a parameter or by a row in hand, each in its match, `keyShapeGen` by `k0` alone too.
 */
const shapeGenOver =
	(
		vias: Arr.NonEmptyReadonlyArray<ReadSketch["via"]>,
		stateds: Arr.NonEmptyReadonlyArray<ReadSketch["stated"]>
	): Gen<ShapeSketch> =>
	(source) => {
		const count = source.draw(int(1, 3))
		const members: Array<MemberSketch> = []
		for (let at = 0; at < count; at++) {
			members.push(source.draw(memberGen(members)))
		}
		const [first, ...rest] = members
		const all: Arr.NonEmptyReadonlyArray<MemberSketch> = [defined(first, "a first member"), ...rest]
		const drawn = source.draw(array(derivedGen(count), { min: 0, max: 2 }))
		/** Half the time where one is drawn, an alias of the first: a derived relation of its definition, the canonical
		 * relation's (analysis/derived/canonical.ts), whose one table, key and indexes both read. */
		const level1 = drawn[0] !== undefined && source.draw(boolean) ? [...drawn, drawn[0]] : drawn
		const derived: ReadonlyArray<DerivedSketch> =
			level1.length > 0 && source.draw(boolean)
				? [
						...level1,
						{
							kind: "over",
							twice: source.draw(boolean),
							head: source.draw(element(["keys", "byDoc"] as const))
						}
					]
				: level1
		return {
			members: all,
			derived,
			reads: Arr.map(
				[
					...Arr.map(all, (_, at) => ({ kind: "member" as const, at })),
					...Arr.map(derived, (_, at) => ({ kind: "derived" as const, at }))
				],
				(relation) => ({
					relation,
					byKey: source.draw(boolean),
					via: source.draw(element(vias)),
					stated: source.draw(element(stateds))
				})
			),
			content: source.draw(boolean),
			globalKey: all[0].keys === 1 && source.draw(boolean)
		}
	}

export const shapeGen: Gen<ShapeSketch> = shapeGenOver(["param", "owner"], ["match"])
export const keyShapeGen: Gen<ShapeSketch> = shapeGenOver(["param", "owner", "key"], ["match"])
export const whereShapeGen: Gen<ShapeSketch> = shapeGenOver(["param", "owner"], ["match", "where"])

/**
 * A shape that reaches a live derivation read by its key alone, which few drawn shapes reach: a member keyed by
 * (doc, k0) alone, a derived relation joining it whole, a copy of it, which the installation keeps live
 * (analysis/derived/storage.ts copiedRelation), read by k0 alone, and the member read by its document.
 */
export const liveKeyReadGen: Gen<ShapeSketch> = (source) => ({
	members: [
		{
			keys: 1,
			values: source.draw(element([1, 2] as const)),
			mutable: false,
			parent: Option.none()
		}
	],
	derived: [{ kind: "join", members: [0], without: Option.none(), head: "whole" }],
	reads: [
		{
			relation: { kind: "member", at: 0 },
			byKey: source.draw(boolean),
			via: "param",
			stated: "match"
		},
		{ relation: { kind: "derived", at: 0 }, byKey: false, via: "key", stated: "match" }
	],
	content: false,
	globalKey: false
})

/** Owner, outside every unit: each row's document, by its own `id`. */
export const ownerName = "Owner"

/** A member's name, a derived relation's, and a read's program's. */
export const memberName = (at: number): string => `M${at}`
export const derivedName = (at: number): string => `D${at}`
export const readName = (at: number): string => `read${at}`

/** The content's relations: its two closed relations of Pkg, its publication fact, the member that sees items, and L. */
export const contentNames = {
	items: "I0",
	modes: "I1",
	fact: "F",
	seen: "Seen",
	sightings: "L"
} as const

/** The read of L, a document's sightings with their items' publication facts. */
export const contentRead = "readSightings"

/**
 * The writes, by program name: the one-stratum write, the two-strata one, the carried one, the content's publication of
 * a package, and a document's sightings. The carried write gives the first member's facts, then, in a stratum sequenced
 * after them, writes a member's rows from `held`, a relation parameter the call binds to the first member's rows at a
 * document before the call, which the second stratum reads past the first's writes, so the installation carries it
 * (README "Writes").
 */
const wholeWrite = "writeWhole"
export const strataWrite = "writeStrata"
export const carriedWrite = "writeCarried"
export const publishWrite = "writePublish"
const seenWrite = "writeSeen"

/** A member's fields, in declaration order: the unit's, its keys, then its values. */
const memberFields = (m: MemberSketch): Arr.NonEmptyReadonlyArray<string> => [
	"doc",
	"k0",
	...(m.keys === 2 ? ["k1"] : []),
	"v0",
	...(m.values === 2 ? ["v1"] : [])
]

/** A member's primary key: the unit's field, then its own keys. */
export const memberKey = (m: MemberSketch): Arr.NonEmptyReadonlyArray<string> => [
	"doc",
	"k0",
	...(m.keys === 2 ? ["k1"] : [])
]

/** The first derived relation, which an `over` one reads. */
const firstDerived = (s: ShapeSketch): DerivedSketch =>
	defined(s.derived[0], "a first derived relation")

/** The heading a derived relation delivers, in its head's order: an `over` relation's over the first's heading. */
const derivedHeading = (s: ShapeSketch, d: DerivedSketch): Arr.NonEmptyReadonlyArray<string> => {
	switch (d.kind) {
		case "union":
			return ["doc", "k0", "v"]
		case "join":
			switch (d.head) {
				case "whole":
					return ["doc", "k0", ...Arr.map(d.members, (_, i) => `v${i}`)]
				case "values":
					return ["doc", ...Arr.map(d.members, (_, i) => `v${i}`)]
				case "byKey":
					return ["doc", "k0", "n"]
				case "byDoc":
					return ["doc", "n"]
			}
		case "over":
			return d.head === "keys" && overKeyed(s) ? ["doc", "k0"] : ["doc", "n"]
	}
}

/** Whether the first derived relation delivers `k0`, which an `over` relation joins it to itself and keys by. */
const overKeyed = (s: ShapeSketch): boolean => {
	const first = firstDerived(s)
	return first.kind !== "over" && derivedHeading(s, first).includes("k0")
}

/** The heading a read's relation delivers. */
const readHeading = (s: ShapeSketch, read: ReadSketch): ReadonlyArray<string> =>
	read.relation.kind === "member"
		? memberFields(defined(s.members[read.relation.at], "a read member"))
		: derivedHeading(s, defined(s.derived[read.relation.at], "a read derived relation"))

/** Whether a read binds `k0`: where it is drawn to, or reads by it alone, and its relation's heading holds `k0`. */
export const bindsKey = (s: ShapeSketch, read: ReadSketch): boolean =>
	(read.byKey || read.via === "key") && readHeading(s, read).includes("k0")

/** Whether a read binds `doc`: every read but one by `k0` alone. */
export const bindsDoc = (s: ShapeSketch, read: ReadSketch): boolean =>
	read.via !== "key" || !readHeading(s, read).includes("k0")

/** The members a write writes: those of `members` and every parent they reference, at any depth, in order. */
const closedUnderParents = (
	s: ShapeSketch,
	members: ReadonlyArray<number>
): ReadonlyArray<number> => {
	const held = new Set<number>()
	const visit = (at: number): void => {
		if (!held.has(at)) {
			held.add(at)
			Option.map(defined(s.members[at], "a written member").parent, visit)
		}
	}
	Arr.forEach(members, visit)
	return Arr.sort([...held], Order.Number)
}

/** Every member, closed under parents: what the one-stratum write writes. */
const everyMember = (s: ShapeSketch): ReadonlyArray<number> =>
	closedUnderParents(
		s,
		Arr.map(s.members, (_, at) => at)
	)

/**
 * The strata of the two-strata write: the members no member references as a parent of it first, the children after;
 * none where no member has a parent.
 */
const strataOf = (
	s: ShapeSketch
): Option.Option<readonly [ReadonlyArray<number>, ReadonlyArray<number>]> => {
	const children = Arr.filterMap(s.members, (m, at) =>
		Option.isSome(m.parent) ? Result.succeed(at) : Result.failVoid
	)
	return children.length === 0
		? Option.none()
		: Option.some([
				Arr.filter(everyMember(s), (at) => !children.includes(at)),
				Arr.filter(everyMember(s), (at) => children.includes(at))
			])
}

/** The member the carried write's second stratum writes: the last one no parent of which but the first one is. */
const carriedTarget = (s: ShapeSketch): number =>
	Option.getOrElse(
		Arr.findLastIndex(s.members, (m) =>
			Option.match(m.parent, { onNone: () => true, onSome: (parent) => parent === 0 })
		),
		() => 0
	)

/**
 * What the model says a read asks of each relation it scans: the fields of each whose columns its binding fixes, and
 * the occurrences of each its definition reads. A relation the installation stores is read as its table, once at each
 * occurrence; a live one as its definition, each relation it reads at each of their occurrences, a negation's among
 * them, every one at the read's binding, `doc` and `k0` where the read binds it, which every arm, match and negation of
 * every definition holds as its own `doc` and `k0`, whether a parameter binds `doc` or the row of Owner the read keys,
 * which it reads once at its `id`. L's read asks Seen for `doc`, and reads F, or I0 and I1 where F is
 * live, at the packages Seen's rows name, which the plan's joins bind (plan-bindings.ts binding).
 */
export interface ReadAsks {
	readonly fields: ReadonlyMap<string, ReadonlySet<string>>
	readonly occurrences: ReadonlyMap<string, number>
}

/** The occurrences of each relation a reading of `relation` reads, a stored one's as itself (ReadAsks). */
const occurrencesOf = (
	s: ShapeSketch,
	relation: ReadSketch["relation"],
	stored: (name: string) => boolean
): ReadonlyArray<string> => {
	if (relation.kind === "member") {
		return [memberName(relation.at)]
	}
	const name = derivedName(relation.at)
	if (stored(name)) {
		return [name]
	}
	const d = defined(s.derived[relation.at], "a derived relation")
	const member = (at: number) => occurrencesOf(s, { kind: "member", at }, stored)
	switch (d.kind) {
		case "join":
			return [
				...Arr.flatMap(d.members, member),
				...Option.match(d.without, { onNone: () => [], onSome: member })
			]
		case "union":
			return Arr.flatMap(d.members, member)
		case "over": {
			const first = occurrencesOf(s, { kind: "derived", at: 0 }, stored)
			return d.twice && overKeyed(s) ? [...first, ...first] : first
		}
	}
}

/** Each name's count in `names`. */
const counted = (names: ReadonlyArray<string>): ReadonlyMap<string, number> => {
	const counts = new Map<string, number>()
	for (const name of names) {
		counts.set(name, (counts.get(name) ?? 0) + 1)
	}
	return counts
}

/** The model of a read of Doc's relations (ReadAsks), as the installation holds each derived relation (`stored`). */
export const askedOf = (
	s: ShapeSketch,
	read: ReadSketch,
	stored: (name: string) => boolean
): ReadAsks => {
	const bound: ReadonlySet<string> = new Set([
		...(bindsDoc(s, read) ? ["doc"] : []),
		...(bindsKey(s, read) ? ["k0"] : [])
	])
	const occurring = occurrencesOf(s, read.relation, stored)
	const occurrences = counted(read.via === "owner" ? [ownerName, ...occurring] : occurring)
	return {
		fields: new Map([
			...Arr.map(occurring, (name) => [name, bound] as const),
			...(read.via === "owner" ? [[ownerName, new Set(["id"])] as const] : [])
		]),
		occurrences
	}
}

/** The model of L's read (ReadAsks): Seen at `doc`, and F's table or its definition's two relations, once each. */
export const contentAsked = (stored: (name: string) => boolean): ReadAsks => ({
	fields: new Map([[contentNames.seen, new Set(["doc"])]]),
	occurrences: counted([
		contentNames.seen,
		...(stored(contentNames.fact) ? [contentNames.fact] : [contentNames.items, contentNames.modes])
	])
})

/**
 * A generated relation value: its name, fields and key are known only at run time, so its type is the widest the
 * relation constructor gives.
 */
type RelationValue = Relation<
	string,
	Record<string, FieldBase>,
	readonly [string, ...Array<string>]
>

/** A relation of bigint fields under `name`, keyed by `key`. */
const relationOf = (
	name: string,
	fields: ReadonlyArray<string>,
	key: Arr.NonEmptyReadonlyArray<string>
): RelationValue =>
	relationBuilder(name, Rec.fromEntries(Arr.map(fields, (f) => [f, pg.bigint] as const)), key, [])

/** The level-1 derived relation `d` over `base` and its members' values. */
const derivedValue = (
	s: ShapeSketch,
	base: ReturnType<typeof schema>,
	members: ReadonlyArray<RelationValue>,
	d: Exclude<DerivedSketch, { readonly kind: "over" }>,
	name: string
) => {
	const member = (at: number): RelationValue => defined(members[at], "a derived relation's member")
	if (d.kind === "union") {
		const arm = (at: number, i: number) => (r: RuleValue) => {
			const m = varsOver(member(at), `u${i}`)
			return r
				.match(member(at), { doc: m["doc"], k0: m["k0"], v0: m["v0"] })
				.find({ doc: m["doc"], k0: m["k0"], v: m["v0"] })
		}
		return derivedBuilder(
			name,
			queryOver(base).rule(arm(d.members[0], 0)).rule(arm(d.members[1], 1)),
			[]
		)
	}
	return derivedBuilder(
		name,
		queryOver(base).rule((r: RuleValue) => {
			const [head, ...rest] = d.members
			const first = varsOver(member(head), "j0")
			/** Every field of the member at `at` bound, its `doc` and `k0` to the first match's, so each match binds the
			 * member's whole key, as a count over the join reads each fact by it. */
			const whole = (at: number, vars: Readonly<Record<string, unknown>>) =>
				Rec.fromEntries(
					Arr.map(
						memberFields(defined(s.members[at], "a matched member")),
						(f) => [f, f === "doc" || f === "k0" ? first[f] : vars[f]] as const
					)
				)
			const values: Array<readonly [string, unknown]> = [["v0", first["v0"]]]
			let ruled = r.match(member(head), whole(head, first))
			for (const [i, at] of rest.entries()) {
				const m = varsOver(member(at), `j${i + 1}`)
				ruled = ruled.match(member(at), whole(at, m))
				values.push([`v${i + 1}`, m["v0"]])
			}
			const kept = Option.match(d.without, {
				onNone: () => ruled,
				onSome: (at) => ruled.where(r.not(member(at), { doc: first["doc"], k0: first["k0"] }))
			})
			switch (d.head) {
				case "whole":
					return kept.find({ doc: first["doc"], k0: first["k0"], ...Rec.fromEntries(values) })
				case "values":
					return kept.find({ doc: first["doc"], ...Rec.fromEntries(values) })
				case "byKey":
					return kept.find({ doc: first["doc"], k0: first["k0"], n: r.count() })
				case "byDoc":
					return kept.find({ doc: first["doc"], n: r.count() })
			}
		}),
		[]
	)
}

/**
 * The shape's schema under `name`, its levels, its full world's login, whose workload holds its programs, and the
 * programs, by name: a read of each relation of Doc (ReadSketch), L's read, and the writes (see the header).
 */
export const built = (s: ShapeSketch, name: string) => {
	const members = Arr.map(s.members, (m, at) =>
		relationOf(memberName(at), memberFields(m), memberKey(m))
	)
	const member = (at: number): RelationValue => defined(members[at], "a member value")
	const items = relationOf(contentNames.items, ["pkg", "item", "kind"], ["pkg", "item"])
	const modes = relationOf(contentNames.modes, ["pkg", "item", "mode"], ["pkg", "item"])
	const seen = relationOf(contentNames.seen, ["doc", "n", "pkg", "item"], ["doc", "n"])
	const owner = relationOf(ownerName, ["id", "doc"], ["id"])
	const base = schema(
		name,
		[...members, owner, ...(s.content ? [items, modes, seen] : [])],
		[
			unit("Doc", { doc: pg.bigint }),
			...(s.content ? [sealed(unit("Pkg", { pkg: pg.bigint }))] : []),
			...Arr.flatMap(s.members, (m, at) => (m.mutable ? [mutable(member(at))] : [])),
			...(s.globalKey ? [key(on(member(0), "k0"))] : []),
			...Arr.flatMap(s.members, (m, at) =>
				Option.match(m.parent, {
					onNone: () => [],
					onSome: (parent) => [
						contained(on(member(at), "doc", "k0"), on(member(parent), "doc", "k0"))
					]
				})
			)
		]
	)
	const level1 = Arr.filterMap(s.derived, (d, at) =>
		d.kind === "over"
			? Result.failVoid
			: Result.succeed(derivedValue(s, base, members, d, derivedName(at)))
	)
	const fact = derivedBuilder(
		contentNames.fact,
		queryOver(base).rule((r: RuleValue) => {
			const i = varsOver(items, "item")
			const m = varsOver(modes, "mode")
			return r
				.match(items, { pkg: i["pkg"], item: i["item"], kind: i["kind"] })
				.match(modes, { pkg: i["pkg"], item: i["item"], mode: m["mode"] })
				.find({ pkg: i["pkg"], items: r.count() })
		}),
		[]
	)
	const firstLevel = [...level1, ...(s.content ? [fact] : [])]
	const first = firstLevel.length === 0 ? base : schema.extend([base], `${name}_1`, firstLevel, [])
	const firstDerivedValue = level1[0]
	const sightings = s.content
		? Option.some(
				derivedBuilder(
					contentNames.sightings,
					queryOver(first).rule((r: RuleValue) => {
						const x = varsOver(seen, "seen")
						const f = varsOver(fact, "fact")
						return r
							.match(seen, { doc: x["doc"], n: x["n"], pkg: x["pkg"], item: x["item"] })
							.match(fact, { pkg: x["pkg"], items: f["items"] })
							.find({ doc: x["doc"], n: x["n"], items: f["items"] })
					}),
					[]
				)
			)
		: Option.none()
	const overValue = Option.flatMap(
		Arr.findFirst(s.derived, (d) => d.kind === "over"),
		(d) =>
			firstDerivedValue === undefined
				? Option.none()
				: Option.some(
						derivedBuilder(
							derivedName(s.derived.length - 1),
							queryOver(first).rule((r: RuleValue) => {
								const heading = derivedHeading(s, firstDerived(s))
								const keyed = overKeyed(s)
								const a = varsOver(firstDerivedValue, "a")
								const b = varsOver(firstDerivedValue, "b")
								const once = r.match(
									firstDerivedValue,
									Rec.fromEntries(Arr.map(heading, (f) => [f, a[f]] as const))
								)
								const ruled =
									d.twice && keyed
										? once.match(
												firstDerivedValue,
												Rec.fromEntries(
													Arr.map(
														heading,
														(f) => [f, f === "doc" || f === "k0" ? a[f] : b[f]] as const
													)
												)
											)
										: once
								return d.head === "keys" && keyed
									? ruled.find({ doc: a["doc"], k0: a["k0"] })
									: ruled.find({ doc: a["doc"], n: r.count() })
							}),
							[]
						)
					)
	)
	const secondLevel = [...Option.toArray(overValue), ...Option.toArray(sightings)]
	const top =
		secondLevel.length === 0 ? first : schema.extend([first], `${name}_2`, secondLevel, [])
	const derived = [...level1, ...Option.toArray(overValue)]
	const relationRead = (read: ReadSketch) =>
		read.relation.kind === "member"
			? member(read.relation.at)
			: defined(derived[read.relation.at], "a read derived value")
	const reads = Arr.map(s.reads, (read, at) => {
		const relation = relationRead(read)
		const keyed = bindsKey(s, read)
		return [
			readName(at),
			queryOver(top).rule((r: RuleValue) => {
				const vars = varsOver(relation, `r${at}`)
				const held = varsOver(owner, `o${at}`)
				const bindings: Record<string, unknown> = {}
				const head: Record<string, unknown> = {}
				const equalities: Array<unknown> = []
				/** The field `f` bound to `value`: in the match, or by a where over its own variable. */
				const bind = (f: string, value: unknown): void => {
					if (read.stated === "match") {
						bindings[f] = value
					} else {
						bindings[f] = vars[f]
						equalities.push(r.eq(vars[f], value))
					}
				}
				for (const f of readHeading(s, read)) {
					if (f === "doc" && bindsDoc(s, read)) {
						bind(f, read.via === "owner" ? held["doc"] : r.param("doc", pg.bigint))
					} else if (f === "k0" && keyed) {
						bind(f, r.param("k0", pg.bigint))
					} else {
						bindings[f] = vars[f]
						head[f] = vars[f]
					}
				}
				const owned =
					read.via === "owner"
						? r.match(owner, { id: r.param("id", pg.bigint), doc: held["doc"] })
						: r
				const matched = owned.match(relation, bindings)
				const [first, ...rest] = equalities
				const filtered =
					first === undefined
						? matched
						: matched.where(rest.length === 0 ? first : r.and(equalities))
				return filtered.find(Rec.isEmptyRecord(head) ? { doc: bindings["doc"] } : head)
			})
		] as const
	})
	const inserting = (ats: ReadonlyArray<number>) =>
		Arr.reduce(ats, ChangeSet.empty(top), (cs, at) => cs.insert(member(at), []))
	const target = carriedTarget(s)
	const targetFields = memberFields(defined(s.members[target], "the carried write's member"))
	const carried = ChangeSet.sequence(
		inserting([0]),
		ChangeSet.empty(top).insert(
			member(target),
			queryOver(top).rule((r: RuleValue) => {
				const held = r.relation("held", { doc: pg.bigint, k0: pg.bigint, v0: pg.bigint })
				const h = varsOver(held, "held")
				return r
					.match(held, { doc: h["doc"], k0: h["k0"], v0: h["v0"] })
					.find(
						Rec.fromEntries(
							Arr.map(
								targetFields,
								(f) => [f, f === "doc" || f === "k0" || f === "v0" ? h[f] : 1n] as const
							)
						)
					)
			})
		)
	).bind({
		held: queryOver(top).rule((r: RuleValue) => {
			const m = varsOver(member(0), "first")
			return r
				.match(member(0), { doc: r.param("doc", pg.bigint), k0: m["k0"], v0: m["v0"] })
				.find({ doc: r.param("doc", pg.bigint), k0: m["k0"], v0: m["v0"] })
		})
	})
	const content = Option.match(sightings, {
		onNone: () => [],
		onSome: (l) => [
			[
				contentRead,
				queryOver(top).rule((r: RuleValue) => {
					const v = varsOver(l, "l")
					return r
						.match(l, { doc: r.param("doc", pg.bigint), n: v["n"], items: v["items"] })
						.find({ n: v["n"], items: v["items"] })
				})
			] as const,
			[publishWrite, ChangeSet.empty(top).insert(items, []).insert(modes, [])] as const,
			[seenWrite, ChangeSet.empty(top).insert(seen, [])] as const
		]
	})
	const programs: Readonly<Record<string, unknown>> = Rec.fromEntries([
		...reads,
		[wholeWrite, inserting(everyMember(s))] as const,
		...Option.match(strataOf(s), {
			onNone: () => [],
			onSome: ([parents, children]) => [
				[strataWrite, ChangeSet.sequence(inserting(parents), inserting(children))] as const
			]
		}),
		[carriedWrite, carried] as const,
		...content
	])
	return { schema: top, programs, world: fullWorld(top, programs, []) }
}

/** The facts a write's call gives, under each op and then each relation. */
type CallFacts = Readonly<Record<string, Readonly<Record<string, ReadonlyArray<unknown>>>>>

/** One write, by its program's name: the facts its call `call` gives, and the parameters it binds. */
interface WriteCall {
	readonly program: string
	readonly facts: (call: number) => CallFacts
	readonly params: (call: number) => Readonly<Record<string, unknown>>
}

/** One row of `fields` with `unitField` at `at`, every other field 1. */
const rowAt = (fields: ReadonlyArray<string>, unitField: string, at: bigint) =>
	Rec.fromEntries(Arr.map(fields, (f) => [f, f === unitField ? at : 1n] as const))

/**
 * The calls of each write: each call `call` writes one row of each relation it gives facts of at the document, or the
 * package, `100 + call`, a member's `k0` too, so no two calls meet, a key of `k0` alone among them, each other field 1,
 * a child's reference the row of its parent the call writes; the carried write's `held` reads the first member at its first call's document, so its second call carries
 * the row the first wrote.
 */
export const writeCalls = (s: ShapeSketch): ReadonlyArray<WriteCall> => {
	const facts =
		(written: ReadonlyArray<number>) =>
		(call: number): CallFacts => ({
			insert: Rec.fromEntries(
				Arr.map(written, (at) => [
					memberName(at),
					[
						Rec.fromEntries(
							Arr.map(
								memberFields(defined(s.members[at], "a written member")),
								(f) => [f, f === "doc" || f === "k0" ? BigInt(100 + call) : 1n] as const
							)
						)
					]
				])
			)
		})
	const none = () => ({})
	return [
		{ program: wholeWrite, facts: facts(everyMember(s)), params: none },
		...Option.match(strataOf(s), {
			onNone: () => [],
			onSome: ([parents, children]) => [
				{ program: strataWrite, facts: facts([...parents, ...children]), params: none }
			]
		}),
		{
			program: carriedWrite,
			facts: facts([0]),
			params: (call: number) => ({ doc: BigInt(100 + call - (call % 2)) })
		},
		...(s.content
			? [
					{
						program: publishWrite,
						facts: (call: number): CallFacts => ({
							insert: {
								[contentNames.items]: [rowAt(["pkg", "item", "kind"], "pkg", BigInt(100 + call))],
								[contentNames.modes]: [rowAt(["pkg", "item", "mode"], "pkg", BigInt(100 + call))]
							}
						}),
						params: none
					},
					{
						program: seenWrite,
						facts: (call: number): CallFacts => ({
							insert: {
								[contentNames.seen]: [rowAt(["doc", "n", "pkg", "item"], "doc", BigInt(100 + call))]
							}
						}),
						params: none
					}
				]
			: [])
	]
}
