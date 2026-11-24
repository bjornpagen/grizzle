import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { OccurrenceId } from "#compiler/core/ids.ts"
import { listOrder } from "#compiler/core/order.ts"
import {
	type DeclaredKey,
	keptRowsOf,
	type NodeOf,
	type RelNode,
	unionArms
} from "#compiler/ir/rel.ts"

/**
 * A key's columns in the order of the declared key they copy: the order a completion appends a chosen key in
 * (logical/order.ts completeOrder step 2), so a result ordered by its key is ordered as that key's own unique index
 * delivers it, lexicographically in its declared column order, and an index read of the key serves the order with no
 * Sort.
 *
 * A heading column copies a stored field when every node between it and a Base passes it through unchanged: a filter,
 * a step, a take, an ordered result, the left side of a semi-join, an anti-join, an intersection or a difference, an
 * attachment's parent, a projection that outputs the input column itself, a group's key, and a rule's region, whose
 * variable copies the column of the first occurrence that binds it. Any other column, a computed one, an aggregate's or
 * a union's, copies none; a union's rows are ordered as its arms agree to order them (unionOfRows).
 *
 * The columns copying fields of one Base occurrence are ordered by the first of that Base's declared keys, its primary
 * key and then its other keys as declared, that holds every one of them: a key's columns less those a reading fixes,
 * a union of the key's own columns, so a chosen key's columns lie within one declared key exactly when they are one,
 * or one less fixed columns. The occurrences follow the region order that reaches them, each region's occurrences in
 * the order its rule states its matches, so a parent's key precedes the key of a child matched after it. A column that
 * copies no field, or whose occurrence's columns lie in no one declared key, follows the ordered ones, in the order
 * given, the heading's.
 */
export const declaredKeyOrder =
	(node: RelNode) =>
	(columns: ReadonlyArray<string>): ReadonlyArray<string> => {
		const union = unionOfRows(node)
		if (union !== undefined) {
			const [first, ...rest] = mapNonEmpty(unionArms(union.groups), (arm) =>
				declaredKeyOrder(arm)(columns)
			)
			return rest.every((order) => order.every((c, at) => c === first[at])) ? first : columns
		}
		const placed = columns.map((column, at) => ({ column, at, origin: originOf(node, column, []) }))
		const byOccurrence = new Map<OccurrenceId, Array<Origin>>()
		for (const p of placed) {
			if (p.origin !== undefined) {
				byOccurrence.getOrInsertComputed(p.origin.base.occurrence, () => []).push(p.origin)
			}
		}
		/** The declared key of each occurrence that holds every field its columns copy, if one does. */
		const keyOf = new Map<OccurrenceId, DeclaredKey>()
		for (const [occurrence, origins] of byOccurrence) {
			const base = defined(origins[0], "an occurrence's first origin").base
			const key = [base.primaryKey, ...base.keys].find((k) =>
				origins.every((o) => k.includes(o.field))
			)
			if (key !== undefined) {
				keyOf.set(occurrence, key)
			}
		}
		const rankOf = (origin: Origin | undefined): ReadonlyArray<number> | undefined => {
			if (origin === undefined) {
				return undefined
			}
			const key = keyOf.get(origin.base.occurrence)
			return key === undefined ? undefined : [...origin.path, key.indexOf(origin.field)]
		}
		const ranked = placed.map((p) => ({ ...p, rank: rankOf(p.origin) }))
		const compareRanks = listOrder<number>((a, b) => a - b)
		return ranked
			.toSorted((a, b) => {
				if (a.rank === undefined || b.rank === undefined) {
					return a.rank === b.rank ? a.at - b.at : a.rank === undefined ? 1 : -1
				}
				const d = compareRanks(a.rank, b.rank)
				return d === 0 ? a.at - b.at : d
			})
			.map((p) => p.column)
	}

/**
 * The union of several arms whose rows `node`'s are, down the kept rows (ir/rel.ts keptRowsOf), or undefined where they
 * are computed elsewhere. A union's column copies no one stored field, but each arm's copies its own: the union's key
 * columns are ordered as every arm orders them, where the arms agree, so each arm's index serves the order and the arms
 * merge in it; where they disagree no one index order serves them, and the columns keep the order given, the heading's.
 */
const unionOfRows = (node: RelNode): NodeOf<"Union"> | undefined => {
	if (node.kind === "Union") {
		return unionArms(node.groups).length > 1 ? node : undefined
	}
	const kept = keptRowsOf(node)
	return kept === undefined ? undefined : unionOfRows(kept.input)
}

/** The stored field a column copies: the Base occurrence it is read from, the field, and the occurrence places reaching it. */
interface Origin {
	readonly base: NodeOf<"Base">
	readonly field: string
	/** Each region's occurrence index on the way from the column to the Base, outermost first. */
	readonly path: ReadonlyArray<number>
}

/** The stored field `column` of `node` copies (declaredKeyOrder), under the occurrence places `path` reached it by. */
const originOf = (
	node: RelNode,
	column: string,
	path: ReadonlyArray<number>
): Origin | undefined => {
	switch (node.kind) {
		case "Base":
			return node.heading.some((c) => c.name === column)
				? { base: node, field: column, path }
				: undefined
		case "Filter":
		case "Step":
		case "Take":
		case "OrderedResult":
			return originOf(node.input, column, path)
		case "SemiJoin":
		case "AntiJoin":
		case "Intersect":
		case "Difference":
			return originOf(node.left, column, path)
		case "Attach":
			return node.parent.heading.some((c) => c.name === column)
				? originOf(node.parent, column, path)
				: undefined
		case "Group":
			return node.keys.includes(column) ? originOf(node.input, column, path) : undefined
		case "ProjectSet": {
			const out = node.out.find((o) => o.name === column)
			return out?.expr.kind === "column" && out.expr.column.node === node.input.id
				? originOf(node.input, out.expr.column.name, path)
				: undefined
		}
		case "MatchRegion": {
			const variable = node.vars.find((v) => v.name === column)
			if (variable === undefined) {
				return undefined
			}
			for (const [at, occurrence] of node.occurrences.entries()) {
				const binding = occurrence.bindings.find((b) => b.var.id === variable.id)
				if (binding !== undefined) {
					return originOf(occurrence.source, binding.column, [...path, at])
				}
			}
			return undefined
		}
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "Union":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "ApproximateNearest":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
		case "Call":
			return undefined
	}
}
