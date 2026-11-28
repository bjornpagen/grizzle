/**
 * What heads.test.ts reads: a schema whose relations hold a clock and a place, each a head (physical/ddl/stamps.ts), at
 * two versions, and the run of a history of them through the command line.
 */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, map } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { instant, natural, place } from "#compiler/public/fields.ts"
import { query } from "#compiler/public/query.ts"
import { key, login, on, relation, role, schema, unit } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { defineConfig } from "#index.ts"
import {
	cliOver,
	configName,
	connectionOf,
	ownerOn,
	workspace
} from "#test/support/pg/cli/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A version of the schema: `first`, Event's clock at each user beside its key over (user, tag), and Slot's place at
 * each user; or `regrouped`, Event's key over (tag, user), an index swapped in over rows Event may hold, and Slot's
 * place grouped by (user, note), so its head's table and stamp function are made again.
 */
export type HeadsVersion = "first" | "regrouped"

/** Every version, in the order a history takes them. */
const headsVersions: Arr.NonEmptyReadonlyArray<HeadsVersion> = ["first", "regrouped"]

/** A history: every version up to the one drawn, in order, the first alone or the first then the regrouped one. */
export const historyGen: Gen<ReadonlyArray<HeadsVersion>> = map(element(headsVersions), (last) => [
	...Arr.takeWhile(headsVersions, (v) => v !== last),
	last
])

/** The schema at `version` under `name`, its login serving a writer that adds an Event and a Slot. */
const headsSchema = (name: string, version: HeadsVersion) => {
	const Event = relation("Event", { user: natural, at: instant, tag: natural }, ["user", "at"])
	const Slot = relation(
		"Slot",
		{ user: natural, note: natural, n: place },
		version === "first" ? ["user", "n"] : ["user", "note", "n"]
	)
	const base = schema(
		name,
		[Event, Slot],
		[
			unit("User", { user: natural }),
			version === "first" ? key(on(Event, "user", "tag")) : key(on(Event, "tag", "user"))
		]
	)
	const writer = role(base, "writer", { Event, Slot }, { insert: ["Event", "Slot"] })
	const add = ChangeSet.empty(writer)
		.insert(
			writer.relations.Event,
			query(writer).rule((r) =>
				r.find({ user: r.param("user", natural), tag: r.param("tag", natural) })
			)
		)
		.insert(
			writer.relations.Slot,
			query(writer).rule((r) =>
				r.find({ user: r.param("user", natural), note: r.param("tag", natural) })
			)
		)
	return {
		schema: base,
		login: login(base, "app", [writer], { workload: [workload(writer, { add })] })
	}
}

/** What one version's run through the command line showed: each command's exit code and what it printed. */
export interface VersionRun {
	readonly version: HeadsVersion
	readonly runs: ReadonlyArray<{
		readonly command: string
		readonly code: number
		readonly printed: string
	}>
}

/**
 * Runs each version of `history` in turn through the command line over one workspace and one database: generate, then
 * migrate, drift and migrate again.
 */
export const runHistory = (history: ReadonlyArray<HeadsVersion>) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const name = yield* substrate.schema({ create: false, label: "heads" })
		const ws = yield* workspace("heads")
		const out: Array<VersionRun> = []
		for (const version of history) {
			const s = headsSchema(name, version)
			const config = defineConfig({
				contracts: [],
				schemas: [s.schema],
				logins: [s.login],
				migrations: "migrations",
				rolePrefixBytes: 0,
				connection: () =>
					connectionOf(substrate.cluster, ownerOn(substrate.cluster, substrate.database))
			})
			const runs: Array<VersionRun["runs"][number]> = []
			for (const command of ["generate", "migrate", "drift", "migrate"]) {
				const ran = yield* cliOver(ws, config, [command, configName])
				runs.push({ command, code: ran.code, printed: `${ran.stdout}${ran.stderr}` })
			}
			out.push({ version, runs })
		}
		return out
	}).pipe(Effect.scoped)

/** Every command of every version passed: the problems are each one that did not, with what it printed. */
const problemsOf = (runs: ReadonlyArray<VersionRun>): ReadonlyArray<string> =>
	Arr.flatMap(runs, (v) =>
		Arr.flatMap(v.runs, (r) =>
			r.code === 0 ? [] : [`grizzle ${r.command} at ${v.version} exited ${r.code}: ${r.printed}`]
		)
	)

/** Asserts no command of `runs` failed. */
export const assertPassed = (runs: ReadonlyArray<VersionRun>): void => {
	const problems = problemsOf(runs)
	assert.deepEqual(problems, [], Arr.join(problems, "\n"))
}
