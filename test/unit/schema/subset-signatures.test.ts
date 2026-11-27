/**
 * A declared function's closed id is of its whole roster (schema/function-own.ts subsetId): a value of a subset comes
 * from a value of that subset, and no function's body is one, since a call casts the function's value to the roster's
 * domain alone, so a signature naming a subset would type a query's term by a subset no body is held to.
 *
 * The box, exhausted: a closed id of the whole roster, of `only` a subset and of every handle `except` one, at each place
 * of a signature: an argument, the result, a field of the heading the function returns rows of, and of the row it takes
 * and returns. Each reaches ownership as a JavaScript caller hands it, since its type refuses the subset. The oracle is
 * the rule stated: the whole roster's is owned, and a subset's is refused at its place by the rule, naming it.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { refused, succeeded } from "#test/support/assert.ts"
import {
	ownedCase,
	type SignatureCase,
	signatureCases
} from "#test/unit/schema/subset-signatures.fixtures.ts"

type Feature = "a whole roster's closed id owned" | "a subset's closed id refused"

/** A declared function's closed id is of its whole roster: a subset's is refused wherever its signature holds it. */
export const aDeclaredFunctionsClosedIdIsOfItsWholeRoster = property.exhaust(
	finite(signatureCases),
	{
		box: "a closed id of the whole roster, of only a subset and of every handle except one, as an argument, the result, a field of returned rows and of a row taken and returned",
		needs: {},
		situations: [
			"a whole roster's closed id owned",
			"a subset's closed id refused"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (k: SignatureCase) =>
			Effect.sync(() => {
				const owned = ownedCase(k)
				if (k.form === "whole") {
					c.note("a whole roster's closed id owned")
					succeeded(owned, `a closed id of the whole roster as ${k.place} is owned`)
					return
				}
				c.note("a subset's closed id refused")
				const error = refused(owned, "Refused", `a closed id of a subset as ${k.place} is refused`)
				assert.ok(
					error.reason._tag === "Refused" &&
						error.reason.refusal ===
							"a declared function's closed id is of its whole roster: no function's body is a value of a subset",
					`a closed id of a subset as ${k.place} is refused by its rule: ${error.message}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the rule: a declared function's closed id is of its whole roster"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/function-own.ts",
				original: "\t\t\t\tif (typesOf(t).some(subsetId)) {\n",
				replacement: "\t\t\t\tif (false) {\n",
				why: "A declared function's signature names a closed id of a subset: a query's term of its value is typed by a subset no body is held to, the call casting it to the roster's domain alone."
			}
		]
	}
)
