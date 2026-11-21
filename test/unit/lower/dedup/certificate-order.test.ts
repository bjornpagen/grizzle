/**
 * A plan's certificates are put in canonical order by one read of its node order (lower/optimize/dedup/certify.ts
 * canonicalCertificates, firstPositions): each label's first position read once, and each certificate's first output
 * the least first position of its outputs, where each certificate scanned the order from its start, so the reads were
 * the certificates times the order: 34 s of edullm's QTI database generate at 94aa830e1, a write's plan holding
 * thousands of certificates over thousands of nodes.
 *
 * The box, drawn: an order of one to eight labels, one possibly met twice, and two to twelve certificates of three rules,
 * each with any outputs among eight labels, one possibly drawn twice.
 *
 * Properties: the canonical list is the scan's (a second implementation, certify.ts at 8071f3a64); and its reads of the
 * order are the order's length, each entry once, however many certificates the plan holds. Kills: a label's last
 * position kept, where its first is the scan's; and the positions read again for each certificate, the scan's work.
 *
 * Features: an output the order does not hold; two certificates at one position; one certificate drawn twice; a label
 * met twice in the order.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import { canonicalCertificates } from "#compiler/lower/optimize/dedup/certify.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	boxGen,
	countedOrder,
	referenceCertificates
} from "#test/unit/lower/dedup/certificate-order.fixtures.ts"

type Situation =
	| "an output the order does not hold"
	| "two certificates at one position"
	| "one certificate drawn twice"
	| "a label met twice"

/** A plan's canonical certificates are the scan's. */
export const aPlansCanonicalCertificatesAreTheScans = property.explore(boxGen, {
	needs: {},
	situations: [
		"an output the order does not hold",
		"two certificates at one position",
		"one certificate drawn twice",
		"a label met twice"
	] satisfies ReadonlyArray<Reached<Situation>>,
	check: (_, c: Case<Situation>) => (box) =>
		Effect.sync(() => {
			const canonical = succeeded(canonicalCertificates(box.order, box.certificates))
			const reference = succeeded(referenceCertificates(box.order, box.certificates))
			assert.deepEqual(canonical, reference, "the canonical certificates are the scan's")
			const held = new Set(box.order)
			if (Arr.some(box.certificates, (cert) => Arr.some(cert.outputs, (id) => !held.has(id)))) {
				c.note("an output the order does not hold")
			}
			const firsts = Arr.map(box.certificates, (cert) =>
				Arr.findFirstIndex(box.order, (id) => cert.outputs.includes(id))
			)
			if (new Set(firsts).size < firsts.length) {
				c.note("two certificates at one position")
			}
			const texts = Arr.map(box.certificates, (cert) => succeeded(encode(cert, everyProperty)))
			if (new Set(texts).size < texts.length) {
				c.note("one certificate drawn twice")
			}
			if (held.size < box.order.length) {
				c.note("a label met twice")
			}
		}),
	oracle: {
		kind: "second-implementation",
		name: "the canonical order by a scan of the node order for each certificate (certify.ts at 8071f3a64)"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/optimize/dedup/certify.ts",
			original: "\t\tif (!positions.has(id)) {\n",
			replacement: "\t\tif (positions.has(id) || !positions.has(id)) {\n",
			why: "Each label keeps its last position in the order, where the scan meets its first: a certificate whose output is met twice sorts at the later position, after one the scan puts after it, and the search fails."
		}
	]
})

/** A plan's canonicalization reads its node order once, however many certificates it holds. */
export const aPlansCanonicalizationReadsItsNodeOrderOnceHoweverManyCertificatesItHolds =
	property.explore(boxGen, {
		needs: {},
		situations: [],
		check: () => (box) =>
			Effect.sync(() => {
				const reads = { count: 0 }
				succeeded(canonicalCertificates(countedOrder(box.order, reads), box.certificates))
				assert.equal(
					reads.count,
					box.order.length,
					`the order's ${box.order.length} entries are each read once for ${box.certificates.length} certificates`
				)
			}),
		oracle: {
			kind: "specification",
			name: "one read of each entry of the node order for the whole plan"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/dedup/certify.ts",
				original:
					"\t\tkeyed.push({ cert, text: text.value, at: firstOutputAt(positions, order.length, cert.outputs) })\n",
				replacement:
					"\t\tkeyed.push({ cert, text: text.value, at: firstOutputAt(firstPositions(order), order.length, cert.outputs) })\n",
				why: "Each certificate reads the whole order again for its first output, the scan's work: the reads are the order's length for each of two certificates at least, and the search fails."
			}
		]
	})
