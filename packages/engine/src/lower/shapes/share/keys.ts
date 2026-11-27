import { postorder } from "@bjornpagen/grizzle-text/base/graph"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { FixedFacts } from "#compiler/analysis/physical/props.ts"
import { outerOf } from "#compiler/analysis/physical/rules.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import { Fold } from "#compiler/ir/fold.ts"
import {
	edgesOf,
	inputsOf,
	type NodeOf,
	type Occurrence,
	type RelNode,
	regionVarClasses,
	unionArms,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { conjuncts } from "#compiler/logical/props.ts"
import { queryInputs, restrictsInside } from "#compiler/lower/conservative/context.ts"
import {
	attachmentRead,
	correlatedSites,
	renamedSource,
	restrictedByValues,
	semiJoinDriven,
	valueFixings
} from "#compiler/lower/optimize/cte-policy/index.ts"
import {
	type ChainSite,
	chainSites,
	regionChain,
	sitesAtRows,
	statementValue,
	unitAtValues
} from "#compiler/lower/shapes/share/sites.ts"
import { inPartition } from "#compiler/lower/shapes/take/partition.ts"

/**
 * The keys a shared node is read at, by every one of its reads (magic sets): the rows a statement needs of the node are
 * the node's rows whose `columns` equal a row of one of its `sources`, each the bindings one read's region holds of
 * them, so the node computed at those keys alone delivers every row any read of it meets; or `whole`, where some read
 * binds none of its columns from what the statement fixes, and the node is computed whole.
 */
export type KeyRestriction =
	| { readonly kind: "whole" }
	| {
			readonly kind: "keys"
			readonly columns: NonEmptyReadonlyArray<string>
			readonly sources: NonEmptyReadonlyArray<KeySource>
	  }

/**
 * One read's keys: a conjunctive query over slots, its atoms each a relation the statement reads where the key source
 * stands, each column it binds at a slot, two atoms equal where they bind one slot, and `keys` the slot each of the
 * node's restricted columns is at. Its `seeds` are what the statement fixes (a carried or value-restricted source, a
 * stored relation read at a value that binds one of its keys or its unit's (share/sites.ts unitAtValues; one a value
 * binds looser seeds only where nothing tighter reaches the read), the reading region's own keys, an existence test's
 * left side, an outer row a correlation reads), joined where they stand; its `steps` the fewest occurrences of the
 * reading region that join them to the read's variables, in the order the crossing reached them, each read at the
 * slots an atom before it binds, as a navigation's step is read at the values the steps before it bound.
 */
export interface KeySource {
	readonly seeds: ReadonlyArray<KeyAtom>
	readonly steps: ReadonlyArray<ReadAtom>
	/** Slots a value of the statement's own fixes: a correlation to a parameter. */
	readonly fixed: ReadonlyArray<{ readonly slot: string; readonly expr: ScalarExpr }>
	readonly keys: NonEmptyReadonlyArray<{ readonly column: string; readonly slot: string }>
}

/**
 * An atom of a key source: a node read where it stands, at its constants, each of `bindings`' columns at its slot; the
 * source of the outer row the reading region is evaluated for, read where it stands (`outer`), each column of that row
 * the read is fixed to at its slot, every outer row's values at once; a stored relation read where it stands at a condition of the statement's values over its columns (`filtered`), the
 * condition stated over the columns of node `at` and each read as the column of the relation `columns` names; or the
 * keys of a node, the key set of the region the source crosses, read where the source stands.
 */
export type KeyAtom =
	| {
			readonly kind: "read"
			readonly node: RelNode
			readonly bindings: ReadonlyArray<{ readonly column: string; readonly slot: string }>
			readonly constants: ReadonlyArray<{ readonly column: string; readonly expr: ScalarExpr }>
	  }
	| {
			readonly kind: "outer"
			readonly node: RelNode
			readonly bindings: ReadonlyArray<{ readonly column: string; readonly slot: string }>
	  }
	| {
			readonly kind: "filtered"
			readonly node: RelNode
			readonly bindings: ReadonlyArray<{ readonly column: string; readonly slot: string }>
			readonly condition: ScalarExpr
			readonly at: NodeId
			readonly columns: ReadonlyMap<string, string>
	  }
	| {
			readonly kind: "keys"
			readonly of: RelNode
			readonly keys: Keys
			readonly bindings: ReadonlyArray<{ readonly column: string; readonly slot: string }>
	  }

/** A node read where a key source stands: what a key source's step is, a lookup at the slots before it (KeyAnalysis #lookup). */
export type ReadAtom = Extract<KeyAtom, { readonly kind: "read" }>

/** A key set that restricts: the keys a node's reads read it at. */
export type Keys = Extract<KeyRestriction, { readonly kind: "keys" }>

/** What each column of a node is fixed to per evaluation (PhysicalProps fixed), which a correlated read's equalities are. */
export type FixedOf = (node: RelNode) => ReadonlyMap<string, FixedFacts>

/** Every atom of a key source: its seeds, then its steps. */
export const atomsOf = (source: KeySource): ReadonlyArray<KeyAtom> => [
	...source.seeds,
	...source.steps
]

/** The nodes a key set's sources read where they stand, through the key sets they read in turn. */
export const keySetReads = (keys: Keys): ReadonlyArray<RelNode> =>
	keys.sources.flatMap((s) =>
		atomsOf(s).flatMap((a): ReadonlyArray<RelNode> =>
			a.kind === "keys" ? keySetReads(a.keys) : [a.node]
		)
	)

/**
 * What a region's crossing may read for one of its occurrences (KeyAnalysis #crossing): the slots it binds, and the
 * atoms it reads them by, read together: those what the statement fixes restricts, its seeds, a seed of the crossing
 * where it has one, and those read at the slots an atom before them binds, its steps, in that order.
 */
interface Candidate {
	readonly slots: ReadonlyArray<string>
	readonly seeds: ReadonlyArray<KeyAtom>
	readonly steps: ReadonlyArray<ReadAtom>
}

/** The key set of a node every row of which a statement reads. */
export const whole: KeyRestriction = { kind: "whole" }

/**
 * A page's rows read once per window row, at the key of the window's driver (lower/shapes/page/driver.ts): `reader`, the
 * node over `rows` (its lowest attachment, or its ordered result), reads them at the `key` columns, each fixed to the
 * window row's value, so they read no key set (rowReads).
 */
export interface PagedRead {
	readonly reader: RelNode
	readonly rows: RelNode
	readonly key: ReadonlyArray<string>
}

/** No page's rows: a statement no window reads per row. */
export const noPagedReads: ReadonlyArray<PagedRead> = []

/**
 * The key sets of a statement's nodes (keysOf), worked out top-down, a node's from its readers' among the statement's:
 * each read of a node gives its keys, a region's by the fewest of its occurrences that join what the statement fixes
 * there to the variables the read binds (`crossing`), a node that keeps or renames its input's rows (a filter, a step, a
 * union's arm, an existence test's or a set difference's left side, a projection, a fold on its grouping keys, a take on
 * its partition) by its own keys mapped to the input's columns, an existence test's right side by its left side at the
 * test's pairs; a root, and a node any reader keeps none of the keys of (a take's bound beyond its partition, a
 * recursion, a call's argument, an attachment), is whole,
 * and so is every node below it on that path alone. The node's key set is the union of its reads' over the columns
 * every read restricts, each region's read crossing to those columns alone.
 *
 * Soundness: a read's key source holds every binding of the read's variables that the reading node can use. A region's
 * rows are its bindings that hold at every occurrence; each such binding restricted to the occurrences the source
 * crosses holds there, and its seeds hold what the statement fixes, so its value at the read's variables is a row of the
 * source. A keeping or renaming reader's rows needed are its own key set's, by induction from the roots; an existence
 * test's verdict for a left row reads only right rows at that row's pair values. So the node at its key set's rows meets
 * every read as the whole node does, and a key set may always be relaxed (an atom dropped, a constant left out): only
 * K ⊇ π(keys)(the bindings the reads need) is required. A union is restricted inside each arm, a fold only on its
 * grouping keys (a group being its input rows at one key), never on an aggregate, and a take only on its partition (a
 * group's rank reading its group's rows alone, take/partition.ts), never on a column it orders by. The crossing steps only through a
 * region's occurrences, every one a positive conjunct (a negation is an anti-join, whose right side reads its left only
 * as a seed, never a step), and through no source that reads an outer row, which no key source can read.
 */
export class KeyAnalysis {
	readonly #readers = new Map<RelNode, Array<RelNode>>()
	readonly #known = new Map<RelNode, KeyRestriction>()
	readonly #fixed: FixedOf
	/** Which nodes a key source reads by an index lookup, a step of its (Lookups). */
	readonly #lookups: Lookups
	/** The statement's nodes and every input of theirs, by label: what an outer column a node reads names. */
	readonly #byId = new Map<string, RelNode>()
	/**
	 * The reads of each node made per row of a driver (rowReads), lowered at that row's values where they stand, which
	 * read no key set.
	 */
	readonly #rowReads: ReadonlyMap<RelNode, ReadonlySet<RelNode>>

	/**
	 * The key sets of `nodes`, a statement's, each read by those of them that read it, each of `roots` at the key set it
	 * is given: whole for a statement's own, the keys every read of a share reads it at for the statement that fills it;
	 * a correlated read's columns equal to the outer columns `fixed` fixes them to; each step of a key source a node
	 * `lookups` reads by an index lookup; each page's rows `paged` reads per window row (rowReads).
	 */
	constructor(
		nodes: Iterable<RelNode>,
		roots: ReadonlyMap<RelNode, KeyRestriction>,
		fixed: FixedOf,
		lookups: Lookups,
		paged: ReadonlyArray<PagedRead>
	) {
		this.#fixed = fixed
		this.#lookups = lookups
		this.#rowReads = rowReading(nodes, paged).readers
		for (const node of nodes) {
			this.#byId.set(node.id, node)
			for (const input of inputsOf(node)) {
				this.#byId.set(input.id, input)
				const readers = this.#readers.getOrInsertComputed(input, () => [])
				if (!readers.includes(node)) {
					readers.push(node)
				}
			}
		}
		for (const [root, keys] of roots) {
			this.#known.set(root, keys)
		}
	}

	/** The key set of `node`: the union of every read's keys over the columns each restricts, whole where one is. */
	keysOf(node: RelNode): KeyRestriction {
		const known = this.#known.get(node)
		if (known !== undefined) {
			return known
		}
		const readers = this.#keyedReaders(node)
		let found: KeyRestriction = whole
		if (isNonEmpty(readers)) {
			const reached = unionOf(readers.map((reader) => this.#readAt(reader, node, undefined)))
			found =
				reached.kind === "whole"
					? whole
					: unionOf(readers.map((reader) => this.#readAt(reader, node, new Set(reached.columns))))
		}
		/** A key set one of whose sources restricts nothing holds every key: the node is computed whole. */
		const keyed = found.kind === "keys" && found.sources.every(restricting) ? found : whole
		this.#known.set(node, keyed)
		return keyed
	}

	/**
	 * The key set of copies of one sub-query that one computation serves (a share's every copy): the union of each copy's,
	 * whole where any is.
	 */
	keysOfAll(copies: ReadonlyArray<RelNode>): KeyRestriction {
		return unionOf(copies.map((c) => this.keysOf(c)))
	}

	/**
	 * How the reads of `copies` read it where they stand, where every read reads it at values fixed where it stands alone,
	 * a key the node is computed at by itself (computedAt) fixed by a parameter, or by the outer row the reading region is
	 * evaluated for, with no relation read beside: some read so per outer row (`rows`), or none (`values`). PostgreSQL
	 * moves such a value below a fold's grouping and into a union's arms where the node stands inline at each read, each
	 * at its own value, where reads restricting different columns share no key set and computed once the node would be
	 * derived whole; and a read evaluated per outer row reads it at that row's values, an index lookup, where computed once
	 * at every row's keys, a CTE no index reads, each evaluation would scan the computed rows whole: a whole rule's judge
	 * read the seeds of its walk, a union of each written document's root rows, once per document written, 31 documents
	 * scanning 31 rows each.
	 */
	readsAtValues(copies: ReadonlyArray<RelNode>): "values" | "rows" | undefined {
		const reads = copies.flatMap((c) =>
			this.#keyedReaders(c).map((reader) => computedAt(c, this.#readAt(reader, c, undefined)))
		)
		if (!reads.every((read) => read.kind === "keys" && read.sources.every(atValues))) {
			return undefined
		}
		return reads.some((read) => read.kind === "keys" && read.sources.some(perRow))
			? "rows"
			: "values"
	}

	/**
	 * The readers of `node` whose reads a key set serves: every one but those that read it per row of a driver, at that
	 * row's values (rowReads).
	 */
	#keyedReaders(node: RelNode): ReadonlyArray<RelNode> {
		const perRow = this.#rowReads.get(node)
		const readers = this.#readers.get(node) ?? []
		return perRow === undefined ? readers : readers.filter((r) => !perRow.has(r))
	}

	/**
	 * The keys `reader` reads `node` at (KeyAnalysis), whole where it keeps none; a region's crossing to the `wanted`
	 * columns alone where given, the columns every read restricts, so no occurrence joins in for a column the union drops.
	 */
	#readAt(reader: RelNode, node: RelNode, wanted: ReadonlySet<string> | undefined): KeyRestriction {
		switch (reader.kind) {
			case "MatchRegion": {
				const reads = reader.occurrences.flatMap((o) =>
					o.source === node ? [this.#crossing(reader, o, wanted)] : []
				)
				return unionOf(reads)
			}
			case "Filter": {
				const fixed = fixedAt(
					this.keysOf(reader),
					valueFixings(reader).flatMap((f) =>
						statementValue(f.value) ? [{ column: f.column, expr: f.value }] : []
					)
				)
				return fixed.kind === "keys" ? fixed : conditionAt(reader)
			}
			case "Step":
			case "Union":
				return this.keysOf(reader)
			case "Intersect":
			case "Difference":
				return reader.left === node ? this.keysOf(reader) : whole
			case "SemiJoin":
			case "AntiJoin": {
				if (reader.left !== node) {
					return reader.right === node
						? this.#atLeftRows(reader, reader.left, reader.on, wanted)
						: whole
				}
				return this.keysOf(reader)
			}
			case "Attach":
				return reader.child === node && attachmentRead(reader).kind === "coGroup"
					? whole
					: reader.child === node
						? this.#atLeftRows(
								reader,
								reader.parent,
								reader.correlation.map((c) => ({ left: c.parent, right: c.child })),
								wanted
							)
						: this.keysOf(reader)
			case "ProjectSet": {
				const above = this.keysOf(reader)
				return above.kind === "whole"
					? whole
					: renamed(above, (column) => {
							const e = reader.out.find((o) => o.name === column)?.expr
							return e?.kind === "column" && e.column.node === node.id ? e.column.name : undefined
						})
			}
			case "Group": {
				const above = this.keysOf(reader)
				return above.kind === "whole"
					? whole
					: renamed(above, (column) => (reader.keys.includes(column) ? column : undefined))
			}
			case "Take": {
				const above = this.keysOf(reader)
				return above.kind === "whole" ? whole : partitionKeys(reader, above)
			}
			case "ApproximateNearest":
			case "Base":
			case "Call":
			case "Closed":
			case "Context":
			case "Delta":
			case "Forbid":
			case "InputSet":
			case "OrderedResult":
			case "OrderedSetAggregate":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "Window":
				return whole
		}
	}

	/**
	 * The keys of a node read per row of `left` by `reader` at its pairs `on`: an existence test's right side, a left
	 * row's verdict reading it at that row's pair values alone, or an attachment's child, a parent row's attachment
	 * reading it at the correlated values: `left`'s rows, at `reader`'s own keys, each pair's right column at the left
	 * column's value; the pairs of the `wanted` right columns alone where given.
	 */
	#atLeftRows(
		reader: RelNode,
		left: RelNode,
		on: ReadonlyArray<{ readonly left: string; readonly right: string }>,
		wanted: ReadonlySet<string> | undefined
	): KeyRestriction {
		const pairs = on.filter((p) => wanted === undefined || wanted.has(p.right))
		if (!isNonEmpty(pairs)) {
			return whole
		}
		if (outerOf(left).length > 0) {
			return this.#atFixedLeft(left, pairs)
		}
		const above = this.keysOf(reader)
		const slotOf = (column: string): string => `left:${column}`
		const restricted = above.kind === "keys" ? above.columns : []
		const leftColumns = [...new Set([...pairs.map((p) => p.left), ...restricted])]
		const leftRead: ReadAtom = {
			kind: "read",
			node: left,
			bindings: leftColumns.map((c) => ({ column: c, slot: slotOf(c) })),
			constants: []
		}
		const [first, ...rest] = pairs
		return {
			kind: "keys",
			columns: [first.right, ...rest.map((p) => p.right)],
			sources: [
				{
					...(above.kind === "keys" && this.#lookups.readByLookup(left)
						? {
								seeds: [
									{
										kind: "keys",
										of: reader,
										keys: above,
										bindings: above.columns.map((c) => ({ column: c, slot: slotOf(c) }))
									}
								],
								steps: [leftRead]
							}
						: { seeds: [leftRead], steps: [] }),
					fixed: [],
					keys: [
						{ column: first.right, slot: slotOf(first.left) },
						...rest.map((p) => ({ column: p.right, slot: slotOf(p.left) }))
					]
				}
			]
		}
	}

	/**
	 * The keys of a node read per row of a correlated `left` at `pairs`: each pair whose left column the physical
	 * analysis fixes to an outer row's column (PhysicalProps fixed, outer), every left row's value there that row's, read
	 * from that outer node where it stands, each outer row (#outerSource `row`) one atom binding every column of it the
	 * pairs read; whole where no pair's left column is so fixed.
	 */
	#atFixedLeft(
		left: RelNode,
		pairs: NonEmptyReadonlyArray<{ readonly left: string; readonly right: string }>
	): KeyRestriction {
		const facts = this.#fixed(left)
		const slotOf = (column: string): string => `left:${column}`
		const byOuter = new Map<
			object,
			{
				readonly node: RelNode
				readonly bindings: Array<{ readonly column: string; readonly slot: string }>
			}
		>()
		const keys: Array<{ readonly column: string; readonly slot: string }> = []
		for (const p of pairs) {
			const outer = (facts.get(p.left) ?? []).flatMap((f) => {
				const source =
					f.fixed.kind === "outer" ? this.#outerSource(f.fixed.node, f.fixed.column) : undefined
				return source === undefined ? [] : [source]
			})
			const [first] = outer
			if (first === undefined) {
				continue
			}
			byOuter
				.getOrInsertComputed(first.row, () => ({ node: first.node, bindings: [] }))
				.bindings.push({ column: first.column, slot: slotOf(p.left) })
			keys.push({ column: p.right, slot: slotOf(p.left) })
		}
		const [head, ...tail] = keys
		return head === undefined
			? whole
			: {
					kind: "keys",
					columns: [head.column, ...tail.map((k) => k.column)],
					sources: [
						{
							seeds: [...byOuter.values()].map((o): KeyAtom => ({
								kind: "outer",
								node: o.node,
								bindings: o.bindings
							})),
							steps: [],
							fixed: [],
							keys: [head, ...tail]
						}
					]
				}
	}

	/**
	 * A region's read of a node at occurrence `o`: the fewest of the region's occurrences that join what the statement
	 * fixes there to the variables `o` binds (of its `wanted` columns, where given), by a breadth-first reach over the
	 * region's variable classes from its seeds, each occurrence reached kept only where a path to one of those variables
	 * passes it; the columns of the node whose variables it reaches are its keys, whole where it reaches none. A stored
	 * relation a constant of the statement's holds at no key and no unit seeds the reach only where the tighter seeds
	 * reach none of those variables, else it is a step read at the slots before it, its constants beside them: metis's
	 * myOpenSittingsOf derived each sitting's status at every learner's assignments of the test the call names, the key
	 * set of the test's assignments alone, 633 rows beside 105 learners, where the claims' Clerk user, its person and the
	 * person's assignments of the test reach one.
	 */
	#crossing(
		region: NodeOf<"MatchRegion">,
		o: Occurrence,
		wanted: ReadonlySet<string> | undefined
	): KeyRestriction {
		const classOf = regionVarClasses(region)
		/**
		 * Each variable class merged into another: a correlated read's column the physical analysis fixes to a column of
		 * another read of the region (PhysicalProps fixed, outer), the two equal at every row, as a LATERAL's correlation
		 * equates them where the region states no equality.
		 */
		const merged = new Map<string, string>()
		const find = (s: string): string => {
			let at = s
			for (let next = merged.get(at); next !== undefined; next = merged.get(at)) {
				at = next
			}
			return at
		}
		const slot = (v: VarDecl): string => find(`v:${classOf(v)}`)
		const bySource = new Map<string, Occurrence | "twice">()
		for (const q of region.occurrences) {
			bySource.set(q.source.id, bySource.has(q.source.id) ? "twice" : q)
		}
		for (const q of region.occurrences) {
			const facts = this.#fixed(q.source)
			for (const b of q.bindings) {
				for (const f of facts.get(b.column) ?? []) {
					const at = f.fixed
					const sibling = at.kind === "outer" ? bySource.get(at.node) : undefined
					const w =
						at.kind !== "outer"
							? undefined
							: at.node === region.id
								? region.vars.find((x) => x.name === at.column)
								: sibling !== undefined && sibling !== "twice" && sibling !== q
									? sibling.bindings.find((x) => x.column === at.column)?.var
									: undefined
					if (w !== undefined) {
						const [a, c] = [slot(b.var), slot(w)]
						if (a !== c) {
							merged.set(a, c)
						}
					}
				}
			}
		}
		/** Each atom reached, in order, with whether it is a seed, joined where it stands, or a step, read at earlier slots. */
		const atoms: Array<
			| { readonly seed: true; readonly atom: KeyAtom }
			| { readonly seed: false; readonly atom: ReadAtom }
		> = []
		const fixed: Array<{ readonly slot: string; readonly expr: ScalarExpr }> = []
		/** Each slot reached, with the atom that first bound it. */
		const reached = new Map<string, number>()
		const reach = (
			entry:
				| { readonly seed: true; readonly atom: KeyAtom }
				| { readonly seed: false; readonly atom: ReadAtom }
		): number => {
			const at = atoms.length
			atoms.push(entry)
			for (const b of entry.atom.bindings) {
				if (!reached.has(b.slot)) {
					reached.set(b.slot, at)
				}
			}
			return at
		}
		const readOf = (q: Occurrence): ReadAtom => ({
			kind: "read",
			node: q.source,
			bindings: q.bindings.map((b) => ({ column: b.column, slot: slot(b.var) })),
			constants: q.constants.filter((c) => statementValue(c.expr))
		})
		/** An occurrence the key source may read where it stands: one whose source reads no outer row. */
		const readable = (q: Occurrence): boolean => q !== o && outerOf(q.source).length === 0
		const above = this.keysOf(region)
		if (above.kind === "keys") {
			reach({
				seed: true,
				atom: {
					kind: "keys",
					of: region,
					keys: above,
					bindings: above.columns.flatMap((c) => {
						const v = region.vars.find((x) => x.name === c)
						return v === undefined ? [] : [{ column: c, slot: slot(v) }]
					})
				}
			})
		}
		/** The outer rows the read is fixed to, by the row (#outerSource `row`), each the columns it reads of it. */
		const outerRows = new Map<
			object,
			{
				readonly node: RelNode
				readonly bindings: Array<{ readonly column: string; readonly slot: string }>
			}
		>()
		/** An outer row's column `column` of node `id` at `at`, where its source is read where it stands. */
		const outerAt = (id: string, column: string, at: string): boolean => {
			const source = this.#outerSource(id, column)
			if (source === undefined) {
				return false
			}
			outerRows
				.getOrInsertComputed(source.row, () => ({ node: source.node, bindings: [] }))
				.bindings.push({ column: source.column, slot: at })
			return true
		}
		for (const c of region.correlated) {
			if (statementValue(c.expr)) {
				fixed.push({ slot: slot(c.var), expr: c.expr })
				reached.set(slot(c.var), -1)
			} else if (c.expr.kind === "column") {
				outerAt(c.expr.column.node, c.expr.column.name, slot(c.var))
			}
		}
		/** The read's own columns it fixes: at a value of the statement's, or at an outer row's column. */
		const own: Array<{ readonly column: string; readonly slot: string }> = []
		for (const c of o.constants) {
			if (wanted !== undefined && !wanted.has(c.column)) {
				continue
			}
			const at = `const:${c.column}`
			if (statementValue(c.expr)) {
				fixed.push({ slot: at, expr: c.expr })
				own.push({ column: c.column, slot: at })
				continue
			}
			if (c.expr.kind === "column" && outerAt(c.expr.column.node, c.expr.column.name, at)) {
				own.push({ column: c.column, slot: at })
			}
		}
		for (const row of outerRows.values()) {
			reach({ seed: true, atom: { kind: "outer", node: row.node, bindings: row.bindings } })
		}
		/**
		 * The occurrences a constant of the statement's holds at no key and no unit (share/sites.ts unitAtValues), each its
		 * seed and its step where an index reads it at keys: a seed only where nothing the statement fixes tighter reaches
		 * the read's variables, else a step read at the slots an atom before it binds, its constants beside them.
		 */
		const loose: Array<{ readonly seed: Candidate; readonly step: Candidate | undefined }> = []
		/**
		 * Each other occurrence as the atoms the key source reads for it: its source where it reads no outer row, or a
		 * correlated one decorrelated (#decorrelated); a seed where what the statement fixes restricts it, its rows a
		 * set the statement's values restrict or a stored relation's at a key or a unit its constants bind (`loose` for
		 * any other a constant holds).
		 */
		const pending = new Set(
			region.occurrences.flatMap((q): ReadonlyArray<Candidate> => {
				if (q === o) {
					return []
				}
				if (readable(q)) {
					const atom = readOf(q)
					const slots = atom.bindings.map((b) => b.slot)
					const held = q.constants.some((c) => statementValue(c.expr))
					/** A source no index reads at keys (#lookup), a fold, a union or a computed node among them, is no step. */
					const step = this.#lookups.readByLookup(q.source)
						? { slots, seeds: [], steps: [atom] }
						: undefined
					if (restrictedByValues(q.source) || (held && unitAtValues(region, q))) {
						return [{ slots, seeds: [atom], steps: [] }]
					}
					if (held) {
						loose.push({ seed: { slots, seeds: [atom], steps: [] }, step })
					}
					return step === undefined ? [] : [step]
				}
				const decorrelated = this.#decorrelated(q, slot, (id, column) => {
					if (id === region.id) {
						const v = region.vars.find((x) => x.name === column)
						return v === undefined ? undefined : slot(v)
					}
					const sibling = bySource.get(id)
					const b =
						sibling === undefined || sibling === "twice" || sibling === q
							? undefined
							: sibling.bindings.find((x) => x.column === column)
					return b === undefined ? undefined : slot(b.var)
				})
				return decorrelated === undefined ? [] : [decorrelated]
			})
		)
		/** The atom each atom was reached from, by its place: its parent on the path; and the atoms read together. */
		const parent = new Map<number, number>()
		const together = new Map<number, ReadonlyArray<number>>()
		/**
		 * A candidate's atoms reached, its seeds first, then its steps, the first from `via` where it has no seed, all kept
		 * where one is.
		 */
		const take = (c: Candidate, via: number | undefined): void => {
			const at = [
				...c.seeds.map((atom) => reach({ seed: true, atom })),
				...c.steps.map((atom) => reach({ seed: false, atom }))
			]
			for (const i of at) {
				together.set(i, at)
			}
			const [first] = at
			if (via !== undefined && first !== undefined) {
				parent.set(first, via)
			}
		}
		for (const c of pending) {
			if (c.seeds.length > 0) {
				pending.delete(c)
				take(c, undefined)
			}
		}
		const aimed = o.bindings.filter((b) => wanted === undefined || wanted.has(b.column))
		const targets = new Set(aimed.map((b) => slot(b.var)))
		const done = (): boolean => [...targets].every((t) => reached.has(t))
		/** Each pending candidate an atom reached taken, from the first atom that reached it, until the targets are reached. */
		const grow = (): void => {
			for (let grew = true; grew && !done();) {
				grew = false
				for (const c of pending) {
					const via = c.slots.map((at) => reached.get(at)).find((x) => x !== undefined)
					if (via === undefined) {
						continue
					}
					pending.delete(c)
					take(c, via)
					grew = true
					if (done()) {
						break
					}
				}
			}
		}
		grow()
		if (!done()) {
			for (const l of loose) {
				if (l.step === undefined || pending.delete(l.step)) {
					take(l.seed, undefined)
				}
			}
			grow()
		}
		const keys = [
			...own,
			...aimed.flatMap((b) => {
				const s = slot(b.var)
				return reached.has(s) ? [{ column: b.column, slot: s }] : []
			})
		]
		if (!isNonEmpty(keys)) {
			return whole
		}
		/** The atoms on the paths from the seeds to the keys: the minimal crossing. */
		const kept = new Set<number>()
		const keep = (from: number | undefined): void => {
			for (let at = from; at !== undefined && at >= 0 && !kept.has(at); at = parent.get(at)) {
				for (const i of together.get(at) ?? [at]) {
					kept.add(i)
					if (i !== at) {
						keep(parent.get(i))
					}
				}
			}
		}
		for (const k of keys) {
			keep(reached.get(k.slot))
		}
		const used = atoms.filter((_, i) => kept.has(i))
		const bound = new Set(used.flatMap((a) => a.atom.bindings.map((b) => b.slot)))
		return {
			kind: "keys",
			columns: mapKeys(keys, (k) => k.column),
			sources: [
				{
					seeds: used.flatMap((a) => (a.seed ? [a.atom] : [])),
					steps: used.flatMap((a) => (a.seed ? [] : [a.atom])),
					fixed: fixed.filter((f) => bound.has(f.slot) || keys.some((k) => k.slot === f.slot)),
					keys
				}
			]
		}
	}

	/**
	 * A correlated occurrence `q` as atoms a key source reads where it stands: its source's rows, through steps, filters
	 * and projections of columns, are one region's single read of a source that reads no outer row, its correlations and
	 * constants equating columns of it to outer rows' columns; read decorrelated, that source with each such column at the
	 * value the outer source holds (#outerSource), its rows those of every outer row at once, a relaxation of what `q`
	 * reads for each, beside each outer source, one atom for each outer row, binding every column `q` reads of it. Where
	 * the statement's values restrict an outer source (a delta's keys, the unit a probe's chain steps from), the
	 * candidate is a seed: those sources first, the source read at the values they bind, then the other outer sources at
	 * the values it binds; where a constant of the statement's restricts the source itself, it is the seed; and where
	 * neither, every atom is a step, the source first, read at the slots a read beside `q` binds. None for any other
	 * occurrence, which the crossing does not step through.
	 */
	#decorrelated(
		q: Occurrence,
		slot: (v: VarDecl) => string,
		beside: (node: string, column: string) => string | undefined
	): Candidate | undefined {
		/** Each column of `at` that `q` binds, by the slot its variable stands at. */
		let map = new Map(q.bindings.map((b) => [b.column, slot(b.var)] as const))
		let at = q.source
		for (;;) {
			if (at.kind === "Step" || at.kind === "Filter") {
				at = at.input
				continue
			}
			if (at.kind === "ProjectSet") {
				const input = at.input
				const out = at.out
				map = new Map(
					[...map].flatMap(([column, s]) => {
						const e = out.find((x) => x.name === column)?.expr
						return e?.kind === "column" && e.column.node === input.id
							? [[e.column.name, s] as const]
							: []
					})
				)
				at = input
				continue
			}
			break
		}
		const [p, ...more] = at.kind === "MatchRegion" ? at.occurrences : []
		if (
			at.kind !== "MatchRegion" ||
			p === undefined ||
			more.length > 0 ||
			outerOf(p.source).length > 0 ||
			!this.#lookups.readByLookup(p.source)
		) {
			return undefined
		}
		const region = at
		const classOf = regionVarClasses(region)
		const bindings: Array<{ readonly column: string; readonly slot: string }> = []
		/** Each outer row's source and the columns `q` reads of it, by the row (#outerSource `row`). */
		const outers = new Map<
			object,
			{
				readonly node: RelNode
				readonly bindings: Array<{ readonly column: string; readonly slot: string }>
			}
		>()
		const constants = p.constants.filter((c) => statementValue(c.expr))
		/**
		 * `column` of the source equated to an outer row's column: the slot a variable of the reading region holds it at,
		 * where a read beside `q` binds it (`beside`), or an atom of the outer source that holds it (#outerSource).
		 */
		const equate = (column: string, node: string, outerColumn: string): void => {
			const besideSlot = beside(node, outerColumn)
			if (besideSlot !== undefined) {
				bindings.push({ column, slot: besideSlot })
				return
			}
			const outer = this.#outerSource(node, outerColumn)
			if (outer !== undefined) {
				const corr = `corr:${q.id}:${column}`
				bindings.push({ column, slot: corr })
				outers
					.getOrInsertComputed(outer.row, () => ({ node: outer.node, bindings: [] }))
					.bindings.push({ column: outer.column, slot: corr })
			}
		}
		for (const b of p.bindings) {
			const bound = [...map].find(([name]) => {
				const v = region.vars.find((x) => x.name === name)
				return v !== undefined && classOf(v) === classOf(b.var)
			})?.[1]
			if (bound !== undefined) {
				bindings.push({ column: b.column, slot: bound })
			}
			const c = region.correlated.find((x) => classOf(x.var) === classOf(b.var))
			if (c?.expr.kind === "column") {
				equate(b.column, c.expr.column.node, c.expr.column.name)
			}
		}
		for (const c of p.constants) {
			if (c.expr.kind === "column") {
				equate(c.column, c.expr.column.node, c.expr.column.name)
			}
		}
		if (bindings.length === 0) {
			return undefined
		}
		const read: ReadAtom = { kind: "read", node: p.source, bindings, constants }
		const outerReads = [...outers.values()].map((o) => ({
			atom: { kind: "read", node: o.node, bindings: o.bindings, constants: [] } satisfies ReadAtom,
			restricted: restrictedByValues(o.node)
		}))
		const restricted = outerReads.flatMap((o) => (o.restricted ? [o.atom] : []))
		/** The outer sources read as steps, each a lookup (#lookup); one that is none only relaxes the source, so it goes. */
		const others = outerReads.flatMap((o) =>
			o.restricted || !this.#lookups.readByLookup(o.atom.node) ? [] : [o.atom]
		)
		const steps = outerReads.flatMap((o) =>
			this.#lookups.readByLookup(o.atom.node) ? [o.atom] : []
		)
		return {
			slots: bindings.map((b) => b.slot),
			...(constants.length > 0
				? { seeds: [read], steps }
				: restricted.length > 0
					? { seeds: restricted, steps: [read, ...others] }
					: { seeds: [], steps: [read, ...others] })
		}
	}

	/**
	 * Where an outer row's column `column` of node `id` is read where it stands: the node itself where it reads no outer
	 * row and holds no node it would be read beside; an enclosing region's variable, by the occurrence that binds it, a
	 * source of the region read where it stands, or by the outer column its correlation reads in turn; a projection's
	 * column, by its input's. The region whose row a correlated node reads encloses that node, so reading the region
	 * itself would read the node it restricts: its binding occurrence gives the same values without it.
	 */
	#outerSource(
		id: string,
		column: string
	): { readonly node: RelNode; readonly column: string; readonly row: object } | undefined {
		const node = this.#byId.get(id)
		if (node === undefined) {
			return undefined
		}
		if (node.kind === "MatchRegion") {
			const v = node.vars.find((x) => x.name === column)
			if (v === undefined) {
				return undefined
			}
			for (const q of node.occurrences) {
				const b = q.bindings.find((x) => x.var === v)
				if (b !== undefined && outerOf(q.source).length === 0) {
					return { node: q.source, column: b.column, row: q }
				}
			}
			const c = node.correlated.find((x) => x.var === v)
			return c?.expr.kind === "column"
				? this.#outerSource(c.expr.column.node, c.expr.column.name)
				: undefined
		}
		if (node.kind === "ProjectSet") {
			const e = node.out.find((o) => o.name === column)?.expr
			return e?.kind === "column" && e.column.node === node.input.id
				? this.#outerSource(node.input.id, e.column.name)
				: undefined
		}
		return outerOf(node).length === 0 ? { node, column, row: node } : undefined
	}
}

/**
 * The keys a filter reads its input region at by a conjunct that fixes no column to a value: a condition of the
 * statement's values over columns one stored relation of the region binds, `state = $1 OR hub = $1`, that relation's
 * rows at the condition, each column at a slot of its own; whole where no conjunct is one. learning-commons' crosswalk
 * of one standard reads the pairs whose state or hub it is, beside how many components support each end, a fold of
 * every standard's supports, which no value fixed: its key set reads those pairs' ends alone.
 */
const conditionAt = (filter: NodeOf<"Filter">): KeyRestriction => {
	const region = filter.input
	if (region.kind !== "MatchRegion") {
		return whole
	}
	for (const e of conjuncts(filter.pred)) {
		if (e.deps.params.length === 0 || !e.deps.nodes.every((n) => n === region.id)) {
			continue
		}
		const read = [
			...new Set(
				exprClosure([e]).flatMap((x) =>
					x.kind === "column" && x.column.node === region.id ? [x.column.name] : []
				)
			)
		]
		const bound = (
			q: Occurrence
		): ReadonlyArray<{ readonly name: string; readonly column: string }> =>
			read.flatMap((name) => {
				const b = q.bindings.find((x) => x.var.name === name)
				return b === undefined ? [] : [{ name, column: b.column }]
			})
		const o = region.occurrences.find(
			(q) => q.source.kind === "Base" && bound(q).length === read.length
		)
		const [first, ...rest] = o === undefined ? [] : bound(o)
		if (o === undefined || first === undefined) {
			continue
		}
		const columns: NonEmptyReadonlyArray<{ readonly name: string; readonly column: string }> = [
			first,
			...rest
		]
		const slotOf = (name: string): string => `filter:${name}`
		return {
			kind: "keys",
			columns: mapKeys(columns, (c) => c.name),
			sources: [
				{
					seeds: [
						{
							kind: "filtered",
							node: o.source,
							bindings: columns.map((c) => ({ column: c.column, slot: slotOf(c.name) })),
							condition: e,
							at: region.id,
							columns: new Map(columns.map((c) => [c.name, c.column] as const))
						}
					],
					steps: [],
					fixed: [],
					keys: mapKeys(columns, (c) => ({ column: c.name, slot: slotOf(c.name) }))
				}
			]
		}
	}
	return whole
}

/**
 * Which nodes are read at keys by an index lookup, as a key source's step reads a node at the values the atoms before
 * it bind (keyed.ts KeyedLowering #sourceRows) and a node computed at keys is read LATERAL per key (KeyedLowering body):
 * a stored relation; a step, a projection of columns or a filter over such a read; a region of stored relations alone;
 * never a node the statement computes once and reads where it stands (`computed`: a CTE, a carrier), nor anything over
 * one, which no index reads. Any other read would meet a key set in a join whose plan depends on its estimate:
 * PostgreSQL rescans a CTE on a nested loop's inner side for each outer row, and at an estimate of one row it chose to,
 * lower-shapes/read-once's derived relation of 450 rows scanned for each of 52 keys.
 */
export class Lookups {
	readonly #computed: (node: RelNode) => boolean
	/** Whether each node is read by a lookup, worked out once. */
	readonly #known = new Map<RelNode, boolean>()

	constructor(computed: (node: RelNode) => boolean) {
		this.#computed = computed
	}

	readByLookup(node: RelNode): boolean {
		const known = this.#known.get(node)
		if (known !== undefined) {
			return known
		}
		const lookup = ((): boolean => {
			if (this.#computed(node)) {
				return false
			}
			switch (node.kind) {
				case "Base":
					return true
				case "Step":
				case "ProjectSet":
				case "Filter":
					return this.readByLookup(node.input)
				case "MatchRegion":
					return node.occurrences.every(
						(o) => o.source.kind === "Base" && !this.#computed(o.source)
					)
				case "AntiJoin":
				case "ApproximateNearest":
				case "Attach":
				case "Call":
				case "Closed":
				case "Context":
				case "Delta":
				case "Difference":
				case "Forbid":
				case "Group":
				case "InputSet":
				case "Intersect":
				case "OrderedResult":
				case "OrderedSetAggregate":
				case "Produce":
				case "Recursive":
				case "SelfRef":
				case "SemiJoin":
				case "Take":
				case "Union":
				case "Window":
					return false
			}
		})()
		this.#known.set(node, lookup)
		return lookup
	}
}

/** `xs` mapped, a non-empty array staying one. */
const mapKeys = <T, U>(xs: NonEmptyReadonlyArray<T>, f: (x: T) => U): NonEmptyReadonlyArray<U> => {
	const [first, ...rest] = xs
	return [f(first), ...rest.map(f)]
}

/**
 * Whether a key source restricts the node it keys: a slot a value of the statement's fixes, or a seed that reads one (a
 * constant of the statement's, a condition over its values), an outer row, a node the statement's values restrict
 * (cte-policy restrictedByValues) or a key set that restricts in turn. A source whose seeds read relations whole holds
 * every key their rows bind, so the node computed at it is the node whole with a key set beside it: the latest
 * assertion of each item session, keyed at eleven whole scans of every asserted value, one LATERAL fold per key.
 */
const restricting = (source: KeySource): boolean =>
	source.fixed.length > 0 ||
	source.seeds.some((a) =>
		a.kind === "read"
			? a.constants.length > 0 || restrictedByValues(a.node)
			: a.kind === "keys"
				? a.keys.sources.every(restricting)
				: true
	)

/** Whether a source reads values of the statement's alone: no relation, only key sets that read values alone in turn. */
const atValues = (source: KeySource): boolean =>
	atomsOf(source).every(
		(a) => a.kind === "outer" || (a.kind === "keys" && a.keys.sources.every(atValues))
	)

/** Whether a source reads the outer row its region is evaluated for, or a key set that does in turn. */
const perRow = (source: KeySource): boolean =>
	atomsOf(source).some(
		(a) => a.kind === "outer" || (a.kind === "keys" && a.keys.sources.some(perRow))
	)

/**
 * A key set over the columns `rename` maps to, each kept column renamed: the columns a reader keeps of its input under
 * its own names; whole where it keeps none.
 */
const renamed = (keys: Keys, rename: (column: string) => string | undefined): KeyRestriction => {
	const columns = keys.columns.flatMap((c) => {
		const to = rename(c)
		return to === undefined ? [] : [{ from: c, to }]
	})
	if (!isNonEmpty(columns)) {
		return whole
	}
	const [first, ...rest] = keys.sources
	const project = (s: KeySource): KeySource | undefined => {
		const picked = columns.flatMap((c) => {
			const k = s.keys.find((x) => x.column === c.from)
			return k === undefined ? [] : [{ column: c.to, slot: k.slot }]
		})
		return isNonEmpty(picked) && picked.length === columns.length
			? { ...s, keys: picked }
			: undefined
	}
	const sources = [first, ...rest].flatMap((s) => {
		const p = project(s)
		return p === undefined ? [] : [p]
	})
	const [head, ...tail] = sources
	return head === undefined || sources.length !== keys.sources.length
		? whole
		: { kind: "keys", columns: mapKeys(columns, (c) => c.to), sources: [head, ...tail] }
}

/**
 * The keys a take's readers read it at, on its partition's columns alone (take/partition.ts): a group's rank reads only
 * its group's rows, so its input at those keys ranks as the whole input does; whole where they restrict none of them.
 */
const partitionKeys = (take: NodeOf<"Take">, keys: Keys): KeyRestriction =>
	renamed(keys, (column) => (inPartition(take, column) ? column : undefined))

/**
 * The key set a node is computed at by itself: a fold's on its grouping columns alone, a group being its input's rows
 * at one key, its aggregate known only once the group is whole; a call's none, its rows its function's at its
 * arguments, evaluated whole wherever it stands and held by the statement once (lower/conservative/call
 * evaluationQuery, StatementSharing carryEvaluation), so a copy at keys evaluates it again beside the one the statement
 * holds: metis's submit carried the texts of its response processing at their readers' keys, the call's 230 KB
 * evaluated a second time in a nested WITH beside the statement's own, and seventeen of its fields each at a key set
 * of its own; any other node's whole key set.
 */
export const computedAt = (node: RelNode, keys: KeyRestriction): KeyRestriction =>
	node.kind === "Call"
		? whole
		: node.kind !== "Group" || keys.kind === "whole"
			? keys
			: renamed(keys, (column) => (node.keys.includes(column) ? column : undefined))

/**
 * A key set narrowed by `fixings`, columns a filter keeps at values of the statement's: each fixed column a key at its
 * value in every source, beside the keys the filter's own readers read it at; those columns alone where they read it
 * whole.
 */
const fixedAt = (
	above: KeyRestriction,
	fixings: ReadonlyArray<{ readonly column: string; readonly expr: ScalarExpr }>
): KeyRestriction => {
	const [first, ...rest] = fixings
	if (first === undefined) {
		return above
	}
	const slotOf = (column: string): string => `filter:${column}`
	const fixedKeys = mapKeys([first, ...rest], (f) => ({ column: f.column, slot: slotOf(f.column) }))
	const fixed = fixings.map((f) => ({ slot: slotOf(f.column), expr: f.expr }))
	if (above.kind === "whole") {
		return {
			kind: "keys",
			columns: mapKeys(fixedKeys, (k) => k.column),
			sources: [{ seeds: [], steps: [], fixed, keys: fixedKeys }]
		}
	}
	const extra = fixedKeys.filter((k) => !above.columns.includes(k.column))
	const [head, ...tail] = above.sources
	const widen = (s: KeySource): KeySource => {
		const [k, ...ks] = s.keys
		return { ...s, fixed: [...s.fixed, ...fixed], keys: [k, ...ks, ...extra] }
	}
	const [c, ...cs] = above.columns
	return {
		kind: "keys",
		columns: [c, ...cs, ...extra.map((k) => k.column)],
		sources: [widen(head), ...tail.map(widen)]
	}
}

/**
 * The union of reads' key sets, over the columns every read restricts, each source's keys narrowed to them; whole where
 * any read is, or no column is common.
 */
const unionOf = (reads: ReadonlyArray<KeyRestriction>): KeyRestriction => {
	const keyed = reads.flatMap((r) => (r.kind === "keys" ? [r] : []))
	const [first, ...rest] = keyed
	if (first === undefined || keyed.length !== reads.length) {
		return whole
	}
	const common = first.columns.filter((c) => rest.every((r) => r.columns.includes(c)))
	if (!isNonEmpty(common)) {
		return whole
	}
	const sources = keyed.flatMap((r) =>
		r.sources.map((s): KeySource => ({
			...s,
			keys: mapKeys(common, (c) =>
				defined(
					s.keys.find((k) => k.column === c),
					"a key every read restricts, in each source of its"
				)
			)
		}))
	)
	const [head, ...tail] = sources
	return head === undefined ? whole : { kind: "keys", columns: common, sources: [head, ...tail] }
}

/**
 * Whether a node held at its keys is read at them inside (StatementSharing #atKeys): a union, each arm at the keys, or a
 * fold, below its aggregate, where a restriction placed over either reaches no arm and no group; a join's restriction
 * stands over it, its EXISTS a semi-join PostgreSQL plans with the join's sources.
 */
export const readAtKeys = (node: RelNode): node is NodeOf<"Union"> | NodeOf<"Group"> =>
	node.kind === "Union" || node.kind === "Group"

/** Each node's reads by the nodes under it, itself among them, one per edge (ir/rel.ts edgesOf): a DAG is immutable. */
const readsUnder = new WeakMap<RelNode, ReadonlyMap<RelNode, number>>()

/** How many times `root` and the nodes under it read each node (`readsUnder`). */
const readsWithin = (root: RelNode): ReadonlyMap<RelNode, number> => {
	const known = readsUnder.get(root)
	if (known !== undefined) {
		return known
	}
	const out = new Map<RelNode, number>()
	for (const node of postorder([root], inputsOf)) {
		for (const input of edgesOf(node)) {
			out.set(input, (out.get(input) ?? 0) + 1)
		}
	}
	readsUnder.set(root, out)
	return out
}

/**
 * One node a restriction reaches (restrictionWalk): lowered where its `readers` read it, never as a CTE or a carrier of
 * its, its rows read at `reached`, the part of its reads' restrictions every one of them holds (commonRestriction), and
 * kept at `equalities` where they stand on it, none where it only passes them on to nodes under it.
 */
export interface RestrictionReach<V> {
	readonly node: RelNode
	readonly readers: NonEmptyReadonlyArray<RelNode>
	readonly reached: ReadonlyArray<{ readonly column: string; readonly value: V }>
	readonly equalities: ReadonlyArray<{ readonly column: string; readonly value: V }>
}

/**
 * Which nodes under a root its restriction reaches (restrictionWalk): `once`, a node the root's subtree reads once alone,
 * the reach of a root the statement computes at its key set (KeyedLowering atKeys), whose every other node its reads key
 * (KeyAnalysis), computed once at their keys; `held`, a node every read of which under the root arrives at one
 * restriction, the reach of a row site's root, read per row of its driver, under which no read keys a node.
 */
export type WalkReach = "once" | "held"

/**
 * The nodes under `root` a restriction of its rows reaches (the one walk of a restriction into a node, the lowering's
 * and the key analysis's, share/keys.ts KeyAnalysis rowRead), each lowered where it is read, at the values: the root's
 * rows at `restriction`, each column by the name it has there, carried through a projection of columns, a filter, both
 * sides of an existence test (its right side at each pair whose left column the restriction holds: a left row at the
 * value tests the right side's rows at it alone), of an intersection and of a difference, a step, an attachment to the
 * parent whose rows it delivers and to its child at each column its correlation names the restriction holds (a child
 * row is read only at its parent row's values: qti-pie's ItemSessionControl, which metis's resume reads at each item
 * session's key for its control and again under it for the attempts it leaves, was reached by neither read and derived
 * whole for every learner), and a region to every source each occurrence binds the column's variable or one its
 * equalities join to, each keeping the rows at those values alone of what it reads; and a union's arms, a fold's input
 * at its grouping keys and a take's input at its partition (take/partition.ts), never at a column it orders by.
 * Where PostgreSQL moves no restriction, it stands on the node itself: a step's input, inside its fence (step/index.ts
 * fencedRead, a subquery with an OFFSET), a take's input, below its ORDER BY and LIMIT, which PostgreSQL moves no
 * restriction of the take's rows past (metis's results page read each session's latest credit as a take over the credit
 * of every attempt of the database), and a union or a fold a region reads, each arm
 * at the values or the keys below its aggregate (lower/shapes/union keyedUnion, lower/shapes/aggregate keyedGroup),
 * which a restriction over either would reach no arm and no group of; every other node on the way passes the values
 * on, PostgreSQL moving a restriction of a derived table into it. A root that is a union or a fold restricts its arms or
 * its groups itself (KeyedLowering atKeys). Under a row site's root (`reach` held) a node is reached where every read
 * of it under the root (`readsWithin`) is a read the restriction reached, at the part of their restrictions they all
 * hold (commonRestriction), so each read keeps the rows of that part and its own other columns where it stands,
 * wherever else the statement reads it whole or as a CTE: a node read
 * twice under the root at the key, as edullm's credit reads the attempt's numeric value in force for its score and its
 * maximum, is derived once at the key and read at both (keyed.ts pushedInto, context.ts Holding), where reaching only a
 * node read once left it the statement's CTE, derived whole. Under a root the statement computes at its key set (`reach`
 * once) a node is reached only where the root's subtree reads it once: one read at several reads is its own CTE, keyed
 * at the root's keys through its readers (KeyAnalysis), printed once, where lowered at each read edullm's takenSessions
 * printed its session control twice in each of four such roots and planned nine times as long. The nodes are visited
 * readers first (the reverse of a postorder), so a node's reads have all arrived when it is visited. metis's hold gate
 * read the read-aloud stamps of the due assignments, a union of three rules each a navigation's chain of steps, its
 * first step every assignment, which per due key read all 97,379 assignments again; edullm's latest decision read the
 * latest attempt of each session of its stage, a fold every item session's attachment read beside it, derived whole
 * for the database.
 */
export const restrictionWalk = <V>(
	root: RelNode,
	restriction: ReadonlyArray<{ readonly column: string; readonly value: V }>,
	reach: WalkReach
): ReadonlyArray<RestrictionReach<V>> => {
	type Equalities = ReadonlyArray<{ readonly column: string; readonly value: V }>
	const reads = readsWithin(root)
	/** Each node's reads the restriction reached so far: the reader, the restriction, and whether a step's input. */
	const arrived = new Map<
		RelNode,
		Array<{ readonly reader: RelNode; readonly equalities: Equalities; readonly fenced: boolean }>
	>()
	/**
	 * `node` read by `reader` at `equalities`; a fold at those of its grouping keys alone, a value of an aggregate no
	 * restriction below its grouping reaches (lower/shapes/aggregate keyedGroup), which the reader that holds it keeps
	 * where the fold delivers it: a region's held condition, a union's arm, the root.
	 */
	const deliver = (
		reader: RelNode,
		node: RelNode,
		equalities: Equalities,
		fenced: boolean
	): void => {
		arrived
			.getOrInsertComputed(node, () => [])
			.push({
				reader,
				equalities:
					node.kind === "Group"
						? equalities.filter((e) => node.keys.includes(e.column))
						: equalities,
				fenced
			})
	}
	/** `at`'s inputs, each read at what `at` read at `equalities` keeps of it. */
	const into = (at: RelNode, equalities: Equalities): void => {
		switch (at.kind) {
			case "ProjectSet": {
				const input = at.input
				deliver(
					at,
					input,
					equalities.flatMap((e) => {
						const x = at.out.find((o) => o.name === e.column)?.expr
						return x?.kind === "column" && x.column.node === input.id
							? [{ column: x.column.name, value: e.value }]
							: []
					}),
					false
				)
				return
			}
			case "Filter":
				deliver(at, at.input, equalities, false)
				return
			case "SemiJoin":
			case "AntiJoin":
				deliver(at, at.left, equalities, false)
				deliver(
					at,
					at.right,
					equalities.flatMap((e) =>
						at.on.flatMap((p) => (p.left === e.column ? [{ column: p.right, value: e.value }] : []))
					),
					false
				)
				return
			case "Intersect":
			case "Difference":
				deliver(at, at.left, equalities, false)
				deliver(at, at.right, equalities, false)
				return
			case "Step":
				deliver(at, at.input, equalities, true)
				return
			case "Attach":
				deliver(at, at.parent, equalities, false)
				deliver(
					at,
					at.child,
					equalities.flatMap((e) =>
						at.correlation.flatMap((c) =>
							c.parent === e.column ? [{ column: c.child, value: e.value }] : []
						)
					),
					false
				)
				return
			case "MatchRegion": {
				const classOf = regionVarClasses(at)
				for (const o of at.occurrences) {
					const source = o.source
					if (source.kind === "Base") {
						continue
					}
					deliver(
						at,
						source,
						equalities.flatMap((e) => {
							const v = at.vars.find((x) => x.name === e.column)
							return v === undefined
								? []
								: o.bindings.flatMap((b) =>
										classOf(b.var) === classOf(v) ? [{ column: b.column, value: e.value }] : []
									)
						}),
						false
					)
				}
				return
			}
			case "Union":
				for (const arm of unionArms(at.groups)) {
					deliver(at, arm, equalities, false)
				}
				return
			case "Group":
				deliver(
					at,
					at.input,
					equalities.filter((e) => at.keys.includes(e.column)),
					false
				)
				return
			case "Take":
				deliver(
					at,
					at.input,
					equalities.filter((e) => inPartition(at, e.column)),
					true
				)
				return
			case "ApproximateNearest":
			case "Base":
			case "Call":
			case "Closed":
			case "Context":
			case "Delta":
			case "Forbid":
			case "InputSet":
			case "OrderedResult":
			case "OrderedSetAggregate":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "Window":
				return
		}
	}
	into(root, restriction)
	const out: Array<RestrictionReach<V>> = []
	for (const node of postorder([root], inputsOf).toReversed()) {
		const at = arrived.get(node) ?? []
		const [first, ...rest] = at
		if (
			node === root ||
			first === undefined ||
			at.length !== reads.get(node) ||
			(reach === "once" && at.length !== 1)
		) {
			continue
		}
		const common = commonRestriction(
			first.equalities,
			rest.map((a) => a.equalities)
		)
		if (common.length === 0) {
			continue
		}
		const fenced = at.some((a) => a.fenced)
		out.push({
			node,
			readers: [first.reader, ...rest.map((a) => a.reader)],
			reached: common,
			equalities: fenced || restrictsInside(node) ? common : []
		})
		into(node, common)
	}
	return out
}

/**
 * The nodes of `reaches`, a restriction's reach under `root` (restrictionWalk), the root's query holds once (keyed.ts
 * pushedInto, context.ts heldEnv): each it reads at several reads, its CTE in the root's query's WITH, derived there at
 * the restriction that reaches it (RestrictionReach `reached`) and read at every read, where lowered at each read it was
 * printed and planned once for each; a read inside an attachment's child under the root is its attachment's own
 * (context.ts queryInputs), so a node the root's query reads once beside it is lowered in place, never a CTE of one read,
 * a tuplestore per row bought for nothing. A node that reads a row of the root or of a node under it is lowered at each
 * read, that row in scope there alone.
 */
export const heldOnce = <V>(
	root: RelNode,
	reaches: ReadonlyArray<RestrictionReach<V>>
): ReadonlyArray<RestrictionReach<V>> => {
	/** The root and the nodes under it: a CTE in the root's query reads no row of theirs, none in scope there. */
	const within = new Set(postorder([root], inputsOf).map((n) => n.id))
	/** The nodes the root's query lowers (context.ts queryInputs). */
	const lowered = new Set(postorder([root], queryInputs))
	return reaches.filter(
		(r) =>
			r.readers.filter((reader) => lowered.has(reader)).length > 1 &&
			outerOf(r.node).every((c) => !within.has(c.node))
	)
}

/**
 * The part of a node's reads' restrictions every one of them holds (restrictionWalk): each column `first` holds at a
 * value every other read holds it at too. The node read there holds every row each read needs, a key set relaxed to its
 * reads' common columns (KeyAnalysis's soundness: K ⊇ π(keys) of what the reads need), and each read keeps its own
 * other columns where it stands, a join or a filter over the node's rows: so a node read at restrictions that differ is
 * derived once per row of its driver at the part they share, where reached at none it stayed the statement's CTE,
 * derived whole for every row of the store and scanned once for each row of the driver (edullm's session control,
 * read three times in controlOf at a session's stage and at the session; metis's review reads its session control and
 * pending external scorings so). None where the reads share no column at one value.
 */
const commonRestriction = <V>(
	first: ReadonlyArray<{ readonly column: string; readonly value: V }>,
	rest: ReadonlyArray<ReadonlyArray<{ readonly column: string; readonly value: V }>>
): ReadonlyArray<{ readonly column: string; readonly value: V }> =>
	first.filter((e) =>
		rest.every((r) => r.some((x) => x.column === e.column && x.value === e.value))
	)

/**
 * The reads of `nodes` made per row of a driver, each node with the readers that read it so: an attachment's read of
 * its child, once per parent key (cte-policy attachmentRead `perKey`), a driven semi-join's read of its left side once
 * per right-side key (cte-policy semiJoinDriven), a correlated region's read of a source at the values its correlation
 * fixes for each outer row (cte-policy correlatedSites), and the row sites of the chain of a region evaluated per outer
 * row (cte-policy evaluatedPerRow), each read per row of the steps before it, a page's read of its rows once per window
 * row at its driver's key (PagedRead, lower/shapes/page/driver.ts), every read the restriction reaches under any of them
 * (restrictionWalk), and every row site those reads hold beneath them (share/sites.ts), walked in turn: a region's
 * chain's row sites, each read per row of the steps before it (chainSites). Each is lowered there at the row's values, never as a CTE. They read no key
 * set: a node's key set is its other reads' (KeyAnalysis keysOf), so a node an attachment's child reads beside the head
 * it attaches to is computed at the head's keys alone, where reading it at the parents' rows, the head's own rows of
 * it, closed a cycle no order computes first (keyedOrder) and computed it whole.
 *
 * Beside them, each region those reads hold at a restriction, with the columns of each restriction it is held at
 * (`restricted`): the region its lowering chains at those columns (lower/shapes/region regionSelect, share/sites.ts
 * chainSteps), whose steps physical/access extract.ts requests the paths of. And each node a row site's root holds once
 * (`held`, heldOnce), with the columns of each restriction it is derived at there (RestrictionReach `reached`): its one
 * CTE in the root's query's WITH, which every read of it under the root reads where it stands, so a chain step over it
 * seeks nothing of it at the step's own columns (physical/access extract.ts `chained`).
 */
export interface RowReading {
	readonly readers: ReadonlyMap<RelNode, ReadonlySet<RelNode>>
	readonly restricted: ReadonlyMap<NodeOf<"MatchRegion">, ReadonlyArray<ReadonlyArray<string>>>
	readonly held: ReadonlyMap<RelNode, ReadonlyArray<ReadonlyArray<string>>>
}

export const rowReading = (
	nodes: Iterable<RelNode>,
	paged: ReadonlyArray<PagedRead>
): RowReading => {
	const out = new Map<RelNode, Set<RelNode>>()
	const restricted = new Map<NodeOf<"MatchRegion">, Array<ReadonlyArray<string>>>()
	const heldAt = new Map<RelNode, Array<ReadonlyArray<string>>>()
	const add = (reader: RelNode, node: RelNode): void => {
		out.getOrInsertComputed(node, () => new Set()).add(reader)
	}
	/** The reads `restriction` reaches under `root`, read per row of its driver, and the row sites they hold. */
	const walk = (
		root: RelNode,
		restriction: ReadonlyArray<{ readonly column: string; readonly value: unknown }>
	): void => {
		const reaches = restrictionWalk(root, restriction, "held")
		const steps = [{ node: root, equalities: restriction }, ...reaches]
		/** The nodes under the row sites found below, each read at its site's columns alone. */
		const beneath = new Set<RelNode>()
		/**
		 * The row sites of the regions among them, each region's chain's (chainSites), each walked at the columns the
		 * steps before it bind: every node under a site is read there, per row of those steps, the restriction reaching it
		 * through the region standing nowhere the lowering reads it (lower/shapes/region siteReads), so a region under one,
		 * the members of qti-pie's member controls read at the member's place, is held at the site's columns alone and
		 * never at the region's weaker ones, a chain no statement prints, whose index no plan reads.
		 */
		const sites: Array<{ readonly region: NodeOf<"MatchRegion">; readonly site: ChainSite }> = []
		for (const at of steps) {
			const node = at.node
			if (beneath.has(node) || node.kind !== "MatchRegion") {
				continue
			}
			const columns = at.equalities.map((e) => e.column)
			if (columns.length > 0) {
				restricted.getOrInsertComputed(node, () => []).push(columns)
			}
			const chain = regionChain(node, columns, correlatedSites(node))
			for (const site of chain === undefined ? [] : chainSites(node, chain, columns)) {
				sites.push({ region: node, site })
				for (const under of postorder([site.occurrence.source], inputsOf)) {
					beneath.add(under)
				}
			}
		}
		for (const r of reaches) {
			if (beneath.has(r.node)) {
				continue
			}
			for (const reader of r.readers) {
				add(reader, r.node)
			}
		}
		for (const r of heldOnce(root, reaches)) {
			if (!beneath.has(r.node)) {
				heldAt.getOrInsertComputed(r.node, () => []).push(r.reached.map((e) => e.column))
			}
		}
		for (const { region, site } of sites) {
			walkSite(region, site)
		}
	}
	/** A row site of `region`'s chain read per row of the steps before it, every node under it walked at its columns. */
	const walkSite = (region: NodeOf<"MatchRegion">, site: ChainSite): void => {
		add(region, site.occurrence.source)
		walk(site.occurrence.source, [
			...site.held.map((h) => ({ column: h.column, value: h })),
			...site.columns.map((c) => ({ column: c.column, value: c }))
		])
	}
	for (const page of paged) {
		add(page.reader, page.rows)
		walk(
			page.rows,
			page.key.map((column) => ({ column, value: column }))
		)
	}
	for (const node of nodes) {
		const driven = node.kind === "SemiJoin" ? semiJoinDriven(node) : undefined
		if (node.kind === "SemiJoin" && driven !== undefined) {
			add(node, node.left)
			walk(
				node.left,
				driven.map((p) => ({ column: p.left, value: p.right }))
			)
			continue
		}
		if (node.kind === "MatchRegion") {
			const correlated = correlatedSites(node)
			for (const site of correlated) {
				add(node, site.source)
				walk(
					site.source,
					site.restriction.map((x) => ({ column: x.column, value: x.expr }))
				)
			}
			const chain = sitesAtRows(node, false) ? regionChain(node, [], correlated) : undefined
			for (const site of chain === undefined ? [] : chainSites(node, chain, [])) {
				walkSite(node, site)
			}
			continue
		}
		if (node.kind !== "Attach" || attachmentRead(node).kind !== "perKey") {
			continue
		}
		add(node, node.child)
		walk(
			node.child,
			node.correlation.map((c) => ({ column: c.child, value: c.parent }))
		)
	}
	return { readers: out, restricted, held: heldAt }
}

/**
 * Which of `candidates`, each a sub-query computed once (its copies), are computed at their key sets, and the height
 * each is computed at: each with a key set, lowest first, at its keys unless the nodes its key set reads (keys.ts
 * keySetReads) or a node below one hold a copy of a candidate whose computation reaches it in turn, which no order computes
 * first; a candidate's computation reads every candidate below its copies, and one at its keys every candidate its key
 * set's reads hold too, so it stands past each of them.
 */
export const keyedOrder = (
	inputs: (node: RelNode) => ReadonlyArray<RelNode>,
	candidates: ReadonlyArray<{
		readonly copies: ReadonlyArray<RelNode>
		readonly keys: KeyRestriction
		readonly height: number
	}>
): ReadonlyArray<{ readonly keys: Keys | undefined; readonly height: number }> => {
	const owner = new Map<RelNode, number>()
	for (const [i, c] of candidates.entries()) {
		for (const copy of c.copies) {
			owner.set(copy, i)
		}
	}
	const none: ReadonlySet<number> = new Set()
	/** The candidates a node or a node below it holds a copy of. */
	const under = new Fold<RelNode, ReadonlySet<number>>(function* (node) {
		const own = owner.get(node)
		let met: ReadonlySet<number> = own === undefined ? none : new Set([own])
		for (const input of inputsOf(node)) {
			const below: ReadonlySet<number> = yield input
			met = below.isSubsetOf(met) ? met : met.union(below)
		}
		return met
	})
	/** The candidates whose copies `from` or a node below them hold. */
	const held = (from: ReadonlyArray<RelNode>): Set<number> =>
		new Set(from.flatMap((node) => [...under.of(node)]))
	const below = candidates.map((c, i) => {
		const met = held(c.copies.flatMap((copy) => inputs(copy)))
		met.delete(i)
		return met
	})
	const throughKeys = candidates.map((c) =>
		c.keys.kind === "keys" ? held(keySetReads(c.keys)) : new Set<number>()
	)
	const keyed = new Set<number>()
	const edges = (i: number): ReadonlyArray<number> => [
		...defined(below[i], "a candidate's reads"),
		...(keyed.has(i) ? defined(throughKeys[i], "a candidate's key set's reads") : [])
	]
	/** Whether a candidate's computation reaches `to` from `from`. */
	const reaches = (from: Iterable<number>, to: number): boolean => {
		const seen = new Set<number>()
		const queue = [...from]
		for (const at of queue) {
			if (at === to) {
				return true
			}
			if (!seen.has(at)) {
				seen.add(at)
				for (const next of edges(at)) {
					queue.push(next)
				}
			}
		}
		return false
	}
	const lowestFirst = [...candidates.keys()].toSorted(
		(a, b) =>
			defined(candidates[a], "a candidate").height - defined(candidates[b], "a candidate").height ||
			a - b
	)
	for (const i of lowestFirst) {
		const c = defined(candidates[i], "a candidate")
		if (
			c.keys.kind === "keys" &&
			!reaches(defined(throughKeys[i], "a candidate's key set's reads"), i)
		) {
			keyed.add(i)
		}
	}
	const heights = new Map<number, number>()
	const heightOf = (i: number): number => {
		const known = heights.get(i)
		if (known !== undefined) {
			return known
		}
		const h = edges(i).reduce(
			(most, j) => Math.max(most, heightOf(j) + 1),
			defined(candidates[i], "a candidate").height
		)
		heights.set(i, h)
		return h
	}
	return candidates.map((c, i) => ({
		keys: keyed.has(i) && c.keys.kind === "keys" ? c.keys : undefined,
		height: heightOf(i)
	}))
}

/**
 * The key sets a statement computes its nodes at (KeyAnalysis over the statement's own `nodes`, each of `roots` at the
 * key set it is given): each sub-query it computes once (`once`, its copies, a CTE or a part) at its copies' key set,
 * and each union or fold it lowers in place, uncorrelated, at its own, where no value of the statement restricts it and
 * no cycle closes (keyedOrder); every other node whole. A fold is computed at its grouping keys alone (computedAt).
 */
export const keyPlan = (statement: {
	readonly nodes: ReadonlyArray<RelNode>
	readonly roots: ReadonlyMap<RelNode, KeyRestriction>
	readonly once: ReadonlyArray<ReadonlyArray<RelNode>>
	readonly fixed: FixedOf
	/** Each page's rows its windows read per window row (rowReads). */
	readonly paged: ReadonlyArray<PagedRead>
	readonly inputs: (node: RelNode) => ReadonlyArray<RelNode>
	readonly height: (node: RelNode) => number
}): {
	readonly once: ReadonlyArray<Keys | undefined>
	readonly atValues: ReadonlyArray<boolean>
	readonly inPlace: ReadonlyMap<RelNode, Keys>
} => {
	const computedOnce = new Set(statement.once.flat())
	const analysis = new KeyAnalysis(
		statement.nodes,
		statement.roots,
		statement.fixed,
		new Lookups((node) => computedOnce.has(node)),
		statement.paged
	)
	/**
	 * Whether a union's arm or a fold's input is a node the statement computes once, through projections, filters,
	 * steps and regions that read one source as it stands (cte-policy renamedSource):
	 * read at keys, each key would scan those computed rows whole, which no index reads, where they are restricted at
	 * their own key set already and the node over them computed once is too (a fold of 52 keys over 1,800 computed rows
	 * scanned them 52 times).
	 */
	const overComputed = (node: RelNode): boolean => {
		const computed = (n: RelNode): boolean => {
			if (computedOnce.has(n)) {
				return true
			}
			switch (n.kind) {
				case "ProjectSet":
				case "Filter":
				case "Step":
					return computed(n.input)
				case "MatchRegion": {
					const one = renamedSource(n)
					return one !== undefined && computed(one.occurrence.source)
				}
				case "ApproximateNearest":
				case "Attach":
				case "Base":
				case "Call":
				case "Closed":
				case "Context":
				case "Delta":
				case "Difference":
				case "Forbid":
				case "Group":
				case "InputSet":
				case "Intersect":
				case "OrderedResult":
				case "OrderedSetAggregate":
				case "Produce":
				case "Recursive":
				case "SelfRef":
				case "SemiJoin":
				case "AntiJoin":
				case "Take":
				case "Union":
				case "Window":
					return false
			}
		}
		return node.kind === "Group"
			? computed(node.input)
			: node.kind === "Union" && unionArms(node.groups).some(computed)
	}
	const inPlace = statement.nodes.filter(
		(node) =>
			!computedOnce.has(node) &&
			!statement.roots.has(node) &&
			(node.kind === "Union" || node.kind === "Group") &&
			outerOf(node).length === 0
	)
	const candidates = [
		...statement.once.map((copies) => {
			const [first] = copies
			return {
				copies,
				keys:
					first === undefined || copies.some(restrictedByValues) || overComputed(first)
						? whole
						: computedAt(first, analysis.keysOfAll(copies)),
				height: copies.reduce((h, c) => Math.max(h, statement.height(c)), 0)
			}
		}),
		...inPlace.map((node) => ({
			copies: [node],
			keys:
				restrictedByValues(node) || overComputed(node)
					? whole
					: computedAt(node, analysis.keysOf(node)),
			height: statement.height(node)
		}))
	]
	const order = keyedOrder(statement.inputs, candidates)
	return {
		once: statement.once.map((_, i) => order[i]?.keys),
		atValues: statement.once.map((copies, i) => {
			const at = copies.length > 0 ? analysis.readsAtValues(copies) : undefined
			return at === "rows" || (at === "values" && order[i]?.keys === undefined)
		}),
		inPlace: new Map(
			inPlace.flatMap((node, i) => {
				const at = order[statement.once.length + i]?.keys
				return at === undefined ? [] : [[node, at] as const]
			})
		)
	}
}
