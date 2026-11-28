/**
 * What generate keeps of a login's served compile past it holds its texts alone (adapter/served/compile.ts ServedEntry):
 * its login's name, its served file's text and its OpenAPI document's, each as its chunks, and no part of the served
 * file's value, which no reader reads past the making of its texts, where each entry held the value beside them until
 * every login's file was written (metis's suite installation: its served round grew by about 730 MiB over its 28
 * logins, the run dying as its write began).
 *
 * Property, per case: the served-levels box (test/unit/cli/served-levels.fixtures.ts: Reports over Work, a login over
 * each level running a drawn set of ChangeSets) drafted from the empty snapshot as generate drafts it (cli/generate.ts
 * draftSchema, eachServedFile): every object reachable from each login's entry (each object's own properties, a list's
 * elements) is the entry or one of its two texts, each a list of strings. Oracle: specification, what the write reads of
 * a served compile. Kill: the entry keeps the served file's value beside its texts, as it did.
 *
 * Features: a login over each level.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, eachServedFile } from "#cli/generate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { login } from "#compiler/public/schema.ts"
import { defineConfig } from "#index.ts"
import { Reports, Work } from "#test/support/agreement/changeset-schema.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { offlineOwner } from "#test/support/pg/cli/support.ts"
import {
	caseGen,
	counts,
	file,
	programsOf,
	reportsWriter,
	workWriter
} from "#test/unit/cli/served-levels.fixtures.ts"

/** Every object reachable from `root` by own properties and list elements. */
const reachable = (root: object): ReadonlyArray<object> => {
	const seen = new Set<object>()
	const pending: Array<unknown> = [root]
	while (pending.length > 0) {
		const next = pending.pop()
		if (typeof next !== "object" || next === null || seen.has(next)) {
			continue
		}
		seen.add(next)
		for (const key of Reflect.ownKeys(next)) {
			const descriptor = Reflect.getOwnPropertyDescriptor(next, key)
			if (descriptor !== undefined && "value" in descriptor) {
				pending.push(descriptor.value)
			}
		}
	}
	return [...seen]
}

/** Whether `value` is a list of strings: a text's chunks. */
const isChunks = (value: object): boolean =>
	Arr.isArray(value) && Arr.every(value, (piece) => typeof piece === "string")

/** What generate keeps of a login's served compile holds its texts alone: no part of its served file's value. */
export const whatGenerateKeepsOfALoginsServedCompileHoldsItsTextsAloneNoPartOfItsServedFilesValue =
	property.explore(caseGen, {
		needs: {},
		situations: ["a login over each level"],
		check: (_, notes: Case<"a login over each level">) => (c) =>
			Effect.gen(function* () {
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
				if (entries.length === 2) {
					notes.note("a login over each level")
				}
				for (const entry of entries) {
					for (const held of reachable(entry)) {
						assert.ok(
							held === entry || isChunks(held),
							`login ${entry.login}: its entry holds its texts alone`
						)
					}
					assert.ok(
						entry.text.length > 0 && entry.openapi.length > 0,
						`login ${entry.login}: its texts`
					)
				}
			}),
		oracle: { kind: "specification", name: "what the write reads of a login's served compile" },
		budget: { runs: 12, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/served/compile.ts",
				original: "\treturn { login: compiled.login.name, text, openapi }",
				replacement: "\treturn { login: compiled.login.name, file, text, openapi }",
				why: "The entry keeps the served file's value beside its texts, as it did, so every login's value lives until the last login's file is written."
			}
		]
	})
