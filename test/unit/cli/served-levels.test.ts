/**
 * A login's served file is one text whichever compile reaches it. `grizzle generate` and `grizzle check` compile every
 * login's ChangeSets once, in the draft's workload plan (cli/generate.ts plannedLogins): a login over the configured
 * schema's level over the installation's artifacts, and a login over a level below it over that level's artifacts,
 * compiled from the installation's basis under the derived facts a snapshot records of it (deploy/snapshot/build.ts
 * derivedFacts), before any snapshot is written. An application's test compiles a login from the committed snapshot
 * alone (adapter/served/compile.ts snapshotServedEntry), its level's artifacts compiled under the codes and the derived
 * facts snapshot.json records. Both compiles read the same facts, so each login's two texts are the same, byte for byte.
 *
 * The box: the ChangeSet agreement's schemas (test/support/agreement/changeset-schema.ts), Reports configured over Work,
 * its level below. A login over Work runs, on Work's writer, a drawn nonempty set of ChangeSets from a menu that writes
 * every kind of field Work holds: a closed id, a set and texts of two patterns (Tag), a contract (Budget), a serial
 * (Ticket), an immutable family owner (Order, Pool) and a tree (Node). A login over Reports runs, on a writer of
 * Reports, a drawn set of the same menu and a read of Reports' TaskCount. The oracle is the snapshot-only compile of
 * each login, under the snapshot.json text the draft lays out.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { snapshotServedEntry } from "#adapter/served/compile.ts"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, eachServedFile } from "#cli/generate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { emptySnapshot, writeRuntimeSnapshot } from "#compiler/deploy/snapshot/build.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { login } from "#compiler/public/schema.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { Reports, Work } from "#test/support/agreement/changeset-schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { joined, jsonOf } from "#test/support/chunked.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import {
	caseGen,
	counts,
	type Feature,
	file,
	programsOf,
	reportsWriter,
	workWriter
} from "#test/unit/cli/served-levels.fixtures.ts"

/**
 * A login's served file is the same text from the draft's workload plan and from the committed snapshot alone, over
 * the configured level and a level below it.
 *
 * Budget: its suite's count before the conversion (unit/cli/served-levels: 24 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const aLoginsServedFileIsTheSameTextFromTheDraftsWorkloadPlanAndFromTheCommittedSnapshotAloneOverTheConfiguredLevelAndALevelBelowIt =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"a closed id, a set and texts",
			"a contract",
			"a serial",
			"an immutable owner",
			"a counted family's owner",
			"a tree",
			"a delete",
			"a ChangeSet over the level below",
			"a ChangeSet over the configured level"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, notes: CaseOf<Feature>) => (c) =>
			Effect.gen(function* () {
				for (const m of [...c.below, ...c.above]) {
					notes.note(m.kind)
				}
				notes.note("a ChangeSet over the level below")
				if (c.above.length > 0) {
					notes.note("a ChangeSet over the configured level")
				}
				const writer = workWriter()
				const reporter = reportsWriter()
				const below = login(Work, "app", [writer], {
					workload: [workload(writer, programsOf(c.below, writer))]
				})
				const above = login(Reports, "reports", [reporter], {
					workload: [workload(reporter, { ...programsOf(c.above, reporter), counts })]
				})
				const config = yield* resolveConfig(
					defineConfig({
						contracts: [],
						schemas: [Reports],
						logins: [below, above],
						migrations: "migrations",
						rolePrefixBytes: 0,
						connection: () => offlineOwner
					}),
					file
				)
				const configured = defined(config.schemas[0], "the configured schema")
				const compiled = yield* Effect.fromResult(compileSchema(configured))
				const draft = yield* draftSchema(
					compiled,
					emptySnapshot({ schemaName: configured.declared, schema: configured.ident }),
					[],
					noDeclarations,
					silentPhases
				)
				const entries = yield* eachServedFile(
					compiled,
					draft,
					draft.served,
					silentPhases,
					Effect.succeed
				)
				const snapshot = jsonOf(
					succeeded(writeRuntimeSnapshot(draft.snapshot, draft.derived), "snapshot.json")
				)
				assert.equal(entries.length, compiled.logins.length, "a served file for each login")
				for (const [i, l] of compiled.logins.entries()) {
					const planned = defined(entries[i], `the planned file of login ${i}`)
					const alone = yield* snapshotServedEntry(l, snapshot)
					assert.equal(planned.login, alone.login)
					assert.equal(
						joined(planned.text),
						joined(alone.text),
						`login ${planned.login}: the plan's served file is the snapshot-only compile's`
					)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the snapshot-only compile of each login (adapter/served/compile.ts snapshotServedEntry)"
		},
		budget: { runs: 24, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/config.ts",
				original:
					"\t\t\t!Arr.some(\n\t\t\t\tlevelsOf(entry.built),\n\t\t\t\t(level) => level.name === login.base.name && sameLevel(level.content, read.base.content)\n\t\t\t)",
				replacement:
					"\t\t\tArr.some(\n\t\t\t\tlevelsOf(entry.built),\n\t\t\t\t(level) => level.name === login.base.name && sameLevel(level.content, read.base.content)\n\t\t\t)",
				why: "Operator mutant (negation) at packages/grizzle/src/cli/config.ts:313 in resolveConfigWith: `!Arr.some(\n\t\t\t\tlevelsOf(entry.built),\n\t\t\t\t(level) => level.name === login.base.n` becomes `Arr.some(\n\t\t\t\tlevelsOf(entry.built),\n\t\t\t\t(level) => level.name === login.base.na`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
