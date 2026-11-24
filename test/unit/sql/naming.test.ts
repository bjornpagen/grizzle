/**
 * Outermost-only public renaming (sql/naming.ts renameToPublicHeading), over generated queries.
 *
 * The rename gives the statement's own output the public heading, position by position, in every arm of a set
 * operation and in an ORDER BY that names the outputs, and touches nothing nested: so the renamed query passes both
 * audits, whose naming rule refuses any nested name that is not a generated c<n>, and its output names are the heading.
 * A heading of another width than the output is refused. Each query is also renamed with its set operation's first
 * arm unaliased where it passes columns through: PostgreSQL names such an output after its column, and an ORDER BY
 * names it so. The headings are named awkward spellings: a keyword, a space, a quote, a capital, a generated name, a
 * letter outside ASCII.
 *
 * Oracle: both SQL audits and the output names PostgreSQL derives (bodyPositionNames), a specification. Features: a
 * core, a set operation, a passthrough arm, a heading of the wrong width. Kept: a UNION of two one-column cores.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { bodyPositionNames } from "#compiler/sql/ast.ts"
import { renameToPublicHeading } from "#compiler/sql/naming.ts"
import {
	admitted,
	headings,
	passthrough,
	renamedGen,
	type RenameFeature
} from "#test/unit/sql/naming.fixtures.ts"

/**
 * Outermost-only public renaming names the output by the heading, in every arm and its ORDER BY, and nothing nested.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/sql/naming.test.ts:142 at 8cad5bce, its runs and its coverage's cases).
 */
export const outermostOnlyPublicRenamingNamesTheOutputByTheHeadingInEveryArmAndItsORDERBYAndNothingNested =
	property.explore(renamedGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: ["core", "set operation", "passthrough arm", "wrong width"] satisfies ReadonlyArray<
			Reached<RenameFeature>
		>,
		check:
			(_, c: Case<RenameFeature>) =>
			([statement, offset]) =>
				Effect.sync(() => {
					if (statement.kind !== "select") {
						return
					}
					const queries = [
						statement,
						...Arr.flatMap([passthrough(statement)], (p) => (p === undefined ? [] : [p]))
					]
					for (const q of queries) {
						admitted(q)
						const width = bodyPositionNames(q.body).length
						const heading = [...headings.slice(offset), ...headings.slice(0, offset)].slice(
							0,
							width
						)
						assert.equal(
							heading.length,
							width,
							"the heading dictionary holds every generated width"
						)
						const renamed = renameToPublicHeading(q, heading)
						if (!renamed.ok) {
							assert.fail(`refused a heading of the output's width: ${renamed.error.message}`)
						}
						admitted(renamed.value)
						assert.deepEqual(bodyPositionNames(renamed.value.body), heading)
						for (const wrong of [heading.slice(1), [...heading, "extra"]]) {
							const refused = renameToPublicHeading(q, wrong)
							assert.equal(!refused.ok && refused.error.reason._tag, "MalformedDescription")
							c.note("wrong width")
						}
						c.note(q.body.kind === "core" ? "core" : "set operation")
						if (q !== statement) {
							c.note("passthrough arm")
						}
					}
				}),
		oracle: {
			kind: "specification",
			name: "both SQL audits, and the output names PostgreSQL derives equal to the heading"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/sql/naming.test.ts#outermostOnlyPublicRenamingNamesTheOutputByTheHeadingInEveryArmAndItsORDERBYAndNothingNested:-:1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason: "a UNION of two one-column cores",
				since: "2026-10-29"
			}
		],
		kills: [
			{
				file: "packages/engine/src/sql/naming.ts",
				original: "\t\t\t\t\t\treturn Result.ok(withArms(body, [a, b, ...more]))",
				replacement: "\t\t\t\t\t\treturn Result.ok(withArms(body, [a, second, ...rest]))",
				why: "A set operation's first arm alone is renamed; the search fails."
			}
		]
	})
