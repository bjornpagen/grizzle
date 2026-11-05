import { Array as Arr, Option } from "effect"
import type { FoldInput, KeySet, KeyedOccurrence, RelNode } from "#compiler/ir/rel.ts"

/**
 * The keys a fixture's matched source is read by, as the checker states them for a fold (check/checker.ts
 * sourceKeys): a relation's primary key and every further key, a view's proved keys then its whole heading, a
 * context's empty key, a delta's relation's keys, and the whole heading of any other source, a set keyed by its
 * heading. A fixture names no closed relation's key, so a Closed source is read by its whole heading.
 */
const sourceKeys = (source: RelNode): ReadonlyArray<KeySet> => {
	const heading = Arr.map(source.heading, (c) => c.name)
	switch (source.kind) {
		case "Base":
			return source.relationKind === "relation"
				? [source.primaryKey, ...source.keys]
				: [...Arr.map(source.view, (k) => k.fields), heading]
		case "Context":
			return [[]]
		case "Delta":
			return source.keys.length > 0 ? source.keys : [heading]
		case "Closed":
		case "InputSet":
		case "MatchRegion":
		case "Filter":
		case "ProjectSet":
		case "SemiJoin":
		case "AntiJoin":
		case "Union":
		case "Intersect":
		case "Difference":
		case "Take":
		case "Group":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "ApproximateNearest":
		case "OrderedResult":
		case "Attach":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
			return [heading]
	}
}

/** The region a fold's input reads its facts through: under its filters, negations, existence tests and projections. */
const regionUnder = (input: RelNode): RelNode => {
	switch (input.kind) {
		case "Filter":
		case "ProjectSet":
			return regionUnder(input.input)
		case "SemiJoin":
		case "AntiJoin":
			return regionUnder(input.left)
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "MatchRegion":
		case "Union":
		case "Intersect":
		case "Difference":
		case "Take":
		case "Group":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "ApproximateNearest":
		case "OrderedResult":
		case "Attach":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
			return input
	}
}

/**
 * The fold input of a Group over `input` with the bound tuple `columns` (ir/rel.ts FoldInput), where `columns` holds a
 * key of every fact the input reads, as the checker proves it: for each occurrence of the region the input reads under
 * its filters and existence tests, the first key of its source whose every field the occurrence binds to a column of
 * `columns` or fixes to a constant; a stored relation read directly by its keys; and any other input, a set keyed by
 * its heading, by its whole heading. Undefined where `columns` holds no key of some fact: a fold over it would read a
 * projection, which the checker refuses before any IR exists.
 */
export const keyedFoldInput = (
	input: RelNode,
	columns: ReadonlyArray<string>
): FoldInput | undefined => {
	const region = regionUnder(input)
	const keyOf = (source: RelNode, bound: ReadonlySet<string>): KeySet | undefined =>
		Option.getOrUndefined(
			Arr.findFirst(sourceKeys(source), (k) => Arr.every(k, (f) => bound.has(f)))
		)
	switch (region.kind) {
		case "MatchRegion": {
			const keyed: Array<KeyedOccurrence> = []
			for (const o of region.occurrences) {
				const key = keyOf(
					o.source,
					new Set([
						...Arr.flatMap(o.bindings, (b) => (Arr.contains(columns, b.var.name) ? [b.column] : [])),
						...Arr.map(o.constants, (c) => c.column)
					])
				)
				if (key === undefined) {
					return undefined
				}
				keyed.push({ occurrence: o.id, key })
			}
			return { columns, keyed }
		}
		case "Base": {
			const key = keyOf(region, new Set(columns))
			return key === undefined
				? undefined
				: { columns, keyed: [{ occurrence: region.occurrence, key }] }
		}
		default:
			return Arr.every(region.heading, (c) => Arr.contains(columns, c.name))
				? { columns, keyed: [] }
				: undefined
	}
}

/**
 * The fold input of a Group a fixture builds (keyedFoldInput). A fixture whose fold reads a projection is a defect of
 * the fixture, never a case for the code under test.
 */
export const foldInputOf = (input: RelNode, columns: ReadonlyArray<string>): FoldInput => {
	const fold = keyedFoldInput(input, columns)
	if (fold === undefined) {
		throw new Error(
			`a fixture's fold over ${input.kind} ${input.id} whose bound tuple (${Arr.join(columns, ", ")}) holds a key of every fact it reads`
		)
	}
	return fold
}
