/**
 * How a ChangeSet's writes meet the schema's instants (ir/instant.ts): each action's rows, as its source delivers them,
 * state some instant fields and leave the others out, and every refusal of how a write writes an instant is made here,
 * once, from the classifier's roles (analysis/theory/instants.ts):
 *
 * - an insert leaves a clock out, which it stamps, and states none (`clockStated`); a reference it leaves out is stamped
 *   by its clock's stamp source, and one with none is refused (`unstampable`); no stamp's child holds a field the same
 *   insert stamps (`childStamped`);
 * - a put states every instant of its rows, a clock never (`clockStated`), and a delete states every instant
 *   (`unstated`), each from a stored instant, which only a query's term of instant's type is (check/member.ts): no host
 *   row carries an instant (frontend/compile.ts carriedOf);
 * - an insert stamps in the one statement that writes its rows (`StampingWriter`): its own, or its relation's family
 *   statement, which stamps every row of its nesting (write/family/additions.ts); never through a query entry's
 *   precheck (`stampedApart`, statements);
 * - a ChangeSet stamps each clock in one stratum (`stampedApart`, strata), and a reference it stamps beside an insert of
 *   its clock in that stratum (`clockUnstamped`). A later stratum reads the stamped rows back as stored instants. Two
 *   clocks of one scope may stamp in two strata, or two statements: each stamps rows of its own relation, which the
 *   other's never meets at its key, and both take the call's one instant of the scope (write/insert/stamp.ts).
 *
 * A place (ir/instant.ts PlaceHead) is stamped as a clock is, by its own head at its group, and refused as PlaceRefused:
 * no put writes its relation, and a delete only where it removes whole groups (`written`, Removal), its group holds no
 * field the same insert stamps (`groupStamped`), and one call stamps it in one statement (`stampedApart`). No member
 * head holds a place, as none holds a field grizzle writes (check/member.ts), so an insert's rows state none.
 *
 * What a stratum's statements stamp together is the plan's to keep in one statement (write/schedule/plan.ts).
 */
import { Refusal } from "#compiler/core/canonical.ts"
import type { InstantRule, PlaceRule } from "#compiler/core/causes.ts"
import { CompileError } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { WriteOp } from "#compiler/ir/desc.ts"
import {
	type HeadStamped,
	headStamped,
	type Instants,
	type Stamped,
	stampText
} from "#compiler/ir/instant.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import type { Heading } from "#compiler/ir/rel.ts"

/** The refusal of `relation`'s instant field `field` by `rule`, at `loc`. */
const refused = (loc: SourceLoc, relation: string, field: string, rule: InstantRule): never => {
	throw new Refusal(CompileError.make({ _tag: "InstantRefused", at: loc, relation, field, rule }))
}

/** The refusal of `relation`'s place `field` by `rule`, at `loc`. */
const placeRefused = (loc: SourceLoc, relation: string, field: string, rule: PlaceRule): never => {
	throw new Refusal(CompileError.make({ _tag: "PlaceRefused", at: loc, relation, field, rule }))
}

/**
 * What a delete removes of its relation's place groups: `groups`, where every field its rows state is a field of the
 * place's group (PlaceHead `child`), so every group it reaches it removes whole and each group left stays gapless
 * from 0; `rows` otherwise, which may leave a gap, and for a relation with no place, where it decides nothing.
 */
export type Removal = "rows" | "groups"

/** What a delete of `relation` whose rows state the fields `stated` removes of its place's groups (Removal). */
export const removalOf = (
	instants: Instants,
	relation: RelationInfo,
	stated: ReadonlyArray<string>
): Removal => {
	const place = instants.places.get(relation.name)
	return place !== undefined && stated.every((f) => place.child.some((c) => c.name === f))
		? "groups"
		: "rows"
}

/**
 * Refuses a delete of a tree's or a family owner's units, removing every row nested under the rows it names, of a
 * relation whose place it would leave a gap in: one that removes rows of its groups, not whole groups (Removal), as
 * stampsOf refuses any other delete of a place's relation.
 */
export const refuseUnitPlace = (
	instants: Instants,
	relation: RelationInfo,
	removes: Removal,
	loc: SourceLoc
): void => {
	const place = instants.places.get(relation.name)
	if (place !== undefined && removes === "rows") {
		placeRefused(loc, relation.name, place.field.name, { kind: "written", op: "delete" })
	}
}

/** A stamp's spelling in a refusal: its clock's relation and field, or its place's. */
const clockText = (s: HeadStamped): string => stampText(s.stamp)

/** Whether a stamp is `relation`'s own: its own clock, or its own place, never a reference's clock. */
const ownStamp = (s: HeadStamped, relation: string): boolean => {
	const [of, field] =
		s.stamp.kind === "clock"
			? [s.stamp.clock.relation, s.stamp.clock.field.name]
			: [s.stamp.place.relation, s.stamp.place.field.name]
	return of === relation && field === s.field.name
}

/**
 * The refusal of `s`, a stamp of `relation`'s, as stamped apart: `apart` in two strata or in a stratum of several
 * statements, an instant's by its clock, a place's by itself.
 */
const refusedApart = (
	loc: SourceLoc,
	relation: string,
	s: HeadStamped,
	apart: "strata" | "statements"
): never =>
	s.stamp.kind === "clock"
		? refused(loc, relation, s.field.name, { kind: "stampedApart", clock: clockText(s), apart })
		: placeRefused(loc, relation, s.field.name, { kind: "stampedApart", apart })

/**
 * The statement that writes an action's rows, and so stamps them: `own`, its insert's own statement, a part of its
 * stratum's single statement or one of its own; `family`, its relation's family statement, which writes a nesting's
 * every row, a stamped one's root among them (write/family/nesting.ts Nesting `stamps`); or `entry`, its insert's
 * statement through a query entry, whose precheck reads its rows before it, which stamps nothing.
 */
export type StampingWriter =
	| { readonly kind: "own" }
	| { readonly kind: "family" }
	| { readonly kind: "entry" }

/**
 * What an action of `op` over `relation` stamps, its source delivering `heading`, its rows written by `writer`: the
 * instant fields its insert's rows leave out, each with its stamp source, its relation's place, which an insert always
 * stamps, and `computed`, the fields its insert computes from the call (ir/instant.ts Computed), each its value; none
 * for a put or a delete, which state every instant and write a relation with a place only as a delete that `removes`
 * whole groups. A head's child may hold a computed field, which every row of the call holds alike, never a field a head
 * stamps. Refused as the module's header says.
 */
export const stampsOf = (
	instants: Instants,
	relation: RelationInfo,
	op: WriteOp,
	removes: Removal,
	heading: Heading,
	writer: StampingWriter,
	loc: SourceLoc,
	computed: ReadonlyArray<Stamped>
): ReadonlyArray<Stamped> => {
	const roles = instants.roles.get(relation.name)
	const place = instants.places.get(relation.name)
	const stated = (f: LawField): boolean => heading.some((c) => c.name === f.name)
	const stamped: Array<HeadStamped> = []
	for (const field of relation.fields) {
		const role = roles?.get(field.name)
		if (role === undefined) {
			continue
		}
		if (role.kind === "clock" && op !== "delete" && stated(field)) {
			return refused(loc, relation.name, field.name, { kind: "clockStated", op })
		}
		if (stated(field)) {
			continue
		}
		if (op !== "insert") {
			return refused(loc, relation.name, field.name, { kind: "unstated", op })
		}
		if (role.stamp === undefined) {
			return refused(loc, relation.name, field.name, { kind: "unstampable" })
		}
		stamped.push({ field, stamp: { kind: "clock", ...role.stamp } })
	}
	if (place !== undefined) {
		if (op === "delete" && removes === "groups") {
			return stamped
		}
		if (op !== "insert") {
			return placeRefused(loc, relation.name, place.field.name, { kind: "written", op })
		}
		stamped.push({ field: place.field, stamp: { kind: "place", place, child: place.child } })
	}
	for (const s of stamped) {
		const inChild = s.stamp.child.find((f) => stamped.some((o) => o.field.name === f.name))
		if (inChild === undefined) {
			continue
		}
		const within = `${relation.name}.${inChild.name}`
		return s.stamp.kind === "clock"
			? refused(loc, relation.name, s.field.name, { kind: "childStamped", stamped: within })
			: placeRefused(loc, relation.name, s.field.name, { kind: "groupStamped", stamped: within })
	}
	const [first] = stamped
	if (first !== undefined && writer.kind === "entry") {
		return refusedApart(loc, relation.name, first, "statements")
	}
	return [...computed, ...stamped]
}

/**
 * Refuses a stratum realized one statement after another, `actions` its actions with their statements' count, that
 * stamps one clock in more than one statement: by two actions, or by an action of several statements. Each statement
 * would read the clock's head anew, the stamp of an earlier one among it, so its rows would not share their child's
 * instant. A stratum one statement realizes stamps every clock once (write/schedule/plan.ts realizationOf).
 */
export const refuseStampedStatements = (
	actions: ReadonlyArray<{
		readonly relation: RelationInfo
		readonly stamps: ReadonlyArray<Stamped>
		readonly statements: number
		readonly loc: SourceLoc
	}>
): void => {
	const stamping = new Map<string, number>()
	for (const a of actions) {
		const heads = headStamped(a.stamps)
		const clocks = new Set(heads.map(clockText))
		for (const clock of clocks) {
			const statements = (stamping.get(clock) ?? 0) + a.statements
			const first = heads.find((s) => clockText(s) === clock)
			if (statements > 1 && first !== undefined) {
				return refusedApart(a.loc, a.relation.name, first, "statements")
			}
			stamping.set(clock, statements)
		}
	}
}

/**
 * One writer's stamps as the ChangeSet's check reads them: its stratum's position, its relation, its stamps, and the
 * statement that stamps them (StampingWriter): an action's own, or the family statement that writes a stamped nesting's
 * rows, one statement for every head it stamps (write/frontend/compile.ts familyWorkOf).
 */
export interface StampingAction {
	readonly stratum: number
	readonly relation: RelationInfo
	readonly stamps: ReadonlyArray<Stamped>
	readonly writer: Exclude<StampingWriter["kind"], "entry">
	readonly loc: SourceLoc
}

/**
 * Refuses a ChangeSet whose actions `actions` stamp a clock in two strata, a head in a stratum's own statements and in
 * its family statement too, or a reference beside no insert of its clock in its stratum (see the module's header). A
 * call's value reads no head, so it is stamped apart from nothing.
 */
export const refuseStampsApart = (actions: ReadonlyArray<StampingAction>): void => {
	/** Each head a stratum's family statement stamps, by its stratum and its spelling. */
	const family = new Set(
		actions.flatMap((a) =>
			a.writer === "family"
				? headStamped(a.stamps).map((s) => `${a.stratum}\u0000${clockText(s)}`)
				: []
		)
	)
	for (const a of actions) {
		const apart =
			a.writer === "own"
				? headStamped(a.stamps).find((s) => family.has(`${a.stratum}\u0000${clockText(s)}`))
				: undefined
		if (apart !== undefined) {
			return refusedApart(a.loc, a.relation.name, apart, "statements")
		}
	}
	/** Each clock its own stamps stamp, by its relation and field, with the stratum that stamps it. */
	const clocks = new Map<string, number>()
	for (const a of actions) {
		for (const s of headStamped(a.stamps)) {
			if (!ownStamp(s, a.relation.name)) {
				continue
			}
			const key = clockText(s)
			const earlier = clocks.get(key)
			if (earlier !== undefined && earlier !== a.stratum) {
				return refusedApart(a.loc, a.relation.name, s, "strata")
			}
			clocks.set(key, a.stratum)
		}
	}
	for (const a of actions) {
		for (const s of headStamped(a.stamps)) {
			if (clocks.get(clockText(s)) !== a.stratum) {
				return refused(a.loc, a.relation.name, s.field.name, {
					kind: "clockUnstamped",
					clock: clockText(s)
				})
			}
		}
	}
}
