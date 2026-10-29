import { describe, it } from "@effect/vitest"
import { Array as Arr, String as Str } from "effect"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import { type LedgerRow, ledgerState } from "#compiler/deploy/ledger/ledger.ts"
import { metaFileName } from "#compiler/deploy/render/folder.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"

/** The `<schema>.__migrations` ledger's state as `grizzle migrate apply` reads it, in the cases no apply against a
 * database reaches: a custom folder of no file, and damage no apply leaves. */
const empty = SchemaFingerprint(Str.repeat(64)("e"))
/** A stand-in fingerprint of the snapshot a folder reaches. */
const fpA = SchemaFingerprint("A")
const row = (
	folder: string,
	ordinal: number,
	files: number,
	source: string,
	target: string
): LedgerRow => ({
	folder,
	ordinal,
	file: ordinal === 0 ? metaFileName : `0${ordinal}-x.sql`,
	source: SchemaFingerprint(source),
	target: SchemaFingerprint(target),
	files,
	digest: "d"
})

describe("the ledger's state and the apply decision", () => {
	it("a custom folder with no file completes on its folder row, and its target is its source", () => {
		const state = succeeded(
			ledgerState(
				[
					row("20260101000000_a", 0, 1, empty, "A"),
					row("20260101000000_a", 1, 1, empty, "A"),
					row("20260102000000_c", 0, 0, "A", "A")
				],
				empty
			)
		)
		assert.equal(state.latest, fpA)
		assert.deepEqual(
			Arr.map(state.complete, (f) => f.folder),
			["20260101000000_a", "20260102000000_c"]
		)
		assert.equal(state.partial, undefined)
	})

	it("refuses damage no apply leaves: file rows without their folder row, two partial folders, disagreeing rows", () => {
		refused(ledgerState([row("f", 1, 1, empty, "A")], empty), "MalformedArtifact")
		refused(
			ledgerState(
				[row("f", 0, 2, empty, "A"), row("f", 1, 2, empty, "A"), row("g", 0, 2, "A", "B")],
				empty
			),
			"MalformedArtifact"
		)
		refused(
			ledgerState([row("f", 0, 1, empty, "A"), row("f", 1, 1, empty, "B")], empty),
			"MalformedArtifact"
		)
	})
})
