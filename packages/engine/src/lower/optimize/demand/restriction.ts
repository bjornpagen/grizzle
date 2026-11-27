import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import type { OccurrenceId, VarId } from "#compiler/core/ids.ts"
import { regionVarClasses, type VarDecl } from "#compiler/ir/rel.ts"

/**
 * A region as its restriction is read off it, over the checked DAG's nodes and the editor's cells alike: its
 * occurrences, each by its id and the columns it binds to variables, the equalities that make two variables one, and the
 * variables its correlation holds at an outer value.
 */
export interface LinkedRegion {
	readonly occurrences: ReadonlyArray<{
		readonly id: OccurrenceId
		readonly bindings: ReadonlyArray<{ readonly column: string; readonly var: VarDecl }>
	}>
	readonly equalities: ReadonlyArray<{ readonly a: VarDecl; readonly b: VarDecl }>
	readonly correlated: ReadonlyArray<{ readonly var: VarDecl }>
}

/**
 * The restriction reaching each occurrence's read in a region, by occurrence: the columns at which the region binds the
 * occurrence to something outside it, so that its read is at the values those bind rather than over every value of the
 * column. A column is restricted where its variable's class (the region's equalities making two variables one) is held
 * by the region's correlation, or bound by another occurrence that relates it to the rest of the region: one that also
 * binds a class outside the occurrence's own which the correlation holds or a third occurrence binds. An occurrence
 * all of whose classes are the occurrence's own (a test of its rows, every column of it one of theirs) relates it to
 * nothing, so it restricts no column of it, however many of its columns it shares.
 *
 * This is what a rewrite of a region must keep (restrictionKept): no pass may reduce the restriction reaching any
 * occurrence's read. A region whose occurrence lost the only occurrence relating one of its columns to the rest reads
 * that occurrence at every value of the column and leaves the relation to a test applied after the read: an existence
 * test above a computed occurrence read LATERAL, which PostgreSQL cannot drive the read from, reads the computation
 * over every value and filters it after (metis's sitting: each item's attempts in force derived for every member of its
 * test, its membership an EXISTS applied to each of 68 rows).
 */
export const linkedColumns = (
	region: LinkedRegion
): ReadonlyMap<OccurrenceId, ReadonlySet<string>> => {
	const classOf = regionVarClasses(region)
	const held = new Set(region.correlated.map((c) => classOf(c.var)))
	/** Each occurrence's classes, place for place, the places that bind each class, and how many do. */
	const classes = region.occurrences.map((o) => new Set(o.bindings.map((b) => classOf(b.var))))
	const binders = new Map<VarId, Array<number>>()
	for (const [at, own] of classes.entries()) {
		for (const c of own) {
			binders.getOrInsertComputed(c, () => []).push(at)
		}
	}
	const ownAt = (at: number): ReadonlySet<VarId> =>
		defined(classes[at], "an occurrence's classes, place for place")
	/**
	 * Whether the occurrence at `p` relates a class of the occurrence at `x` to the rest of the region: it binds a class
	 * outside `x`'s own that the correlation holds or another occurrence binds, which is never `x`, whose classes it is
	 * outside of.
	 */
	const relates = (p: number, x: number): boolean => {
		const own = ownAt(x)
		return [...ownAt(p)].some(
			(d) => !own.has(d) && (held.has(d) || (binders.get(d)?.length ?? 0) > 1)
		)
	}
	return new Map(
		region.occurrences.map((o, x) => {
			const restricted = new Set<string>()
			for (const b of o.bindings) {
				const c = classOf(b.var)
				if (held.has(c) || (binders.get(c) ?? []).some((p) => p !== x && relates(p, x))) {
					restricted.add(b.column)
				}
			}
			return [o.id, restricted] as const
		})
	)
}

/**
 * Whether a rewrite from a region restricted `before` to one restricted `after` (linkedColumns) kept the restriction
 * reaching every occurrence present in both: each column restricted before is restricted after.
 */
export const restrictionKept = (
	before: ReadonlyMap<OccurrenceId, ReadonlySet<string>>,
	after: ReadonlyMap<OccurrenceId, ReadonlySet<string>>
): boolean =>
	[...after].every(([id, columns]) => [...(before.get(id) ?? [])].every((c) => columns.has(c)))

/**
 * A region's roots: each occurrence that binds, through the keys of the occurrences it reaches, a key of every other
 * (`keyedAt`, the columns of the occurrence at a place that the classes bound so far hold, a key of its source or not),
 * each class the region's correlation holds bound from the start. Every row of a region with a root is one of the root's
 * rows with at most one row of each other occurrence beside it, so a removal that leaves a root leaves no product for a
 * test above the region to filter: the restriction an occurrence loses there was only a check of a row the keys already
 * single out.
 */
export const roots = (
	region: LinkedRegion,
	keyedAt: (at: number, columns: ReadonlyArray<string>) => boolean
): ReadonlyArray<number> => {
	const classOf = regionVarClasses(region)
	const held = region.correlated.map((c) => classOf(c.var))
	const occurrences = region.occurrences
	return [...occurrences.keys()].filter((root) => {
		const first = defined(occurrences[root], "a root among the region's occurrences")
		const bound = new Set([...held, ...first.bindings.map((b) => classOf(b.var))])
		const reached = new Set([root])
		for (let grew = true; grew;) {
			grew = false
			for (const [at, o] of occurrences.entries()) {
				const columns = o.bindings.flatMap((b) => (bound.has(classOf(b.var)) ? [b.column] : []))
				if (reached.has(at) || !keyedAt(at, columns)) {
					continue
				}
				reached.add(at)
				for (const b of o.bindings) {
					bound.add(classOf(b.var))
				}
				grew = true
			}
		}
		return reached.size === occurrences.length
	})
}
