/**
 * A closed, parameter-free derivation a served program imports is a canonical relation of its schema (schema/reach.ts
 * Slice `served`, analysis/schema.ts CheckedSchema), held in a table the installation keeps wherever admission stores it
 * (analysis/derived/storage.ts), which the lowering reads in its place (ir/derived.ts servedDag): so no served statement
 * computes one admission stores where its table serves the statement. One it still computes there is an internal
 * compiler error, the lowering having lost a form its installation holds. A closed derivation admission keeps live is
 * computed where it stands, at whatever key its reader binds; whether PostgreSQL then computes it whole is a fact of the
 * printed statement, which the verifier of printed statements holds.
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import type { CheckSession } from "#compiler/check/session.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { CanonicalDigests, nodeScopes, topoOrder } from "#compiler/ir/dag.ts"
import type { DerivedRows } from "#compiler/ir/derived.ts"
import type { RelDag } from "#compiler/ir/rel.ts"

/** A served statement's DAG before and after the lowering's reading of its derived relations (ir/derived.ts servedDag),
 * with the closed imports its check built, by label. */
export interface ServedCompile {
	/** The checked schema its program reads, whose admission made its forms. */
	readonly schema: CheckedSchema
	/** How it reads the schema's derived relations, the reading servedDag made `served` under. */
	readonly rows: DerivedRows
	/** The DAG servedDag read. */
	readonly checked: RelDag
	/** The DAG servedDag made of it, every node under its own label. */
	readonly served: RelDag
	/** The label of each closed import the program's check built (check/session.ts CheckSession closedRoots). */
	readonly imports: ReadonlySet<NodeId>
	/** The served statement, as an internal compiler error names it. */
	readonly member: string
}

/**
 * Holds a served statement to the rule (the header): each closed import of its program that reads no parameter and some
 * relation, and that it still computes after servedDag (a node of `served` under its label that is no Base), is no
 * stored canonical relation's whose table serves the statement. A stored relation's whose holders the statement writes
 * reads its rows as the write left them, never its table, which the write's own COMMIT replaces; a live one's, and a
 * node of no form admission made (an import over a role's query entry, whose rows its claims select), are computed where
 * they stand.
 */
export const servedDerivations = (s: ServedCompile): void => {
	const computed = new Set<NodeId>(
		topoOrder(s.served).flatMap((node) => (node.kind === "Base" ? [] : [node.id]))
	)
	const scopes = nodeScopes()
	const digests = new CanonicalDigests()
	for (const node of topoOrder(s.checked)) {
		if (
			!s.imports.has(node.id) ||
			!computed.has(node.id) ||
			node.kind === "Base" ||
			node.meta.paramDeps.length > 0 ||
			node.meta.reads.length === 0 ||
			scopes.of(node).outer.size > 0
		) {
			continue
		}
		const digest = digests.of(node)
		const relation = digest.ok ? s.schema.formOf(digest.value) : undefined
		if (relation?.holding.kind === "stored" && s.rows.serves(relation.subject.name)) {
			defect(
				`${s.member} computes ${relation.subject.name}, whose table serves its statement, in its place`
			)
		}
	}
}

/** The label of each node of `dag` that `session`'s checks built as a closed import (check/session.ts closedKey). */
export const importLabels = (dag: RelDag, session: CheckSession): ReadonlySet<NodeId> =>
	new Set(
		topoOrder(dag).flatMap((node) => (session.closedKey(node) === undefined ? [] : [node.id]))
	)
