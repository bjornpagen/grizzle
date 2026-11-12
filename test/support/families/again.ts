/**
 * A stored instance of a fill specification (fill.ts) inserted again, identically or with drawn differences, and the
 * README's set rule as the model of what that insert does ("Writes": "add these rows; a row already present is no
 * change", "A row holds the fields its caller writes", "A relation's rows are a set … Two rows of one relation that
 * share a key and differ elsewhere are invariant-rejected on that key"; "Families": "the insert states the owner's
 * members").
 *
 * What a fact states is fill.ts instanceFacts' fact: its caller's `v`, the owner of each counted family it is a member
 * of, and, for each sequence it owns, its members in order at the count field, each its own fact, nested; a nested
 * member's place, its owner and slot, is stated by where its owner nests it. A counted family's count and fold, an
 * index, an interval and every copy are drawn by grizzle from the rows the write leaves, never stated. So, for an
 * insert of `again` over the stored instance `stored`:
 *
 * - a stated row at a key no stored row holds is added, a counted member under a stored owner joining its family;
 * - a stated row equal to the stored row at its key, at every field it states, is no change;
 * - a stated row that differs there, in its `v`, a counted owner or its place, or as a sequence's owner whose members
 *   or any member's own fact below it differ from the stored ones, is invariant-rejected on its relation's primary key
 *   (`keyed`), and the write changes nothing; a stated row at a sequence's place, or a tree's (root, start), that a
 *   different stored row holds breaks that family's key too (`placed`).
 *
 * The differences are drawn from the stored instance by construction, each leaving a valid instance: a row's payload
 * changed, a member added to a family under one of its owners, a row and everything nested under it or naming it as a
 * counted owner removed, a member moved to another place, and another instance beside it under fresh keys. A counted
 * member is added only under mutable owners: the README fixes an immutable owner's family when the owner is inserted
 * and states no outcome for an insert joining a stored one.
 */
import { element, type Gen, int } from "@grizzle/testing/gen"
import { type Swarm, swarmChoice } from "@grizzle/testing/swarm"
import { Array as Arr, Option, Order } from "effect"
import { defined, nonEmpty } from "#test/support/assert.ts"
import {
	familyAt,
	type FamilyKind,
	type FillSpec,
	type InstanceRow,
	instanceGen,
	isSequence,
	membershipIn,
	relationAt,
	rootName,
	writtenRows
} from "#test/support/families/fill.ts"
import { upTo } from "#test/support/up-to.ts"

/** A row's membership of one family: its family, its owner, and its slot (0 in a counted family, whose order is hidden). */
type Membership = InstanceRow["memberOf"][number]

/** Where a row stands: a tree's node, a member of an ordered family, of a counted family alone, or of none. */
export type Standing = "tree node" | "ordered member" | "counted member" | "top row"

/**
 * One difference of a second insert from the stored instance:
 * - `payload`: row `id`'s `v` changed;
 * - `added`: a new row, a member of a family at the place its first membership names, every later member of each
 *   sequence it joins a slot further on;
 * - `removed`: row `id` and every row nested under it or naming it as a counted owner, each sequence closing up;
 * - `moved`: row `id` placed at `to` in `to`'s family, the sequence it leaves closing up and the one it joins opening;
 * - `beside`: another instance under fresh keys.
 */
export type Difference =
	| { readonly kind: "payload"; readonly id: number; readonly v: bigint }
	| { readonly kind: "added"; readonly row: InstanceRow }
	| { readonly kind: "removed"; readonly id: number }
	| { readonly kind: "moved"; readonly id: number; readonly to: Membership }
	| { readonly kind: "beside"; readonly rows: ReadonlyArray<InstanceRow> }

/** The kinds of difference, the first the one every instance admits. */
export const differenceKinds = ["beside", "payload", "added", "removed", "moved"] as const

type DifferenceKind = (typeof differenceKinds)[number]

/** A row's place: a tree's node, else an ordered member, else a counted member, else a top row. */
export const standingOf = (spec: FillSpec, row: InstanceRow): Standing => {
	if (Arr.some(spec.families, (f) => f.kind === "tree" && f.member === row.relation)) {
		return "tree node"
	}
	if (Arr.some(row.memberOf, (m) => familyAt(spec, m.family).kind === "ordered")) {
		return "ordered member"
	}
	return Arr.isReadonlyArrayNonEmpty(row.memberOf) ? "counted member" : "top row"
}

/** The members of family `f` under `owner`, in slot order. */
const membersUnder = (
	rows: ReadonlyArray<InstanceRow>,
	f: number,
	owner: number
): ReadonlyArray<InstanceRow> =>
	Arr.sort(
		Arr.filter(rows, (r) => membershipIn(r, f)?.owner === owner),
		Order.mapInput(Order.Number, (r: InstanceRow) => membershipIn(r, f)?.slot ?? 0)
	)

/** Every sequence's members renumbered 0 … n − 1 in their slot order, as a sequence closes up after a removal. */
const closedUp = (spec: FillSpec, rows: ReadonlyArray<InstanceRow>): ReadonlyArray<InstanceRow> =>
	Arr.map(rows, (r) => ({
		...r,
		memberOf: Arr.map(r.memberOf, (m) =>
			isSequence(familyAt(spec, m.family))
				? {
						...m,
						slot: Option.getOrElse(
							Arr.findFirstIndex(membersUnder(rows, m.family, m.owner), (x) => x.id === r.id),
							() => m.slot
						)
					}
				: m
		)
	}))

/** Row `r` with every sequence a newcomer joins at `places` opened: each member at or after a place a slot further on. */
const opened = (
	spec: FillSpec,
	r: InstanceRow,
	places: ReadonlyArray<Membership>
): InstanceRow => ({
	...r,
	memberOf: Arr.map(r.memberOf, (m) =>
		isSequence(familyAt(spec, m.family)) &&
		Arr.some(places, (p) => p.family === m.family && p.owner === m.owner && m.slot >= p.slot)
			? { ...m, slot: m.slot + 1 }
			: m
	)
})

/** The rows of `rows` left once row `id` is gone, with every row nested under one gone or naming one as its owner. */
const without = (rows: ReadonlyArray<InstanceRow>, id: number): ReadonlyArray<InstanceRow> => {
	const gone = new Set([id])
	let grew = true
	while (grew) {
		grew = false
		for (const r of rows) {
			if (!gone.has(r.id) && Arr.some(r.memberOf, (m) => gone.has(m.owner))) {
				gone.add(r.id)
				grew = true
			}
		}
	}
	return Arr.filter(rows, (r) => !gone.has(r.id))
}

/** The instance a difference makes of `rows`. */
export const differed = (
	spec: FillSpec,
	rows: ReadonlyArray<InstanceRow>,
	d: Difference
): ReadonlyArray<InstanceRow> => {
	switch (d.kind) {
		case "payload":
			return Arr.map(rows, (r) => (r.id === d.id ? { ...r, v: d.v } : r))
		case "added":
			return [...Arr.map(rows, (r) => opened(spec, r, d.row.memberOf)), d.row]
		case "removed":
			return closedUp(spec, without(rows, d.id))
		case "moved": {
			const left = closedUp(
				spec,
				Arr.map(rows, (r) =>
					r.id === d.id
						? { ...r, memberOf: Arr.filter(r.memberOf, (m) => m.family !== d.to.family) }
						: r
				)
			)
			return Arr.map(left, (r) =>
				r.id === d.id ? { ...r, memberOf: [...r.memberOf, d.to] } : opened(spec, r, [d.to])
			)
		}
		case "beside":
			return [...rows, ...d.rows]
	}
}

/** What a second insert does by the set rule: written, leaving `rows`, changed or not; or refused on its keys. */
export type AgainVerdict =
	| {
			readonly kind: "written"
			readonly rows: ReadonlyArray<InstanceRow>
			readonly added: ReadonlyArray<InstanceRow>
	  }
	| {
			readonly kind: "refused"
			readonly keyed: Arr.NonEmptyReadonlyArray<InstanceRow>
			readonly placed: ReadonlyArray<{ readonly row: InstanceRow; readonly family: number }>
	  }

/** Whether two rows state one membership set: one owner per counted family, one owner and slot per sequence. */
const sameMemberships = (spec: FillSpec, a: InstanceRow, b: InstanceRow): boolean =>
	a.memberOf.length === b.memberOf.length &&
	Arr.every(a.memberOf, (m) => {
		const other = membershipIn(b, m.family)
		return (
			other !== undefined &&
			other.owner === m.owner &&
			(!isSequence(familyAt(spec, m.family)) || other.slot === m.slot)
		)
	})

/** A tree node's (root, start) by the reference writer, keyed by its id, for each relation a tree holds. */
const treePlaces = (
	spec: FillSpec,
	rows: ReadonlyArray<InstanceRow>
): ReadonlyMap<number, { readonly family: number; readonly at: string }> => {
	const written = writtenRows(spec, rows)
	return new Map(
		Arr.flatMap(rows, (r) =>
			Arr.flatMap(spec.families, (f, k) => {
				if (f.kind !== "tree" || f.member !== r.relation) {
					return []
				}
				const fields = defined(written.get(r.id), "a written row")
				return [
					[r.id, { family: k, at: `${String(fields[rootName(k)])}/${String(fields["start"])}` }]
				] as const
			})
		)
	)
}

/** The set rule's verdict on inserting `again` over the stored instance `stored` (see the module's header). */
export const againVerdict = (
	spec: FillSpec,
	stored: ReadonlyArray<InstanceRow>,
	again: ReadonlyArray<InstanceRow>
): AgainVerdict => {
	const storedOf = new Map(Arr.map(stored, (r) => [r.id, r] as const))
	const collides = (x: InstanceRow): boolean => {
		const s = storedOf.get(x.id)
		if (s === undefined) {
			return false
		}
		if (s.relation !== x.relation || s.v !== x.v || !sameMemberships(spec, x, s)) {
			return true
		}
		return Arr.some(spec.families, (f, k) => {
			if (!isSequence(f) || f.owner !== x.relation) {
				return false
			}
			const now = membersUnder(again, k, x.id)
			const was = membersUnder(stored, k, x.id)
			return (
				now.length !== was.length || Arr.some(now, (y, i) => y.id !== was[i]?.id || collides(y))
			)
		})
	}
	const keyed = Arr.filter(again, collides)
	if (!Arr.isReadonlyArrayNonEmpty(keyed)) {
		const added = Arr.filter(again, (x) => !storedOf.has(x.id))
		return { kind: "written", rows: [...stored, ...added], added }
	}
	const storedPlaces = treePlaces(spec, stored)
	const againPlaces = treePlaces(spec, again)
	const placed = Arr.flatMap(again, (y) => [
		...Arr.flatMap(y.memberOf, (m) =>
			isSequence(familyAt(spec, m.family)) &&
			Arr.some(stored, (z) => {
				const at = membershipIn(z, m.family)
				return z.id !== y.id && at?.owner === m.owner && at.slot === m.slot
			})
				? [{ row: y, family: m.family }]
				: []
		),
		...Option.match(Option.fromUndefinedOr(againPlaces.get(y.id)), {
			onNone: () => [],
			onSome: (p) =>
				Arr.some(
					[...storedPlaces],
					([id, q]) => id !== y.id && q.family === p.family && q.at === p.at
				)
					? [{ row: y, family: p.family }]
					: []
		})
	])
	return { kind: "refused", keyed, placed }
}

/**
 * What a difference aims at: a payload at a place, a member added, removed or moved in a family of a kind, a top row
 * left out, or another instance beside.
 */
export type Target =
	| { readonly kind: "payload"; readonly place: Standing }
	| { readonly kind: "added" | "removed" | "moved"; readonly family: FamilyKind }
	| { readonly kind: "left out" }
	| { readonly kind: "beside" }

/** The ids handed out so far: a new row's key is the next, above every key the case has stored. */
export interface Keys {
	next: number
}

/** A fresh key. */
const freshKey = (keys: Keys): number => {
	keys.next += 1
	return keys.next
}

/** The `v`s a row is drawn with: small values around zero, as instanceGen draws them. */
const values: Arr.NonEmptyReadonlyArray<bigint> = [-2n, -1n, 0n, 1n, 2n, 3n]

/** A tree node's descendants in tree family `f`, itself among them. */
const subtree = (rows: ReadonlyArray<InstanceRow>, f: number, id: number): ReadonlySet<number> => {
	const out = new Set([id])
	let grew = true
	while (grew) {
		grew = false
		for (const r of rows) {
			const m = membershipIn(r, f)
			if (m !== undefined && out.has(m.owner) && !out.has(r.id)) {
				out.add(r.id)
				grew = true
			}
		}
	}
	return out
}

/**
 * A new member of family `f` under `owner`, at a drawn slot of a sequence; it names an owner of each other family its
 * relation is a member of, a mutable one for a counted family, nested under one for an ordered family and a root of
 * its own for a tree; none where some such family has no owner to name.
 */
const newMember = (
	spec: FillSpec,
	rows: ReadonlyArray<InstanceRow>,
	f: number,
	owner: InstanceRow,
	keys: Keys
): Option.Option<Gen<InstanceRow>> => {
	const family = familyAt(spec, f)
	const others = Arr.flatMap(spec.families, (g, k) =>
		k !== f && g.member === family.member && g.kind !== "tree"
			? [
					{
						family: k,
						kind: g.kind,
						owners: Arr.filter(
							rows,
							(r) =>
								r.relation === g.owner &&
								(g.kind !== "counted" || relationAt(spec, g.owner).mutable)
						)
					}
				]
			: []
	)
	if (Arr.some(others, (o) => !Arr.isReadonlyArrayNonEmpty(o.owners))) {
		return Option.none()
	}
	return Option.some((source) => {
		const at = (k: number, under: InstanceRow): Membership => ({
			family: k,
			owner: under.id,
			slot: isSequence(familyAt(spec, k))
				? source.draw(int(0, membersUnder(rows, k, under.id).length))
				: 0
		})
		return {
			relation: family.member,
			id: freshKey(keys),
			v: source.draw(element(values)),
			memberOf: [
				at(f, owner),
				...Arr.map(others, (o) => at(o.family, source.draw(element(nonEmpty(o.owners)))))
			]
		}
	})
}

/** The places a stored row of `rows` may move to in family `f`: every other place of the family, none for a root. */
const movesOf = (
	spec: FillSpec,
	rows: ReadonlyArray<InstanceRow>,
	x: InstanceRow,
	f: number
): ReadonlyArray<Membership> => {
	const family = familyAt(spec, f)
	const from = membershipIn(x, f)
	if (from === undefined) {
		return []
	}
	const barred = family.kind === "tree" ? subtree(rows, f, x.id) : new Set<number>()
	return Arr.flatMap(
		Arr.filter(rows, (o) => o.relation === family.owner && !barred.has(o.id)),
		(o: InstanceRow): ReadonlyArray<Membership> => {
			if (family.kind === "counted") {
				return o.id === from.owner ? [] : [{ family: f, owner: o.id, slot: 0 }]
			}
			const room = Arr.filter(membersUnder(rows, f, o.id), (y) => y.id !== x.id).length
			return Arr.flatMap(
				upTo(room + 1, (slot) => slot),
				(slot): ReadonlyArray<Membership> =>
					o.id === from.owner && slot === from.slot ? [] : [{ family: f, owner: o.id, slot }]
			)
		}
	)
}

/** Every target `rows` admits: a payload at each place a row stands, a family's member added, removed or moved. */
export const targetsOf = (
	spec: FillSpec,
	rows: ReadonlyArray<InstanceRow>,
	keys: Keys
): Arr.NonEmptyReadonlyArray<Target> => [
	{ kind: "beside" },
	...Arr.map(Arr.dedupe(Arr.map(rows, (r) => standingOf(spec, r))), (place) => ({
		kind: "payload" as const,
		place
	})),
	...(Arr.some(rows, (r) => standingOf(spec, r) === "top row")
		? [{ kind: "left out" as const }]
		: []),
	...Arr.flatMap(["added", "removed", "moved"] as const, (kind) =>
		Arr.map(
			Arr.dedupe(
				Arr.flatMap(spec.families, (f, k) =>
					Arr.isReadonlyArrayNonEmpty(candidates(spec, rows, keys, { kind, family: f.kind }, k))
						? [f.kind]
						: []
				)
			),
			(family) => ({ kind, family })
		)
	)
]

/** The differences of family `k` aiming at a member target, each a generator of one: none where it is not of the target's kind. */
const candidates = (
	spec: FillSpec,
	rows: ReadonlyArray<InstanceRow>,
	keys: Keys,
	target: { readonly kind: "added" | "removed" | "moved"; readonly family: FamilyKind },
	k: number
): ReadonlyArray<Gen<Difference>> => {
	const family = familyAt(spec, k)
	if (family.kind !== target.family) {
		return []
	}
	switch (target.kind) {
		case "added":
			return Arr.flatMap(
				Arr.filter(
					rows,
					(o) =>
						o.relation === family.owner &&
						(family.kind !== "counted" || relationAt(spec, family.owner).mutable)
				),
				(o: InstanceRow): ReadonlyArray<Gen<Difference>> =>
					Option.match(newMember(spec, rows, k, o, keys), {
						onNone: () => [],
						onSome: (row) => [(source): Difference => ({ kind: "added", row: source.draw(row) })]
					})
			)
		case "removed":
			return Arr.flatMap(rows, (x) =>
				membershipIn(x, k) === undefined ? [] : [(): Difference => ({ kind: "removed", id: x.id })]
			)
		case "moved":
			return Arr.flatMap(rows, (x) => {
				const to = movesOf(spec, rows, x, k)
				return Arr.isReadonlyArrayNonEmpty(to)
					? [(source): Difference => ({ kind: "moved", id: x.id, to: source.draw(element(to)) })]
					: []
			})
	}
}

/** Another instance of `spec` under fresh keys, every id it names past the case's. */
const besideGen =
	(spec: FillSpec, keys: Keys): Gen<Difference> =>
	(source) => {
		const base = keys.next
		const rows = Arr.map(source.draw(instanceGen(spec)), (r) => ({
			...r,
			id: r.id + base,
			memberOf: Arr.map(r.memberOf, (m) => ({ ...m, owner: m.owner + base }))
		}))
		keys.next = Arr.reduce(rows, base, (most, r) => Math.max(most, r.id))
		return { kind: "beside", rows }
	}

/** A difference of `rows` at `target`, which `targetsOf` gave for them. */
export const differenceAt =
	(spec: FillSpec, rows: ReadonlyArray<InstanceRow>, keys: Keys, target: Target): Gen<Difference> =>
	(source) => {
		switch (target.kind) {
			case "beside":
				return source.draw(besideGen(spec, keys))
			case "payload": {
				const x = source.draw(
					element(
						nonEmpty(
							Arr.filter(rows, (r) => standingOf(spec, r) === target.place),
							"a row at the target's place"
						)
					)
				)
				const v = source.draw(
					element(
						nonEmpty(
							Arr.filter(values, (value) => value !== x.v),
							"another value"
						)
					)
				)
				return { kind: "payload", id: x.id, v }
			}
			case "left out":
				return {
					kind: "removed",
					id: source.draw(
						element(
							nonEmpty(
								Arr.filter(rows, (r) => standingOf(spec, r) === "top row"),
								"a top row"
							)
						)
					).id
				}
			case "added":
			case "removed":
			case "moved": {
				const all = nonEmpty(
					Arr.flatMap(spec.families, (_, k) => candidates(spec, rows, keys, target, k)),
					"a difference at the target"
				)
				return source.draw(source.draw(element(all)))
			}
		}
	}

/** A drawn difference of `rows`: its kind by the case's swarm among those `rows` admits, then a target of that kind. */
export const differenceGen =
	(
		spec: FillSpec,
		rows: ReadonlyArray<InstanceRow>,
		keys: Keys,
		kinds: Swarm<DifferenceKind>
	): Gen<Difference> =>
	(source) => {
		const targets = targetsOf(spec, rows, keys)
		const kindOf = (t: Target): DifferenceKind => (t.kind === "left out" ? "removed" : t.kind)
		const admitted = nonEmpty(
			Arr.filter(differenceKinds, (k) => Arr.some(targets, (t) => kindOf(t) === k)),
			"a kind of difference"
		)
		const kind = source.draw(swarmChoice(kinds, admitted))
		const target = source.draw(
			element(
				nonEmpty(
					Arr.filter(targets, (t) => kindOf(t) === kind),
					"a target of the kind"
				)
			)
		)
		return source.draw(differenceAt(spec, rows, keys, target))
	}
