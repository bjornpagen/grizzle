import { Refusal } from "#compiler/core/canonical.ts"
import type { InstantRule } from "#compiler/core/causes.ts"
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
 * - an insert stamps in one statement: one written whole, by no family statement and through no query entry's
 *   precheck (`stampedApart`, statements);
 * - a ChangeSet stamps each clock in one stratum (`stampedApart`, strata), and a reference it stamps beside an insert of
 *   its clock in that stratum (`clockUnstamped`). A later stratum reads the stamped rows back as stored instants.
 *
 * What a stratum's statements stamp together is the plan's to keep in one statement (write/schedule/plan.ts).
 */
import { CompileError } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { WriteOp } from "#compiler/ir/desc.ts"
import type { Instants, Stamped } from "#compiler/ir/instant.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import type { Heading } from "#compiler/ir/rel.ts"

/** The refusal of `relation`'s instant field `field` by `rule`, at `loc`. */
const refused = (loc: SourceLoc, relation: string, field: string, rule: InstantRule): never => {
	throw new Refusal(CompileError.make({ _tag: "InstantRefused", at: loc, relation, field, rule }))
}

/** A clock's spelling in a refusal: its relation and field. */
const clockText = (s: Stamped): string => `${s.stamp.clock.relation}.${s.stamp.clock.field.name}`

/**
 * What an action of `op` over `relation` stamps, its source delivering `heading`, written in one statement where
 * `alone` (no family statement and no query entry's precheck beside it): the instant fields its insert's rows leave out,
 * each with its stamp source; none for a put or a delete, which state every one. Refused as the module's header says.
 */
export const stampsOf = (
	instants: Instants,
	relation: RelationInfo,
	op: WriteOp,
	heading: Heading,
	alone: boolean,
	loc: SourceLoc
): ReadonlyArray<Stamped> => {
	const roles = instants.roles.get(relation.name)
	if (roles === undefined) {
		return []
	}
	const stated = (f: LawField): boolean => heading.some((c) => c.name === f.name)
	const stamped: Array<Stamped> = []
	for (const field of relation.fields) {
		const role = roles.get(field.name)
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
	for (const s of stamped) {
		const inChild = s.stamp.child.find((f) => stamped.some((o) => o.field.name === f.name))
		if (inChild !== undefined) {
			return refused(loc, relation.name, s.field.name, {
				kind: "childStamped",
				stamped: `${relation.name}.${inChild.name}`
			})
		}
	}
	const [first] = stamped
	if (first !== undefined && !alone) {
		return refused(loc, relation.name, first.field.name, {
			kind: "stampedApart",
			clock: clockText(first),
			apart: "statements"
		})
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
			const [first] = a.stamps
			if (statements > 1 && first !== undefined) {
				return refused(a.loc, a.relation.name, first.field.name, {
					kind: "stampedApart",
					clock,
					apart: "statements"
				})
			}
			stamping.set(clock, statements)
		}
	}
}

/** One action's stamps as the ChangeSet's check reads them: its stratum's position, its relation, and its stamps. */
export interface StampingAction {
	readonly stratum: number
	readonly relation: RelationInfo
	readonly stamps: ReadonlyArray<Stamped>
	readonly loc: SourceLoc
}

/**
 * Refuses a ChangeSet whose actions `actions` stamp a clock in two strata, or a reference beside no insert of its
 * clock in its stratum (see the module's header).
 */
export const refuseStampsApart = (actions: ReadonlyArray<StampingAction>): void => {
	/** Each clock its own stamps stamp, by its relation and field, with the stratum that stamps it. */
	const clocks = new Map<string, number>()
	for (const a of actions) {
		for (const s of a.stamps) {
			const own =
				s.stamp.clock.relation === a.relation.name && s.stamp.clock.field.name === s.field.name
			if (!own) {
				continue
			}
			const key = clockText(s)
			const earlier = clocks.get(key)
			if (earlier !== undefined && earlier !== a.stratum) {
				return refused(a.loc, a.relation.name, s.field.name, {
					kind: "stampedApart",
					clock: key,
					apart: "strata"
				})
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
