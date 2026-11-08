import { inject } from "vitest"

/** The key the type tier's run travels under, from its global setup to every test process. */
export const typeRunKey = "grizzle.types.run"

/**
 * The type tier's run as its global setup hands it to the test processes: the run's seed, which the generated programs
 * the batch checks and the tests that read them both draw from, so the two agree; and the type-test batch, the file its
 * result is written to once its builder has built it (build.ts), or none when the run has no type-test file. Plain
 * data, since what crosses to a worker must survive structured cloning.
 */
export type TypeRun = Readonly<{
	seed: number
	batch: Readonly<{ kind: "none" }> | Readonly<{ kind: "batch"; file: string }>
}>

declare module "vitest" {
	interface ProvidedContext {
		[typeRunKey]: TypeRun
	}
}

/** The type tier's run, in a test process of `pnpm test`. */
export const typeRun = (): TypeRun => inject(typeRunKey)
