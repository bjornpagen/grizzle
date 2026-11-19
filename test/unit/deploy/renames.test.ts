/**
 * Declared renames and drops, drafted with no database: every one or two operations (a rename, a drop, an addition)
 * over at most three names, on relations, on the fields of one relation, on a roster's handles and on logins, and every
 * operation on relations beside one or two on logins, each operation declared or, a named invalid variant, its
 * declaration left out, exhausted.
 *
 * The oracle is a model of declared identities: it applies the operations to the previous names, predicts the target's
 * names, and predicts the verdict, accepted exactly when every name the previous schema holds and the target does not
 * keep is declared renamed or dropped, refused otherwise with UndeclaredDrop naming the first such name, a relation's
 * before a login's, in the previous snapshot's order. A name a declared rename takes from a name the previous schema
 * holds and does not rename, as a drop and then a rename onto the dropped name does, ends that name, so its drop is
 * declared though the target holds the name. An accepted draft is checked against the model: its snapshot holds exactly
 * the target's names; a declared rename of a relation is a chain of renames taking the old table to the target's, and
 * of a login a chain of ALTER ROLE ... RENAME taking the old login's role to the target's, which the draft neither
 * creates nor drops; a kept login's role is neither renamed, created nor dropped; a dropped login's role is dropped,
 * and a new login's created; and a renamed handle keeps its code, the codes read back from the snapshot.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Result } from "effect"
import { type Named } from "#compiler/deploy/diff/plan.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import {
	boxGen,
	draft,
	type Feature,
	FEATURES,
	type Gone,
	goneDesc,
	type GoneFeature,
	judge,
	respelledDesc,
	type RespelledFeature,
	respellingGen,
	statementsOf
} from "#test/unit/deploy/renames.fixtures.ts"

/** Declared renames and drops drop a field grizzle draws again with no declaration, and refuse a caller's field's undeclared drop. */
export const declaredRenamesAndDropsDropAFieldGrizzleDrawsAgainWithNoDeclarationAndRefuseACallersFieldsUndeclaredDrop =
	property.exhaust(
		finite((source): Gone => ({
			writing: source.draw(element(["caller", "generated"] as const)),
			declared: source.draw(boolean)
		})),
		{
			needs: {},
			situations: [
				"a caller's field refused",
				"a caller's field dropped",
				"a generated field dropped"
			] satisfies ReadonlyArray<Reached<GoneFeature>>,
			check: (_, c: Case<GoneFeature>) => (gone) =>
				Effect.sync(() => {
					const x: Named = { kind: "field", relation: parsedName("P"), field: parsedName("x") }
					const previous = draft(
						emptySnapshot({ schemaName: "Renames", schema: "renames" }),
						{ desc: goneDesc(gone, true), logins: [] },
						{ renames: [], drops: [] },
						new Map()
					)
					if (Result.isFailure(previous)) {
						return assert.fail(`the starting draft: ${previous.failure.message}`)
					}
					const drafted = draft(
						previous.success.snapshot,
						{ desc: goneDesc(gone, false), logins: [] },
						{ renames: [], drops: gone.declared ? [x] : [] },
						new Map()
					)
					if (gone.writing === "caller" && !gone.declared) {
						const reason = Result.isFailure(drafted) ? drafted.failure.reason : undefined
						assert.ok(
							reason?._tag === "UndeclaredDrop",
							"a caller's field dropped undeclared is refused"
						)
						assert.deepEqual(reason.dropped, x, "naming the field")
						c.note("a caller's field refused")
						return
					}
					if (Result.isFailure(drafted)) {
						return assert.fail(`the draft drafts: ${drafted.failure.message}`)
					}
					const p = drafted.success.snapshot.theory.relations["P"]
					const fields: ReadonlyArray<string> =
						p?.kind === "relation" ? Arr.map(p.fields, (y) => y.name) : []
					assert.deepEqual(fields, ["id", "n"], "the field is dropped")
					c.note(
						gone.writing === "caller" ? "a caller's field dropped" : "a generated field dropped"
					)
				}),
			oracle: {
				kind: "specification",
				name: "a generated, drawn or accumulated field holds no caller data, so its drop needs no declaration"
			},
			box: "a caller's field and a generated one dropped, each declared or not",
			kept: [],
			kills: []
		}
	)

/** Declared renames and drops a relation, a field or a roster respelled to an alike name is one installed object, and so is a law column that reads it: drafted with no declaration, and nothing dropped. Its budget is its suite's before it was a property (test/unit/deploy/renames.test.ts at 4ca3036a): 64 runs and 64 steered cases. */
export const declaredRenamesAndDropsARelationAFieldOrARosterRespelledToAnAlikeNameIsOneInstalledObjectAndSoIsALawColumnThatReadsItDraftedWithNoDeclarationAndNothingDropped =
	property.explore(respellingGen, {
		needs: {},
		budget: { runs: 64, steered: 64 },
		situations: ["relation", "field", "roster", "every name respelled"] satisfies ReadonlyArray<
			Reached<RespelledFeature>
		>,
		check: (_, c: Case<RespelledFeature>) => (respelling) =>
			Effect.sync(() => {
				const respelled = Arr.filter(
					["relation", "field", "roster"] as const,
					(r) => respelling[r].before !== respelling[r].after
				)
				c.noteAll(respelled)
				if (respelled.length === 3) {
					c.note("every name respelled")
				}
				const previous = draft(
					emptySnapshot({ schemaName: "Renames", schema: "renames" }),
					{ desc: respelledDesc(respelling, "before"), logins: [] },
					{ renames: [], drops: [] },
					new Map()
				)
				if (Result.isFailure(previous)) {
					return assert.fail(`the starting draft: ${previous.failure.message}`)
				}
				const drafted = draft(
					previous.success.snapshot,
					{ desc: respelledDesc(respelling, "after"), logins: [] },
					{ renames: [], drops: [] },
					new Map()
				)
				if (Result.isFailure(drafted)) {
					return assert.fail(`the respelled names draft: ${drafted.failure.message}`)
				}
				const drops = Arr.filter(
					statementsOf(drafted.success.plan.steps),
					(st) =>
						st.kind === "drop" ||
						(st.kind === "alterTable" &&
							Arr.some(st.actions, (a) => a.kind === "dropColumn" || a.kind === "alterColumnType"))
				)
				assert.deepEqual(drops, [], "a respelling drops nothing")
			}),
		oracle: {
			kind: "specification",
			name: "the naming door installs a declared name as its conversion, so two alike names name one table, column or roster domain"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/declared.ts",
				original: "\t\tconst alikeOwn = this.#groups.get(conversionOf(own)) ?? []",
				replacement: "\t\tconst alikeOwn = this.#groups.get(own) ?? []",
				why: "The previous snapshot's names are looked up by spelling, not by conversion, so a respelled name's law column is set aside and dropped."
			}
		]
	})

/** Declared renames and drops draft exactly the model's identities for every pair of renames, drops and additions over three names, refusing every drop no declaration names. */
export const declaredRenamesAndDropsDraftExactlyTheModelsIdentitiesForEveryPairOfRenamesDropsAndAdditionsOverThreeNamesRefusingEveryDropNoDeclarationNames =
	property.exhaust(finite(boxGen), {
		needs: {},
		situations: FEATURES satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (box) =>
			Effect.sync(() => judge(box, (feature) => c.note(feature))),
		oracle: {
			kind: "second-implementation",
			name: "a model of declared identities predicting the target's names and every verdict"
		},
		box: "every one or two operations (a rename, a drop, an addition, each rename and drop declared or not) over the names a, b, c, from a and b, on relations, on one relation's fields, on a roster's handles and on logins, and every one operation on relations beside one or two on logins",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/codes.ts",
				original:
					"\t\tconst codes = rosterCodes(before, renames.get(roster.closed) ?? noHandleRenames, roster)",
				replacement: "\t\tconst codes = rosterCodes(before, noHandleRenames, roster)",
				why: "A roster's declared handle renames are ignored when its codes are drafted, so a renamed handle takes a new code."
			}
		]
	})
