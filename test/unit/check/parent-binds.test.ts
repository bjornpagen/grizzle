/**
 * An attachment child's import whose parameter is bound to a parent variable is formed into a region its lowering
 * places, whichever match of the child's rule binds that variable (check/checker.ts RuleCheck #bindValue): a bind map
 * reads a parent variable as the region's variable where the region holds its value before the import's source, a
 * match before it binding it or none, the region correlating it to its parent column; where the import's own match or
 * a later one binds it, as the parent's own column, an outer reference the attachment's statement carries in its parent
 * key. Read through the region's variable there, the source waited on the occurrence it is: edullm's marks attachments
 * (judged.ts marksOf, `match(reads.file.bind({ sittings: sittingOf.bind({ child: marked.child, … }) }), { child:
 * marked.child, … })`), read back by answerTestItem, were refused "an order of the region's occurrences in which every
 * correlated source follows what it reads" (lower/conservative/match-region regionParts), and generate with them.
 *
 * The box, exhausted: which match binds the parent variable `child` the import's parameter is bound to (the import's
 * own, an earlier one, a later one, none), how it is bound (a scalar parameter, or a relation parameter bound to the
 * rows of a query whose own parameter is, edullm's shape), and where the attachment is read (a query, or a ChangeSet's
 * read-back). Each case reads each attempt with the marks of its child's item (parent-binds.fixtures.ts attemptsOf). Its
 * first case, the import's own match binding the parent variable its scalar parameter is bound to, read as a query, is
 * the two-relation repro of edullm's refusal, refused at its lowering before.
 *
 * Property: every region the checker forms for the case's query has an order to place, its occurrences in the order
 * of its matches, each reading only what an occurrence before it binds, what the region correlates, or what lies
 * outside it; and the case compiles, a query under both lowerings, both audited (test/support/compile.ts
 * compileTemplate), a read-back as a write. What it reads is the pg property's (test/pg/reads/parent-binds).
 * Oracle: specification, regionParts' placement, a correlated source after what it reads. Kill: the parent variable
 * read as the region's variable wherever a match binds it, under which the import's own match leaves its region no
 * order and a later one none in its matches' order.
 *
 * Features: each binder, form and reader.
 */

import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { queryInput } from "#compiler/program/input.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import {
	attemptsOf,
	bindCaseGen,
	ParentBinds,
	readBackOf,
	type Situation,
	situationOf,
	situations,
	unplaceableRegions
} from "#test/support/unit/check/parent-binds.fixtures.ts"
import { descOf } from "#test/support/unit/write/changeset/fixtures.ts"

/** ParentBinds' artifacts, which every read-back compiles against. */
const artifacts = succeeded(testArtifacts(ParentBinds, testCompile), "ParentBinds' artifacts")

/**
 * An attachment child's import bound to a parent variable forms a region its lowering places, whichever match binds
 * the variable, and compiles.
 */
export const anAttachmentChildsImportBoundToAParentVariableFormsARegionItsLoweringPlacesWhicheverMatchBindsTheVariable =
	property.exhaust(finite(bindCaseGen), {
		needs: {},
		situations: nonEmpty(situations) satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, k: Case<Situation>) => (c) =>
			Effect.sync(() => {
				const situation = situationOf(c)
				k.note(situation)
				const read = attemptsOf(c.binder, c.form)
				const checked = succeeded(
					checkQuery(
						checking(ParentBinds),
						succeeded(queryInput(read), "a query value").desc,
						checkOptions("query")
					),
					`${situation}: checked`
				)
				assert.deepEqual(
					unplaceableRegions(checked.dag),
					[],
					`${situation}: every region has its occurrences in an order to place`
				)
				if (c.reader === "a query") {
					succeeded(
						compileTemplate(read, ParentBinds, testCompile),
						`${situation}: compiles under both lowerings`
					)
					return
				}
				succeeded(
					compileWrite(
						checking(ParentBinds),
						descOf(readBackOf(c.binder, c.form)),
						realityWrite(artifacts)
					),
					`${situation}: compiles as a write`
				)
			}),
		oracle: {
			kind: "specification",
			name: "regionParts' placement: each occurrence after what its source reads, in its region's order"
		},
		box: "the match binding the parent variable an attachment child's import is bound to (its own, an earlier, a later, none), the binding (a scalar parameter, a relation parameter's rows), the reader (a query, a ChangeSet's read-back)",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: '\t\t\treturn { kind: "column", ...slot.outer, node: slot.head }\n',
				replacement: "\t\t\treturn this.#slotValue(slot, node)\n",
				why: "A bind map reads a parent variable as the region's variable, a match binding it or not, so the import's own match reads the variable only it binds, its region has no order and the lowering refuses it, and a later match's binding is read by the import before it."
			}
		]
	})
