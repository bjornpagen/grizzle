import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	DateTime,
	Effect,
	Equivalence,
	FileSystem,
	Formatter,
	Option,
	Order,
	String as Str
} from "effect"
import { check } from "#cli/check.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { manifestFileName, snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, login, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { refresh, workload } from "#compiler/public/workload.ts"
import { servedPath } from "#compiler/served/forms.ts"
import { servedFile } from "#compiler/served/json.ts"
import { defineConfig } from "#index.ts"
import {
	cliOver,
	configName,
	offlineOwner,
	resolvedConfig,
	workspace
} from "#test/pg/cli/support.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"

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
 * otherwise finds exactly one stale served file, naming the login and the refresh member; generate then writes the
 * configured set's first draft, drafting no folder and leaving snapshot.json and manifest.json byte for byte, since a
 * refresh member plans no access; and check passes again.
 */

type Situation =
	| "the same relations, called otherwise"
	| "a relation added"
	| "a relation dropped"
	| "relations exchanged"
	| "a relation repeated"

/** Two refresh calls, each the positions of the relations it names in `materialized`: the committed, the configured. */
interface Calls {
	readonly committed: Arr.NonEmptyReadonlyArray<number>
	readonly configured: Arr.NonEmptyReadonlyArray<number>
}

const schemaName = "ServedRefresh"
const ident = identifierOf(identity.schema(parsedSchemaName(schemaName)))
const schemaDir = `migrations/${ident}`
const loginName = "nightly_job"
const roleName = "analyst"
const memberName = "nightly"
const servedAt = `${schemaDir}/${servedPath(loginName)}`

const Call = relation("Call", { id: uuid, workspace: uuid, cost: pg.bigint }, ["id"])
const base = schema(schemaName, [Call], [])
const Spend = derived.materialized(
	"Spend",
	query(base).rule((r) => {
		const { id, workspace, cost } = v(Call, "call")
		return r.match(Call, { id, workspace, cost }).find({ workspace, spend: r.sum(cost) })
	})
)
const Calls = derived.materialized(
	"Calls",
	query(base).rule((r) => {
		const { id, workspace } = v(Call, "call")
		return r.match(Call, { id, workspace }).find({ workspace, calls: r.count() })
	})
)
const totals = schema.extend(base, `${schemaName}_1`, [Spend, Calls], [])
const Usage = derived.materialized(
	"Usage",
	query(totals).rule((r) => {
		const { workspace, spend } = v(Spend, "spend")
		const { calls } = v(Calls, "calls")
		return r
			.match(Spend, { workspace, spend })
			.match(Calls, { workspace, calls })
			.find({ workspace, spend, calls })
	})
)
const top = schema.extend(totals, `${schemaName}_2`, [Usage], [])

/** A materialized relation of the schema, with its declared name. */
interface Materialized {
	readonly name: string
	readonly relation: typeof Spend | typeof Calls | typeof Usage
}

/** The materialized relations in declared level order. */
const materialized: ReadonlyArray<Materialized> = [
	{ name: "Spend", relation: Spend },
	{ name: "Calls", relation: Calls },
	{ name: "Usage", relation: Usage }
]

const relationAt = (position: number): Materialized =>
	defined(materialized[position], `materialized relation ${position}`)

/**
 * The configuration whose login serves `nightly: refresh(relations)` of the relations at `positions`, in that order,
 * to a role of its own: a role is in exactly one login, and each configuration builds its login anew.
 */
const configOf = (positions: Arr.NonEmptyReadonlyArray<number>) => {
	const analyst = role(top, roleName, wholeEntriesOf(top), { refresh: ["Spend", "Calls", "Usage"] })
	return defineConfig({
		schemas: [top],
		logins: [
			login(top, loginName, [analyst], {
				workload: [
					workload(analyst, {
						[memberName]: refresh(Arr.map(positions, (p) => relationAt(p).relation))
					})
				]
			})
		],
		migrations: "migrations",
		connection: () => offlineOwner
	})
}

/** The set of relations a call names, one bit per position. */
const setOf = (positions: ReadonlyArray<number>): number =>
	Arr.reduce(Arr.dedupe(positions), 0, (bits, p) => bits | (1 << p))

/** The positions of a set, ascending: declared level order. */
const positionsOf = (bits: number): ReadonlyArray<number> =>
	Arr.filter(
		upTo(materialized.length, (i) => i),
		(p) => (bits & (1 << p)) !== 0
	)

/** Every nonempty set of the relations. */
const everySet = Object.freeze(upTo((1 << materialized.length) - 1, (i) => i + 1))

const at = (second: number) =>
	DateTime.makeUnsafe({
		year: 2026,
		month: 11,
		day: 9,
		hour: 12,
		minute: 0,
		second,
		millisecond: 0
	})

/**
 * The relations a served file's refresh member refreshes, in the file's order, each as the file names it: the file read
 * as a layer reads it (served/json.ts servedFile), its role's member under the member's name.
 */
const refreshedIn = (text: string): ReadonlyArray<string> => {
	const file = succeeded(servedFile(trustedJson<unknown>(text)), "the served file")
	const own = defined(
		Option.getOrUndefined(Arr.findFirst(file.roles, (r) => r.name === roleName)),
		`the served file's role ${roleName}`
	)
	const member = defined(
		Option.getOrUndefined(Arr.findFirst(own.members, (m) => m.name === memberName)),
		`the served member ${memberName}`
	)
	assert.equal(member.kind, "refresh", `${memberName} is a refresh member`)
	return member.kind === "refresh" ? Arr.map(member.refresh.targets, (t) => t.relation) : []
}

const callGen: Gen<Arr.NonEmptyReadonlyArray<number>> = (source) =>
	nonEmpty(
		source.draw(array(int(0, materialized.length - 1), { min: 1, max: 4 })),
		"a refresh call names a relation"
	)

const callsGen: Gen<Calls> = (source) => ({
	committed: source.draw(callGen),
	configured: source.draw(callGen)
})

/** Whether two calls name the same relations in the same order. */
const sameCall = Arr.makeEquivalence(Equivalence.strictEqual<number>())

const situationsOf = (calls: Calls): ReadonlyArray<Situation> => {
	const committed = setOf(calls.committed)
	const configured = setOf(calls.configured)
	const both = committed & configured
	const repeated = (positions: ReadonlyArray<number>) =>
		Arr.dedupe(positions).length < positions.length
	const change: ReadonlyArray<Situation> =
		committed !== configured
			? [
					both === committed
						? "a relation added"
						: both === configured
							? "a relation dropped"
							: "relations exchanged"
				]
			: sameCall(calls.committed, calls.configured)
				? []
				: ["the same relations, called otherwise"]
	const repeats: ReadonlyArray<Situation> =
		repeated(calls.committed) || repeated(calls.configured) ? ["a relation repeated"] : []
	return [...change, ...repeats]
}

layer(NodeServices.layer, { excludeTestServices: true })("served refresh members", (it) => {
	it.effect(
		"a refresh member's served targets are its call's set of relations in level order, check refuses a committed one of another set naming the member, and generate writes it back drafting no folder",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const drafts = new Map<number, string>()
					for (const bits of everySet) {
						const ws = yield* workspace("served-refresh-draft")
						const positions = nonEmpty(positionsOf(bits), "a nonempty set")
						const drafted = yield* cliOver(
							ws,
							configOf(positions),
							["generate", configName, "--name", "init"],
							at(0)
						)
						assert.equal(drafted.code, 0, drafted.stderr)
						const text = yield* fs.readFileString(`${ws}/${servedAt}`)
						assert.deepEqual(
							refreshedIn(text),
							Arr.map(positions, (p) => relationAt(p).name),
							"a refresh member's targets are its relations in declared level order"
						)
						drafts.set(bits, text)
					}
					const draftOf = (positions: ReadonlyArray<number>): string =>
						defined(drafts.get(setOf(positions)), "the first draft of the call's set")
					return yield* explore(
						{
							suite: "unit/cli/served-refresh",
							draw: drawn(callsGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "the first draft of each set of relations, whose targets are the set in level order"
							},
							coverage: required<Situation>(
								[
									"the same relations, called otherwise",
									"a relation added",
									"a relation dropped",
									"relations exchanged",
									"a relation repeated"
								],
								{ cases: 40, sense: notesOnly }
							),
							kept: [],
							runs: 8,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(calls, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									c.noteAll(situationsOf(calls))
									const ws = yield* workspace("served-refresh")
									const committed = configOf(calls.committed)
									const configured = configOf(calls.configured)
									const drafted = yield* cliOver(
										ws,
										committed,
										["generate", configName, "--name", "init"],
										at(1)
									)
									assert.equal(drafted.code, 0, drafted.stderr)
									const file = `${ws}/${servedAt}`
									const draft = yield* fs.readFileString(file)
									assert.equal(
										draft,
										draftOf(calls.committed),
										"a call's served file is its set's first draft, whatever its order and repeats"
									)
									const listed = yield* fs.readDirectory(`${ws}/${schemaDir}`)
									const entries = Arr.sort(listed, Order.String)
									const snapshot = yield* fs.readFileString(
										`${ws}/${schemaDir}/${snapshotFileName}`
									)
									const manifest = yield* fs.readFileString(
										`${ws}/${schemaDir}/${manifestFileName}`
									)
									const same = setOf(calls.committed) === setOf(calls.configured)
									const checked = yield* cliOver(ws, configured, ["check", configName], at(2))
									assert.equal(checked.code, same ? 0 : 1, checked.stdout)
									const read = yield* resolvedConfig(configured, `${ws}/${configName}`)
									const [result] = yield* check(succeeded(read), ws)
									const findings = defined(result, "the schema's check").findings
									assert.deepEqual(
										Arr.map(findings, (f) => ({ kind: f.kind, where: f.where })),
										same ? [] : [{ kind: "servedStale", where: servedAt }],
										Formatter.format(calls)
									)
									for (const found of findings) {
										const says = `login ${loginName}, first at program ${memberName} of role ${roleName}:`
										assert.ok(
											Str.startsWith(says)(found.problem),
											`the finding names ${says}: ${Formatter.format(found)}`
										)
									}
									const regenerated = yield* cliOver(
										ws,
										configured,
										["generate", configName],
										at(3)
									)
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
					)
				})
			)
	)
})
