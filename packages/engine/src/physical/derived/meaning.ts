import { derivedAnalysis } from "#compiler/analysis/schema.ts"
import { unwrap } from "#compiler/core/canonical.ts"
import { rooted, rowsDigestWithin, StatedFacts } from "#compiler/ir/dag.ts"
import { noneWritten, servedQuery } from "#compiler/ir/derived.ts"
import { makePassContext } from "#compiler/ir/pass.ts"
import { derivedKeyConstraints, evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import { sourcePrunePass } from "#compiler/lower/optimize/prune/index.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"

/**
 * A stored derived relation is identified by what it means, never by its SQL: the digest of the rows its admitted
 * definition's DAG yields of the rows it reads, as it reads them (ir/dag.ts rowsDigestWithin), the definition pruned
 * by the prune that narrows the sources (lower/optimize/prune sourcePrunePass), so it reads of each relation the columns
 * it binds and the relation's primary key, as a law's check is identified (snapshot/violation.ts checkOf), but with no
 * key a law declares: a key the relations it reads gain or lose yields no other row, and the view's own keys are
 * unique indexes beside it, which a draft adds or drops alone. A change of the definition, of a relation it reads or
 * of a column it reads is a new meaning, and a change of how grizzle lowers, rewrites or analyzes it, or of a key, is
 * none. The snapshot records each view's meaning (deploy/snapshot/types.ts SnapshotRelation), by which a
 * draft creates the view again exactly when its meaning changes (deploy/diff/diff.ts viewDropsOf), and records a view
 * it keeps as it was installed, an earlier lowering's SQL (deploy/snapshot/build.ts withInstalledViews).
 *
 * Each view's meaning, by its derived relation's declared name, in the installation's order of its derived relations.
 */
export const definitionMeanings = (installation: Installation): ReadonlyMap<string, string> => {
	const analysis = derivedAnalysis(installation.checked)
	const catalog = evidenceCatalog({
		laws: installation.laws,
		views: derivedKeyConstraints(analysis)
	})
	/** The closed facts every definition's meaning reads, each read once for all of them (ir/dag.ts StatedFacts). */
	const stated = new StatedFacts(installation.checked.closed)
	return new Map(
		analysis.order.map((a) => {
			/** As its fill reads it: a lower level's stored relation by its table, a live one by its definition, whose
			 * meaning is then its own (ir/derived.ts servedQuery). */
			const served = servedQuery(a.query, installation.checked.rows(noneWritten))
			const pruned = unwrap(
				sourcePrunePass.run(
					{ dag: rooted([served.dag.roots[0]]), params: [] },
					makePassContext({ evidenceContext: "transaction", catalog })
				)
			)
			const reads = conservativeInput(pruned)
			const meaning = unwrap(
				rowsDigestWithin(reads.dag, [reads.root], "derived-definition", stated)
			)
			return [a.name, meaning] as const
		})
	)
}
