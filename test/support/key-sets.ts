/**
 * An attachment's parent key set as an optimized program's statement holds it: the values of the parent key in the
 * rows of its parent, which its part reads in place of those rows (lower/conservative/deliver.ts parentKeysSource,
 * keysOf), read from the statement as the lowering placed it, and whether the lowering deduplicated it (SELECT
 * DISTINCT) or read it as it is.
 *
 * The rows a key set reads are its parent's: a rows part's, the delivered rows of its program (`rows`), or the children
 * of the attachment above it, the columns after that attachment's parent key (`children`). An attachment part reads its
 * key set as the first FROM item of its attachment core (shapes/attach pipelinedAttachment), which is its own query's
 * core; the query of the CTE that holds its rows, when it has attachments of its own and delivers from it (shapes/index.ts
 * OptimizedDelivery #heldAttachment); or the seed of its recursion, when its child is seeded from its parent keys
 * (shapes/attach-recursive seededAttachment).
 */
import { Array as Arr, Formatter, Option } from "effect"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { deliverySpine, nodeScopes, topoOrder } from "#compiler/ir/dag.ts"
import type { Heading, NodeOf, RelDag } from "#compiler/ir/rel.ts"
import type { ConservativeParamSlot } from "#compiler/lower/conservative/types.ts"
import type { DeliveredPart, StatementParts } from "#compiler/lower/shapes/index.ts"
import {
	type AttachedTree,
	keyColumns,
	type RowsRole,
	type StatementRoots,
	type StatementTree
} from "#compiler/runtime/lower/tree.ts"
import type { FromItem, OperandSelect, SelectCore, With } from "#compiler/sql/ast.ts"
import { canonicalCell } from "#test/support/oracle/compare.ts"
import type { RawRow } from "#test/support/oracle/install/capture.ts"

/** The rows a key set reads: a rows part's delivered rows, or the children an attachment part delivers. */
export type KeySetParent =
	| { readonly kind: "rows"; readonly part: DeliveredPart; readonly role: RowsRole }
	| { readonly kind: "children"; readonly part: DeliveredPart; readonly attach: NodeOf<"Attach"> }

/** One attachment part's parent key set. */
export interface KeySetSite {
	readonly attach: NodeOf<"Attach">
	readonly part: DeliveredPart
	readonly parent: KeySetParent
	/** The parent key's columns, which the set reads of its parent's rows, by name. */
	readonly demand: ReadonlyArray<string>
	/** Whether the statement deduplicates the set: its core is SELECT DISTINCT. */
	readonly deduplicates: boolean
}

/** A query's core: its body's, through a parenthesized query; none for a set operation. */
const coreOf = (query: OperandSelect): SelectCore | undefined => {
	const body = query.body
	return body.kind === "core" ? body : body.kind === "select" ? coreOf(body) : undefined
}

/** The query the CTE `name` defines in the innermost of `scope` that defines it. */
const definedIn = (name: string, scope: ReadonlyArray<With>): OperandSelect => {
	for (const w of Arr.reverse(scope)) {
		for (const cte of w.ctes) {
			if (cte.name === name && cte.query.kind === "select") {
				return cte.query
			}
		}
	}
	throw new Error(`no query CTE ${name} in scope`)
}

/** The core of a derived table's query: a key set's. */
const derivedCore = (item: FromItem | undefined, what: string): SelectCore => {
	const core = item?.kind === "derived" ? coreOf(item.query) : undefined
	if (core === undefined) {
		throw new Error(`${what} is no derived table of one core`)
	}
	return core
}

/**
 * The core of an attachment part's key set, from the query `query` its part delivers under the WITH clauses `outer`:
 * the first FROM item of its attachment core (see the header). A first FROM item that reads a CTE is the seeded
 * recursion's; one that reads a derived table of a CTE's rows is the held rows', whose query is the attachment's; any
 * other is the key set itself.
 */
const keySetCore = (query: OperandSelect, outer: ReadonlyArray<With>): SelectCore => {
	const scope = query.with === undefined ? outer : [...outer, query.with]
	const first = coreOf(query)?.from[0]
	if (first?.kind === "cte") {
		const recursion = definedIn(first.name, scope).body
		const seed = recursion.kind === "setOp" ? recursion.arms[0] : undefined
		const seedCore = seed?.kind === "core" ? seed : undefined
		return derivedCore(seedCore?.from[0], "a seeded attachment's first seed source")
	}
	const read = first?.kind === "derived" ? coreOf(first.query)?.from[0] : undefined
	if (read?.kind === "cte") {
		return keySetCore(definedIn(read.name, scope), scope)
	}
	return derivedCore(first, "an attachment core's first FROM item")
}

/** The query a program's part `part` delivers, as lowered. */
const deliveredOf = <Slot extends ConservativeParamSlot>(
	parts: StatementParts<Slot>,
	part: DeliveredPart
): OperandSelect => {
	if (parts.kind === "one") {
		throw new Error("a program of one part delivers no attachment part")
	}
	const tagged = parts.parts[part.answer]
	if (tagged === undefined) {
		throw new Error(`no part answers ${part.answer}`)
	}
	return tagged.delivered
}

/** The children an attachment part delivers, the rows its nested attachments' key sets read. */
const childrenOf = (a: AttachedTree<DeliveredPart>): KeySetParent => ({
	kind: "children",
	part: a.statement,
	attach: a.attach
})

/**
 * Every attachment part's parent key set in an optimized program (or a page's request program), in flight order: one
 * per attachment the program delivers as a part of its own, at every depth.
 */
export const keySetSites = <Slot extends ConservativeParamSlot>(program: {
	readonly parts: StatementParts<Slot>
	readonly roots: StatementRoots<DeliveredPart>
}): ReadonlyArray<KeySetSite> => {
	const out: Array<KeySetSite> = []
	const under = (tree: StatementTree<DeliveredPart>, parent: KeySetParent): void => {
		for (const a of tree.attachments) {
			const core = keySetCore(deliveredOf(program.parts, a.statement), [])
			out.push({
				attach: a.attach,
				part: a.statement,
				parent,
				demand: Arr.map(keyColumns(a.statement.role), (c) => c.name),
				deduplicates: core.distinct !== false
			})
			under(a, childrenOf(a))
		}
	}
	for (const tree of program.roots) {
		const role = tree.statement.role
		if (role.kind === "attachment") {
			throw new Error("a program's root delivers rows, not an attachment's children")
		}
		under(tree, { kind: "rows", part: tree.statement, role })
	}
	return out
}

/**
 * The columns of the parent's rows a key set reads, each with its position in its parent part's output row: after the
 * parent key, for an attachment's children, at the column's place in the part's heading.
 */
const demandedColumns = (
	site: KeySetSite
): ReadonlyArray<{ readonly at: number; readonly column: Heading[number] }> => {
	const part = site.parent.part
	const offset = keyColumns(part.role).length
	return Arr.map(site.demand, (name) =>
		Option.match(
			Arr.findFirstWithIndex(part.heading, (c) => c.name === name),
			{
				onNone: () => {
					throw new Error(`the parent of ${site.attach.name} has no column ${name}`)
				},
				onSome: ([column, at]) => ({ at: offset + at, column })
			}
		)
	)
}

/**
 * The key sets of `sites` read without DISTINCT that repeat a value in the rows `rowsOf` gives of their parent parts,
 * each reported with the value it repeats: the parent rows, as values of the demanded columns' types (compare.ts
 * canonicalCell), hold no two rows alike on the demanded columns wherever the statement reads the set as it is.
 */
export const keySetRepeats = (
	sites: ReadonlyArray<KeySetSite>,
	rowsOf: (part: DeliveredPart) => ReadonlyArray<RawRow>,
	codes: Codebook
): ReadonlyArray<string> =>
	Arr.flatMap(sites, (site) => {
		if (site.deduplicates) {
			return []
		}
		const columns = Arr.map(demandedColumns(site), (d) => ({
			at: d.at,
			cell: canonicalCell(d.column.type, codes)
		}))
		const seen = new Set<string>()
		const repeated: Array<string> = []
		for (const row of rowsOf(site.parent.part)) {
			const value = canonicalTextOf(
				Arr.map(columns, (c) => {
					const cell = row[c.at]
					if (cell === undefined) {
						throw new Error(`a parent row of ${site.attach.name} holds no column ${c.at}`)
					}
					return c.cell(cell)
				})
			)
			if (seen.has(value)) {
				repeated.push(value)
			}
			seen.add(value)
		}
		return repeated.length === 0
			? []
			: [
					`the key set of ${site.attach.name} over (${Arr.join(site.demand, ", ")}), read without DISTINCT, repeats ${Formatter.format(repeated)} in its parent's rows`
				]
	})

/**
 * Whether a query holds a correlated child under a nested attachment: an attachment's child that reads that
 * attachment's parent (its evaluation's scope reads a node of the parent's delivered rows, nodeScopes), with an
 * attachment of its own on its delivered rows. That nested attachment's parent key set reads the children under every
 * parent at once, whose keys within one parent need not hold across parents.
 */
export const correlatedChildUnderNestedAttachment = (dag: RelDag): boolean => {
	const scopes = nodeScopes(dag)
	return Arr.some(topoOrder(dag), (node) => {
		if (node.kind !== "Attach" || deliverySpine(node.child).attachments.length === 0) {
			return false
		}
		const parentRows = new Set(Arr.map(deliverySpine(node.parent).nodes, (n) => n.id))
		return Arr.some([...scopes.of(node.child).outer.keys()], (id) => parentRows.has(id))
	})
}
