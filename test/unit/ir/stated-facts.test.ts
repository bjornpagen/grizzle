/**
 * The closed facts a caller's meaning digests read (ir/dag.ts StatedFacts): each closed read's facts projected once for
 * the caller by its relation and payload, the one object every read of that pair answers, with its canonical text,
 * which a digest writes where the facts stand (core/fingerprint.ts digestCarrying), byte for byte the digest of the
 * facts read in place.
 *
 * Oracle: specification, a projection per relation and payload for each caller, and the digest of the facts read in
 * place (core/fingerprint.ts digest). Box: R and S keyed by k, 0 to 12 rows each, read by 1 to 24 closed reads, many
 * alike. Kill: each read projected again.
 */

import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { withoutSourceLocs } from "#compiler/core/canonical.ts"
import { digest, digestCarrying } from "#compiler/core/fingerprint.ts"
import { StatedFacts } from "#compiler/ir/dag.ts"
import { succeeded } from "#test/support/assert.ts"
import { closedFacts, readKey, statedGen } from "#test/unit/ir/stated-facts.fixtures.ts"

/** A caller's closed facts project each closed read once, by its relation and payload, and a digest writing their texts is the digest of the facts read in place. */
export const aCallersClosedFactsProjectEachClosedReadOnceAndADigestWritingTheirTextsIsTheDigestOfTheFactsReadInPlace =
	property.explore(statedGen, {
		needs: {},
		situations: [],
		check:
			() =>
			([rows, reads]) =>
				Effect.sync(() => {
					const stated = new StatedFacts(closedFacts(rows))
					const read = Arr.map(reads, (r) => stated.read(r.relation, r.payload))
					const first = new Map<string, object>()
					for (const [at, r] of reads.entries()) {
						const facts = read[at]
						const known = first.get(readKey(r))
						if (known === undefined && facts !== undefined) {
							first.set(readKey(r), facts)
						} else {
							assert.ok(
								facts === known,
								"every read of one relation and payload answers one object"
							)
						}
					}
					assert.equal(
						stated.projected,
						first.size,
						`${reads.length} closed reads of ${first.size} relations and payloads project as many as there are pairs`
					)
					const form = { reads: read, rows }
					assert.equal<string>(
						succeeded(digestCarrying("stated", form, withoutSourceLocs, stated.texts)),
						succeeded(digest("stated", form, withoutSourceLocs)),
						"the digest writing the facts' texts is the digest of the facts read in place"
					)
				}),
		oracle: {
			kind: "specification",
			name: "a projection per relation and payload for each caller, and the digest of the facts read in place"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/dag.ts",
				original: "\t\tconst known = this.#reads.get(key)\n",
				replacement: "\t\tconst known = this.#reads.get(key + String(this.#reads.size))\n",
				why: "Each closed read projects its facts again, as statedExpr did for every read of every law: the projections are as many as the reads, not the pairs."
			}
		]
	})
