import { Array as Arr } from "effect"
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
 * The fold input of a Group a fixture builds over `input` with the bound tuple `columns` (ir/rel.ts FoldInput): for
 * each occurrence of the region the input reads, the first key of its source whose every field the occurrence binds
 * to a column of `columns` or fixes to a constant, as the checker proves it. A fold over a stored relation read whole
 * is keyed by its primary key, and one over any other source by its whole heading, which `columns` then holds. A
 * fixture whose fold reads a projection, a source of which `columns` holds no key, is a defect of the fixture, never
 * a case for the code under test: the checker refuses such a fold before any IR exists.
 */
export const foldInputOf = (input: RelNode, columns: ReadonlyArray<string>): FoldInput => {
	const region = regionUnder(input)
	const keyed = (
		occurrence: KeyedOccurrence["occurrence"],
		source: RelNode,
		bound: ReadonlySet<string>
	): KeyedOccurrence => {
		const key = Arr.findFirst(sourceKeys(source), (k) => Arr.every(k, (f) => bound.has(f)))
		if (key._tag === "None") {
			throw new Error(
				`a fixture's fold over ${source.kind} ${source.id} binds none of its keys: bind one of (${Arr.join(
					Arr.map(sourceKeys(source), (k) => Arr.join(k, ", ")),
					"), ("
				)}) in its bound tuple`
			)
		}
		return { occurrence, key: key.value }
	}
	if (region.kind === "MatchRegion") {
		return {
			columns,
			keyed: Arr.map(region.occurrences, (o) =>
				keyed(
					o.id,
					o.source,
					new Set([
						...Arr.flatMap(o.bindings, (b) => (columns.includes(b.var.name) ? [b.column] : [])),
						...Arr.map(o.constants, (c) => c.column)
					])
				)
			)
		}
	}
	if (region.kind === "Base") {
		return { columns, keyed: [keyed(region.occurrence, region, new Set(columns))] }
	}
	const missing = Arr.filter(region.heading, (c) => !columns.includes(c.name))
	if (missing.length > 0) {
		throw new Error(
			`a fixture's fold over ${region.kind} ${region.id} binds its whole heading, not without (${Arr.join(
				Arr.map(missing, (c) => c.name),
				", "
			)})`
		)
	}
	return { columns, keyed: [] }
}
