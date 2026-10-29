import { Effect } from "effect"
import { startProcessCoverage } from "#sense.ts"

await Effect.runPromise(startProcessCoverage)
