/**
 * A column a rule's head fixes at a bare literal, read after navigation inlines the rule (analysis/theory/navigate.ts):
 * the literal stands for the column, so it is typed at the column's descriptor wherever the rule is inlined
 * (analysis/theory/leaves.ts atColumn, analysis/theory/columns.ts), and a substitution that puts it where a term stands
 * puts a term of the column's type there. "A literal never stands first" is the user's spelling's rule (the builders'),
 * never a refusal of a term the compiler substituted.
 *
 * Over every use of such a column below a writer's probes (literal-heads.fixtures.ts uses), each an installation whose
 * derived relation reads a query fixing `scope` at 0n and `variable` at "numAttempts": a selection comparing the
 * column first with a literal or equating it with a column, a join of it to a stored column and a check comparing it
 * first each compile. The literal's type is its column's, never the type of what it meets: a selection equating the
 * text column `variable` with a bigint column is a TypeScript error at its spelling, as it is for any text column, and
 * compiled, the two types refuse it ("text never meets bigint"), never the literal's place.
 *
 * Oracle: the installation's own compile, against the rule the README states for a literal (it takes the type of the
 * term it stands for or meets, and only the user's spelling puts a term first).
 *
 * Features: each use.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { installed, type Use, uses } from "#test/unit/analysis/literal-heads.fixtures.ts"

/** A column a rule's head fixes at a literal compiles wherever a navigated rule reads it. */
export const aColumnARulesHeadFixesAtALiteralCompilesWhereverANavigatedRuleReadsIt =
	property.exhaust(
		finite((source) => source.draw(element(uses))),
		{
			box: "each use of a literal-headed column below a writer's probes",
			needs: {},
			situations: uses satisfies ReadonlyArray<Reached<Use>>,
			check: (_, c: Case<Use>) => (use) =>
				Effect.sync(() => {
					c.note(use)
					const compiled = installed(use)
					assert.ok(compiled.ok, compiled.ok ? "compiled" : compiled.error.message)
				}),
			oracle: {
				kind: "specification",
				name: "README's rule for a literal: it takes the type of the term it stands for or meets; only the user's spelling puts a term first"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/leaves.ts",
					original: "\tisBare(e) ? typedAs(e, columns(column)) : e\n",
					replacement: "\te\n",
					why: "A head literal navigation substitutes stays bare, so `scope < 5` over the rule fixing scope at 0n is `0 < 5`, refused as a literal standing first."
				},
				{
					file: "packages/engine/src/analysis/theory/navigate.ts",
					original:
						"\t\t\t\twhere.push(equal(lift(atColumn(head, field, columns)), atColumn(outer, field, columns)))\n",
					replacement: "\t\t\t\twhere.push(equal(lift(head), atColumn(outer, field, columns)))\n",
					why: "An inlined import's head literal is equated bare with the variable its match binds, which the navigation then replaces by it, so a selection reading the variable first reads a bare literal first."
				}
			]
		}
	)
