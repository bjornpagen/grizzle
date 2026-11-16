/**
 * A read's per-execution form is chosen by the count of the relation parameter its correlated take reads, whatever the
 * parameter is named (R20).
 *
 * A take correlated through `bind` to a relation parameter's facts is lowered LATERAL at or below lateralParentMax
 * distinct facts and in its whole-relation form above, the template's variant. The choice's input is the relation
 * parameter itself, never a name: a parameter named like the page's own size, a page placeholder or any other spelling
 * the runtime might once have branched on compiles, and its count alone selects the form. The names are the kernel's
 * parameter dictionary (test/support/kernel/dict.ts), each admitted by the production name validator.
 *
 * Oracle: the choice's contract, a specification: the whole-relation form exactly past lateralParentMax facts.
 *
 * Features: a relation parameter at lateralParentMax facts, and one past it, each under every name.
 */

import { lateralParentMax } from "@bjornpagen/grizzle-engine/lower/shapes/index"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Result } from "effect"
import { formFor } from "#adapter/reader/execution.ts"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import { readExceeds, readProgram } from "#adapter/reader/run.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { servedSource } from "#compiler/served/read.ts"
import { servedSpine } from "#compiler/served/spine.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { parameterNames } from "#test/support/kernel/dict.ts"
import { accounts, type Count, namedAccounts } from "#test/unit/page/choice-input.fixtures.ts"

/** A read's per-execution choice runs the whole-relation form exactly when the named relation parameter holds more than lateralParentMax facts. */
export const aReadsPerExecutionChoiceRunsTheWholeRelationFormExactlyWhenTheNamedRelationParameterHoldsMoreThanLateralParentMaxFacts =
	property.exhaust(
		finite(
			(source) =>
				[
					source.draw(element(nonEmpty(parameterNames, "the parameter names"))),
					source.draw(element([lateralParentMax, lateralParentMax + 1]))
				] as const
		),
		{
			needs: {},
			situations: ["at lateralParentMax", "one past lateralParentMax"] satisfies ReadonlyArray<
				Reached<Count>
			>,
			check:
				(_, c: Case<Count>) =>
				([name, count]) =>
					Effect.sync(() => {
						c.note(count > lateralParentMax ? "one past lateralParentMax" : "at lateralParentMax")
						const read = namedAccounts(name)
						const template = succeeded(compileTemplate(read, undefined, testCompile))
						const { desc } = succeeded(queryInput(read))
						const program = readProgram(
							servedSource(template.run),
							servedSpine(desc),
							emptyCodebook
						)
						const facts = accounts(count)
						/** The template declares the relation parameter alone: firstTwo's `acct` is bound to the account variable. */
						const inputs = Result.getOrThrow(
							executionInputs(paramCodecs(template.params, emptyCodebook), { [name]: facts })
						)
						const forms = program.run.forms
						assert.ok(forms.kind === "chosen", name)
						assert.equal(
							formFor(program.run, readExceeds(inputs)) === forms.large,
							count > lateralParentMax,
							name
						)
					}),
			oracle: {
				kind: "specification",
				name: "the whole-relation form exactly past lateralParentMax facts"
			},
			box: "every name of the parameter dictionary, at lateralParentMax facts and one past",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/runtime/lower/take.ts",
					original: "): boolean => distinctCount > choice.threshold",
					replacement: "): boolean => distinctCount >= choice.threshold",
					why: "The whole-relation form is chosen at lateralParentMax facts, not past them (runtime/lower/take.ts runsLargeForm); the property fails."
				}
			]
		}
	)
