import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { type NodeOf, type RelNode, unionArms } from "#compiler/ir/rel.ts"

/**
 * The text digests `node` delivers by lineage (docs/limits.md "Keys and indexes"), each text column by its name with the
 * column that is its SHA-256: a relation's (`relationDigests`, ir/law.ts digestsOf); its input's through a node that
 * delivers its input's columns as they are, a step, a filter, a take, an order, a window, and a semi- or anti-join's
 * left; a projection's that delivers a text and its digest as they are; a match region's variables one occurrence binds
 * to a text and to its digest; a union's that every arm delivers; none of any other node, which computes what it
 * delivers. The one derivation of a digest carried through a query: what a rule over the query states the digest's
 * equality by (check/checker.ts RuleCheck `#stateDigests`), and what a stored derived relation's head carries as its
 * own digest column (analysis/derived/storage.ts storedRelationOf). Each node's once, in `memo`.
 */
export const lineageDigests = (
	node: RelNode,
	relationDigests: (base: NodeOf<"Base">) => ReadonlyMap<string, string>,
	memo: Map<RelNode, ReadonlyMap<string, string>>
): ReadonlyMap<string, string> => {
	const known = memo.get(node)
	if (known !== undefined) {
		return known
	}
	const found = lineageOf(node, relationDigests, memo)
	memo.set(node, found)
	return found
}

const lineageOf = (
	node: RelNode,
	relationDigests: (base: NodeOf<"Base">) => ReadonlyMap<string, string>,
	memo: Map<RelNode, ReadonlyMap<string, string>>
): ReadonlyMap<string, string> => {
	const of = (n: RelNode) => lineageDigests(n, relationDigests, memo)
	switch (node.kind) {
		case "Base":
			return relationDigests(node)
		case "Step":
		case "Filter":
		case "Take":
		case "OrderedResult":
		case "Window":
			return of(node.input)
		case "SemiJoin":
		case "AntiJoin":
			return of(node.left)
		case "ProjectSet": {
			const input = of(node.input)
			const read = (e: ScalarExpr): string | undefined =>
				e.kind === "column" && e.column.node === node.input.id ? e.column.name : undefined
			const pairs = new Map<string, string>()
			for (const text of node.out) {
				const digest = input.get(read(text.expr) ?? "")
				const out = node.out.find((d) => digest !== undefined && read(d.expr) === digest)
				if (out !== undefined) {
					pairs.set(text.name, out.name)
				}
			}
			return pairs
		}
		case "MatchRegion": {
			const pairs = new Map<string, string>()
			for (const o of node.occurrences) {
				const digests = of(o.source)
				for (const b of o.bindings) {
					const digest = o.bindings.find((d) => d.column === digests.get(b.column))
					if (digest !== undefined && !pairs.has(b.var.name)) {
						pairs.set(b.var.name, digest.var.name)
					}
				}
			}
			return pairs
		}
		case "Union": {
			const [first, ...rest] = mapNonEmpty(unionArms(node.groups), of)
			return new Map(
				[...first].filter(([text, digest]) => rest.every((m) => m.get(text) === digest))
			)
		}
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
		case "OrderedSetAggregate":
		case "Produce":
		case "Recursive":
		case "SelfRef":
			return new Map()
	}
}
