/**
 * Sub-queries shared by the statements of one program and repeated inside one statement (shapes/share/statements.ts):
 * the carried sub-queries of a stratum's statements, the MATERIALIZED CTEs of one statement, and the attachment
 * parts of a program's statement it feeds from an earlier one (R25). The first two rules are exhausted over the
 * number of copies:
 *
 * - n statements each reading `pick` carry it once, its every copy read through the carrier, exactly when n is more
 *   than one; the highest shared sub-query is chosen, so `first`, which pick reads, is never carried beside it;
 * - a statement reading r copies of an unbounded union computes it once as a CTE exactly when r is more than one;
 * - an attachment of a parent is fed the rows of the first earlier attachment part of that parent computing its
 *   sub-query, and every other is a part of its own, the parts in the order the program holds them.
 *
 * Oracle: each rule's statement as a checker (a specification): the share keys and copies the statements read, and
 * the part each attachment reads computed from the filters in program order.
 *
 * Features: carried and inline; shared and inline; fed and sent.
 */

import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { agree, exact, set, structuralHash } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { shareKey } from "#compiler/lower/shapes/share/index.ts"
import {
	planStatementShares,
	ShareIndex,
	statementCtes
} from "#compiler/lower/shapes/share/statements.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import {
	attachedJobs,
	attachmentFilters,
	expectedAnswers,
	Jobs,
	program,
	repeated
} from "#test/unit/lower/shapes/share-statements.fixtures.ts"
import { present } from "#test/unit/lower/support.ts"

/** Sub-queries carried across a stratum's statements carry pick once, every copy through the carrier, exactly when enough statements read it. */
export const subQueriesCarriedAcrossAStratumsStatementsCarryPickOnceEveryCopyThroughTheCarrierExactlyWhenEnoughStatementsReadIt =
	property.exhaust(finite(int(1, 4)), {
		needs: {},
		situations: ["carried", "inline"] satisfies ReadonlyArray<Reached<"carried" | "inline">>,
		check: (_, c: Case<"carried" | "inline">) => (statements) =>
			Effect.sync(() => {
				const p = program(statements)
				const shares = succeeded(planStatementShares(new ShareIndex(p.dag), p.roots))
				if (statements < 2) {
					assert.deepEqual(shares, [])
					c.note("inline")
					return
				}
				const [pick] = p.picks
				assert.equal(shares.length, 1)
				const share = present(shares[0], "the carried share")
				assert.equal(share.key, succeeded(shareKey(p.dag, present(pick, "a pick"))))
				unorderedEqual([...share.copies], p.picks)
				c.note("carried")
			}),
		oracle: {
			kind: "specification",
			name: "pick carried once, every copy through the carrier, exactly when more than one statement reads it"
		},
		box: "one to four statements each reading pick",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original: "\t\t\t.filter((group) => statementsOf(group) >= 2)\n",
				replacement: "\t\t\t.filter((group) => statementsOf(group) >= 4)\n",
				why: "A sub-query is carried only when more than three statements read it; the carried search fails."
			}
		]
	})

/** Sub-queries repeated inside one statement compute an unbounded sub-query once exactly when it is read more than once. */
export const subQueriesRepeatedInsideOneStatementComputeAnUnboundedSubQueryOnceExactlyWhenItIsReadMoreThanOnce =
	property.exhaust(finite(int(1, 4)), {
		needs: {},
		situations: ["shared", "inline"] satisfies ReadonlyArray<Reached<"shared" | "inline">>,
		check: (_, c: Case<"shared" | "inline">) => (reads) =>
			Effect.gen(function* () {
				const { built, copies } = repeated(reads)
				const ctes = statementCtes(new ShareIndex(built.dag), built.dag.roots[0], () => false)
				const expected =
					reads > 1 ? [succeeded(shareKey(built.dag, present(copies[0], "a copy")))] : []
				yield* agree(
					[
						["the share keys the statement computes once", [...new Set(ctes.values())]],
						["the copies' share key", expected]
					],
					set(structuralHash, exact)
				)
				unorderedEqual([...ctes.keys()], reads > 1 ? Arr.map(copies, (copy) => copy.id) : [])
				c.note(reads > 1 ? "shared" : "inline")
			}),
		oracle: {
			kind: "specification",
			name: "the union computed once as a CTE exactly when it is read more than once"
		},
		box: "one statement reading one to four copies of an unbounded union",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original: "\t\t\tif ((byKey.get(key) ?? 0) < 2) {",
				replacement: "\t\t\tif ((byKey.get(key) ?? 0) < 4) {",
				why: "A statement computes a sub-query once as a CTE only when it reads it more than three times; the CTE search fails."
			}
		]
	})

/** Attachment parts fed from an earlier one feed a later attachment from the first earlier part computing its sub-query, and place every other. */
export const attachmentPartsFedFromAnEarlierOneFeedALaterAttachmentFromTheFirstEarlierPartComputingItsSubQueryAndPlaceEveryOther =
	property.exhaust(attachmentFilters, {
		needs: {},
		situations: ["fed", "sent"] satisfies ReadonlyArray<Reached<"fed" | "sent">>,
		check: (_, c: Case<"fed" | "sent">) => (filters) =>
			Effect.sync(() => {
				const optimized = succeeded(compileTemplate(attachedJobs(filters), Jobs, testCompile))
					.programs.optimized
				const [main] = optimized.roots
				const filterOf = new Map<string, number>(
					Arr.map(filters, (filter, i) => [`jobs${i}`, filter])
				)
				assert.equal(main.attachments.length, filters.length)
				const answers: ReadonlyArray<number> = [
					main.statement.answer,
					...Arr.map(main.attachments, (a) => a.statement.answer)
				]
				assert.deepEqual(
					answers,
					expectedAnswers(
						Arr.map(main.attachments, (a) =>
							present(filterOf.get(a.attach.name), `the filter of ${a.attach.name}`)
						)
					)
				)
				const placed = new Set<number>()
				for (const answer of Arr.drop(answers, 1)) {
					c.note(placed.has(answer) ? "fed" : "sent")
					placed.add(answer)
				}
			}),
		oracle: {
			kind: "specification",
			name: "each attachment fed from the first earlier part of its filter, every other a part of its own"
		},
		box: "one to three attachments of one parent, each of three filters",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/index.ts",
				original: "\t\t\tconst feeder = siblings.find((s) => this.#sameRows(s, attach, parentKey))",
				replacement: "\t\t\tconst feeder = siblings.find(() => false)",
				why: "No attachment part is fed from an earlier one, each placed as a part of its own; the feeding search fails."
			}
		]
	})
