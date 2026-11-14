import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { boundedShrink } from "@bjornpagen/testing/shrink"
import { type Swarm, swarm, swarmChoice } from "@bjornpagen/testing/swarm"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import type { LawId } from "#compiler/core/ids.ts"
import {
	accumulated,
	Bits,
	bits,
	drawn as drawnField,
	natural,
	pg
} from "#compiler/public/fields.ts"
import {
	counted,
	fin,
	fold,
	Monoid,
	mutable,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { int4, setOf, Tag } from "#test/pg/fin/folds.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, deepEquals, defined, unorderedEqual } from "#test/support/assert.ts"
import { type FoldMonoid, foldStoredOf } from "#test/support/families/fold.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { applicationOf, member, openServedDb } from "#test/support/served-db.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A counted SET keyed by three fields and a name, its owner keyed by (text, text, int), with folds over it, under
 * grizzle's writes on PostgreSQL 19rc2: qti-pie's Attribute (package, path, start, name), counted under its Node.
 *
 * Owner(a, b, k) holds a label its caller writes, its drawn count `n`, and three ends: the Monoid.sum of its members'
 * `x`, the Monoid.or of their `flags` (a set over folds.ts's roster Tag), and the Monoid.count of those whose `x` is
 * positive (a selection). Attr(a, b, k, name) is its counted member, `x` and `flags` its steps. Owners are drawn from
 * two values of each text and two of `k`, so owners that share their first two key fields and differ only in the third
 * are common; names from three.
 *
 * A case is up to five ChangeSets, each drawn from the model's state under a swarm of their kinds: owners inserted
 * with their members; members appended to stored owners; an owner inserted again with a subset of its members or with
 * a new one; members deleted (a counted member's removal moves the last member into the freed slot and refills from
 * there, README "Families"); a member moved to another owner, a delete and an insert in one ChangeSet; a member's
 * steps put; an owner's label put; and now and then a member naming no owner, or a member at a stored key with other
 * steps.
 *
 * The oracle is the fold model (test/support/families/fold.ts foldStoredOf, the reference fold folds.ts judges the
 * fold natives by, over its carriers int4 and setOf(5)): after each write every owner's count is its members' and each
 * end its members' fold, and the members are the model's set (README "Writes": a row already present is no change, a
 * counted owner's count and ends are drawn, never written, so an owner stated again with a subset of its members
 * changes nothing and one with a new member appends it). A refused write names only laws it breaks, a key's refusal
 * witnessed by that key's values in a stated row, the family's (a member naming no owner) by none (README "Errors and
 * outcomes", Witness: unreported "for a foreign key"), `every` law it names broken, or, where the family's foreign key
 * carries other containments merged into it, `some` of them, and changes nothing.
 *
 * Features: each kind of write at each state that matters to the fill: an append to an owner with members and to one
 * with none, the only member deleted and one of several, a move between owners sharing their first two key fields and
 * between others, an owner inserted again with a subset and with a new member, a step put, a label put, and each
 * refusal. A steered case is constructed to reach the situation its turn aims at (aimedWritesGen): a drawn case seldom
 * deletes an owner's only member or names an owner no write stored.
 *
 * Plant: ~/.cache/grizzle-release/KEYSTRESS/plants/counted-set-fold-ignores-third-field.patch, a counted family's
 * groups read by their key's first fields alone, must turn the property red.
 */

const Name = str.bytes(16, str.regex("^.*$", "su"))

const Owner = relation(
	"Owner",
	{
		a: Name,
		b: Name,
		k: pg.int4,
		label: pg.int4,
		n: drawnField(natural),
		total: accumulated(pg.int4, 0),
		seen: accumulated(bits(Tag), Bits.of(Tag, [])),
		positive: accumulated(natural, 0n)
	},
	["a", "b", "k"]
)

const Attr = relation(
	"Attr",
	{ a: Name, b: Name, k: pg.int4, name: Name, x: pg.int4, flags: bits(Tag) },
	["a", "b", "k", "name"]
)

const family = counted(on(Attr, "a", "b", "k"), fin(Owner, "n"))

const declaredSchema = (name: string) =>
	schema(
		name,
		[Tag, Owner, Attr],
		[
			family,
			fold(family, Monoid.sum, on(Attr, "a", "b", "k", "x"), on(Owner, "a", "b", "k", "total")),
			fold(family, Monoid.or, on(Attr, "a", "b", "k", "flags"), on(Owner, "a", "b", "k", "seen")),
			fold(
				family,
				Monoid.count,
				on(
					select(Attr, (r) => r.gt(r.x, 0)),
					"a",
					"b",
					"k"
				),
				on(Owner, "a", "b", "k", "positive")
			),
			mutable(Owner),
			mutable(Attr)
		]
	)

/** An owner's key. */
interface OwnerKey {
	readonly a: string
	readonly b: string
	readonly k: number
}

/** An owner as its caller writes it. */
interface OwnerRow extends OwnerKey {
	readonly label: number
}

/** A member as its caller writes it: its owner's key, its name, its step `x` and its set `flags` as a bit mask. */
interface AttrRow extends OwnerKey {
	readonly name: string
	readonly x: number
	readonly flags: number
}

/** What the model holds: owners and members as their callers wrote them. */
interface State {
	readonly owners: ReadonlyArray<OwnerRow>
	readonly attrs: ReadonlyArray<AttrRow>
}

/** A ChangeSet of a case: its member's kind and its facts. */
type Write =
	| {
			readonly kind: "insert"
			readonly owners: ReadonlyArray<OwnerRow>
			readonly attrs: ReadonlyArray<AttrRow>
	  }
	| { readonly kind: "delete"; readonly attrs: ReadonlyArray<AttrRow> }
	| { readonly kind: "move"; readonly from: AttrRow; readonly to: AttrRow }
	| { readonly kind: "restep"; readonly attrs: ReadonlyArray<AttrRow> }
	| { readonly kind: "relabel"; readonly owners: ReadonlyArray<OwnerRow> }

const texts = ["p", "q"] as const

const keyGen: Gen<OwnerKey> = (source) => ({
	a: source.draw(element(texts)),
	b: source.draw(element(texts)),
	k: source.draw(int(0, 1))
})

const names = ["x", "y", "z"] as const

const sameKey = (o: OwnerKey, p: OwnerKey): boolean => o.a === p.a && o.b === p.b && o.k === p.k

const sameAttrKey = (x: AttrRow, y: AttrRow): boolean => sameKey(x, y) && x.name === y.name

/** A member of `owner` named `name`, its steps drawn. */
const namedGen =
	(owner: OwnerKey, name: (typeof names)[number]): Gen<AttrRow> =>
	(source) => ({
		a: owner.a,
		b: owner.b,
		k: owner.k,
		name,
		x: source.draw(int(-1, 2)),
		flags: source.draw(int(0, 31))
	})

/** A member of `owner`, its name and steps drawn. */
const attrGen =
	(owner: OwnerKey): Gen<AttrRow> =>
	(source) =>
		source.draw(namedGen(owner, source.draw(element(names))))

/** The kinds of write, the first the one every state admits. */
const writeKinds = ["insert", "append", "delete", "move", "restep", "relabel", "again"] as const

type WriteKind = (typeof writeKinds)[number]

/** How a drawn write may break a law: not at all, a member naming no owner, or a member at a stored key. */
type Breaking = "none" | "orphan" | "clash"

const breakingGen: Gen<Breaking> = weighted([
	[8, (): Breaking => "none"],
	[1, (): Breaking => "orphan"],
	[1, (): Breaking => "clash"]
])

/** The members of an owner in a state. */
const membersOf = (state: State, o: OwnerKey): ReadonlyArray<AttrRow> =>
	Arr.filter(state.attrs, (x) => sameKey(x, o))

/** A write of `kind` from `state`; none where the state admits none of it. */
const writeGen =
	(state: State, kind: WriteKind): Gen<Option.Option<Write>> =>
	(source) => {
		const stored = state.owners
		const breaking = source.draw(breakingGen)
		const pick = <A>(xs: ReadonlyArray<A>): Option.Option<A> =>
			Arr.isReadonlyArrayNonEmpty(xs) ? Option.some(source.draw(element(xs))) : Option.none()
		const absent = (): OwnerKey => {
			const free = Arr.filter(
				Arr.flatMap(texts, (a) => Arr.flatMap(texts, (b) => Arr.map([0, 1], (k) => ({ a, b, k })))),
				(o) => !Arr.some(stored, (s) => sameKey(s, o))
			)
			return Option.getOrElse(pick(free), () => ({ a: "r", b: "r", k: 0 }))
		}
		const extra = (): ReadonlyArray<AttrRow> => {
			switch (breaking) {
				case "none":
					return []
				case "orphan":
					return [source.draw(attrGen(absent()))]
				case "clash":
					return Option.match(pick(state.attrs), {
						onNone: () => [],
						onSome: (x) => [{ ...x, x: x.x + 1 }]
					})
			}
		}
		switch (kind) {
			case "insert": {
				const owners = Arr.dedupeWith(
					source.draw(
						array((s): OwnerRow => ({ ...s.draw(keyGen), label: s.draw(int(0, 2)) }), {
							min: 1,
							max: 2
						})
					),
					sameKey
				)
				const attrs = Arr.flatMap(owners, (o) => source.draw(array(attrGen(o), { min: 0, max: 3 })))
				return Option.some({ kind, owners, attrs: [...attrs, ...extra()] })
			}
			case "append":
				return Option.map(pick(stored), (o) => ({
					kind: "insert",
					owners: [],
					attrs: [...source.draw(array(attrGen(o), { min: 1, max: 2 })), ...extra()]
				}))
			case "again":
				return Option.map(pick(stored), (o) => {
					const mine = membersOf(state, o)
					const kept = Arr.filter(mine, () => source.draw(boolean))
					return {
						kind: "insert",
						owners: [o],
						attrs: [...kept, ...(source.draw(boolean) ? [source.draw(attrGen(o))] : []), ...extra()]
					}
				})
			case "delete":
				return Option.map(pick(state.attrs), (x) => ({
					kind,
					attrs: Arr.dedupeWith(
						[x, ...Arr.filter(state.attrs, () => source.draw(int(0, 3)) === 0)],
						sameAttrKey
					)
				}))
			case "move":
				return Option.flatMap(pick(state.attrs), (from) =>
					Option.map(pick(Arr.filter(stored, (o) => !sameKey(o, from))), (o): Write => ({
						kind,
						from,
						to: { ...from, a: o.a, b: o.b, k: o.k }
					}))
				)
			case "restep":
				return Option.map(pick(state.attrs), (x) => ({
					kind,
					attrs: [{ ...x, x: source.draw(int(-1, 2)), flags: source.draw(int(0, 31)) }]
				}))
			case "relabel":
				return Option.map(pick(stored), (o) => ({
					kind,
					owners: [{ ...o, label: source.draw(int(0, 2)) }]
				}))
		}
	}

/** The law a refused write breaks, by its role. */
type Broken = "the owner's key" | "the member's key" | "the family"

/** What a write does by the model: written, leaving `next`, changed or not; or refused on the laws it breaks. */
type Verdict =
	| { readonly kind: "written"; readonly next: State; readonly changed: boolean }
	| {
			readonly kind: "refused"
			readonly broken: ReadonlySet<Broken>
			readonly keyed: ReadonlyArray<{ readonly broken: Broken; readonly row: OwnerRow | AttrRow }>
	  }

/** Rows sharing a key and differing, among `stated` and against `against`, each with its key's law. */
const clashing = <A>(
	stated: ReadonlyArray<A>,
	against: ReadonlyArray<A>,
	same: (x: A, y: A) => boolean
): ReadonlyArray<A> =>
	Arr.filter(stated, (x) => Arr.some(against, (y) => same(x, y) && !deepEquals(x, y)))

const verdictOf = (state: State, w: Write): Verdict => {
	const settle = (
		owners: ReadonlyArray<OwnerRow>,
		attrs: ReadonlyArray<AttrRow>,
		keyed: ReadonlyArray<{ readonly broken: Broken; readonly row: OwnerRow | AttrRow }>
	): Verdict => {
		const orphaned = Arr.some(attrs, (x) => !Arr.some(owners, (o) => sameKey(o, x)))
		const broken = new Set<Broken>([
			...Arr.map(keyed, (k) => k.broken),
			...(orphaned ? (["the family"] as const) : [])
		])
		if (broken.size > 0) {
			return { kind: "refused", broken, keyed }
		}
		const next = { owners, attrs }
		const same = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>) =>
			a.length === b.length && Arr.every(a, (x) => Arr.some(b, (y) => deepEquals(x, y)))
		return {
			kind: "written",
			next,
			changed: !same(owners, state.owners) || !same(attrs, state.attrs)
		}
	}
	const once = <A>(rows: ReadonlyArray<A>): ReadonlyArray<A> => Arr.dedupeWith(rows, deepEquals)
	switch (w.kind) {
		case "insert": {
			const owners = once(w.owners)
			const attrs = once(w.attrs)
			const keyed = [
				...Arr.map(clashing(owners, [...owners, ...state.owners], sameKey), (row) => ({
					broken: "the owner's key" as const,
					row
				})),
				...Arr.map(clashing(attrs, [...attrs, ...state.attrs], sameAttrKey), (row) => ({
					broken: "the member's key" as const,
					row
				}))
			]
			return settle(once([...state.owners, ...owners]), once([...state.attrs, ...attrs]), keyed)
		}
		case "delete":
			return settle(
				state.owners,
				Arr.filter(state.attrs, (x) => !Arr.some(w.attrs, (y) => sameAttrKey(x, y))),
				[]
			)
		case "move": {
			const left = Arr.filter(state.attrs, (x) => !sameAttrKey(x, w.from))
			const keyed = Arr.map(clashing([w.to], left, sameAttrKey), (row) => ({
				broken: "the member's key" as const,
				row
			}))
			return settle(state.owners, once([...left, w.to]), keyed)
		}
		case "restep":
			return settle(
				state.owners,
				[
					...Arr.filter(state.attrs, (x) => !Arr.some(w.attrs, (y) => sameAttrKey(x, y))),
					...w.attrs
				],
				[]
			)
		case "relabel":
			return settle(
				[
					...Arr.filter(state.owners, (o) => !Arr.some(w.owners, (p) => sameKey(o, p))),
					...w.owners
				],
				state.attrs,
				[]
			)
	}
}

/** A case: up to five writes, each drawn from the state the model leaves, under a swarm of write kinds. */
const caseGen: Gen<ReadonlyArray<Write>> = (source) => {
	const kinds: Swarm<WriteKind> = source.draw(swarm(writeKinds))
	let state: State = { owners: [], attrs: [] }
	const writes: Array<Write> = []
	for (let left = source.draw(int(1, 5)); left > 0; left -= 1) {
		const kind = Arr.isReadonlyArrayNonEmpty(state.owners)
			? source.draw(swarmChoice(kinds, writeKinds))
			: "insert"
		const w = source.draw(writeGen(state, kind))
		if (Option.isNone(w)) {
			continue
		}
		writes.push(w.value)
		const v = verdictOf(state, w.value)
		state = v.kind === "written" ? v.next : state
	}
	return writes
}

const sumMonoid: FoldMonoid = { name: "sum", least: 0n }
const orMonoid: FoldMonoid = { name: "or", least: 0n }
const countMonoid: FoldMonoid = { name: "count", least: 0n }

/** An owner's end under a monoid: the reference fold of its members' steps (fold.ts foldStoredOf). */
const endOf = (
	m: FoldMonoid,
	members: ReadonlyArray<AttrRow>,
	step: (x: AttrRow) => { readonly x: bigint; readonly selected: boolean }
): bigint =>
	Arr.headNonEmpty(
		defined(
			foldStoredOf(m, [
				{ owner: 0, members: Arr.map(members, (x, member) => ({ member, ...step(x) })) }
			]).owners[0],
			"the owner's fold"
		).end
	)

/** The rows the model stores, each as tableState reads it. */
const ownerRowsOf = (state: State): ReadonlyArray<Readonly<Record<string, unknown>>> =>
	Arr.map(state.owners, (o) => {
		const mine = membersOf(state, o)
		return {
			a: o.a,
			b: o.b,
			k: o.k,
			label: o.label,
			n: BigInt(mine.length),
			total: int4.toHost(endOf(sumMonoid, mine, (x) => ({ x: BigInt(x.x), selected: true }))),
			seen: setOf(5).toHost(endOf(orMonoid, mine, (x) => ({ x: BigInt(x.flags), selected: true }))),
			positive: endOf(countMonoid, mine, (x) => ({ x: 0n, selected: x.x > 0 }))
		}
	})

const attrRowOf = (x: AttrRow): Readonly<Record<string, unknown>> => ({
	a: x.a,
	b: x.b,
	k: x.k,
	name: x.name,
	x: x.x,
	flags: setOf(5).toHost(BigInt(x.flags))
})

const ownerFact = (o: OwnerRow): Readonly<Record<string, unknown>> => ({
	a: o.a,
	b: o.b,
	k: o.k,
	label: o.label
})

type Situation =
	| "owners inserted with their members"
	| "a member appended to an owner with members"
	| "a member appended to an owner with none"
	| "an owner inserted again with a subset of its members"
	| "an owner inserted again with a new member"
	| "the only member deleted"
	| "a member of several deleted"
	| "a member moved to an owner differing in the third key field alone"
	| "a member moved to another owner"
	| "a member's steps put"
	| "an owner's label put"
	| "a member naming no owner refused"
	| "a member at a stored key with other steps refused"

const situations: Arr.NonEmptyReadonlyArray<Situation> = [
	"owners inserted with their members",
	"a member appended to an owner with members",
	"a member appended to an owner with none",
	"an owner inserted again with a subset of its members",
	"an owner inserted again with a new member",
	"the only member deleted",
	"a member of several deleted",
	"a member moved to an owner differing in the third key field alone",
	"a member moved to another owner",
	"a member's steps put",
	"an owner's label put",
	"a member naming no owner refused",
	"a member at a stored key with other steps refused"
]

/** The situations one judged write reaches, from the state before it. */
const situationsOf = (state: State, w: Write, v: Verdict): ReadonlyArray<Situation> => {
	if (v.kind === "refused") {
		return [
			...(v.broken.has("the family") ? (["a member naming no owner refused"] as const) : []),
			...(v.broken.has("the member's key")
				? (["a member at a stored key with other steps refused"] as const)
				: [])
		]
	}
	switch (w.kind) {
		case "insert": {
			const fresh = Arr.filter(w.owners, (o) => !Arr.some(state.owners, (s) => sameKey(s, o)))
			const again = Arr.filter(w.owners, (o) => Arr.some(state.owners, (s) => sameKey(s, o)))
			const appendedTo = Arr.filter(
				state.owners,
				(o) =>
					!Arr.some(w.owners, (p) => sameKey(p, o)) &&
					Arr.some(w.attrs, (x) => sameKey(x, o) && !Arr.some(state.attrs, (y) => deepEquals(x, y)))
			)
			return [
				...(Arr.isReadonlyArrayNonEmpty(fresh) && Arr.isReadonlyArrayNonEmpty(w.attrs)
					? (["owners inserted with their members"] as const)
					: []),
				...Arr.map(appendedTo, (o): Situation =>
					Arr.isReadonlyArrayNonEmpty(membersOf(state, o))
						? "a member appended to an owner with members"
						: "a member appended to an owner with none"
				),
				...Arr.flatMap(again, (o): ReadonlyArray<Situation> => {
					const stated = Arr.filter(w.attrs, (x) => sameKey(x, o))
					const adds = Arr.some(stated, (x) => !Arr.some(state.attrs, (y) => deepEquals(x, y)))
					return adds
						? ["an owner inserted again with a new member"]
						: stated.length < membersOf(state, o).length
							? ["an owner inserted again with a subset of its members"]
							: []
				})
			]
		}
		case "delete":
			return Arr.map(w.attrs, (x): Situation =>
				membersOf(state, x).length === 1 ? "the only member deleted" : "a member of several deleted"
			)
		case "move":
			return [
				w.from.a === w.to.a && w.from.b === w.to.b
					? "a member moved to an owner differing in the third key field alone"
					: "a member moved to another owner"
			]
		case "restep":
			return ["a member's steps put"]
		case "relabel":
			return ["an owner's label put"]
	}
}

/** A steered case's owners: `sharing` and `third`, apart in `k` alone, `other`, and `unstored`, never stored. */
const sharing: OwnerKey = { a: "p", b: "q", k: 0 }
const third: OwnerKey = { a: "p", b: "q", k: 1 }
const other: OwnerKey = { a: "q", b: "p", k: 0 }
const unstored: OwnerKey = { a: "q", b: "q", k: 0 }

/**
 * The writes a steered case runs to reach `situation`: `sharing`, `third` and `other` inserted, `sharing` with members
 * `x` and `y` and `other` with its only member `x`, which reaches owners inserted with their members; then the one
 * write that reaches `situation` from there. Labels and steps are drawn; the situations noted are still computed from
 * the writes (situationsOf), so a note never claims what the case does not hold.
 */
const aimedWritesGen =
	(situation: Situation): Gen<ReadonlyArray<Write>> =>
	(source) => {
		const label = () => source.draw(int(0, 2))
		const stored: OwnerRow = { ...sharing, label: label() }
		const x = source.draw(namedGen(sharing, "x"))
		const y = source.draw(namedGen(sharing, "y"))
		const only = source.draw(namedGen(other, "x"))
		const seeded: Write = {
			kind: "insert",
			owners: [stored, { ...third, label: label() }, { ...other, label: label() }],
			attrs: [x, y, only]
		}
		const appended = (attrs: ReadonlyArray<AttrRow>): Write => ({
			kind: "insert",
			owners: [],
			attrs
		})
		const next = ((): ReadonlyArray<Write> => {
			switch (situation) {
				case "owners inserted with their members":
					return []
				case "a member appended to an owner with members":
					return [appended([source.draw(namedGen(sharing, "z"))])]
				case "a member appended to an owner with none":
					return [appended([source.draw(namedGen(third, "x"))])]
				case "an owner inserted again with a subset of its members":
					return [{ kind: "insert", owners: [stored], attrs: [x] }]
				case "an owner inserted again with a new member":
					return [
						{ kind: "insert", owners: [stored], attrs: [x, source.draw(namedGen(sharing, "z"))] }
					]
				case "the only member deleted":
					return [{ kind: "delete", attrs: [only] }]
				case "a member of several deleted":
					return [{ kind: "delete", attrs: [x] }]
				case "a member moved to an owner differing in the third key field alone":
					return [{ kind: "move", from: x, to: { ...x, ...third } }]
				case "a member moved to another owner":
					return [{ kind: "move", from: y, to: { ...y, ...other } }]
				case "a member's steps put":
					return [{ kind: "restep", attrs: [source.draw(namedGen(sharing, "x"))] }]
				case "an owner's label put":
					return [{ kind: "relabel", owners: [{ ...sharing, label: label() }] }]
				case "a member naming no owner refused":
					return [appended([source.draw(namedGen(unstored, "x"))])]
				case "a member at a stored key with other steps refused":
					return [appended([{ ...x, x: x.x + 1 }])]
			}
		})()
		return [seeded, ...next]
	}

/**
 * The steered case: the drawn one, or, where its turn aims at a situation (Case.steering), the writes that reach it
 * (aimedWritesGen), so the steered phase reaches every situation by construction and the cases of one window reach
 * distinct ones.
 */
const aimedCase = (drawnCase: ReadonlyArray<Write>, c: Case<Situation>): ReadonlyArray<Write> =>
	Option.match(
		Option.flatMap(c.steering, (pending) => Arr.findFirst(situations, (s) => pending.aimed(s))),
		{ onNone: () => drawnCase, onSome: (situation) => c.draw(aimedWritesGen(situation)) }
	)

layer(Substrate.layer, { excludeTestServices: true })(
	"a counted set keyed by three fields and a name",
	(it) => {
		it.effect(
			"stores each owner's count and folds of exactly the model's members after every insert, delete, move and refill",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const declared = declaredSchema("CountedSet")
						const done = yield* installMigrated(declared, {
							ambient: ordinarySession,
							label: "countedset",
							logins: [fullWorld(declared, {}).server],
							extensions: []
						})
						const value = declaredSchema(done.schema)
						const world = fullWorld(value, {})
						const names = namesOf(done)
						const lawNames = lawNamesOf(value)
						const lawOf: { readonly [B in Broken]: LawId } = {
							"the owner's key": lawNames.primaryKeyLaw({ name: Owner.name }),
							"the member's key": lawNames.primaryKeyLaw({ name: Attr.name }),
							"the family": lawNames.lawOf(family)
						}
						const s = yield* Substrate
						const db = yield* openServedDb(done, world.server.roles.app, {})
						const loaded = yield* db.load({
							insert: ChangeSet.empty(value).insert(Owner, []).insert(Attr, []),
							delete: ChangeSet.empty(value).delete(Attr, []),
							move: ChangeSet.empty(value).delete(Attr, []).insert(Attr, []),
							restep: ChangeSet.empty(value).put(Attr, []),
							relabel: ChangeSet.empty(value).put(Owner, [])
						})
						return yield* explore(
							{
								suite: "pg/fin/counted-set",
								draw: drawn(caseGen),
								literal: Formatter.format,
								coverage: required<Situation>(situations, { cases: 96, sense: notesOnly }),
								kept: [],
								runs: 24,
								shrink: boundedShrink(40),
								concurrency: 1,
								steerEvery: 8,
								caseHang,
								oracle: {
									kind: "specification",
									name: "the reference fold of each owner's members (test/support/families/fold.ts foldStoredOf) over the README's set of members"
								}
							},
							(drawnCase, c) =>
								Effect.gen(function* () {
									const writes = aimedCase(drawnCase, c)
									yield* s.admin.query(`TRUNCATE ${names.table(Attr)}, ${names.table(Owner)}`, [])
									let state: State = { owners: [], attrs: [] }
									for (const [i, w] of writes.entries()) {
										const label = `write ${String(i)} ${Formatter.format(w)}`
										const verdict = verdictOf(state, w)
										const facts = (() => {
											switch (w.kind) {
												case "insert":
													return {
														insert: {
															Owner: Arr.map(w.owners, ownerFact),
															Attr: Arr.map(w.attrs, attrRowOf)
														}
													}
												case "delete":
													return { delete: { Attr: Arr.map(w.attrs, attrRowOf) } }
												case "move":
													return {
														delete: { Attr: [attrRowOf(w.from)] },
														insert: { Attr: [attrRowOf(w.to)] }
													}
												case "restep":
													return { put: { Attr: Arr.map(w.attrs, attrRowOf) } }
												case "relabel":
													return { put: { Owner: Arr.map(w.owners, ownerFact) } }
											}
										})()
										const outcome: ApplyOutcome<unknown> = yield* applicationOf(
											db.ctx,
											member(loaded, w.kind)
										)({ params: {}, facts })
										if (verdict.kind === "refused") {
											if (outcome.kind !== "invariant-rejected") {
												return assert.fail(
													`${label}: it breaks ${Formatter.format([...verdict.broken])}, so it is invariant-rejected, not ${outcome.kind}`
												)
											}
											const allowed = new Set(Arr.map([...verdict.broken], (b) => lawOf[b]))
											const named = Arr.map(outcome.refused.laws, names.reported)
											switch (outcome.refused.kind) {
												case "every":
													for (const law of named) {
														assert.ok(
															allowed.has(law),
															`${label}: it names ${law}, which it does not break`
														)
													}
													break
												case "some":
													assert.ok(
														Arr.some(named, (law) => allowed.has(law)),
														`${label}: of ${Formatter.format(named)} it names none it breaks`
													)
													break
												case "first":
												case "above":
													return assert.fail(
														`${label}: a key's or a family's refusal is decided, not ${outcome.refused.kind}`
													)
											}
											const keyNamed = Arr.filter(verdict.keyed, (x) =>
												named.includes(lawOf[x.broken])
											)
											const witness = outcome.witness
											if (Arr.isReadonlyArrayNonEmpty(keyNamed)) {
												if (witness.kind === "unreported") {
													return assert.fail(
														`${label}: a key its stated rows break reports no witness: ${Formatter.format(outcome)}, the rows ${Formatter.format(keyNamed)}`
													)
												}
												assert.ok(
													Arr.some(keyNamed, (x) => {
														const keyFields =
															x.broken === "the owner's key"
																? ["a", "b", "k"]
																: ["a", "b", "k", "name"]
														const row: Readonly<Record<string, unknown>> = { ...x.row }
														return (
															witness.relation ===
																(x.broken === "the owner's key" ? "Owner" : "Attr") &&
															deepEquals<unknown>(
																witness.values,
																Rec.fromEntries(Arr.map(keyFields, (f) => [f, row[f]] as const))
															)
														)
													}),
													`${label}: the witness ${Formatter.format(witness)} is the key of a stated row that breaks it`
												)
											} else {
												assert.equal(
													witness.kind,
													"unreported",
													`${label}: a family's refusal names no row`
												)
											}
										} else {
											assert.equal(outcome.kind, verdict.changed ? "accepted" : "no-change", label)
										}
										c.noteAll(situationsOf(state, w, verdict))
										state = verdict.kind === "written" ? verdict.next : state
										const owners = yield* tableState(done, Owner)
										unorderedEqual<Readonly<Record<string, unknown>>>(
											owners,
											ownerRowsOf(state),
											`the owners after ${label}`
										)
										const attrs = yield* tableState(done, Attr)
										unorderedEqual<Readonly<Record<string, unknown>>>(
											attrs,
											Arr.map(state.attrs, attrRowOf),
											`the members after ${label}`
										)
									}
								})
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
