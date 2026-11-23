/**
 * A member's copy of its owner's field reads the owner's rows as its family statement holds them (write/frontend/
 * schedule.ts CopySource, HeldSource): a stamp, a field an insert computes from the call (ChangeSet.insertComputed) or
 * a head stamps, is taken once in its stratum, by the statement that writes the rows carrying it (ir/instant.ts
 * stampText), so a statement that appends the owner reads the owner's rows as it appends them, its stamps among them,
 * and any other reads them as the host sends them, without a stamp (write/family/additions.ts sentOf): a copy whose
 * group or column another statement stamps reads the owner's table once that statement has run (`drawn`).
 *
 * The box, exhausted: Node, a tree's nodes keyed (pkg, path, start) with (pkg, path) its root fields or a plain relation
 * keyed so, the owner of a counted family of Attr carrying its node's key, inserted computing `pkg` (its key, the
 * tree's root field every member carries), `note` (a payload field) or nothing; Attr inserted apart computing `pkg`,
 * stating it, or nested under the node two deep (owner-copies.fixtures.ts copyingOf), so its statement is the node's;
 * each Attr copying its node's `tag`, or not. pantry's insertWrite taking `package` as its one scalar parameter is the
 * tree, its key computed, Attr apart computing it too.
 *
 * Property, per case: the write compiles, served as `grizzle generate` drafts it, every held copy reading owner rows
 * that hold what it copies (write/family/additions.ts appendScan); and no family statement draws a copy from the table
 * of an owner it appends itself, whose rows it cannot read there. Oracle: the rule, each copy reading rows that hold
 * what it copies, a stamped column only in the statement that stamps it. Kills: every owner read as its statement
 * appended it, its stamps held by a statement that never takes them, which dies where the write compiles
 * (PANTRY-WRITERS, `the column pkg of r10`); and every owner read as the host sends it, so a nested member's copy of its
 * stamped owner is drawn from the table of the owner its own statement inserts.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"
import {
	type CopyFeature,
	copyFeatures,
	copyGen,
	copyingOf
} from "#test/unit/write/owner-copies.fixtures.ts"

/** A member's copy of its owner's field reads the owner's rows as its family statement holds them, a stamp only where that statement takes it. */
export const aMembersCopyOfItsOwnersFieldReadsTheOwnersRowsAsItsFamilyStatementHoldsThemAStampOnlyWhereThatStatementTakesIt =
	property.exhaust(finite(copyGen), {
		needs: {},
		situations: [
			"a tree owner",
			"a plain owner",
			"a key field computed",
			"a payload field computed",
			"nothing computed",
			"members computing their group field",
			"members stating it",
			"members nested under the owner",
			"a copy held",
			"a copy drawn",
			"no copy"
		] satisfies ReadonlyArray<Reached<CopyFeature>>,
		check: (_, k: Case<CopyFeature>) => (c) =>
			Effect.sync(() => {
				k.noteAll(copyFeatures(c))
				const copying = copyingOf(c)
				const artifacts = succeeded(
					testArtifacts(copying.schema, testCompile),
					"the case's schema compiles"
				)
				const value = copying.changeSet()
				const program = succeeded(
					compileWrite(checking(copying.schema), descOf(value), realityWrite(artifacts)),
					"the write compiles"
				)
				for (const stratum of program.frontend.ir.strata) {
					for (const { node } of stratum.family) {
						if (node.kind !== "additions" || node.appends !== "rows") {
							continue
						}
						for (const copy of node.ownerCopies) {
							k.note(copy.source === "held" ? "a copy held" : "a copy drawn")
							assert.ok(
								copy.source !== "drawn" || !node.members.includes(copy.owner),
								`${copy.column}, a copy of ${copy.owner}, is drawn by no statement that appends ${copy.owner}`
							)
						}
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the rule: a copy reads its owner's rows as its family statement holds them, a stamped column only in the statement that stamps it (ir/instant.ts stampText)"
		},
		box: "a tree or plain owner computing its key field, a payload field or nothing; its counted members inserted apart computing their group field, stating it, or nested two deep; copying the owner's tag or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original:
					"\t\t\tconst sources: ReadonlyArray<OwnerSourceRead> = statement.includes(owner)\n",
				replacement: "\t\t\tconst sources: ReadonlyArray<OwnerSourceRead> = true\n",
				why: "Every owner is read as if its statement appended it, its stamps held by the statement of a member inserted apart, which never takes them: the tree's nested rows read as the host sends them hold no pkg, and the append scan dies where the write compiles (PANTRY-WRITERS at fa7560c88, `grizzle internal invariant: the column pkg of r10`)."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original:
					"\t\t\tconst sources: ReadonlyArray<OwnerSourceRead> = statement.includes(owner)\n",
				replacement: "\t\t\tconst sources: ReadonlyArray<OwnerSourceRead> = false\n",
				why: "Every owner is read as the host sends it, so the tree's root slot, which no statement stamps, holds no pkg, and a nested member's copy of its owner is drawn from the table of the owner its own statement inserts, which it cannot read there."
			}
		]
	})
