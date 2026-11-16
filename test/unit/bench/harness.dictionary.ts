/** The vocabularies harness.test.ts draws from: the domain itself, never cases a person chose. */

import { dictionary } from "@bjornpagen/testing/dictionary"
import { Array as Arr } from "effect"
import { gateCatalog } from "#bench/harness/rules.ts"
import { nonEmpty } from "#test/support/assert.ts"

/** Every gate of the catalog, by its id: the domain the catalog's audit walks and a record's gates are drawn from. */
export const catalogIds = dictionary(
	nonEmpty(
		Arr.map(gateCatalog, (e) => e.id),
		"the catalog's gates"
	)
)
