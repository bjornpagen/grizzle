/**
 * Folds over families as grizzle lowers them (fin.md §4.3, w4-w7 §2.3): the reference fold every fold test judges by,
 * a second implementation of the host's fills, and the model of what PostgreSQL does with each transaction of a
 * family's rows under the fold's natives.
 *
 * A fold `fold(Φ, Monoid.m, step, end)` keeps, per plane, an accumulator before and after each member's step, and the
 * owner's end. Its natives, beside the family's own (mutate.ts):
 *
 * - `combine`, CHECK ((after = CASE WHEN φ THEN combine(before, x) ELSE before END) IS TRUE), in exact arithmetic: every
 *   after is drawn by the host and proved here, never generated, since count's, sum's and max's combine is not total in
 *   its carrier;
 * - `first slot`, the identity pin CHECK (i > 0 OR before = ι) on the member;
 * - `empty family`, the identity pin CHECK (n > 0 OR end = ι) on the owner;
 * - the predecessor axis carries each before from its predecessor's after, and the last axis each end from the last
 *   member's after: a mismatch is that axis's foreign key, 23503, at its moment.
 *
 * Values are exact: an integer carrier's in its own unit, money in cents, numeric(p, s) scaled by 10^s, and a set of
 * codes as the bit mask of its codes (bit c for code c), so one `bigint` holds every carrier's value and the reference
 * computes with no rounding. A lowering may drop a pin (`FoldLowering`), the mutants a box must kill: the fold
 * accumulator unconstrained at slot 0 is the first-slot pin's drop.
 */
import { Array as Arr } from "effect"
import type { MonoidName } from "#compiler/ir/desc.ts"
import type { Moment, Timing } from "#test/support/families/mutate.ts"
import type { Shape } from "#test/support/families/theorem.ts"

/**
 * A fold's monoid on one carrier: its name, and its identity's least value where it is max's. The reference computes
 * over exact integers, so it folds every monoid but concat, whose texts test/unit/write/concat-fill.test.ts and
 * test/unit/analysis/theory/concat.test.ts fold by their own naive concatenation.
 */
export interface FoldMonoid {
	readonly name: Exclude<MonoidName, "concat">
	/** max's identity, its carrier's least value (natural's 0, an integer's minimum, a roster's first code); 0 otherwise. */
	readonly least: bigint
}

/** A plane's value, or the planes of a twos fold: one value per plane, in plane order. */
export type Planes = Arr.NonEmptyReadonlyArray<bigint>

/** The identity of each plane: 0, the empty set, or max's least value. */
export const identityOf = (m: FoldMonoid): Planes => {
	switch (m.name) {
		case "count":
		case "sum":
		case "or":
			return [0n]
		case "twos":
			return [0n, 0n]
		case "max":
			return [m.least]
	}
}

/**
 * Each plane's after, from the befores and the step's value, in exact arithmetic: count adds one, sum adds x, or
 * unites, twos keeps (ones ∪ x, twos ∪ (ones ∩ x)), and max keeps the greater.
 */
export const combined = (m: FoldMonoid, befores: Planes, x: bigint): Planes => {
	const [first, second = 0n] = befores
	switch (m.name) {
		case "count":
			return [first + 1n]
		case "sum":
			return [first + x]
		case "or":
			return [first | x]
		case "twos":
			return [first | x, second | (first & x)]
		case "max":
			return [first > x ? first : x]
	}
}

/** One member's step: its value (count reads none), and whether the step side's selection holds of its row. */
export interface Step {
	readonly x: bigint
	readonly selected: boolean
}

/** A member's accumulators: each plane before its step and after it. */
export interface Accumulated {
	readonly before: Planes
	readonly after: Planes
}

/** A fold of one owner's members in slot order: each slot's accumulators, and the end. */
export interface Folded {
	readonly slots: ReadonlyArray<Accumulated>
	readonly end: Planes
}

/**
 * The reference fold: the identity at the first slot, each before the previous slot's after, each after the
 * combine of its before and value where the selection holds and its before elsewhere, and the end the last after,
 * the identity for no member.
 */
export const folded = (m: FoldMonoid, steps: ReadonlyArray<Step>): Folded =>
	foldedFrom(m, identityOf(m), steps)

/** The fold of the steps from `seed` in place of the identity: a fold a junk seed starts, consistent with it throughout. */
export const foldedFrom = (m: FoldMonoid, seed: Planes, steps: ReadonlyArray<Step>): Folded => {
	let at: Planes = seed
	const slots: Array<Accumulated> = []
	for (const step of steps) {
		const after = step.selected ? combined(m, at, step.x) : at
		slots.push({ before: at, after })
		at = after
	}
	return { slots, end: at }
}

/** Whether two plane lists are equal plane by plane. */
const samePlanes = (a: Planes, b: Planes): boolean =>
	a.length === b.length && Arr.every(a, (v, i) => v === b[i])

/** A member row of a folded family: the family's row (theorem.ts FamilyRow), its step, and its accumulators. */
export interface FoldRow extends Step, Accumulated {
	readonly group: number
	readonly at: number
	readonly copy: number
	readonly member: number
}

/** An owner of a folded family: its key, its count, and its fold's end. */
export interface FoldOwner {
	readonly owner: number
	readonly count: number
	readonly end: Planes
}

/** What PostgreSQL holds of a folded family: its owners and member rows, which a statement may leave lawless. */
export interface FoldStored {
	readonly owners: ReadonlyArray<FoldOwner>
	readonly rows: ReadonlyArray<FoldRow>
}

/** One owner's family as its caller writes it: its members in slot order, each with its step. */
export interface FoldFamily {
	readonly owner: number
	readonly members: ReadonlyArray<{ readonly member: number } & Step>
}

/**
 * What the host writes for families: each row's accumulators and each end the reference fold's, every copy the count;
 * from `seed` in place of the identity, the state a junk seed writes.
 */
export const foldStoredFrom = (
	m: FoldMonoid,
	families: ReadonlyArray<FoldFamily>,
	seed: Planes
): FoldStored => ({
	owners: Arr.map(families, (f) => ({
		owner: f.owner,
		count: f.members.length,
		end: foldedFrom(m, seed, f.members).end
	})),
	rows: Arr.flatMap(families, (f) => {
		const { slots } = foldedFrom(m, seed, f.members)
		return Arr.map(f.members, (s, at) => ({
			group: f.owner,
			at,
			copy: f.members.length,
			member: s.member,
			x: s.x,
			selected: s.selected,
			...Arr.getUnsafe(slots, at)
		}))
	})
})

/** What the host writes for families from the identity: the lawful state. */
export const foldStoredOf = (m: FoldMonoid, families: ReadonlyArray<FoldFamily>): FoldStored =>
	foldStoredFrom(m, families, identityOf(m))

/**
 * A native of a folded family, by the role a test names it by: the family's (its member's identity, its key, its bound,
 * its three axes, which carry the fold's copies, and the member superkey they reference) and the fold's three CHECKs.
 */
export type FoldNative =
	| "identity"
	| "key"
	| "member superkey"
	| "bound"
	| "owner axis"
	| "predecessor axis"
	| "last axis"
	| "combine"
	| "first slot"
	| "empty family"

/** A lowering of a fold: the family's shape, and whether each identity pin is emitted (the mutants drop one). */
export interface FoldLowering {
	readonly shape: Shape
	readonly firstPin: boolean
	readonly emptyPin: boolean
}

/** grizzle's lowering of a fold over a family of a shape: both pins. */
export const grizzleFold = (shape: Shape): FoldLowering => ({
	shape,
	firstPin: true,
	emptyPin: true
})

/** The SQLSTATE a native's violation is refused with. */
export const foldSqlstate = (native: FoldNative): "23505" | "23514" | "23503" => {
	switch (native) {
		case "identity":
		case "key":
		case "member superkey":
			return "23505"
		case "bound":
		case "combine":
		case "first slot":
		case "empty family":
			return "23514"
		case "owner axis":
		case "predecessor axis":
		case "last axis":
			return "23503"
	}
}

/**
 * When PostgreSQL checks a native: the last axis at COMMIT, a counted family's predecessor axis at COMMIT (swap-with-last
 * leaves a slot without its predecessor until the last member moves in), and every other at its statement.
 */
const foldTiming = (lowering: FoldLowering, native: FoldNative): Timing =>
	native === "last axis" || (native === "predecessor axis" && lowering.shape === "counted")
		? "commit"
		: "statement"

/** A native a state breaks, on the member or owner whose row it is. */
export type FoldViolation =
	| { readonly native: Exclude<FoldNative, "last axis" | "empty family">; readonly member: number }
	| { readonly native: "last axis" | "empty family"; readonly owner: number }

/** Every native the state breaks, whenever PostgreSQL checks it. */
const foldViolations = (
	m: FoldMonoid,
	lowering: FoldLowering,
	stored: FoldStored
): ReadonlyArray<FoldViolation> => {
	const ι = identityOf(m)
	const found: Array<FoldViolation> = []
	const at = (group: number, slot: number) =>
		Arr.filter(stored.rows, (r) => r.group === group && r.at === slot)
	for (const r of stored.rows) {
		const member = r.member
		if (Arr.some(stored.rows, (o) => o !== r && o.member === member)) {
			found.push({ native: "identity", member })
		}
		const twins = Arr.filter(at(r.group, r.at), (o) => o !== r)
		if (twins.length > 0) {
			found.push({ native: "key", member })
		}
		if (Arr.some(twins, (o) => samePlanes(o.after, r.after))) {
			found.push({ native: "member superkey", member })
		}
		if (r.at >= r.copy) {
			found.push({ native: "bound", member })
		}
		if (!Arr.some(stored.owners, (o) => o.owner === r.group && o.count === r.copy)) {
			found.push({ native: "owner axis", member })
		}
		if (
			r.at > 0 &&
			r.at < r.copy &&
			!Arr.some(at(r.group, r.at - 1), (p) => samePlanes(p.after, r.before))
		) {
			found.push({ native: "predecessor axis", member })
		}
		if (!samePlanes(r.after, r.selected ? combined(m, r.before, r.x) : r.before)) {
			found.push({ native: "combine", member })
		}
		if (lowering.firstPin && r.at === 0 && !samePlanes(r.before, ι)) {
			found.push({ native: "first slot", member })
		}
	}
	for (const o of stored.owners) {
		if (o.count > 0 && !Arr.some(at(o.owner, o.count - 1), (l) => samePlanes(l.after, o.end))) {
			found.push({ native: "last axis", owner: o.owner })
		}
		if (lowering.emptyPin && o.count === 0 && !samePlanes(o.end, ι)) {
			found.push({ native: "empty family", owner: o.owner })
		}
	}
	return found
}

/**
 * One statement of a folded family's transaction:
 *
 * - `create` inserts an owner with its count and end; `drop` deletes one;
 * - `count` updates an owner's count and end in one statement, the owner axis's cascade carrying the count into every
 *   copy of the old one;
 * - `insert` inserts member rows in the order listed; `delete` deletes members by key;
 * - `update` rewrites one member's slot and accumulators, swap-with-last's move of the last member into the freed slot.
 */
export type FoldStatement =
	| { readonly kind: "create"; readonly owner: FoldOwner }
	| { readonly kind: "drop"; readonly owner: number }
	| { readonly kind: "count"; readonly owner: FoldOwner }
	| { readonly kind: "insert"; readonly rows: Arr.NonEmptyReadonlyArray<FoldRow> }
	| { readonly kind: "delete"; readonly members: Arr.NonEmptyReadonlyArray<number> }
	| {
			readonly kind: "update"
			readonly member: number
			readonly at: number
			readonly before: Planes
			readonly after: Planes
	  }

/** The state a statement leaves, before any native is checked. */
export const foldApplied = (stored: FoldStored, statement: FoldStatement): FoldStored => {
	switch (statement.kind) {
		case "create":
			return { owners: [...stored.owners, statement.owner], rows: stored.rows }
		case "drop":
			return {
				owners: Arr.filter(stored.owners, (o) => o.owner !== statement.owner),
				rows: stored.rows
			}
		case "count": {
			const old = Arr.findFirst(stored.owners, (o) => o.owner === statement.owner.owner)
			if (old._tag === "None") {
				return stored
			}
			return {
				owners: Arr.map(stored.owners, (o) =>
					o.owner === statement.owner.owner ? statement.owner : o
				),
				rows: Arr.map(stored.rows, (r) =>
					r.group === statement.owner.owner && r.copy === old.value.count
						? { ...r, copy: statement.owner.count }
						: r
				)
			}
		}
		case "insert":
			return { owners: stored.owners, rows: [...stored.rows, ...statement.rows] }
		case "delete":
			return {
				owners: stored.owners,
				rows: Arr.filter(stored.rows, (r) => !statement.members.includes(r.member))
			}
		case "update":
			return {
				owners: stored.owners,
				rows: Arr.map(stored.rows, (r) =>
					r.member === statement.member
						? { ...r, at: statement.at, before: statement.before, after: statement.after }
						: r
				)
			}
	}
}

/** What the model says PostgreSQL does with a transaction: it commits to a state, or is refused at a moment. */
export type FoldPredicted =
	| { readonly kind: "committed"; readonly after: FoldStored }
	| {
			readonly kind: "refused"
			readonly moment: Moment
			readonly violations: Arr.NonEmptyReadonlyArray<FoldViolation>
	  }

/**
 * The model of one transaction over a committed state: after each statement every native checked at a statement must
 * hold of the whole state, and at COMMIT every native must.
 */
export const foldPredicted = (
	m: FoldMonoid,
	lowering: FoldLowering,
	before: FoldStored,
	statements: ReadonlyArray<FoldStatement>
): FoldPredicted => {
	let state = before
	for (const [index, statement] of statements.entries()) {
		state = foldApplied(state, statement)
		const broken = Arr.filter(
			foldViolations(m, lowering, state),
			(v) => foldTiming(lowering, v.native) === "statement"
		)
		if (Arr.isReadonlyArrayNonEmpty(broken)) {
			return { kind: "refused", moment: { kind: "statement", index }, violations: broken }
		}
	}
	const deferred = foldViolations(m, lowering, state)
	return Arr.isReadonlyArrayNonEmpty(deferred)
		? { kind: "refused", moment: { kind: "commit" }, violations: deferred }
		: { kind: "committed", after: state }
}
