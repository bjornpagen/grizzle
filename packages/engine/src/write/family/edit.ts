/**
 * Rows first (rows-first.md §2): a changeset's rows are data and a family is a law over them, so grizzle owns every
 * value a family draws. Per family, a changeset's rows are grouped by group, the group-key value for a counted family
 * and the owner for a sequence, and every change to a group is one edit: its appends, its removals and its members'
 * updates. Each edit becomes one suffix rewrite of its group:
 *
 * 1. the stored suffix: the group's members from the least slot the edit touches to the end, the member before it
 *    included, and the owner's count, ends and copied columns, read in one batched SELECT per family before any write
 *    (statements.ts suffixReadSql). An owner the same changeset inserts has its key read in that SELECT too: its group
 *    is fresh, an empty family, count 0 and every end at its start, only when no owner is stored at its key; an owner
 *    stored there is the insert's exact repeat, and its members are planned against its stored group;
 * 2. the host fill (`fillGroup`): the new suffix from the stored one and the edit, each slot's index, copies and
 *    accumulators, and the owner's new count and ends;
 * 3. the statements (order.ts): the rows each family's edits delete, update and insert, merged per row across the
 *    relation's families, and each changed owner's count, chunked by the transport.
 *
 * An edit by family kind:
 * - counted: an append at slot count + k; a removal swaps the last member into the freed slot and refills the suffix
 *   from there; an update that changes a step value, a column a step selection reads or a column a copy carries
 *   refills from its slot; an update that changes its group key is a removal from its old group and an append to its
 *   new one; any other update is in place. Every row keeps its slot or moves into a freed one, so its slot changes by
 *   an update;
 * - ordered: the suffix from the least slot the edit touches is deleted and inserted again in its new slots, its
 *   predecessor axis being immediate; appends go at the end; an update that changes no input is in place.
 *
 * Set semantics throughout: a counted family is an unordered set of member rows keyed by the member's key, and its
 * index is a coordinate, never a multiplicity. A member key a family's changes name twice is refused, never a second
 * member.
 */
import { readsOf, withGenerationInputs } from "#compiler/analysis/theory/fill.ts"
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import { admittedParam, carrierSpecOf } from "#compiler/codec/scalar.ts"
import { sameOrder } from "#compiler/core/array.ts"
import { type CompileError, type EncodingFailure, unsupported } from "#compiler/core/errors.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import {
	type ReadonlyTupleMap,
	type ReadonlyTupleSet,
	TupleMap,
	TupleSet
} from "#compiler/core/tuple-map.ts"
import type { ParamText } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { type Family, familyColumnType, isSequence } from "#compiler/ir/family.ts"
import type { LawField, LawRelation, RelationInfo } from "#compiler/ir/law.ts"
import { sqlNull } from "#compiler/scalar/compute/evaluate.ts"
import { admitted, admitValue, compareValues } from "#compiler/scalar/values/identity.ts"
import type { CountRow, MemberKey, Owner, Recount, Row } from "#compiler/write/family/draw.ts"
import {
	baseOf,
	type ColumnKey,
	columnKey,
	combineHost,
	familyKey,
	fieldKey,
	type HostEvaluator,
	literalHost
} from "#compiler/write/family/fold.ts"
import type { OwnerWrite, RelationWrite } from "#compiler/write/family/order.ts"
import { endColumns, type ReadShape, type RowLayout } from "#compiler/write/family/statements.ts"

/** A row's host values by column key: the values a codec admits (scalar/values/identity.ts CarrierHost). */
export type Values = ReadonlyMap<ColumnKey, unknown>

/** A fact of a member relation's slot, as normalization admitted it: its fields' host values by name. */
export type Fact = { readonly [field: string]: unknown }

/**
 * A family-managed relation's changes in one stratum: its facts as its normalized slots hold them, and the rows of it the
 * stratum's nested writes fill (write/family/nesting.ts NestedRow), each with every column the walk filled. A nested
 * row is appended to each counted family it is a member of, whose fill completes it, and inserted whole; the sequences
 * it is a member of are the walk's.
 */
export interface RelationChanges {
	readonly inserts: ReadonlyArray<Fact>
	readonly puts: ReadonlyArray<Fact>
	readonly deletes: ReadonlyArray<Fact>
	readonly nested: ReadonlyArray<Values>
}

/** What one stratum's edits of a member relation read and write, compiled once: its row layout, its families with
 * each one's read shape, and its depth among the families. */
export interface EditTarget {
	readonly relation: RelationInfo
	readonly layout: RowLayout
	/** Each family with its read's shape, and whether its owner is immutable, its family fixed when it is inserted. */
	readonly families: ReadonlyArray<{
		readonly family: Family
		readonly shape: ReadShape
		readonly fixed: boolean
	}>
}

/** Why an immutable owner's family refuses a change, the sentence its static and read-time refusals share. */
const fixedRule = (owner: string): string =>
	`an immutable owner's family is fixed when its owner is inserted; declare mutable(${owner}) to change it`

/**
 * The sentence of a refused write that changes the family `family` of an immutable owner: `head` names the write and
 * its member relation, `effect` the owner it changes when the run time found it, and the rule is `fixedRule`, so a
 * caller meets one sentence whether compile proved the refusal or the run time found the owner.
 */
export const fixedSentence = (head: string, family: Family, effect: string | undefined): string =>
	`${head}, a member of the family ${family.id.owner}.${family.id.count} of the immutable ${family.owner.name}${effect === undefined ? "" : `, ${effect}`}: ${fixedRule(family.owner.name)}`

/** The run time's refusal of a write of `member` that changes an immutable owner's family (`fixedSentence`). */
const fixedRefusal = (member: string, head: string, family: Family, effect: string): CompileError =>
	unsupported(SourceLoc("ChangeSet", [member]), fixedSentence(head, family, effect))

/** A stored member as a read returns it: its key's texts, its slot in the read's family, its group's key texts, and its
 * values. */
export interface StoredMember {
	readonly key: MemberKey
	readonly slot: number
	readonly group: Owner
	readonly values: Values
}

/** A group as a read returns it: its owner's values and count, and its members from the read's first slot on. */
export interface StoredGroup {
	readonly owner: Values
	readonly count: number
	readonly members: ReadonlyArray<StoredMember>
}

/** One family's read, decoded: its stored groups by their key's texts, and its stored members by theirs. */
export interface StoredFamily {
	readonly groups: ReadonlyTupleMap<Owner, StoredGroup>
	readonly members: ReadonlyTupleMap<MemberKey, StoredMember>
}

/** The context the host fills in: the installation's codes and the evaluator of generated fields. */
export interface FillContext {
	readonly codes: Codebook
	readonly evaluate: HostEvaluator
}

/** A type's carrier spec under the installation's codes. */
export const specOf = (ctx: FillContext, type: LawField["type"]) => carrierSpecOf(type, ctx.codes)

/**
 * A host value's parameter text in its type's carrier: a key's, which the read and the delete send and which its
 * relation's rows are a set by, and a row's or a count's, written once at its statement. No text it writes is read
 * back: what PostgreSQL holds comes back through decodeRead, from PostgreSQL's own output.
 */
const textOf = (ctx: FillContext, type: LawField["type"], value: unknown): ParamText =>
	admittedParam(specOf(ctx, type), value)

/** A fact's values by column key. */
const valuesOfFact = (fact: Fact): Map<ColumnKey, unknown> =>
	new Map(Object.entries(fact).map(([name, v]) => [fieldKey(name), v] as const))

/** A row's key texts in its layout. */
export const keyOf = (ctx: FillContext, layout: RowLayout, values: Values): MemberKey =>
	mapNonEmpty(layout.key, (c) => textOf(ctx, c.type, values.get(c.key)))

/** A fact's key texts in its relation's layout. */
export const factKey = (ctx: FillContext, layout: RowLayout, fact: Fact): MemberKey =>
	keyOf(ctx, layout, valuesOfFact(fact))

/** A fact's fields its caller writes, by column key: what a put of it sets of a row already stored. */
export const callerValues = (relation: LawRelation, fact: Fact): Values =>
	callerFields(relation, valuesOfFact(fact))

/**
 * Two reads of one family as one (`StoredFamily`): every member either read returns, each by its key, and every group
 * either reads, its members the ones read of it in slot order.
 */
export const mergeStored = (a: StoredFamily | undefined, b: StoredFamily): StoredFamily => {
	if (a === undefined) {
		return b
	}
	const members = new TupleMap<MemberKey, StoredMember>()
	for (const [key, m] of [...a.members, ...b.members]) {
		members.set(key, m)
	}
	const byGroup = membersByGroup(members.values())
	const groups = new TupleMap<Owner, StoredGroup>()
	for (const [group, g] of [...a.groups, ...b.groups]) {
		groups.set(group, { owner: g.owner, count: g.count, members: byGroup.get(group) ?? [] })
	}
	return { groups, members }
}

/** Stored members by their group's key texts, each group's in slot order. */
export const membersByGroup = (
	members: Iterable<StoredMember>
): ReadonlyTupleMap<Owner, ReadonlyArray<StoredMember>> => {
	const grouped = new TupleMap<Owner, Array<StoredMember>>()
	for (const m of members) {
		const list = grouped.get(m.group) ?? []
		list.push(m)
		grouped.set(m.group, list)
	}
	const out = new TupleMap<Owner, ReadonlyArray<StoredMember>>()
	for (const [group, list] of grouped) {
		out.set(
			group,
			list.toSorted((x, y) => x.slot - y.slot)
		)
	}
	return out
}

/** A row's group key texts in a family. */
export const groupOf = (ctx: FillContext, family: Family, values: Values): Owner =>
	mapNonEmpty(family.group, (g) => textOf(ctx, g.member.type, values.get(fieldKey(g.member.name))))

/**
 * What one family's read reads (statements.ts suffixReadSql): the touched members' keys, each once, and the touched
 * groups' keys, each once, which its placeholders carry as arrays, the keys' first; undefined when the changes name no
 * member of the family.
 */
export interface ReadKeys {
	readonly keys: ReadonlyArray<MemberKey>
	readonly groups: ReadonlyArray<Owner>
}

/**
 * One family's read's keys (`ReadKeys`): every member key the changes name, and every group an insert, a put or, for a
 * counted family, a nested row names. A stored row at an insert's key is its exact repeat, no change, or the key law's
 * refusal; a stored owner at a group's key is a stored group, whatever the changeset inserts there, since an owner the
 * changeset inserts may be the exact repeat of a stored one, its members stored with it. The owners the changeset
 * inserts are read in the same SELECT as every other group, so their keys cost no flight of their own. A sequence reads
 * nothing for a nested row, whose place in it the walk drew.
 */
export const readKeys = (
	ctx: FillContext,
	target: EditTarget,
	family: Family,
	changes: RelationChanges
): ReadKeys | undefined => {
	const nested = isSequence(family) ? [] : changes.nested
	const keys = new TupleSet<MemberKey>()
	for (const values of [
		...[...changes.deletes, ...changes.puts, ...changes.inserts].map(valuesOfFact),
		...nested
	]) {
		keys.add(keyOf(ctx, target.layout, values))
	}
	const groups = new TupleSet<Owner>()
	for (const values of [...[...changes.inserts, ...changes.puts].map(valuesOfFact), ...nested]) {
		groups.add(groupOf(ctx, family, values))
	}
	if (keys.size === 0 && groups.size === 0) {
		return undefined
	}
	return { keys: [...keys], groups: [...groups] }
}

/** An owner fact's group key texts in `family`, its key fields paired with the family's group in order. */
export const ownerGroup = (ctx: FillContext, family: Family, fact: Fact): Owner =>
	groupOfOwner(ctx, family, valuesOfFact(fact))

/** A recount's values as an owner's fields hold them, by field name: its count, and each end's host value. */
export const recountValues = (family: Family, recount: Recount): ReadonlyMap<string, unknown> =>
	new Map<string, unknown>([
		[family.count.name, BigInt(recount.count)],
		...endColumns(family).map((f): readonly [string, unknown] => [f.name, recount.ends.get(f.name)])
	])

/** The owners of `family` among an owner relation's inserted facts, by their group key texts, with their values. */
export const ownersOf = (
	ctx: FillContext,
	family: Family,
	facts: ReadonlyArray<Fact>
): ReadonlyTupleMap<Owner, Values> => {
	const out = new TupleMap<Owner, Values>()
	for (const fact of facts) {
		const values = valuesOfFact(fact)
		out.set(groupOfOwner(ctx, family, values), values)
	}
	return out
}

/** An owner's group key texts, its key fields paired with the family's group in order. */
export const groupOfOwner = (ctx: FillContext, family: Family, values: Values): Owner =>
	mapNonEmpty(family.group, (g) => textOf(ctx, g.owner.type, values.get(fieldKey(g.owner.name))))

/** The fields a family's drawn values read of a member: its step value, its selections' fields, every column its axes
 * carry from a member, and the fields every generated one of those reads, transitively (fill.ts withGenerationInputs).
 * A selection's law columns (a fold's accumulators) are no member field, so no caller's update changes them. */
const inputsOf = (family: Family, relation: LawRelation): ReadonlyArray<LawField> => {
	const named = new Set<string>()
	for (const fold of family.folds) {
		if (fold.step.kind === "value") {
			named.add(fold.step.field.name)
		}
		for (const w of fold.where) {
			for (const name of readsOf(w)) {
				named.add(name)
			}
		}
	}
	for (const pair of [...family.axes.predecessor, ...family.axes.last]) {
		if (pair.to.kind === "field") {
			named.add(pair.to.field.name)
		}
	}
	return withGenerationInputs(
		relation,
		relation.fields.filter((f) => named.has(f.name))
	)
}

/**
 * A value of a row, a generated field's evaluated over the row; undefined where the row holds none, as it holds no
 * generated field that is NULL.
 */
export const valueAt = (
	ctx: FillContext,
	relation: LawRelation,
	values: Values,
	key: ColumnKey
): unknown => {
	if (values.has(key)) {
		return values.get(key)
	}
	const field = relation.fields.find((f) => fieldKey(f.name) === key)
	if (field?.writing.kind !== "generated") {
		return undefined
	}
	const v = ctx.evaluate(relation, field.writing.expr, (name) =>
		valueAt(ctx, relation, values, fieldKey(name))
	)
	return v.ok && v.value !== sqlNull ? v.value : undefined
}

/** Whether two host values of one carrier are one value: equal under PostgreSQL's B-tree order of the type. */
export const same = (ctx: FillContext, type: LawField["type"], a: unknown, b: unknown): boolean => {
	if (a === undefined || b === undefined) {
		return false
	}
	const spec = specOf(ctx, type)
	return compareValues(spec, admitted(spec, a), admitted(spec, b)) === 0
}

/** A member a group's fill writes: its key's texts, the family's columns of it, and the statement that writes it: an
 * insert of a new member, a delete and an insert of a re-placed one, an update in place of any other. */
interface Placement {
	readonly key: MemberKey
	readonly columns: ReadonlyMap<ColumnKey, unknown>
	readonly change: "insert" | "update" | "replace"
}

/**
 * The owners of a family a stratum writes, each by its group key texts, which a member's write reads over its stored row:
 * - `stated`: each owner the stratum states a fact of, an insert's, a put's or a nested write's row, with its values;
 * - `plain`: whether the stratum's own statements write those owners before every family statement, as they write an
 *   owner no family has as a member; a member's owner otherwise is written by its own family's edit, after the members
 *   deeper than it are updated;
 * - `recounted`: each owner's counts and ends the stratum's edits of its other families draw, which its count
 *   statements write before any member is inserted.
 */
export interface OwnerViews {
	readonly stated: ReadonlyTupleMap<Owner, Values>
	readonly plain: boolean
	readonly recounted: ReadonlyTupleMap<Owner, Values>
}

/** The values of a row's fields its caller writes, a caller's and a serial one. */
const callerFields = (relation: LawRelation, row: Values): Values =>
	new Map(
		relation.fields.flatMap((f) =>
			(f.writing.kind === "caller" || f.writing.kind === "serial") && row.has(fieldKey(f.name))
				? [[fieldKey(f.name), row.get(fieldKey(f.name))] as const]
				: []
		)
	)

/**
 * A row's values with `over` written over them: every column `over` holds, and every generated field read again from
 * the result, since PostgreSQL generates it from the row's written fields; the row unchanged when nothing is written.
 */
const overlaid = (
	relation: LawRelation,
	row: Values | undefined,
	over: Values | undefined
): Values | undefined => {
	if (over === undefined) {
		return row
	}
	const generated = new Set(
		relation.fields.flatMap((f) => (f.writing.kind === "generated" ? [fieldKey(f.name)] : []))
	)
	const merged = [...(row ?? new Map<ColumnKey, unknown>()), ...over]
	return new Map(merged.filter(([key]) => !generated.has(key)))
}

/**
 * A group's edit as one family's fill takes it: its owner as a member's update in place reads it (`owner`), and as a
 * member's insert reads it (`final`), the owner as its stratum leaves it; none for an owner neither stored nor written.
 * A refilled group (`refilled`) is one a change of the stratum leaves stale, whose kept members a refill rewrites in
 * place ahead of that change, each with the owner as its stratum leaves it, since the refill draws the family's
 * values again from the values the change gives them (analysis/theory/refill.ts).
 */
interface GroupEdit {
	readonly owner: Values | undefined
	readonly final: Values | undefined
	readonly stored: StoredGroup | undefined
	readonly removals: ReadonlyTupleSet<MemberKey>
	/** Kept members' new values: the stored ones with the put's caller fields over them, or a refreshed member's values
	 * as the stratum's changes leave them. */
	readonly updates: ReadonlyTupleMap<MemberKey, Values>
	/** The kept members whose new values are the stratum's other changes', not the edit's own. */
	readonly refreshed: ReadonlyTupleSet<MemberKey>
	/** The kept members of a counted family the row's sequences re-place, deleting them before the family's count
	 * statement and inserting them after it, which no cascade reaches: each is drawn whole, from the owner as the
	 * stratum leaves it. */
	readonly replaced: ReadonlyTupleSet<MemberKey>
	readonly refilled: boolean
	/** Each new member, with the write that adds it: an insert, or a put of a key no stored row holds or that moves it. */
	readonly appends: ReadonlyArray<{
		readonly key: MemberKey
		readonly values: Values
		readonly by: "insert" | "put"
	}>
}

/**
 * Why a group's family is fixed, an immutable owner's: its owner is stored, so its family is as that owner's insert
 * left it; or nothing stores or inserts its owner, so no family of it can be written.
 */
interface FixedGroup {
	readonly owner: Owner
	readonly standing: "stored" | "absent"
}

/** What a group's fill writes: its placements, and its owner's new values when its count or ends change. */
interface GroupFilled {
	readonly placed: ReadonlyArray<Placement>
	readonly recount: Values | undefined
}

/**
 * One group's fill (rows-first.md §2): its members' final slots, then from the least slot the edit touches every
 * member's index, copies and accumulators in slot order, each from its predecessor, its owner and the step, and the
 * owner's count and ends from its last member. A counted removal moves the last kept members into the slots removals
 * free below the new count, and every other member keeps its slot; a sequence's members keep their order, and from the
 * least slot the edit's own changes touch on every one is re-placed, since its predecessor axis is immediate. A refreshed
 * member below that slot keeps its slot and is rewritten in place, under its family's deferred predecessor axis.
 */
const fillGroup = (
	ctx: FillContext,
	relation: LawRelation,
	family: Family,
	edit: GroupEdit,
	fixed: FixedGroup | undefined
): Result.Result<GroupFilled, EncodingFailure | CompileError> => {
	const failure = encodeFailure("integerRange", slotPlace(relation.name))
	const n0 = edit.stored?.count ?? 0
	const stored = edit.stored?.members ?? []
	const bySlot = new Map(stored.map((m) => [m.slot, m] as const))
	const byKey = new TupleMap<MemberKey, StoredMember>()
	for (const m of stored) {
		byKey.set(m.key, m)
	}
	const inputs = inputsOf(family, relation).filter((field) => field.writing.kind !== "generated")
	const changesInput = (before: Values, after: Values): boolean =>
		inputs.some(
			(field) =>
				!same(ctx, field.type, before.get(fieldKey(field.name)), after.get(fieldKey(field.name)))
		)
	const removedSlots = stored.filter((m) => edit.removals.has(m.key)).map((m) => m.slot)
	if (fixed !== undefined) {
		/** A fixed group of an immutable owner takes no append, no removal and no change of what its family values read:
		 * every one would change a value fixed when the owner was inserted. An update of anything else is in place. */
		const at = `the owner ${family.owner.name} with key (${fixed.owner.join(", ")}), ${fixed.standing === "stored" ? "which is already stored" : "which this stratum does not insert"}`
		const changed = [...edit.updates].some(([key, values]) => {
			const m = byKey.get(key)
			return m !== undefined && changesInput(m.values, values)
		})
		const [append] = edit.appends
		const refusal =
			append !== undefined
				? {
						head:
							append.by === "insert"
								? `an insert into ${relation.name}`
								: `a put of ${relation.name}`,
						effect: `appending to ${at}`
					}
				: removedSlots.length > 0
					? { head: `a put of ${relation.name}`, effect: `moving a member out of ${at}` }
					: changed
						? {
								head: `a put of ${relation.name}`,
								effect: `changing a value its family reads of a member of ${at}`
							}
						: undefined
		if (refusal !== undefined) {
			return Result.err(fixedRefusal(relation.name, refusal.head, family, refusal.effect))
		}
	}
	const kept = n0 - removedSlots.length
	const n1 = kept + edit.appends.length
	const counted = !isSequence(family)
	const owner = edit.owner
	const ownerCopies = family.axes.owner.filter(
		(pair) =>
			(pair.from.kind === "field" ? pair.from.field.writing.kind === "accumulated" : true) &&
			!(pair.from.kind === "law" && pair.from.column === family.copy)
	)
	/** A refilled group whose owner's copied columns or count change is refilled from its first member, each member's
	 * copy of them drawn again: a refill draws the rows of an owner the stratum deletes and inserts again, which no
	 * cascade follows. */
	const ownerChanged =
		edit.refilled &&
		ownerCopies.some((pair) => {
			const type = pair.to.kind === "field" ? pair.to.field.type : familyColumnType(family, pair.to)
			const was = edit.stored?.owner
			return (
				type !== undefined &&
				was !== undefined &&
				edit.final !== undefined &&
				!same(
					ctx,
					type,
					valueAt(ctx, family.owner, was, columnKey(pair.to)),
					valueAt(ctx, family.owner, edit.final, columnKey(pair.to))
				)
			)
		})
	let s = ownerChanged || (edit.refilled && n1 !== n0) ? 0 : n1
	/** The least slot the edit's own changes touch, from which a sequence's members are re-placed. */
	let own = n1
	for (const [key, values] of edit.updates) {
		const m = byKey.get(key)
		if (m !== undefined && changesInput(m.values, values)) {
			s = Math.min(s, m.slot)
			if (!edit.refreshed.has(key)) {
				own = Math.min(own, m.slot)
			}
		}
	}
	for (const m of stored) {
		if (edit.replaced.has(m.key) && !edit.removals.has(m.key)) {
			s = Math.min(s, m.slot)
		}
	}
	if (edit.appends.length > 0) {
		s = Math.min(s, kept)
		own = Math.min(own, kept)
	}
	/** Each final slot's member from `s` on, where it differs from the stored slot's: moved, or appended. */
	const at = new Map<
		number,
		{ readonly key: MemberKey; readonly values: Values; readonly from: "moved" | "new" }
	>()
	if (counted) {
		const freed = removedSlots.filter((slot) => slot < kept).toSorted((a, b) => a - b)
		const movers = stored
			.filter((m) => m.slot >= kept && !edit.removals.has(m.key))
			.toSorted((a, b) => b.slot - a.slot)
		for (const [i, slot] of freed.entries()) {
			const mover = defined(
				movers[i],
				"a kept member above the new count for each slot freed below it"
			)
			s = Math.min(s, slot)
			own = Math.min(own, slot)
			at.set(slot, {
				key: mover.key,
				values: edit.updates.get(mover.key) ?? mover.values,
				from: "moved"
			})
		}
	} else {
		for (const slot of removedSlots) {
			s = Math.min(s, slot)
			own = Math.min(own, slot)
		}
		const remaining = stored
			.filter((m) => m.slot >= s && !edit.removals.has(m.key))
			.toSorted((a, b) => a.slot - b.slot)
		for (const [i, m] of remaining.entries()) {
			at.set(s + i, { key: m.key, values: edit.updates.get(m.key) ?? m.values, from: "moved" })
		}
	}
	for (const [i, a] of edit.appends.entries()) {
		at.set(kept + i, { key: a.key, values: a.values, from: "new" })
	}
	/** The member at a final slot: placed, or stored there and kept, with its update's values over it. */
	const memberAt = (
		slot: number
	): { readonly key: MemberKey; readonly values: Values } | undefined => {
		const placed = at.get(slot)
		if (placed !== undefined) {
			return placed
		}
		const m = bySlot.get(slot)
		return m === undefined ? undefined : { key: m.key, values: edit.updates.get(m.key) ?? m.values }
	}
	if (edit.final === undefined && ownerCopies.length > 0 && n1 > 0) {
		return Result.err(encodeFailure("factShape", slotPlace(relation.name)))
	}
	const placed: Array<Placement> = []
	const filled = new Map<number, Values>()
	for (let slot = s; slot < n1; slot += 1) {
		const member = memberAt(slot)
		if (member === undefined) {
			throw defect(`the member at slot ${slot} a group's fill places`)
		}
		const values = new Map(member.values)
		const drawn = new Map<ColumnKey, unknown>()
		const put = (key: ColumnKey, v: unknown): void => {
			values.set(key, v)
			drawn.set(key, v)
		}
		put(columnKey(family.index), BigInt(slot))
		put(`law:${family.copy}`, BigInt(n1))
		const prev = slot === 0 ? undefined : (filled.get(slot - 1) ?? memberAt(slot - 1)?.values)
		/** A counted member kept or moved is updated in place, before its owner's own write and its count statement, which
		 * the owner axis cascades into it; every other member is inserted after them, and every member of a refilled group
		 * is rewritten ahead of its owner's change, so each reads the owner as the stratum leaves it. */
		const seen =
			counted && !edit.refilled && at.get(slot)?.from !== "new" && !edit.replaced.has(member.key)
				? owner
				: edit.final
		for (const pair of ownerCopies) {
			put(
				columnKey(pair.from),
				seen === undefined ? undefined : valueAt(ctx, family.owner, seen, columnKey(pair.to))
			)
		}
		for (const pair of family.axes.predecessor) {
			if (pair.from.kind === "field" && pair.from.field.writing.kind !== "accumulated") {
				continue
			}
			const type = familyColumnType(family, pair.from)
			if (type === undefined) {
				continue
			}
			if (prev === undefined) {
				const base = baseOf(family, pair.from, specOf(ctx, type))
				if (base.kind === "base") {
					put(columnKey(pair.from), base.value)
				}
				continue
			}
			put(columnKey(pair.from), valueAt(ctx, relation, prev, columnKey(pair.to)))
		}
		for (const fold of family.folds) {
			const befores = fold.planes.map((p) => values.get(columnKey(p.before)))
			let selected = true
			for (const w of fold.where) {
				const holds = ctx.evaluate(relation, w, (name) =>
					valueAt(ctx, relation, values, fieldKey(name))
				)
				if (!holds.ok) {
					return Result.err(failure)
				}
				selected = selected && holds.value === true
			}
			const x =
				fold.step.kind === "value"
					? valueAt(ctx, relation, values, fieldKey(fold.step.field.name))
					: undefined
			for (const [p, plane] of fold.planes.entries()) {
				const spec = specOf(ctx, familyColumnType(family, plane.after) ?? plane.end.type)
				const after = selected ? combineHost(fold, p === 0 ? 0 : 1, befores, x, spec) : befores[p]
				const value = after === undefined ? undefined : admitValue(spec, after)
				if (value === undefined || !value.ok) {
					return Result.err(failure)
				}
				put(columnKey(plane.after), value.value)
			}
		}
		filled.set(slot, values)
		const from = at.get(slot)?.from ?? "kept"
		const storedHere = bySlot.get(slot)
		const unchanged =
			from === "kept" &&
			storedHere !== undefined &&
			!edit.updates.has(member.key) &&
			[...drawn].every(([key, v]) =>
				same(ctx, typeOfKey(relation, family, key), storedHere.values.get(key), v)
			)
		if (counted && unchanged && !edit.replaced.has(member.key)) {
			continue
		}
		placed.push({
			key: member.key,
			columns: drawn,
			change: from === "new" ? "insert" : counted || slot < own ? "update" : "replace"
		})
	}
	for (const key of edit.updates.keys()) {
		const m = byKey.get(key)
		if (m !== undefined && m.slot < s && !edit.refreshed.has(key)) {
			placed.push({ key, columns: new Map(), change: "update" })
		}
	}
	const last = n1 === 0 ? undefined : (filled.get(n1 - 1) ?? memberAt(n1 - 1)?.values)
	const ownerAfter = new Map(owner ?? [])
	ownerAfter.set(fieldKey(family.count.name), BigInt(n1))
	for (const pair of family.axes.last) {
		if (pair.from.kind !== "field" || pair.from.field.writing.kind !== "accumulated") {
			continue
		}
		const base = baseOf(family, pair.from, specOf(ctx, pair.from.field.type))
		ownerAfter.set(
			columnKey(pair.from),
			last === undefined
				? base.kind === "base"
					? base.value
					: undefined
				: valueAt(ctx, relation, last, columnKey(pair.to))
		)
	}
	const changes =
		n1 !== n0 ||
		endColumns(family).some(
			(f) => !same(ctx, f.type, owner?.get(fieldKey(f.name)), ownerAfter.get(fieldKey(f.name)))
		)
	return Result.ok({ placed, recount: changes ? ownerAfter : undefined })
}

/** The type of a column key of a member of `family`: a field's, or one of the family's drawn law columns'. */
const typeOfKey = (relation: LawRelation, family: Family, key: ColumnKey): LawField["type"] => {
	const field = relation.fields.find((f) => fieldKey(f.name) === key)
	if (field !== undefined) {
		return field.type
	}
	const columns = [
		family.index,
		{ kind: "law" as const, column: family.copy },
		...family.folds.flatMap((f) => f.planes.flatMap((p) => [p.before, p.after]))
	]
	const column = columns.find((c) => columnKey(c) === key)
	const type = column === undefined ? undefined : familyColumnType(family, column)
	if (type === undefined) {
		throw defect(`a column ${key} of ${relation.name} its family draws`)
	}
	return type
}

/**
 * The host value a new row holds a field at when nothing fills it (rows-first.md §1): a drawn field, which beside a
 * member's own family values is its own counted family's count, at 0, and an accumulated one, its own family's end, at
 * its start, so a member that owns a family is inserted with that family empty; none for any other field.
 */
const startHost = (ctx: FillContext, field: LawField): unknown => {
	switch (field.writing.kind) {
		case "drawn":
			return 0n
		case "accumulated":
			return literalHost(specOf(ctx, field.type), field.writing.start)
		case "caller":
		case "serial":
		case "generated":
			return undefined
	}
}

/** A member relation's row as its families' fill leaves it: its key's texts, and each column's host value. */
export interface FilledRow {
	readonly key: MemberKey
	readonly values: Values
}

/**
 * A member relation's rows of one stratum as its families' fill leaves them, each kind a set by its key's texts: those
 * deleted by key, its kept rows a refill rewrites in place, its other kept rows updated in place, and its new and
 * re-placed rows inserted, each with its columns' host values. Its texts are written once, at its statements
 * (`encodedWrite`).
 */
export interface FilledWrite {
	readonly relation: string
	readonly deletes: ReadonlyTupleSet<MemberKey>
	readonly refills: ReadonlyTupleMap<MemberKey, FilledRow>
	readonly updates: ReadonlyTupleMap<MemberKey, FilledRow>
	readonly inserts: ReadonlyTupleMap<MemberKey, FilledRow>
}

/** What one stratum's edits of a member relation write: its rows, and each family's changed owners. */
export interface Edited {
	readonly rows: FilledWrite
	readonly owners: ReadonlyArray<OwnerWrite>
}

/** A filled write in its rows' texts, each column's host value written by its type's codec, as its statements carry it. */
export const encodedWrite = (
	ctx: FillContext,
	layout: RowLayout,
	write: FilledWrite
): RelationWrite => {
	const encoded = (
		rows: ReadonlyTupleMap<MemberKey, FilledRow>
	): ReadonlyTupleMap<MemberKey, Row> => {
		const out = new TupleMap<MemberKey, Row>()
		for (const [key, row] of rows) {
			out.set(key, {
				key: row.key,
				columns: layout.columns.map((c) => textOf(ctx, c.type, row.values.get(c.key)))
			})
		}
		return out
	}
	return {
		relation: write.relation,
		deletes: write.deletes,
		refills: encoded(write.refills),
		updates: encoded(write.updates),
		inserts: encoded(write.inserts)
	}
}

/** A family's recounts as its count statement's rows: each owner's key, then its count and its ends, written. */
export const countRows = (
	ctx: FillContext,
	family: Family,
	recounts: Iterable<Recount>
): ReadonlyArray<CountRow> =>
	[...recounts].map((r) => ({
		owner: r.owner,
		drawn: [
			textOf(ctx, family.count.type, BigInt(r.count)),
			...endColumns(family).map((f) => textOf(ctx, f.type, r.ends.get(f.name)))
		]
	}))

/**
 * The stratum's other changes to a relation's stored rows, which its refilled families are drawn again from
 * (analysis/theory/refill.ts): each row's values as the stratum leaves them, by its key's texts, and whether a family
 * is refilled.
 */
export interface RefillView {
	readonly current: ReadonlyTupleMap<MemberKey, Values>
	readonly refilled: (family: Family) => boolean
}

/** Whether two rows of `relation` hold another value at some column one of them holds. */
const differs = (ctx: FillContext, relation: LawRelation, a: Values, b: Values): boolean =>
	[...a.keys()].some((key) => {
		const field = relation.fields.find((f) => fieldKey(f.name) === key)
		return field !== undefined && b.has(key) && !same(ctx, field.type, a.get(key), b.get(key))
	})

/**
 * A member relation's changes in one stratum planned against its families' reads: each family's touched groups
 * resolved into edits and filled, the placements merged per row (a row deleted, inserted whole, re-placed whole,
 * refilled or updated in place, its every family's columns as filled or as stored), and each changed owner's count and
 * ends. `owners` gives each family's owners the stratum writes (`OwnerViews`); `refresh` the rows the stratum's other
 * changes leave changed, whose refilled families' groups are filled again from them, their kept members rewritten in
 * place by the relation's refill with every value as the stratum leaves it.
 */
export const planEdits = (
	ctx: FillContext,
	target: EditTarget,
	changes: RelationChanges,
	stored: ReadonlyMap<string, StoredFamily>,
	owners: (family: Family) => OwnerViews,
	refresh: RefillView
): Result.Result<Edited, EncodingFailure | CompileError> => {
	const relation = target.relation
	/** Each row the changes name, once: a key named twice is refused, never a second member. */
	const named = new TupleMap<
		MemberKey,
		{ readonly op: "insert" | "put" | "delete" | "nested"; readonly values: Values }
	>()
	for (const [op, rows] of [
		["insert", changes.inserts.map(valuesOfFact)],
		["put", changes.puts.map(valuesOfFact)],
		["delete", changes.deletes.map(valuesOfFact)],
		["nested", changes.nested]
	] as const) {
		for (const values of rows) {
			const key = keyOf(ctx, target.layout, values)
			if (named.has(key)) {
				return Result.err(encodeFailure("factShape", slotPlace(relation.name)))
			}
			named.set(key, { op, values })
		}
	}
	/** Every stored row any family's read returned, by its key's texts, with every column it holds. */
	const storedRows = new TupleMap<MemberKey, Values>()
	for (const read of stored.values()) {
		for (const m of read.members.values()) {
			storedRows.set(m.key, m.values)
		}
	}
	/** An insert of a row the stored state holds already, every field its fact carries equal, is that row: no change
	 * and no statement (rule 0). A stored row at its key with another fact stays an append, which the key law refuses
	 * at the insert. */
	const repeats = [...named].flatMap(([key, { op, values }]) => {
		const was = storedRows.get(key)
		return op === "insert" &&
			was !== undefined &&
			[...values].every(([k, v]) => {
				const field = target.relation.fields.find((f) => fieldKey(f.name) === k)
				return field !== undefined && same(ctx, field.type, v, was.get(k))
			})
			? [key]
			: []
	})
	for (const key of repeats) {
		named.delete(key)
	}
	const placements = new TupleMap<MemberKey, Array<Placement>>()
	/** The kept rows a refilled group's fill rewrites, which the relation's refill writes. */
	const refilledRows = new TupleSet<MemberKey>()
	const writes: Array<OwnerWrite> = []
	/** A row's values as the stratum leaves them before the edit's own changes: its refreshed ones, else its stored. */
	const currentOf = (key: MemberKey, was: Values): Values => refresh.current.get(key) ?? was
	/**
	 * A named row's values as `family`'s fill reads them: `values`, the edit's over the row as the stratum leaves it, and,
	 * for a counted family, every column the row's sequences placed on it, which their fills, run first, drew: a counted
	 * fold may step or select a sequence's copy of its owner's column (analysis/theory/fill.ts), and a put that moves
	 * the row to another of that sequence's owners re-places it with the new owner's.
	 */
	const viewOf = (family: Family, key: MemberKey, values: Values): Values => {
		const placed = isSequence(family) ? [] : (placements.get(key) ?? [])
		return placed.length === 0
			? values
			: new Map([...values, ...placed.flatMap((p) => [...p.columns])])
	}
	/** The target's families, its sequences first, so each counted family's fill reads what they drew. */
	const sequencesFirst = target.families.toSorted(
		(a, b) => Number(!isSequence(a.family)) - Number(!isSequence(b.family))
	)
	for (const { family, fixed } of sequencesFirst) {
		const read = stored.get(familyKey(family.id))
		const views = owners(family)
		/** The rows the target's sequences re-place, which their fills, run first, placed: a counted family's fill draws
		 * each that its groups hold whole. */
		const replaced = new TupleSet<MemberKey>()
		if (!isSequence(family)) {
			for (const [key, list] of placements) {
				if (list.some((p) => p.change === "replace")) {
					replaced.add(key)
				}
			}
		}
		const groups = new TupleMap<
			Owner,
			{
				readonly owner: Owner
				readonly edit: {
					readonly owner: Values | undefined
					readonly final: Values | undefined
					readonly stored: StoredGroup | undefined
					readonly removals: TupleSet<MemberKey>
					readonly updates: TupleMap<MemberKey, Values>
					readonly refreshed: TupleSet<MemberKey>
					readonly replaced: ReadonlyTupleSet<MemberKey>
					refilled: boolean
					readonly appends: Array<GroupEdit["appends"][number]>
				}
			}
		>()
		const groupEdit = (owner: Owner) => {
			const known = groups.get(owner)
			if (known !== undefined) {
				return known.edit
			}
			const s = read?.groups.get(owner)
			const stated = views.stated.get(owner)
			/** A stored owner's write sets its caller's fields alone: its counts and ends are its families' to draw. */
			const written = stated === undefined ? undefined : callerFields(family.owner, stated)
			const edit = {
				owner:
					s === undefined
						? stated
						: overlaid(family.owner, s.owner, views.plain ? written : undefined),
				final:
					s === undefined
						? overlaid(family.owner, stated, views.recounted.get(owner))
						: overlaid(
								family.owner,
								overlaid(family.owner, s.owner, written),
								views.recounted.get(owner)
							),
				stored: s,
				removals: new TupleSet<MemberKey>(),
				updates: new TupleMap<MemberKey, Values>(),
				refreshed: new TupleSet<MemberKey>(),
				replaced,
				refilled: false,
				appends: new Array<GroupEdit["appends"][number]>()
			}
			groups.set(owner, { owner, edit })
			return edit
		}
		const storedGroupOf = (m: StoredMember): Owner => groupOf(ctx, family, m.values)
		for (const [key, { op, values }] of named) {
			const was = read?.members.get(key)
			switch (op) {
				case "delete":
					if (was !== undefined) {
						groupEdit(storedGroupOf(was)).removals.add(key)
					}
					break
				case "insert":
					groupEdit(groupOf(ctx, family, values)).appends.push({
						key,
						values: viewOf(family, key, values),
						by: "insert"
					})
					break
				case "nested":
					if (!isSequence(family)) {
						groupEdit(groupOf(ctx, family, values)).appends.push({ key, values, by: "insert" })
					}
					break
				case "put": {
					const group = groupOf(ctx, family, values)
					if (was === undefined) {
						groupEdit(group).appends.push({ key, values: viewOf(family, key, values), by: "put" })
						break
					}
					const merged = viewOf(family, key, new Map([...currentOf(key, was.values), ...values]))
					if (sameOrder(was.group, group)) {
						groupEdit(group).updates.set(key, merged)
					} else {
						groupEdit(storedGroupOf(was)).removals.add(key)
						groupEdit(group).appends.push({ key, values: merged, by: "put" })
					}
					break
				}
			}
		}
		if (refresh.refilled(family)) {
			for (const m of read?.members.values() ?? []) {
				const now = refresh.current.get(m.key)
				if (now === undefined || named.has(m.key) || !differs(ctx, relation, m.values, now)) {
					continue
				}
				const edit = groupEdit(storedGroupOf(m))
				edit.updates.set(m.key, now)
				edit.refreshed.add(m.key)
				edit.refilled = true
			}
		}
		for (const m of read?.members.values() ?? []) {
			if (replaced.has(m.key) && !named.has(m.key)) {
				const edit = groupEdit(storedGroupOf(m))
				if (!edit.updates.has(m.key)) {
					edit.updates.set(m.key, viewOf(family, m.key, currentOf(m.key, m.values)))
				}
			}
		}
		const recounts = new TupleMap<Owner, Recount>()
		const storedGroups = new TupleSet<Owner>()
		for (const { owner, edit } of groups.values()) {
			/** A group is fresh when the stratum inserts its owner and the read found none stored at its key. Any other group
			 * of an immutable owner is fixed: stored, whether or not the changeset inserts its owner again, since an owner
			 * insert at a stored key is its exact repeat or the key law's refusal; or absent, its owner neither stored nor
			 * inserted. */
			const storedGroup = edit.stored !== undefined
			const fresh = views.stated.has(owner) && !storedGroup
			const filled = fillGroup(
				ctx,
				relation,
				family,
				edit,
				fixed && !fresh ? { owner, standing: storedGroup ? "stored" : "absent" } : undefined
			)
			if (!filled.ok) {
				return filled
			}
			for (const placement of filled.value.placed) {
				const list = placements.get(placement.key) ?? []
				const moved = placement.change === "insert" && storedRows.has(placement.key)
				list.push(moved ? { ...placement, change: "replace" } : placement)
				placements.set(placement.key, list)
				if (edit.refilled && placement.change === "update") {
					refilledRows.add(placement.key)
				}
			}
			const after = filled.value.recount
			if (after !== undefined) {
				recounts.set(owner, {
					owner,
					count: edit.appends.length + (edit.stored?.count ?? 0) - edit.removals.size,
					ends: new Map(
						endColumns(family).map((f) => [f.name, after.get(fieldKey(f.name))] as const)
					)
				})
				if (storedGroup) {
					storedGroups.add(owner)
				}
			}
		}
		if (recounts.size > 0) {
			writes.push({ family: family.id, recounts, stored: storedGroups })
		}
	}
	const deletes = new TupleSet<MemberKey>()
	const refills = new TupleMap<MemberKey, FilledRow>()
	const updates = new TupleMap<MemberKey, FilledRow>()
	const inserts = new TupleMap<MemberKey, FilledRow>()
	const written = new TupleSet<MemberKey>()
	for (const key of [...named.keys(), ...placements.keys()]) {
		written.add(key)
	}
	for (const key of written) {
		const op = named.get(key)
		if (op?.op === "delete") {
			if (storedRows.has(key)) {
				deletes.add(key)
			}
			continue
		}
		const was = storedRows.get(key)
		const merged = new Map([
			...(was === undefined ? [] : currentOf(key, was)),
			...(op?.values ?? [])
		])
		const list = placements.get(key) ?? []
		for (const placement of list) {
			for (const [k, v] of placement.columns) {
				merged.set(k, v)
			}
		}
		/** An insert at a stored key that is no exact repeat stays an insert beside the stored row, which its key law then
		 * refuses at the statement: never a silent replacement of the stored row. A nested row is always inserted, as its
		 * nesting's other rows are. */
		const inserted = !storedRows.has(key) || op?.op === "insert" || op?.op === "nested"
		if (inserted) {
			for (const c of target.layout.columns) {
				const start = c.column.kind === "field" ? startHost(ctx, c.column.field) : undefined
				if (start !== undefined && !merged.has(c.key)) {
					merged.set(c.key, start)
				}
			}
			inserts.set(key, { key, values: merged })
		} else if (list.some((p) => p.change === "replace")) {
			deletes.add(key)
			inserts.set(key, { key, values: merged })
		} else if (refilledRows.has(key)) {
			refills.set(key, { key, values: merged })
		} else {
			updates.set(key, { key, values: merged })
		}
	}
	return Result.ok({
		rows: { relation: relation.name, deletes, refills, updates, inserts },
		owners: writes
	})
}

/** One member relation's edits in a stratum, planned (`planEdits`), with the target they were planned for. */
export interface EditedTarget {
	readonly target: EditTarget
	readonly edited: Edited
}

/**
 * A stratum's planned edits with every count of an owner the same stratum inserts as an edited member carried by that
 * owner's own inserted row instead of a count statement: a relation that is both a counted member and an owner is
 * inserted with its families empty (`startHost`), and its members appended in the same stratum count it. The count
 * statements run before the inserts (order.ts Plan), so a count of an owner not yet inserted would update no row; the
 * row carries its count and its ends from the start, which its members' copies then reference.
 */
export const foldRecounts = (planned: ReadonlyArray<EditedTarget>): ReadonlyArray<Edited> => {
	/** Each edited relation's inserted rows, by their key's texts, which a recount of its own families may replace. */
	const insertedRows = new Map(
		planned.map((p) => {
			const rows = new TupleMap<MemberKey, FilledRow>()
			for (const [key, row] of p.edited.rows.inserts) {
				rows.set(key, row)
			}
			return [p.target.relation.name, rows] as const
		})
	)
	const layoutOf = new Map(planned.map((p) => [p.target.relation.name, p.target.layout] as const))
	const owners = planned.map((p) =>
		p.edited.owners.flatMap((write): ReadonlyArray<OwnerWrite> => {
			const family = defined(
				p.target.families.find((f) => familyKey(f.family.id) === familyKey(write.family)),
				"a family of the edited relation"
			).family
			const rows = insertedRows.get(family.owner.name)
			const layout = layoutOf.get(family.owner.name)
			if (rows === undefined || layout === undefined) {
				return [write]
			}
			const kept = new TupleMap<Owner, Recount>()
			for (const [group, recount] of write.recounts) {
				/** The owner's key texts in its layout's key order, which its group pairs with in the family's order. */
				const key = mapNonEmpty(layout.key, (c) => {
					const at = family.group.findIndex((g) => fieldKey(g.owner.name) === c.key)
					return defined(recount.owner[at], `the owner's key field ${c.key} in its group`)
				})
				const row = rows.get(key)
				if (row === undefined || write.stored.has(group)) {
					kept.set(group, recount)
					continue
				}
				const values = new Map(row.values)
				for (const [name, value] of recountValues(family, recount)) {
					values.set(fieldKey(name), value)
				}
				rows.set(key, { key: row.key, values })
			}
			return kept.size > 0 ? [{ family: write.family, recounts: kept, stored: write.stored }] : []
		})
	)
	return planned.map((p, i) => ({
		rows: {
			...p.edited.rows,
			inserts: defined(insertedRows.get(p.target.relation.name), "an edited relation's inserts")
		},
		owners: defined(owners[i], "an edited relation's owners")
	}))
}

/**
 * A tree's every value drawn again from its nodes as the stratum leaves them (analysis/theory/refill.ts): each node's
 * copies of its parent's columns, a root's of its own, each group of siblings' predecessor copies and accumulators, and
 * each parent's ends, parents before their children, as the nesting draws them on insert; no node moves, so every slot,
 * count and interval stays. `stored` and `current` are the trees' every node, by its key's texts, as stored and as the
 * stratum leaves them; the result is every node with every value drawn again.
 */
export const refillTree = (
	ctx: FillContext,
	family: Family,
	stored: ReadonlyTupleMap<MemberKey, Values>,
	current: ReadonlyTupleMap<MemberKey, Values>
): Result.Result<ReadonlyTupleMap<MemberKey, Values>, EncodingFailure | CompileError> => {
	const tree = family.members
	if (tree.kind !== "tree") {
		return Result.ok(current)
	}
	const relation = family.member
	const now = new TupleMap<MemberKey, Map<ColumnKey, unknown>>()
	for (const [key, values] of current) {
		now.set(key, new Map(values))
	}
	/** A node as an owner: its own key, paired with the tree's group in order. */
	const ownGroup = (values: Values): Owner => groupOfOwner(ctx, family, values)
	/** A node as a member: its parent's key, its group. */
	const parentGroup = (values: Values): Owner => groupOf(ctx, family, values)
	const startOf = (values: Values): bigint => {
		const start = values.get(fieldKey(tree.start.name))
		return typeof start === "bigint" ? start : 0n
	}
	const ownerCopies = family.axes.owner.filter(
		(pair) =>
			(pair.from.kind === "field" ? pair.from.field.writing.kind === "accumulated" : true) &&
			!(pair.from.kind === "law" && pair.from.column === family.copy)
	)
	const children = new TupleMap<Owner, Array<MemberKey>>()
	for (const [key, values] of stored) {
		const parent = parentGroup(values)
		if (sameOrder(parent, ownGroup(values))) {
			continue
		}
		const list = children.get(parent) ?? []
		list.push(key)
		children.set(parent, list)
	}
	const preOrder = [...stored].toSorted(([, a], [, b]) => {
		const x = startOf(a)
		const y = startOf(b)
		return x < y ? -1 : x > y ? 1 : 0
	})
	for (const [key, was] of preOrder) {
		const node = defined(now.get(key), "a tree's node as the stratum leaves it")
		if (sameOrder(parentGroup(was), ownGroup(was))) {
			for (const pair of ownerCopies) {
				node.set(columnKey(pair.from), valueAt(ctx, relation, node, columnKey(pair.to)))
			}
		}
		const kids = children.get(ownGroup(was)) ?? []
		if (kids.length === 0) {
			continue
		}
		const members = kids.map((kid): StoredMember => {
			const values = defined(stored.get(kid), "a stored node")
			const slot = values.get(columnKey(family.index))
			return {
				key: kid,
				slot: typeof slot === "bigint" ? Number(slot) : -1,
				group: ownGroup(was),
				values
			}
		})
		const changedNodes = new TupleMap<MemberKey, Values>()
		const changedKeys = new TupleSet<MemberKey>()
		for (const m of members) {
			const values = now.get(m.key)
			if (values !== undefined && differs(ctx, relation, m.values, values)) {
				changedNodes.set(m.key, values)
				changedKeys.add(m.key)
			}
		}
		const filled = fillGroup(
			ctx,
			relation,
			family,
			{
				owner: node,
				final: node,
				stored: {
					owner: was,
					count: members.length,
					members: members.toSorted((a, b) => a.slot - b.slot)
				},
				removals: new TupleSet<MemberKey>(),
				updates: changedNodes,
				refreshed: changedKeys,
				replaced: new TupleSet<MemberKey>(),
				refilled: true,
				appends: []
			},
			undefined
		)
		if (!filled.ok) {
			return filled
		}
		for (const placement of filled.value.placed) {
			const values = defined(now.get(placement.key), "a placed node")
			for (const [k, v] of placement.columns) {
				values.set(k, v)
			}
		}
		const ends = filled.value.recount
		if (ends !== undefined) {
			for (const f of endColumns(family)) {
				node.set(fieldKey(f.name), ends.get(fieldKey(f.name)))
			}
		}
	}
	return Result.ok(now)
}
