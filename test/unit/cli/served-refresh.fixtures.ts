/** What the properties of served-refresh.test.ts read: its spaces, models and helpers. */

import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { array, type Gen, int } from "@bjornpagen/testing/gen"
import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import { Array as Arr, Cause, DateTime, Effect, Equivalence, FileSystem, Option } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, login, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { refresh, workload } from "#compiler/public/workload.ts"
import { servedPath } from "#compiler/served/forms.ts"
import { servedFile } from "#compiler/served/json.ts"
import { defineConfig } from "#index.ts"
import { cliOver, configName, offlineOwner, workspace } from "#test/pg/cli/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { Id } from "#test/support/ids.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { upTo } from "#test/support/up-to.ts"

export type Situation =
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

export const schemaDir = `migrations/${ident}`

export const loginName = "nightly_job"

export const roleName = "analyst"

export const memberName = "nightly"

export const servedFilePath = `${schemaDir}/${servedPath(loginName)}`

const Call = relation("Call", { id: Id, workspace: Id, cost: pg.bigint }, ["id"])

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

const totals = schema.extend([base], `${schemaName}_1`, [Spend, Calls], [])

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

const top = schema.extend([totals], `${schemaName}_2`, [Usage], [])

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
export const refreshConfigOf = (positions: Arr.NonEmptyReadonlyArray<number>) => {
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
		rolePrefixBytes: 0,
		connection: () => offlineOwner
	})
}

/** The set of relations a call names, one bit per position. */
export const setOf = (positions: ReadonlyArray<number>): number =>
	Arr.reduce(Arr.dedupe(positions), 0, (bits, p) => bits | (1 << p))

/** The positions of a set, ascending: declared level order. */
const positionsOf = (bits: number): ReadonlyArray<number> =>
	Arr.filter(
		upTo(materialized.length, (i) => i),
		(p) => (bits & (1 << p)) !== 0
	)

/** Every nonempty set of the relations. */
const everySet = Object.freeze(upTo((1 << materialized.length) - 1, (i) => i + 1))

export const at = (second: number) =>
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

export const callsGen: Gen<Calls> = (source) => ({
	committed: source.draw(callGen),
	configured: source.draw(callGen)
})

/** Whether two calls name the same relations in the same order. */
const sameCall = Arr.makeEquivalence(Equivalence.strictEqual<number>())

export const situationsOf = (calls: Calls): ReadonlyArray<Situation> => {
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

/** What the search built once before its cases (fs, draftOf), now once per worker: every case on it reads them. */
export const draftsNeed = {
	key: "test/unit/cli/served-refresh.fixtures.ts draftsNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const drafts = new Map<number, string>()
		for (const bits of everySet) {
			const ws = yield* workspace("served-refresh-draft")
			const positions = nonEmpty(positionsOf(bits), "a nonempty set")
			const drafted = yield* cliOver(
				ws,
				refreshConfigOf(positions),
				["generate", configName, "--name", "init"],
				at(0)
			)
			assert.equal(drafted.code, 0, drafted.stderr)
			const text = yield* fs.readFileString(`${ws}/${servedFilePath}`)
			assert.deepEqual(
				refreshedIn(text),
				Arr.map(positions, (p) => relationAt(p).name),
				"a refresh member's targets are its relations in declared level order"
			)
			drafts.set(bits, text)
		}
		const draftOf = (positions: ReadonlyArray<number>): string =>
			defined(drafts.get(setOf(positions)), "the first draft of the call's set")
		return { fs, draftOf }
	}).pipe(
		Effect.mapBoth({
			onFailure: (error) =>
				NeedFailed.make({
					need: "test/unit/cli/served-refresh.fixtures.ts draftsNeed",
					message: Cause.pretty(Cause.fail(error))
				}),
			onSuccess: (made) => Effect.succeed(made)
		})
	)
} as const satisfies Need<unknown>
