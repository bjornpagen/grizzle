/**
 * A nested addition split along its relation's families, as binding reads a caller's fact (write/family/nesting.ts):
 * its own fields, and each family's members, to any depth.
 */
import type { ValueFault } from "#compiler/core/errors.ts"
import { hostRead } from "#compiler/core/host.ts"
import { defined } from "#compiler/core/invariant.ts"
import { isList, isPlainRecord } from "#compiler/core/record.ts"
import * as Result from "#compiler/core/result.ts"
import type { FamilyId } from "#compiler/ir/law.ts"

/** An addition split along its relation's families: its own fields, and each family's member additions in order. */
export interface NestedAddition {
	readonly relation: string
	/** The fact's own fields: every field but its families' count fields and the fields grizzle draws or accumulates. */
	readonly fact: Readonly<Record<string, unknown>>
	readonly families: ReadonlyArray<{
		readonly family: FamilyId
		readonly members: ReadonlyArray<NestedAddition>
	}>
}

/** An addition whose shape breaks at `path`: the count fields and member positions from the addition down. */
export interface ChangeSetRefusal {
	readonly fault: Extract<ValueFault, "factShape">
	readonly path: ReadonlyArray<string | number>
}

/** A fact found while splitting, with where its result goes: its slot, and its families' member slots in order. */
interface Split {
	readonly relation: string
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
	readonly owner: string
	readonly member: string
	readonly count: string
}

/** What splitting a fact of one relation reads off `families`: the families it owns, and their count fields, which
 * hold its members' arrays. */
interface RelationSplit {
	readonly owned: ReadonlyArray<SplitFamily>
	readonly counts: ReadonlySet<string>
}

/** How a fact of `relation` splits along `families`. */
const relationSplit = (relation: string, families: ReadonlyArray<SplitFamily>): RelationSplit => {
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

/**
 * The addition `fact` of `relation` split along `families`: each family whose owner is the fact's relation holds its
 * members as an array at the owner's count field, each member a fact of the family's member relation, split alike, so
 * a tree's nodes nest to any depth. The walk is iterative, with no limit on the depth, and linear in the facts it
 * reads: each fact is read once, its position is one cell over its owner's, and each relation's split is computed once.
 * A fact that is no plain record, or a count field that holds no array, is refused as factShape at its path. Each fact
 * keeps every field it states but its count fields, so one it states beyond the fields its caller writes, a field
 * grizzle draws or accumulates among them, reaches its level's normalizer, which admits exactly those and refuses it as
 * factShape, as a deletion's fact stating one is: dropped here, its value would be lost unsaid. Encoding them is the
 * program's, with the installation's codes.
 */
export const encodeAddition = (
	relation: string,
	fact: unknown,
	families: ReadonlyArray<SplitFamily>
): Result.Result<NestedAddition, ChangeSetRefusal> => {
	const relationSplits = new Map<string, RelationSplit>()
	const splitOf = (name: string): RelationSplit => {
		const known = relationSplits.get(name)
		if (known !== undefined) {
			return known
		}
		const split = relationSplit(name, families)
		relationSplits.set(name, split)
		return split
	}
	const splits: Array<Split | undefined> = [undefined]
	const pending: Array<{
		readonly relation: string
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
	const built: Array<NestedAddition | undefined> = splits.map(() => undefined)
	for (let slot = splits.length - 1; slot >= 0; slot -= 1) {
		const split = defined(splits[slot], "every slot the walk reserved is split")
		built[slot] = Object.freeze({
			relation: split.relation,
			fact: split.own,
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
	return Result.ok(defined(built[0], "the addition's own slot"))
}
