/** What the properties of parent-binds.test.ts and test/pg/reads/parent-binds.test.ts read: their schema, box and reads. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { NodeId } from "#compiler/core/ids.ts"
import { nodeScopes, topoOrder } from "#compiler/ir/dag.ts"
import type { NodeOf, RelDag, RelNode } from "#compiler/ir/rel.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"

/** An attempt of a child at its item `n`, at its instant: the parent rows. */
const Attempt = relation("Attempt", { child: int4, n: int4, at: int4 }, ["child", "n", "at"])

/** A mark of a child's item `n`: the rows each attempt's attachment reads through an import. */
const Mark = relation("Mark", { child: int4, n: int4, mark: int4 }, ["child", "n", "mark"])

export const ParentBinds = schema("ParentBinds", [Attempt, Mark], [])

/** The marks of the child its parameter `c` names, as a scalar parameter reads it. */
const marksOf = query(ParentBinds).rule((r) => {
	const { n, mark } = v(Mark, "marked")
	return r
		.match(Mark, { child: r.param("c", Mark.fields.child), n, mark })
		.find({ child: r.param("c", Mark.fields.child), n, mark })
})

/** The child its parameter `c` names wherever it attempted an item: a relation of sittings, as edullm's sittingOf. */
const sittingOf = query(ParentBinds).rule((r) => {
	const { child } = v(Attempt, "sitting")
	return r
		.match(Attempt, { child })
		.where(r.eq(child, r.param("c", Attempt.fields.child)))
		.find({ child })
})

/** The marks of the children its relation parameter `sittings` holds, as edullm's markReadsOf reads its sittings. */
const marksIn = query(ParentBinds).rule((r) => {
	const sittings = r.relation("sittings", { child: Attempt.fields.child })
	const { child } = v(sittings, "sitting")
	const { n, mark } = v(Mark, "marked")
	return r.match(sittings, { child }).match(Mark, { child, n, mark }).find({ child, n, mark })
})

/**
 * Which match of the attachment child's rule binds the parent variable `child` the import's parameter is bound to:
 * the import's own match (edullm's marks attachments, judged.ts marksOf, refused before), a match before it, a match
 * after it, or none, where the region correlates the variable to its parent column.
 */
export const binders = [
	"the import's own match",
	"an earlier match",
	"a later match",
	"no match"
] as const
export type Binder = (typeof binders)[number]

/**
 * How the import's parameter is bound to the parent variable: a scalar parameter (`marksOf.bind({ c: a.child })`), or
 * a relation parameter bound to the rows of a query whose own parameter is (`marksIn.bind({ sittings:
 * sittingOf.bind({ c: a.child }) })`), edullm's shape.
 */
export const forms = ["a scalar parameter", "a relation parameter's rows"] as const
export type Form = (typeof forms)[number]

/** Where the attachment is read: a query, or a ChangeSet's read-back, edullm's answerTestItem `attempt`. */
const readers = ["a query", "a ChangeSet's read-back"] as const
export type Reader = (typeof readers)[number]

export interface BindCase {
	readonly binder: Binder
	readonly form: Form
	readonly reader: Reader
}

const bindCases = Arr.flatMap(binders, (binder) =>
	Arr.flatMap(forms, (form) => Arr.map(readers, (reader): BindCase => ({ binder, form, reader })))
)

export const bindCaseGen: Gen<BindCase> = element(bindCases)

/** A case's situation: its binder, its form and its reader. */
export type Situation = `${Binder}, ${Form}, ${Reader}`

export const situationOf = (c: BindCase): Situation => `${c.binder}, ${c.form}, ${c.reader}`

export const situations = Arr.map(bindCases, situationOf)

/**
 * Each attempt with the marks of its child's item, read through an import whose parameter is bound to the parent
 * variable `child` as `form` binds it, `binder` the match that binds `child` in the child's rule. Every case reads the
 * same rows: each attempt's marks, those of its child at its `n` (an earlier or a later match of Attempt at the parent's
 * key holds for the parent's own row).
 */
export const attemptsOf = (binder: Binder, form: Form) =>
	query(ParentBinds)
		.rule((r) => {
			const { child, n, at } = v(Attempt, "attempt")
			return r.match(Attempt, { child, n, at }).find({ child, n, at })
		})
		.attach(
			"marks",
			(a) =>
				form === "a scalar parameter"
					? query(ParentBinds).rule((r) => {
							const read = marksOf.bind({ c: a.child })
							const { mark } = v(read, "mark")
							const { at } = v(Attempt, "again")
							const before =
								binder === "an earlier match" ? r.match(Attempt, { child: a.child, n: a.n, at }) : r
							const matched = before.match(
								read,
								binder === "the import's own match"
									? { child: a.child, n: a.n, mark }
									: { n: a.n, mark }
							)
							return (
								binder === "a later match"
									? matched.match(Attempt, { child: a.child, n: a.n, at })
									: matched
							).find({ mark })
						})
					: query(ParentBinds).rule((r) => {
							const read = marksIn.bind({ sittings: sittingOf.bind({ c: a.child }) })
							const { mark } = v(read, "mark")
							const { at } = v(Attempt, "again")
							const before =
								binder === "an earlier match" ? r.match(Attempt, { child: a.child, n: a.n, at }) : r
							const matched = before.match(
								read,
								binder === "the import's own match"
									? { child: a.child, n: a.n, mark }
									: { n: a.n, mark }
							)
							return (
								binder === "a later match"
									? matched.match(Attempt, { child: a.child, n: a.n, at })
									: matched
							).find({ mark })
						}),
			"array"
		)

/** The attempts read back by a ChangeSet that writes nothing, as edullm's answerTestItem reads its attempt back. */
export const readBackOf = (binder: Binder, form: Form) =>
	ChangeSet.empty(ParentBinds).read("attempts", () => attemptsOf(binder, form))

/**
 * The first occurrence of a region whose source reads what no occurrence before it holds, or undefined where every one
 * reads only that: a variable of the region an earlier occurrence binds or the region correlates, another occurrence's
 * source placed before it, or a node outside the region. regionParts places a region's occurrences each once what it
 * reads is in scope (lower/conservative/match-region), so a region of which none is first has an order to place; the
 * checker forms one in its matches' order, each match's bind map read once the matches before it bound what it reads.
 */
const unplaceable = (
	region: NodeOf<"MatchRegion">,
	outer: (source: RelNode) => ReadonlyMap<NodeId, ReadonlySet<string>>
): string | undefined => {
	const valued = new Set(Arr.map(region.correlated, (c) => c.var.name))
	const placed = new Set<NodeId>()
	const sources = new Set(Arr.map(region.occurrences, (o) => o.source.id))
	for (const o of region.occurrences) {
		for (const [ref, columns] of outer(o.source)) {
			const early =
				ref === region.id
					? Arr.every([...columns], (c) => valued.has(c))
					: !sources.has(ref) || placed.has(ref)
			if (!early) {
				return `${o.source.id} (${o.source.kind}) reads ${ref}.${Arr.join([...columns], ", ")} before any occurrence of ${region.id} holds it`
			}
		}
		placed.add(o.source.id)
		for (const b of o.bindings) {
			valued.add(b.var.name)
		}
	}
	return undefined
}

/** Each region of `dag` some occurrence of which reads what none before it holds (`unplaceable`), with why. */
export const unplaceableRegions = (dag: RelDag): ReadonlyArray<string> => {
	const scopes = nodeScopes()
	return Arr.flatMap(topoOrder(dag), (node) => {
		if (node.kind !== "MatchRegion") {
			return []
		}
		const why = unplaceable(node, (source) => scopes.of(source).outer)
		return why === undefined ? [] : [why]
	})
}
