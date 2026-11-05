/**
 * Rows first (rows-first.md §2): a changeset's rows are data and a family is a law over them, so grizzle owns every
 * value a family draws. Per family, a changeset's rows are grouped by group, the group-key value for a counted family
 * and the owner for a sequence, and every change to a group is one edit: its appends, its removals and its members'
 * updates. Each edit becomes one suffix rewrite of its group:
 *
 * 1. the stored suffix: the group's members from the least slot the edit touches to the end, the member before it
 *    included, and the owner's count, ends and copied columns, read in one batched SELECT per family before any write
 *    (statements.ts suffixReadSql); an owner the same changeset inserts has an empty family, count 0 and every end at
 *    its start, and is no stored group;
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
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import { carrierSpecOf, scalarCodec } from "#compiler/codec/scalar.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { LawField, LawRelation, RelationInfo } from "#compiler/ir/law.ts"
import { admittedText, admitValue } from "#compiler/scalar/values/identity.ts"
import {
	type MemberKey,
	type Owner,
	type Recount,
	type Row,
	textsKey
} from "#compiler/write/family/draw.ts"
import {
	baseOf,
	type ColumnKey,
	columnKey,
	combineHost,
	familyColumnType,
	familyKey,
	fieldKey,
	type HostEvaluator,
	readsOf
} from "#compiler/write/family/fold.ts"
import { isSequence } from "#compiler/write/family/nesting.ts"
import type { OwnerWrite, RelationWrite } from "#compiler/write/family/order.ts"
import { endColumns, type ReadShape, type RowLayout } from "#compiler/write/family/statements.ts"

/** A row's host values by column key: the values a codec admits (scalar/values/identity.ts CarrierHost). */
export type Values = ReadonlyMap<ColumnKey, unknown>

/** A fact of a member relation's slot, as normalization admitted it: its fields' host values by name. */
export type Fact = { readonly [field: string]: unknown }

/** A family-managed relation's changes in one stratum, as its normalized slots hold them. */
export interface RelationChanges {
	readonly inserts: ReadonlyArray<Fact>
	readonly puts: ReadonlyArray<Fact>
	readonly deletes: ReadonlyArray<Fact>
}

/** What one stratum's edits of a member relation read and write, compiled once: its row layout, its families with
 * each one's read shape, and its depth among the families. */
export interface EditTarget {
	readonly relation: RelationInfo
	readonly layout: RowLayout
	readonly families: ReadonlyArray<{ readonly family: Family; readonly shape: ReadShape }>
}

/** A stored member as a read returns it: its slot in the read's family, its group's key text, and its values. */
interface StoredMember {
	readonly key: string
	readonly slot: number
	readonly group: string
	readonly values: Values
}

/** A group as a read returns it: its owner's values and count, and its members from the read's first slot on. */
export interface StoredGroup {
	readonly owner: Values
	readonly count: number
	readonly members: ReadonlyArray<StoredMember>
}

/** One family's read, decoded: its stored groups by group key text, and its stored members by key text. */
export interface StoredFamily {
	readonly groups: ReadonlyMap<string, StoredGroup>
	readonly members: ReadonlyMap<string, StoredMember>
}

/** The context the host fills in: the installation's codes and the evaluator of generated fields. */
export interface FillContext {
	readonly codes: Codebook
	readonly evaluate: HostEvaluator
}

/** A key text, which keys of one relation are told apart by. */
const specOf = (ctx: FillContext, type: LawField["type"]) => carrierSpecOf(type, ctx.codes)

/** A host value's text in its type's carrier. */
const textOf = (ctx: FillContext, type: LawField["type"], value: unknown): string =>
	admittedText(specOf(ctx, type), value)

/** A fact's values by column key. */
export const valuesOfFact = (fact: Fact): Map<ColumnKey, unknown> =>
	new Map(Object.entries(fact).map(([name, v]) => [fieldKey(name), v] as const))

/** A row's key texts in its layout. */
const keyOf = (ctx: FillContext, layout: RowLayout, values: Values): MemberKey =>
	mapNonEmpty(layout.key, (c) => textOf(ctx, c.type, values.get(c.key)))

/** A row's group key texts in a family. */
const groupOf = (ctx: FillContext, family: Family, values: Values): Owner =>
	mapNonEmpty(family.group, (g) => textOf(ctx, g.member.type, values.get(fieldKey(g.member.name))))

/**
 * The placeholder texts of one family's read: the touched members' keys, one array per key field, then the touched
 * groups' keys, one array per group field, each once; none when nothing it touches can be stored, no key named and
 * every group an owner's the changeset inserts.
 */
export const readArrays = (
	ctx: FillContext,
	target: EditTarget,
	family: Family,
	changes: RelationChanges,
	inserted: ReadonlySet<string>
): ReadonlyArray<ReadonlyArray<string>> | undefined => {
	const keys = new Map<string, MemberKey>()
	for (const fact of [...changes.deletes, ...changes.puts]) {
		const key = keyOf(ctx, target.layout, valuesOfFact(fact))
		keys.set(textsKey(key), key)
	}
	const groups = new Map<string, Owner>()
	for (const fact of [...changes.inserts, ...changes.puts]) {
		const group = groupOf(ctx, family, valuesOfFact(fact))
		if (!inserted.has(textsKey(group))) {
			groups.set(textsKey(group), group)
		}
	}
	if (keys.size === 0 && groups.size === 0) {
		return undefined
	}
	const column = (list: ReadonlyArray<ReadonlyArray<string>>, i: number): ReadonlyArray<string> =>
		list.map((k) => defined(k[i], `component ${i} of a read key`))
	return [
		...target.layout.key.map((_, i) => column([...keys.values()], i)),
		...family.group.map((_, i) => column([...groups.values()], i))
	]
}

/**
 * One family's read's rows decoded (statements.ts suffixReadSql): each `o` row an owner, its key and its read columns;
 * each `m` row a member, its key and its row layout's columns, each text read through its column's codec. A text the
 * codec does not read is the read's EncodingFailure.
 */
export const decodeRead = (
	ctx: FillContext,
	target: EditTarget,
	family: Family,
	shape: ReadShape,
	rows: ReadonlyArray<ReadonlyArray<string>>
): Result.Result<StoredFamily, EncodingFailure> => {
	const owners = new Map<
		string,
		{ readonly values: Map<ColumnKey, unknown>; readonly count: number }
	>()
	const members: Array<StoredMember> = []
	const failure = encodeFailure("factShape", slotPlace(target.relation.name))
	const read = (
		type: LawField["type"],
		text: string | undefined
	): Result.Result<unknown, EncodingFailure> => {
		if (text === undefined) {
			return Result.err(failure)
		}
		const converted = scalarCodec(type, ctx.codes).convert(text)
		const admitted = admitValue(specOf(ctx, type), converted)
		return admitted.ok ? Result.ok(admitted.value) : Result.err(failure)
	}
	for (const row of rows) {
		const [tag, ...cells] = row
		if (tag === "o") {
			const values = new Map<ColumnKey, unknown>()
			const columns: ReadonlyArray<LawField> = [
				...family.group.map((g) => g.owner),
				...shape.owner.columns
			]
			for (const [i, f] of columns.entries()) {
				const v = read(f.type, cells[i])
				if (!v.ok) {
					return v
				}
				values.set(fieldKey(f.name), v.value)
			}
			const count = values.get(fieldKey(family.count.name))
			const group = textsKey(groupOfOwner(ctx, family, values))
			owners.set(group, { values, count: typeof count === "bigint" ? Number(count) : 0 })
			continue
		}
		const values = new Map<ColumnKey, unknown>()
		for (const [i, c] of [...target.layout.key, ...target.layout.columns].entries()) {
			const v = read(c.type, cells[i])
			if (!v.ok) {
				return v
			}
			values.set(c.key, v.value)
		}
		const slot = values.get(columnKey(family.index))
		members.push({
			key: textsKey(keyOf(ctx, target.layout, values)),
			slot: typeof slot === "bigint" ? Number(slot) : -1,
			group: textsKey(groupOf(ctx, family, values)),
			values
		})
	}
	const groups = new Map<string, StoredGroup>()
	for (const [group, o] of owners) {
		groups.set(group, {
			owner: o.values,
			count: o.count,
			members: members.filter((m) => m.group === group).toSorted((a, b) => a.slot - b.slot)
		})
	}
	return Result.ok({ groups, members: new Map(members.map((m) => [m.key, m] as const)) })
}

/** An owner's group key texts, its key fields paired with the family's group in order. */
const groupOfOwner = (ctx: FillContext, family: Family, values: Values): Owner =>
	mapNonEmpty(family.group, (g) => textOf(ctx, g.owner.type, values.get(fieldKey(g.owner.name))))

/** The fields a family's drawn values read of a member: its step value, its selections' fields, every column its axes
 * carry from a member, and the fields every generated one of those reads, transitively. */
const inputsOf = (family: Family, relation: LawRelation): ReadonlySet<string> => {
	const out = new Set<string>()
	const pending: Array<string> = []
	const add = (name: string): void => {
		if (!out.has(name)) {
			out.add(name)
			pending.push(name)
		}
	}
	for (const fold of family.folds) {
		if (fold.step.kind === "value") {
			add(fold.step.field.name)
		}
		for (const w of fold.where) {
			for (const name of readsOf(w)) {
				add(name)
			}
		}
	}
	for (const pair of [...family.axes.predecessor, ...family.axes.last]) {
		if (pair.to.kind === "field") {
			add(pair.to.field.name)
		}
	}
	for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
		const field = relation.fields.find((f) => f.name === name)
		if (field?.writing.kind === "generated") {
			for (const read of readsOf(field.writing.expr)) {
				add(read)
			}
		}
	}
	return out
}

/** A value of a row, a generated field's evaluated over the row; undefined where the row holds none. */
const valueAt = (
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
	return v.ok ? v.value : undefined
}

/** Whether two host values of one carrier are one: their canonical texts are equal. */
const same = (ctx: FillContext, type: LawField["type"], a: unknown, b: unknown): boolean =>
	a !== undefined && b !== undefined && textOf(ctx, type, a) === textOf(ctx, type, b)

/** A member a group's fill writes: its key text, the family's columns of it, and the statement that writes it: an
 * insert of a new member, a delete and an insert of a re-placed one, an update in place of any other. */
interface Placement {
	readonly key: string
	readonly columns: ReadonlyMap<ColumnKey, unknown>
	readonly change: "insert" | "update" | "replace"
}

/** A group's edit as one family's fill takes it. */
interface GroupEdit {
	readonly owner: Values | undefined
	readonly stored: StoredGroup | undefined
	readonly removals: ReadonlySet<string>
	/** Kept members' new values, the stored ones with the put's caller fields over them. */
	readonly updates: ReadonlyMap<string, Values>
	readonly appends: ReadonlyArray<{ readonly key: string; readonly values: Values }>
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
 * least changed slot on every one is re-placed, since its predecessor axis is immediate.
 */
const fillGroup = (
	ctx: FillContext,
	relation: LawRelation,
	family: Family,
	edit: GroupEdit
): Result.Result<GroupFilled, EncodingFailure> => {
	const failure = encodeFailure("integerRange", slotPlace(relation.name))
	const n0 = edit.stored?.count ?? 0
	const stored = edit.stored?.members ?? []
	const bySlot = new Map(stored.map((m) => [m.slot, m] as const))
	const inputs = inputsOf(family, relation)
	const changesInput = (before: Values, after: Values): boolean =>
		[...inputs].some((name) => {
			const field = relation.fields.find((f) => f.name === name)
			return (
				field?.writing.kind === "caller" &&
				!same(ctx, field.type, before.get(fieldKey(name)), after.get(fieldKey(name)))
			)
		})
	const removedSlots = stored.filter((m) => edit.removals.has(m.key)).map((m) => m.slot)
	const kept = n0 - removedSlots.length
	const n1 = kept + edit.appends.length
	const counted = !isSequence(family)
	let s = n1
	for (const [key, values] of edit.updates) {
		const m = stored.find((x) => x.key === key)
		if (m !== undefined && changesInput(m.values, values)) {
			s = Math.min(s, m.slot)
		}
	}
	if (edit.appends.length > 0) {
		s = Math.min(s, kept)
	}
	/** Each final slot's member from `s` on, where it differs from the stored slot's: moved, or appended. */
	const at = new Map<
		number,
		{ readonly key: string; readonly values: Values; readonly from: "moved" | "new" }
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
			at.set(slot, {
				key: mover.key,
				values: edit.updates.get(mover.key) ?? mover.values,
				from: "moved"
			})
		}
	} else {
		for (const slot of removedSlots) {
			s = Math.min(s, slot)
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
	): { readonly key: string; readonly values: Values } | undefined => {
		const placed = at.get(slot)
		if (placed !== undefined) {
			return placed
		}
		const m = bySlot.get(slot)
		return m === undefined ? undefined : { key: m.key, values: edit.updates.get(m.key) ?? m.values }
	}
	const owner = edit.owner
	const ownerCopies = family.axes.owner.filter(
		(pair) =>
			(pair.from.kind === "field" ? pair.from.field.writing.kind === "accumulated" : true) &&
			!(pair.from.kind === "law" && pair.from.column === family.copy)
	)
	if (owner === undefined && ownerCopies.length > 0 && n1 > 0) {
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
		const own = new Map<ColumnKey, unknown>()
		const put = (key: ColumnKey, v: unknown): void => {
			values.set(key, v)
			own.set(key, v)
		}
		put(columnKey(family.index), BigInt(slot))
		put(`law:${family.copy}`, BigInt(n1))
		const prev = slot === 0 ? undefined : (filled.get(slot - 1) ?? memberAt(slot - 1)?.values)
		for (const pair of ownerCopies) {
			put(
				columnKey(pair.from),
				owner === undefined ? undefined : valueAt(ctx, family.owner, owner, columnKey(pair.to))
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
				const admitted = after === undefined ? undefined : admitValue(spec, after)
				if (admitted === undefined || !admitted.ok) {
					return Result.err(failure)
				}
				put(columnKey(plane.after), admitted.value)
			}
		}
		filled.set(slot, values)
		const from = at.get(slot)?.from ?? "kept"
		const storedHere = bySlot.get(slot)
		const unchanged =
			from === "kept" &&
			storedHere !== undefined &&
			!edit.updates.has(member.key) &&
			[...own].every(([key, v]) =>
				same(ctx, typeOfKey(relation, family, key), storedHere.values.get(key), v)
			)
		if (counted && unchanged) {
			continue
		}
		placed.push({
			key: member.key,
			columns: own,
			change: from === "new" ? "insert" : counted ? "update" : "replace"
		})
	}
	for (const key of edit.updates.keys()) {
		const m = stored.find((x) => x.key === key)
		if (m !== undefined && m.slot < s) {
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

/** What one stratum's edits of a member relation write: its rows, and each family's changed owners. */
export interface Edited {
	readonly rows: RelationWrite
	readonly owners: ReadonlyArray<OwnerWrite>
}

/**
 * A member relation's changes in one stratum planned against its families' reads: each family's touched groups
 * resolved into edits and filled, the placements merged per row (a row deleted, inserted whole, re-placed whole, or
 * updated in place, its every family's columns as filled or as stored), and each changed owner's count and ends.
 * `insertedOwners` gives each family's owners the changeset inserts, by group key text, with their values.
 */
export const planEdits = (
	ctx: FillContext,
	target: EditTarget,
	changes: RelationChanges,
	stored: ReadonlyMap<string, StoredFamily>,
	insertedOwners: (family: Family) => ReadonlyMap<string, Values>
): Result.Result<Edited, EncodingFailure> => {
	const relation = target.relation
	/** Each row the changes name, once: a key named twice is refused, never a second member. */
	const named = new Map<
		string,
		{ readonly op: "insert" | "put" | "delete"; readonly values: Values }
	>()
	const keys = new Map<string, MemberKey>()
	for (const [op, facts] of [
		["insert", changes.inserts],
		["put", changes.puts],
		["delete", changes.deletes]
	] as const) {
		for (const fact of facts) {
			const values = valuesOfFact(fact)
			const key = keyOf(ctx, target.layout, values)
			const text = textsKey(key)
			if (named.has(text)) {
				return Result.err(encodeFailure("factShape", slotPlace(relation.name)))
			}
			named.set(text, { op, values })
			keys.set(text, key)
		}
	}
	/** Every stored row any family's read returned, by key text, with every column it holds. */
	const storedRows = new Map<string, Values>()
	for (const read of stored.values()) {
		for (const m of read.members.values()) {
			storedRows.set(m.key, m.values)
			keys.set(m.key, keyOf(ctx, target.layout, m.values))
		}
	}
	const placements = new Map<string, Array<Placement>>()
	const owners: Array<OwnerWrite> = []
	for (const { family } of target.families) {
		const read = stored.get(familyKey(family.id))
		const inserted = insertedOwners(family)
		const groups = new Map<
			string,
			{
				readonly owner: Owner
				readonly edit: {
					readonly owner: Values | undefined
					readonly stored: StoredGroup | undefined
					readonly removals: Set<string>
					readonly updates: Map<string, Values>
					readonly appends: Array<{ readonly key: string; readonly values: Values }>
				}
			}
		>()
		const groupEdit = (owner: Owner) => {
			const text = textsKey(owner)
			const known = groups.get(text)
			if (known !== undefined) {
				return known.edit
			}
			const s = read?.groups.get(text)
			const edit = {
				owner: s?.owner ?? inserted.get(text),
				stored: s,
				removals: new Set<string>(),
				updates: new Map<string, Values>(),
				appends: new Array<{ readonly key: string; readonly values: Values }>()
			}
			groups.set(text, { owner, edit })
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
					groupEdit(groupOf(ctx, family, values)).appends.push({ key, values })
					break
				case "put": {
					const group = groupOf(ctx, family, values)
					if (was === undefined) {
						groupEdit(group).appends.push({ key, values })
						break
					}
					const merged = new Map([...was.values, ...values])
					if (was.group === textsKey(group)) {
						groupEdit(group).updates.set(key, merged)
					} else {
						groupEdit(storedGroupOf(was)).removals.add(key)
						groupEdit(group).appends.push({ key, values: merged })
					}
					break
				}
			}
		}
		const recounts = new Map<string, Recount>()
		for (const [text, { owner, edit }] of groups) {
			const filled = fillGroup(ctx, relation, family, edit)
			if (!filled.ok) {
				return filled
			}
			for (const placement of filled.value.placed) {
				const list = placements.get(placement.key) ?? []
				const moved = placement.change === "insert" && storedRows.has(placement.key)
				list.push(moved ? { ...placement, change: "replace" } : placement)
				placements.set(placement.key, list)
			}
			const after = filled.value.recount
			if (after !== undefined) {
				recounts.set(text, {
					owner,
					count: edit.appends.length + (edit.stored?.count ?? 0) - edit.removals.size,
					ends: endColumns(family).map((f) => textOf(ctx, f.type, after.get(fieldKey(f.name))))
				})
			}
		}
		if (recounts.size > 0) {
			owners.push({ family: family.id, recounts })
		}
	}
	const deletes = new Map<string, MemberKey>()
	const updates = new Map<string, Row>()
	const inserts = new Map<string, Row>()
	const keyOfText = (text: string): MemberKey => defined(keys.get(text), "a named or stored key")
	const rowOf = (text: string, values: Values): Row => ({
		key: keyOfText(text),
		columns: target.layout.columns.map((c) => textOf(ctx, c.type, values.get(c.key)))
	})
	const written = new Set<string>([...named.keys(), ...placements.keys()])
	for (const text of written) {
		const op = named.get(text)
		if (op?.op === "delete") {
			if (storedRows.has(text)) {
				deletes.set(text, keyOfText(text))
			}
			continue
		}
		const merged = new Map([...(storedRows.get(text) ?? []), ...(op?.values ?? [])])
		const list = placements.get(text) ?? []
		for (const placement of list) {
			for (const [k, v] of placement.columns) {
				merged.set(k, v)
			}
		}
		if (!storedRows.has(text)) {
			inserts.set(text, rowOf(text, merged))
		} else if (list.some((p) => p.change === "replace")) {
			deletes.set(text, keyOfText(text))
			inserts.set(text, rowOf(text, merged))
		} else {
			updates.set(text, rowOf(text, merged))
		}
	}
	return Result.ok({
		rows: { relation: relation.name, deletes, trees: new Map(), updates, inserts },
		owners
	})
}
