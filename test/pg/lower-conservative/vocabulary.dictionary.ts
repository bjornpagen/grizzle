import { nonEmpty } from "@bjornpagen/testing/assert"
import { dictionary } from "@bjornpagen/testing/dictionary"
import { Array as Arr } from "effect"
import { opForms } from "#compiler/lower/conservative/expr/ops.ts"

/**
 * The default operator table's entries, each a function's identity and the operator form it is spelled by
 * (lower/conservative/expr/ops.ts opForms): the source's own roster, never cases a person chose.
 */
export const operatorForms = dictionary(
	nonEmpty(Arr.fromIterable(opForms), "the default operator table's entries")
)
