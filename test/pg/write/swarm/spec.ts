/**
 * The schemas the family swarm search draws (test/pg/write/swarm/families.test.ts): a family core of relations R0 …
 * Rn−1 as the reference writer specifies them (test/support/families/fill.ts FillSpec: trees, ordered and counted
 * families, folds, copies riding their axes, steps over copies, generated fields, mutable relations), with what the
 * reference writer's own generator never draws together: many relations, owners of several families, members that
 * own families, cycles of families (an owner of a family whose member owns a family of it), and fold ends of the
 * monoids max (over a member's `v`) and or (over a member's set `b` of a five-handle roster); beside plain relations
 * P0 … Pm−1, each a pure set `{ x }` or a referrer `{ id, r, x }`; and laws between the two: a family relation's `v`
 * contained in a pure set (an immediate foreign key), a referrer contained in a family relation's rows or in a
 * family's members, an owner (or the owners with one member) contained in its members (a law on a cycle with the owner
 * axis), a key over a family's members, a selection over a copy contained in a pure set, a row check over a
 * relation's `v` and the count of a family it owns, and a family relation naming a counted member's row whole (an
 * immediate foreign key into a family's member, so the member's rows land before the naming relation's and that
 * relation's own members after them: pantry's importWrite shape).
 *
 * Every name is the reference writer's (fill.ts): relation `R<i>`, family `f`'s count `n<f>`, group `o<f>`, index
 * `i<f>`, root `d<f>` and sum or count fold `s<f>`, copy `j`'s field `c<j>`; this module adds a member's set `b`, the
 * extra fold end `e<f>`, the plain relations `P<j>`, the check `C<i>`, and a naming relation's copy of family `f`'s
 * group `o<f>` (the shared-field column) beside the named row's id `m<f>` and `v` `w<f>`.
 */
import { boolean, type Gen, int } from "@grizzle/testing/gen"
import { keep, type Swarm, swarm, swarmChoice, weightOf } from "@grizzle/testing/swarm"
import { Array as Arr, Option, Order, Record as Rec, String as Str } from "effect"
import { int8Min } from "#compiler/core/limits.ts"
import { accumulated, bits, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import { type AnyFamily, type RowScalars, schema, type Statement } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import {
	accumulatedField,
	bitsOf,
	closed,
	generatedField,
	generatedRelation,
	relation
} from "#compiler/schema/relation.ts"
import {
	checkBuilder,
	containedBuilder,
	countedBuilder,
	finBuilder,
	foldBuilder,
	keyBuilder,
	monoids,
	mutableBuilder,
	onBuilder,
	orderedBuilder,
	predBuilder,
	selectBuilder,
	treeBuilder
} from "#compiler/schema/statements.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyRelation, AnyRoster, Relation } from "#compiler/types/schema/relation.ts"
import { defined } from "#test/support/assert.ts"
import {
	admittedSources,
	type Axis,
	type CopySource,
	type FamilyKind,
	type FillSpec,
	groupFieldsOf,
	groupName,
	type InstanceRow,
	keyOfRelation,
	rootFieldsOf,
	relationName,
	sourcesFor,
	uuidOfRow
} from "#test/support/families/fill.ts"
import { upTo } from "#test/support/up-to.ts"

/** An extra fold end over a family: max over its member's `v`, or or over its member's set `b`, into its owner's `e<f>`. */
export interface EndSpec {
	readonly family: number
	readonly monoid: "max" | "or"
}

/** A plain relation: a pure set `{ x }` keyed by `x`, or a referrer `{ id, r, x }` keyed by `id`. */
export interface PlainSpec {
	readonly kind: "set" | "referrer"
	readonly mutable: boolean
}

/**
 * A law between the family core and the plain relations, each a statement of the schema:
 * - `into set`: `contained(on(R, "v"), on(P, "x"))`, P a pure set, so its foreign key is immediate;
 * - `into rows`: `contained(on(P, "r"), on(R, "id"))`, P a referrer;
 * - `into members`: `contained(on(P, "r", "x"), on(M, o<f>, "v"))`, P a referrer, M family `f`'s member;
 * - `owner into members`: `contained(on(O or select(O, n<f> = 1), "id", "v"), on(M, o<f>, "v"))`;
 * - `member key`: `key(on(M, o<f>, "v"))`, which a containment into a family's members needs, its target holding a key;
 * - `selected`: `contained(on(select(R, c<copy> > 0), "v"), on(P, "x"))`, R holding copy `copy`, P a pure set;
 * - `check`: `check("C<i>", R, …)`: `v > -3`, or, where `family` names a family R owns, `n<f> < 3 or v >= 0`;
 * - `into member rows`: `contained(on(R, o<f>, m<f>, w<f>), on(M, o<f>, "id", "v"))`, M family `f`'s counted member
 *   holding exactly `id`, `v` and `o<f>`, R after M and no family's member: each row of R names one row of M whole,
 *   R's `o<f>` the member's group field it shares, so its foreign key is immediate.
 */
export type LawSpec =
	| { readonly kind: "into set"; readonly relation: number; readonly plain: number }
	| { readonly kind: "into rows"; readonly plain: number; readonly relation: number }
	| { readonly kind: "into members"; readonly plain: number; readonly family: number }
	| { readonly kind: "owner into members"; readonly family: number; readonly selected: boolean }
	| { readonly kind: "member key"; readonly family: number }
	| { readonly kind: "selected"; readonly copy: number; readonly plain: number }
	| { readonly kind: "check"; readonly relation: number; readonly family: number | undefined }
	| { readonly kind: "into member rows"; readonly relation: number; readonly family: number }

/** A drawn schema: its family core, its extra fold ends, its plain relations and its laws. */
export interface SwarmSpec {
	readonly fill: FillSpec
	readonly ends: ReadonlyArray<EndSpec>
	readonly plains: ReadonlyArray<PlainSpec>
	readonly laws: ReadonlyArray<LawSpec>
}

/** The features a drawn case turns on, swarm by swarm. */
const swarmFeatures = [
	"ordered",
	"counted",
	"tree",
	"several families per owner",
	"member owning a family",
	"cycle of families",
	"fold",
	"max end",
	"or end",
	"owner copy",
	"predecessor copy",
	"last copy",
	"copy of a copy",
	"fold over a copy",
	"generated",
	"mutable",
	"plain set",
	"plain referrer",
	"law into a set",
	"law into rows",
	"law into members",
	"owner into members",
	"member key",
	"selection over a copy",
	"check",
	"law into member rows",
	"scale",
	"split members",
	"repeated fact",
	"strata",
	"query insert",
	"query put",
	"follow-ups",
	"delete all",
	"unlawful"
] as const

export type SwarmFeature = (typeof swarmFeatures)[number]

export const plainName = (j: number): string => `P${j}`
export const countName = (f: number): string => `n${f}`
const indexName = (f: number): string => `i${f}`
const foldName = (f: number): string => `s${f}`
export const endName = (f: number): string => `e${f}`
export const copyName = (j: number): string => `c${j}`
export const namedIdName = (f: number): string => `m${f}`
export const namedValueName = (f: number): string => `w${f}`

type FamilySpec = FillSpec["families"][number]
type CopySpec = FillSpec["copies"][number]
type RelationSpec = FillSpec["relations"][number]

export const familyOf = (spec: SwarmSpec, f: number): FamilySpec =>
	defined(spec.fill.families[f], `family ${f}`)

const copyOf = (spec: FillSpec, j: number): CopySpec => defined(spec.copies[j], `copy ${j}`)

/** The relation a copy's field is on: the member's for the owner and predecessor axes, the owner's for the last. */
export const holderOf = (spec: FillSpec, copy: CopySpec): number => {
	const family = defined(spec.families[copy.family], `family ${copy.family}`)
	return copy.axis === "last" ? family.owner : family.member
}

/** Whether relation `r` holds the set `b`: it is the member of a family an or end folds. */
const holdsMask = (spec: SwarmSpec, r: number): boolean =>
	Arr.some(spec.ends, (e) => e.monoid === "or" && familyOf(spec, e.family).member === r)

/** The handles of the roster a member's set `b` is over: five, so its hex spelling pads a second digit. */
const maskHandles = ["h0", "h1", "h2", "h3", "h4"] as const

/** A row's set `b`, by its id: the handles of the bits of `11 · id mod 32`. */
const maskOf = (id: number): ReadonlySet<string> =>
	new Set(Arr.filter(maskHandles, (_, c) => (((id * 11) % 32) & (1 << c)) !== 0))

/** The or of the sets of rows `ids`. */
export const maskUnion = (ids: ReadonlyArray<number>): ReadonlySet<string> =>
	new Set(Arr.flatMap(ids, (id) => [...maskOf(id)]))

/** Max's identity over bigint, its end where a family has no member. */
export const maxIdentity: bigint = int8Min.value

/** Whether relation `r` is an ordered family's member, written nested under its owner alone. */
export const nestedOnly = (spec: FillSpec, r: number): boolean =>
	Arr.some(spec.families, (f) => f.kind === "ordered" && f.member === r)

/** Whether the ordered families of `families` nest `from` under itself through `to`: a path of ordered families. */
const orderedPath = (families: ReadonlyArray<FamilySpec>, from: number, to: number): boolean => {
	const seen = new Set<number>([from])
	const pending = [from]
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		if (at === to) {
			return true
		}
		for (const f of families) {
			if (f.kind === "ordered" && f.owner === at && !seen.has(f.member)) {
				seen.add(f.member)
				pending.push(f.member)
			}
		}
	}
	return false
}

/**
 * The copies family `f`'s sum fold may step: each a copy of its member's of a caller's `v` or a generated `g` along an
 * owner axis, its own family's, or, for a counted family, a sequence's whose member its member is too (fill.ts).
 */
const steppable = (spec: FillSpec, f: number): ReadonlyArray<number> => {
	const family = defined(spec.families[f], `family ${f}`)
	return Arr.flatMap(spec.copies, (c, j) => {
		const along = defined(spec.families[c.family], `family ${c.family}`)
		return c.axis === "owner" &&
			holderOf(spec, c) === family.member &&
			(c.source.kind === "caller" || c.source.kind === "generated") &&
			(c.family === f || (family.kind === "counted" && along.kind !== "counted"))
			? [j]
			: []
	})
}

/** How large a case may draw its schema: at scale, the downstream import's breadth. */
const space = (scale: boolean) => ({
	relations: scale ? 16 : 5,
	families: scale ? 14 : 4,
	copies: scale ? 10 : 3,
	plains: scale ? 8 : 3,
	laws: scale ? 10 : 3
})

/** Element `i` of a non-empty list drawn uniformly. */
const pick =
	<A>(xs: Arr.NonEmptyReadonlyArray<A>): Gen<A> =>
	(source) =>
		defined(xs[source.draw(int(0, xs.length - 1))], "a drawn element")

/**
 * The family core under a swarm: its relations, then its families, each kind the swarm's choice, its owner drawn among
 * the relations before its member unless the swarm keeps cycles of families, or among the owners already drawn where
 * it keeps several families per owner, or among the members already drawn where it keeps members owning a family; a
 * sequence's member is no other sequence's, and no ordered family closes a cycle of ordered families. Then its copies,
 * their sources among those fill.ts offers that leave the core admitted (fill.ts admittedSources), a copy of a copy
 * first where the swarm keeps it, and its steps: the reference admits every core by construction.
 */
const coreGen =
	(features: Swarm<SwarmFeature>, scale: boolean): Gen<FillSpec> =>
	(source) => {
		const kept = (feature: SwarmFeature): boolean => source.draw(keep(features, feature))
		const size = space(scale)
		const n = source.draw(int(2, size.relations))
		const relations = upTo(n, (): RelationSpec => ({
			generated: kept("generated"),
			mutable: kept("mutable")
		}))
		const families: Array<FamilySpec> = []
		const sequenced = new Set<number>()
		const nf = source.draw(int(1, size.families))
		for (let i = 0; i < nf; i += 1) {
			const kind: FamilyKind = source.draw(
				swarmChoice(features, ["ordered", "counted", "tree"] as const)
			)
			const fold = kept("fold") ? (source.draw(boolean) ? "sum" : "count") : "none"
			const owners = Arr.dedupe(Arr.map(families, (f) => f.owner))
			const members = Arr.dedupe(Arr.map(families, (f) => f.member))
			const cyclic = kept("cycle of families")
			const owner =
				Arr.isReadonlyArrayNonEmpty(owners) && kept("several families per owner")
					? source.draw(pick(owners))
					: Arr.isReadonlyArrayNonEmpty(members) && kept("member owning a family")
						? source.draw(pick(members))
						: source.draw(int(0, cyclic ? n - 1 : n - 2))
			if (kind === "tree") {
				if (!sequenced.has(owner)) {
					sequenced.add(owner)
					families.push({ kind, owner, member: owner, fold })
				}
				continue
			}
			const member = cyclic
				? source.draw(int(0, n - 1))
				: owner + 1 > n - 1
					? owner
					: source.draw(int(owner + 1, n - 1))
			if (member === owner) {
				continue
			}
			if (kind === "ordered") {
				if (!sequenced.has(member) && !orderedPath(families, member, owner)) {
					sequenced.add(member)
					families.push({ kind, owner, member, fold })
				}
				continue
			}
			families.push({ kind, owner, member, fold })
		}
		const copies: Array<CopySpec> = []
		const nc = Arr.isReadonlyArrayNonEmpty(families) ? source.draw(int(0, size.copies)) : 0
		for (let j = 0; j < nc; j += 1) {
			const f = source.draw(int(0, families.length - 1))
			const family = defined(families[f], "a drawn family")
			const axis: Axis =
				family.kind === "counted"
					? "owner"
					: axisOf[
							source.draw(
								swarmChoice(features, ["owner copy", "predecessor copy", "last copy"] as const)
							)
						]
			const draft: FillSpec = {
				relations: nonEmptyRelations(relations),
				families,
				copies: [...copies, { family: f, axis, source: { kind: "caller" } }],
				steps: []
			}
			const sources = admittedSources(
				{ ...draft, copies },
				f,
				axis,
				sourcesFor(draft, f, axis, copies.length)
			)
			const ofCopies = Arr.filter(sources, (s) => s.kind === "copy")
			const offered =
				Arr.isReadonlyArrayNonEmpty(ofCopies) && kept("copy of a copy") ? ofCopies : sources
			if (Arr.isReadonlyArrayNonEmpty(offered)) {
				copies.push({ family: f, axis, source: source.draw(pick(offered)) })
			}
		}
		const drafted: FillSpec = {
			relations: nonEmptyRelations(relations),
			families,
			copies,
			steps: []
		}
		const steps = Arr.flatMap(families, (family, f) => {
			const candidates = steppable(drafted, f)
			return family.fold === "sum" &&
				Arr.isReadonlyArrayNonEmpty(candidates) &&
				kept("fold over a copy")
				? [{ family: f, copy: source.draw(pick(candidates)) }]
				: []
		})
		return { ...drafted, steps }
	}

const axisOf = {
	"owner copy": "owner",
	"predecessor copy": "predecessor",
	"last copy": "last"
} as const satisfies Readonly<Record<string, Axis>>

export const nonEmptyRelations = (
	relations: ReadonlyArray<RelationSpec>
): Arr.NonEmptyReadonlyArray<RelationSpec> => {
	const [first, ...rest] = relations
	return [defined(first, "a schema has a relation"), ...rest]
}

/** The families a law over members may name: the ordered and counted ones. */
const memberFamilies = (core: FillSpec): ReadonlyArray<number> =>
	Arr.flatMap(core.families, (f, k) =>
		f.kind === "tree" || groupFieldsOf(core, k).length > 1 ? [] : [k]
	)

/**
 * The extra ends, plain relations and laws of a core under a swarm: an end of max or or over each family the swarm
 * reaches, a pure set or a referrer per plain relation, and laws each of a kind the swarm keeps, every referrer the
 * source of one law at most.
 */
const aroundGen =
	(features: Swarm<SwarmFeature>, scale: boolean, core: FillSpec): Gen<SwarmSpec> =>
	(source) => {
		const kept = (feature: SwarmFeature): boolean => source.draw(keep(features, feature))
		const size = space(scale)
		const ends = Arr.flatMap(core.families, (_, family): ReadonlyArray<EndSpec> => {
			const max = kept("max end")
			const or = kept("or end")
			return max && or
				? [{ family, monoid: source.draw(boolean) ? "max" : "or" }]
				: max
					? [{ family, monoid: "max" }]
					: or
						? [{ family, monoid: "or" }]
						: []
		})
		const m =
			source.draw(keep(features, "plain set")) || source.draw(keep(features, "plain referrer"))
				? source.draw(int(0, size.plains))
				: 0
		const plains = upTo(m, (): PlainSpec => ({
			kind:
				source.draw(swarmChoice(features, ["plain set", "plain referrer"] as const)) === "plain set"
					? "set"
					: "referrer",
			mutable: kept("mutable")
		}))
		const sets = Arr.flatMap(plains, (p, j) => (p.kind === "set" ? [j] : []))
		const referrers = Arr.flatMap(plains, (p, j) => (p.kind === "referrer" ? [j] : []))
		const membered = memberFamilies(core)
		const held = Arr.map(core.copies, (_, j) => j)
		const laws: Array<LawSpec> = []
		const sourced = new Set<number>()
		const nl = Arr.some(lawFeatures, (f) => weightOf(features, f) > 0)
			? source.draw(int(0, size.laws))
			: 0
		for (let i = 0; i < nl; i += 1) {
			const kind = source.draw(swarmChoice(features, lawFeatures))
			const free = Arr.filter(referrers, (j) => !sourced.has(j))
			switch (kind) {
				case "law into a set":
					if (Arr.isReadonlyArrayNonEmpty(sets)) {
						laws.push({
							kind: "into set",
							relation: source.draw(int(0, core.relations.length - 1)),
							plain: source.draw(pick(sets))
						})
					}
					break
				case "law into rows":
					if (Arr.isReadonlyArrayNonEmpty(free)) {
						const plain = source.draw(pick(free))
						sourced.add(plain)
						laws.push({
							kind: "into rows",
							plain,
							relation: source.draw(int(0, core.relations.length - 1))
						})
					}
					break
				case "law into members":
					if (Arr.isReadonlyArrayNonEmpty(free) && Arr.isReadonlyArrayNonEmpty(membered)) {
						const plain = source.draw(pick(free))
						sourced.add(plain)
						laws.push({ kind: "into members", plain, family: source.draw(pick(membered)) })
					}
					break
				case "owner into members":
					if (Arr.isReadonlyArrayNonEmpty(membered)) {
						laws.push({
							kind: "owner into members",
							family: source.draw(pick(membered)),
							selected: source.draw(boolean)
						})
					}
					break
				case "member key":
					if (Arr.isReadonlyArrayNonEmpty(membered)) {
						laws.push({ kind: "member key", family: source.draw(pick(membered)) })
					}
					break
				case "selection over a copy":
					if (Arr.isReadonlyArrayNonEmpty(held) && Arr.isReadonlyArrayNonEmpty(sets)) {
						laws.push({
							kind: "selected",
							copy: source.draw(pick(held)),
							plain: source.draw(pick(sets))
						})
					}
					break
				case "check": {
					const r = source.draw(int(0, core.relations.length - 1))
					if (Arr.some(laws, (l) => l.kind === "check" && l.relation === r)) {
						break
					}
					const owned = Arr.flatMap(core.families, (f, k) => (f.owner === r ? [k] : []))
					laws.push({
						kind: "check",
						relation: r,
						family:
							Arr.isReadonlyArrayNonEmpty(owned) && source.draw(boolean)
								? source.draw(pick(owned))
								: undefined
					})
					break
				}
				case "law into member rows": {
					const named = namedPairs({ fill: core, ends, plains, laws })
					if (Arr.isReadonlyArrayNonEmpty(named)) {
						laws.push({ kind: "into member rows", ...source.draw(pick(named)) })
					}
					break
				}
			}
		}
		const keyed = Arr.flatMap(laws, (l): ReadonlyArray<LawSpec> =>
			l.kind === "into members" || l.kind === "owner into members"
				? [{ kind: "member key", family: l.family }]
				: []
		)
		return { fill: core, ends, plains, laws: Arr.dedupeWith([...laws, ...keyed], sameLaw) }
	}

/**
 * The laws into member rows a spec may state: of each counted family whose member holds exactly `id`, `v` and its
 * group, a naming relation after the member that is no family's member, so the law's target is every field of its
 * member and no family statement ever writes the naming relation's rows.
 */
const namedPairs = (
	spec: SwarmSpec
): ReadonlyArray<{ readonly relation: number; readonly family: number }> =>
	Arr.flatMap(spec.fill.families, (f, family) => {
		const heading = fieldNames(spec, { kind: "core", r: f.member })
		const whole = ["id", "v", groupName(family)]
		return f.kind === "counted" &&
			heading.length === whole.length &&
			Arr.every(whole, (name) => heading.includes(name))
			? Arr.flatMap(spec.fill.relations, (_, relation) =>
					relation > f.member && Arr.every(spec.fill.families, (g) => g.member !== relation)
						? [{ relation, family }]
						: []
				)
			: []
	})

/** The features that draw laws, each its law's kind. */
const lawFeatures = [
	"law into a set",
	"law into rows",
	"law into members",
	"owner into members",
	"member key",
	"selection over a copy",
	"check",
	"law into member rows"
] as const

/** Whether two laws are one statement: a schema states each law once. */
const sameLaw = (a: LawSpec, b: LawSpec): boolean => {
	switch (a.kind) {
		case "into set":
			return b.kind === a.kind && b.relation === a.relation && b.plain === a.plain
		case "into rows":
			return b.kind === a.kind && b.plain === a.plain && b.relation === a.relation
		case "into members":
			return b.kind === a.kind && b.plain === a.plain && b.family === a.family
		case "owner into members":
			return b.kind === a.kind && b.family === a.family && b.selected === a.selected
		case "member key":
			return b.kind === a.kind && b.family === a.family
		case "selected":
			return b.kind === a.kind && b.copy === a.copy && b.plain === a.plain
		case "check":
			return b.kind === a.kind && b.relation === a.relation
		case "into member rows":
			return b.kind === a.kind && b.relation === a.relation && b.family === a.family
	}
}

/** A drawn schema under a swarm: its core (coreGen), then what surrounds it (aroundGen). */
export const swarmSpecGen =
	(features: Swarm<SwarmFeature>, scale: boolean): Gen<SwarmSpec> =>
	(source) =>
		source.draw(aroundGen(features, scale, source.draw(coreGen(features, scale))))

/** A case's swarm: drawn over every feature. */
export const featuresGen: Gen<Swarm<SwarmFeature>> = swarm(Arr.copy(swarmFeatures))

/** A relation built at run time, as a check over one types it. */
export type BuiltRelation = Relation<
	string,
	Record<string, FieldBase>,
	readonly [string, ...Array<string>]
>

/** The row a selection's or a check's predicate reads, as a check over a relation built at run time reads it. */
type Row = RowScalars<BuiltRelation>

const field = (row: Row, name: string) => defined(row[name], `the field ${name}`)

/** Whether a source's type is natural, else bigint: a count, an index, an interval and a count fold are natural. */
const naturalSource = (spec: FillSpec, source: CopySource, seen: ReadonlySet<number>): boolean => {
	switch (source.kind) {
		case "caller":
		case "generated":
			return false
		case "count":
		case "index":
		case "start":
		case "end":
			return true
		case "fold":
			return defined(spec.families[source.family], "a folded family").fold === "count"
		case "copy":
			return seen.has(source.copy)
				? false
				: naturalSource(spec, copyOf(spec, source.copy).source, new Set([...seen, source.copy]))
	}
}

/** The field a source names on its row (fill.ts). */
const sourceField = (source: CopySource): string => {
	switch (source.kind) {
		case "caller":
			return "v"
		case "generated":
			return "g"
		case "count":
			return countName(source.family)
		case "index":
			return indexName(source.family)
		case "start":
			return "start"
		case "end":
			return "end"
		case "fold":
			return foldName(source.family)
		case "copy":
			return copyName(source.copy)
	}
}

/** A tree root's text field, fill.ts's: at most 16 bytes. */
const rootText = str.bytes(16, str.regex("^.*$", "su"))

/** The roster a member's set `b` and an or end are over. */
const Mask = closed("Mask", maskHandles, [])

/** The fields of family relation `r`, fill.ts's in its order, then its set `b` and each extra end it owns. */
const fieldsOf = (spec: SwarmSpec, r: number): Record<string, FieldBase> => {
	const core = spec.fill
	const fields: Record<string, FieldBase> = { id: uuid, v: pg.bigint }
	for (const [f, family] of core.families.entries()) {
		if (family.owner === r) {
			fields[countName(f)] = drawn(natural)
			if (family.fold === "sum") {
				fields[foldName(f)] = accumulated(pg.bigint, 0n)
			}
			if (family.fold === "count") {
				fields[foldName(f)] = accumulated(natural, 0n)
			}
		}
		if (family.member === r) {
			if (family.kind === "tree") {
				for (const name of rootFieldsOf(f)) {
					fields[name] = rootText
				}
				fields[groupName(f)] = drawn(natural)
				fields["start"] = drawn(natural)
				fields["end"] = drawn(natural)
			} else {
				const group = groupFieldsOf(core, f)
				for (const [i, name] of group.entries()) {
					fields[name] = group.length === 1 ? uuid : i === group.length - 1 ? natural : rootText
				}
			}
			if (family.kind !== "counted") {
				fields[indexName(f)] = drawn(natural)
			}
		}
	}
	for (const [j, copy] of core.copies.entries()) {
		if (holderOf(core, copy) === r) {
			fields[copyName(j)] = naturalSource(core, copy.source, new Set([j]))
				? accumulated(natural, 0n)
				: accumulated(pg.bigint, 0n)
		}
	}
	if (holdsMask(spec, r)) {
		fields["b"] = bits(Mask)
	}
	for (const end of spec.ends) {
		if (familyOf(spec, end.family).owner === r) {
			fields[endName(end.family)] =
				end.monoid === "max"
					? accumulated(pg.bigint, maxIdentity)
					: accumulatedField(bits(Mask), bitsOf(Mask, [], []), [])
		}
	}
	return { ...fields, ...namedFields(spec, r) }
}

/** The families whose counted members' rows family relation `r` names whole, by its laws into member rows. */
const namedFamilies = (spec: SwarmSpec, r: number): ReadonlyArray<number> =>
	Arr.flatMap(spec.laws, (law) =>
		law.kind === "into member rows" && law.relation === r ? [law.family] : []
	)

/** The columns family relation `r` names a member's row by, for each family it names: its group, its id and its `v`. */
const namedFields = (spec: SwarmSpec, r: number): Readonly<Record<string, FieldBase>> =>
	Rec.fromEntries(
		Arr.flatMap(namedFamilies(spec, r), (f): ReadonlyArray<readonly [string, FieldBase]> => [
			[groupName(f), uuid],
			[namedIdName(f), uuid],
			[namedValueName(f), pg.bigint]
		])
	)

/**
 * The fields a caller states of family relation `r`'s row and only a put of it changes: its id and `v`, its set `b`,
 * and the columns it names a member's row by.
 */
export const callerFields = (spec: SwarmSpec, r: number): Readonly<Record<string, FieldBase>> => ({
	id: uuid,
	v: pg.bigint,
	...(holdsMask(spec, r) ? { b: bits(Mask) } : {}),
	...namedFields(spec, r)
})

/**
 * The row of family `f`'s member that the row `id` names among `rows`: of the member's rows with an id below it, in id
 * order, the one at the id modulo their count. The member comes before the naming relation and every row the swarm
 * stores of it names one (swarmInstanceGen), and every row written after takes a larger id, so a row names one row in
 * every state that holds it.
 */
const namedRow = (
	spec: SwarmSpec,
	f: number,
	rows: ReadonlyArray<InstanceRow>,
	id: number
): InstanceRow => {
	const member = familyOf(spec, f).member
	const below = Arr.sort(
		Arr.filter(rows, (x) => x.relation === member && x.id < id),
		Order.mapInput(Order.Number, (x: InstanceRow) => x.id)
	)
	return defined(below[id % below.length], `the row of ${relationName(member)} the row ${id} names`)
}

/**
 * The values the row `id` of family relation `relation` states at the columns it names a member's row by
 * (namedFields), among `rows`: the named row's group in the family, its id and its `v`, a uuid as its text.
 */
const namedFacts = (
	spec: SwarmSpec,
	rows: ReadonlyArray<InstanceRow>,
	relation: number,
	id: number
): Readonly<Record<string, string | bigint>> =>
	Rec.fromEntries(
		Arr.flatMap(
			namedFamilies(spec, relation),
			(f): ReadonlyArray<readonly [string, string | bigint]> => {
				const named = namedRow(spec, f, rows, id)
				const group = defined(
					Option.getOrUndefined(Arr.findFirst(named.memberOf, (m) => m.family === f)),
					`the group of the named row ${named.id}`
				)
				return [
					[groupName(f), uuidOfRow(group.owner)],
					[namedIdName(f), uuidOfRow(named.id)],
					[namedValueName(f), named.v]
				]
			}
		)
	)

/**
 * The values the row `id` of family relation `relation` states beyond the reference writer's caller fields (fill.ts),
 * among `rows`: its set `b`, and the columns it names a member's row by (namedFacts).
 */
export const swarmFacts = (
	spec: SwarmSpec,
	rows: ReadonlyArray<InstanceRow>,
	relation: number,
	id: number
): Readonly<Record<string, string | bigint | ReadonlySet<string>>> => ({
	...(holdsMask(spec, relation) ? { b: maskOf(id) } : {}),
	...namedFacts(spec, rows, relation, id)
})

/** The fields of plain relation `j`. */
const plainFields = (p: PlainSpec): Record<string, FieldBase> =>
	p.kind === "set" ? { x: pg.bigint } : { id: uuid, r: uuid, x: pg.bigint }

/** The field names of family relation `r` (its generated `g` among them) or of plain relation `j`, in heading order. */
export const fieldNames = (
	spec: SwarmSpec,
	relation:
		| { readonly kind: "core"; readonly r: number }
		| { readonly kind: "plain"; readonly j: number }
): ReadonlyArray<string> =>
	relation.kind === "core"
		? [
				...Rec.keys(fieldsOf(spec, relation.r)),
				...(defined(spec.fill.relations[relation.r], `relation ${relation.r}`).generated
					? ["g"]
					: [])
			]
		: Rec.keys(plainFields(defined(spec.plains[relation.j], `plain relation ${relation.j}`)))

/** The relation value of family relation `r`, its `g` generated from `v` where the core says so. */
const relationValue = (spec: SwarmSpec, r: number): BuiltRelation => {
	const name = relationName(r)
	const fields = fieldsOf(spec, r)
	return defined(spec.fill.relations[r], `relation ${r}`).generated
		? generatedRelation(
				name,
				fields,
				keyOfRelation(spec.fill, r),
				(row) => ({ g: generatedField(pg.bigint, row["v"], []) }),
				[]
			)
		: relation(name, fields, keyOfRelation(spec.fill, r), [])
}

/** A tree's member side reads every row but its root, the rows whose start is above zero. */
const treeMembers = (t: AnyRelation) =>
	selectBuilder(t, (row: Row) => row.gt(field(row, "start"), 0n))

/**
 * A built schema: its relation values by name, its statements, each family's, fold's, end's, copy's and law's
 * statement by index (the laws a refusal may name), and the schema under any declared name.
 */
export interface BuiltSwarm {
	readonly relations: Readonly<Record<string, BuiltRelation>>
	readonly families: ReadonlyArray<AnyFamily>
	readonly folds: ReadonlyMap<number, Statement>
	readonly ends: ReadonlyMap<number, Statement>
	readonly copies: ReadonlyArray<Statement>
	readonly laws: ReadonlyArray<Statement>
	readonly rename: (declared: string) => ReturnType<typeof schemaOf>
}

const schemaOf = (
	declared: string,
	relations: Readonly<Record<string, AnyRelation | AnyRoster>>,
	statements: ReadonlyArray<Statement>
) => schema(declared, relations, statements)

/** A family's statement of its kind over its member and its slots. */
const familyStatement = (
	core: FillSpec,
	f: number,
	member: AnyRelation,
	slots: unknown
): AnyFamily => {
	switch (defined(core.families[f], `family ${f}`).kind) {
		case "tree":
			return treeBuilder(onBuilder(member, [groupName(f), indexName(f)]), slots, {
				root: rootFieldsOf(f)
			})
		case "ordered":
			return orderedBuilder(onBuilder(member, [...groupFieldsOf(core, f), indexName(f)]), slots)
		case "counted":
			return countedBuilder(onBuilder(member, groupFieldsOf(core, f)), slots)
	}
}

/** The schema of a drawn spec, by the builders: fill.ts's statements, then the extra ends, the laws and `mutable`. */
export const buildSwarm = (spec: SwarmSpec): BuiltSwarm => {
	const core = spec.fill
	const values = Arr.map(core.relations, (_, r) => relationValue(spec, r))
	const plains = Arr.map(spec.plains, (p, j): BuiltRelation =>
		relation(plainName(j), plainFields(p), p.kind === "set" ? ["x"] : ["id"], [])
	)
	const valueAt = (r: number): AnyRelation => defined(values[r], `the relation value ${r}`)
	const plainAt = (j: number): AnyRelation => defined(plains[j], `the plain relation ${j}`)
	const families: Array<AnyFamily> = []
	const folds = new Map<number, Statement>()
	const ends = new Map<number, Statement>()
	const stepField = (f: number): string =>
		Option.match(
			Arr.findFirst(core.steps, (s) => s.family === f),
			{ onNone: () => "v", onSome: (s) => copyName(s.copy) }
		)
	for (const [f, family] of core.families.entries()) {
		const owner = valueAt(family.owner)
		const member = valueAt(family.member)
		const slots = finBuilder(owner, countName(f))
		const stated = familyStatement(core, f, member, slots)
		families.push(stated)
		if (family.fold !== "none") {
			folds.set(
				f,
				foldBuilder(
					stated,
					family.fold === "sum" ? monoids.sum : monoids.count,
					onBuilder(
						member,
						family.fold === "sum"
							? [...groupFieldsOf(core, f), stepField(f)]
							: groupFieldsOf(core, f)
					),
					onBuilder(owner, [...keyOfRelation(core, family.owner), foldName(f)])
				)
			)
		}
	}
	for (const end of spec.ends) {
		const family = familyOf(spec, end.family)
		ends.set(
			end.family,
			foldBuilder(
				defined(families[end.family], "an end's family"),
				end.monoid === "max" ? monoids.max : monoids.or,
				onBuilder(valueAt(family.member), [
					...groupFieldsOf(core, end.family),
					end.monoid === "max" ? "v" : "b"
				]),
				onBuilder(valueAt(family.owner), [
					...keyOfRelation(core, family.owner),
					endName(end.family)
				])
			)
		)
	}
	const copies = Arr.map(core.copies, (copy, j): Statement => {
		const family = defined(core.families[copy.family], "a copy's family")
		const owner = valueAt(family.owner)
		const member = valueAt(family.member)
		const side = family.kind === "tree" ? treeMembers(member) : member
		const read = sourceField(copy.source)
		const group = groupFieldsOf(core, copy.family)
		const key = keyOfRelation(core, family.owner)
		switch (copy.axis) {
			case "owner":
				return containedBuilder(
					onBuilder(side, [...group, copyName(j)]),
					onBuilder(owner, [...key, read])
				)
			case "predecessor":
				return containedBuilder(
					onBuilder(side, [...group, predBuilder(indexName(copy.family)), copyName(j)]),
					onBuilder(side, [...group, indexName(copy.family), read])
				)
			case "last":
				return containedBuilder(
					onBuilder(owner, [...key, predBuilder(countName(copy.family)), copyName(j)]),
					onBuilder(side, [...group, indexName(copy.family), read])
				)
		}
	})
	const laws = Arr.map(spec.laws, (law): Statement => {
		switch (law.kind) {
			case "into set":
				return containedBuilder(
					onBuilder(valueAt(law.relation), ["v"]),
					onBuilder(plainAt(law.plain), ["x"])
				)
			case "into rows":
				return containedBuilder(
					onBuilder(plainAt(law.plain), ["r"]),
					onBuilder(valueAt(law.relation), ["id"])
				)
			case "into members": {
				const family = familyOf(spec, law.family)
				return containedBuilder(
					onBuilder(plainAt(law.plain), ["r", "x"]),
					onBuilder(valueAt(family.member), [groupName(law.family), "v"])
				)
			}
			case "owner into members": {
				const family = familyOf(spec, law.family)
				const owner = valueAt(family.owner)
				const count = countName(law.family)
				return containedBuilder(
					onBuilder(
						law.selected ? selectBuilder(owner, (o: Row) => o.eq(field(o, count), 1n)) : owner,
						["id", "v"]
					),
					onBuilder(valueAt(family.member), [groupName(law.family), "v"])
				)
			}
			case "member key": {
				const family = familyOf(spec, law.family)
				return keyBuilder(onBuilder(valueAt(family.member), [groupName(law.family), "v"]))
			}
			case "selected": {
				const copy = copyOf(core, law.copy)
				const name = copyName(law.copy)
				return containedBuilder(
					onBuilder(
						selectBuilder(valueAt(holderOf(core, copy)), (row: Row) =>
							row.gt(field(row, name), 0n)
						),
						["v"]
					),
					onBuilder(plainAt(law.plain), ["x"])
				)
			}
			case "check": {
				const target = valueAt(law.relation)
				const family = law.family
				return family === undefined
					? checkBuilder(`C${law.relation}`, target, (row: Row) => row.gt(field(row, "v"), -3n))
					: checkBuilder(`C${law.relation}`, target, (row: Row) =>
							row.or(row.lt(field(row, countName(family)), 3n), row.ge(field(row, "v"), 0n))
						)
			}
			case "into member rows":
				return containedBuilder(
					onBuilder(valueAt(law.relation), [
						groupName(law.family),
						namedIdName(law.family),
						namedValueName(law.family)
					]),
					onBuilder(valueAt(familyOf(spec, law.family).member), [groupName(law.family), "id", "v"])
				)
		}
	})
	const mutables: ReadonlyArray<Statement> = [
		...Arr.flatMap(core.relations, (r, i) => (r.mutable ? [mutableBuilder(valueAt(i))] : [])),
		...Arr.flatMap(spec.plains, (p, j) => (p.mutable ? [mutableBuilder(plainAt(j))] : []))
	]
	const statements: ReadonlyArray<Statement> = [
		...Arr.flatMap(families, (stated, f) => [
			stated,
			...Option.toArray(Option.fromNullishOr(folds.get(f)))
		]),
		...ends.values(),
		...copies,
		...laws,
		...mutables
	]
	const relations: Readonly<Record<string, AnyRelation | AnyRoster>> = Rec.fromEntries([
		...Arr.map([...values, ...plains], (value) => [value.name, value] as const),
		...(Arr.some(spec.ends, (e) => e.monoid === "or") ? [["Mask", Mask] as const] : [])
	])
	const relationValues = Rec.fromEntries(
		Arr.map([...values, ...plains], (value) => [value.name, value] as const)
	)
	return {
		relations: relationValues,
		families,
		folds,
		ends,
		copies,
		laws,
		rename: (declared) => schemaOf(declared, relations, statements)
	}
}

/** One plain row: a pure set's `x`, or a referrer's `id`, `r` (a family row's id) and `x`. */
export type PlainRow =
	| { readonly kind: "set"; readonly plain: number; readonly x: bigint }
	| {
			readonly kind: "referrer"
			readonly plain: number
			readonly id: number
			readonly r: number
			readonly x: bigint
	  }

/** A plain row's fact as a ChangeSet states it. */
export const plainFact = (row: PlainRow): { readonly [field: string]: unknown } =>
	row.kind === "set" ? { x: row.x } : { id: uuidOfRow(row.id), r: uuidOfRow(row.r), x: row.x }

/** Whether two plain rows are one fact. */
export const samePlain = (a: PlainRow, b: PlainRow): boolean =>
	a.plain === b.plain &&
	a.x === b.x &&
	(a.kind === "set" || (b.kind === "referrer" && a.id === b.id && a.r === b.r))

/**
 * The relations a row of family relation `r` needs a row of: the owner of each counted family it is a member of, and
 * the member of each family whose rows it names (a law into member rows).
 */
const neededBy = (spec: SwarmSpec, r: number): ReadonlyArray<number> => [
	...Arr.flatMap(spec.fill.families, (f) =>
		f.kind === "counted" && f.member === r ? [f.owner] : []
	),
	...Arr.map(namedFamilies(spec, r), (f) => familyOf(spec, f).member)
]

/**
 * An instance of a spec's core: some rows of each relation a ChangeSet inserts itself, each sequence's members nested
 * under their owner's rows, a tree's nodes to a few levels; the rows of a relation that needs a row of another with no
 * row left (neededBy) are dropped, with every row nested under them, until none is; then every counted member names
 * an owner of each counted family it belongs to. Up to `bound` rows, ids from `first`, each `v` small around zero, and
 * at least `least` top rows of each relation a ChangeSet inserts itself, where the bound leaves room.
 */
export const swarmInstanceGen =
	(spec: SwarmSpec, bound: number, first: number, least: number): Gen<ReadonlyArray<InstanceRow>> =>
	(source) => {
		const core = spec.fill
		interface Draft {
			readonly relation: number
			readonly id: number
			readonly v: bigint
			readonly memberOf: Array<InstanceRow["memberOf"][number]>
		}
		const rows: Array<Draft> = []
		const make = (relation: number, memberOf: InstanceRow["memberOf"], depth: number): void => {
			if (rows.length >= bound) {
				return
			}
			const id = first + rows.length
			rows.push({ relation, id, v: BigInt(source.draw(int(-2, 3))), memberOf: [...memberOf] })
			for (const [f, family] of core.families.entries()) {
				if (
					family.owner !== relation ||
					family.kind === "counted" ||
					(family.kind === "tree" && depth >= 3)
				) {
					continue
				}
				const k = source.draw(int(0, 2))
				for (let slot = 0; slot < k; slot += 1) {
					make(family.member, [{ family: f, owner: id, slot }], depth + 1)
				}
			}
		}
		const countedOf = (r: number): ReadonlyArray<number> =>
			Arr.flatMap(core.families, (f, k) => (f.kind === "counted" && f.member === r ? [k] : []))
		const most = Math.max(2, Math.floor(bound / Math.max(1, core.relations.length)))
		for (const [r] of core.relations.entries()) {
			if (!nestedOnly(core, r)) {
				const k = source.draw(int(Math.min(least, most), most))
				for (let i = 0; i < k; i += 1) {
					make(r, [], 0)
				}
			}
		}
		const removed = new Set<number>()
		const left = (r: number): ReadonlyArray<Draft> =>
			Arr.filter(rows, (row) => row.relation === r && !removed.has(row.id))
		for (let changed = true; changed;) {
			changed = false
			for (const [r] of core.relations.entries()) {
				const orphaned = Arr.some(neededBy(spec, r), (needed) => left(needed).length === 0)
				if (orphaned && left(r).length > 0) {
					for (const row of left(r)) {
						removed.add(row.id)
					}
					changed = true
				}
			}
			for (const row of rows) {
				if (
					!removed.has(row.id) &&
					Arr.some(
						row.memberOf,
						(m) =>
							defined(core.families[m.family], "a family").kind !== "counted" &&
							removed.has(m.owner)
					)
				) {
					removed.add(row.id)
					changed = true
				}
			}
		}
		for (const row of rows) {
			if (removed.has(row.id)) {
				continue
			}
			for (const f of countedOf(row.relation)) {
				const choices = left(defined(core.families[f], "a family").owner)
				if (Arr.isReadonlyArrayNonEmpty(choices)) {
					row.memberOf.push({ family: f, owner: source.draw(pick(choices)).id, slot: 0 })
				}
			}
		}
		return Arr.flatMap(rows, (row) =>
			removed.has(row.id)
				? []
				: [{ relation: row.relation, id: row.id, v: row.v, memberOf: row.memberOf }]
		)
	}

/** A fact's id as the row it states: the inverse of fill.ts uuidOfRow. */
export const idOfUuid = (text: unknown): number =>
	typeof text === "string" ? Number.parseInt(Str.takeRight(text, 12), 16) : Number.NaN
