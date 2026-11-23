/** What the properties of derived.test.ts read: its spaces, models and helpers. */

import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import { boolean, constant, type Gen, oneOf, subarray } from "@bjornpagen/testing/gen"
import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import { Array as Arr, Cause, DateTime, Effect, FileSystem, Order, Record as Rec } from "effect"
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
 * How a case makes the draft's derived facts stale: the `derived` member removed whole; or kept with the recorded
 * members `dropped` left out and, at `foreign`, the closed facts holding a fact of a relation the schema does not
 * declare. A kept `derived` drops a member or holds the foreign fact, so every staling is stale.
 */
export type Staling =
	| { readonly derived: "removed" }
	| { readonly derived: "kept"; readonly dropped: ReadonlyArray<string>; readonly foreign: boolean }

/** The member of `derived` that holds the closed facts, which a foreign fact is planted among. */
const closedMember = "closed"

/**
 * Every staling of facts that record `members`: the whole member removed, or each subset of them left out, the foreign
 * fact drawn where the closed facts are kept, and held where nothing is left out.
 */
const stalings = (members: ReadonlyArray<string>): Gen<Staling> =>
	oneOf<Staling>([
		constant({ derived: "removed" }),
		(source) => {
			const dropped = subarray(members)(source)
			const foreign = Arr.contains(dropped, closedMember)
				? false
				: dropped.length === 0 || boolean(source)
			return { derived: "kept", dropped, foreign }
		}
	])

/** What a staling leaves of the facts the layer reads: whether it records every one of them. */
export const recordsEvery = (staling: Staling): boolean =>
	staling.derived === "kept" && staling.dropped.length === 0

/** What a staling does, as the search counts it. */
export type Situation =
	| "the derived member removed"
	| "a member left out"
	| "every member left out"
	| "a foreign fact"
	| "a foreign fact beside every member"

/** The situations a staling of facts that record `members` reaches. */
export const situationsOf = (
	staling: Staling,
	members: ReadonlyArray<string>
): ReadonlyArray<Situation> => {
	if (staling.derived === "removed") {
		return ["the derived member removed"]
	}
	const left: ReadonlyArray<Situation> =
		staling.dropped.length === 0
			? []
			: staling.dropped.length === members.length
				? ["a member left out", "every member left out"]
				: ["a member left out"]
	const foreign: ReadonlyArray<Situation> = !staling.foreign
		? []
		: staling.dropped.length === 0
			? ["a foreign fact", "a foreign fact beside every member"]
			: ["a foreign fact"]
	return [...left, ...foreign]
}

const shop = Object.freeze(shopV1("DerivedShop", "none"))
const ident = identifierOf(identity.schema(parsedSchemaName("DerivedShop")))
export const schemaDir = `migrations/${ident}`

export const config = defineConfig({
	schemas: [shop.schema],
	logins: [shop.server],
	migrations: "migrations",
	rolePrefixBytes: 0,
	connection: () => offlineOwner
})

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

/** The derived facts snapshot.json records, by member, the closed facts by relation. */
type RecordedFacts = { readonly [member: string]: { readonly [key: string]: Json } }

/** snapshot.json's text with its derived facts made stale by `staling`. */
export const staled = (text: string, staling: Staling): string => {
	const { derived: _recorded, ...rest } = trustedJson<{ readonly [key: string]: Json }>(text)
	if (staling.derived === "removed") {
		return jsonText(rest)
	}
	const { derived } = trustedJson<{ readonly derived: RecordedFacts }>(text)
	const kept = Rec.filter(derived, (_, member) => !Arr.contains(staling.dropped, member))
	return jsonText({
		...rest,
		derived: staling.foreign
			? { ...kept, [closedMember]: { ...kept[closedMember], Stale: { function: "stale" } } }
			: kept
	})
}

/**
 * Every member of the derived facts snapshot.json records (SnapshotDerived), each under its own name: the record's type
 * holds it to every member, and a case's check holds it to the members the first draft records.
 */
const derivedMembers: { readonly [K in keyof SnapshotDerived]: K } = {
	closed: "closed",
	fkCycles: "fkCycles",
	references: "references",
	textDomains: "textDomains",
	library: "library",
	tables: "tables",
	live: "live",
	params: "params"
}

/** The members the first draft's derived facts record. */
export const members: ReadonlyArray<string> = Rec.values(derivedMembers)

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
		const drafted = yield* cliOver(base, config, ["generate", configName, "--name", "init"], at(0))
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
