import { assert, defined } from "@bjornpagen/testing/assert"
/**
 * A refresh member of a login's workload is compiled by `grizzle generate` into the login's served file, and held to
 * it by `grizzle check`, as every member is: its targets are the views of the set of materialized relations its
 * refresh(relations) call names, in refresh order, so a call that names other relations leaves the committed file stale.
 *
 * The schema holds three materialized relations over two levels above its base: Spend and Calls at the first, in that
 * order, and Usage, which joins them, at the second; the role `analyst` refreshes all three, and its login serves one
 * workload member, `nightly: refresh(relations)`. A case draws two calls, each a nonempty list of the three, in any order and
 * with repeats: the committed one, which generate drafts, and the configured one, which the configuration then names.
 *
 * The oracle is the first draft of each set of relations, taken before any case: its refresh member's targets are the
 * set's relations in declared level order, whatever order and repeats a call names them in, so a case's draft is the
 * first draft of its call's set byte for byte. check passes when the configured call names the committed one's set, and
 * otherwise finds the login's files stale as the shared model states it (test/support/migrate/kit.ts loginFileFindings):
 * its served file, naming the login and the refresh member, and its OpenAPI document, naming the login, which states
 * what each program does with the relations it names, the refresh's targets among them. generate then writes the
 * configured set's first draft, drafting no folder and leaving snapshot.json and manifest.json byte for byte, since a
 * refresh member plans no access; and check passes again.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, String as Str } from "effect"
import { check } from "#cli/check.ts"
import { loginFiles } from "#cli/files.ts"
import { manifestFileName, snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { cliOver, configName, resolvedConfig, workspace } from "#test/pg/cli/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { loginFileFindings } from "#test/support/migrate/kit.ts"
import {
	at,
	callsGen,
	draftsNeed,
	loginName,
	memberName,
	refreshConfigOf,
	roleName,
	schemaDir,
	servedFilePath,
	setOf,
	type Situation,
	situationsOf
} from "#test/unit/cli/served-refresh.fixtures.ts"

/**
 * Served refresh members a refresh member's served targets are its call's set of relations in level order, check
 * refuses a committed one of another set naming the member, and generate writes it back drafting no folder.
 *
 * Budget: its suite's count before the conversion (unit/cli/served-refresh: 8 independent cases and 32 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const servedRefreshMembersARefreshMembersServedTargetsAreItsCallsSetOfRelationsInLevelOrderCheckRefusesACommittedOneOfAnotherSetNamingTheMemberAndGenerateWritesItBackDraftingNoFolder =
	property.explore(callsGen, {
		needs: { draftsNeed },
		situations: [
			"the same relations, called otherwise",
			"a relation added",
			"a relation dropped",
			"relations exchanged",
			"a relation repeated"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ draftsNeed }, c: Case<Situation>) =>
			(calls) =>
				Effect.gen(function* () {
					const { fs, draftOf } = yield* draftsNeed
					return yield* Effect.scoped(
						Effect.gen(function* () {
							c.noteAll(situationsOf(calls))
							const ws = yield* workspace("served-refresh")
							const committed = refreshConfigOf(calls.committed)
							const configured = refreshConfigOf(calls.configured)
							const drafted = yield* cliOver(
								ws,
								committed,
								["generate", configName, "--name", "init"],
								at(1)
							)
							assert.equal(drafted.code, 0, drafted.stderr)
							const file = `${ws}/${servedFilePath}`
							const draft = yield* fs.readFileString(file)
							assert.equal(
								draft,
								draftOf(calls.committed),
								"a call's served file is its set's first draft, whatever its order and repeats"
							)
							const listed = yield* fs.readDirectory(`${ws}/${schemaDir}`)
							const entries = Arr.sort(listed, Order.String)
							const snapshot = yield* fs.readFileString(`${ws}/${schemaDir}/${snapshotFileName}`)
							const manifest = yield* fs.readFileString(`${ws}/${schemaDir}/${manifestFileName}`)
							const same = setOf(calls.committed) === setOf(calls.configured)
							const checked = yield* cliOver(ws, configured, ["check", configName], at(2))
							assert.equal(checked.code, same ? 0 : 1, checked.stdout)
							const read = yield* resolvedConfig(configured, `${ws}/${configName}`)
							const [result] = yield* check(succeeded(read), ws)
							const findings = defined(result, "the schema's check").findings
							const expected = same ? [] : loginFileFindings("stale")
							assert.deepEqual(
								Arr.map(findings, (f) => ({ kind: f.kind, where: f.where })),
								Arr.map(expected, (f) => ({
									kind: f.kind,
									where: `${schemaDir}/${loginFiles[f.file].path(loginName)}`
								})),
								Formatter.format(calls)
							)
							for (const [found, model] of Arr.zip(findings, expected)) {
								const says = `login ${loginName}, ${model.file === "served" ? `first at program ${memberName} of role ${roleName}:` : ""}`
								assert.ok(
									Str.startsWith(says)(found.problem),
									`the finding names ${says}: ${Formatter.format(found)}`
								)
							}
							const regenerated = yield* cliOver(ws, configured, ["generate", configName], at(3))
							assert.equal(regenerated.code, 0, regenerated.stderr)
							const after = yield* fs.readDirectory(`${ws}/${schemaDir}`)
							assert.deepEqual(
								Arr.sort(after, Order.String),
								entries,
								"a refresh member plans no access, so generate drafts no folder"
							)
							const snapshotAfter = yield* fs.readFileString(
								`${ws}/${schemaDir}/${snapshotFileName}`
							)
							assert.equal(snapshotAfter, snapshot, "snapshot.json is the first draft's")
							const manifestAfter = yield* fs.readFileString(
								`${ws}/${schemaDir}/${manifestFileName}`
							)
							assert.equal(manifestAfter, manifest, "manifest.json is the first draft's")
							const rewritten = yield* fs.readFileString(file)
							assert.equal(
								rewritten,
								draftOf(calls.configured),
								"generate writes the configured set's first draft"
							)
							const again = yield* cliOver(ws, configured, ["check", configName], at(4))
							assert.equal(again.code, 0, again.stdout)
						})
					)
				}),
		oracle: {
			kind: "specification",
			name: "the first draft of each set of relations, whose targets are the set in level order"
		},
		budget: { runs: 8, steered: 32 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/check.ts",
				original: "\t\t\t\tfor (const kind of loginFileKinds) {",
				replacement: '\t\t\t\tfor (const kind of ["served"] as const) {',
				why: "check holds the served files alone, so a stale document goes unfound."
			}
		]
	})
