/** What the properties of interrupted.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { ambientSessionGen } from "#test/support/ambient.ts"
import { type Restorage, restorageGen } from "#test/support/oracle/gen/restorage.ts"
import { type Perturbation, perturbationGen } from "#test/support/oracle/perturb.ts"
import { plantedCasesGen, writeCaseGen } from "#test/support/oracle/write/harness.ts"
import type { WriteRun } from "#test/support/oracle/write/index.ts"
import { schemaSketchGen } from "#test/support/oracle/write/schema.ts"

/**
 * Where a run's cases stood when the property stopped them, and whether a backend of the writer's login was still
 * listed, its session ended and the backend on its way out, when the property read them.
 */
export type InterruptFeature =
	| "interrupted after a commit"
	| "ended before any commit"
	| "a backend on its way out"

/** A small write run, drawn with the plan perturbation and the restorage it runs under. */
export const runGen: Gen<readonly [WriteRun, Perturbation, Restorage]> = (source) =>
	[
		{
			schema: source.draw(schemaSketchGen),
			statistics: source.draw(element(["analyzed", "none"] as const)),
			ambient: source.draw(ambientSessionGen),
			cases: source.draw(array(writeCaseGen, { min: 1, max: 2 })),
			planted: source.draw(plantedCasesGen)
		},
		source.draw(perturbationGen),
		source.draw(restorageGen)
	] as const
