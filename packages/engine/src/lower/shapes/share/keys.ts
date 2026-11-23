import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { FixedFacts } from "#compiler/analysis/physical/props.ts"
import { outerOf } from "#compiler/analysis/physical/rules.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import {
	inputsOf,
	type NodeOf,
	type Occurrence,
	type RelNode,
	regionVarClasses,
	type VarDecl
} from "#compiler/ir/rel.ts"
import { restrictedByValues, valueFixings } from "#compiler/lower/optimize/cte-policy/index.ts"

/**
 * The keys a shared node is read at, by every one of its reads (magic sets): the rows a statement needs of the node are
 * the node's rows whose `columns` equal a row of one of its `sources`, each the bindings one read's region holds of
 * them, so the node computed at those keys alone delivers every row any read of it meets; or `whole`, where some read
 * binds none of its columns from what the statement fixes, and the node is computed whole.
 */
export type KeySet =
	| { readonly kind: "whole" }
	| {
			readonly kind: "keys"
			readonly columns: NonEmptyReadonlyArray<string>
			readonly sources: NonEmptyReadonlyArray<KeySource>
	  }

/**
 * One read's keys: a conjunctive query over slots, its atoms each a relation the statement reads where the key source
 * stands, each column it binds at a slot, two atoms equal where they bind one slot, and `keys` the slot each of the
 * node's restricted columns is at. Its atoms are the read's seeds, what the statement fixes (a carried or value-restricted
 * source, a stored relation read at a value, the reading region's own keys, an existence test's left side, an outer row
 * a correlation reads), and the fewest occurrences of the reading region that join them to the read's variables.
 */
export interface KeySource {
	readonly atoms: ReadonlyArray<KeyAtom>
	/** Slots a value of the statement's own fixes: a correlation to a parameter. */
	readonly fixed: ReadonlyArray<{ readonly slot: string; readonly expr: ScalarExpr }>
	readonly keys: NonEmptyReadonlyArray<{ readonly column: string; readonly slot: string }>
}

/**
 * An atom of a key source: a node read where it stands, at its constants, each of `bindings`' columns at its slot; or
 * the keys of a node, the key set of the region the source crosses, read where the source stands.
 */
export type KeyAtom =
	| {
			readonly kind: "read"
			readonly node: RelNode
			readonly bindings: ReadonlyArray<{ readonly column: string; readonly slot: string }>
			readonly constants: ReadonlyArray<{ readonly column: string; readonly expr: ScalarExpr }>
	  }
	| {
			readonly kind: "keys"
			readonly of: RelNode
			readonly keys: Keys
			readonly bindings: ReadonlyArray<{ readonly column: string; readonly slot: string }>
	  }

/** A key set that restricts: the keys a node's reads read it at. */
export type Keys = Extract<KeySet, { readonly kind: "keys" }>

/** What each column of a node is fixed to per evaluation (PhysicalProps fixed), which a correlated read's equalities are. */
export type FixedOf = (node: RelNode) => ReadonlyMap<string, FixedFacts>

/** The nodes a key set's sources read where they stand, through the key sets they read in turn. */
export const keySetReads = (keys: Keys): ReadonlyArray<RelNode> =>
	keys.sources.flatMap((s) =>
		s.atoms.flatMap((a): ReadonlyArray<RelNode> =>
			a.kind === "read" ? [a.node] : keySetReads(a.keys)
		)
	)

/** The key set of a node every row of which a statement reads. */
export const whole: KeySet = { kind: "whole" }

/** Whether an expression is a value of the statement's own: it reads a parameter and no relation. */
const statementValue = (e: ScalarExpr): boolean =>
	e.deps.params.length > 0 && e.deps.nodes.length === 0

/**
 * The key sets of a statement's nodes (keysOf), worked out top-down, a node's from its readers' among the statement's:
 * each read of a node gives its keys, a region's by the fewest of its occurrences that join what the statement fixes
 * there to the variables the read binds (`crossing`), a node that keeps or renames its input's rows (a filter, a step, a
 * union's arm, an existence test's or a set difference's left side, a projection, a fold on its grouping keys) by its own
 * keys mapped to the input's columns, an existence test's right side by its left side at the test's pairs; a root, and a
 * node any reader keeps none of the keys of (a take's bound, a recursion, a call's argument, an attachment), is whole,
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
 * grouping keys (a group being its input rows at one key), never on an aggregate. The crossing steps only through a
 * region's occurrences, every one a positive conjunct (a negation is an anti-join, whose right side reads its left only
 * as a seed, never a step), and through no source that reads an outer row, which no key source can read.
 */
export class KeyAnalysis {
	readonly #readers = new Map<RelNode, Array<RelNode>>()
	readonly #known = new Map<RelNode, KeySet>()
	readonly #fixed: FixedOf

	/**
	 * The key sets of `nodes`, a statement's, each read by those of them that read it, each of `roots` at the key set it
	 * is given: whole for a statement's own, the keys every read of a share reads it at for the statement that fills it;
	 * a correlated read's columns equal to the outer columns `fixed` fixes them to.
	 */
	constructor(nodes: Iterable<RelNode>, roots: ReadonlyMap<RelNode, KeySet>, fixed: FixedOf) {
		this.#fixed = fixed
		for (const node of nodes) {
			for (const input of inputsOf(node)) {
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
	keysOf(node: RelNode): KeySet {
		const known = this.#known.get(node)
		if (known !== undefined) {
			return known
		}
		const readers = this.#readers.get(node) ?? []
		let found: KeySet = whole
		if (isNonEmpty(readers)) {
			const reached = unionOf(readers.map((reader) => this.#readAt(reader, node, undefined)))
			found =
				reached.kind === "whole"
					? whole
					: unionOf(readers.map((reader) => this.#readAt(reader, node, new Set(reached.columns))))
		}
		this.#known.set(node, found)
		return found
	}

	/**
	 * The key set of copies of one sub-query that one computation serves (a share's every copy): the union of each copy's,
	 * whole where any is.
	 */
	keysOfAll(copies: ReadonlyArray<RelNode>): KeySet {
		return unionOf(copies.map((c) => this.keysOf(c)))
	}

	/**
	 * The keys `reader` reads `node` at (KeyAnalysis), whole where it keeps none; a region's crossing to the `wanted`
	 * columns alone where given, the columns every read restricts, so no occurrence joins in for a column the union drops.
	 */
	#readAt(reader: RelNode, node: RelNode, wanted: ReadonlySet<string> | undefined): KeySet {
		switch (reader.kind) {
			case "MatchRegion": {
				const reads = reader.occurrences.flatMap((o) =>
					o.source === node ? [this.#crossing(reader, o, wanted)] : []
				)
				return unionOf(reads)
			}
			case "Filter":
				return fixedAt(
					this.keysOf(reader),
					valueFixings(reader).flatMap((f) =>
						statementValue(f.value) ? [{ column: f.column, expr: f.value }] : []
					)
				)
			case "Step":
			case "Union":
				return this.keysOf(reader)
			case "Intersect":
			case "Difference":
				return reader.left === node ? this.keysOf(reader) : whole
			case "SemiJoin":
			case "AntiJoin":
				return reader.left === node
					? this.keysOf(reader)
					: reader.right === node
						? this.#testRight(reader, wanted)
						: whole
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
			case "ApproximateNearest":
			case "Attach":
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
			case "Take":
			case "Window":
				return whole
		}
	}

	/**
	 * An existence test's right side's keys: its left side's rows, at the test's own keys, each pair's right column at
	 * the left column's value, a left row's verdict reading the right side at its pair values alone; the pairs of the
	 * `wanted` right columns alone where given.
	 */
	#testRight(
		test: NodeOf<"SemiJoin"> | NodeOf<"AntiJoin">,
		wanted: ReadonlySet<string> | undefined
	): KeySet {
		const pairs = test.on.filter((p) => wanted === undefined || wanted.has(p.right))
		if (outerOf(test.left).length > 0 || !isNonEmpty(pairs)) {
			return whole
		}
		const above = this.keysOf(test)
		const slotOf = (left: string): string => `left:${left}`
		const restricted = above.kind === "keys" ? above.columns : []
		const leftColumns = [...new Set([...pairs.map((p) => p.left), ...restricted])]
		const atoms: Array<KeyAtom> = [
			{
				kind: "read",
				node: test.left,
				bindings: leftColumns.map((c) => ({ column: c, slot: slotOf(c) })),
				constants: []
			}
		]
		if (above.kind === "keys") {
			atoms.push({
				kind: "keys",
				of: test,
				keys: above,
				bindings: above.columns.map((c) => ({ column: c, slot: slotOf(c) }))
			})
		}
		const [first, ...rest] = pairs
		return {
			kind: "keys",
			columns: [first.right, ...rest.map((p) => p.right)],
			sources: [
				{
					atoms,
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
	 * A region's read of a node at occurrence `o`: the fewest of the region's occurrences that join what the statement
	 * fixes there to the variables `o` binds (of its `wanted` columns, where given), by a breadth-first reach over the
	 * region's variable classes from its seeds, each occurrence reached kept only where a path to one of those variables
	 * passes it; the columns of the node whose variables it reaches are its keys, whole where it reaches none.
	 */
	#crossing(
		region: NodeOf<"MatchRegion">,
		o: Occurrence,
		wanted: ReadonlySet<string> | undefined
	): KeySet {
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
		const atoms: Array<KeyAtom> = []
		const fixed: Array<{ readonly slot: string; readonly expr: ScalarExpr }> = []
		/** Each slot reached, with the atom that first bound it. */
		const reached = new Map<string, number>()
		const reach = (atom: KeyAtom): number => {
			const at = atoms.length
			atoms.push(atom)
			for (const b of atom.bindings) {
				if (!reached.has(b.slot)) {
					reached.set(b.slot, at)
				}
			}
			return at
		}
		const readOf = (q: Occurrence): KeyAtom => ({
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
				kind: "keys",
				of: region,
				keys: above,
				bindings: above.columns.flatMap((c) => {
					const v = region.vars.find((x) => x.name === c)
					return v === undefined ? [] : [{ column: c, slot: slot(v) }]
				})
			})
		}
		for (const c of region.correlated) {
			if (statementValue(c.expr)) {
				fixed.push({ slot: slot(c.var), expr: c.expr })
				reached.set(slot(c.var), -1)
				continue
			}
			const [outer, ...more] = c.expr.deps.nodes
			if (c.expr.kind === "column" && outer !== undefined && more.length === 0) {
				const source = this.#nodeOf(region, outer)
				if (source !== undefined && outerOf(source).length === 0) {
					reach({
						kind: "read",
						node: source,
						bindings: [{ column: c.expr.column.name, slot: slot(c.var) }],
						constants: []
					})
				}
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
			const [outer, ...more] = c.expr.deps.nodes
			const source =
				c.expr.kind === "column" && outer !== undefined && more.length === 0
					? this.#nodeOf(region, outer)
					: undefined
			if (c.expr.kind === "column" && source !== undefined && outerOf(source).length === 0) {
				reach({
					kind: "read",
					node: source,
					bindings: [{ column: c.expr.column.name, slot: at }],
					constants: []
				})
				own.push({ column: c.column, slot: at })
			}
		}
		const pending = new Set(region.occurrences.filter(readable))
		for (const q of pending) {
			if (restrictedByValues(q.source) || q.constants.some((c) => statementValue(c.expr))) {
				pending.delete(q)
				reach(readOf(q))
			}
		}
		const aimed = o.bindings.filter((b) => wanted === undefined || wanted.has(b.column))
		const targets = new Set(aimed.map((b) => slot(b.var)))
		/** The atom an occurrence was reached from, by the atom's place: its parent on the path. */
		const parent = new Map<number, number>()
		const done = (): boolean => [...targets].every((t) => reached.has(t))
		for (let grew = true; grew && !done();) {
			grew = false
			for (const q of pending) {
				const via = q.bindings.map((b) => reached.get(slot(b.var))).find((x) => x !== undefined)
				if (via === undefined) {
					continue
				}
				pending.delete(q)
				const at = reach(readOf(q))
				parent.set(at, via)
				grew = true
				if (done()) {
					break
				}
			}
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
		for (const k of keys) {
			for (
				let at = reached.get(k.slot);
				at !== undefined && at >= 0 && !kept.has(at);
				at = parent.get(at)
			) {
				kept.add(at)
			}
		}
		const used = atoms.filter((_, i) => kept.has(i))
		const bound = new Set(used.flatMap((a) => a.bindings.map((b) => b.slot)))
		return {
			kind: "keys",
			columns: mapKeys(keys, (k) => k.column),
			sources: [
				{
					atoms: used,
					fixed: fixed.filter((f) => bound.has(f.slot) || keys.some((k) => k.slot === f.slot)),
					keys
				}
			]
		}
	}

	/** The node of label `id` a region's correlation reads, among the nodes the DAG holds above or beside it. */
	#nodeOf(region: NodeOf<"MatchRegion">, id: string): RelNode | undefined {
		for (const [node] of this.#readers) {
			if (node.id === id) {
				return node
			}
		}
		return region.id === id ? region : undefined
	}
}

/** `xs` mapped, a non-empty array staying one. */
const mapKeys = <T, U>(xs: NonEmptyReadonlyArray<T>, f: (x: T) => U): NonEmptyReadonlyArray<U> => {
	const [first, ...rest] = xs
	return [f(first), ...rest.map(f)]
}

/**
 * A key set over the columns `rename` maps to, each kept column renamed: the columns a reader keeps of its input under
 * its own names; whole where it keeps none.
 */
const renamed = (keys: Keys, rename: (column: string) => string | undefined): KeySet => {
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
 * The key set a node is computed at by itself: a fold's on its grouping columns alone, a group being its input's rows
 * at one key, its aggregate known only once the group is whole; any other node's whole key set.
 */
export const computedAt = (node: RelNode, keys: KeySet): KeySet =>
	node.kind !== "Group" || keys.kind === "whole"
		? keys
		: renamed(keys, (column) => (node.keys.includes(column) ? column : undefined))

/**
 * A key set narrowed by `fixings`, columns a filter keeps at values of the statement's: each fixed column a key at its
 * value in every source, beside the keys the filter's own readers read it at; those columns alone where they read it
 * whole.
 */
const fixedAt = (
	above: KeySet,
	fixings: ReadonlyArray<{ readonly column: string; readonly expr: ScalarExpr }>
): KeySet => {
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
			sources: [{ atoms: [], fixed, keys: fixedKeys }]
		}
	}
	const extra = fixedKeys.filter((k) => !above.columns.includes(k.column))
	const [head, ...tail] = above.sources
	const widen = (s: KeySource): KeySource => {
		const [k, ...ks] = s.keys
		return { atoms: s.atoms, fixed: [...s.fixed, ...fixed], keys: [k, ...ks, ...extra] }
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
const unionOf = (reads: ReadonlyArray<KeySet>): KeySet => {
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
