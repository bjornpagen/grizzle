import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { compareStrings } from "#compiler/core/order.ts"
import type { ContainedDependency } from "#compiler/ir/keys.ts"
import { type RelNode, regionVarClasses, unionArms } from "#compiler/ir/rel.ts"
import type { Owned } from "#compiler/schema/own.ts"

/**
 * Containments of one relation's fields in another's, field for field, and the dependencies each gives: the declared
 * ones a schema states, and those a derived relation's definition proves of its columns, where every arm draws them
 * from one row of a relation (`viewDependencies`). One rule gives a dependency of either (`containmentDependencies`).
 */

/** A containment of fields in `target`'s, field for field: each row's `left` fields are one row's `right` fields. */
interface FieldContainment {
	readonly target: string
	readonly pairs: ReadonlyArray<{ readonly left: string; readonly right: string }>
}

/**
 * Each relation's declared containments that read every fact of it, onto an ordinary relation, field for field, by its
 * name: a side that selects reads some facts alone, and a pair that reads no field is no field's containment.
 */
const declaredContainments = (
	owned: Owned
): ReadonlyMap<string, ReadonlyArray<FieldContainment>> => {
	const out = new Map<string, Array<FieldContainment>>()
	for (const s of owned.statements) {
		if (s.kind !== "contained" || s.left.selection.conjuncts.length > 0) {
			continue
		}
		if (owned.relations[s.right.relation]?.kind !== "relation") {
			continue
		}
		const pairs = s.pairs.flatMap((p) =>
			p.left.kind === "field" && p.right.kind === "field"
				? [{ left: p.left.field, right: p.right.field }]
				: []
		)
		out.getOrInsertComputed(s.left.relation, () => []).push({ target: s.right.relation, pairs })
	}
	return out
}

/**
 * The dependencies a containment's `pairs` onto a relation of declared keys `keys` give the side it contains: for each
 * key whose every field it maps onto, the fields mapped onto the key determine every field it maps, since two rows that
 * agree on them map to one row of the target, which its key's value names alone; none where it maps the key alone.
 */
const containmentDependencies = (
	pairs: FieldContainment["pairs"],
	keys: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<ContainedDependency> =>
	keys.flatMap((key) => {
		const by = key.flatMap((f) => pairs.flatMap((p) => (p.right === f ? [p.left] : [])))
		return by.length === key.length && pairs.length > by.length
			? [{ by, fields: pairs.map((p) => p.left) }]
			: []
	})

/** The declared keys of the ordinary relation `name` of `owned`, each its fields; none for any other relation. */
const keysOf = (owned: Owned, name: string): ReadonlyArray<ReadonlyArray<string>> => {
	const relation = owned.relations[name]
	return relation?.kind === "relation" ? relation.keys.map((k) => k.fields) : []
}

/**
 * The dependencies each relation's declared containments give it, by its name (ir/law.ts RelationInfo `determined`):
 * each containment that reads every fact of its relation, onto an ordinary relation, gives what its pairs give
 * (`containmentDependencies`).
 */
export const declaredDependencies = (
	owned: Owned
): ReadonlyMap<string, ReadonlyArray<ContainedDependency>> =>
	new Map(
		[...declaredContainments(owned)].map(
			([relation, containments]) =>
				[
					relation,
					containments.flatMap((c) => containmentDependencies(c.pairs, keysOf(owned, c.target)))
				] as const
		)
	)

/**
 * The columns of a node's rows that each row takes, jointly, from one row of `relation`, each at that relation's column
 * (`columns`, the node's column to the relation's), and the declared containments it rides on to reach that relation
 * (`through`), each hop a relation's containment in its target: none where a row of the relation is read itself.
 */
interface Draw {
	readonly relation: string
	readonly columns: ReadonlyMap<string, string>
	readonly through: ReadonlyArray<ContainmentHop>
}

/** A declared containment a draw rides on: `relation`'s, in `target`. */
export interface ContainmentHop {
	readonly relation: string
	readonly target: string
}

/** The hops of `a` and of `b`, each once, in the order first met. */
const hopsOf = (
	a: ReadonlyArray<ContainmentHop>,
	b: ReadonlyArray<ContainmentHop>
): ReadonlyArray<ContainmentHop> => [
	...a,
	...b.filter((h) => !a.some((x) => x.relation === h.relation && x.target === h.target))
]

/**
 * `draw` and every draw a declared containment of its relation carries it into, transitively: a row of the relation
 * holds its contained fields as one row of the target, so the columns drawn from those fields are drawn from that row.
 */
const closedDraws = (
	draw: Draw,
	containments: ReadonlyMap<string, ReadonlyArray<FieldContainment>>
): ReadonlyArray<Draw> => {
	const out: Array<Draw> = [draw]
	const seen = new Set<string>([draw.relation])
	for (const at of out) {
		for (const c of containments.get(at.relation) ?? []) {
			const columns = new Map(
				[...at.columns].flatMap(([column, field]) => {
					const pair = c.pairs.find((p) => p.left === field)
					return pair === undefined ? [] : [[column, pair.right] as const]
				})
			)
			if (columns.size > 0 && !seen.has(c.target)) {
				seen.add(c.target)
				out.push({
					relation: c.target,
					columns,
					through: [...at.through, { relation: at.relation, target: c.target }]
				})
			}
		}
	}
	return out
}

/** The draws of `node`'s rows at `rename`'s columns, each renamed to the column it names, those it names alone kept. */
const renamedDraws = (
	draws: ReadonlyArray<Draw>,
	rename: (column: string) => ReadonlyArray<string>
): ReadonlyArray<Draw> =>
	draws.flatMap((d) => {
		const columns = new Map(
			[...d.columns].flatMap(([column, field]) =>
				rename(column).map((named) => [named, field] as const)
			)
		)
		return columns.size > 0 ? [{ relation: d.relation, columns, through: d.through }] : []
	})

/** The columns two draws of one relation both take from it at the same field: what a row of either arm draws there. */
const commonDraw = (a: Draw, b: Draw): Draw | undefined => {
	if (a.relation !== b.relation) {
		return undefined
	}
	const columns = new Map(
		[...a.columns].filter(([column, field]) => b.columns.get(column) === field)
	)
	return columns.size > 0
		? { relation: a.relation, columns, through: hopsOf(a.through, b.through) }
		: undefined
}

/**
 * One definition's walk of its draws: the schema's declared containments, and each node's draws once computed, so a node
 * the definition reads along several paths (an arm and an occurrence over one sub-query) is walked once.
 */
interface Drawing {
	readonly containments: ReadonlyMap<string, ReadonlyArray<FieldContainment>>
	readonly known: Map<RelNode, ReadonlyArray<Draw>>
}

/** The text that names a draw's relation and its columns at their fields, whatever containments it rides on. */
const drawKey = (d: Draw): string =>
	JSON.stringify([d.relation, [...d.columns].toSorted(([a], [b]) => compareStrings(a, b))])

/**
 * `draws` as a set: one draw for each relation and each map of columns to its fields, riding on every containment any
 * draw it stands for rides on (`hopsOf`). Draws of one relation that one occurrence after another, or one containment
 * path after another, reaches differ in nothing but their hops, and a union meets each arm's draws with what its arms
 * before kept: without the set, its draws were the product of its arms' (a 4-arm union of metis's ops role held 6,098
 * draws, 34 distinct, and its compile ran out of memory); with it, at most the distinct draws its arms meet in.
 */
const drawSet = (draws: ReadonlyArray<Draw>): ReadonlyArray<Draw> => {
	const out = new Map<string, Draw>()
	for (const d of draws) {
		const key = drawKey(d)
		const had = out.get(key)
		out.set(key, had === undefined ? d : { ...had, through: hopsOf(had.through, d.through) })
	}
	return [...out.values()]
}

/** The draws of `node` in `drawing` (drawsOf) as a set (`drawSet`), each node's computed once. */
const drawn = (node: RelNode, drawing: Drawing): ReadonlyArray<Draw> => {
	const known = drawing.known.get(node)
	if (known !== undefined) {
		return known
	}
	const draws = drawSet(drawsOf(node, drawing))
	drawing.known.set(node, draws)
	return draws
}

/**
 * The draws of a node's rows (`Draw`), each a relation every row of the node takes the drawn columns from, jointly, from
 * one row: a stored relation's own rows, closed under its declared containments; a region's columns that one
 * occurrence's source binds, its row's (every binding of a region is a row of each occurrence, and a variable equals
 * every column its class binds); a projection's columns that read an input column as it stands (a column it computes
 * or casts draws nothing); the rows a node keeps of its input or its left side as they stand (a filter, a step, a take,
 * an ordered result, an existence test, a set difference) or of either side (an intersection); a fold's grouping
 * columns, its input's; and a union's columns that every arm draws from one relation at one field, since each row of the
 * union is a row of some arm. Every other node draws nothing: a view read by its table, a closed relation's values, the
 * statement's sets.
 */
const drawsOf = (node: RelNode, drawing: Drawing): ReadonlyArray<Draw> => {
	switch (node.kind) {
		case "Base":
			return node.relationKind === "relation"
				? closedDraws(
						{
							relation: node.relation,
							columns: new Map(node.heading.map((c) => [c.name, c.name])),
							through: []
						},
						drawing.containments
					)
				: []
		case "MatchRegion": {
			const classOf = regionVarClasses(node)
			return node.occurrences.flatMap((o) =>
				renamedDraws(drawn(o.source, drawing), (column) => {
					const bound = o.bindings.filter((b) => b.column === column)
					return node.heading.flatMap((h) => {
						const v = node.vars.find((x) => x.name === h.name)
						return v !== undefined && bound.some((b) => classOf(b.var) === classOf(v))
							? [h.name]
							: []
					})
				})
			)
		}
		case "ProjectSet":
			return renamedDraws(drawn(node.input, drawing), (column) =>
				node.out.flatMap((o) =>
					o.expr.kind === "column" &&
					o.expr.column.node === node.input.id &&
					o.expr.column.name === column
						? [o.name]
						: []
				)
			)
		case "Filter":
		case "Step":
		case "Take":
		case "OrderedResult":
			return drawn(node.input, drawing)
		case "SemiJoin":
		case "AntiJoin":
		case "Difference":
			return drawn(node.left, drawing)
		case "Intersect":
			return [...drawn(node.left, drawing), ...drawn(node.right, drawing)]
		case "Group":
			return renamedDraws(drawn(node.input, drawing), (column) =>
				node.keys.includes(column) ? [column] : []
			)
		case "Union": {
			const [first, ...rest] = unionArms(node.groups)
			return rest.reduce<ReadonlyArray<Draw>>(
				(kept, arm) => {
					const armDraws = drawn(arm, drawing)
					return drawSet(
						kept.flatMap((a) =>
							armDraws.flatMap((b) => {
								const common = commonDraw(a, b)
								return common === undefined ? [] : [common]
							})
						)
					)
				},
				drawn(first, drawing)
			)
		}
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "ApproximateNearest":
		case "Attach":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
		case "Call":
			return []
	}
}

/**
 * The dependencies a derived relation's columns hold, its definition rooted at `root` over `owned`: for each relation
 * every row of the definition draws columns from, jointly, at fields of one of its rows (`drawsOf`), those columns are
 * contained in that relation, field for field, and the containment gives what a declared one would
 * (`containmentDependencies`). A dependency that holds in each arm of a union alone does not hold of the union, whose two
 * arms' rows may agree where the arms' relations differ; a containment every arm holds into one relation holds of every
 * row of the union, each some arm's row, so the dependency its target's key gives holds of the union: each sitting's
 * status drawn, in every rule, from its assignment's (child, number) or from its events', which its assignment's
 * contain, so its number, which keys an assignment, determines its child. The dependencies rank and prove the reads of
 * the view (a chain's order, a per-key read: lower/optimize/cte-policy boundPrefix), never a row a read returns, so a
 * containment the schema checks at COMMIT, deferred, gives its dependency while a transaction holds a row it has yet to
 * meet: the proof reads the facts every committed state holds.
 */
export const viewDependencies = (owned: Owned, root: RelNode): ReadonlyArray<ContainedDependency> =>
	viewContainments(owned, root).flatMap((c) =>
		containmentDependencies(c.pairs, keysOf(owned, c.target))
	)

/**
 * The containments of a derived relation's columns, its definition rooted at `root` over `owned`: for each relation every
 * row of the definition draws columns from, jointly, at fields of one of its rows (`drawsOf`), those columns in that
 * relation, field for field, and the declared containments the draw rides on to reach it (`through`), which every arm's
 * draw rides on together: each row of the view is some arm's row, whose fields a row of the target holds by them.
 */
export const viewContainments = (
	owned: Owned,
	root: RelNode
): ReadonlyArray<FieldContainment & { readonly through: ReadonlyArray<ContainmentHop> }> => {
	const drawing: Drawing = { containments: declaredContainments(owned), known: new Map() }
	return drawn(root, drawing).flatMap((d) => {
		const pairs = [...d.columns].map(([left, right]) => ({ left, right }))
		return isNonEmpty(pairs) ? [{ target: d.relation, pairs, through: d.through }] : []
	})
}
