import { Refusal } from "#compiler/core/canonical.ts"
import type { InstantRule, PlaceRule } from "#compiler/core/causes.ts"
/**
 * How a ChangeSet's writes meet the schema's instants (ir/instant.ts): each action's rows, as its source delivers them,
 * state some instant fields and leave the others out, and every refusal of how a write writes an instant is made here,
 * once, from the classifier's roles (analysis/theory/instants.ts):
 *
 * - an insert leaves a clock out, which it stamps, and states none (`clockStated`); a reference it leaves out is stamped
 *   by its clock's stamp source, and one with none is refused (`unstampable`); no stamp reads a child the same insert
 *   stamps (`childStamped`);
 * - a put states every instant of its rows, a clock never (`clockStated`), and a delete states every instant
 *   (`unstated`), each from a stored instant, which only a query's term of instant's type is (check/member.ts): no host
 *   row carries an instant (frontend/compile.ts carriedOf);
 * - an insert stamps in the one statement that writes its rows (`StampingWriter`): its own, or its relation's family
 *   statement, which stamps every row of its nesting (write/family/additions.ts); never through a query entry's
 *   precheck (`stampedApart`, statements);
 * - a ChangeSet stamps each clock in one stratum (`stampedApart`, strata), and a reference it stamps beside an insert of
 *   its clock in that stratum (`clockUnstamped`). A later stratum reads the stamped rows back as stored instants.
 *
 * A place (ir/instant.ts PlaceHead) is stamped as a clock is, by its own head at its group, and refused as PlaceRefused:
 * no put or delete writes its relation (`written`), its group holds no field the same insert stamps (`groupStamped`),
 * and one call stamps it in one statement (`stampedApart`). No member head holds a place, as none holds a field grizzle
 * writes (check/member.ts), so an insert's rows state none.
 *
 * What a stratum's statements stamp together is the plan's to keep in one statement (write/schedule/plan.ts).
 */
import { CompileError } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { WriteOp } from "#compiler/ir/desc.ts"
import { headText, type Instants, type Stamped } from "#compiler/ir/instant.ts"
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

/** A stamp's head's spelling in a refusal: its relation and field. */
const clockText = (s: Stamped): string => headText(s.stamp.head)

/**
 * The refusal of `s`, a stamp of `relation`'s, as stamped apart: `apart` in two strata or in a stratum of several
 * statements, an instant's by its clock, a place's by itself.
 */
const refusedApart = (
	loc: SourceLoc,
	relation: string,
	s: Stamped,
	apart: "strata" | "statements"
): never =>
	s.stamp.head.kind === "clock"
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
 * instant fields its insert's rows leave out, each with its stamp source, and its relation's place, which an insert
 * always stamps; none for a put or a delete, which state every instant and write no relation with a place. Refused as
 * the module's header says.
 */
export const stampsOf = (
	instants: Instants,
	relation: RelationInfo,
	op: WriteOp,
	heading: Heading,
	writer: StampingWriter,
	loc: SourceLoc
): ReadonlyArray<Stamped> => {
	const roles = instants.roles.get(relation.name)
	const place = instants.places.get(relation.name)
	const stated = (f: LawField): boolean => heading.some((c) => c.name === f.name)
	const stamped: Array<Stamped> = []
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
		stamped.push({ field, stamp: role.stamp })
	}
	if (place !== undefined) {
		if (op !== "insert") {
			return placeRefused(loc, relation.name, place.field.name, { kind: "written", op })
		}
		stamped.push({ field: place.field, stamp: { head: place, child: place.child } })
	}
	for (const s of stamped) {
		const inChild = s.stamp.child.find((f) => stamped.some((o) => o.field.name === f.name))
		if (inChild === undefined) {
			continue
		}
		const within = `${relation.name}.${inChild.name}`
		return s.stamp.head.kind === "clock"
			? refused(loc, relation.name, s.field.name, { kind: "childStamped", stamped: within })
			: placeRefused(loc, relation.name, s.field.name, { kind: "groupStamped", stamped: within })
	}
	const [first] = stamped
	if (first !== undefined && writer.kind === "entry") {
		return refusedApart(loc, relation.name, first, "statements")
	}
	return stamped
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
		const clocks = new Set(a.stamps.map(clockText))
		for (const clock of clocks) {
			const statements = (stamping.get(clock) ?? 0) + a.statements
			const first = a.stamps.find((s) => clockText(s) === clock)
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
 * its family statement too, or a reference beside no insert of its clock in its stratum (see the module's header).
 */
export const refuseStampsApart = (actions: ReadonlyArray<StampingAction>): void => {
	/** Each head a stratum's family statement stamps, by its stratum and its spelling. */
	const family = new Set(
		actions.flatMap((a) =>
			a.writer === "family" ? a.stamps.map((s) => `${a.stratum}\u0000${clockText(s)}`) : []
		)
	)
	for (const a of actions) {
		const apart =
			a.writer === "own"
				? a.stamps.find((s) => family.has(`${a.stratum}\u0000${clockText(s)}`))
				: undefined
		if (apart !== undefined) {
			return refusedApart(a.loc, a.relation.name, apart, "statements")
		}
	}
	/** Each clock its own stamps stamp, by its relation and field, with the stratum that stamps it. */
	const clocks = new Map<string, number>()
	for (const a of actions) {
		for (const s of a.stamps) {
			const own =
				s.stamp.head.relation === a.relation.name && s.stamp.head.field.name === s.field.name
			if (!own) {
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
		for (const s of a.stamps) {
			if (clocks.get(clockText(s)) !== a.stratum) {
				return refused(a.loc, a.relation.name, s.field.name, {
					kind: "clockUnstamped",
					clock: clockText(s)
				})
			}
		}
	}
}
