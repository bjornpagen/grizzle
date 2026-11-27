/** What the properties of derived.test.ts read: its spaces, models and helpers. */

import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import { Array as Arr, Cause, Effect, FileSystem, Order, Record as Rec } from "effect"
import type { Json } from "#compiler/core/canonical.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import {
	manifestFileName,
	type SnapshotDerived,
	snapshotFileName
} from "#compiler/deploy/snapshot/types.ts"
import { defineConfig } from "#index.ts"
import { shopV1 } from "#test/pg/cli/fixture.ts"
import { cliOver, configName, offlineOwner, workspace } from "#test/pg/cli/support.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"

/**
 * How a case makes the draft's derived facts stale: the `derived` member removed whole (`removed`); the recorded members
 * `left` left out of it, one alone or every one (`leftOut`); or every member kept and the closed facts holding a fact of
 * a relation the schema does not declare (`foreign`). Every staling is stale.
 *
 * Each member's absence is decided apart from every other's: DbLayer.make's parse reads each member on its own and refuses
 * the first it lacks (deploy/snapshot/served.ts servedDerived), and `grizzle check` holds the record to the compile's by
 * canonical equality (deploy/snapshot/build.ts derivedHolds), equal exactly where every member is. So each member left out
 * alone reaches its own reading, and a subset of members reaches none another subset does not: the space is linear in the
 * members, where every subset of them doubled it with each member the format added (6,144 cases at twelve). The one
 * dependency is the foreign fact's on the closed facts it is planted among, so it is drawn where every member is kept.
 */
export type Staling =
	| { readonly kind: "removed" }
	| { readonly kind: "leftOut"; readonly left: Arr.NonEmptyReadonlyArray<string> }
	| { readonly kind: "foreign" }

/** The member of `derived` that holds the closed facts, which a foreign fact is planted among. */
const closedMember = "closed"

/**
 * Every staling of facts that record `members` (Staling): the whole member removed, each member left out alone, every
 * member left out, and the foreign fact beside every member.
 */
const stalings = (members: Arr.NonEmptyReadonlyArray<string>): Gen<Staling> =>
	element<Staling>([
		{ kind: "removed" },
		{ kind: "foreign" },
		...Arr.map(members, (member): Staling => ({ kind: "leftOut", left: [member] })),
		{ kind: "leftOut", left: members }
	])

/** What a staling leaves of the facts the layer reads: whether it records every one of them. */
export const recordsEvery = (staling: Staling): boolean => staling.kind === "foreign"

/** What a staling does, as the search counts it. */
export type Situation =
	| "the derived member removed"
	| "a member left out"
	| "every member left out"
	| "a foreign fact beside every member"

/** The situations a staling of facts that record `members` reaches. */
export const situationsOf = (
	staling: Staling,
	members: ReadonlyArray<string>
): ReadonlyArray<Situation> => {
	switch (staling.kind) {
		case "removed":
			return ["the derived member removed"]
		case "leftOut":
			return staling.left.length === members.length
				? ["a member left out", "every member left out"]
				: ["a member left out"]
		case "foreign":
			return ["a foreign fact beside every member"]
	}
}

const shop = Object.freeze(shopV1("DerivedShop", "none"))
const ident = identifierOf(identity.schema(parsedSchemaName("DerivedShop")))
export const schemaDir = `migrations/${ident}`

export const config = defineConfig({
	contracts: [],
	schemas: [shop.schema],
	logins: [shop.server],
	migrations: "migrations",
	rolePrefixBytes: 0,
	connection: () => offlineOwner
})

/** The derived facts snapshot.json records, by member, the closed facts by relation. */
type RecordedFacts = { readonly [member: string]: { readonly [key: string]: Json } }

/** snapshot.json's text with its derived facts made stale by `staling`. */
export const staled = (text: string, staling: Staling): string => {
	const { derived: _recorded, ...rest } = trustedJson<{ readonly [key: string]: Json }>(text)
	const { derived } = trustedJson<{ readonly derived: RecordedFacts }>(text)
	switch (staling.kind) {
		case "removed":
			return jsonText(rest)
		case "leftOut":
			return jsonText({
				...rest,
				derived: Rec.filter(derived, (_, member) => !Arr.contains(staling.left, member))
			})
		case "foreign":
			return jsonText({
				...rest,
				derived: {
					...derived,
					[closedMember]: { ...derived[closedMember], Stale: { function: "stale" } }
				}
			})
	}
}

/**
 * Every member of the derived facts snapshot.json records (SnapshotDerived), each under its own name: the record's type
 * holds it to every member, and a case's check holds it to the members the first draft records.
 */
const derivedMembers: { readonly [K in keyof SnapshotDerived]: K } = {
	closed: "closed",
	fkCycles: "fkCycles",
	references: "references",
	judged: "judged",
	textDomains: "textDomains",
	library: "library",
	tables: "tables",
	resolved: "resolved",
	live: "live",
	params: "params",
	liveDerived: "liveDerived",
	proved: "proved",
	planned: "planned"
}

/** The members the first draft's derived facts record. */
export const members: Arr.NonEmptyReadonlyArray<string> = [
	derivedMembers.closed,
	...Rec.values(Rec.remove(derivedMembers, "closed"))
]

/** Every staling of the first draft's derived facts. */
export const stalingGen: Gen<Staling> = stalings(members)

/** What the search built once before its cases (fs, base, snapshot, manifest, entries), now once per worker: every case on it reads them. */
export const baseNeed = {
	key: "test/unit/cli/derived.fixtures.ts baseNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const base = yield* workspace("derived-base")
		const drafted = yield* cliOver(base, config, ["generate", configName, "--name", "init"])
		assert.equal(drafted.code, 0, drafted.stderr)
		const snapshot = yield* fs.readFileString(`${base}/${schemaDir}/${snapshotFileName}`)
		const manifest = yield* fs.readFileString(`${base}/${schemaDir}/${manifestFileName}`)
		const listed = yield* fs.readDirectory(`${base}/${schemaDir}`)
		const entries = Arr.sort(listed, Order.String)
		unorderedEqual(
			Rec.keys(trustedJson<{ readonly derived: RecordedFacts }>(snapshot).derived),
			members,
			"the first draft records every member of the derived facts, and only those"
		)
		return { fs, base, snapshot, manifest, entries }
	}).pipe(
		Effect.mapBoth({
			onFailure: (error) =>
				NeedFailed.make({
					need: "test/unit/cli/derived.fixtures.ts baseNeed",
					message: Cause.pretty(Cause.fail(error))
				}),
			onSuccess: (made) => Effect.succeed(made)
		})
	)
} as const satisfies Need<unknown>
