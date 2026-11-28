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
import { callCounts } from "#test/support/kernel/calls.ts"
import {
	installed,
	installedReaders,
	type Use,
	uses
} from "#test/unit/analysis/literal-heads.fixtures.ts"

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
					file: "packages/engine/src/physical/ddl/rules.ts",
					original: "\t\t\tdefinedAt(b.columns, unit.definitionOf),\n",
					replacement: "\t\t\tb.columns,\n",
					why: "A whole rule's statement over its units reads the heading of the walked copy of the union it selects at a literal, checked alone, where the copy's recursive import reads the document's channel, which only its import types: refused as a channel bound to a column, as pantry's assembledPartRows was (tests.ts:1040)."
				},
				{
					file: "packages/engine/src/analysis/theory/navigate.ts",
					original:
						"\t\t\t\t\tconst equation = equal(\n\t\t\t\t\t\tlift(atColumn(head, field, columns)),\n",
					replacement: "\t\t\t\t\tconst equation = equal(\n\t\t\t\t\t\tlift(head),\n",
					why: "An inlined import's head literal is equated bare with the variable its match binds, which the navigation then replaces by it, so a selection reading the variable first reads a bare literal first."
				}
			]
		}
	)

/** The one check of a query's heading a column type reads (analysis/theory/columns.ts checkedHeading). */
const headingChecks = {
	check: { file: "packages/engine/src/analysis/theory/columns.ts", name: "checkedHeading" }
} as const

/**
 * An import's heading is checked once per installation however many statements navigation reads it in: the
 * installation holds one QueryColumns (physical/ddl/context.ts InstallBuilder.columns), every law reads the import in
 * its violation as one live query (analysis/theory/query.ts liveReading), and a whole rule's statement over its units
 * reads a walked copy's heading at the definition it was walked from (WholeRule `definitionOf`), so every statement the
 * judge navigates reads the one import's, and three checked derived relations reading `fixed`, each with its own judge
 * statements that inline it and type its head literal at its heading, check its heading as often as one does.
 */
export const anImportsHeadingIsCheckedOncePerInstallationHoweverManyProbesNavigateIt =
	property.exhaust(
		finite((source) => source.draw(element(["one reader", "three readers"] as const))),
		{
			box: "an installation of one and of three derived relations reading a query whose head fixes a literal",
			needs: {},
			situations: ["one reader", "three readers"] satisfies ReadonlyArray<
				Reached<"one reader" | "three readers">
			>,
			check: (_, c: Case<"one reader" | "three readers">) => (readers) =>
				Effect.gen(function* () {
					c.note(readers)
					const [one, once] = yield* callCounts(
						Effect.sync(() => installedReaders("one reader")),
						headingChecks
					)
					const [read, counted] = yield* callCounts(
						Effect.sync(() => installedReaders(readers)),
						headingChecks
					)
					assert.ok(one.ok && read.ok, "both installations compile")
					assert.ok(once.check > 0, "the import's heading is checked")
					assert.ok(
						counted.check === once.check,
						`${readers} check the import's heading ${counted.check} times, one reader ${once.check}`
					)
				}),
			oracle: {
				kind: "specification",
				name: "work counted: the heading checks of one installation"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/physical/ddl/context.ts",
					original:
						'\t\tthis.columns = queryColumns(input.checked, SourceLoc("the installation", []))\n',
					replacement:
						'\t\tthis.columns = { desc: (query) => queryColumns(input.checked, SourceLoc("the installation", [])).desc(query), field: (relation, column) => queryColumns(input.checked, SourceLoc("the installation", [])).field(relation, column) }\n',
					why: "Each statement navigation reads gets a QueryColumns of its own, so the import's heading is checked again for every probe that inlines it: three readers check it more often than one."
				},
				{
					file: "packages/engine/src/analysis/theory/query.ts",
					original: "\t\t\tconst found = known.get(query)\n",
					replacement: "\t\t\tconst found = known.get({ ...query })\n",
					why: "Each law reads its own live copy of every query its violation imports, so the judge's statements of three laws meet three imports, each one's heading checked apart."
				}
			]
		}
	)

/** The one copy of a query a walk makes (analysis/theory/unit.ts copied). */
const walkCopies = {
	copy: { file: "packages/engine/src/analysis/theory/unit.ts", name: "copied" }
} as const

/**
 * A whole rule's walk copies only the queries it changes: over checked readers of a query of a stored relation, each
 * law's walk per unit copies its violation, whose outermost rule it reads per unit, and nothing the violation imports,
 * neither the reader's live definition nor the query, which it leaves as they were (analysis/theory/unit.ts Walked), so
 * an installation of one reader makes one copy and of three readers three, where a walk that copied all it read made a
 * copy of every query below each violation, and of each again in every walk that decides a unit.
 */
export const aWholeRulesWalkCopiesOnlyTheQueriesItChanges = property.exhaust(
	finite((source) => source.draw(element(["one reader", "three readers"] as const))),
	{
		box: "an installation of one and of three checked derived relations reading a query of a stored relation",
		needs: {},
		situations: ["one reader", "three readers"] satisfies ReadonlyArray<
			Reached<"one reader" | "three readers">
		>,
		check: (_, c: Case<"one reader" | "three readers">) => (readers) =>
			Effect.gen(function* () {
				c.note(readers)
				const [read, counted] = yield* callCounts(
					Effect.sync(() => installedReaders(readers)),
					walkCopies
				)
				assert.ok(read.ok, "the installation compiles")
				const laws = readers === "one reader" ? 1 : 3
				assert.ok(
					counted.copy === laws,
					`${readers} make ${counted.copy} copies of a query in their walks, one per law, ${laws}, expected`
				)
			}),
		oracle: { kind: "specification", name: "work counted: the queries a whole rule's walks copy" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\tquery: read.stage === query.stage ? query : copied(query, read.stage, w),\n",
				replacement: "\t\tquery: copied(query, read.stage, w),\n",
				why: "The walk copies every query it reads, changed or not: the reader's live definition and the query below each violation, in each law's walk per unit and in every walk that decides its unit, more copies than laws."
			}
		]
	}
)
