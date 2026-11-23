/**
 * A member's copy of its owner's field reads the owner's rows as its family statement holds them (write/frontend/
 * schedule.ts CopySource, HeldSource), and a counted family's fresh groups are drawn on the host from the rows it holds
 * (runtime/write/bind.ts freshOwners, write/frontend/compile.ts FreshFill): a stamp, a field an insert computes from the
 * call (ChangeSet.insertAllComputed) or a head stamps, is taken once in its stratum, by the statement that writes the rows
 * carrying it (ir/instant.ts stampText), so no row the host holds holds it. A statement that appends the owner reads the
 * owner's rows as it appends them, its stamps among them, and any other as the host sends them, without a stamp: a copy
 * whose group or column another statement stamps reads the owner's table once that statement has run (`drawn`). The
 * host matches a member to its fresh owner by the group fields both hold, and a group field both sides fill with one
 * value of the call, the same term of its parameters, is a unit every row of the call shares, which the host leaves to
 * the statements; a group field one side computes and the other states is refused where the write compiles, since the
 * host could not tell which owner a member names.
 *
 * The box, exhausted: Node, a tree's nodes keyed (pkg, path, start) with (pkg, path) its root fields or a plain relation
 * keyed so, the owner of a counted family of Attr carrying its node's key, inserted computing `pkg` (its key, the
 * tree's root field every member carries), `note` (a payload field) or nothing; Attr inserted apart computing `pkg`,
 * stating it, or nested under the node two deep (owner-copies.fixtures.ts copyingOf), so its statement is the node's;
 * each Attr copying its node's `tag`, or not. pantry's insertWrite taking `package` as its one scalar parameter is the
 * tree, its key computed, Attr apart computing it too. Its database half, every call's rows as stored, is
 * test/pg/write/owner-copies.
 *
 * Property, per case: the write is refused as the rule says (owner-copies.fixtures.ts verdictOf); or it compiles, served
 * as `grizzle generate` drafts it, every held copy reading owner rows that hold what it copies (write/family/
 * additions.ts appendScan), no family statement drawing a copy from the table of an owner it appends itself, whose rows
 * it cannot read there; and the call binds, every placeholder of every statement one the host sends rows for. Oracle:
 * the rule, each copy and each fresh group read from rows that hold what they read, a stamped column only in the
 * statement that stamps it. Kills: every owner read as its statement appended it, its stamps held by a statement that
 * never takes them, which dies where the write compiles (PANTRY-WRITERS, `the column pkg of r10`); every owner read as
 * the host sends it, so a nested member's copy of its stamped owner is drawn from the table of the owner its own
 * statement inserts; the host's nested rows read with their stamped columns, which no nested row sends; the host
 * matching members to their owners by every group field, a computed one among them, which no row it holds holds; and a
 * group field one side computes and the other states left unrefused, which the host cannot match.
 */

import { assert, assertVariant } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf } from "#test/unit/write/changeset/fixtures.ts"
import {
	type CopyFeature,
	copyFeatures,
	copyGen,
	copyingOf,
	verdictOf
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
			"no copy",
			"a write refused"
		] satisfies ReadonlyArray<Reached<CopyFeature>>,
		check: (_, k: Case<CopyFeature>) => (c) =>
			Effect.gen(function* () {
				k.noteAll(copyFeatures(c))
				const copying = copyingOf(c, "Copies")
				const artifacts = succeeded(
					testArtifacts(copying.schema, testCompile),
					"the case's schema compiles"
				)
				const value = copying.changeSet("changeSet")
				const compiled = compileWrite(
					checking(copying.schema),
					descOf(value),
					realityWrite(artifacts)
				)
				if (verdictOf(c) === "refused") {
					k.note("a write refused")
					refused(
						compiled,
						"UnsupportedOperation",
						"a group field one side computes and the other states, which the host cannot match"
					)
					return
				}
				const program = succeeded(compiled, "the write compiles")
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
				const members = yield* collectInputs(program.binding.groups, parsedOf(value).inputs)
				const flight = flightOf(servableWrite(program), program.frontend.codes)
				const bound = succeeded(
					bindWrite(flight, { members, params: copying.params, transport: inForce(bindFrame) }),
					"the call binds"
				)
				assertVariant(bound, "kind", "bound", "the call's facts are lawful")
				for (const statement of flight.statements) {
					succeeded(
						bound.chunks(statement, inForce(bindFrame)),
						`statement ${statement.index}'s placeholders, each one the host sends`
					)
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
			},
			{
				file: "packages/engine/src/write/family/additions.ts",
				original: "\t\tconst rows = nestedRowsCte(w, supply, ctes, relation, sentOf(source))\n",
				replacement: "\t\tconst rows = nestedRowsCte(w, supply, ctes, relation, source)\n",
				why: "The host's nested rows are read with their stamped columns, which no nested row sends: a statement declares a placeholder for the tree's pkg or note, so its placeholders are not what the host sends."
			},
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original:
					'\t\t\t\tconst groupOf = groupReader(ctx, hostGroup(f), "member", ctx.columns(f.member))\n',
				replacement:
					'\t\t\t\tconst groupOf = groupReader(ctx, f, "member", ctx.columns(f.member))\n',
				why: "The host matches the call's members to their fresh owners by every group field, pkg among them, which the members' insert computes and no row the host holds holds, so the bind dies reading it (PANTRY-WRITERS' shape past generate, `a value at position 3 of a row a reader reads`)."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: "\t\t\t\t\t(member === undefined) !== (owner === undefined) ||\n",
				replacement: "\t\t\t\t\tfalse ||\n",
				why: "A group field the owner's insert computes and its members state is left unrefused: the host matches the members by the field they state against owner rows that hold none of it, and the bind dies."
			}
		]
	})
