/** What the properties of declared.test.ts read: their space of relation shapes and PostgreSQL's estimate over them. */

import { array, boolean, type Gen, int, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import type {
	ColumnValues,
	DeclaredDependency,
	RelationShape
} from "#compiler/physical/statistics/declared.ts"
import type { DeclaredDistinct } from "#compiler/sql/ast.ts"

export type DeclaredFeature =
	| "a unit's member"
	| "a relation in no unit"
	| "a key bound"
	| "a set apart bound"
	| "a roster column"
	| "a crossing"
	| "an unsettled raise"
	| "a column beyond its values"
	| "a pair a dependency ties"
	| "an index led by a column of many values in no unit"
	| "a member's index led by a column no fact binds to its unit"
	| "a column determining an anchor"

/** A sequence of distinct columns of `columns`, `min` to `max` of them. */
const sequenceGen =
	(columns: ReadonlyArray<string>, min: number, max: number): Gen<ReadonlyArray<string>> =>
	(source) => {
		const left = [...columns]
		const length = source.draw(int(min, Math.min(max, columns.length)))
		const out: Array<string> = []
		for (let i = 0; i < length; i++) {
			const at = source.draw(int(0, left.length - 1))
			const [c] = left.splice(at, 1)
			if (c !== undefined) {
				out.push(c)
			}
		}
		return out
	}

/** A crossed pair's keys, indexes and bindings. */
interface Crossed {
	readonly keys: ReadonlyArray<ReadonlyArray<string>>
	readonly indexes: ReadonlyArray<ReadonlyArray<string>>
	readonly bindings: RelationShape["bindings"]
}

/**
 * A crossed pair of a unit's member: keys (u, b, c) and (u, d, e), indexes (u, b, d) and (u, c, e), and a binding each
 * index's equalities stop at short of, so the sets apart (u, b, d) and (u, c, e) hold together the columns the two keys
 * do: no numbers of distinct values meet the four bounds together.
 */
const crossedGen =
	(unit: ReadonlyArray<string>, rest: ReadonlyArray<string>): Gen<Crossed> =>
	(source) => {
		const [b = "", c = "", d = "", e = ""] = source.draw(sequenceGen(rest, 4, 4))
		return {
			keys: [
				[...unit, b, c],
				[...unit, d, e]
			],
			indexes: [
				[...unit, b, d],
				[...unit, c, e]
			],
			bindings: [
				{ columns: [...unit, b, d, c], by: "a binding past index (u, b, d)" },
				{ columns: [...unit, c, e, b], by: "a binding past index (u, c, e)" }
			]
		}
	}

/**
 * A relation's shape: two to six columns, each of many values or a roster of one to eight handles; a unit of one or two
 * leading columns or none; a primary key leading with the unit, and up to two other keys; its keys' indexes and up to
 * three more, each led by the unit or by a column of its own; the bindings of each key and each index's prefix, as the
 * installation's statements make them; and up to one dependency of a column on another a containment proves, as
 * metis's assignment.user determines child. Half the shapes hold a crossed pair besides (`crossedGen`), each of five
 * columns or more and a unit of one.
 */
export const shapeGen: Gen<RelationShape> = (source) => {
	const crossing = source.draw(boolean)
	const count = source.draw(int(crossing ? 5 : 2, 6))
	const names = Array.from({ length: count }, (_, i) => `c${i}`)
	/** A crossed pair's unit leads by a column of many values, its anchor. */
	const columns = Arr.map(names, (column, i) => ({
		column,
		values:
			!(crossing && i === 0) && source.draw(boolean)
				? ({ kind: "few", handles: source.draw(int(1, 8)) } satisfies ColumnValues)
				: ({ kind: "many" } satisfies ColumnValues)
	}))
	const unitWidth = crossing ? 1 : source.draw(int(0, Math.min(2, count - 1)))
	const unit = names.slice(0, unitWidth)
	const rest = names.slice(unitWidth)
	const crossed: Crossed = crossing
		? source.draw(crossedGen(unit, rest))
		: { keys: [], indexes: [], bindings: [] }
	const primary = [...unit, ...source.draw(sequenceGen(rest, 1, 3))]
	const others = source.draw(
		array((s) => [...(s.draw(boolean) ? unit : []), ...s.draw(sequenceGen(rest, 1, 3))], {
			min: 0,
			max: 2
		})
	)
	const keys = [primary, ...crossed.keys, ...others]
	const more = source.draw(
		array((s) => [...(s.draw(boolean) ? unit : []), ...s.draw(sequenceGen(rest, 1, 3))], {
			min: 0,
			max: 3
		})
	)
	const indexes = [...keys, ...crossed.indexes, ...more]
	const bindings = [
		...Arr.map(keys, (k) => ({ columns: k, by: `key (${Arr.join(k, ", ")})` })),
		...Arr.map(indexes, (i) => {
			const cut = source.draw(int(1, i.length))
			return { columns: i.slice(0, cut), by: `index (${Arr.join(i, ", ")}) to ${cut}` }
		}),
		...crossed.bindings,
		...source.draw(
			array(
				(s) => ({ columns: s.draw(subset(names, { min: 1, max: count })), by: "a drawn binding" }),
				{
					min: 0,
					max: 2
				}
			)
		)
	]
	const determined = source.draw(
		array(
			(s) => {
				const [determinant = "", dependent = ""] = s.draw(sequenceGen(names, 2, 2))
				return { determinant, dependent }
			},
			{ min: 0, max: 1 }
		)
	)
	return { relation: "R", columns, unit, keys, indexes, bindings, determined }
}

/** The leading run of an index's columns a binding holds. */
export const boundPrefix = (
	index: ReadonlyArray<string>,
	binding: ReadonlySet<string>
): ReadonlyArray<string> =>
	Option.match(
		Arr.findFirstIndex(index, (c) => !binding.has(c)),
		{
			onNone: () => index,
			onSome: (end) => index.slice(0, end)
		}
	)

/**
 * PostgreSQL's estimate of the rows a set of columns binds, in powers of two, under declared numbers of distinct values
 * and declared dependencies, at a size of the table past every anchor's rows: the independence product of each column's
 * selectivity, but for a pair a dependency ties, P(determinant) · (d + (1 − d) · P(dependent)), 2^(y − exponent) rows at
 * any size (dependencies.c dependencies_clauselist_selectivity). A set of exactly one anchor, or of exactly a declared
 * pair, binds 2^(y − Σ x); one of two anchors or more otherwise binds less than one row; one of none, a number of rows
 * growing with the table (`growing`).
 */
export const estimate = (
	declared: ReadonlyMap<string, DeclaredDistinct>,
	dependencies: ReadonlyArray<DeclaredDependency>,
	set: ReadonlyArray<string>
): { readonly kind: "rows"; readonly log2: number } | { readonly kind: "growing" | "belowOne" } => {
	const relative = Arr.filter(set, (c) => declared.get(c)?.kind === "relative")
	const absolute = Arr.reduce(set, 0, (s, c) => {
		const d = declared.get(c)
		return d?.kind === "absolute" ? s + d.exponent : s
	})
	const [anchor, ...more] = relative
	if (anchor === undefined) {
		return { kind: "growing" }
	}
	if (more.length === 0) {
		return { kind: "rows", log2: (declared.get(anchor)?.exponent ?? 0) - absolute }
	}
	const pair = Arr.findFirst(
		dependencies,
		(d) =>
			relative.length === 2 && relative.includes(d.determinant) && relative.includes(d.dependent)
	)
	return Option.match(pair, {
		onNone: () => ({ kind: "belowOne" }) as const,
		onSome: (d) => ({
			kind: "rows",
			log2: (declared.get(d.determinant)?.exponent ?? 0) - d.exponent - absolute
		})
	})
}

/** The first column of `columns` of many values that holds more than one, a unit's later field holding one. */
export const scopeOf = (
	shape: RelationShape,
	columns: ReadonlyArray<string>
): Option.Option<string> =>
	Arr.findFirst(
		columns,
		(c) =>
			!unitTail(shape).includes(c) &&
			Arr.some(shape.columns, (x) => x.column === c && x.values.kind === "many")
	)

/** The fields of the unit's key after its first of many values, on which the unit's count of rows sits. */
export const unitTail = (shape: RelationShape): ReadonlyArray<string> =>
	Option.match(
		Arr.findFirstIndex(shape.unit, (c) =>
			Arr.some(shape.columns, (x) => x.column === c && x.values.kind === "many")
		),
		{ onNone: () => [], onSome: (at) => shape.unit.slice(at + 1) }
	)

/** Whether a set of columns holds a key of the shape: every column of one but those of one value, the unit's key's
 * fields after its first of many values and a roster's of one handle. */
export const holdsKey = (shape: RelationShape, set: ReadonlyArray<string>): boolean => {
	const tail = unitTail(shape)
	const single = (c: string): boolean =>
		tail.includes(c) ||
		Arr.some(
			shape.columns,
			(x) => x.column === c && x.values.kind === "few" && x.values.handles <= 1
		)
	return Arr.some(shape.keys, (k) => Arr.every(k, (c) => set.includes(c) || single(c)))
}
