import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { resolveCase } from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	holds,
	type Read,
	sketchGen,
	type TemplateFeature
} from "#test/unit/program/context.fixtures.ts"

/** A template rests on committed-snapshot evidence only for a snapshot, and shares one conservative artifact. Its budget is its suite's before it was a property (test/unit/program/context.test.ts at 4ca3036a): 100 runs and 100 steered cases. */
export const aTemplateRestsOnCommittedSnapshotEvidenceOnlyForASnapshotAndSharesOneConservativeArtifact =
	property.explore(sketchGen, {
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: [
			"rows",
			"page",
			"a committed-snapshot certificate",
			"several relations",
			"a generated program"
		] satisfies ReadonlyArray<Reached<TemplateFeature>>,
		check: (_, k: Case<TemplateFeature>) => (sketch) =>
			Effect.sync(() => {
				if (sketch.kind === "planted") {
					holds(
						{
							program: sketch.program.program,
							schema: undefined,
							read: sketch.read,
							what: `${sketch.program.name} as ${sketch.read}`
						},
						k.note
					)
					return
				}
				const c = k.draw(resolveCase(sketch.sketch))
				const built = buildSchema(c.schema)
				k.note("a generated program")
				for (const [i, read] of c.reads.entries()) {
					if (read.kind !== "query") {
						continue
					}
					const program = buildRoot(built, built.schema, read.query)
					const reads: ReadonlyArray<Read> =
						read.query.delivery.kind === "ordered" ? ["rows", "page"] : ["rows"]
					for (const as of reads) {
						holds(
							{
								program,
								schema: built.schema,
								read: as,
								what: `read ${i} as ${as}\n${printCase(c)}`
							},
							k.note
						)
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "a transaction's template rests on no committed-snapshot evidence, and the conservative lowering on none at all"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/compile.ts",
				original: "\t\tcatalog: evidenceCatalog(artifacts),\n\t\tcontext",
				replacement: '\t\tcatalog: evidenceCatalog(artifacts),\n\t\tcontext: "snapshot"',
				why: "A transaction's template is lowered under committed-snapshot evidence (program/compile.ts compileQuery); the compilation's verified context promise fails: a plan compiled for the transaction context, not snapshot."
			},
			{
				file: "packages/engine/src/program/compile.ts",
				original: "\t\tprograms: { optimized, checked: served },",
				replacement:
					'\t\tprograms: { optimized, checked: context === "snapshot" ? { ...served, dag: analyzed.value.dag } : served },',
				why: "The conservative lowering is keyed by the context: under a snapshot it lowers the analysis's restated DAG."
			}
		]
	})
