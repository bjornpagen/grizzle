import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	checkIndexes,
	checkReports,
	type Feature,
	FEATURES,
	featuresOf,
	installationOf,
	objectsOf,
	placementsOf,
	restated,
	schemaOf,
	sketchGen
} from "#test/unit/laws/model/probed-target.fixtures.ts"

/** A fixed target's UNIQUE beside the reverse probes out of its selection plans no redundant pair, a unique index per referenced set and none beyond the keys and references, no more objects than the implied keys restated, a constant only where it saves one, and reports a key every duplicate breaks. Its budget is its suite's before it was a property (test/unit/laws/model/probed-target.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const aFixedTargetsUNIQUEBesideTheReverseProbesOutOfItsSelectionPlansNoRedundantPairAUniqueIndexPerReferencedSetAndNoneBeyondTheKeysAndReferencesNoMoreObjectsThanTheImpliedKeysRestatedAConstantOnlyWhereItSavesOneAndReportsAKeyEveryDuplicateBreaks =
	property.explore(sketchGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: FEATURES satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (s) =>
			Effect.sync(() => {
				c.noteAll(featuresOf(s))
				const placements = placementsOf(schemaOf(s, []))
				const plain = placements.chosen
				checkIndexes(plain, "the schema with K alone")
				checkReports(plain, "the schema with K alone", c.note)
				const restating = installationOf(schemaOf(s, restated(s)))
				checkIndexes(restating, "the schema with the implied keys restated")
				checkReports(restating, "the schema with the implied keys restated", c.note)
				const alone = objectsOf(plain)
				const beside = objectsOf(restating)
				assert.ok(
					alone.objects <= beside.objects,
					`K alone plans ${alone.objects} indexes and law columns, no more than the ${beside.objects} of K beside the keys it implies`
				)
				assert.equal(
					placements.again,
					alone.objects,
					"the model's own choice, installed again as a recorded placement, plans what the model plans"
				)
				assert.equal(
					alone.objects,
					placements.least,
					`K alone plans ${alone.objects} indexes and law columns, the fewest of any placement of its fixed targets (${placements.least})`
				)
				if (alone.constants > beside.constants) {
					c.note("constant columns that cost the schema no more objects")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the planned index set and law columns: no redundant pair, one unique index per referenced set, none a law needs no more, no more objects than with the implied keys restated and a constant column only where it saves one, and each unique index reporting a key the pairs of a box of rows it refuses break"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/laws/model/probed-target.test.ts#aFixedTargetsUNIQUEBesideTheReverseProbesOutOfItsSelectionPlansNoRedundantPairAUniqueIndexPerReferencedSetAndNoneBeyondTheKeysAndReferencesNoMoreObjectsThanTheImpliedKeysRestatedAConstantOnlyWhereItSavesOneAndReportsAKeyEveryDuplicateBreaks:-:1.0.0.2.0.1.0.0.2.0.1.3.0.0.0.1.0.2.0.2.0.2.1.1.1.0"
				),
				reason:
					"Two targets fixing kind = 2 over (a, b), K on (a, kind) over select(T, c = 1), and probes out of K's selection over (id, a, b) and (a, b): the superkey (a, b, kind) leads the (a, b) probe, but the engine's index for the (id, a, b) probe leads with (a, b) too, so the superkey saves no B-tree and its two constants cost one more object than the targets' own columns. The choice counted each unserved probe a B-tree of its own until probeIndexes, and K alone planned 20 objects to the restated keys' 19 (rotating case 166)",
				since: "2026-11-14"
			},
			{
				token: ReplayToken(
					"test/unit/laws/model/probed-target.test.ts#aFixedTargetsUNIQUEBesideTheReverseProbesOutOfItsSelectionPlansNoRedundantPairAUniqueIndexPerReferencedSetAndNoneBeyondTheKeysAndReferencesNoMoreObjectsThanTheImpliedKeysRestatedAConstantOnlyWhereItSavesOneAndReportsAKeyEveryDuplicateBreaks:-:0.0.0.1.0.2.1.1.0.0.1.0.0.0.2.1.0.0.1.1.1.2.2.0.0"
				),
				reason:
					"K on a over every row, two targets fixing kind = 1 over (a, b) and (a), one fixing kind = 0 over (b, a), and probes out of select(T, kind = 0) over (a, b) and out of every row over (b): the targets over (a, b) and (b, a) share one superkey column set, which the law model installs once, in the first target's order (a, b, kind), so it leads no (b) probe. The choice read each landing's own order, priced (b, a, kind) as serving the (b) probe, took every superkey at a tie, and K alone planned 19 objects to the restated keys' 18 (rotating case 165, TEST_SEED=20261115)",
				since: "2026-11-14"
			},
			{
				token: ReplayToken(
					"test/unit/laws/model/probed-target.test.ts#aFixedTargetsUNIQUEBesideTheReverseProbesOutOfItsSelectionPlansNoRedundantPairAUniqueIndexPerReferencedSetAndNoneBeyondTheKeysAndReferencesNoMoreObjectsThanTheImpliedKeysRestatedAConstantOnlyWhereItSavesOneAndReportsAKeyEveryDuplicateBreaks:-:0.0.0.2.0.2.0.0.0.0.0.0.1.0.0.1.0.0.0.2.0.0"
				),
				reason:
					"K on a over every row, three targets fixing kind = 2, 0 and 1 over (a, b), one superkey (a, b, kind) for all three, and a probe out of select(T, kind = 2) over (id, a, b), which the kind = 2 target's own columns serve: the fewest objects take the other two to the superkey and keep that one at its own columns. The choice moved all three at once and never one back, and K alone planned 17 objects where that placement plans 16 (floor stream case 53, TEST_SEED=1395491330)",
				since: "2026-11-15"
			},
			{
				token: ReplayToken(
					"test/unit/laws/model/probed-target.test.ts#aFixedTargetsUNIQUEBesideTheReverseProbesOutOfItsSelectionPlansNoRedundantPairAUniqueIndexPerReferencedSetAndNoneBeyondTheKeysAndReferencesNoMoreObjectsThanTheImpliedKeysRestatedAConstantOnlyWhereItSavesOneAndReportsAKeyEveryDuplicateBreaks:-:3.0.0.0.2.0.0.1.1.0.1.0.1.0.1.1.0.0"
				),
				reason:
					"K on (a, b) over every row, a target fixing kind = 0 over (a, b), two fixing b = 0 and kind = 0 over (a, b) and (b, a), and a probe out of select(T, b = 0, kind = 0) over (a): the two guarded targets land on one UNIQUE, which the law model installed in its first plan's order, (b, a) by law order, so it led no (a) probe, and the probe took a B-tree of its own. The restated keys state (a, b), which leads it, and K alone planned 14 objects to their 13 (UNITREDS on trunk)",
				since: "2026-11-21"
			}
		],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\t\treturn rest.reduce((best, order) => (served(order) > served(best) ? order : best), first)",
				replacement: "\t\treturn rest.reduce((best) => best, first)",
				why: "A UNIQUE over one column set is installed in its first plan's order, whatever probe another order leads (laws/model/plan.ts uniqueOrder): two guarded targets over (a, b) and (b, a) install (b, a), a probe over (a) takes a B-tree of its own, and K alone plans one object more than the restated keys."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\t\t\tprobeIndexes(probes.filter((probe) => !installed.some((u) => servesProbe(u, probe)))) +",
				replacement:
					"\t\t\tprobes.filter((probe) => !installed.some((u) => servesProbe(u, probe))).length +",
				why: "The reference choice counts every unserved reverse probe a B-tree of its own, though the engine drafts one index for a chain of probes over nested columns, so it takes a superkey that saves nothing: the chained case's superkey costs its three constants where the target's own columns cost a guard of their own and one B-tree for the chain, one object fewer."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\treturn targets.filter((t) => taken.has(t)).map((t) => t.own.columns)",
				replacement: "\treturn targets.map((t) => t.own.columns)",
				why: "Every fixed target at its terms and fixed field (laws/model/plan.ts takingShared); the fewest objects of any placement catch it."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\t\t\t).length +\n\t\t\tdistinct(\n\t\t\t\ttargets.filter((t) => taking.has(t)).flatMap((t) => t.constants),\n\t\t\t\tsameConstant\n\t\t\t).length",
				replacement: "\t\t\t).length\n",
				why: "The choice counts a constant column as nothing, so a superkey is taken though the target's own columns need no constant and cost less (laws/model/plan.ts takingShared); the restated keys' objects catch it."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\t\tconst host = own.find((c) => serves(c.index, entry))",
				replacement:
					'\t\t\t\tconst host = own.find((c) => serves(c.index, entry) && !(entry.request.use === "reverse reference" && c.index.unique))',
				why: "Each reverse probe a B-tree of its own beside a unique index that serves it (physical/indexes/engine.ts planIndexes); the redundant pair catches it."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\t\t...this.#targetUnique(toRel, reference.targetColumns, containment, loc),",
				replacement:
					"\t\t\t...(reference.columns === sourceColumns ? [] : this.#targetUnique(toRel, reference.targetColumns, containment, loc)),",
				why: "No UNIQUE beside a reference at a target's own columns (laws/model/plan.ts scalar containment); the foreign key that references no unique index catches it."
			},
			{
				file: "packages/engine/src/laws/model/model.ts",
				original:
					'\t\tfor (const law of this.theory.laws) {\n\t\t\tif (\n\t\t\t\tlaw.detail.kind === "projectedKey" &&\n\t\t\t\t!law.detail.side.terms.some((t) => isSpanField(t.column))\n\t\t\t) {\n\t\t\t\tadd(law.detail.side.relation, law.detail.side, law)\n\t\t\t}\n\t\t}\n\t\treturn (unique) =>',
				replacement: "\t\treturn (unique) =>\n",
				why: "laws/model/model.ts #implyingKey back to declared keys only, so a UNIQUE only K over a selection implies reports its containment; the reported key catches it."
			}
		]
	})
