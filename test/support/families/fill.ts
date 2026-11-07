/**
 * Schemas of families and the copies that ride their axes, drawn for the fill order's suites
 * (test/unit/write/fill-order.test.ts and test/pg/write/fill-order/fill-order.test.ts): a schema's specification, the
 * verdict a reference model of the fill order gives it, the schema value the builders make of it, an instance of it,
 * and the rows a reference writer fills of that instance.
 *
 * A specification is relations R0 … Rn−1, each keyed by its uuid `id` and holding a bigint `v` its caller writes, with a
 * generated `g` = `v` where it says so; families between them, a tree on one relation, an ordered family or a counted
 * one of an owner and a member, each with a fold over it or none, a sum stepping its member's `v` or a copy of it;
 * copies, each an accumulated field `c<j>` riding one axis of one family and reading one column of the axis's target
 * row; keys over `g`; and mutable relations. Family `f`
 * names its count `n<f>`, its member's group field `o<f>` (a tree's parent), an ordered family's or a tree's index
 * `i<f>`, a tree's root field `d<f>` and a fold's end `s<f>`; a tree's interval is `start` and `end`.
 *
 * The reference verdict (`verdictOf`) is a model of the fill order written apart from the engine's analysis
 * (analysis/theory/fill.ts), over the specification's own names: the stage at which a write fills each column of a row
 * (entering it, after the members of each sequence it owns that it waits on, or a counted family's own fill after the
 * nested write), the order the walk fills a row's sequences in, every one after each sequence a copy its members take
 * waits on, and
 * the rule each copy's axis sets on its source. The reference writer (`writtenRows`) computes every field of every row
 * of an instance directly, by recursion over the instance: a count is its members, an index its slot, an interval a
 * pre-order numbering, a fold its members' sum or count, and a copy its target row's value, the axis's start at its
 * base. It never consults the engine.
 *
 * A follow-up (`followUpGen`) is a second ChangeSet over a stored instance: an owner's put, counted members inserted
 * under it, a member deleted from one of its ordered families, and a member appended to one, new or moved there from
 * another owner's. The reference's verdict on a ChangeSet
 * (`writesVerdict`) finds every value its writes leave stale and every value the refills that draw them again leave
 * stale in turn (`refillsOf`, a second implementation of analysis/theory/refill.ts over the specification's names), and
 * refuses only a refill of an immutable relation's rows; the instance a follow-up leaves (`followUpRows`) is the
 * reference writer's to fill, every refilled value among it.
 */
import { boolean, type Gen, int } from "@grizzle/testing/gen"
import { keep, type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { Array as Arr, Option, Order, pipe, Record as Rec, String as Str } from "effect"
import type { ChangedColumn, DerivedReader, FamilyName } from "#compiler/core/causes.ts"
import { accumulated, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import { type AnyFamily, type RowScalars, schema, type Statement } from "#compiler/public/schema.ts"
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
export type CopySource =
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
	readonly source: CopySource
}

interface RelationSpec {
	/** Whether it holds `g`, generated from `v`. */
	readonly generated: boolean
	readonly mutable: boolean
	/** Whether a key holds its `g`, which only a relation that holds one may. */
	readonly key: boolean
}

/**
 * A sum fold that steps a copy of its member's instead of its `v`: family `family`'s fold, stepping copy `copy`, a copy
 * of a caller's `v` or a generated `g` along an owner axis onto the family's member, its own family's or, for a counted
 * family, a sequence's.
 */
interface StepSpec {
	readonly family: number
	readonly copy: number
}

export interface FillSpec {
	readonly relations: Arr.NonEmptyReadonlyArray<RelationSpec>
	readonly families: ReadonlyArray<FamilySpec>
	readonly copies: ReadonlyArray<CopySpec>
	readonly steps: ReadonlyArray<StepSpec>
}

/** The specification's names: relation `i`, family `f`'s fields, copy `j`'s field. */
export const relationName = (i: number): string => `R${i}`
const countName = (f: number): string => `n${f}`
const groupName = (f: number): string => `o${f}`
const indexName = (f: number): string => `i${f}`
const rootName = (f: number): string => `d${f}`
const foldName = (f: number): string => `s${f}`
const copyName = (j: number): string => `c${j}`

/** The copy family `f`'s sum fold steps, none where it steps its member's `v`. */
const stepCopyOf = (spec: FillSpec, f: number): number | undefined =>
	Option.getOrUndefined(Arr.findFirst(spec.steps, (step) => step.family === f))?.copy

/** The field family `f`'s sum fold steps on its member: a copy a step names, else `v`. */
const stepField = (spec: FillSpec, f: number): string => {
	const copy = stepCopyOf(spec, f)
	return copy === undefined ? "v" : copyName(copy)
}

const familyAt = (spec: FillSpec, f: number): FamilySpec => defined(spec.families[f], `family ${f}`)
const copyAt = (spec: FillSpec, j: number): CopySpec => defined(spec.copies[j], `copy ${j}`)
export const relationAt = (spec: FillSpec, r: number): RelationSpec =>
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
): ReadonlyArray<CopySource> => {
	const family = familyAt(spec, f)
	const row = axis === "owner" ? family.owner : family.member
	const tree = treeOn(spec, row)
	const taken = Arr.flatMap(spec.copies, (c, j) =>
		j !== copy && c.family === f && c.axis === axis ? [sourceField(c.source)] : []
	)
	const all: ReadonlyArray<CopySource> = [
		{ kind: "caller" },
		...(relationAt(spec, row).generated ? [{ kind: "generated" } as const] : []),
		...Arr.flatMap(spec.families, (x, k): ReadonlyArray<CopySource> =>
			x.owner === row ? [{ kind: "count", family: k }] : []
		),
		...Arr.flatMap(spec.families, (x, k): ReadonlyArray<CopySource> =>
			x.member === row && x.kind !== "counted" ? [{ kind: "index", family: k }] : []
		),
		...(tree === undefined ? [] : [{ kind: "start" } as const, { kind: "end" } as const]),
		...Arr.flatMap(spec.families, (x, k): ReadonlyArray<CopySource> =>
			x.owner === row && x.fold !== "none" ? [{ kind: "fold", family: k }] : []
		),
		...Arr.flatMap(spec.copies, (c, j): ReadonlyArray<CopySource> =>
			j !== copy && holderOf(spec, c) === row ? [{ kind: "copy", copy: j }] : []
		),
		...(family.kind === "tree" && axis === "owner" ? [{ kind: "copy", copy } as const] : [])
	]
	const carried = (s: CopySource): boolean => {
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
	"nesting cycle",
	"fold over a copy"
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
 * cycle); every other shape is drawn, a counted member that is also a sequence's member, a tree's node or a sequence's
 * owner among them, so the suites meet the refusals too. An ordered family's owner comes before its member too, but
 * where the swarm keeps `nesting cycle`, which draws any owner and member, an ordered family of a relation over itself
 * among them.
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
				copies: [...draft.copies, { family: f, axis, source: { kind: "caller" } }],
				steps: []
			}
			const sources = sourcesFor(spec, f, axis, draft.copies.length)
			if (Arr.isReadonlyArrayNonEmpty(sources)) {
				const chosen = defined(sources[source.draw(int(0, sources.length - 1))], "a source")
				draft.copies.push({ family: f, axis, source: chosen })
			}
		}
		const drafted: FillSpec = {
			relations: relationsNonEmpty(relations),
			families,
			copies: draft.copies,
			steps: []
		}
		const steps = Arr.flatMap(families, (family, f): ReadonlyArray<StepSpec> => {
			const candidates = steppable(drafted, f)
			return family.fold === "sum" &&
				Arr.isReadonlyArrayNonEmpty(candidates) &&
				kept("fold over a copy")
				? [{ family: f, copy: defined(candidates[source.draw(int(0, candidates.length - 1))]) }]
				: []
		})
		return { ...drafted, steps }
	}

/**
 * The copies family `f`'s sum fold may step: each a copy of its member's of a caller's `v` or a generated `g` along an
 * owner axis, its own family's, or, for a counted family, a sequence's whose member its member is too.
 */
const steppable = (spec: FillSpec, f: number): ReadonlyArray<number> => {
	const family = familyAt(spec, f)
	return Arr.flatMap(spec.copies, (c, j) => {
		const along = familyAt(spec, c.family)
		return c.axis === "owner" &&
			holderOf(spec, c) === family.member &&
			(c.source.kind === "caller" || c.source.kind === "generated") &&
			(c.family === f || (family.kind === "counted" && along.kind !== "counted"))
			? [j]
			: []
	})
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
 * When a write fills a column of a row, by the reference model: entering the row, before its sequences' members; after
 * the members of each of the sequences `families` the row owns, by index; or by counted family `family`'s own fill,
 * after the nested write: its count, which it knows before its members, or its end, after them.
 */
type Stage =
	| { readonly kind: "entering" }
	| { readonly kind: "after"; readonly families: ReadonlySet<number> }
	| { readonly kind: "counted"; readonly family: number; readonly part: "count" | "end" }

/** Why the reference refuses a copy: the UnfillableField causes it may report (core/causes.ts FilledLater). */
type LaterKind = "afterMembers" | "countedFill" | "cycle" | "unreached"

/**
 * The reference's verdict on a specification, in the order the compiler decides them: a relation no write fills,
 * sequences that nest each other in a cycle; then copies no write fills, each with the causes it may be reported by;
 * then a relation with a key over its generated `g`; else admitted. A copy of `g` along a predecessor or a last axis
 * makes its target's superkey hold `g`, but the family's own key holds every two of its rows apart first, so no
 * addition meets that superkey. A counted family's member may also be a sequence's member, a tree's node or a
 * sequence's owner: the walk fills its row and the counted family's fill completes it.
 */
type Verdict =
	| { readonly kind: "unwritable" }
	| {
			readonly kind: "unfillable"
			readonly copies: ReadonlyArray<{
				readonly copy: number
				readonly later: ReadonlyArray<LaterKind>
			}>
	  }
	| { readonly kind: "generatedKey"; readonly relations: ReadonlyArray<number> }
	| { readonly kind: "admitted" }

/** Whether the reference finds sequences that nest each other in a cycle, which no write fills: see `Verdict`. */
const nestingCycle = (spec: FillSpec): boolean => {
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
	return Arr.some(nests, (s) => reaches(s.member, s.owner) || s.member === s.owner)
}

/**
 * The stage of a source on a row of its relation, by the reference model; `root` for a tree's root, where a copy along
 * its own tree's owner axis reads its own row. A sequence's fold end waits on that sequence's members, and so does a
 * copy along its last axis. A copy's own stage is its source's along the tree's owner axis at the root, a counted
 * family's fill for a copy of a counted family, and entering otherwise. A cycle of copies at a root reads back to
 * itself; `undefined` marks one.
 */
const stageOf = (
	spec: FillSpec,
	source: CopySource,
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
				? { kind: "after", families: new Set([source.family]) }
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
				return { kind: "after", families: new Set([copy.family]) }
			}
			return root && copy.axis === "owner" && family.kind === "tree"
				? stageOf(spec, copy.source, root, new Set([...seen, source.copy]))
				: { kind: "entering" }
		}
	}
}

/** The positions a copy's source row stands at that the reference tells apart: a tree's root, where its own copies
 * read its own row, and every other. */
const positionsOf = (spec: FillSpec, j: number): ReadonlyArray<boolean> => {
	const copy = copyAt(spec, j)
	return treeOn(spec, sourceRelationOf(spec, copy)) === undefined || copy.axis !== "owner"
		? [false]
		: [false, true]
}

/**
 * The walk's order a copy along a sequence's owner axis asks of its owner, at each position: every other sequence its
 * source waits on is walked before the copy's own family. A copy its own source refuses asks nothing.
 */
const orderingOf = (
	spec: FillSpec,
	j: number
): ReadonlyArray<{ readonly root: boolean; readonly before: number; readonly family: number }> => {
	const copy = copyAt(spec, j)
	if (copy.axis !== "owner" || !isSequence(familyAt(spec, copy.family))) {
		return []
	}
	return Arr.flatMap(positionsOf(spec, j), (root) => {
		const stage = stageOf(spec, copy.source, root, new Set([j]))
		return stage?.kind === "after" && !stage.families.has(copy.family)
			? Arr.map([...stage.families], (before) => ({ root, before, family: copy.family }))
			: []
	})
}

/**
 * The copies whose order the walk cannot keep: each asks that a sequence of its owner come before its own family,
 * where its own family must already come before that sequence, through every copy's ordering of that owner at that
 * position. No order of the walk fills either first, so each is refused as filled after its members.
 */
const orderCycles = (spec: FillSpec): ReadonlySet<number> => {
	const asked = Arr.flatMap(spec.copies, (copy, j) =>
		Arr.map(orderingOf(spec, j), (o) => ({ ...o, copy: j, row: sourceRelationOf(spec, copy) }))
	)
	const reaches = (row: number, root: boolean, from: number, to: number): boolean => {
		const seen = new Set<number>()
		const pending = [from]
		for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
			if (at === to) {
				return true
			}
			for (const o of asked) {
				if (o.row === row && o.root === root && o.before === at && !seen.has(o.family)) {
					seen.add(o.family)
					pending.push(o.family)
				}
			}
		}
		return false
	}
	return new Set(
		Arr.flatMap(asked, (o) => (reaches(o.row, o.root, o.family, o.before) ? [o.copy] : []))
	)
}

/** The causes the reference refuses copy `j` by, none when a write fills it: see the module's header. */
const refusalsOf = (
	spec: FillSpec,
	j: number,
	cycles: ReadonlySet<number>
): ReadonlyArray<LaterKind> => {
	const copy = copyAt(spec, j)
	const family = familyAt(spec, copy.family)
	const later = new Set<LaterKind>(cycles.has(j) ? ["afterMembers"] : [])
	for (const root of positionsOf(spec, j)) {
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
		if (
			copy.axis === "owner" &&
			isSequence(family) &&
			stage.kind === "after" &&
			stage.families.has(copy.family)
		) {
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
	if (nestingCycle(spec)) {
		return { kind: "unwritable" }
	}
	const cycles = orderCycles(spec)
	const copies = Arr.flatMap(spec.copies, (_, j) => {
		const later = refusalsOf(spec, j, cycles)
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

/**
 * A copy's own class as the suites' situations name it: what its source is filled by, relative to its axis: entering
 * its row; after the members of the copy's own family; after the members of another sequence its row owns; a counted
 * family's count or end; or a cycle.
 */
export type SourceClass =
	| "entering"
	| "after its own family"
	| "after another family"
	| "counted count"
	| "counted end"
	| "cycle"

/** The class of a copy's source on a member row of its relation, the reference's stage spelled as a situation. */
export const sourceClassOf = (spec: FillSpec, j: number): SourceClass => {
	const copy = copyAt(spec, j)
	const stage = stageOf(spec, copy.source, false, new Set([j]))
	if (stage === undefined) {
		return "cycle"
	}
	switch (stage.kind) {
		case "entering":
			return "entering"
		case "after":
			return stage.families.has(copy.family) ? "after its own family" : "after another family"
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
type Row = RowScalars<BuiltRelation>

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
					onBuilder(
						member,
						family.fold === "sum" ? [groupName(f), stepField(spec, f)] : [groupName(f)]
					),
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

/** A row of an instance as it is made: its counted families' owners are named once every row is made. */
interface DraftRow {
	readonly relation: number
	readonly id: number
	readonly v: bigint
	readonly memberOf: Array<InstanceRow["memberOf"][number]>
}

/**
 * An instance of an admitted specification: some rows of each relation a ChangeSet inserts itself (no ordered family's
 * member), each sequence's members nested under their owner's rows, a tree's nodes to a few levels; then every row of
 * a counted family's member, nested or not, names an owner of each counted family it belongs to. Relations name their
 * owners in their order, and a counted family's owner's relation comes before its member's, so every owner is made
 * first; a relation with a counted family none of whose owner's rows is left loses every row, and every row nested
 * under one. `count` says how many rows of a kind, between its bounds, and `value` each row's `v`.
 */
const instanceOf = (
	spec: FillSpec,
	count: (lo: number, hi: number) => number,
	value: (id: number) => bigint
): ReadonlyArray<InstanceRow> => {
	const rows: Array<DraftRow> = []
	const make = (relation: number, memberOf: InstanceRow["memberOf"], depth: number): void => {
		if (rows.length >= instanceBound) {
			return
		}
		const id = rows.length + 1
		rows.push({ relation, id, v: value(id), memberOf: [...memberOf] })
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
	const countedOf = (r: number): ReadonlyArray<number> =>
		Arr.flatMap(spec.families, (f, k) => (f.kind === "counted" && f.member === r ? [k] : []))
	for (const [r] of spec.relations.entries()) {
		if (!nestedOnly(spec, r)) {
			const k = count(0, Arr.isReadonlyArrayNonEmpty(countedOf(r)) ? 3 : 2)
			for (let i = 0; i < k; i += 1) {
				make(r, [], 0)
			}
		}
	}
	const removed = new Set<number>()
	const left = (r: number): ReadonlyArray<DraftRow> =>
		Arr.filter(rows, (row) => row.relation === r && !removed.has(row.id))
	for (const [r] of spec.relations.entries()) {
		const memberships = countedOf(r)
		const candidates = Arr.map(memberships, (f) => left(familyAt(spec, f).owner))
		if (Arr.some(candidates, (c) => c.length === 0)) {
			for (const row of left(r)) {
				removed.add(row.id)
			}
			for (const row of rows) {
				if (
					Arr.some(
						row.memberOf,
						(m) => isSequence(familyAt(spec, m.family)) && removed.has(m.owner)
					)
				) {
					removed.add(row.id)
				}
			}
			continue
		}
		for (const row of left(r)) {
			for (const [i, f] of memberships.entries()) {
				const choices = defined(candidates[i], "an owner's rows")
				row.memberOf.push({
					family: f,
					owner: defined(choices[count(0, choices.length - 1)], "an owner").id,
					slot: 0
				})
			}
		}
	}
	return Arr.flatMap(rows, (row) =>
		removed.has(row.id)
			? []
			: [{ relation: row.relation, id: row.id, v: row.v, memberOf: row.memberOf }]
	)
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
	const sourceValue = (row: InstanceRow, source: CopySource): bigint => {
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
				const stepped = stepCopyOf(spec, source.family)
				return family.fold === "sum"
					? Arr.reduce(
							members,
							0n,
							(sum, m) => sum + (stepped === undefined ? m.v : copyValue(m, stepped))
						)
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

/** A write of one relation of a specification, as one member of a ChangeSet states it. */
export interface SpecWrite {
	readonly relation: number
	readonly op: "insert" | "put" | "delete"
}

/**
 * A value the reference finds a change leaves stale, which a refill of its family draws again: the column the change
 * makes, by a write or by a refill, the write the change starts from (a refill's, the one whose path first reached
 * it), every relation the change passes on its way (its own, then each its cascade reaches), the value drawn from it,
 * and the family whose refill draws it.
 */
export interface StaleSpec {
	readonly changed: ChangedColumn
	readonly from: "write" | "refill"
	readonly origin: SpecWrite
	readonly passed: Arr.NonEmptyReadonlyArray<string>
	readonly reader: DerivedReader
	readonly family: number
}

/** Family `f` as a refusal names it. */
export const familyNamed = (spec: FillSpec, f: number): FamilyName => ({
	owner: relationName(familyAt(spec, f).owner),
	count: countName(f)
})

/**
 * The values of relation `r`'s families but those `except` names that read its column `column` and are drawn only when
 * their row is written, each with its family: a sum fold stepping the column, and a copy along a predecessor axis, a
 * last axis or a tree's owner axis.
 */
const derivedReaders = (
	spec: FillSpec,
	r: number,
	column: string,
	except: (k: number) => boolean
): ReadonlyArray<{ readonly reader: DerivedReader; readonly family: number }> => [
	...Arr.flatMap(spec.families, (l, k) =>
		l.member === r && !except(k) && l.fold === "sum" && column === stepField(spec, k)
			? [
					{
						family: k,
						reader: {
							kind: "fold" as const,
							family: familyNamed(spec, k),
							relation: relationName(l.owner),
							column: foldName(k)
						}
					}
				]
			: []
	),
	...Arr.flatMap(spec.copies, (c, j) => {
		const l = familyAt(spec, c.family)
		if (l.member !== r || except(c.family) || sourceField(c.source) !== column) {
			return []
		}
		const family = familyNamed(spec, c.family)
		const at = (kind: DerivedReader["kind"], relation: number) => [
			{
				family: c.family,
				reader: { kind, family, relation: relationName(relation), column: copyName(j) }
			}
		]
		switch (c.axis) {
			case "predecessor":
				return at("predecessor", r)
			case "last":
				return at("last", l.owner)
			case "owner":
				return l.kind === "tree" ? at("tree", r) : []
		}
	})
]

/** A change of stored rows the reference follows: a write of a ChangeSet's, or a refill of family `family`. */
type SpecChange =
	| { readonly kind: "write"; readonly write: SpecWrite }
	| { readonly kind: "refill"; readonly family: number; readonly origin: SpecWrite }

/**
 * The values one change leaves stale, by the reference: each value drawn from a column the change makes on rows
 * already stored that the change itself does not draw again, through every path the change takes.
 *
 * A put changes its row's `v` and `g`. A write of a family's member, a tree's aside, changes the owner's count, fold end
 * and last copies, and draws its members' index and copies along the owner and predecessor axes again. A refill of a
 * family changes its owner's fold end and last copies, and its members' predecessor copies and, along a tree, copies
 * of their parent's. A copy along a family's owner axis, a tree's aside, carries a change of what it reads into its
 * member's copy, and `g` follows `v`. A change reaches the values of the families of the row it is on (a fold summing
 * its step, and a predecessor copy, a last copy and a tree's copy of what changed): each is stale, but those the change
 * draws again itself: a write's of the written relation's own families, which the family planner draws, and a
 * refill's of its own family. An insert also edits the counted families of every counted member its nesting writes,
 * each nested row appended to them as a row of its own would be; their sequences are the walk's, under their fresh
 * owners, and change nothing stored. A relation of `replaced` has rows the ChangeSet deletes and inserts again, which no
 * cascade follows: a member's copy, along a family it owns, of a column a change makes there is stale too, its copy of
 * the family's count among them, and so is its own copy, as a counted family's member, of a column a change makes on
 * its owner; a sequence draws its own re-placed members from their owner as the ChangeSet leaves it.
 */
const staleOf = (
	spec: FillSpec,
	change: SpecChange,
	replaced: ReadonlySet<number>
): ReadonlyArray<StaleSpec> => {
	const found: Array<StaleSpec> = []
	/** The write the change starts from: its own, or the one whose path first reached the refill. */
	const origin = change.kind === "write" ? change.write : change.origin
	const reach = (
		changed: ChangedColumn,
		at: number,
		column: string,
		except: (k: number) => boolean,
		seen: ReadonlySet<string>,
		passed: Arr.NonEmptyReadonlyArray<string>
	): void => {
		const visit = `${at} ${column} ${seen.size === 0 ? "own" : "carried"}`
		if (seen.has(visit)) {
			return
		}
		const next = new Set([...seen, visit])
		for (const { reader, family } of derivedReaders(spec, at, column, except)) {
			found.push({ changed, from: change.kind, origin, passed, reader, family })
		}
		for (const [k, f] of spec.families.entries()) {
			if (replaced.has(at) && f.kind !== "tree" && f.owner === at && column === countName(k)) {
				found.push({
					changed,
					from: change.kind,
					origin,
					passed,
					reader: {
						kind: "owner",
						family: familyNamed(spec, k),
						relation: relationName(f.member),
						column: `‹${countName(k)}›`
					},
					family: k
				})
			}
		}
		for (const [j, c] of spec.copies.entries()) {
			const family = familyAt(spec, c.family)
			if (
				c.axis === "owner" &&
				family.kind !== "tree" &&
				family.owner === at &&
				sourceField(c.source) === column
			) {
				if (replaced.has(at) || (replaced.has(family.member) && family.kind === "counted")) {
					found.push({
						changed,
						from: change.kind,
						origin,
						passed,
						reader: {
							kind: "owner",
							family: familyNamed(spec, c.family),
							relation: relationName(family.member),
							column: copyName(j)
						},
						family: c.family
					})
				}
				reach(changed, family.member, copyName(j), () => false, next, [
					...passed,
					relationName(family.member)
				])
			}
		}
		if (column === "v" && relationAt(spec, at).generated) {
			reach(changed, at, "g", except, next, passed)
		}
	}
	const carried = (k: number, axis: Axis): ReadonlyArray<string> =>
		Arr.flatMap(spec.copies, (c, j) => (c.family === k && c.axis === axis ? [copyName(j)] : []))
	const changes = ((): ReadonlyArray<{
		readonly at: number
		readonly column: string
		readonly by: ChangedColumn["by"]
		readonly except: (k: number) => boolean
	}> => {
		if (change.kind === "refill") {
			const k = change.family
			const f = familyAt(spec, k)
			const own = (x: number): boolean => x === k
			return [
				...Arr.map(
					[...(f.fold === "none" ? [] : [foldName(k)]), ...carried(k, "last")],
					(column) => ({
						at: f.owner,
						column,
						by: "owner" as const,
						except: own
					})
				),
				...Arr.map(
					[...carried(k, "predecessor"), ...(f.kind === "tree" ? carried(k, "owner") : [])],
					(column) => ({
						at: f.member,
						column,
						by: "member" as const,
						except: own
					})
				)
			]
		}
		const write = change.write
		const r = write.relation
		const written = (k: number): boolean => familyAt(spec, k).member === r
		/** The relations an insert of r nests, through its sequences, every one but r. */
		const nested = new Set<number>()
		if (write.op === "insert") {
			const pending = [r]
			for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
				for (const s of spec.families) {
					if (s.owner === at && s.kind !== "counted" && s.member !== r && !nested.has(s.member)) {
						nested.add(s.member)
						pending.push(s.member)
					}
				}
			}
		}
		return [
			...(write.op === "put"
				? Arr.map(["v", ...(relationAt(spec, r).generated ? ["g"] : [])], (column) => ({
						at: r,
						column,
						by: "put" as const,
						except: written
					}))
				: []),
			...Arr.flatMap(spec.families, (f, k) => {
				if (
					f.kind === "tree" ||
					(f.member !== r && !(f.kind === "counted" && nested.has(f.member)))
				) {
					return []
				}
				return [
					...Arr.map(
						[countName(k), ...(f.fold === "none" ? [] : [foldName(k)]), ...carried(k, "last")],
						(column) => ({
							at: f.owner,
							column,
							by: "owner" as const,
							except: () => false
						})
					),
					...Arr.map(
						[
							...(f.kind === "ordered" ? [indexName(k)] : []),
							...carried(k, "owner"),
							...carried(k, "predecessor")
						],
						(column) => ({
							at: f.member,
							column,
							by: "member" as const,
							except: (x: number) => familyAt(spec, x).member === f.member
						})
					)
				]
			})
		]
	})()
	for (const c of changes) {
		reach(
			{ relation: relationName(c.at), column: c.column, by: c.by },
			c.at,
			c.column,
			c.except,
			new Set(),
			[relationName(c.at)]
		)
	}
	return found
}

/**
 * The refills a ChangeSet of `writes` needs, by the reference: every value its writes leave stale, and every value each
 * refill it needs leaves stale in turn, each with the family whose refill draws it again.
 */
const refillsOf = (
	spec: FillSpec,
	writes: ReadonlyArray<SpecWrite>
): { readonly stale: ReadonlyArray<StaleSpec>; readonly cycle: ReadonlyArray<number> } => {
	const found: Array<StaleSpec> = []
	const refilled = new Set<number>()
	/** Each refilled family's refills its own changes reach. */
	const next = new Map<number, Set<number>>()
	/** The relations whose stored rows the writes may delete and insert again: a put of a member of a family that is no
	 * tree, which may move it to another group or change what an ordered family reads of it, and a delete of an ordered
	 * family's member, which re-places every member after it, each family's owner mutable. */
	const replaced = new Set(
		Arr.flatMap(writes, (w) =>
			Arr.some(
				spec.families,
				(f) =>
					f.member === w.relation &&
					f.kind !== "tree" &&
					relationAt(spec, f.owner).mutable &&
					(w.op === "put" || (w.op === "delete" && f.kind === "ordered"))
			)
				? [w.relation]
				: []
		)
	)
	const pending: Array<SpecChange> = Arr.map(writes, (write) => ({ kind: "write", write }))
	for (let change = pending.shift(); change !== undefined; change = pending.shift()) {
		for (const stale of staleOf(spec, change, replaced)) {
			found.push(stale)
			if (change.kind === "refill") {
				const out = next.get(change.family) ?? new Set<number>()
				out.add(stale.family)
				next.set(change.family, out)
			}
			if (!refilled.has(stale.family)) {
				refilled.add(stale.family)
				pending.push({ kind: "refill", family: stale.family, origin: stale.origin })
			}
		}
	}
	/** Whether family `k`'s refill reaches it again, through the refills each reaches in turn. */
	const returns = (k: number): boolean => {
		const seen = new Set<number>()
		const pendingFamilies = [...(next.get(k) ?? [])]
		for (let at = pendingFamilies.pop(); at !== undefined; at = pendingFamilies.pop()) {
			if (at === k) {
				return true
			}
			if (!seen.has(at)) {
				seen.add(at)
				for (const then of next.get(at) ?? []) {
					pendingFamilies.push(then)
				}
			}
		}
		return false
	}
	return {
		stale: found,
		cycle: Arr.filter(Arr.sort([...refilled], Order.Number), returns)
	}
}

/**
 * A shape a drawn specification reaches only now and then, which a suite plants where its witnesses still miss it:
 * - `counted copy of an end`: a counted family's copy of its owner's end of a fold over a sequence the owner owns;
 * - `counted ordered member`, `counted tree node`, `counted sequence owner`: a counted family's member that is also an
 *   ordered family's member, a tree's node, or the owner of an ordered family or a tree;
 * - `tree with an ordered family`, `tree with a counted family`: a tree's relation that owns another family;
 * - `counted family of a nested owner`: a counted family whose owner is an ordered family's member;
 * - `copy of a tree's end`, `counted copy of a tree's end`: a copy along another family's owner axis of a tree node's
 *   `end`, that family drawn or counted;
 * - `nesting three deep`: ordered families nested two below their first owner;
 * - `mutable owner`: a mutable owner of a counted and an ordered family over mutable members, which a follow-up puts
 *   beside appends to its families;
 * - `sibling's end`, `siblings' ends`: an owner of two sequences, a tree or an ordered family and an ordered family,
 *   each with a fold, and a copy along one's owner axis of the other's end, or along each of the other's;
 * - `stepped copy`: a mutable owner of a counted or an ordered family over a mutable member, which copies its owner's
 *   `v` along the family's owner axis, and the family's sum fold steps that copy, so a put of the owner changes what
 *   the fold's every step reads;
 * - `re-placed owner`, `re-placed immutable owner`: a mutable owner's ordered family whose member, mutable or immutable,
 *   owns a counted family, its members copying the member's index or nothing, so a delete or a move of a member
 *   re-places the members after it beneath their own counted members;
 * - `generated copy`: a copy along a counted or an ordered family's owner axis of its owner's generated `g`.
 */
export type Planted =
	| "counted copy of an end"
	| "counted ordered member"
	| "counted tree node"
	| "counted sequence owner"
	| "tree with an ordered family"
	| "tree with a counted family"
	| "counted family of a nested owner"
	| "copy of a tree's end"
	| "counted copy of a tree's end"
	| "nesting three deep"
	| "mutable owner"
	| "sibling's end"
	| "siblings' ends"
	| "stepped copy"
	| "re-placed owner"
	| "re-placed immutable owner"
	| "generated copy"
	| "counted step of a sequence's copy"

/** A specification holding the shape `planted` (`Planted`), its relations' flags, its folds and its kinds drawn. */
export const plantedGen =
	(planted: Planted): Gen<FillSpec> =>
	(source) => {
		const relationGen = (): RelationSpec => ({
			generated: source.draw(boolean),
			mutable: source.draw(boolean),
			key: false
		})
		const fold = (): FamilySpec["fold"] => {
			const k = source.draw(int(0, 2))
			return k === 0 ? "none" : k === 1 ? "sum" : "count"
		}
		const sequence = (owner: number, member: number): FamilySpec =>
			source.draw(boolean)
				? { kind: "tree", owner, member: owner, fold: fold() }
				: { kind: "ordered", owner, member, fold: fold() }
		const relations: Arr.NonEmptyReadonlyArray<RelationSpec> = [
			relationGen(),
			relationGen(),
			relationGen()
		]
		switch (planted) {
			case "counted copy of an end": {
				const first = sequence(0, 1)
				return {
					relations,
					families: [
						{ ...first, fold: source.draw(boolean) ? "sum" : "count" },
						{ kind: "counted", owner: 0, member: 2, fold: fold() }
					],
					copies: [{ family: 1, axis: "owner", source: { kind: "fold", family: 0 } }],
					steps: []
				}
			}
			case "counted ordered member":
				return {
					relations,
					families: [
						{ kind: "ordered", owner: 0, member: 2, fold: fold() },
						{ kind: "counted", owner: source.draw(int(0, 1)), member: 2, fold: fold() }
					],
					copies: [],
					steps: []
				}
			case "counted tree node":
				return {
					relations,
					families: [
						{ kind: "tree", owner: 1, member: 1, fold: fold() },
						{ kind: "counted", owner: 0, member: 1, fold: fold() }
					],
					copies: [],
					steps: []
				}
			case "counted sequence owner":
				return {
					relations,
					families: [{ kind: "counted", owner: 0, member: 1, fold: fold() }, sequence(1, 2)],
					copies: [],
					steps: []
				}
			case "tree with an ordered family":
			case "tree with a counted family":
				return {
					relations,
					families: [
						{ kind: "tree", owner: 0, member: 0, fold: fold() },
						{
							kind: planted === "tree with an ordered family" ? "ordered" : "counted",
							owner: 0,
							member: 1,
							fold: fold()
						}
					],
					copies: [],
					steps: []
				}
			case "counted family of a nested owner":
				return {
					relations,
					families: [
						{ kind: "ordered", owner: 0, member: 1, fold: fold() },
						{ kind: "counted", owner: 1, member: 2, fold: fold() }
					],
					copies: [],
					steps: []
				}
			case "copy of a tree's end":
			case "counted copy of a tree's end":
				return {
					relations,
					families: [
						{ kind: "tree", owner: 0, member: 0, fold: fold() },
						{
							kind:
								planted === "counted copy of a tree's end" || source.draw(boolean)
									? "counted"
									: "ordered",
							owner: 0,
							member: 1,
							fold: fold()
						}
					],
					copies: [{ family: 1, axis: "owner", source: { kind: "end" } }],
					steps: []
				}
			case "sibling's end":
			case "siblings' ends": {
				const ends: FamilySpec["fold"] = source.draw(boolean) ? "sum" : "count"
				const first = { ...sequence(0, 1), fold: ends }
				const second: FamilySpec = { kind: "ordered", owner: 0, member: 2, fold: ends }
				const reads = (f: number, other: number): CopySpec => ({
					family: f,
					axis: "owner",
					source: { kind: "fold", family: other }
				})
				const one = source.draw(boolean) ? reads(0, 1) : reads(1, 0)
				return {
					relations,
					families: [first, second],
					copies: planted === "sibling's end" ? [one] : [reads(0, 1), reads(1, 0)],
					steps: []
				}
			}
			case "mutable owner":
				return {
					relations: [
						{ ...relations[0], mutable: true },
						{ ...relationGen(), mutable: true },
						{ ...relationGen(), mutable: true }
					],
					families: [
						{ kind: "counted", owner: 0, member: 1, fold: fold() },
						{ kind: "ordered", owner: 0, member: 2, fold: fold() }
					],
					copies: [],
					steps: []
				}
			case "stepped copy":
				return {
					relations: [
						{ ...relations[0], mutable: true },
						{ ...relationGen(), mutable: true },
						relationGen()
					],
					families: [
						{
							kind: source.draw(boolean) ? "counted" : "ordered",
							owner: 0,
							member: 1,
							fold: "sum"
						}
					],
					copies: [{ family: 0, axis: "owner", source: { kind: "caller" } }],
					steps: [{ family: 0, copy: 0 }]
				}
			case "generated copy":
				return {
					relations: [{ ...relations[0], generated: true }, relationGen(), relationGen()],
					families: [
						{
							kind: source.draw(boolean) ? "counted" : "ordered",
							owner: 0,
							member: 1,
							fold: fold()
						}
					],
					copies: [{ family: 0, axis: "owner", source: { kind: "generated" } }],
					steps: []
				}
			case "re-placed immutable owner":
				return {
					relations: [
						{ ...relations[0], mutable: true },
						{ ...relationGen(), mutable: false },
						{ ...relationGen(), mutable: true }
					],
					families: [
						{ kind: "ordered", owner: 0, member: 1, fold: fold() },
						{ kind: "counted", owner: 1, member: 2, fold: fold() }
					],
					copies: [],
					steps: []
				}
			case "re-placed owner":
				return {
					relations: [
						{ ...relations[0], mutable: true },
						{ ...relationGen(), mutable: true },
						{ ...relationGen(), mutable: true }
					],
					families: [
						{ kind: "ordered", owner: 0, member: 1, fold: fold() },
						{ kind: "counted", owner: 1, member: 2, fold: fold() }
					],
					copies: source.draw(boolean)
						? [{ family: 1, axis: "owner", source: { kind: "index", family: 0 } }]
						: [],
					steps: []
				}
			case "nesting three deep":
				return {
					relations,
					families: [
						{ kind: "ordered", owner: 0, member: 1, fold: fold() },
						{ kind: "ordered", owner: 1, member: 2, fold: fold() }
					],
					copies: [],
					steps: []
				}
			case "counted step of a sequence's copy": {
				const tree = source.draw(boolean)
				const generated = source.draw(boolean)
				const owner = tree ? 0 : 2
				return {
					relations: Arr.map(relations, (r, i) => (i === owner ? { ...r, generated } : r)),
					families: [
						tree
							? { kind: "tree", owner: 0, member: 0, fold: fold() }
							: { kind: "ordered", owner: 2, member: 0, fold: fold() },
						{ kind: "counted", owner: 1, member: 0, fold: "sum" }
					],
					copies: [
						{ family: 0, axis: "owner", source: { kind: generated ? "generated" : "caller" } }
					],
					steps: [{ family: 1, copy: 0 }]
				}
			}
		}
	}

/**
 * Two specifications side by side, over disjoint relations: `planted`'s relations, families, copies and steps after
 * `base`'s, renumbered past them. Neither reads the other, so the union is admitted exactly where both are.
 */
export const besides = (base: FillSpec, planted: FillSpec): FillSpec => {
	const r = base.relations.length
	const f = base.families.length
	const c = base.copies.length
	const source = (s: CopySource): CopySource => {
		switch (s.kind) {
			case "caller":
			case "generated":
			case "start":
			case "end":
				return s
			case "count":
			case "index":
			case "fold":
				return { ...s, family: s.family + f }
			case "copy":
				return { kind: "copy", copy: s.copy + c }
		}
	}
	return {
		relations: relationsNonEmpty([...base.relations, ...planted.relations]),
		families: [
			...base.families,
			...Arr.map(planted.families, (x) => ({ ...x, owner: x.owner + r, member: x.member + r }))
		],
		copies: [
			...base.copies,
			...Arr.map(planted.copies, (x) => ({
				family: x.family + f,
				axis: x.axis,
				source: source(x.source)
			}))
		],
		steps: [
			...base.steps,
			...Arr.map(planted.steps, (x) => ({ family: x.family + f, copy: x.copy + c }))
		]
	}
}

/**
 * A drawn specification with every relation mutable, or as `specs` draws it: the fill order never reads a relation's
 * mutability, and a follow-up needs a mutable owner.
 */
export const mutableOrDrawn =
	(specs: Gen<FillSpec>): Gen<FillSpec> =>
	(source) => {
		const spec = source.draw(specs)
		const [first, ...rest] = spec.relations
		const mutable = (r: RelationSpec): RelationSpec => ({ ...r, mutable: true })
		return source.draw(boolean)
			? { ...spec, relations: [mutable(first), ...Arr.map(rest, mutable)] }
			: spec
	}

/** The relations of a specification, by index. */
const relationIndices = (spec: FillSpec): ReadonlyArray<number> =>
	Arr.map(spec.relations, (_, r) => r)

/** Whether relation `r` owns a sequence, an ordered family or a tree. */
const ownsSequence = (spec: FillSpec, r: number): boolean =>
	Arr.some(spec.families, (f) => f.owner === r && isSequence(f))

/**
 * A second ChangeSet over a stored instance, written after its first insert, around one row of `owner`: a mutable
 * relation that is no tree's, owns no sequence while it is a member, and is a member only of mutable owners' families,
 * so the rules admit its put in place. It puts the row with a new `v`, or leaves it; inserts counted members under it
 * in one counted family it owns whose member is no ordered family's, each naming a row of the owner of every other
 * counted family it is a member of, every such owner mutable, with the sequences it owns empty; deletes a stored member
 * that owns no row of one of its ordered families (`removed`), or none; and puts a member at the end of one ordered
 * family it owns, whose member owns no sequence, is mutable where it owns a family and names a row of the owner of
 * every counted family it is a member of, every such owner mutable: a new one (`appended`), or a stored one of another
 * owner's group (`moved`), its relation mutable, or none. Half the time, where an owner's row holds a stored member of
 * such a family, the follow-up is around such a row and deletes a member, moves one or both, and appends none. A
 * deletion or a move re-places every member after it in its group, and a moved member keeps the rows it owns. Each new
 * row's id follows the instance's largest.
 */
export interface FollowUp {
	readonly owner: number
	readonly row: number
	readonly put: Option.Option<bigint>
	readonly inserted: ReadonlyArray<InstanceRow>
	readonly removed: Option.Option<FollowUpMove>
	readonly appended: Option.Option<InstanceRow>
	readonly moved: Option.Option<FollowUpMove>
}

/** A stored member a follow-up deletes or moves, by its row's id, of the ordered family `family`. */
export interface FollowUpMove {
	readonly id: number
	readonly family: number
}

/** One member of a follow-up's ChangeSet: the relation it writes, by an insert, a put or a delete, and its facts. */
export interface FollowUpMember {
	readonly relation: number
	readonly op: "insert" | "put" | "delete"
	readonly facts: ReadonlyArray<Fact>
}

/** A row's caller fields as a fact states them: its `v`, and the group field of every family it is a member of. */
const memberFact = (row: InstanceRow, v: bigint): Fact =>
	Rec.fromEntries([
		["id", uuidOfRow(row.id)] as const,
		["v", v] as const,
		...Arr.map(row.memberOf, (m) => [groupName(m.family), uuidOfRow(m.owner)] as const)
	])

/**
 * A follow-up drawn over an instance of an admitted specification, its owner among those whose families may take an
 * append where any may; none where no row may take one, or it draws no change.
 */
export const followUpGen =
	(spec: FillSpec, rows: ReadonlyArray<InstanceRow>): Gen<Option.Option<FollowUp>> =>
	(source) => {
		const rowsOf = (r: number): ReadonlyArray<InstanceRow> =>
			Arr.filter(rows, (row) => row.relation === r)
		const mutable = (r: number): boolean => relationAt(spec, r).mutable
		const families = Arr.map(spec.families, (_, k) => k)
		/** Whether every counted family `member` is a member of has a mutable owner with a row, which a new member names. */
		const countedOwners = (member: number): boolean =>
			Arr.every(
				spec.families,
				(o) =>
					o.kind !== "counted" ||
					o.member !== member ||
					(mutable(o.owner) && Arr.isReadonlyArrayNonEmpty(rowsOf(o.owner)))
			)
		/** The counted families of `owner` a member may be inserted into: its member inserted directly, no ordered
		 * family's, and each owner it names mutable, with a row. */
		const countedOf = (owner: number): ReadonlyArray<number> =>
			Arr.filter(families, (k) => {
				const f = familyAt(spec, k)
				return (
					f.kind === "counted" &&
					f.owner === owner &&
					!nestedOnly(spec, f.member) &&
					countedOwners(f.member)
				)
			})
		/** The ordered families of `owner` a member may be put at the end of: one that owns no sequence, mutable where
		 * it owns a family, and naming a mutable owner of each counted family it is a member of. */
		const orderedOf = (owner: number): ReadonlyArray<number> =>
			Arr.filter(families, (k) => {
				const f = familyAt(spec, k)
				return (
					f.kind === "ordered" &&
					f.owner === owner &&
					!ownsSequence(spec, f.member) &&
					(mutable(f.member) || !Arr.some(spec.families, (o) => o.owner === f.member)) &&
					countedOwners(f.member)
				)
			})
		/** The ordered families of `owner` whose stored members a follow-up may delete or move to its row: one whose
		 * member owns no sequence and is mutable, naming a mutable owner of each counted family it is a member of. */
		const reorderedOf = (owner: number): ReadonlyArray<number> =>
			Arr.filter(families, (k) => {
				const f = familyAt(spec, k)
				return (
					f.kind === "ordered" &&
					f.owner === owner &&
					!ownsSequence(spec, f.member) &&
					mutable(f.member) &&
					countedOwners(f.member)
				)
			})
		const owners = Arr.filter(
			relationIndices(spec),
			(r) =>
				mutable(r) &&
				treeOn(spec, r) === undefined &&
				Arr.every(
					spec.families,
					(f) => f.member !== r || (mutable(f.owner) && !ownsSequence(spec, r))
				) &&
				Arr.isReadonlyArrayNonEmpty(rowsOf(r))
		)
		const appending = Arr.filter(
			owners,
			(r) => Arr.isReadonlyArrayNonEmpty(countedOf(r)) || Arr.isReadonlyArrayNonEmpty(orderedOf(r))
		)
		/** The owners with a stored member in an ordered family a follow-up may delete or move: half the time the
		 * follow-up is around one of them, and deletes or moves such a member instead of appending one. */
		const reordering = Arr.filter(owners, (r) =>
			Arr.some(reorderedOf(r), (k) => Arr.some(rows, (x) => membershipIn(x, k) !== undefined))
		)
		const reorders = Arr.isReadonlyArrayNonEmpty(reordering) && source.draw(boolean)
		const chosen = reorders
			? reordering
			: Arr.isReadonlyArrayNonEmpty(appending)
				? appending
				: owners
		if (!Arr.isReadonlyArrayNonEmpty(chosen)) {
			return Option.none()
		}
		const owner = defined(chosen[source.draw(int(0, chosen.length - 1))], "an owner")
		/** The id after every row's of the instance, whose ids need not run unbroken. */
		const firstId = Arr.reduce(rows, 0, (most, r) => Math.max(most, r.id)) + 1
		/** The owner's rows, those with a member a follow-up may delete or move where it was drawn among `reordering`. */
		const holding = Arr.filter(rowsOf(owner), (r) =>
			Arr.some(reorderedOf(owner), (k) => Arr.some(rows, (x) => membershipIn(x, k)?.owner === r.id))
		)
		const candidates = reorders ? holding : rowsOf(owner)
		const row = defined(candidates[source.draw(int(0, candidates.length - 1))], "an owner's row")
		/** A new row's memberships of the counted families of `member`, each owner drawn among its rows but `fixed`'s,
		 * which is the chosen row. */
		const countedMemberships = (
			member: number,
			fixed: number | undefined
		): ReadonlyArray<InstanceRow["memberOf"][number]> =>
			Arr.flatMap(spec.families, (o, n) => {
				if (o.kind !== "counted" || o.member !== member) {
					return []
				}
				const choices = rowsOf(o.owner)
				const named =
					n === fixed ? row : defined(choices[source.draw(int(0, choices.length - 1))], "an owner")
				return [{ family: n, owner: named.id, slot: 0 }]
			})
		const put = source.draw(boolean)
			? Option.some(row.v + BigInt(source.draw(int(1, 3))) * (source.draw(boolean) ? 1n : -1n))
			: Option.none()
		const counted = countedOf(owner)
		const inserted: ReadonlyArray<InstanceRow> = Arr.isReadonlyArrayNonEmpty(counted)
			? (() => {
					const k = defined(counted[source.draw(int(0, counted.length - 1))], "a counted family")
					const member = familyAt(spec, k).member
					const made: Array<InstanceRow> = []
					for (let i = source.draw(int(0, 2)); i > 0; i -= 1) {
						made.push({
							relation: member,
							id: firstId + made.length,
							v: BigInt(source.draw(int(-2, 3))),
							memberOf: countedMemberships(member, k)
						})
					}
					return made
				})()
			: []
		const reordered = reorderedOf(owner)
		/** Whether a row of the instance is a member of the row `id` owns. */
		const ownsRows = (id: number): boolean =>
			Arr.some(rows, (x) => Arr.some(x.memberOf, (m) => m.owner === id))
		/** A stored member of one of `reordered` drawn among the rows `where` keeps, or none: always where the owner was
		 * drawn among `reordering`, else half the time. */
		const storedMember = (
			where: (x: InstanceRow, family: number) => boolean,
			pick: (candidates: Arr.NonEmptyReadonlyArray<InstanceRow>, family: number) => InstanceRow
		): Option.Option<FollowUpMove> => {
			if (!Arr.isReadonlyArrayNonEmpty(reordered) || (!reorders && !source.draw(boolean))) {
				return Option.none()
			}
			const family = defined(
				reordered[source.draw(int(0, reordered.length - 1))],
				"an ordered family"
			)
			const candidates = Arr.filter(rows, (x) => where(x, family))
			return Arr.isReadonlyArrayNonEmpty(candidates)
				? Option.some({ id: pick(candidates, family).id, family })
				: Option.none()
		}
		/** The removed member: the first of the row's members that owns no row, which re-places the most after it. */
		const removed = storedMember(
			(x, family) => membershipIn(x, family)?.owner === row.id && !ownsRows(x.id),
			(candidates, family) =>
				Arr.reduce(candidates, candidates[0], (first, x) =>
					(membershipIn(x, family)?.slot ?? 0) < (membershipIn(first, family)?.slot ?? 0)
						? x
						: first
				)
		)
		/** The slot after the last member of `family` the row keeps. */
		const end = (family: number): number =>
			Arr.filter(rows, (r) => membershipIn(r, family)?.owner === row.id).length -
			(Option.exists(removed, (m) => m.family === family) ? 1 : 0)
		const ordered = orderedOf(owner)
		const appended: Option.Option<InstanceRow> =
			!reorders && Arr.isReadonlyArrayNonEmpty(ordered) && source.draw(boolean)
				? (() => {
						const g = defined(ordered[source.draw(int(0, ordered.length - 1))], "an ordered family")
						const member = familyAt(spec, g).member
						return Option.some({
							relation: member,
							id: firstId + inserted.length,
							v: BigInt(source.draw(int(-2, 3))),
							memberOf: [
								{ family: g, owner: row.id, slot: end(g) },
								...countedMemberships(member, undefined)
							]
						})
					})()
				: Option.none()
		const moved = Option.isSome(appended)
			? Option.none()
			: storedMember(
					(x, family) => {
						const m = membershipIn(x, family)
						return m !== undefined && m.owner !== row.id
					},
					(candidates) =>
						defined(candidates[source.draw(int(0, candidates.length - 1))], "a member")
				)
		return Option.isNone(put) &&
			inserted.length === 0 &&
			Option.isNone(removed) &&
			Option.isNone(appended) &&
			Option.isNone(moved)
			? Option.none()
			: Option.some({ owner, row: row.id, put, inserted, removed, appended, moved })
	}

/**
 * A follow-up aimed at a stale value: a put of the first row of `owner` with a new `v`, and nothing else; none where
 * the instance holds no row of it.
 */
export const ownerPutGen =
	(rows: ReadonlyArray<InstanceRow>, owner: number): Gen<Option.Option<FollowUp>> =>
	(source) =>
		Option.map(
			Arr.findFirst(rows, (r) => r.relation === owner),
			(row): FollowUp => ({
				owner,
				row: row.id,
				put: Option.some(row.v + BigInt(source.draw(int(1, 3)))),
				inserted: [],
				removed: Option.none(),
				appended: Option.none(),
				moved: Option.none()
			})
		)

/**
 * A follow-up aimed at a re-placed owner, over the ordered family `family`, drawing nothing: the deletion of a group's
 * first member that owns no row where a later member owns one, which re-places it; else, the member relation mutable,
 * the move of a member that owns a row to the end of another owner's group; none where the instance holds neither.
 */
export const replacingGen =
	(
		spec: FillSpec,
		rows: ReadonlyArray<InstanceRow>,
		family: number
	): Gen<Option.Option<FollowUp>> =>
	() => {
		const owner = familyAt(spec, family).owner
		const ownsRows = (id: number): boolean =>
			Arr.some(rows, (x) => Arr.some(x.memberOf, (m) => m.owner === id))
		const slotOf = (x: InstanceRow): number => membershipIn(x, family)?.slot ?? 0
		const owners = Arr.filter(rows, (r) => r.relation === owner)
		const [deletion] = Arr.flatMap(owners, (o) => {
			const group = Arr.sort(
				Arr.filter(rows, (x) => membershipIn(x, family)?.owner === o.id),
				Order.mapInput(Order.Number, slotOf)
			)
			const free = Arr.findFirstIndex(group, (x) => !ownsRows(x.id))
			if (
				Option.isNone(free) ||
				!Arr.some(Arr.drop(group, free.value + 1), (x) => ownsRows(x.id))
			) {
				return []
			}
			return Arr.map(Arr.take(Arr.drop(group, free.value), 1), (x) => ({ row: o.id, id: x.id }))
		})
		if (deletion !== undefined) {
			return Option.some({
				owner,
				row: deletion.row,
				put: Option.none(),
				inserted: [],
				removed: Option.some({ id: deletion.id, family }),
				appended: Option.none(),
				moved: Option.none()
			})
		}
		const mover = Arr.findFirst(
			rows,
			(x) =>
				relationAt(spec, x.relation).mutable &&
				membershipIn(x, family) !== undefined &&
				ownsRows(x.id)
		)
		return Option.flatMap(mover, (m) =>
			Option.map(
				Arr.findFirst(owners, (o) => o.id !== membershipIn(m, family)?.owner),
				(o): FollowUp => ({
					owner,
					row: o.id,
					put: Option.none(),
					inserted: [],
					removed: Option.none(),
					appended: Option.none(),
					moved: Option.some({ id: m.id, family })
				})
			)
		)
	}

/**
 * The instance a follow-up leaves: its owner's row with its new `v`, its removed member gone, its moved member at the
 * end of the row's group, each member after the removed or the moved one in its group a slot down, then its new rows.
 */
export const followUpRows = (
	rows: ReadonlyArray<InstanceRow>,
	followUp: FollowUp
): ReadonlyArray<InstanceRow> => {
	/** The slots the removed and the moved member leave, each in its family and its owner's group. */
	const left = Arr.flatMap(
		[...Option.toArray(followUp.removed), ...Option.toArray(followUp.moved)],
		({ id, family }) => {
			const stored = Option.getOrUndefined(Arr.findFirst(rows, (x) => x.id === id))
			const m = stored === undefined ? undefined : membershipIn(stored, family)
			return m === undefined ? [] : [{ family, owner: m.owner, slot: m.slot }]
		}
	)
	const end = (family: number): number =>
		Arr.filter(rows, (x) => membershipIn(x, family)?.owner === followUp.row).length -
		Arr.filter(left, (l) => l.family === family && l.owner === followUp.row).length
	return [
		...Arr.flatMap(rows, (row): ReadonlyArray<InstanceRow> => {
			if (Option.exists(followUp.removed, (m) => m.id === row.id)) {
				return []
			}
			const moving = Option.getOrUndefined(Option.filter(followUp.moved, (m) => m.id === row.id))
			return [
				{
					...row,
					v: row.id === followUp.row ? Option.getOrElse(followUp.put, () => row.v) : row.v,
					memberOf: Arr.map(row.memberOf, (m) =>
						moving !== undefined && m.family === moving.family
							? { family: m.family, owner: followUp.row, slot: end(m.family) }
							: {
									...m,
									slot:
										m.slot -
										Arr.filter(
											left,
											(l) => l.family === m.family && l.owner === m.owner && l.slot < m.slot
										).length
								}
					)
				}
			]
		}),
		...followUp.inserted,
		...Option.toArray(followUp.appended)
	]
}

/**
 * A follow-up's ChangeSet, member by member: the owner's put, the counted members' insert, each a top fact of its
 * relation with the sequences it owns empty and a tree's root its own, the removed member's delete, and the appended or
 * the moved member's put, the moved one under the follow-up's row.
 */
export const followUpMembers = (
	spec: FillSpec,
	rows: ReadonlyArray<InstanceRow>,
	followUp: FollowUp
): ReadonlyArray<FollowUpMember> => {
	const rowOf = (id: number): InstanceRow =>
		defined(Arr.findFirst(rows, (r) => r.id === id).pipe(Option.getOrUndefined), `the row ${id}`)
	const row = rowOf(followUp.row)
	return [
		...Option.match(followUp.put, {
			onNone: (): ReadonlyArray<FollowUpMember> => [],
			onSome: (v): ReadonlyArray<FollowUpMember> => [
				{ relation: followUp.owner, op: "put", facts: [memberFact(row, v)] }
			]
		}),
		...Arr.match(followUp.inserted, {
			onEmpty: (): ReadonlyArray<FollowUpMember> => [],
			onNonEmpty: (inserted): ReadonlyArray<FollowUpMember> => [
				{
					relation: inserted[0].relation,
					op: "insert",
					facts: instanceFacts(spec, inserted).get(inserted[0].relation) ?? []
				}
			]
		}),
		...Option.match(followUp.removed, {
			onNone: (): ReadonlyArray<FollowUpMember> => [],
			onSome: ({ id }): ReadonlyArray<FollowUpMember> => {
				const x = rowOf(id)
				return [{ relation: x.relation, op: "delete", facts: [memberFact(x, x.v)] }]
			}
		}),
		...Option.match(followUp.appended, {
			onNone: (): ReadonlyArray<FollowUpMember> => [],
			onSome: (a): ReadonlyArray<FollowUpMember> => [
				{ relation: a.relation, op: "put", facts: [memberFact(a, a.v)] }
			]
		}),
		...Option.match(followUp.moved, {
			onNone: (): ReadonlyArray<FollowUpMember> => [],
			onSome: ({ id, family }): ReadonlyArray<FollowUpMember> => {
				const x = rowOf(id)
				const under = {
					...x,
					memberOf: Arr.map(x.memberOf, (m) =>
						m.family === family ? { ...m, owner: followUp.row } : m
					)
				}
				return [{ relation: x.relation, op: "put", facts: [memberFact(under, x.v)] }]
			}
		})
	]
}

/**
 * The reference's verdict on a ChangeSet of `writes` over a stored instance of an admitted specification, with every
 * value it leaves stale (`refillsOf`): written, each stale value drawn again by a refill of its family; refused, where
 * a refill would change the rows of an immutable relation: a refilled family's members, or its owner, whose family is
 * fixed when it is inserted (StaleDerivedRead, `immutable`, the compiler naming any of `immutable`); or, failing that,
 * cycle, where refills reach a family they refill again (StaleDerivedRead, `cycle`, every family the compiler names
 * among `cycle`, the families whose refill reaches them again). A refusal names the write a refused refill's path
 * starts from, one of `origins`.
 */
export type WritesVerdict =
	| { readonly kind: "written"; readonly stale: ReadonlyArray<StaleSpec> }
	| {
			readonly kind: "refused"
			readonly stale: ReadonlyArray<StaleSpec>
			readonly immutable: Arr.NonEmptyReadonlyArray<string>
			readonly origins: Arr.NonEmptyReadonlyArray<SpecWrite>
	  }
	| {
			readonly kind: "cycle"
			readonly stale: ReadonlyArray<StaleSpec>
			readonly cycle: Arr.NonEmptyReadonlyArray<number>
			readonly origins: Arr.NonEmptyReadonlyArray<SpecWrite>
	  }

/** The reference's verdict on a ChangeSet of `writes` (`WritesVerdict`). */
export const writesVerdict = (spec: FillSpec, writes: ReadonlyArray<SpecWrite>): WritesVerdict => {
	const { stale, cycle } = refillsOf(spec, writes)
	const sameWrite = (a: SpecWrite, b: SpecWrite): boolean =>
		a.relation === b.relation && a.op === b.op
	/** Each stale value of a family whose refill would change an immutable relation's rows, with those relations. */
	const fixed = Arr.flatMap(stale, (s) => {
		const f = familyAt(spec, s.family)
		const relations = [
			...(relationAt(spec, f.member).mutable ? [] : [relationName(f.member)]),
			...(relationAt(spec, f.owner).mutable ? [] : [relationName(f.owner)])
		]
		return Arr.isReadonlyArrayNonEmpty(relations) ? [{ s, relations }] : []
	})
	if (Arr.isReadonlyArrayNonEmpty(fixed)) {
		return {
			kind: "refused",
			stale,
			immutable: Arr.dedupe(Arr.flatMap(fixed, ({ relations }) => relations)),
			origins: Arr.dedupeWith(
				Arr.map(fixed, ({ s }) => s.origin),
				sameWrite
			)
		}
	}
	const cyclic = Arr.filter(stale, (s) => cycle.includes(s.family))
	return Arr.isReadonlyArrayNonEmpty(cyclic)
		? {
				kind: "cycle",
				stale,
				cycle: Arr.sort(Arr.dedupe(Arr.map(cyclic, (s) => s.family)), Order.Number),
				origins: Arr.dedupeWith(
					Arr.map(cyclic, (s) => s.origin),
					sameWrite
				)
			}
		: { kind: "written", stale }
}
