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
import { Array as Arr, Effect, Record as Rec, Result } from "effect"
import { isCanonicalName } from "#compiler/analysis/derived/canonical.ts"
import type { Named } from "#compiler/core/errors.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import {
	boxGen,
	type CanonicalOp,
	canonicalDeclarations,
	canonicalFirst,
	canonicalOps,
	canonicalRenamed,
	canonicalSubject,
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
	rowStepsOf,
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
			kills: [
				{
					file: "packages/engine/src/core/lines.ts",
					original: `needed > limit\n\t\t? Result.err(resourceBound(at, { kind: "stringLength", limit, needed }))\n\t\t: Result.ok(\`\${open}\${parts.join(separator)}\${close}\`)`,
					replacement: `needed > limit ? Result.ok(\`\${open}\${parts.join(separator)}\${close}\`) : Result.err(resourceBound(at, { kind: "stringLength", limit, needed }))`,
					why: `Operator mutant 62cfe33fcc at packages/engine/src/core/lines.ts:107 in enclosedWithin: \`needed > limit   ? Result.err(resourceBound(at, { kind: "stringLength", limit, needed }))   : Result.ok(\`\${open}\${parts.join(separator)}\${close}\`)\` becomes \`needed > limit ? Result.ok(\`\${open}\${parts.join(separator)}\${close}\`) : Result.err(resourceBound(at, { kind: "stringLength", limit, needed }))\`; the property fails (the census, lane TESTPOLICY2).`
				}
			]
		}
	)

/** Declared renames and drops a relation, a field or a roster respelled to an alike name is one installed object, and so is a law column that reads it and a law over it: drafted with no declaration, nothing dropped and no row checked again. Its budget is its suite's before it was a property (test/unit/deploy/renames.test.ts at 4ca3036a): 64 runs and 64 steered cases. */
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
				assert.deepEqual(
					rowStepsOf(drafted.success.plan.steps),
					[],
					"a respelling checks no stored row against a law again"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the naming door installs a declared name as its conversion, so two alike names name one table, column or roster domain"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/declared.ts",
				original: "\t\t\t\tif (holds.has(column)) {\n\t\t\t\t\treturn column\n\t\t\t\t}\n",
				replacement: "",
				why: "A law column the previous snapshot holds under the target's own name is not that column, so a respelled name's law column is set aside and dropped."
			}
		]
	})

/** Declared renames and drops draft exactly the model's identities for every pair of renames, drops and additions over three names, refusing every drop no declaration names and every declaration the snapshots do not bear out, by what it misses. */
export const declaredRenamesAndDropsDraftExactlyTheModelsIdentitiesForEveryPairOfRenamesDropsAndAdditionsOverThreeNamesRefusingEveryDropNoDeclarationNamesAndEveryDeclarationTheSnapshotsDoNotBearOutByWhatItMisses =
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
			},
			{
				file: "packages/engine/src/deploy/diff/declared.ts",
				original: '\t\t\t\tif (code < 0) {\n\t\t\t\t\treturn "dropUnheld"\n\t\t\t\t}\n',
				replacement: '\t\t\t\tif (code < 0) {\n\t\t\t\t\treturn "dropKept"\n\t\t\t\t}\n',
				why: "A handle's drop over a roster that holds its code as a hole, as a draft run again over the folder it wrote finds it, is refused as a drop of a handle the schema keeps, naming the wrong side."
			}
		]
	})

/**
 * A draft over a snapshot that records an anonymous canonical relation beside the declared names keeps, renames,
 * respells and drops its stored relations as one without it does: the canonical relation's name is its form's, no
 * declared name, so no declaration renames or drops it and no name is alike it (deploy/diff/declared.ts relationName),
 * where the draft read it as a declared name and stopped on an internal error (den's slice, `grizzle check` over its
 * first migration, its programs importing its queues). The box, exhausted: the relation beside it kept, renamed by a
 * declaration, respelled alike or dropped by one.
 */
export const aDraftOverASnapshotRecordingAnAnonymousCanonicalRelationKeepsRenamesRespellsAndDropsItsRelationsAsDeclared =
	property.exhaust(
		finite((source) => source.draw(element(canonicalOps))),
		{
			needs: {},
			situations: canonicalOps satisfies ReadonlyArray<Reached<CanonicalOp>>,
			check: (_, c: Case<CanonicalOp>) => (op) =>
				Effect.sync(() => {
					const previous = draft(
						emptySnapshot({ schemaName: "Renames", schema: "renames" }),
						canonicalSubject(op, "start"),
						{ renames: [], drops: [] },
						new Map()
					)
					if (Result.isFailure(previous)) {
						return assert.fail(`the starting draft: ${previous.failure.message}`)
					}
					const recorded = Rec.keys(previous.success.snapshot.theory.relations)
					assert.ok(
						Arr.some(recorded, isCanonicalName),
						"the first draft's snapshot records the anonymous canonical relation"
					)
					const drafted = draft(
						previous.success.snapshot,
						canonicalSubject(op, "target"),
						canonicalDeclarations(op),
						new Map()
					)
					if (Result.isFailure(drafted)) {
						return assert.fail(`the draft over it: ${drafted.failure.message}`)
					}
					const relations = drafted.success.snapshot.theory.relations
					const held = op === "renamed" ? canonicalRenamed : canonicalFirst
					assert.equal(
						Rec.has(relations, held) || op === "respelled",
						op !== "dropped",
						`the relation ${op === "dropped" ? "is dropped" : "stands"}`
					)
					assert.deepEqual(
						Arr.filter(Rec.keys(relations), isCanonicalName),
						Arr.filter(recorded, isCanonicalName),
						"the canonical relation stands under its own name"
					)
					c.note(op)
				}),
			oracle: {
				kind: "specification",
				name: "the declarations' rule over the declared names alone: a canonical relation's name is its form's, kept as it is"
			},
			box: "the relation beside an anonymous canonical relation kept, renamed, respelled alike or dropped",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/deploy/diff/declared.ts",
					original: "\tisCanonicalName(name) ? undefined : declared(name)\n",
					replacement: "\tdeclared(name)\n",
					why: "A snapshot's anonymous canonical relation read as a declared name: every draft over a snapshot that records one stops on an internal error, den's `grizzle check` over its first migration among them."
				}
			]
		}
	)
