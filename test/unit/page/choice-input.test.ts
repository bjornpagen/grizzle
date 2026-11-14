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
 *
 * Plant (~/.cache/grizzle-release/BR06/plants): choice-large-at-threshold (the whole-relation form chosen at
 * lateralParentMax facts).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, pipe, Result, String as Str } from "effect"
import { formFor } from "#adapter/reader/execution.ts"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import { readExceeds, readProgram } from "#adapter/reader/run.ts"
import { indices } from "#compiler/core/array.ts"
import { lateralParentMax } from "#compiler/core/limits.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { query, v } from "#compiler/public/query.ts"
import { servedSource } from "#compiler/served/read.ts"
import { servedSpine } from "#compiler/served/spine.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { Account, Task, Work } from "#test/support/fixtures/api/work.ts"
import { parameterNames } from "#test/support/kernel/dict.ts"
import { caseHang } from "#test/support/limits.ts"

/** An account's first two tasks by id. */
const firstTwo = query(Work)
	.rule((r) => {
		const { id } = v(Task, "task")
		return r.match(Task, { id, account: r.param("acct", Task.fields.account) }).find({ id })
	})
	.orderBy(["id", "asc"])
	.take(2)

/** The accounts the relation parameter `name` names, each with its first two tasks. */
const namedAccounts = (name: string) =>
	query(Work).rule((r) => {
		const wanted = r.relation(name, { id: Account.fields.id })
		const { id: account } = v(wanted, "wanted")
		const top = firstTwo.bind({ acct: account })
		const { id } = v(top, "top")
		return r.match(wanted, { id: account }).match(top, { id }).find({ account, id })
	})

/** `count` distinct account facts. */
const accounts = (count: number): ReadonlyArray<{ readonly id: string }> =>
	Arr.map(indices(count), (i) => ({
		id: `00000000-0000-4000-8000-${pipe(i.toString(16), Str.padStart(12, "0"))}`
	}))

type Count = "at lateralParentMax" | "one past lateralParentMax"

describe("a read's per-execution choice", () => {
	it.effect(
		"runs the whole-relation form exactly when the named relation parameter holds more than lateralParentMax facts",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "every name of the parameter dictionary, at lateralParentMax facts and one past",
						oracle: {
							kind: "specification",
							name: "the whole-relation form exactly past lateralParentMax facts"
						},
						suite: "unit/page/choice-input",
						generator: (source) =>
							[
								source.draw(element(nonEmpty(parameterNames, "the parameter names"))),
								source.draw(element([lateralParentMax.value, lateralParentMax.value + 1]))
							] as const,
						literal: Formatter.format,
						coverage: requiredInSpace<Count>(["at lateralParentMax", "one past lateralParentMax"]),
						caseHang,
						concurrency: 1
					},
					([name, count], c) =>
						Effect.sync(() => {
							c.note(
								count > lateralParentMax.value ? "one past lateralParentMax" : "at lateralParentMax"
							)
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
								count > lateralParentMax.value,
								name
							)
						})
				)
			)
	)
})
