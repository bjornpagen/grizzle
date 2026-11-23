/**
 * The borrow rules over compiled members whose unit key or whole key a row another read finds holds (RCCERT's P1 cases):
 * a learner's answer in a sitting, reading a package's documents at the package its stage's session holds, the session
 * a row of the learner's unit or a fact outside every unit; and metis's operator permission (MR-OPS-GAPS G5), a grant
 * read at the person the signed-in clerk's account holds and the constant program "assign". Each login compiles for
 * READ COMMITTED as generate compiles it, and each member's facts are read under the installation the IR alone gives
 * (program/isolation/borrows.ts borrowInstallationOf).
 *
 * Oracle: each variant of the member proves exactly the borrows the rules restate over its case (borrow-sites.fixtures.ts
 * expectedOf), with no fault: the learner borrows Learner exclusively at its child and Package shared at its session's
 * package, held under Learner where the session sits in it and learned where it is a fact, so its call takes Learner
 * before Package; the operator's permission is an immutable fact at a learned key and borrows nothing.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	caseGen,
	type Case,
	expectedOf,
	proofsOf
} from "#test/unit/program/isolation/borrow-sites.fixtures.ts"

/** A member whose key a row another read finds holds borrows at that row's field, learned or held, and faults nowhere. */
export const aMemberWhoseKeyARowAnotherReadFindsHoldsBorrowsAtThatRowsFieldLearnedOrHeldAndFaultsNowhere =
	property.exhaust(finite(caseGen), {
		box: "the learner's sitting, its session under Learner or outside every unit, and the operator's permission",
		needs: {},
		situations: [],
		check: () => (c: Case) =>
			Effect.sync(() => {
				const proofs = proofsOf(c)
				assert.ok(proofs.length > 0, "the member's flight sends a statement")
				for (const proof of proofs) {
					assert.deepEqual(proof.faults, [], "the member's faults")
					assert.deepEqual(proof.borrows, expectedOf(c), "the member's borrows")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the borrows the rules restate over each case: Learner exclusive at the child, Package shared at the session's package held under Learner or learned, none for the operator's permission"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original:
					'\t\t\treturn field === undefined ? undefined : { kind: "column", of: named, field }\n',
				replacement: "\t\t\treturn undefined\n",
				why: "A column of another stored table's source binds nothing, as before the stored provenance: the package's documents are read at no key the learner holds, rows of no one group."
			},
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original:
					'\t\treturn field === undefined ? undefined : { kind: "column", of: source, field }\n',
				replacement: "\t\treturn undefined\n",
				why: "A derived table's column carries no stored table's column: the session's package, projected through the derived tables a match lowers to, binds the documents' read to the derived table's rows, one group per row."
			},
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original:
					'\tif (e.kind === "literal") {\n\t\treturn { kind: "constant", spelled: printExpr(e) }\n\t}\n',
				replacement: "",
				why: "A literal binds nothing: the grant's program \"assign\" leaves its whole key unbound, so the operator's permission reads rows of no one group (MR-OPS-GAPS G5)."
			},
			{
				file: "packages/engine/src/analysis/isolation/borrows.ts",
				original: "\t\t!bound.every((b) => onceAt(at, reads, b.by))\n",
				replacement: "\t\ttrue\n",
				why: "No read outside every unit is an immutable fact at a learned key: the grant read at the account's person is a read without a borrow (MR-OPS-GAPS G5)."
			},
			{
				file: "packages/engine/src/analysis/isolation/borrows.ts",
				original: "\t\treturn place.fields.every((f) => key.some((k) => k.field === f.field))\n",
				replacement: "\t\treturn false\n",
				why: "No lookup is held: the learner's session, a row of the unit it borrows, keys no package, so the package's documents are read at no key."
			},
			{
				file: "packages/engine/src/analysis/isolation/borrows.ts",
				original: '\treturn at.changed.has(relation) || lookup.read.base !== "positive"\n',
				replacement: '\treturn at.changed.has(relation) || lookup.read.mode !== "positive"\n',
				why: "A learned lookup judged by its raw mode: the session read again beneath the insert's refusal probe keys no package, the documents' read beneath it is unsealed, the probe is no longer neutral and the session's read there an absence (the first draft of this landing, red on the session outside every unit)."
			}
		]
	})
