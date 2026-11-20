import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
/**
 * A nested addition split along its relation's families, as binding reads a caller's fact (write/family/nesting.ts):
 * its own fields, and each family's members, to any depth.
 */
import type { ValueFault } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import { isList, isPlainRecord } from "#compiler/core/record.ts"
import type { FamilyId } from "#compiler/ir/law.ts"
import type { ReadFact } from "#compiler/scalar/values/identity.ts"

/**
 * The shape of an addition split along its relation's families: its relation, its slot, and each family's members'
 * shapes in order, to any depth, with no fact: what a nested write lays a fact's rows out by once its levels are read
 * (nesting.ts hostNodes), which is all a decoded row's reading keeps of its split (runtime/write/decoded.ts). A node's
 * slot is its place among the split's nodes, at which the split holds its own fields (`NestedAddition` facts).
 */
export interface NestedShape {
	readonly relation: StoredRelationName
	readonly slot: number
	readonly families: ReadonlyArray<{
		readonly family: FamilyId
		readonly members: ReadonlyArray<NestedShape>
	}>
}

/**
 * An addition split along its relation's families: its shape, and each node's own fields at the node's slot, every field
 * the node's fact states but its families' count fields. The two are apart so a reading keeps the shape and drops the
 * fields once each level is read (nesting.ts nestedReader).
 */
export interface NestedAddition {
	readonly shape: NestedShape
	readonly facts: ReadonlyArray<Readonly<Record<string, unknown>>>
}

/** An addition whose shape breaks at `path`: the count fields and member positions from the addition down. */
export interface ChangeSetRefusal {
	readonly fault: Extract<ValueFault, "factShape">
	readonly path: ReadonlyArray<string | number>
}

/** A fact found while splitting, with where its result goes: its slot, and its families' member slots in order. */
interface Split {
	readonly relation: StoredRelationName
	readonly own: Readonly<Record<string, unknown>>
	readonly families: ReadonlyArray<{
		readonly family: FamilyId
		readonly members: ReadonlyArray<number>
	}>
}

/**
 * A position in an addition: the step from its parent's position, a count field or a member's position, and that
 * parent; the addition itself has none. Each position is one cell over its parent's, so the walk allocates nothing per
 * level of depth, and only a refusal spells its path out (`pathOf`).
 */
interface PathStep {
	readonly parent: PathStep | undefined
	readonly step: string | number
}

/** The count fields and member positions from the addition down to `at`. */
const pathOf = (at: PathStep | undefined): ReadonlyArray<string | number> => {
	const steps: Array<string | number> = []
	for (let p = at; p !== undefined; p = p.parent) {
		steps.push(p.step)
	}
	return steps.toReversed()
}

/** A family an addition splits along: its id, its owner and member relations and its count field, each by name. */
export interface SplitFamily {
	readonly id: FamilyId
	readonly owner: StoredRelationName
	readonly member: StoredRelationName
	readonly count: string
}

/** What splitting a fact of one relation reads off `families`: the families it owns, and their count fields, which
 * hold its members' arrays. */
interface RelationSplit {
	readonly owned: ReadonlyArray<SplitFamily>
	readonly counts: ReadonlySet<string>
}

/** How a fact of `relation` splits along `families`. */
const relationSplit = (
	relation: StoredRelationName,
	families: ReadonlyArray<SplitFamily>
): RelationSplit => {
	const owned = families.filter((f) => f.owner === relation)
	return { owned, counts: new Set(owned.map((f) => f.count)) }
}

/** What reading a caller's fact answers for a fact that could not be read. */
const unshapedFact = (): ChangeSetRefusal["fault"] => "factShape"

/** A caller's fact read once as a plain record, or factShape for anything else, a throwing getter among them. */
const factRecord = (
	value: unknown
): Result.Result<Readonly<Record<string, unknown>>, ChangeSetRefusal["fault"]> =>
	hostRead<Readonly<Record<string, unknown>>, ChangeSetRefusal["fault"]>(unshapedFact, () =>
		isPlainRecord(value) ? Result.ok(Object.freeze({ ...value })) : Result.err("factShape")
	)

/** A splitter of additions along `families` (`additionSplitter`): `relation`'s addition `fact` split, or its refusal. */
export type AdditionSplitter = (
	relation: StoredRelationName,
	fact: unknown
) => Result.Result<NestedAddition, ChangeSetRefusal>

/**
 * The splitter of additions along `families`, each relation's split worked out once, where a fact of it is first split,
 * and read by every later fact (`splitAddition`), so splitting a call's facts costs each relation's split once, whatever
 * the facts' count: a nested write's facts, and a decoded relation's rows (program/decode.ts).
 */
export const additionSplitter = (families: ReadonlyArray<SplitFamily>): AdditionSplitter => {
	const relationSplits = new Map<StoredRelationName, RelationSplit>()
	const splitOf = (name: StoredRelationName): RelationSplit => {
		const known = relationSplits.get(name)
		if (known !== undefined) {
			return known
		}
		const split = relationSplit(name, families)
		relationSplits.set(name, split)
		return split
	}
	return (relation, fact) => splitAddition(splitOf, relation, fact)
}

/**
 * The addition `fact` of `relation` split along the families `splitOf` reads each relation's split off: each family
 * whose owner is the fact's relation holds its members as an array at the owner's count field, each member a fact of the
 * family's member relation, split alike, so a tree's nodes nest to any depth. The walk is iterative, with no limit on
 * the depth, and linear in the facts it reads: each fact is read once and its position is one cell over its owner's.
 * A fact that is no plain record, or a count field that holds no array, is refused as factShape at its path. Each fact
 * keeps every field it states but its count fields, so one it states beyond the fields its caller writes, a field
 * grizzle draws or accumulates among them, reaches its level's normalizer, which admits exactly those and refuses it as
 * factShape, as a deletion's fact stating one is: dropped here, its value would be lost unsaid. Encoding them is the
 * program's, with the installation's codes.
 */
const splitAddition = (
	splitOf: (name: StoredRelationName) => RelationSplit,
	relation: StoredRelationName,
	fact: unknown
): Result.Result<NestedAddition, ChangeSetRefusal> => {
	const splits: Array<Split | undefined> = [undefined]
	const pending: Array<{
		readonly relation: StoredRelationName
		readonly value: unknown
		readonly at: PathStep | undefined
		readonly slot: number
	}> = [{ relation, value: fact, at: undefined, slot: 0 }]
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		const read = factRecord(next.value)
		if (!read.ok) {
			return Result.err({ fault: read.error, path: pathOf(next.at) })
		}
		const { owned, counts } = splitOf(next.relation)
		const own = Object.freeze(
			Object.fromEntries(Object.entries(read.value).filter(([name]) => !counts.has(name)))
		)
		const groups: Array<{ readonly family: FamilyId; readonly members: ReadonlyArray<number> }> = []
		for (const family of owned) {
			const at: PathStep = { parent: next.at, step: family.count }
			const members = read.value[family.count]
			if (!isList(members)) {
				return Result.err({ fault: "factShape", path: pathOf(at) })
			}
			const list: ReadonlyArray<unknown> = members
			const slots = list.map((member, position) => {
				const slot = splits.length
				splits.push(undefined)
				pending.push({
					relation: family.member,
					value: member,
					at: { parent: at, step: position },
					slot
				})
				return slot
			})
			groups.push({ family: family.id, members: slots })
		}
		splits[next.slot] = { relation: next.relation, own, families: groups }
	}
	const built: Array<NestedShape | undefined> = splits.map(() => undefined)
	const facts: Array<Readonly<Record<string, unknown>>> = []
	for (let slot = splits.length - 1; slot >= 0; slot -= 1) {
		const split = defined(splits[slot], "every slot the walk reserved is split")
		facts[slot] = split.own
		built[slot] = Object.freeze({
			relation: split.relation,
			slot,
			families: Object.freeze(
				split.families.map((g) =>
					Object.freeze({
						family: g.family,
						members: Object.freeze(
							g.members.map((m) => defined(built[m], "a member's slot follows its owner's"))
						)
					})
				)
			)
		})
	}
	return Result.ok({ shape: defined(built[0], "the addition's own slot"), facts })
}

/**
 * The levels of a nesting, each an L: its facts' own, and each sequence's members', by the sequence's id, the one its
 * split additions name it by (`additionSplitter`), so no node spells a family's key. An addition another compile split
 * names its families by that compile's ids, whose levels are these re-keyed by them (runtime/write/decoded.ts
 * keptReadings).
 */
export interface NestingLevels<L> {
	readonly own: L
	readonly members: ReadonlyMap<FamilyId, L>
}

/**
 * Every node of the nesting `root` heads, in pre-order, each with the level it stands at in `levels`: the order a nested
 * write reads its levels in, backwards, members before their owners (nesting.ts nestedReader), as a decoded row's are
 * read.
 */
export const levelOrder = <L>(
	levels: NestingLevels<L>,
	root: NestedShape
): ReadonlyArray<{ readonly node: NestedShape; readonly level: L }> => {
	const order: Array<{ readonly node: NestedShape; readonly level: L }> = []
	const pending: Array<{ readonly node: NestedShape; readonly level: L }> = [
		{ node: root, level: levels.own }
	]
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		order.push(next)
		for (const g of next.node.families) {
			const level = defined(levels.members.get(g.family), "a sequence the nesting splits along")
			for (const m of g.members) {
				pending.push({ node: m, level })
			}
		}
	}
	return order
}

/** One level of a nested fact read: the level it stands at, and the read its level's normalizer made of its fact. */
export interface LevelRead<L> {
	readonly level: L
	readonly read: ReadFact
}

/**
 * A nested fact as the write reads it (nesting.ts nestedReader): its addition's shape, split along its sequences, and
 * each of its levels' facts read, in the order they are read, members before their owners: the reverse of levelOrder's
 * pre-order, so the read of the node levelOrder puts at i is at the reading's length − 1 − i. No node's own fields are
 * kept past its read, so a decoded row's kept reading holds its levels' reads and its shape alone.
 */
export interface NestedReading<L> {
	readonly shape: NestedShape
	readonly reads: ReadonlyArray<LevelRead<L>>
}
