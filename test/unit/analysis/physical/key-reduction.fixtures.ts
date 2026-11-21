/** What the property of key-reduction.test.ts reads: the key reduction at 94aa830e1. */

import type { Dependencies, JustifiedKey } from "#compiler/analysis/physical/fds.ts"
import { lessDemanding } from "#compiler/ir/evidence.ts"
import type { KeySet } from "#compiler/ir/rel.ts"

/**
 * The canonical minimal key among a candidate in heading order, as fds.ts reduced it at 94aa830e1: each column dropped,
 * from the end, while the rest still identifies a row on a proof no more demanding, each narrower key proved by the
 * strongest proof over every stage (Dependencies proof) and its context compared with the key's.
 */
export const referenceKeyAmong = (
	table: Dependencies,
	candidate: KeySet
): JustifiedKey | undefined => {
	const just = table.proof(candidate)
	if (just === undefined) {
		return undefined
	}
	let key = candidate
	let proof = just
	for (let i = key.length - 1; i >= 0; i--) {
		const without = key.toSpliced(i, 1)
		const narrower = table.proof(without)
		if (narrower !== undefined && !lessDemanding(proof.context, narrower.context)) {
			key = without
			proof = narrower
		}
	}
	return { columns: key, just: proof }
}
