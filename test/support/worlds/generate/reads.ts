import {
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	shuffled
} from "@grizzle/testing/gen"
import type { Source } from "@grizzle/testing/source"
import { Array as Arr, Option, Record as Rec } from "effect"
import { directions } from "#compiler/core/order.ts"
import { projection } from "#test/support/laws/model.ts"
import {
	inDomain,
	knownNonEmpty,
	pooled,
	sameDomain
} from "#test/support/worlds/generate/domain.ts"
import { headingOf } from "#test/support/worlds/generate/entries.ts"
import { type BoundaryArms, type Variant } from "#test/support/worlds/invalid/kinds.ts"
import { classifyEntry, entryRows } from "#test/support/worlds/model/host.ts"
import { entryKeyed } from "#test/support/worlds/model/session/keys.ts"
import { isPageSize } from "#test/support/worlds/model/step.ts"
import type {
	BaseSpec,
	EntrySpec,
	FieldDomain,
	FieldSpec,
	HostFact,
	InvalidKind,
	ModelState,
	OrderKey,
	ReadVia,
	RoleSpec
} from "#test/support/worlds/model/types.ts"

/**
 * The key fields of an entry as `get` reads them: a writable entry's target primary key in its head's terms (a whole
 * entry's primary key), the fields its query fixes left out, when grizzle proves it a key of the entry, which for a
 * query entry needs it to determine every variable its filters bind (session/keys.ts); otherwise every field of its
 * heading, always a key.
 */
export const entryKey = (base: BaseSpec, spec: EntrySpec): ReadonlyArray<FieldSpec> => {
	const heading = headingOf(base, spec)
	const target = classifyEntry(base, spec)
	if (target.kind !== "writable") {
		return heading
	}
	const byTarget = new Map(
		Arr.map(Rec.toEntries(target.head), ([head, { field }]) => [field, head] as const)
	)
	return Option.match(
		Arr.findFirst(base.relations, (r) => r.name === target.target),
		{
			onNone: () => heading,
			onSome: (relation) => {
				const names = Arr.flatMap(relation.key, (k) => {
					const head = byTarget.get(k)
					return head === undefined ? [] : [head]
				})
				return names.length > 0 && entryKeyed(base, spec, names)
					? Arr.filter(heading, (f) => names.includes(f.name))
					: heading
			}
		}
	)
}

/** A fact's values at key fields. */
const keyOfFact = (fact: HostFact, key: ReadonlyArray<FieldSpec>): HostFact =>
	Rec.fromEntries(
		Arr.flatMap(key, (f) => {
			const v = fact[f.name]
			return v === undefined ? [] : [[f.name, v] as const]
		})
	)

/** Whether a key names one of the rows: equal at every key field. */
const keyHeld = (
	rows: ReadonlyArray<HostFact>,
	key: ReadonlyArray<FieldSpec>,
	at: HostFact
): boolean => {
	const fields = Arr.map(key, (f) => f.name)
	return (
		Arr.every(fields, (f) => at[f] !== undefined) &&
		Arr.some(rows, (r) => projection(r, fields) === projection(at, fields))
	)
}

/** The rows of a session's role relation, none when the role does not hold it. */
const rowsOf = (
	state: ModelState,
	role: RoleSpec,
	relation: string,
	facts: Readonly<Record<string, HostFact>>
): ReadonlyArray<HostFact> =>
	Rec.has(role.entries, relation) ? entryRows(state, role.name, relation, facts) : []

/** An offset into the pools: each field of a pool key takes the value of its own pool at the offset past its place. */
const poolOffset = int(0, 0xffff)

/**
 * Whether a read may equate two fields of a domain, as an attachment's child does with its parent: every domain but a
 * span, whose values a read compares by their points.
 */
const attachable = (domain: FieldDomain): boolean => domain.kind !== "span"

/**
 * Whether a recursive read may chain two fields of a domain: a uuid, a text, an integer or a serial, whose type the
 * recursive query's row states by its base type alone.
 */
const reachable = (domain: FieldDomain): boolean =>
	domain.kind === "uuid" ||
	domain.kind === "text" ||
	domain.kind === "integer" ||
	domain.kind === "serial"

/** A page's order: one to every field of the heading, in a drawn order, each ascending or descending. */
const orderGen =
	(heading: Arr.NonEmptyReadonlyArray<FieldSpec>): Gen<Arr.NonEmptyReadonlyArray<OrderKey>> =>
	(source) =>
		knownNonEmpty(
			Arr.map(source.draw(shuffled(heading, { min: 1, max: heading.length })), (f): OrderKey => ({
				field: f.name,
				direction: source.draw(element(directions))
			})),
			"a page's order"
		)

/** The pages of a relation: pages of one to three rows under a drawn order, from the first page or from the last. */
const pageGen =
	(heading: Arr.NonEmptyReadonlyArray<FieldSpec>): Gen<ReadVia> =>
	(source) => ({
		kind: "page",
		size: source.draw(int(1, 3)),
		order: source.draw(orderGen(heading)),
		from: source.draw(element(["first", "last"] as const))
	})

/**
 * The attachments a role offers a read of a relation: each relation the role holds whose field shares a domain a read
 * equates (attachable) with a field of the relation's heading, attached by those two fields, where the child holds a
 * field besides, which its rows are delivered with.
 */
export const attachments = (
	base: BaseSpec,
	role: RoleSpec,
	heading: ReadonlyArray<FieldSpec>
): ReadonlyArray<ReadVia> =>
	Arr.flatMap(Rec.toEntries(role.entries), ([child, spec]) => {
		const fields = headingOf(base, spec)
		return fields.length < 2
			? []
			: Arr.flatMap(heading, (parent) =>
					Arr.flatMap(fields, (field): ReadonlyArray<ReadVia> =>
						attachable(parent.domain) && sameDomain(parent.domain, field.domain)
							? [{ kind: "attach", relation: child, parent: parent.name, child: field.name }]
							: []
					)
				)
	})

/** The recursive reads a relation offers: each ordered pair of two of its heading's fields of one domain it chains. */
export const reaches = (heading: ReadonlyArray<FieldSpec>): ReadonlyArray<ReadVia> =>
	Arr.flatMap(heading, (from) =>
		Arr.flatMap(heading, (to): ReadonlyArray<ReadVia> =>
			from.name !== to.name && reachable(from.domain) && sameDomain(from.domain, to.domain)
				? [{ kind: "reach", from: from.name, to: to.name }]
				: []
		)
	)

/**
 * How a Db reads a role relation, under validity weights: live, a program executed, compiled, paged in pages of one to
 * three rows under an order of its fields, from the first page or the last, `get` by the key of one of its rows (by a
 * pool key when it has none), with another of the role's relations attached by two fields of one domain, or every pair
 * two of its fields of one domain chain; stale, `get` by a key no row of it holds (a fact outside the world, or none at
 * all); wild, `get` by a key missing a field or holding a value its field refuses, or pages of no row, of a fraction,
 * or of a negative count.
 */
export const viaArms = (
	state: ModelState,
	role: RoleSpec,
	facts: Readonly<Record<string, HostFact>>,
	relation: string
): BoundaryArms<ReadVia> => {
	const base = state.install.base
	const spec = Rec.has(role.entries, relation) ? role.entries[relation] : undefined
	const key = spec === undefined ? [] : entryKey(base, spec)
	const heading = spec === undefined ? [] : headingOf(base, spec)
	const rows = spec === undefined ? [] : rowsOf(state, role, relation, facts)
	const poolKey = (n: number): HostFact =>
		Rec.fromEntries(Arr.map(key, (f, i) => [f.name, pooled(f.domain, n + i)] as const))
	const [firstRow, ...moreRows] = rows
	const keyed: Gen<HostFact> =
		firstRow === undefined
			? map(poolOffset, poolKey)
			: map(element([firstRow, ...moreRows]), (row) => keyOfFact(row, key))
	const chained: ReadonlyArray<Gen<ReadVia>> = Arr.flatMap(
		[attachments(base, role, heading), reaches(heading)],
		(offered) =>
			Arr.match(offered, {
				onEmpty: (): ReadonlyArray<Gen<ReadVia>> => [],
				onNonEmpty: (all) => [element(all)]
			})
	)
	const [firstHeading, ...moreHeading] = heading
	const paged: ReadonlyArray<Gen<ReadVia>> =
		firstHeading === undefined ? [] : [pageGen([firstHeading, ...moreHeading])]
	const live: Gen<ReadVia> = oneOf([
		constant<ReadVia>({ kind: "execute" }),
		constant<ReadVia>({ kind: "compile" }),
		map(keyed, (k): ReadVia => ({ kind: "get", key: k })),
		...paged,
		...chained
	])
	const [firstField, ...moreFields] = key
	const [firstAbsent, ...moreAbsent] =
		key.length === 0
			? []
			: Arr.filter(
					Arr.makeBy(16, (n) => poolKey(n)),
					(k) => !keyHeld(rows, key, k)
				)
	const stale: ReadonlyArray<Variant<ReadVia>> =
		firstAbsent === undefined
			? []
			: [
					{
						invalid: "fact:deleted-reference",
						gen: map(element([firstAbsent, ...moreAbsent]), (k): ReadVia => ({
							kind: "get",
							key: k
						}))
					}
				]
	const wild: ReadonlyArray<Variant<ReadVia>> = [
		...(firstHeading === undefined
			? []
			: [
					{
						invalid: "handle:wild-js-value" as const,
						gen: map(
							element([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]),
							(size): ReadVia => ({
								kind: "page",
								size,
								order: [{ field: firstHeading.name, direction: "asc" }],
								from: "first"
							})
						)
					}
				]),
		...(firstField === undefined
			? []
			: [
					{
						invalid: "handle:wild-js-value" as const,
						gen: (source: Source): ReadVia => {
							const f = source.draw(element([firstField, ...moreFields]))
							const k =
								firstRow === undefined ? poolKey(source.draw(poolOffset)) : keyOfFact(firstRow, key)
							return {
								kind: "get",
								key: source.draw(boolean)
									? Rec.fromEntries(Arr.filter(Rec.toEntries(k), ([name]) => name !== f.name))
									: { ...k, [f.name]: typeof k[f.name] === "string" ? 7 : "seven" }
							}
						}
					}
				])
	]
	return { live, stale, wild }
}

/**
 * The invalid kinds of a read's path: a page size no page has, a key of another shape, a key no row holds; an
 * attachment and a recursive read carry none.
 */
export const viaKinds = (
	state: ModelState,
	role: RoleSpec,
	facts: Readonly<Record<string, HostFact>>,
	relation: string,
	via: ReadVia
): ReadonlyArray<InvalidKind> => {
	switch (via.kind) {
		case "execute":
		case "compile":
		case "attach":
		case "reach":
			return []
		case "page":
			return isPageSize(via.size) ? [] : ["handle:wild-js-value"]
		case "get": {
			const spec = Rec.has(role.entries, relation) ? role.entries[relation] : undefined
			if (spec === undefined) {
				return []
			}
			const key = entryKey(state.install.base, spec)
			const shaped =
				Rec.keys(via.key).length === key.length &&
				Arr.every(key, (f) => {
					const v = via.key[f.name]
					return v !== undefined && inDomain(f.domain, v)
				})
			if (!shaped) {
				return ["handle:wild-js-value"]
			}
			return keyHeld(rowsOf(state, role, relation, facts), key, via.key)
				? []
				: ["fact:deleted-reference"]
		}
	}
}
