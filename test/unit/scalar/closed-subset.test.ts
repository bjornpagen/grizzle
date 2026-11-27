import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
/**
 * A closed id of a subset of its roster (scalar/closed-id.ts readSubset, physical/closed/storage.ts closedSubset): what
 * closedId(R, subset) admits, the subset its field describes, and the CHECK its stored column carries.
 *
 * The box, exhausted over a four-handle roster: no subset; `only` and `except` of every ordered list of distinct
 * handles, each as listed and with each of its handles written again; and what a JavaScript caller can pass that no
 * type of closedId takes: such a list with a handle off the roster at every place in it, an empty list, both keys, a
 * list with no key, a key over a handle that is no list, and two subsets. The oracle is the subset as its statement
 * states it, read here apart from the engine: `only`'s handles, or every handle but `except`'s, in the roster's order,
 * every handle being the whole roster's closed id; a handle written twice and an `except` of every handle refused by
 * the rule, and every untyped value refused as a malformed description. Each admitted field is installed as a
 * relation's column: a field of a subset has exactly one CHECK, holding its column to its subset's codes in the codes
 * the installation drafted, and a field of every handle has none; and a query equates either to every handle of the
 * roster, since a literal compared with a closed id is any of its roster's, whatever its subset.
 */
import { property, type Case } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { closedId } from "#compiler/public/fields.ts"
import { closedIdOf } from "#compiler/schema/relation.ts"
import { throwsRefused } from "#test/support/assert.ts"
import {
	handles,
	installedOf,
	Mark,
	type Statement,
	statedBy,
	statements
} from "#test/unit/scalar/closed-subset.fixtures.ts"

type Feature =
	| "every handle"
	| "a subset"
	| "refused by the rule"
	| "malformed"
	| "listed out of the roster's order"

/** A closed id's subset is the one its statement states, in the roster's order, and its column's CHECK holds it. */
export const aClosedIdsSubsetIsTheOneItsStatementStatesAndItsColumnsCheckHoldsItsCodes =
	property.exhaust(finite(statements), {
		needs: {},
		situations: [
			"every handle",
			"a subset",
			"refused by the rule",
			"malformed",
			"listed out of the roster's order"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (s: Statement) =>
			Effect.sync(() => {
				if (s.door === "untyped") {
					c.note("malformed")
					throwsRefused(
						() => closedIdOf(Mark, s.rest),
						"MalformedDescription",
						"what no type of closedId takes is a malformed description"
					)
					return
				}
				const stated = statedBy(s.subset)
				switch (stated.kind) {
					case "refused":
						c.note("refused by the rule")
						throwsRefused(
							() => closedId(Mark, s.subset),
							"Refused",
							"a handle written twice, or an except of every handle, is refused by the rule"
						)
						return
					case "every": {
						c.note("every handle")
						const installed = installedOf(closedId(Mark, s.subset))
						assert.deepEqual(
							installed.described,
							{ kind: "closedId", roster: "Mark", only: undefined },
							"a closed id of every handle describes no subset"
						)
						assert.deepEqual(installed.checks, [], "and its column carries no subset CHECK")
						assert.deepEqual(installed.compared, handles, "and a query equates it to every handle")
						return
					}
					case "subset": {
						c.note("a subset")
						if (stated.reordered) {
							c.note("listed out of the roster's order")
						}
						const installed = installedOf(closedId(Mark, s.subset))
						assert.deepEqual(
							installed.described,
							{ kind: "closedId", roster: "Mark", only: stated.held },
							"the field describes its subset, in the roster's order"
						)
						assert.deepEqual(
							installed.checks,
							[installed.checkOf(stated.held)],
							"its column carries one CHECK, of its subset's codes"
						)
						assert.deepEqual(
							installed.compared,
							handles,
							"a query equates it to every handle of its roster, whatever its subset"
						)
						return
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the subset as its statement states it: only's handles, or every handle but except's, in the roster's order"
		},
		box: "no subset; only and except of every ordered list of distinct handles of four, as listed and with a handle written twice; and every untyped value: a handle off the roster at every place, an empty list, both keys, no key, no list, two subsets",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original:
					'\tif (v.carrier === "code" && v.only !== undefined) {\n\t\treturn Object.freeze({ ...v, only: undefined })\n\t}\n',
				replacement: "",
				why: "A literal compared with a closed id of a subset adopts the subset, which a handle outside it is no value of: a query equating the field to such a handle is refused, where a literal compared with a closed id is any handle of its roster."
			},
			{
				file: "packages/engine/src/scalar/closed-id.ts",
				original:
					"held.length === roster.handles.length ? undefined : Object.freeze([first, ...rest])",
				replacement: "Object.freeze([first, ...rest])",
				why: "A subset of every handle keeps its list: the closed id of every handle has two descriptions and its column a CHECK of the whole roster."
			},
			{
				file: "packages/engine/src/scalar/closed-id.ts",
				original: "\t\t\t: roster.handles.filter((handle) => named.has(handle))",
				replacement: "\t\t\t: [...named]",
				why: "An `only` subset is held in the order it is listed: two spellings of one subset describe it apart."
			},
			{
				file: "packages/engine/src/scalar/closed-id.ts",
				original: "\t\tif (named.has(handle)) {",
				replacement: "\t\tif (false) {",
				why: "A handle listed twice is admitted, where the statement is refused."
			},
			{
				file: "packages/engine/src/scalar/closed-id.ts",
				original: 'if (typeof handle !== "string" || !live.has(handle)) {',
				replacement: 'if (typeof handle !== "string") {',
				why: "A handle off the roster is admitted and ignored, where the statement is refused as malformed."
			},
			{
				file: "packages/engine/src/scalar/literal.ts",
				original:
					'\t\tcase "code":\n\t\t\treturn typeof value === "string" && base.roster.handles.includes(value)\n',
				replacement:
					'\t\tcase "code":\n\t\t\treturn typeof value === "string" && (base.only ?? base.roster.handles).includes(value)\n',
				why: "A literal compared with a closed id of a subset is held to the subset, so a query equating it to a handle of its roster outside the subset is refused."
			},
			{
				file: "packages/engine/src/physical/ddl/column-checks.ts",
				original: "\tboundedNumeric,\n\tclosedSubset\n]",
				replacement: "\tboundedNumeric\n]",
				why: "A closed id of a subset's column carries no CHECK, so a direct writer stores any code of its roster."
			}
		]
	})
