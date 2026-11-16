import { dictionary } from "@bjornpagen/testing/dictionary"
import { nativeOps } from "#compiler/scalar/compute/registry.ts"
import { nonEmpty } from "#test/support/assert.ts"

/**
 * The registry's native operations (scalar/compute/registry.ts nativeOps), every node the evaluator and the lowering
 * dispatch on. The registry's own nodes are the domain, never cases a person chose.
 */
export const nativeOperations = dictionary(nonEmpty(nativeOps, "the registry's nodes"))
