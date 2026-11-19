import { nonEmpty } from "@bjornpagen/testing/assert"
import { dictionary } from "@bjornpagen/testing/dictionary"
import { Array as Arr } from "effect"
import { aliasGroups, refusedNames } from "#test/support/kernel/dict.ts"

/**
 * The declared names the naming door refuses, each with its reason (test/support/kernel/dict.ts refusedNames). The
 * naming door's own verdicts are the domain, never cases a person chose.
 */
export const refusedNameWords = dictionary(nonEmpty(refusedNames, "a refused name"))

/**
 * Each alias group's first two names (test/support/kernel/dict.ts aliasGroups): two declared names one scope cannot
 * hold together. The naming door's own groups are the domain, never cases a person chose.
 */
export const aliasPairs = dictionary(
	nonEmpty(
		Arr.flatMap(aliasGroups, ([first, second]) =>
			second === undefined ? [] : [[first, second] as const]
		),
		"an alias pair"
	)
)
