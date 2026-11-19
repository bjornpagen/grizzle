/**
 * The package as a submodule consumer takes it, against the dev cluster: a consumer's program, run by plain Node from a
 * project whose node_modules links the package's source as a pnpm workspace does (test/unit/dev/consumer.ts), serves
 * its login's committed served file with the runtime entry's served(file, name), builds the login's DbLayer of it and the cluster's connection, opens a Db of the role with
 * Db.open, and reads every note once through its workload's member. The schema is installed under an allocated name as
 * `grizzle generate` drafts and serves it with its login (test/support/install-migrate.ts installGenerated), and the
 * login's served file is the one generate wrote, written as generate writes it. The test writes each case's notes through a Db of its own, and the consumer must read exactly
 * every note written so far: a model of the table, the notes the cases wrote, compared as a set.
 *
 * Features: a case of one note and one of several, and a read after an earlier case's write.
 *
 * The package's pin and command line through a submodule consumer's own install (test/unit/dev/consumer.ts
 * submoduleConsumer), in every layout of that install: the consumer's link to grizzle runs generate and migrate into a
 * cluster of the case's own (test/support/private-cluster.ts privateCluster); the checkout never holds a node_modules of
 * its own, and grizzle's source finds the project's effect, the one package whose Redacted carries the configuration's
 * password, so a second copy fails the migrate. The project's import of `@bjornpagen/grizzle-pg/pin` resolves through
 * its link and agrees with the shell: every assignment of pin.env as scripts/pg/build.sh and source.sh source it in
 * the checkout. Box: the layouts.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Path,
	Record,
	Redacted,
	String as Str
} from "effect"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { servedFile, servedText } from "#compiler/served/json.ts"
import type { Pin } from "#pg/pin.ts"
import {
	consumerConfig,
	consumerConnections,
	type ConsumerFeature,
	consumerProgram,
	declared,
	grizzleCli,
	Note,
	noteId,
	type NoteRow,
	notesOf,
	notesTemplate,
	numbersGen,
	pinProgram,
	shellPin,
	shellSpelling
} from "#test/pg/package/consumer.fixtures.ts"
import { assert, defined, nonEmpty, succeeded, unorderedEqual } from "#test/support/assert.ts"
import { answered, writeOnce } from "#test/support/calls.ts"
import { pgPin } from "#test/support/env.ts"
import { testConnectTimeout, testIdleTimeout } from "#test/support/limits.ts"
import { privateCluster } from "#test/support/private-cluster.ts"
import { hardenedNode } from "#test/support/process.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"
import {
	consumerProject,
	exitedCleanly,
	type Layout,
	layoutGen,
	layouts,
	packageFrom,
	runChild,
	submoduleConsumer
} from "#test/unit/dev/consumer.ts"

/**
 * The package as a submodule consumer takes it, on the dev cluster opens a role of a login with the linked package's Db.open and reads exactly every note written so far.
 *
 * Its pre-conversion budget: runs 2, coverage cases 8 (test/pg/package/consumer.test.ts at d8eed1786).
 */
export const thePackageAsASubmoduleConsumerTakesItOnTheDevClusterOpensARoleOfALoginWithTheLinkedPackagesDbOpenAndReadsExactlyEveryNoteWrittenSoFar =
	property.explore(numbersGen, {
		needs: { notes: Substrate.seat(notesTemplate) },
		situations: [
			"one note",
			"several notes",
			"a read after an earlier write"
		] satisfies ReadonlyArray<Reached<ConsumerFeature>>,
		check:
			({ notes }, c: Case<ConsumerFeature>) =>
			(numbers) =>
				Effect.flatMap(notes, ({ substrate: seat, value: generated }) =>
					Effect.provideService(
						Effect.gen(function* () {
							const written: Array<NoteRow> = []
							const fs = yield* FileSystem.FileSystem
							const path = yield* Path.Path
							const consumer = yield* consumerProject
							const installed = generated.installed
							const App = declared(installed.declared)
							const own = fullWorld(App, { notes: notesOf(App) })
							const file = defined(
								generated.served.get(own.server.name),
								`the served file of login ${own.server.name}`
							)
							const served = path.join(consumer.project, "server.json")
							yield* fs.writeFileString(
								served,
								succeeded(
									servedText(succeeded(servedFile(file), "the login's served file")),
									"the login's served file's text"
								)
							)
							const program = path.join(consumer.project, "consumer.mjs")
							yield* fs.writeFileString(program, consumerProgram)
							const config = path.join(consumer.project, "config.json")
							yield* fs.writeFileString(
								config,
								jsonText({
									host: pgPin.host,
									port: installed.cluster.port,
									ca: installed.cluster.ca,
									database: installed.database,
									password: Redacted.value(installed.as(own.server).password),
									connectTimeoutMs: testConnectTimeout,
									idleTimeoutMs: testIdleTimeout,
									served
								})
							)

							const notes = Arr.map(numbers, (n, i) => ({ id: noteId(written.length + i), n }))
							c.note(notes.length === 1 ? "one note" : "several notes")
							if (Arr.isReadonlyArrayNonEmpty(written)) {
								c.note("a read after an earlier write")
							}
							const outcome = yield* withServedDb(
								installed,
								own.server.roles.app,
								{},
								({ serve }) =>
									Effect.flatMap(serve({ add: ChangeSet.empty(App).insert(Note, []) }), (served) =>
										answered(
											writeOnce(member(served, "add"))({
												params: {},
												facts: { insert: { Note: notes } }
											})
										)
									)
							).pipe(Effect.scoped)
							assert.equal(outcome.kind, "accepted")
							for (const note of notes) {
								written.push(note)
							}
							const read = yield* Effect.scoped(
								Effect.andThen(
									installed.cluster.budget.within(consumerConnections),
									runChild(
										process.execPath,
										[...hardenedNode, program, config],
										consumer.project,
										{}
									)
								)
							)
							assert.equal(read.exitCode, exitedCleanly, `the consumer: ${read.stderr}`)
							unorderedEqual(trustedJson<ReadonlyArray<NoteRow>>(Str.trim(read.stdout)), written)
						}),
						Substrate,
						seat
					)
				),
		oracle: {
			kind: "specification",
			name: "the notes the cases wrote, each read once by the linked package"
		},
		budget: { runs: 2, steered: 8 },
		kept: [],
		kills: []
	})

/**
 * The package's pin and command line through a submodule consumer's install a consumer's own install imports the pin and runs a migrate, its checkout holding no node_modules and effect one package.
 */
export const thePackagesPinAndCommandLineThroughASubmoduleConsumersInstallAConsumersOwnInstallImportsThePinAndRunsAMigrateItsCheckoutHoldingNoNodeModulesAndEffectOnePackage =
	property.exhaust(finite(layoutGen), {
		needs: {},
		situations: nonEmpty(layouts, "the layouts of a consumer's install") satisfies ReadonlyArray<
			Reached<Layout>
		>,
		check: (_, c: Case<Layout>) => (layout) =>
			Effect.scoped(
				Effect.gen(function* () {
					c.note(layout)
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const consumer = yield* submoduleConsumer(layout)
					const member = yield* privateCluster
					const imported = yield* runChild(
						process.execPath,
						[...hardenedNode, "--input-type=module", "-e", pinProgram],
						consumer.project,
						{}
					)
					assert.equal(
						imported.exitCode,
						exitedCleanly,
						`the project's import of the pin: ${imported.stderr}`
					)
					const pin = trustedJson<Pin>(imported.stdout)
					const names = Record.keys(pin)
					const sourced = yield* runChild(
						"bash",
						["-c", shellPin, "bash", consumer.checkout, ...names],
						consumer.project,
						{}
					)
					assert.equal(
						sourced.exitCode,
						exitedCleanly,
						`scripts/pg/pin.env sourced: ${sourced.stderr}`
					)
					const shellValues = Record.fromEntries(
						Arr.map(
							Str.split(Str.trimEnd(sourced.stdout), "\n"),
							(line): readonly [string, string] => {
								const [name, ...value] = Str.split(line, "=")
								return [defined(name, `a line of no name: ${line}`), Arr.join(value, "=")]
							}
						)
					)
					assert.deepEqual(
						Record.map(pin, shellSpelling),
						shellValues,
						"the pin the project imports is pin.env as the shell sources it"
					)
					yield* fs.writeFileString(
						path.join(consumer.project, "grizzle.config.ts"),
						consumerConfig(member)
					)
					for (const step of ["generate", "migrate"]) {
						const ran = yield* runChild(
							process.execPath,
							[...hardenedNode, grizzleCli(consumer), step, "grizzle.config.ts"],
							consumer.project,
							{}
						)
						assert.equal(ran.exitCode, exitedCleanly, `grizzle ${step}: ${ran.stdout}${ran.stderr}`)
					}
					const ownModules = yield* fs.exists(path.join(consumer.checkout, "node_modules"))
					assert.equal(ownModules, false, "the checkout holds a node_modules of its own")
					const projects = yield* packageFrom(consumer.project, "effect")
					assert.ok(Option.isSome(projects), "the project finds no effect")
					const grizzles = yield* packageFrom(
						path.join(consumer.checkout, "packages", "grizzle", "src"),
						"effect"
					)
					assert.deepEqual(
						grizzles,
						projects,
						"grizzle's source finds another effect than the project's"
					)
				})
			),
		oracle: {
			kind: "specification",
			name: "each command exits cleanly, the checkout holds no node_modules, and grizzle's source finds the project's effect"
		},
		box: "every layout of a consumer's install (test/unit/dev/consumer.ts dependencyHome)",
		kept: [],
		kills: []
	})
