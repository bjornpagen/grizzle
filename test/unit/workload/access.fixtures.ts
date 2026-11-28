/** What the properties of access.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { element, uniqueKeys } from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import type { Source } from "@bjornpagen/testing/source"
import { regex } from "arkregex"
import { Array as Arr, Record as Rec } from "effect"
import type { AccessPath } from "#compiler/ir/products.ts"
import { workPrograms } from "#test/support/unit/workload/fixtures.ts"

/**
 * A readable label of a path, `task(account, priority desc, id) btree for page seek`: its method decides its keys'
 * operator class.
 */
export const pathLabel = (p: AccessPath): string => {
	const keys = Arr.map(p.keys, (k) => (k.dir === "desc" ? `${k.field} desc` : k.field))
	return `${p.relation}(${Arr.join(keys, ", ")}) ${p.method} for ${p.use}`
}

export const named = nonEmpty(Rec.toEntries(workPrograms), "the worked example's programs")

/** A workload of drawn programs under drawn names, a program possibly under several. */
export const workloadGen = (source: Source) =>
	Arr.map(
		source.draw(uniqueKeys(matching(regex("^[a-z][a-zA-Z0-9]{0,5}$")), { min: 1, max: 6 })),
		(name) => {
			const [programSource, program] = source.draw(element(named))
			return { name, source: programSource, program }
		}
	)

export type PlanFeature = "a program under two names" | "a path several programs request"
