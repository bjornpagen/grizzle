import { inject } from "vitest"

/** The key the type tier's run travels under, from its global setup to every test process. */
export const typeRunKey = "grizzle.types.run"

/**
/**
 * A run's type-test batch as a test process reaches it: the directory its builder (build.ts) writes the result into,
 * an index and one file per unit (batch.ts batchLayout), and the Unix socket that ends each connection once the writer
 * has finished (batch.ts writtenSignal).
 */
export type BatchAt = Readonly<{ dir: string; signal: string }>

/**
 * The type tier's run as its global setup hands it to the test processes: the run's seed, which the generated programs
 * the batch checks and the tests that read them both draw from, so the two agree; and the type-test batch, or none when
 * the run has no type-test file. Plain data, since what crosses to a worker must survive structured cloning.
 */
export type TypeRun = Readonly<{
	seed: number
	batch: Readonly<{ kind: "none" }> | (Readonly<{ kind: "batch" }> & BatchAt)
}>

declare module "vitest" {
	interface ProvidedContext {
		[typeRunKey]: TypeRun
	}
}

/** The type tier's run, in a test process of `pnpm test`. */
export const typeRun = (): TypeRun => inject(typeRunKey)
