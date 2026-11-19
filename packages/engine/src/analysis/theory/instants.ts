import {
	appendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
/**
 * The classifier of a schema's instants (ir/instant.ts): every instant field a clock or a reference, read off the
 * theory's containments, built once when the schema compiles, its refusals a clock outside its primary key or first in
 * it.
 *
 * - A reference is an instant field a containment carries, from every row of its relation (a side with no selection
 *   and no pred term, which holds only where its field is above zero), term for term into an instant field of an
 *   ordinary relation. Each such containment is one of its `laws`.
 * - Every other instant field is a clock: it stands in its relation's primary key after at least one field, its child
 *   the key's fields before it, or it is refused as InstantRefused: `clockOutsideKey`, since no child would order it,
 *   or `childless`, first in its key, which would order its whole relation as one child that every writer meets.
 *
 * A reference's stamp is the one clock its containments reach, each carrying it into an instant field that is that clock
 * or a reference stamped by it, at the child each carries its row to: every child field of the target's stamp paired,
 * field for field, with a field of the reference's row. Containments that reach no clock, a clock at a child one of them
 * does not carry, or two clocks or two children, stamp it with none: such a reference holds a stored instant whenever a
 * write states one, and no write may leave it out (write/frontend/instants.ts). A cycle of references through whole
 * relations reaches no clock either.
 *
 * The classifier reads each place too (ir/instant.ts PlaceHead): a field written as one stands last in its relation's
 * primary key after at least one field, its group, and its `by` is another field of the relation, a key of which holds
 * no field but the group's and `by`'s; else it is refused as PlaceRefused, `outsideKey`, `groupless`, `notLast`,
 * `byUnknown`, `byItself` or `byUnkeyed`, naming the key the place's group and `by` would be.
 */
import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import type { PlaceRule } from "#compiler/core/causes.ts"
import { CompileError } from "#compiler/core/errors.ts"
import type { LawId, StoredRelationName } from "#compiler/core/ids.ts"
import { compareStrings } from "#compiler/core/order.ts"
import {
	type Clock,
	type InstantRole,
	type Instants,
	type PlaceHead,
	sameStamp,
	type StampSource
} from "#compiler/ir/instant.ts"
import type { LawField, RelationInfo, TheoryRelation } from "#compiler/ir/law.ts"

/**
 * A containment that carries an instant field into another relation's: its law, the target's relation and instant
 * field, and each field of the target the containment pairs term for term with a field of the carried row, by name.
 */
interface Carrier {
	readonly law: LawId
	readonly target: StoredRelationName
	readonly field: string
	readonly pairs: ReadonlyMap<string, LawField>
}

/** An instant field of an ordinary relation, by its relation's name and its own. */
const instantKey = (relation: string, field: string): string => `${relation}\u0000${field}`

/** Whether a field is an instant, as the checked schema resolved its writing (ir/law.ts FieldWriting). */
const isInstant = (field: LawField): boolean => field.writing.kind === "instant"

/**
 * Every containment of `laws` that carries an instant field of an ordinary relation, read from every row of its
 * relation, term for term into an instant field of an ordinary relation, by the carried field (instantKey).
 */
const carriersOf = (
	laws: ReadonlyArray<TheoryLaw>
): ReadonlyMap<string, NonEmptyReadonlyArray<Carrier>> => {
	const out = new Map<string, Array<Carrier>>()
	for (const law of laws) {
		const d = law.detail
		if (
			d.kind !== "containment" ||
			d.pairing.kind !== "scalar" ||
			d.from.rel.kind !== "relation" ||
			d.to.rel.kind !== "relation" ||
			d.from.selection.conjuncts.length > 0 ||
			d.from.terms.some((t) => t.kind === "pred")
		) {
			continue
		}
		const target = d.to.rel.name
		const pairs = new Map(
			d.pairs.flatMap((p): ReadonlyArray<readonly [string, LawField]> =>
				p.from.kind === "field" && p.to.kind === "field" ? [[p.to.column.name, p.from.column]] : []
			)
		)
		for (const p of d.pairs) {
			if (
				p.from.kind !== "field" ||
				p.to.kind !== "field" ||
				!isInstant(p.from.column) ||
				!isInstant(p.to.column)
			) {
				continue
			}
			const key = instantKey(d.from.rel.name, p.from.column.name)
			const carried = out.get(key) ?? []
			carried.push({ law: law.id, target, field: p.to.column.name, pairs })
			out.set(key, carried)
		}
	}
	return new Map(
		[...out].flatMap(
			([key, carried]): ReadonlyArray<readonly [string, NonEmptyReadonlyArray<Carrier>]> =>
				isNonEmpty(carried) ? [[key, carried]] : []
		)
	)
}

/**
 * The roles of `relations`' instant fields, from the containments among `laws` (see the module's header), or the first
 * clock outside its relation's primary key or first in it, by relation name in code points and then field in declared
 * order, refused there.
 */
export const instantRoles = (
	relations: Readonly<Record<string, TheoryRelation>>,
	laws: ReadonlyArray<TheoryLaw>
): Result.Result<Instants, CompileError> => {
	const carriers = carriersOf(laws)
	const ordinary = Object.values(relations)
		.flatMap((r): ReadonlyArray<RelationInfo> => (r.kind === "relation" ? [r] : []))
		.toSorted((a, b) => compareStrings(a.name, b.name))
	/** Each clock, by its field (instantKey), with its child. */
	const clocks = new Map<string, Clock>()
	for (const r of ordinary) {
		for (const field of r.fields) {
			if (!isInstant(field) || carriers.has(instantKey(r.name, field.name))) {
				continue
			}
			const at = r.primaryFields.findIndex((k) => k.name === field.name)
			const child = r.primaryFields.slice(0, at)
			if (at < 0 || !isNonEmpty(child)) {
				return Result.err(
					CompileError.make({
						_tag: "InstantRefused",
						at: r.loc,
						relation: r.name,
						field: field.name,
						rule: at < 0 ? { kind: "clockOutsideKey" } : { kind: "childless" }
					})
				)
			}
			clocks.set(instantKey(r.name, field.name), { kind: "clock", relation: r.name, field, child })
		}
	}
	/** Each reference's stamp once resolved, none where it has none. */
	const stamps = new Map<string, StampSource | undefined>()
	/**
	 * The stamp of `relation`'s instant field `field`: a clock's own, or a reference's through its carriers; none for a
	 * reference met again while its own stamp is resolved, a cycle no clock ends.
	 */
	const stampOf = (
		relation: StoredRelationName,
		field: string,
		resolving: ReadonlySet<string>
	): StampSource | undefined => {
		const key = instantKey(relation, field)
		const clock = clocks.get(key)
		if (clock !== undefined) {
			return { head: clock, child: clock.child }
		}
		if (stamps.has(key)) {
			return stamps.get(key)
		}
		const carried = carriers.get(key)
		if (carried === undefined || resolving.has(key)) {
			return undefined
		}
		const within = new Set([...resolving, key])
		const through = carried.map((c): StampSource | undefined => {
			const target = stampOf(c.target, c.field, within)
			if (target === undefined) {
				return undefined
			}
			const child = target.child.flatMap((f) => {
				const paired = c.pairs.get(f.name)
				return paired === undefined ? [] : [paired]
			})
			return isNonEmpty(child) && child.length === target.child.length
				? { head: target.head, child }
				: undefined
		})
		const [first, ...rest] = through
		const stamp =
			first !== undefined && rest.every((s) => s !== undefined && sameStamp(s, first))
				? first
				: undefined
		stamps.set(key, stamp)
		return stamp
	}
	const roles = new Map<StoredRelationName, ReadonlyMap<string, InstantRole>>()
	for (const r of ordinary) {
		const own = new Map<string, InstantRole>()
		for (const field of r.fields) {
			if (!isInstant(field)) {
				continue
			}
			const key = instantKey(r.name, field.name)
			const clock = clocks.get(key)
			const carried = carriers.get(key)
			if (clock !== undefined) {
				own.set(field.name, { kind: "clock", stamp: { head: clock, child: clock.child } })
			} else if (carried !== undefined) {
				own.set(field.name, {
					kind: "reference",
					laws: mapNonEmpty(carried, (c) => c.law),
					stamp: stampOf(r.name, field.name, new Set())
				})
			}
		}
		if (own.size > 0) {
			roles.set(r.name, own)
		}
	}
	const places = new Map<StoredRelationName, PlaceHead>()
	for (const r of ordinary) {
		for (const field of r.fields) {
			const placed = placeOf(r, field)
			if (placed === undefined) {
				continue
			}
			if (!placed.ok) {
				return placed
			}
			places.set(r.name, placed.value)
		}
	}
	return Result.ok({ roles, places })
}

/**
 * The place `field` of `r` is (ir/instant.ts PlaceHead), none where it is no place: last in `r`'s primary key after at
 * least one field, its group, and ordered for a migration by `by`, another field of `r`, where a key of `r` holds no
 * field but the group's and `by`, so each group's rows are distinct by `by` and their order total. Refused as
 * PlaceRefused otherwise, the key a missing one named by the group and `by`.
 */
const placeOf = (
	r: RelationInfo,
	field: LawField
): Result.Result<PlaceHead, CompileError> | undefined => {
	const w = field.writing
	if (w.kind !== "place") {
		return undefined
	}
	const refused = (rule: PlaceRule): Result.Result<PlaceHead, CompileError> =>
		Result.err(
			CompileError.make({
				_tag: "PlaceRefused",
				at: r.loc,
				relation: r.name,
				field: field.name,
				rule
			})
		)
	const at = r.primaryFields.findIndex((k) => k.name === field.name)
	const child = r.primaryFields.slice(0, at)
	if (at < 0) {
		return refused({ kind: "outsideKey" })
	}
	if (!isNonEmpty(child)) {
		return refused({ kind: "groupless" })
	}
	if (at !== r.primaryFields.length - 1) {
		return refused({ kind: "notLast" })
	}
	const by = r.fields.find((f) => f.name === w.by)
	if (by === undefined) {
		return refused({ kind: "byUnknown", by: w.by })
	}
	if (by.name === field.name) {
		return refused({ kind: "byItself" })
	}
	const within = new Set([...child.map((f) => f.name), by.name])
	const keyed = [r.primaryFields, ...r.keyFields].some((k) => k.every((f) => within.has(f.name)))
	if (!keyed) {
		return refused({
			kind: "byUnkeyed",
			key: appendNonEmpty(
				mapNonEmpty(child, (f) => f.name),
				by.name
			)
		})
	}
	return Result.ok({ kind: "place", relation: r.name, field, child, by })
}
