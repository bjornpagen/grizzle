/** What the properties of digest-book.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { AdmittedBytes } from "#compiler/scalar/values/bytes.ts"

/** An admitted value whose digest the case chooses, so two values of different bytes may share one. */
export class Forged extends AdmittedBytes {
	override readonly digest: string
	constructor(bytes: Uint8Array<ArrayBuffer>, digest: string) {
		super(bytes)
		this.digest = digest
	}
}

/** One admission: its bytes, from a two-letter alphabet, the digest forged for it, and whether it reuses an array. */
interface Admission {
	readonly bytes: ReadonlyArray<number>
	readonly digest: "a" | "b" | "c"
	readonly reuse: boolean
}

export const admission: Gen<Admission> = (s) => ({
	bytes: s.draw(array(int(0, 1), { min: 0, max: 3 })),
	digest: s.draw(element(["a", "b", "c"] as const)),
	reuse: s.draw(element([false, true] as const))
})

export type Feature =
	| "a first value of its digest"
	| "the same bytes again"
	| "the same array again"
	| "different bytes of one digest"
