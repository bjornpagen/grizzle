import { array, boolean, element, type Gen, int, map } from "@grizzle/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import { expect, projection, selected } from "#test/support/laws/model.ts"
import {
	fieldsOfSource,
	inDomain,
	outsideContract,
	pastType,
	pool,
	pooled
} from "#test/support/worlds/generate/domain.ts"
import { headingOf } from "#test/support/worlds/generate/entries.ts"
import type { Strata, Variant } from "#test/support/worlds/invalid/kinds.ts"
import { nextDraw, withSerial, withSerials } from "#test/support/worlds/model/draws.ts"
import {
	classifyEntry,
	uniqueFacts,
	entryRows,
	factKeySet,
	isMember,
	sameFact,
	selectionOf
} from "#test/support/worlds/model/host.ts"
import {
	keysOf,
	serialHead,
	type Written,
	writtenOf
} from "#test/support/worlds/model/session/writes.ts"

import type {
	BaseSpec,
	ContextFacts,
	EntryOp,
	EntrySpec,
	FieldSpec,
	HostFact,
	InvalidKind,
	ModelState,
	RoleSpec,
	SideSpec,
	HostValue
} from "#test/support/worlds/model/types.ts"

/** Who writes: a role and the facts its claims hold. */
export interface FactWriter {
	readonly role: RoleSpec
	readonly facts: ContextFacts
}

type QueryWritten = Extract<Written, { readonly kind: "query" }>

/** The target fact a fact through a query entry fills to, or none when a context it is filled from holds no fact. */
const fillOf = (w: QueryWritten, fact: HostFact, facts: ContextFacts): Option.Option<HostFact> => {
	const supplied = Arr.flatMap(
		Rec.toEntries(w.head),
		([head, { field }]): ReadonlyArray<readonly [string, HostValue]> => {
			const value = fact[head]
			return value === undefined ? [] : [[field, value]]
		}
	)
	const fills = Arr.map(
		Rec.toEntries(w.fills),
		([field, fill]): Option.Option<readonly [string, HostValue]> =>
			fill.kind === "literal"
				? Option.some([field, fill.value])
				: Option.map(
						Option.fromUndefinedOr(facts[fill.context]?.[fill.field]),
						(value) => [field, value] as const
					)
	)
	return Option.map(Option.all(fills), (fixed) => Rec.fromEntries([...supplied, ...fixed]))
}

/** A fact through an entry: a target fact inside it, or outside it (a fill lacking its context, or no member). */
type Filled = { readonly kind: "inside"; readonly fact: HostFact } | { readonly kind: "outside" }

const insideFacts = (filled: ReadonlyArray<Filled>): ReadonlyArray<HostFact> =>
	Arr.flatMap(filled, (f) => (f.kind === "inside" ? [f.fact] : []))

/** A target fact as the entry's head names it: the head fields that supply a field of it. */
const inHead = (w: QueryWritten, fact: HostFact): HostFact =>
	Rec.fromEntries(
		Arr.flatMap(Rec.toEntries(w.head), ([head, { field }]) => {
			const value = fact[field]
			return value === undefined ? [] : [[head, value] as const]
		})
	)

/** Whether a role sees a fact of a base relation: through an entry holding it whole, or a writable entry it is in. */
const visible = (
	state: ModelState,
	writer: FactWriter,
	relation: string,
	fact: HostFact
): boolean =>
	Arr.some(Rec.toEntries(writer.role.entries), ([name, entry]) => {
		const c = classifyEntry(state.install.base, entry)
		return (
			c.kind === "writable" &&
			c.target === relation &&
			isMember(state, writer.role.name, name, writer.facts, fact)
		)
	})

/**
 * Whether a fact of a relation holds a value its integer field's domain refuses: one past a contract's bounds, which
 * the domain's CHECK refuses, or past its integer type's range, which the encoder refuses.
 */
const domainRefused = (state: ModelState, relation: string, fact: HostFact): boolean =>
	Arr.some(fieldsOfSource(state.install.base, relation), (f) => {
		const v = fact[f.name]
		return (
			(f.domain.kind === "contract" || f.domain.kind === "integer") &&
			v !== undefined &&
			!inDomain(f.domain, v)
		)
	})

/** A reference a law makes: from a fact of its source side to its target side. */
interface Reference {
	readonly from: SideSpec
	readonly to: SideSpec
}

/** The references a law makes from a fact of its source side to its target side: its containments'. */
const referencesOf = (state: ModelState): ReadonlyArray<Reference> =>
	Arr.flatMap(state.install.base.laws, (law) =>
		law.kind === "contained" ? [{ from: law.source, to: law.target }] : []
	)

/** The invalid kinds the references of facts written to `relation` carry: a target deleted (none holds it), or hidden. */
const referenceKinds = (
	state: ModelState,
	writer: FactWriter,
	relation: string,
	facts: ReadonlyArray<HostFact>,
	inserted: ReadonlyArray<{ readonly relation: string; readonly fact: HostFact }>
): ReadonlyArray<InvalidKind> =>
	Arr.flatMap(
		Arr.filter(referencesOf(state), (r) => r.from.relation === relation),
		(r: Reference) =>
			Arr.flatMap(facts, (f): ReadonlyArray<InvalidKind> => {
				if (
					!selected(f, selectionOf(r.from)) ||
					Arr.some(r.from.fields, (x) => f[x] === undefined)
				) {
					return []
				}
				const wanted = projection(f, r.from.fields)
				const meets = (g: HostFact): boolean =>
					selected(g, selectionOf(r.to)) &&
					Arr.every(r.to.fields, (x) => g[x] !== undefined) &&
					projection(g, r.to.fields) === wanted
				const targets = Arr.filter(state.reality.get(r.to.relation) ?? [], meets)
				const added = Arr.some(inserted, (i) => i.relation === r.to.relation && meets(i.fact))
				if (targets.length === 0) {
					return added ? [] : ["fact:deleted-reference"]
				}
				return Arr.some(targets, (g) => visible(state, writer, r.to.relation, g))
					? []
					: ["fact:hidden-reference"]
			})
	)

/** What one op is through its written relation: the target and the target facts it writes, or none for an unwritten one. */
interface Judged {
	readonly op: EntryOp
	readonly written: Written
	readonly filled: ReadonlyArray<Filled>
}

const judge = (state: ModelState, writer: FactWriter, op: EntryOp, written: Written): Judged => ({
	op,
	written,
	filled:
		written.kind === "whole"
			? Arr.map(op.facts, (fact): Filled => ({ kind: "inside", fact }))
			: Arr.map(op.facts, (f): Filled =>
					Option.match(fillOf(written, f, writer.facts), {
						onNone: (): Filled => ({ kind: "outside" }),
						onSome: (fact): Filled =>
							isMember(state, writer.role.name, written.entry, writer.facts, fact)
								? { kind: "inside", fact }
								: { kind: "outside" }
					})
				)
})

/**
 * The invalid kinds of one insert or put through a written relation: a value its integer field's domain refuses, a fact
 * outside the entry, a key a fact outside a query entry holds, a reference deleted or hidden. A delete carries none.
 */
const writeKinds = (
	state: ModelState,
	writer: FactWriter,
	j: Judged,
	inserted: ReadonlyArray<{ readonly relation: string; readonly fact: HostFact }>
): ReadonlyArray<InvalidKind> => {
	if (j.op.kind === "delete") {
		return []
	}
	const w = j.written
	const inside = insideFacts(j.filled)
	const mapped =
		w.kind === "whole"
			? j.op.facts
			: Arr.flatMap(j.op.facts, (f) => Arr.fromOption(fillOf(w, f, writer.facts)))
	return [
		...(Arr.some(mapped, (f) => domainRefused(state, w.target, f))
			? (["fact:domain-refused"] as const)
			: []),
		...(Arr.some(j.filled, (f) => f.kind === "outside") ? (["fact:outside-world"] as const) : []),
		...(w.kind === "query" && hiddenCollision(state, writer, w, inside)
			? (["fact:hidden-key-collision"] as const)
			: []),
		...referenceKinds(state, writer, w.target, inside, inserted)
	]
}

/** The facts of a query entry's target outside the entry. */
const outsideOf = (
	state: ModelState,
	writer: FactWriter,
	w: QueryWritten
): ReadonlyArray<HostFact> =>
	Arr.filter(
		state.reality.get(w.target) ?? [],
		(g) => !isMember(state, writer.role.name, w.entry, writer.facts, g)
	)

/** Whether a fact through a query entry holds a key a fact of its target outside the entry holds. */
const hiddenCollision = (
	state: ModelState,
	writer: FactWriter,
	w: QueryWritten,
	inside: ReadonlyArray<HostFact>
): boolean => {
	const occupants = outsideOf(state, writer, w)
	return Arr.some(keysOf(state.install.base, w.target), (key) =>
		Arr.some(inside, (f) =>
			Arr.some(
				occupants,
				(g) =>
					Arr.every(key, (x) => f[x] !== undefined) &&
					projection(f, key) === projection(g, key) &&
					!sameFact(f, g)
			)
		)
	)
}

/**
 * The invalid kinds of a ChangeSet's ops through a writer's role, as the README's rules name its facts: a fact twice in
 * one input, a fact the entry cannot hold, a key a fact
 * outside the entry holds, a reference to a fact the role cannot see or to none at all, and a final state some law
 * refuses. An op through a relation the role does not write carries no fact kind: its refusal is the relation's.
 */
export const opKinds = (
	state: ModelState,
	writer: FactWriter,
	ops: ReadonlyArray<EntryOp>
): ReadonlyArray<InvalidKind> => {
	const kinds = new Set<InvalidKind>()
	for (const op of ops) {
		if (distinctCount(op.facts) < op.facts.length) {
			kinds.add("fact:duplicate-in-input")
		}
	}
	const base = state.install.base
	const written = writtenOf(base, writer.role)
	for (const op of ops) {
		for (const w of Arr.filter(written, (x) => x.entry === op.relation)) {
			for (const k of serialKinds(base, w, op)) {
				kinds.add(k)
			}
		}
	}
	const judged = Arr.flatMap(ops, (op) =>
		Option.match(
			Arr.findFirst(written, (x) => x.entry === op.relation),
			{ onNone: (): ReadonlyArray<Judged> => [], onSome: (w) => [judge(state, writer, op, w)] }
		)
	)
	const inserted = Arr.flatMap(judged, (j) =>
		j.op.kind === "delete"
			? []
			: Arr.map(insideFacts(j.filled), (fact) => ({ relation: j.written.target, fact }))
	)
	for (const k of Arr.flatMap(judged, (j) => writeKinds(state, writer, j, inserted))) {
		kinds.add(k)
	}
	let draws = nextDraw(state)
	const baseOps = Arr.map(judged, (j) => {
		const drew = withSerials(base, j.written.target, insideFacts(j.filled), draws)
		draws = drew.next
		return { relation: j.written.target, kind: j.op.kind, facts: drew.facts }
	})
	if (
		baseOps.length > 0 &&
		expect(state.host, state.reality, baseOps).kind === "invariant-rejected"
	) {
		kinds.add("fact:law-broken")
	}
	return [...kinds]
}

/** A fact without the fields `fields`. */
const without = (fact: HostFact, fields: ReadonlyArray<string>): HostFact =>
	Rec.filter(fact, (_, field) => !fields.includes(field))

/**
 * The serial kinds of an insertion through its written relation (writes.ts serialHead): a fact leaving out some of the
 * classed serial fields and not all, and a fact leaving out a serial field the entry's filter reads.
 */
const serialKinds = (base: BaseSpec, w: Written, op: EntryOp): ReadonlyArray<InvalidKind> => {
	if (op.kind !== "insert") {
		return []
	}
	const { classed, filtered } = serialHead(base, w)
	const carried = (fact: HostFact, fields: ReadonlyArray<string>): number =>
		Arr.filter(fields, (f) => fact[f] !== undefined).length
	return [
		...(Arr.some(op.facts, (f) => carried(f, classed) > 0 && carried(f, classed) < classed.length)
			? (["fact:partial-serial"] as const)
			: []),
		...(Arr.some(op.facts, (f) => carried(f, filtered) < filtered.length)
			? (["fact:filtered-serial-omitted"] as const)
			: [])
	]
}

/** The invalid kinds of one fact a direct writer inserts into a base relation: a reference deleted or hidden, a law broken. */
export const directFactKinds = (
	state: ModelState,
	writer: FactWriter,
	relation: string,
	fact: HostFact,
	view: ReadonlyMap<string, ReadonlyArray<HostFact>>
): ReadonlyArray<InvalidKind> => {
	const kinds = new Set<InvalidKind>(referenceKinds(state, writer, relation, [fact], []))
	if (domainRefused(state, relation, fact)) {
		kinds.add("fact:domain-refused")
	}
	const facts = [withSerial(state.install.base, relation, fact, nextDraw(state)).fact]
	if (
		expect(state.host, view, [{ relation, kind: "insert", facts }]).kind === "invariant-rejected"
	) {
		kinds.add("fact:law-broken")
	}
	return [...kinds]
}

/** A fact of a heading from the pools, each field at a drawn index. */
const pooledFact = (heading: ReadonlyArray<FieldSpec>, picks: ReadonlyArray<number>): HostFact =>
	Rec.fromEntries(
		Arr.map(heading, (f, i) => [
			f.name,
			pooled(f.domain, picks[i % Math.max(1, picks.length)] ?? 0)
		])
	)

/** A fact with one field set to another pool value. */
const mutated = (
	heading: ReadonlyArray<FieldSpec>,
	fact: HostFact,
	at: number,
	value: number
): HostFact => {
	const field = heading[at % heading.length]
	return field === undefined ? fact : { ...fact, [field.name]: pooled(field.domain, value) }
}

/** The facts a writer may meet through an entry, in its heading: its rows, and for a writable query entry, the target facts outside it. */
const metFacts = (
	state: ModelState,
	writer: FactWriter,
	entry: string
): { readonly rows: ReadonlyArray<HostFact>; readonly hidden: ReadonlyArray<HostFact> } => {
	if (!Rec.has(writer.role.entries, entry)) {
		return { rows: [], hidden: [] }
	}
	const rows = entryRows(state, writer.role.name, entry, writer.facts)
	const hidden = Option.match(
		Arr.findFirst(writtenOf(state.install.base, writer.role), (x) => x.entry === entry),
		{
			onNone: (): ReadonlyArray<HostFact> => [],
			onSome: (w) =>
				w.kind === "whole"
					? []
					: Arr.map(
							Arr.filter(
								state.reality.get(w.target) ?? [],
								(g) => !isMember(state, writer.role.name, w.entry, writer.facts, g)
							),
							(g) => inHead(w, g)
						)
		}
	)
	return { rows, hidden }
}

/** The candidate facts of an entry: its rows and hidden facts, each with one field changed, then facts from the pools. */
const candidates = (
	heading: ReadonlyArray<FieldSpec>,
	met: { readonly rows: ReadonlyArray<HostFact>; readonly hidden: ReadonlyArray<HostFact> },
	picks: ReadonlyArray<number>
): ReadonlyArray<HostFact> => {
	const known = Arr.filter([...met.hidden, ...met.rows], (f) =>
		Arr.every(heading, (h) => f[h.name] !== undefined)
	)
	return [
		...Arr.flatMap(known, (f) =>
			Arr.flatMap(heading, (h) =>
				Arr.map(pool(h.domain), (value): HostFact => ({ ...f, [h.name]: value }))
			)
		),
		...Arr.map(picks, (p, i) => pooledFact(heading, [p, p + i + 1, p + 2 * i + 3, p + 5]))
	]
}

/** How many distinct facts an input holds: equal facts are one, as grizzle collapses them before it counts. */
const distinctCount = (facts: ReadonlyArray<HostFact>): number => factKeySet(facts).size

/** The fact kinds an op is searched for, each with its class: from another state or world (stale), or anything (wild). */
const searchedKinds: ReadonlyArray<readonly [InvalidKind, "stale" | "wild"]> = [
	["fact:hidden-key-collision", "stale"],
	["fact:hidden-reference", "stale"],
	["fact:deleted-reference", "stale"],
	["fact:law-broken", "wild"],
	["fact:outside-world", "wild"]
]

/** A contract field of a heading and the value just past its bounds; none for a heading without a contract. */
const refusedField = (
	heading: ReadonlyArray<FieldSpec>
): Option.Option<{ readonly at: FieldSpec; readonly outside: HostValue }> =>
	Option.flatMap(
		Arr.findFirst(heading, (f) => f.domain.kind === "contract"),
		(at) => Option.map(Arr.head(outsideContract(at.domain)), (outside) => ({ at, outside }))
	)

/**
 * The values of a heading's fields just past their domains that a Db write may carry: past a contract's bounds, which
 * the domain's CHECK refuses as the statement casts it, and past an integer type's range, which the encoder refuses
 * before any SQL.
 */
const refusedValues = (
	heading: ReadonlyArray<FieldSpec>
): ReadonlyArray<{ readonly at: FieldSpec; readonly outside: HostValue }> =>
	Arr.flatMap(heading, (at) =>
		Arr.map([...outsideContract(at.domain), ...pastType(at.domain)], (outside) => ({ at, outside }))
	)

/**
 * One drawn op: its kind, the pool picks of its facts, one per fact, and whether it reaches past the first facts it
 * meets: a delete names the facts outside its entry where it meets both, and an insert takes an entry row at a fresh
 * key.
 */
interface OpDraw {
	readonly kind: EntryOp["kind"]
	readonly picks: Arr.NonEmptyReadonlyArray<number>
	readonly met: boolean
}

const opDrawGen: Gen<OpDraw> = (source) => {
	const kind = source.draw(element<EntryOp["kind"]>(["insert", "delete", "put"]))
	const first = source.draw(int(0, 63))
	const rest = source.draw(array(int(0, 63), { min: 0, max: 2 }))
	return { kind, picks: [first, ...rest], met: source.draw(boolean) }
}

/** The picks the candidate search draws its pool facts with: fixed, so what a state offers is the state's alone. */
const searchPicks: ReadonlyArray<number> = [0, 5, 11, 23, 42]

/**
 * Where a reference a law makes from an entry's target points (referencesOf): the entry's fields that carry its source
 * fields, and the values at its target fields of each stored fact of its target side the writer sees.
 */
interface Pointing {
	/** Per source field, the entry's fields that carry it (a head may carry one target field twice). */
	readonly fields: ReadonlyArray<Arr.NonEmptyReadonlyArray<string>>
	readonly targets: Arr.NonEmptyReadonlyArray<ReadonlyArray<HostValue>>
}

/**
 * The references a fact written through an entry makes, each where a lawful write points it: at a stored fact the
 * writer sees. None for an entry the role does not write, a reference whose source fields the entry fills itself (its
 * fills, not the caller, decide them), or one no visible fact satisfies.
 */
const pointingsOf = (
	state: ModelState,
	writer: FactWriter,
	entry: string
): ReadonlyArray<Pointing> =>
	Option.match(
		Arr.findFirst(writtenOf(state.install.base, writer.role), (x) => x.entry === entry),
		{
			onNone: (): ReadonlyArray<Pointing> => [],
			onSome: (w) => {
				const carrying = (field: string): ReadonlyArray<string> =>
					w.kind === "whole"
						? [field]
						: Arr.flatMap(Rec.toEntries(w.head), ([head, h]) => (h.field === field ? [head] : []))
				return Arr.flatMap(
					Arr.filter(referencesOf(state), (r) => r.from.relation === w.target),
					(r: Reference): ReadonlyArray<Pointing> => {
						const fields = Arr.flatMap(r.from.fields, (f) => {
							const carried = carrying(f)
							return Arr.isReadonlyArrayNonEmpty(carried) ? [carried] : []
						})
						const targets = Arr.flatMap(state.reality.get(r.to.relation) ?? [], (g) => {
							const values = Arr.flatMap(r.to.fields, (x) => {
								const v = g[x]
								return v === undefined ? [] : [v]
							})
							return selected(g, selectionOf(r.to)) &&
								values.length === r.to.fields.length &&
								visible(state, writer, r.to.relation, g)
								? [values]
								: []
						})
						return fields.length === r.from.fields.length && Arr.isReadonlyArrayNonEmpty(targets)
							? [{ fields, targets }]
							: []
					}
				)
			}
		}
	)

/** A fact pointed by each pointing at one of its targets, each drawn. */
const pointed =
	(fact: HostFact, pointings: ReadonlyArray<Pointing>): Gen<HostFact> =>
	(source) =>
		Arr.reduce(pointings, fact, (f, p) => {
			const target = source.draw(element(p.targets))
			return {
				...f,
				...Rec.fromEntries(
					Arr.flatMap(p.fields, (carried, j) => {
						const v = target[j]
						return v === undefined ? [] : Arr.map(carried, (field) => [field, v] as const)
					})
				)
			}
		})

/**
 * The fields of an entry's heading a new fact may take a fresh value at and stay where an entry row stands: its target's
 * key fields as the heading carries them (a query entry's keyed head fields), but those a reference points (pointingsOf).
 */
const freshFields = (
	state: ModelState,
	writer: FactWriter,
	entry: string,
	pointings: ReadonlyArray<Pointing>
): ReadonlyArray<string> => {
	const pointed = new Set(
		Arr.flatMap(pointings, (p) => Arr.flatMap(p.fields, (carried) => carried))
	)
	return Option.match(
		Arr.findFirst(writtenOf(state.install.base, writer.role), (x) => x.entry === entry),
		{
			onNone: (): ReadonlyArray<string> => [],
			onSome: (w) =>
				Arr.filter(
					w.kind === "whole"
						? (Option.getOrUndefined(
								Arr.findFirst(state.install.base.relations, (r) => r.name === w.target)
							)?.key ?? [])
						: Arr.flatMap(Rec.toEntries(w.head), ([head, h]) => (h.kind === "keyed" ? [head] : [])),
					(f) => !pointed.has(f)
				)
		}
	)
}

/**
 * The facts of a live op through an entry: an insert's half the time an entry row at a fresh key (freshFields), so it
 * stands where the row stands, inside the entry and pointing where the row points, and otherwise from the pools, each
 * reference it makes pointed at a stored fact the writer sees (pointingsOf), as a lawful write's; a put's from the
 * entry's rows; a delete's from the facts it meets, the entry's rows or, half the time where both are there, its
 * target's facts outside it (each in another of the role's entries or in none, so a delete meets facts outside its
 * world and the hidden ones, which it leaves as they are); an op with no fact to meet takes the pools', pointed
 * likewise. A reference to a hidden fact or to none is the stale strata's. Half the time an insert's facts are
 * generated additions: each leaves out every `classed` serial head field (writes.ts serialHead), the identity's to
 * draw, its other fields from the same pools, so facts that differed only there become equal.
 */
const liveFacts =
	(
		heading: ReadonlyArray<FieldSpec>,
		met: { readonly rows: ReadonlyArray<HostFact>; readonly hidden: ReadonlyArray<HostFact> },
		pointings: ReadonlyArray<Pointing>,
		fresh: ReadonlyArray<string>,
		classed: ReadonlyArray<string>,
		draw: OpDraw
	): Gen<Arr.NonEmptyReadonlyArray<HostFact>> =>
	(source) => {
		const pools =
			draw.kind === "delete" ? [met.rows, met.hidden] : draw.kind === "put" ? [met.rows] : []
		const [firstSource, secondSource] = Arr.filter(pools, Arr.isReadonlyArrayNonEmpty)
		const [firstRow, ...moreRows] = met.rows
		const fields = Arr.filter(heading, (h) => fresh.includes(h.name))
		const rekeyed = (p: number): HostFact | undefined =>
			firstRow === undefined || fields.length === 0 || !draw.met
				? undefined
				: {
						...source.draw(element([firstRow, ...moreRows])),
						...Rec.fromEntries(
							Arr.map(fields, (h, i) => [h.name, pooled(h.domain, p + i + 1)] as const)
						)
					}
		if (firstSource === undefined) {
			const facts = Arr.map(
				draw.picks,
				(p, i) =>
					rekeyed(p) ?? source.draw(pointed(pooledFact(heading, [p, p + i + 1, p + 3]), pointings))
			)
			const generated =
				draw.kind === "insert" && Arr.isReadonlyArrayNonEmpty(classed) && source.draw(boolean)
			return generated ? Arr.map(facts, (f) => without(f, classed)) : facts
		}
		const meeting = draw.met && secondSource !== undefined ? secondSource : firstSource
		return Arr.map(draw.picks, () => source.draw(element(meeting)))
	}

/** A live op through an entry of a writer's role (liveFacts). */
export const liveOpGen = (
	state: ModelState,
	writer: FactWriter,
	entry: { readonly name: string; readonly spec: EntrySpec }
): Gen<EntryOp> => {
	const heading = headingOf(state.install.base, entry.spec)
	const met = metFacts(state, writer, entry.name)
	const pointings = pointingsOf(state, writer, entry.name)
	const fresh = freshFields(state, writer, entry.name, pointings)
	const { classed } = serialOf(state, writer, entry.name)
	return (source) => {
		const draw = source.draw(opDrawGen)
		return {
			relation: entry.name,
			kind: draw.kind,
			facts: dedupe(source.draw(liveFacts(heading, met, pointings, fresh, classed, draw)))
		}
	}
}

/** The serial head fields of the relation a writer's role writes as `entry` (writes.ts serialHead); none for another. */
const serialOf = (
	state: ModelState,
	writer: FactWriter,
	entry: string
): { readonly classed: ReadonlyArray<string>; readonly filtered: ReadonlyArray<string> } =>
	Option.match(
		Arr.findFirst(writtenOf(state.install.base, writer.role), (w) => w.entry === entry),
		{
			onNone: () => ({ classed: [], filtered: [] }),
			onSome: (w) => serialHead(state.install.base, w)
		}
	)

/**
 * The ops through an entry of a writer's role, stratified. Live: liveFacts' (a delete's from the facts it meets, inside
 * or outside the entry, a put's from its rows, an insert's from the pools). Wild: a fact twice in one input, a deletion of more distinct facts than the limit (where the heading
 * has a field to count them through: additions past it would first meet a key they share), a value just past a
 * contract's bounds or an integer type's range (each the classifier confirms for the entry), and inserts of a fact that
 * breaks a law or that the entry cannot hold; stale: inserts of a fact holding a key outside the entry, or referring to a hidden or a deleted fact.
 * Each searched kind is offered exactly when one of the candidates (the entry's rows and the facts outside it, each with
 * one field changed, and facts from the pools) is classified so, and draws only those: every draw is of its kind.
 */
export const opStrata = (
	state: ModelState,
	writer: FactWriter,
	entry: { readonly name: string; readonly spec: EntrySpec }
): Strata<EntryOp> => {
	const heading = headingOf(state.install.base, entry.spec)
	const met = metFacts(state, writer, entry.name)
	const pointings = pointingsOf(state, writer, entry.name)
	const fresh = freshFields(state, writer, entry.name, pointings)
	const { classed, filtered } = serialOf(state, writer, entry.name)
	const factsOf = (draw: OpDraw): Gen<Arr.NonEmptyReadonlyArray<HostFact>> =>
		liveFacts(heading, met, pointings, fresh, classed, draw)
	const op = (kind: EntryOp["kind"], facts: ReadonlyArray<HostFact>): EntryOp => ({
		relation: entry.name,
		kind,
		facts
	})
	/** An insert's kinds: an insert or a put of one fact is how a candidate is judged. */
	const kindsOf = (o: EntryOp): ReadonlyArray<InvalidKind> => opKinds(state, writer, [o])
	const written = Arr.some(
		writtenOf(state.install.base, writer.role),
		(w) => w.entry === entry.name
	)
	const searched = written ? candidates(heading, met, searchPicks) : []
	const judged = Arr.map(searched, (f) => ({ fact: f, kinds: kindsOf(op("insert", [f])) }))
	const found = (kind: InvalidKind): ReadonlyArray<Variant<EntryOp>> => {
		const [first, ...rest] = Arr.flatMap(judged, (j) => (j.kinds.includes(kind) ? [j.fact] : []))
		return first === undefined
			? []
			: [{ invalid: kind, gen: map(element([first, ...rest]), (f) => op("insert", [f])) }]
	}
	const refused = Arr.filter(refusedValues(heading), ({ at, outside }) =>
		kindsOf(op("insert", [{ ...pooledFact(heading, [0, 1, 3]), [at.name]: outside }])).includes(
			"fact:domain-refused"
		)
	)
	const ofClass = (cls: "stale" | "wild"): ReadonlyArray<Variant<EntryOp>> =>
		Arr.flatMap(searchedKinds, ([kind, c]) => (c === cls ? found(kind) : []))
	/**
	 * An insert of a pool fact leaving out serial fields as grizzle refuses: the first classed field alone, so some are
	 * left out and not all; or a serial field the filter reads. Each is offered where the classifier confirms it.
	 */
	const serialVariant = (
		invalid: "fact:partial-serial" | "fact:filtered-serial-omitted",
		omitted: ReadonlyArray<string>
	): ReadonlyArray<Variant<EntryOp>> => {
		const left = (p: number): EntryOp =>
			op("insert", [without(pooledFact(heading, [p, p + 1, p + 3]), omitted)])
		return kindsOf(left(0)).includes(invalid)
			? [{ invalid, gen: (source) => left(source.draw(int(0, 63))) }]
			: []
	}
	const [firstClassed] = classed
	const [firstFiltered] = filtered
	const serialVariants: ReadonlyArray<Variant<EntryOp>> = [
		...(firstClassed === undefined ? [] : serialVariant("fact:partial-serial", [firstClassed])),
		...(firstFiltered === undefined
			? []
			: serialVariant("fact:filtered-serial-omitted", [firstFiltered]))
	]
	return {
		live: [liveOpGen(state, writer, entry)],
		stale: ofClass("stale"),
		wild: [
			{
				invalid: "fact:duplicate-in-input",
				gen: (source) => {
					const draw = source.draw(opDrawGen)
					const [first] = source.draw(factsOf(draw))
					return op(draw.kind, [first, first])
				}
			},
			...Arr.match(refused, {
				onEmpty: (): ReadonlyArray<Variant<EntryOp>> => [],
				onNonEmpty: (all): ReadonlyArray<Variant<EntryOp>> => [
					{
						invalid: "fact:domain-refused",
						gen: (source) => {
							const draw = source.draw(opDrawGen)
							const { at, outside } = source.draw(element(all))
							const [first] = source.draw(factsOf(draw))
							return op("insert", [{ ...first, [at.name]: outside }])
						}
					}
				]
			}),
			...serialVariants,
			...ofClass("wild")
		]
	}
}

/** The facts, each once, first kept. */
const dedupe = (facts: ReadonlyArray<HostFact>): ReadonlyArray<HostFact> => uniqueFacts(facts)

/**
 * A fact of a relation of the base (a derived one included, which a direct writer may try to write) from the pools, the
 * stored facts, a stored fact with one field changed, or with a contract field just outside its bounds.
 */
export const baseFactGen = (state: ModelState, relation: string): Gen<HostFact> => {
	const heading = fieldsOfSource(state.install.base, relation)
	const existing =
		state.reality.get(relation) ??
		(Rec.has(state.derived, relation) ? state.derived[relation] : undefined) ??
		[]
	const refused = refusedField(heading)
	const modes = ["fresh", "stored", "changed", "refused"] as const
	return (source) => {
		const mode = source.draw(element(modes))
		const picks = source.draw(array(int(0, 63), { min: 3, max: 3 }))
		const fresh = pooledFact(heading, picks)
		const stored = (): Option.Option<HostFact> =>
			Arr.isReadonlyArrayNonEmpty(existing)
				? Option.some(source.draw(element(existing)))
				: Option.none()
		const byMode: { readonly [M in (typeof modes)[number]]: () => HostFact } = {
			fresh: () => fresh,
			stored: () => Option.getOrElse(stored(), () => fresh),
			changed: () =>
				Option.match(stored(), {
					onNone: () => fresh,
					onSome: (f) => mutated(heading, f, picks[0] ?? 0, picks[1] ?? 0)
				}),
			refused: () =>
				Option.match(refused, {
					onNone: () => fresh,
					onSome: ({ at, outside }): HostFact => ({ ...fresh, [at.name]: outside })
				})
		}
		return byMode[mode]()
	}
}
