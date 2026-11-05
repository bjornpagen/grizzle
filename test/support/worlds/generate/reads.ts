import { boolean, constant, element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import type { Source } from "@grizzle/testing/source"
import { Array as Arr, Option, Record as Rec } from "effect"
import { projection } from "#test/support/laws/model.ts"
import { inDomain, pooled } from "#test/support/worlds/generate/domain.ts"
import { headingOf } from "#test/support/worlds/generate/entries.ts"
import { type BoundaryArms, type Variant } from "#test/support/worlds/invalid/kinds.ts"
import { classifyEntry, entryRows } from "#test/support/worlds/model/host.ts"
import { entryKeyed } from "#test/support/worlds/model/session/keys.ts"
import { pageLimit } from "#test/support/worlds/model/step.ts"
import type {
	BaseSpec,
	EntrySpec,
	FieldSpec,
	HostFact,
	InvalidKind,
	ModelState,
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
 * How a Db reads a role relation, under validity weights: live, a program executed, compiled, paged in pages of one to
 * three rows, or `get` by the key of one of its rows (by a pool key when it has none); stale, `get` by a key no row of
 * it holds (a fact outside the world, or none at all); wild, `get` by a key missing a field or holding a value its
 * field refuses, or pages of no row, of a fraction, or of a negative count.
 */
export const viaArms = (
	state: ModelState,
	role: RoleSpec,
	facts: Readonly<Record<string, HostFact>>,
	relation: string
): BoundaryArms<ReadVia> => {
	const spec = Rec.has(role.entries, relation) ? role.entries[relation] : undefined
	const key = spec === undefined ? [] : entryKey(state.install.base, spec)
	const rows = spec === undefined ? [] : rowsOf(state, role, relation, facts)
	const poolKey = (n: number): HostFact =>
		Rec.fromEntries(Arr.map(key, (f, i) => [f.name, pooled(f.domain, n + i)] as const))
	const [firstRow, ...moreRows] = rows
	const keyed: Gen<HostFact> =
		firstRow === undefined
			? map(poolOffset, poolKey)
			: map(element([firstRow, ...moreRows]), (row) => keyOfFact(row, key))
	const live: Gen<ReadVia> = oneOf([
		constant<ReadVia>({ kind: "execute" }),
		constant<ReadVia>({ kind: "compile" }),
		map(int(1, 3), (size): ReadVia => ({ kind: "page", size })),
		map(keyed, (k): ReadVia => ({ kind: "get", key: k }))
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
		{
			invalid: "handle:wild-js-value",
			gen: map(
				element([0, -1, 1.5, pageLimit + 1, Number.MAX_SAFE_INTEGER + 2]),
				(size): ReadVia => ({ kind: "page", size })
			)
		},
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

/** The invalid kinds of a read's path: a page size no page has, a key of another shape, a key no row holds. */
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
			return []
		case "page":
			return Number.isSafeInteger(via.size) && via.size > 0 && via.size <= pageLimit
				? []
				: ["handle:wild-js-value"]
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
