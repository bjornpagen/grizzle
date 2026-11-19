import type { Result } from "@bjornpagen/grizzle-text/base/result"
import type { Result as Public } from "effect"

/**
 * How a public answer spells a Result: the shell's conversion of an engine Result into Effect's (packages/grizzle
 * adapter/engine.ts toResult), passed where the shell builds a public reader, rowEvaluator, insertPreview or codecText,
 * so the engine answers every item a caller reads as Effect's Result, where the item is computed, without a runtime
 * dependency on Effect.
 */
export type PublicResult = <A, E>(result: Result<A, E>) => Public.Result<A, E>
