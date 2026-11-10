import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { parseSnapshot, readSnapshot } from "#adapter/boundary/snapshot.ts"
import {
	codebookOf,
	derivedHolds,
	derivedOf,
	finishSnapshot,
	targetState,
	writeSnapshot
} from "#compiler/deploy/snapshot/build.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { closedId, pg, uuid } from "#compiler/public/fields.ts"
import { closed, contained, key, on, relation, schema, select } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installationsOf, own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"

/**
 * snapshot.json records each level's laws as an outcome names them (deploy/snapshot/types.ts SnapshotLevel), so a law
 * whose side selects by a literal carries that literal, whose type member is absent, into the snapshot. The writer lays
 * each law out as one canonical value, as it lays out an installed statement, so the file and the fingerprint agree by
 * construction.
 *
 * The box, exhausted: a key over a side of R selected by a comparison of each kind of field R holds (a 64-bit integer,
 * a text, a boolean, a uuid, a closed id over the root's roster) with a literal of it, R declared at the root or at a
 * level over it, which records the key among the upper level's laws. The oracle is the snapshot itself: the text writeSnapshot writes reads back
 * (boundary/snapshot.ts readSnapshot, which refuses a text whose content is not its recorded fingerprint) as a snapshot
 * of the fingerprint written, every level recording the laws written; and what DbLayer.make serves of the file's JSON
 * value over each of its levels (boundary/snapshot.ts parseSnapshot) is exactly those members of what the file reads
 * back as: its fingerprint, its levels' schemas, the laws of the levels above the served one, its constraint-to-law map
 * and its codes.
 */
const Kind = closed("Kind", ["One", "Two"])
const R = relation(
	"R",
	{
		id: uuid,
		big: pg.bigint,
		label: str.regex("^[a-z]{1,8}$"),
		flag: pg.boolean,
		other: uuid,
		kind: closedId(Kind)
	},
	["id"]
)
const B = relation("B", { id: uuid }, ["id"])

const literals = ["bigint", "text", "boolean", "uuid", "closed id"] as const
type Literal = (typeof literals)[number]
const placements = ["root", "level"] as const
type Placement = (typeof placements)[number]

interface Case {
	readonly literal: Literal
	readonly placement: Placement
}

const caseGen: Gen<Case> = (source) => ({
	literal: source.draw(element(literals)),
	placement: source.draw(element(placements))
})

/** The key over R's facts the case's literal selects. */
const selectedKey = (literal: Literal) => {
	switch (literal) {
		case "bigint":
			return key(
				on(
					select(R, (r) => r.gt(r.big, 0n)),
					"other"
				)
			)
		case "text":
			return key(
				on(
					select(R, (r) => r.eq(r.label, "ab")),
					"other"
				)
			)
		case "boolean":
			return key(
				on(
					select(R, (r) => r.eq(r.flag, true)),
					"other"
				)
			)
		case "uuid":
			return key(
				on(
					select(R, (r) => r.ne(r.other, "00000000-0000-4000-8000-000000000000")),
					"big"
				)
			)
		case "closed id":
			return key(
				on(
					select(R, (r) => r.eq(r.kind, "Two")),
					"other"
				)
			)
	}
}

/**
 * The schema of a case: the key at the root, or at a level over a root of B, R there contained in B by its other and
 * typed by the root's roster.
 */
const schemaOf = (c: Case): AnySchema => {
	switch (c.placement) {
		case "root":
			return schema("Root", { Kind, R }, [selectedKey(c.literal)])
		case "level":
			return schema.extend(schema("Root", { Kind, B }, []), "Upper", { R }, [
				contained(on(R, "other"), on(B, "id")),
				selectedKey(c.literal)
			])
	}
}

describe("snapshot.json", () => {
	it.effect(
		"reads back as the snapshot written, of the same fingerprint, whatever literal a level's law selects by",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/deploy/snapshot-levels",
						generator: caseGen,
						literal: Formatter.format,
						limit: literals.length * placements.length,
						box: "a key over a side selected by a literal of each field kind, stated at the root or at a level above it",
						oracle: {
							kind: "specification",
							name: "the written snapshot reads back as itself, its fingerprint and its levels' laws"
						},
						coverage: requiredInSpace<Placement>(["root", "level"]),
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const owned = succeeded(
								own(defined(schemaDescOf(schemaOf(c)), "the case's description"))
							)
							const installation = succeeded(
								compileInstallation(
									owned,
									completeInstallOptions(
										owned,
										installationsOf(owned),
										[],
										[],
										firstCodebook(rostersOf(owned))
									)
								)
							)
							const snapshot = succeeded(
								finishSnapshot(
									succeeded(
										targetState({
											installation,
											workload: noWorkload,
											checks: lawChecks(installation)
										})
									)
								)
							)
							const files = succeeded(writeSnapshot(snapshot, derivedOf(installation)))
							const committed = succeeded(readSnapshot(files))
							const read = committed.snapshot
							assert.ok(
								derivedHolds(committed.derived, derivedOf(installation)),
								"the derived facts written are the compile's"
							)
							const lawsOf = (levels: typeof snapshot.levels) =>
								Arr.map(levels, (l) => Arr.map(l.laws, (law) => law.law))
							const codesOf = (book: ReturnType<typeof codebookOf>) =>
								Arr.map([...book.rosters.values()], (codec) => [codec.roster, codec.codes])
							assert.equal(read.fingerprint, snapshot.fingerprint)
							assert.deepEqual(lawsOf(read.levels), lawsOf(snapshot.levels))
							for (const level of read.levels.keys()) {
								const served = succeeded(parseSnapshot(snapshotJson(files.snapshot), level))
								assert.equal(served.fingerprint, read.fingerprint)
								assert.deepEqual(
									served.schemas,
									Arr.map(read.levels, (l) => l.schema)
								)
								assert.deepEqual(
									served.above,
									Arr.map(read.levels.slice(level + 1), (l) => ({ name: l.name, laws: l.laws }))
								)
								assert.deepEqual(served.constraintToLaw, read.constraintToLaw)
								assert.deepEqual(codesOf(served.codes), codesOf(codebookOf(read)))
								assert.deepEqual<unknown>(
									[...served.derived.closed],
									Arr.map([...derivedOf(installation).closed], ([name, c]) => [
										name,
										{
											...c,
											payload: Arr.map(c.payload, (p) =>
												p.dictionary === undefined ? { field: p.field, radix: p.radix } : p
											)
										}
									])
								)
								assert.deepEqual(served.derived.fkCycles, installation.laws.fkCycles)
							}
							k.note(c.placement)
						})
				)
			)
	)
})
