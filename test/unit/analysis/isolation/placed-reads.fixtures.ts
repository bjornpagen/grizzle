/** What placed-reads.test.ts reads: its oracle's reading of a case's shared reads. */

import { Array as Arr } from "effect"
import { readModes } from "#compiler/analysis/isolation/certify.ts"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { sharedInput } from "#test/unit/analysis/isolation/certify.fixtures.ts"

/**
 * Whether some read of a query CTE of some member of the case takes one mode at two of its instances: the same read of
 * the same query, the same read fact by its canonical text, at two instances, as the certifier keys a placed read
 * (analysis/isolation/certify.ts readsUnder). Two instances of one query whose read at one place binds its group
 * otherwise read two facts, two reads of the statement.
 */
export const sharedRead = (c: Parameters<typeof sharedInput>[0]): boolean => {
	const input = sharedInput(c, (st) => st)
	return Arr.some(input.roles, (role) =>
		role.writes.kind !== "served"
			? false
			: Arr.some(role.writes.members, (member) => {
					const seen = new Map<string, number>()
					for (const r of readModes(input, member)) {
						if (r.at.cte === undefined) {
							continue
						}
						const cte = member.statements[r.statement]?.ctes[r.at.cte]
						const read = cte?.reads[r.at.read]
						const key = `${r.statement}|${cte?.query}|${r.at.read}|${canonicalTextOf(read)}|${r.mode}`
						const at = seen.get(key)
						if (at !== undefined && at !== r.at.cte) {
							return true
						}
						seen.set(key, r.at.cte)
					}
					return false
				})
	)
}
