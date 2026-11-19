import { nonEmpty } from "@bjornpagen/testing/assert"
import { dictionary } from "@bjornpagen/testing/dictionary"
import { Array as Arr } from "effect"
import { nativeOps } from "#compiler/scalar/compute/registry.ts"

/**
 * The registry's operations over two sets (scalar/compute/registry.ts nativeOps): every native node whose two operands
 * are both a set over a roster. The registry's own nodes are the domain, never cases a person chose.
 */
export const twoSetOperations = dictionary(
	nonEmpty(
		Arr.filter(
			nativeOps,
			(op) =>
				op.operands.kind === "positional" &&
				op.operands.carriers.length === 2 &&
				Arr.every(op.operands.carriers, (carrier) => carrier === "bits")
		),
		"the registry's operations over two sets"
	)
)
