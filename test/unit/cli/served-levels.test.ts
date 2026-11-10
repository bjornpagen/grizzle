import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { filter, type Gen, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { snapshotServedEntry } from "#adapter/served/compile.ts"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, servedFiles } from "#cli/generate.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, role, wholeEntriesOf, writableNamesOf } from "#compiler/public/schema.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import {
	Budget,
	Node,
	Order,
	Pool,
	Reports,
	Tag,
	Task,
	TaskCount,
	Ticket,
	Work
} from "#test/support/agreement/changeset-schema.ts"
import { assert, defined } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"

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

/** A writer of Work's every writable relation over Work, built for one case: a role is in one login. */
const workWriter = () =>
	role(Work, "writer", wholeEntriesOf(Work), { write: writableNamesOf(Work) })

/** A writer of Work's every writable relation over Reports, built for one case. */
const reportsWriter = () =>
	role(Reports, "reportsWriter", wholeEntriesOf(Reports), { write: writableNamesOf(Work) })

type Writer = ReturnType<typeof workWriter> | ReturnType<typeof reportsWriter>

/** One ChangeSet of the menu over a writer of Work or of Reports: its program's name and its value. */
interface Member {
	readonly name: string
	readonly kind: Feature
	readonly over: (writer: Writer) => unknown
}

type Feature =
	| "a closed id, a set and texts"
	| "a contract"
	| "a serial"
	| "an immutable owner"
	| "a counted family's owner"
	| "a tree"
	| "a delete"
	| "a ChangeSet over the level below"
	| "a ChangeSet over the configured level"

/** The menu of ChangeSets, each over a writer of Work or of Reports, every member supplied by the call. */
const menu: Arr.NonEmptyReadonlyArray<Member> = [
	{
		name: "addTag",
		kind: "a closed id, a set and texts",
		over: (w) => ChangeSet.empty(w).insert(Tag, [])
	},
	{ name: "putBudget", kind: "a contract", over: (w) => ChangeSet.empty(w).put(Budget, []) },
	{ name: "addTicket", kind: "a serial", over: (w) => ChangeSet.empty(w).insert(Ticket, []) },
	{
		name: "addOrder",
		kind: "an immutable owner",
		over: (w) => ChangeSet.empty(w).insert(Order, [])
	},
	{
		name: "addPool",
		kind: "a counted family's owner",
		over: (w) => ChangeSet.empty(w).insert(Pool, [])
	},
	{ name: "addNode", kind: "a tree", over: (w) => ChangeSet.empty(w).insert(Node, []) },
	{ name: "dropTask", kind: "a delete", over: (w) => ChangeSet.empty(w).delete(Task, []) }
]

/** A case: the ChangeSets the login over Work runs, a nonempty set, and those the login over Reports runs. */
interface Case {
	readonly below: ReadonlyArray<Member>
	readonly above: ReadonlyArray<Member>
}

const caseGen: Gen<Case> = (source) => ({
	below: source.draw(filter(subarray(menu), Arr.isReadonlyArrayNonEmpty, 8)),
	above: source.draw(subarray(menu))
})

const counts = query(Reports).rule((r) => {
	const { account, tasks } = v(TaskCount, "count")
	return r.match(TaskCount, { account, tasks }).find({ account, tasks })
})

/** The programs of a writer's workload: each member's ChangeSet over it, under its name. */
const programsOf = (
	members: ReadonlyArray<Member>,
	writer: Writer
): Readonly<Record<string, unknown>> =>
	Rec.fromEntries(Arr.map(members, (m) => [m.name, m.over(writer)] as const))

const file = `${repoRoot}app/grizzle.config.ts`

layer(NodeServices.layer, { excludeTestServices: true })("a login's served file", (it) => {
	it.effect(
		"is the same text from the draft's workload plan and from the committed snapshot alone, over the configured level and a level below it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/cli/served-levels",
						draw: drawn(caseGen),
						literal: (c) =>
							Formatter.format({
								below: Arr.map(c.below, (m) => m.name),
								above: Arr.map(c.above, (m) => m.name)
							}),
						oracle: {
							kind: "second-implementation",
							name: "the snapshot-only compile of each login (adapter/served/compile.ts snapshotServedEntry)"
						},
						coverage: required<Feature>(
							[
								"a closed id, a set and texts",
								"a contract",
								"a serial",
								"an immutable owner",
								"a counted family's owner",
								"a tree",
								"a delete",
								"a ChangeSet over the level below",
								"a ChangeSet over the configured level"
							],
							{ cases: 24, sense: notesOnly }
						),
						kept: [],
						runs: 24,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					(c, notes) =>
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
									schemas: [Reports],
									logins: [below, above],
									migrations: "migrations",
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
								noDeclarations
							)
							const entries = yield* servedFiles(compiled, draft.snapshotFiles, draft.served)
							const snapshot = trustedJson<unknown>(draft.snapshotFiles.snapshot)
							assert.equal(entries.length, compiled.logins.length, "a served file for each login")
							for (const [i, l] of compiled.logins.entries()) {
								const planned = defined(entries[i], `the planned file of login ${i}`)
								const alone = yield* snapshotServedEntry(l, snapshot)
								assert.equal(planned.login, alone.login)
								assert.equal(
									planned.text,
									alone.text,
									`login ${planned.login}: the plan's served file is the snapshot-only compile's`
								)
							}
						})
				)
			)
	)
})
