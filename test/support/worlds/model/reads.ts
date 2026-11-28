import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import { Array as Arr, Record as Rec } from "effect"
import type { ValueIdentity } from "#test/support/kernel/identity.ts"
import { sameValue, sameValues } from "#test/support/laws/model.ts"
import { factKey, fieldDomain, headFieldDomain } from "#test/support/worlds/model/host.ts"
import { inFieldDomain } from "#test/support/worlds/model/session/domains.ts"
import { relationSpecOf, roleEntryOf } from "#test/support/worlds/model/session/state.ts"
import type {
	BaseSpec,
	EntrySpec,
	FieldDomain,
	HostFact,
	RoleSpec,
	Source
} from "#test/support/worlds/model/types.ts"

/**
 * The shapes of the reads that deliver more than a relation's own rows (docs/reads-and-writes.md "Queries": nest, recursion), as the model
 * predicts them and the executor reads them back: an attachment's rows flattened, and a recursive read's pairs.
 */

/** The domain of a role relation's field: its base field's for a whole entry, its head field's for a query entry. */
const entryFieldDomain = (
	base: BaseSpec,
	entry: EntrySpec,
	field: string
): FieldDomain | undefined => {
	switch (entry.kind) {
		case "whole": {
			const source: Source = Arr.some(base.closed, (c) => c.name === entry.relation)
				? { kind: "closed", name: entry.relation }
				: { kind: "ordinary", name: entry.relation }
			return fieldDomain(base, source, field)
		}
		case "query":
			return headFieldDomain(base, entry.rules, field)
	}
}

/**
 * Whether a get of a role relation by `key` compiles. A get is a read of the relation with each field it names fixed to
 * its value (execute/session.ts readVia, relationRead), which names no key, since grizzle serves no lookup by a field
 * set a caller picks (6c7c7604): a key member reads by a stored relation's primary key or a declared Key alone
 * (program/workload/value.ts keyLookup, query/build/key.ts keyTarget). So it compiles exactly where each field it names
 * is one the relation's heading types (entryFieldDomain) and each value lies in that field's domain
 * (session/domains.ts inFieldDomain), as grizzle admits a literal of the field; it is refused at compile otherwise. The
 * model's read (step.ts readCall) and the generator's invalid kinds (generate/reads.ts viaKinds) both judge a get by it.
 */
export const getCompiles = (
	base: BaseSpec,
	role: RoleSpec,
	relation: string,
	key: HostFact
): boolean => {
	const entry = roleEntryOf(role, relation)
	return (
		entry !== undefined &&
		Arr.every(Rec.toEntries(key), ([field, value]) => {
			const domain = entryFieldDomain(base, entry, field)
			return domain !== undefined && inFieldDomain(domain, value)
		})
	)
}

/**
 * The fields of a role relation's heading: a whole entry's relation's, a roster's handle, or a query entry's head; none of a relation the role does not hold.
 */
export const headingNames = (
	base: BaseSpec,
	role: RoleSpec,
	relation: string
): ReadonlyArray<string> => {
	const entry = roleEntryOf(role, relation)
	if (entry === undefined) {
		return []
	}
	if (entry.kind === "query") {
		return Rec.keys(entry.rules[0].head)
	}
	const ordinary = relationSpecOf(base, entry.relation)
	if (ordinary !== undefined) {
		return Arr.map(ordinary.fields, (f) => f.name)
	}
	return Arr.some(base.closed, (c) => c.name === entry.relation) ? ["id"] : []
}

/** The field an attachment nests its children under: `attached`, or past every field of the parent's heading. */
export const attachedField = (heading: ReadonlyArray<string>): string => {
	let name = "attached"
	while (heading.includes(name)) {
		name = `${name}x`
	}
	return name
}

/** A child's field as its parent's flattened row names it: under the attachment's field. */
const nested = (attached: string, field: string): string => `${attached}.${field}`

/**
 * A row with its attached children, flattened to rows of one heading: the row itself where it has no child, and the
 * row with each child's fields beside it, each child once, under its own name nested in the attachment's field. An
 * attachment delivers its children as a set, so the flattening tells two deliveries apart exactly when their rows or
 * their children differ.
 */
export const flattened = (
	row: HostFact,
	children: ReadonlyArray<HostFact>,
	attached: string
): ReadonlyArray<HostFact> =>
	Arr.match(Arr.dedupeWith(children, sameValues), {
		onEmpty: () => [row],
		onNonEmpty: (each) =>
			Arr.map(each, (child) => ({
				...row,
				...Rec.fromEntries(
					Arr.map(
						Rec.toEntries(child),
						([field, value]) => [nested(attached, field), value] as const
					)
				)
			}))
	})

/**
 * The rows of a relation with another attached (docs/reads-and-writes.md "Queries": `.attach(name, (parent) => child, "array")`): each
 * parent row with the child rows whose field `child` equals its field `parent`, delivered without that field, flattened.
 */
export const attachedRows = (
	parents: ReadonlyArray<HostFact>,
	children: ReadonlyArray<HostFact>,
	on: { readonly parent: string; readonly child: string },
	attached: string
): ReadonlyArray<HostFact> =>
	Arr.flatMap(parents, (row) =>
		flattened(
			row,
			Arr.flatMap(children, (child) =>
				sameValue(child[on.child], row[on.parent]) ? [Rec.remove(child, on.child)] : []
			),
			attached
		)
	)

/** The fields a recursive read's pairs are delivered under: where a chain starts, and a value it reaches. */
export const reachFields = { origin: "origin", reached: "reached" } as const

/** The pairs of a relation's rows from field `from` to field `to`, each once: one step of a chain. */
export const steppedPairs = (
	rows: ReadonlyArray<HostFact>,
	from: string,
	to: string
): ReadonlyArray<HostFact> =>
	Arr.dedupeWith(
		Arr.flatMap(rows, (row): ReadonlyArray<HostFact> => {
			const origin = row[from]
			const reached = row[to]
			return origin === undefined || reached === undefined
				? []
				: [{ [reachFields.origin]: origin, [reachFields.reached]: reached }]
		}),
		sameValues
	)

/**
 * Whether a role reads `entry` as a union: a query entry of more than one rule, which a recursion's step may not read
 * (docs/reads-and-writes.md "A recursive rule joins `self`": RecursionRefused, cause unionStep), so a recursive read of it is refused when
 * it compiles.
 */
export const readsAsUnion = (entry: EntrySpec | undefined): boolean =>
	entry?.kind === "query" && entry.rules.length > 1

/**
 * Every pair a relation's rows chain from field `from` to field `to` (docs/reads-and-writes.md "Queries": recursion): each step's pair
 * (steppedPairs), and a pair's origin with each value a step starting at its reached value reaches, to a fixed point. A
 * recursive query's result is a set, so a cycle ends the walk.
 */
export const reachedPairs = (
	rows: ReadonlyArray<HostFact>,
	from: string,
	to: string
): ReadonlyArray<HostFact> => {
	const steps = steppedPairs(rows, from, to)
	const pairs = new TupleMap<ValueIdentity, HostFact>()
	/** Whether a pair is new, which it then joins the pairs reached. */
	const fresh = (pair: HostFact): boolean => {
		const key = factKey(pair)
		if (pairs.has(key)) {
			return false
		}
		pairs.set(key, pair)
		return true
	}
	let frontier = Arr.filter(steps, fresh)
	while (frontier.length > 0) {
		frontier = Arr.filter(
			Arr.flatMap(frontier, (pair) =>
				Arr.flatMap(steps, (step): ReadonlyArray<HostFact> => {
					const origin = pair[reachFields.origin]
					const reached = step[reachFields.reached]
					return origin !== undefined &&
						reached !== undefined &&
						sameValue(step[reachFields.origin], pair[reachFields.reached])
						? [{ [reachFields.origin]: origin, [reachFields.reached]: reached }]
						: []
				})
			),
			fresh
		)
	}
	return [...pairs.values()]
}
