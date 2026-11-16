/**
 * An installation's live plan is exactly what its served reads route by: the snapshot generate drafts records as `live`
 * every stored relation some served read's footprint holds, with every field some read routes it by, and every
 * materialized derived relation one reads, and nothing else, and none where no served member reads, so the change
 * source an installation installs from it signals every change a served read routes and none no read routes.
 *
 * Over generated public schemas (test/support/oracle/public), each extended by a drawn law level holding a
 * materialized view, and live logins drawn over them (test/support/served-login.ts liveLoginGen), whose first role reads
 * that view and through its query entry, each configured and drafted as `grizzle generate` drafts it (cli/generate.ts
 * draftSchema, then servedFiles): the union of the served files' read footprints, each installed table, view and column
 * named back as the drafted snapshot's theory names it (its relation's ident, its field's column), is the drafted
 * snapshot's live plan, and snapshot.json writes that plan.
 *
 * The oracle is the served files themselves: the routes a running layer reads, never program/workload/compile.ts
 * livePlanOf.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { lawLevelGen } from "#test/support/oracle/public/laws.ts"
import { drawnSchema, liveLoginGen } from "#test/support/served-login.ts"
import { type Feature, liveIsTheUnion } from "#test/unit/cli/served-live.fixtures.ts"

/** An installation's live plan is exactly the union of what its served reads route by. */
export const anInstallationsLivePlanIsExactlyTheUnionOfWhatItsServedReadsRouteBy = property.explore(
	(source) => [source.draw(caseSketchGen), source.draw(lawLevelGen)] as const,
	{
		needs: {},
		situations: [
			"a footprint table routed by a field",
			"a footprint table read table-wide",
			"a materialized view a read reads",
			"a relation two reads read"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			(_, notes: Case<Feature>) =>
			([sketch, level]) =>
				Effect.suspend(() => {
					const schema = drawnSchema(notes.draw(resolveCase(sketch)), level)
					return liveIsTheUnion(schema, level, notes.draw(liveLoginGen(schema)), notes.note)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the union of the served files' read footprints, named back by the drafted snapshot's theory"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/workload/compile.ts",
				original:
					"\t\t\t.map(([relation, fields]) => ({ relation, routes: [...fields].toSorted(compareText) })),",
				replacement:
					"\t\t\t.map(([relation, fields]) => ({ relation, routes: [...fields].toSorted(compareText).slice(1) })),",
				why: "Each table's first routed field is left out of the live plan."
			},
			{
				file: "packages/engine/src/program/workload/compile.ts",
				original: "\t\tviews: [...views].toSorted(compareText)",
				replacement: "\t\tviews: []",
				why: "Every materialized derived relation is left out of the live plan."
			}
		]
	}
)
