/**
 * Schemas of families and the copies that ride their axes, drawn for the fill order's suites
 * (test/unit/write/fill-order.test.ts and test/pg/write/fill-order/fill-order.test.ts): a schema's specification, the
 * verdict a reference model of the fill order gives it, the schema value the builders make of it, an instance of it,
 * and the rows a reference writer fills of that instance.
 *
 * A specification is relations R0 … Rn−1, each keyed by its uuid `id` and holding a bigint `v` its caller writes, with a
 * generated `g` = `v` where it says so; families between them, a tree on one relation, an ordered family or a counted
 * one of an owner and a member, each with a fold over it or none; copies, each an accumulated field `c<j>` riding one
 * axis of one family and reading one column of the axis's target row; keys over `g`; and mutable relations. Family `f`
 * names its count `n<f>`, its member's group field `o<f>` (a tree's parent), an ordered family's or a tree's index
 * `i<f>`, a tree's root field `d<f>` and a fold's end `s<f>`; a tree's interval is `start` and `end`.
 *
 * The reference verdict (`verdictOf`) is a model of the fill order written apart from the engine's analysis
 * (analysis/theory/fill.ts), over the specification's own names: the stage at which a write fills each column of a row
 * (entering it, leaving it after its sequences' members, or a counted family's own fill after the nested write), and
 * the rule each copy's axis sets on its source. The reference writer (`writtenRows`) computes every field of every row
 * of an instance directly, by recursion over the instance: a count is its members, an index its slot, an interval a
 * pre-order numbering, a fold its members' sum or count, and a copy its target row's value, the axis's start at its
 * base. It never consults the engine.
 */
import { boolean, type Gen, int } from "@grizzle/testing/gen"
import { keep, type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { Array as Arr, Option, Order, pipe, Record as Rec, String as Str } from "effect"
import { accumulated, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import { type AnyFamily, check, type Statement, schema } from "#compiler/public/schema.ts"
import { generatedField, generatedRelation, relation } from "#compiler/schema/relation.ts"
import {
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
import type { Predicate } from "#compiler/types/core/phantom.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyRelation, Relation } from "#compiler/types/schema/relation.ts"
import { defined } from "#test/support/assert.ts"

/** A family's kind: a tree on one relation, or an ordered or a counted family of an owner and a member. */
export type FamilyKind = "tree" | "ordered" | "counted"

/** A family's three axes, which a copy rides: owner (from its member), predecessor and last. */
export type Axis = "owner" | "predecessor" | "last"

/**
 * What a copy reads on its axis's target row: its caller's `v`, its generated `g`, the count of a family it owns, its
 * index in the sequence it is a member of, its tree's start or end, the end of a fold over a family it owns, or another
 * copy it holds.
 */
export type Source =
	| { readonly kind: "caller" }
	| { readonly kind: "generated" }
	| { readonly kind: "count"; readonly family: number }
	| { readonly kind: "index"; readonly family: number }
	| { readonly kind: "start" }
	| { readonly kind: "end" }
	| { readonly kind: "fold"; readonly family: number }
	| { readonly kind: "copy"; readonly copy: number }

interface FamilySpec {
	readonly kind: FamilyKind
	readonly owner: number
	readonly member: number
	readonly fold: "none" | "sum" | "count"
}

interface CopySpec {
	readonly family: number
	readonly axis: Axis
	readonly source: Source
}

interface RelationSpec {
	/** Whether it holds `g`, generated from `v`. */
	readonly generated: boolean
	readonly mutable: boolean
	/** Whether a key holds its `g`, which only a relation that holds one may. */
	readonly key: boolean
}

export interface FillSpec {
	readonly relations: Arr.NonEmptyReadonlyArray<RelationSpec>
	readonly families: ReadonlyArray<FamilySpec>
	readonly copies: ReadonlyArray<CopySpec>
}

/** The specification's names: relation `i`, family `f`'s fields, copy `j`'s field. */
export const relationName = (i: number): string => `R${i}`
const countName = (f: number): string => `n${f}`
const groupName = (f: number): string => `o${f}`
const indexName = (f: number): string => `i${f}`
const rootName = (f: number): string => `d${f}`
const foldName = (f: number): string => `s${f}`
const copyName = (j: number): string => `c${j}`

const familyAt = (spec: FillSpec, f: number): FamilySpec => defined(spec.families[f], `family ${f}`)
const copyAt = (spec: FillSpec, j: number): CopySpec => defined(spec.copies[j], `copy ${j}`)
const relationAt = (spec: FillSpec, r: number): RelationSpec =>
	defined(spec.relations[r], `relation ${r}`)

const isSequence = (family: FamilySpec): boolean => family.kind !== "counted"

/** The relation a copy's field is on: the member's for the owner and predecessor axes, the owner's for the last. */
const holderOf = (spec: FillSpec, copy: CopySpec): number => {
	const family = familyAt(spec, copy.family)
	return copy.axis === "last" ? family.owner : family.member
}

/** The relation a copy reads: its owner's on the owner axis, its member's on the predecessor and last axes. */
const sourceRelationOf = (spec: FillSpec, copy: CopySpec): number => {
	const family = familyAt(spec, copy.family)
	return copy.axis === "owner" ? family.owner : family.member
}

/** The tree on relation `r`, its family's index; none when `r` is no tree's relation. */
const treeOn = (spec: FillSpec, r: number): number | undefined =>
	Option.getOrUndefined(
		Arr.findFirstIndex(spec.families, (x) => x.kind === "tree" && x.owner === r)
	)

/** The field a source names on its row. */
const sourceField = (source: Source): string => {
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

/** Whether a source's type is natural, else bigint: a count, an index, an interval and a count fold are natural. */
const naturalSource = (spec: FillSpec, source: Source, seen: ReadonlySet<number>): boolean => {
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
			return familyAt(spec, source.family).fold === "count"
		case "copy":
			return seen.has(source.copy)
				? false
				: naturalSource(spec, copyAt(spec, source.copy).source, new Set([...seen, source.copy]))
	}
}

/**
 * The sources a copy along `axis` of family `f` may read on its target row, in a fixed order: every numeric column of
 * the row but those the axis itself carries (its key, a family's count on the owner axis, a tree's start and root on
 * its owner axis and its end on the others), so a copy adds a column its axis references once. A copy reads another
 * copy of the row by its number, and a copy along a tree's owner axis may read itself: each node then holds its
 * parent's value, which its root holds of itself alone.
 */
export const sourcesFor = (
	spec: FillSpec,
	f: number,
	axis: Axis,
	copy: number
): ReadonlyArray<Source> => {
	const family = familyAt(spec, f)
	const row = axis === "owner" ? family.owner : family.member
	const tree = treeOn(spec, row)
	const taken = Arr.flatMap(spec.copies, (c, j) =>
		j !== copy && c.family === f && c.axis === axis ? [sourceField(c.source)] : []
	)
	const all: ReadonlyArray<Source> = [
		{ kind: "caller" },
		...(relationAt(spec, row).generated ? [{ kind: "generated" } as const] : []),
		...Arr.flatMap(spec.families, (x, k): ReadonlyArray<Source> =>
			x.owner === row ? [{ kind: "count", family: k }] : []
		),
		...Arr.flatMap(spec.families, (x, k): ReadonlyArray<Source> =>
			x.member === row && x.kind !== "counted" ? [{ kind: "index", family: k }] : []
		),
		...(tree === undefined ? [] : [{ kind: "start" } as const, { kind: "end" } as const]),
		...Arr.flatMap(spec.families, (x, k): ReadonlyArray<Source> =>
			x.owner === row && x.fold !== "none" ? [{ kind: "fold", family: k }] : []
		),
		...Arr.flatMap(spec.copies, (c, j): ReadonlyArray<Source> =>
			j !== copy && holderOf(spec, c) === row ? [{ kind: "copy", copy: j }] : []
		),
		...(family.kind === "tree" && axis === "owner" ? [{ kind: "copy", copy } as const] : [])
	]
	const carried = (s: Source): boolean => {
		switch (axis) {
			case "owner":
				return (
					(s.kind === "count" && s.family === f) || (family.kind === "tree" && s.kind === "start")
				)
			case "predecessor":
			case "last":
				return (
					(s.kind === "index" && s.family === f) || (family.kind === "tree" && s.kind === "end")
				)
		}
	}
	return Arr.filter(all, (s) => !carried(s) && !taken.includes(sourceField(s)))
}

/** The features a drawn specification turns on, swarm by swarm. */
const fillFeatures = [
	"tree",
	"ordered",
	"counted",
	"fold",
	"owner copy",
	"predecessor copy",
	"last copy",
	"generated",
	"generated key",
	"mutable",
	"nesting cycle"
] as const

type FillFeature = (typeof fillFeatures)[number]

/** How large a drawn specification may be. */
interface FillSpace {
	readonly relations: number
	readonly families: number
	readonly copies: number
}

/**
 * A specification drawn under a swarm of `fillFeatures`: up to `space.relations` relations, families between them and
 * copies on their axes. A family is drawn only where the theory admits it (a relation is the member of at most one
 * sequence, a tree its own, and a counted family's owner comes before its member, so counted families never form a
 * cycle); every other shape, a counted member that is also a sequence's member or owner among them, is drawn, so the
 * suites meet the refusals too. An ordered family's owner comes before its member too, but where the swarm keeps
 * `nesting cycle`, which draws any owner and member, an ordered family of a relation over itself among them.
 */
export const fillSpecGen =
	(space: FillSpace): Gen<FillSpec> =>
	(source) => {
		const features: Swarm<FillFeature> = source.draw(swarm(Arr.copy(fillFeatures)))
		const kept = (feature: FillFeature): boolean => source.draw(keep(features, feature))
		const n = source.draw(int(1, space.relations))
		const relations = Arr.makeBy(n, () => {
			const generated = kept("generated")
			return { generated, mutable: kept("mutable"), key: generated && kept("generated key") }
		})
		const families: Array<FamilySpec> = []
		const sequenced = new Set<number>()
		const nf = source.draw(int(0, space.families))
		for (let i = 0; i < nf; i += 1) {
			const kind = source.draw(swarmChoice(features, ["ordered", "counted", "tree"] as const))
			const fold = kept("fold") ? (source.draw(boolean) ? "sum" : "count") : "none"
			if (kind === "tree") {
				const r = source.draw(int(0, n - 1))
				if (!sequenced.has(r)) {
					sequenced.add(r)
					families.push({ kind, owner: r, member: r, fold })
				}
				continue
			}
			if (kind === "ordered") {
				const cyclic = kept("nesting cycle")
				const owner = source.draw(int(0, cyclic ? n - 1 : n - 2))
				const member = cyclic ? source.draw(int(0, n - 1)) : source.draw(int(owner + 1, n - 1))
				if (!sequenced.has(member) && (cyclic || n > 1)) {
					sequenced.add(member)
					families.push({ kind, owner, member, fold })
				}
				continue
			}
			if (n > 1) {
				const owner = source.draw(int(0, n - 2))
				families.push({ kind, owner, member: source.draw(int(owner + 1, n - 1)), fold })
			}
		}
		const draft: { copies: Array<CopySpec> } = { copies: [] }
		const nc = Arr.isReadonlyArrayNonEmpty(families) ? source.draw(int(0, space.copies)) : 0
		for (let j = 0; j < nc; j += 1) {
			const f = source.draw(int(0, families.length - 1))
			const family = defined(families[f], "a drawn family")
			const axis: Axis = isSequence(family)
				? axisOf[
						source.draw(
							swarmChoice(features, ["owner copy", "predecessor copy", "last copy"] as const)
						)
					]
				: "owner"
			const spec: FillSpec = {
				relations: relationsNonEmpty(relations),
				families,
				copies: [...draft.copies, { family: f, axis, source: { kind: "caller" } }]
			}
			const sources = sourcesFor(spec, f, axis, draft.copies.length)
			if (Arr.isReadonlyArrayNonEmpty(sources)) {
				const chosen = defined(sources[source.draw(int(0, sources.length - 1))], "a source")
				draft.copies.push({ family: f, axis, source: chosen })
			}
		}
		return { relations: relationsNonEmpty(relations), families, copies: draft.copies }
	}

/** The axis a copy feature draws. */
const axisOf = {
	"owner copy": "owner",
	"predecessor copy": "predecessor",
	"last copy": "last"
} as const satisfies Readonly<Record<string, Axis>>

const relationsNonEmpty = (
	relations: ReadonlyArray<RelationSpec>
): Arr.NonEmptyReadonlyArray<RelationSpec> => {
	const [first, ...rest] = relations
	return [defined(first, "a specification has a relation"), ...rest]
}

/**
 * When a write fills a column of a row, by the reference model: entering the row, before its sequences' members;
 * leaving it, after them; or by counted family `family`'s own fill, after the nested write: its count, which it knows
 * before its members, or its end, after them.
 */
type Stage =
	| { readonly kind: "entering" }
	| { readonly kind: "leaving" }
	| { readonly kind: "counted"; readonly family: number; readonly part: "count" | "end" }

/** Why the reference refuses a copy: the UnfillableField causes it may report (core/causes.ts FilledLater). */
type LaterKind = "afterMembers" | "countedFill" | "cycle" | "unreached"

/**
 * The reference's verdict on a specification, in the order the compiler decides them: a relation no write fills (a
 * counted family's member that is a sequence's member or owner, or sequences that nest each other in a cycle); then
 * copies no write fills, each with the causes it may be reported by; then a relation with a key over its generated
 * `g`; else admitted. A copy of `g` along a predecessor or a last axis makes its target's superkey hold `g`, but the
 * family's own key holds every two of its rows apart first, so no addition meets that superkey.
 */
type Verdict =
	| {
			readonly kind: "unwritable"
			readonly causes: ReadonlyArray<"countedAndSequence" | "nestingCycle">
	  }
	| {
			readonly kind: "unfillable"
			readonly copies: ReadonlyArray<{
				readonly copy: number
				readonly later: ReadonlyArray<LaterKind>
			}>
	  }
	| { readonly kind: "generatedKey"; readonly relations: ReadonlyArray<number> }
	| { readonly kind: "admitted" }

/** The counted families of a specification, by index. */
const countedFamilies = (spec: FillSpec): ReadonlyArray<number> =>
	Arr.flatMap(spec.families, (f, k) => (f.kind === "counted" ? [k] : []))

/** The structural refusals the reference finds: see `Verdict`. */
const structural = (spec: FillSpec): ReadonlyArray<"countedAndSequence" | "nestingCycle"> => {
	const counted = Arr.some(countedFamilies(spec), (c) => {
		const m = familyAt(spec, c).member
		return Arr.some(spec.families, (s) => isSequence(s) && (s.member === m || s.owner === m))
	})
	const nests = Arr.filter(spec.families, (s) => s.kind === "ordered")
	const reaches = (from: number, to: number): boolean => {
		const seen = new Set<number>()
		const pending = [from]
		for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
			for (const s of nests) {
				if (s.owner === at) {
					if (s.member === to) {
						return true
					}
					if (!seen.has(s.member)) {
						seen.add(s.member)
						pending.push(s.member)
					}
				}
			}
		}
		return false
	}
	const cycle = Arr.some(nests, (s) => reaches(s.member, s.owner) || s.member === s.owner)
	return [
		...(counted ? ["countedAndSequence" as const] : []),
		...(cycle ? ["nestingCycle" as const] : [])
	]
}

/**
 * The stage of a source on a row of its relation, by the reference model; `root` for a tree's root, where a copy along
 * its own tree's owner axis reads its own row. A copy's own stage is its source's along the tree's owner axis at the
 * root, a counted family's fill for a copy of a counted family, the leaving stage for a last copy, and entering
 * otherwise. A cycle of copies at a root reads back to itself; `undefined` marks one.
 */
const stageOf = (
	spec: FillSpec,
	source: Source,
	root: boolean,
	seen: ReadonlySet<number>
): Stage | undefined => {
	switch (source.kind) {
		case "caller":
		case "generated":
		case "index":
		case "start":
		case "end":
			return { kind: "entering" }
		case "count": {
			const family = familyAt(spec, source.family)
			return isSequence(family)
				? { kind: "entering" }
				: { kind: "counted", family: source.family, part: "count" }
		}
		case "fold": {
			const family = familyAt(spec, source.family)
			return isSequence(family)
				? { kind: "leaving" }
				: { kind: "counted", family: source.family, part: "end" }
		}
		case "copy": {
			if (seen.has(source.copy)) {
				return undefined
			}
			const copy = copyAt(spec, source.copy)
			const family = familyAt(spec, copy.family)
			if (!isSequence(family)) {
				return { kind: "counted", family: copy.family, part: "count" }
			}
			if (copy.axis === "last") {
				return { kind: "leaving" }
			}
			return root && copy.axis === "owner" && family.kind === "tree"
				? stageOf(spec, copy.source, root, new Set([...seen, source.copy]))
				: { kind: "entering" }
		}
	}
}

/** The causes the reference refuses copy `j` by, none when a write fills it: see the module's header. */
const refusalsOf = (spec: FillSpec, j: number): ReadonlyArray<LaterKind> => {
	const copy = copyAt(spec, j)
	const family = familyAt(spec, copy.family)
	const row = sourceRelationOf(spec, copy)
	const rootOfTree = treeOn(spec, row)
	const positions =
		rootOfTree === undefined ? [false] : copy.axis === "owner" ? [false, true] : [false]
	const later = new Set<LaterKind>()
	for (const root of positions) {
		const stage = stageOf(spec, copy.source, root, new Set([j]))
		if (stage === undefined) {
			later.add("cycle")
			continue
		}
		if (stage.kind === "counted") {
			const own = stage.family === copy.family
			if (!isSequence(family) && copy.axis === "owner" && own) {
				if (stage.part === "end") {
					later.add("afterMembers")
				}
				continue
			}
			later.add("countedFill")
			if (copy.source.kind === "copy" && !own) {
				later.add("unreached")
			}
			continue
		}
		if (copy.axis === "owner" && isSequence(family) && stage.kind === "leaving") {
			later.add("afterMembers")
		}
	}
	const atRoot = family.kind === "tree" && copy.axis === "owner"
	if (atRoot) {
		const stage = stageOf(spec, copy.source, true, new Set([j]))
		if (stage === undefined) {
			later.add("cycle")
		} else if (stage.kind === "counted") {
			later.add("countedFill")
		}
	}
	return Arr.sort([...later], Order.String)
}

/** The reference's verdict on a specification: see `Verdict`. */
export const verdictOf = (spec: FillSpec): Verdict => {
	const causes = structural(spec)
	if (Arr.isReadonlyArrayNonEmpty(causes)) {
		return { kind: "unwritable", causes }
	}
	const copies = Arr.flatMap(spec.copies, (_, j) => {
		const later = refusalsOf(spec, j)
		return Arr.isReadonlyArrayNonEmpty(later) ? [{ copy: j, later }] : []
	})
	if (Arr.isReadonlyArrayNonEmpty(copies)) {
		return { kind: "unfillable", copies }
	}
	const keyed = Arr.flatMap(spec.relations, (r, i) => (r.key ? [i] : []))
	return Arr.isReadonlyArrayNonEmpty(keyed)
		? { kind: "generatedKey", relations: keyed }
		: { kind: "admitted" }
}

/** A copy's own class as the suites' situations name it: what its source is filled by, relative to its axis. */
export type SourceClass = "entering" | "leaving" | "counted count" | "counted end" | "cycle"

/** The class of a copy's source on a member row of its relation, the reference's stage spelled as a situation. */
export const sourceClassOf = (spec: FillSpec, j: number): SourceClass => {
	const copy = copyAt(spec, j)
	const stage = stageOf(spec, copy.source, false, new Set([j]))
	if (stage === undefined) {
		return "cycle"
	}
	switch (stage.kind) {
		case "entering":
		case "leaving":
			return stage.kind
		case "counted":
			return stage.part === "count" ? "counted count" : "counted end"
	}
}

/** A relation built at run time, as a check over one types it: its name, fields and key known only then. */
type BuiltRelation = Relation<
	string,
	Record<string, FieldBase>,
	readonly [string, ...Array<string>]
>

/** The row a selection's predicate reads, as a check over a relation built at run time reads it. */
type Row = Parameters<Parameters<typeof check<string, BuiltRelation, Predicate>>[2]>[0]

/** The fields of relation `r` of a specification, in declared order. */
const fieldsOf = (spec: FillSpec, r: number): Record<string, FieldBase> => {
	const fields: Record<string, FieldBase> = { id: uuid, v: pg.bigint }
	for (const [f, family] of spec.families.entries()) {
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
			fields[groupName(f)] = uuid
			if (family.kind !== "counted") {
				fields[indexName(f)] = drawn(natural)
			}
			if (family.kind === "tree") {
				fields[rootName(f)] = uuid
				fields["start"] = drawn(natural)
				fields["end"] = drawn(natural)
			}
		}
	}
	for (const [j, copy] of spec.copies.entries()) {
		if (holderOf(spec, copy) === r) {
			fields[copyName(j)] = naturalSource(spec, copy.source, new Set([j]))
				? accumulated(natural, 0n)
				: accumulated(pg.bigint, 0n)
		}
	}
	return fields
}

/** The relation value of relation `r`, its `g` generated from its row's `v` where the specification says so. */
const relationValue = (spec: FillSpec, r: number): AnyRelation => {
	const name = relationName(r)
	const fields = fieldsOf(spec, r)
	return relationAt(spec, r).generated
		? generatedRelation(
				name,
				fields,
				["id"],
				(row) => ({ g: generatedField(pg.bigint, row["v"], []) }),
				[]
			)
		: relation(name, fields, ["id"], [])
}

/** The schema of a specification under any declared name, with its relation values by name. */
interface BuiltFill {
	readonly relations: Readonly<Record<string, AnyRelation>>
	readonly statements: ReadonlyArray<Statement>
	readonly rename: (declared: string) => ReturnType<typeof schemaOf>
}

const schemaOf = (
	declared: string,
	relations: Readonly<Record<string, AnyRelation>>,
	statements: ReadonlyArray<Statement>
) => schema(declared, relations, statements)

/** A tree's member side reads every row but its root, the rows whose start is above zero. */
const treeMembers = (t: AnyRelation) =>
	selectBuilder(t, (row: Row) => row.gt(defined(row["start"], "a tree's start"), 0n))

/** Family `f`'s statement of its kind over its member and its slots. */
const familyStatement = (
	kind: FamilyKind,
	f: number,
	member: AnyRelation,
	slots: unknown
): AnyFamily => {
	switch (kind) {
		case "tree":
			return treeBuilder(onBuilder(member, [groupName(f), indexName(f)]), slots, {
				root: rootName(f)
			})
		case "ordered":
			return orderedBuilder(onBuilder(member, [groupName(f), indexName(f)]), slots)
		case "counted":
			return countedBuilder(onBuilder(member, [groupName(f)]), slots)
	}
}

/** The schema value of a specification, by the builders, each statement where the specification states it. */
export const buildFill = (spec: FillSpec): BuiltFill => {
	const values = Arr.map(spec.relations, (_, r) => relationValue(spec, r))
	const valueAt = (r: number): AnyRelation => defined(values[r], `the relation value ${r}`)
	const statements: Array<Statement> = []
	for (const [f, family] of spec.families.entries()) {
		const owner = valueAt(family.owner)
		const member = valueAt(family.member)
		const slots = finBuilder(owner, countName(f))
		const stated = familyStatement(family.kind, f, member, slots)
		statements.push(stated)
		if (family.fold !== "none") {
			statements.push(
				foldBuilder(
					stated,
					family.fold === "sum" ? monoids.sum : monoids.count,
					onBuilder(member, family.fold === "sum" ? [groupName(f), "v"] : [groupName(f)]),
					onBuilder(owner, ["id", foldName(f)])
				)
			)
		}
	}
	for (const [j, copy] of spec.copies.entries()) {
		const family = familyAt(spec, copy.family)
		const owner = valueAt(family.owner)
		const member = valueAt(family.member)
		const side = family.kind === "tree" ? treeMembers(member) : member
		const field = sourceField(copy.source)
		switch (copy.axis) {
			case "owner":
				statements.push(
					containedBuilder(
						onBuilder(side, [groupName(copy.family), copyName(j)]),
						onBuilder(owner, ["id", field])
					)
				)
				break
			case "predecessor":
				statements.push(
					containedBuilder(
						onBuilder(side, [
							groupName(copy.family),
							predBuilder(indexName(copy.family)),
							copyName(j)
						]),
						onBuilder(side, [groupName(copy.family), indexName(copy.family), field])
					)
				)
				break
			case "last":
				statements.push(
					containedBuilder(
						onBuilder(owner, ["id", predBuilder(countName(copy.family)), copyName(j)]),
						onBuilder(side, [groupName(copy.family), indexName(copy.family), field])
					)
				)
				break
		}
	}
	for (const [r, flags] of spec.relations.entries()) {
		if (flags.key) {
			statements.push(keyBuilder(onBuilder(valueAt(r), ["g"])))
		}
		if (flags.mutable) {
			statements.push(mutableBuilder(valueAt(r)))
		}
	}
	const relations = Rec.fromEntries(Arr.map(values, (v) => [v.name, v] as const))
	return {
		relations,
		statements,
		rename: (declared) => schemaOf(declared, relations, statements)
	}
}

/** One row of an instance: its relation, its id, its `v`, and each family it is a member of with its owner and slot. */
export interface InstanceRow {
	readonly relation: number
	readonly id: number
	readonly v: bigint
	readonly memberOf: ReadonlyArray<{
		readonly family: number
		readonly owner: number
		readonly slot: number
	}>
}

/** How an instance is written: which relations a ChangeSet inserts, and which it writes nested under their owners. */
const nestedOnly = (spec: FillSpec, r: number): boolean =>
	Arr.some(spec.families, (f) => f.kind === "ordered" && f.member === r)

/** How many rows an instance holds at most: a bound on its size, which keeps a case small. */
const instanceBound = 24

/**
 * An instance of an admitted specification: some rows of each relation a ChangeSet inserts itself (no ordered family's
 * member and no counted one's), each sequence's members nested under their owner's rows, a tree's nodes to a few
 * levels; then each counted family's members, naming an owner of every counted family they belong to. Counted members
 * come in their relations' order, after every other row, and a counted family's owner's relation comes before its
 * member's, so every owner is written first. `count` says how many rows of a kind, between its bounds, and `value` each
 * row's `v`.
 */
const instanceOf = (
	spec: FillSpec,
	count: (lo: number, hi: number) => number,
	value: (id: number) => bigint
): ReadonlyArray<InstanceRow> => {
	const rows: Array<InstanceRow> = []
	const make = (relation: number, memberOf: InstanceRow["memberOf"], depth: number): void => {
		if (rows.length >= instanceBound) {
			return
		}
		const id = rows.length + 1
		rows.push({ relation, id, v: value(id), memberOf })
		for (const [f, family] of spec.families.entries()) {
			if (family.owner !== relation || family.kind === "counted") {
				continue
			}
			if (family.kind === "tree" && depth >= 3) {
				continue
			}
			const k = count(0, 2)
			for (let slot = 0; slot < k; slot += 1) {
				make(family.member, [{ family: f, owner: id, slot }], depth + 1)
			}
		}
	}
	const countedMember = (r: number): boolean =>
		Arr.some(spec.families, (f) => f.kind === "counted" && f.member === r)
	for (const [r] of spec.relations.entries()) {
		if (!nestedOnly(spec, r) && !countedMember(r)) {
			const k = count(0, 2)
			for (let i = 0; i < k; i += 1) {
				make(r, [], 0)
			}
		}
	}
	for (const [r] of spec.relations.entries()) {
		if (!countedMember(r)) {
			continue
		}
		const memberships = Arr.flatMap(spec.families, (f, k) =>
			f.kind === "counted" && f.member === r ? [k] : []
		)
		const k = count(0, 3)
		for (let i = 0; i < k; i += 1) {
			const owners = Arr.map(memberships, (f) => {
				const candidates = Arr.filter(rows, (row) => row.relation === familyAt(spec, f).owner)
				return Arr.isReadonlyArrayNonEmpty(candidates)
					? Option.some({
							family: f,
							owner: defined(candidates[count(0, candidates.length - 1)], "an owner").id,
							slot: 0
						})
					: Option.none()
			})
			const named = Arr.getSomes(owners)
			if (named.length === memberships.length) {
				make(r, named, 0)
			}
		}
	}
	return rows
}

/** An instance drawn: its counts and its values each a decision, values small around zero. */
export const instanceGen =
	(spec: FillSpec): Gen<ReadonlyArray<InstanceRow>> =>
	(source) =>
		instanceOf(
			spec,
			(lo, hi) => source.draw(int(lo, hi)),
			() => BigInt(source.draw(int(-2, 3)))
		)

/** The instance an exhaustion writes of a specification, drawing nothing: every count its most, every `v` its id's
 * place among six values around zero, so sums and copies differ from row to row. */
export const fullInstance = (spec: FillSpec): ReadonlyArray<InstanceRow> =>
	instanceOf(
		spec,
		(_lo, hi) => hi,
		(id) => BigInt((id % 6) - 2)
	)

/** A row's membership of family `f`: its owner and its slot; none when it is no member of `f`. */
const membershipIn = (row: InstanceRow, f: number): InstanceRow["memberOf"][number] | undefined =>
	Option.getOrUndefined(Arr.findFirst(row.memberOf, (m) => m.family === f))

/** The uuid an instance's row `id` is written as. */
export const uuidOfRow = (id: number): string =>
	`00000000-0000-4000-8000-${pipe(id.toString(16), Str.padStart(12, "0"))}`

/** A row's fields as the reference writer fills them, by name: a uuid's text, every number a bigint. */
type WrittenRow = Readonly<Record<string, string | bigint>>

/**
 * Every field of every row of an instance, as the reference writer fills it: see the module's header. A tree's root
 * is its own parent and holds its own id as its root field; its interval starts at 0.
 */
export const writtenRows = (
	spec: FillSpec,
	rows: ReadonlyArray<InstanceRow>
): ReadonlyMap<number, WrittenRow> => {
	const byId = new Map(Arr.map(rows, (row) => [row.id, row] as const))
	const rowOf = (id: number): InstanceRow => defined(byId.get(id), `the row ${id}`)
	const membership = (row: InstanceRow, f: number) => membershipIn(row, f)
	const membersOf = (owner: number, f: number): ReadonlyArray<InstanceRow> =>
		Arr.sort(
			Arr.filter(rows, (row) => membership(row, f)?.owner === owner),
			Order.mapInput(Order.Number, (row: InstanceRow) => membership(row, f)?.slot ?? 0)
		)
	const rootOf = (row: InstanceRow, tree: number): InstanceRow => {
		let at = row
		for (let up = membership(at, tree); up !== undefined; up = membership(at, tree)) {
			at = rowOf(up.owner)
		}
		return at
	}
	const sizeOf = (row: InstanceRow, tree: number): number =>
		Arr.reduce(membersOf(row.id, tree), 1, (n, child) => n + sizeOf(child, tree))
	const startOf = (row: InstanceRow, tree: number): number => {
		const up = membership(row, tree)
		if (up === undefined) {
			return 0
		}
		const siblings = membersOf(up.owner, tree)
		const before = Arr.filter(siblings, (s) => (membership(s, tree)?.slot ?? 0) < up.slot)
		return Arr.reduce(before, startOf(rowOf(up.owner), tree) + 1, (n, s) => n + sizeOf(s, tree))
	}
	const sourceValue = (row: InstanceRow, source: Source): bigint => {
		switch (source.kind) {
			case "caller":
			case "generated":
				return row.v
			case "count":
				return BigInt(membersOf(row.id, source.family).length)
			case "index":
				return BigInt(membership(row, source.family)?.slot ?? 0)
			case "start":
			case "end": {
				const tree = defined(treeOn(spec, row.relation), "a tree's row")
				const start = startOf(row, tree)
				return BigInt(source.kind === "start" ? start : start + sizeOf(row, tree))
			}
			case "fold": {
				const family = familyAt(spec, source.family)
				const members = membersOf(row.id, source.family)
				return family.fold === "sum"
					? Arr.reduce(members, 0n, (sum, m) => sum + m.v)
					: BigInt(members.length)
			}
			case "copy":
				return copyValue(row, source.copy)
		}
	}
	const copyValue = (row: InstanceRow, j: number): bigint => {
		const copy = copyAt(spec, j)
		const family = familyAt(spec, copy.family)
		switch (copy.axis) {
			case "owner": {
				const up = membership(row, copy.family)
				return sourceValue(up === undefined ? row : rowOf(up.owner), copy.source)
			}
			case "predecessor": {
				const up = membership(row, copy.family)
				if (up === undefined || up.slot === 0) {
					return 0n
				}
				const before = Arr.findFirst(
					membersOf(up.owner, copy.family),
					(s) => membership(s, copy.family)?.slot === up.slot - 1
				)
				return Option.isSome(before) ? sourceValue(before.value, copy.source) : 0n
			}
			case "last": {
				const members = membersOf(row.id, copy.family)
				const last = members.at(-1)
				return last === undefined || family.kind === "counted" ? 0n : sourceValue(last, copy.source)
			}
		}
	}
	return new Map(
		Arr.map(rows, (row) => {
			const fields: Record<string, string | bigint> = { id: uuidOfRow(row.id), v: row.v }
			if (relationAt(spec, row.relation).generated) {
				fields["g"] = row.v
			}
			for (const [f, family] of spec.families.entries()) {
				if (family.owner === row.relation) {
					fields[countName(f)] = BigInt(membersOf(row.id, f).length)
					if (family.fold !== "none") {
						fields[foldName(f)] = sourceValue(row, { kind: "fold", family: f })
					}
				}
				if (family.member !== row.relation) {
					continue
				}
				const up = membership(row, f)
				fields[groupName(f)] = uuidOfRow(up === undefined ? row.id : up.owner)
				if (family.kind !== "counted") {
					fields[indexName(f)] = BigInt(up?.slot ?? 0)
				}
				if (family.kind === "tree") {
					fields[rootName(f)] = uuidOfRow(rootOf(row, f).id)
					fields["start"] = sourceValue(row, { kind: "start" })
					fields["end"] = sourceValue(row, { kind: "end" })
				}
			}
			for (const [j, copy] of spec.copies.entries()) {
				if (holderOf(spec, copy) === row.relation) {
					fields[copyName(j)] = copyValue(row, j)
				}
			}
			return [row.id, fields] as const
		})
	)
}

/** A fact as a ChangeSet states it: its caller's fields, and each sequence's members nested at its count field. */
type Fact = { readonly [field: string]: unknown }

/**
 * The facts a ChangeSet inserts of an instance, by relation: each row no ordered family nests and no tree holds as a
 * member, with its caller's fields, its counted families' group fields, a tree root's own id as its root field, and
 * every sequence's members nested at its count field in slot order, a tree's children among them; a nested member
 * states its caller's fields alone.
 */
export const instanceFacts = (
	spec: FillSpec,
	rows: ReadonlyArray<InstanceRow>
): ReadonlyMap<number, ReadonlyArray<Fact>> => {
	const factOf = (row: InstanceRow, nested: boolean): Fact => {
		const fact: Record<string, unknown> = { id: uuidOfRow(row.id), v: row.v }
		for (const m of row.memberOf) {
			if (familyAt(spec, m.family).kind === "counted") {
				fact[groupName(m.family)] = uuidOfRow(m.owner)
			}
		}
		for (const [f, family] of spec.families.entries()) {
			if (family.kind === "tree" && family.member === row.relation && !nested) {
				fact[rootName(f)] = uuidOfRow(row.id)
			}
			if (family.owner !== row.relation || family.kind === "counted") {
				continue
			}
			fact[countName(f)] = Arr.map(
				Arr.sort(
					Arr.filter(rows, (r) => membershipIn(r, f)?.owner === row.id),
					Order.mapInput(Order.Number, (r: InstanceRow) => membershipIn(r, f)?.slot ?? 0)
				),
				(member) => factOf(member, true)
			)
		}
		return fact
	}
	const out = new Map<number, Array<Fact>>()
	for (const row of rows) {
		const nested = Arr.some(row.memberOf, (m) => familyAt(spec, m.family).kind !== "counted")
		if (nested) {
			continue
		}
		const list = out.get(row.relation) ?? []
		list.push(factOf(row, false))
		out.set(row.relation, list)
	}
	return out
}

/** The relations a ChangeSet inserting an instance writes itself: every one no ordered family nests. */
export const insertedRelations = (spec: FillSpec): ReadonlyArray<number> =>
	Arr.filter(
		Arr.map(spec.relations, (_, r) => r),
		(r) => !nestedOnly(spec, r)
	)

/**
 * What a refusal of copy `j` names, by the specification: the relation its field is on, its field, its family, the
 * column it reads and the relation it reads it on, and its axis.
 */
export const copyNamed = (
	spec: FillSpec,
	j: number
): {
	readonly relation: string
	readonly field: string
	readonly family: { readonly owner: string; readonly count: string }
	readonly source: { readonly relation: string; readonly column: string }
	readonly axis: Axis
} => {
	const copy = copyAt(spec, j)
	const family = familyAt(spec, copy.family)
	return {
		relation: relationName(holderOf(spec, copy)),
		field: copyName(j),
		family: { owner: relationName(family.owner), count: countName(copy.family) },
		source: {
			relation: relationName(sourceRelationOf(spec, copy)),
			column: sourceField(copy.source)
		},
		axis: copy.axis
	}
}

/** Whether a field of a relation is filled by a counted family's own fill, after the nested write: a counted family's
 * count or the end of a fold over one on its owner, and a copy along a counted family's owner axis on its member. */
export const countedFilled = (spec: FillSpec, relation: number, field: string): boolean =>
	Arr.some(
		spec.families,
		(f, k) =>
			f.kind === "counted" &&
			f.owner === relation &&
			(field === countName(k) || field === foldName(k))
	) ||
	Arr.some(
		spec.copies,
		(c, j) =>
			field === copyName(j) &&
			holderOf(spec, c) === relation &&
			familyAt(spec, c.family).kind === "counted"
	)
