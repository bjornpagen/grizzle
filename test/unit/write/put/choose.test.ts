import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { key, mutable, on, relation, schema, select } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import type { PutChoice } from "#compiler/write/put/choose.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * Each put's statement (write/put/choose.ts choosePutTargets), held to the rules its header states, restated over the
 * box's names: a mutable R(b, c, d) keyed by (b, c), beside one more unique object or none, put by each form a ChangeSet
 * writes it in one stratum.
 *
 * - A unique object reading a field outside the primary key, key(d), makes every put the pair (candidateKey): an UPDATE
 *   checks it at each row, so a statement moving a value between facts would raise 23505 on a lawful final state.
 * - A put of a relation parameter beside the deletion `R where d = $scope and (b, c) not in the parameter` is one MERGE
 *   absorbing it (scopedMerge), unless an object besides the primary key holds apart two facts of different primary
 *   keys, key(c) inside the primary key, which a MERGE meets at an insert before its NOT MATCHED BY SOURCE action
 *   deletes the occupant (the pair, mergeUnique); a key over a selected side of the whole primary key never does,
 *   since two facts it could hold apart share their primary key. Beside an insert into R too, the deletion reads the
 *   stratum's additions, so the put is the pair (unproved).
 * - A put of R's own facts, each key a stored fact's, is an UPDATE ... FROM (existingKeys) when the stratum deletes
 *   nothing of R, and the pair (unproved) beside a deletion, whose key the UPDATE would leave no row to update.
 * - An enumerated put is an ON CONFLICT DO UPDATE (enumerated).
 */

/** The unique objects of R beside its primary key. */
type Uniques = "none" | "key(c)" | "key over a selected primary key" | "key(d)"

/** How the ChangeSet puts R, in one stratum. */
type Form =
	| "replace"
	| "replace beside an insert"
	| "own facts"
	| "own facts beside a deletion"
	| "enumerated"

/** The statement a put lowers to, and why. */
interface Choice {
	readonly target: PutChoice["target"]
	readonly reason: PutChoice["reason"]
}

/** A choice's feature: its statement and its reason. */
type ChoiceFeature = `${PutChoice["target"]} (${PutChoice["reason"]})`

const featureOf = (c: Choice): ChoiceFeature => `${c.target} (${c.reason})`

const R = relation("R", { b: pg.integer, c: pg.integer, d: pg.integer }, ["b", "c"])

const schemaOf = (uniques: Uniques) =>
	schema("Put", { R }, [
		mutable(R),
		...(uniques === "key(c)"
			? [key(on(R, "c"))]
			: uniques === "key over a selected primary key"
				? [
						key(
							on(
								select(R, (r) => r.eq(r.b, 1)),
								"b",
								"c"
							)
						)
					]
				: uniques === "key(d)"
					? [key(on(R, "d"))]
					: [])
	])

/** The facts of the relation parameter `rows`, put as they are. */
const fromRows = (s: ReturnType<typeof schemaOf>): QueryValue =>
	query(s).rule((r: RuleValue) => {
		const { b, c, d } = v(R, "row")
		return r.match(r.relation("rows", R), { b, c, d }).find({ b, c, d })
	})

/** Every stored fact of R with d = $scope whose key the relation parameter `rows` lacks. */
const scopedOutside = (s: ReturnType<typeof schemaOf>): QueryValue =>
	query(s).rule((r: RuleValue) => {
		const { b, c, d } = v(R, "stored")
		return r
			.match(R, { b, c, d })
			.where(r.eq(d, r.param("scope", pg.integer)))
			.where(r.not(r.relation("rows", R), { b, c }))
			.find({ b, c, d })
	})

/** Every stored fact of R, its d set to 1: a put whose every key is a stored fact's. */
const ownFacts = (s: ReturnType<typeof schemaOf>): QueryValue =>
	query(s).rule((r: RuleValue) => {
		const { b, c, d } = v(R, "stored")
		return r.match(R, { b, c, d }).find({ b, c, d: 1 })
	})

/** Every stored fact of R with d = 0. */
const zeroFacts = (s: ReturnType<typeof schemaOf>): QueryValue =>
	query(s).rule((r: RuleValue) => {
		const { b, c } = v(R, "stored")
		return r.match(R, { b, c, d: 0 }).find({ b, c, d: 0 })
	})

/** The ChangeSet of a form, R's first put first. */
const changeSetOf = (s: ReturnType<typeof schemaOf>, form: Form) => {
	const empty = ChangeSet.empty(s)
	switch (form) {
		case "replace":
			return empty.put(R, fromRows(s)).delete(R, scopedOutside(s))
		case "replace beside an insert":
			return empty
				.put(R, fromRows(s))
				.delete(R, scopedOutside(s))
				.insert(R, [{ b: 9, c: 9, d: 9 }])
		case "own facts":
			return empty.put(R, ownFacts(s))
		case "own facts beside a deletion":
			return empty.put(R, ownFacts(s)).delete(R, zeroFacts(s))
		case "enumerated":
			return empty.put(R, [{ b: 1, c: 1, d: 1 }])
	}
}

/** The rules of the header, over the box's names: R's first put's statement and its reason. */
const expectedOf = (uniques: Uniques, form: Form): Choice => {
	if (uniques === "key(d)") {
		return { target: "deleteThenInsert", reason: "candidateKey" }
	}
	switch (form) {
		case "replace":
			return uniques === "key(c)"
				? { target: "deleteThenInsert", reason: "mergeUnique" }
				: { target: "merge", reason: "scopedMerge" }
		case "replace beside an insert":
		case "own facts beside a deletion":
			return { target: "deleteThenInsert", reason: "unproved" }
		case "own facts":
			return { target: "updateFrom", reason: "existingKeys" }
		case "enumerated":
			return { target: "onConflictDoUpdate", reason: "enumerated" }
	}
}

const uniquesList: Arr.NonEmptyReadonlyArray<Uniques> = [
	"none",
	"key(c)",
	"key over a selected primary key",
	"key(d)"
]
const forms: Arr.NonEmptyReadonlyArray<Form> = [
	"replace",
	"replace beside an insert",
	"own facts",
	"own facts beside a deletion",
	"enumerated"
]

const caseGen: Gen<readonly [Uniques, Form]> = (source) =>
	[source.draw(element(uniquesList)), source.draw(element(forms))] as const

describe("a put's statement", () => {
	it.effect(
		"is the one its relation's unique objects and its stratum's other actions on the relation admit, by the rules its header states",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/put/choose",
						generator: caseGen,
						literal: Formatter.format,
						limit: 20,
						box: "a mutable R(b, c, d) keyed by (b, c), beside no other unique object, key(c), a key over a selected (b, c) or key(d), put from a relation parameter beside the scoped deletion of what it lacks, alone or beside an insert, from its own facts, alone or beside a deletion, or enumerated",
						oracle: {
							kind: "specification",
							name: "choosePutTargets' rules, restated over the box"
						},
						coverage: requiredInSpace<ChoiceFeature>([
							"deleteThenInsert (candidateKey)",
							"deleteThenInsert (mergeUnique)",
							"deleteThenInsert (unproved)",
							"merge (scopedMerge)",
							"updateFrom (existingKeys)",
							"onConflictDoUpdate (enumerated)"
						]),
						caseHang
					},
					([uniques, form], c) =>
						Effect.sync(() => {
							const s = schemaOf(uniques)
							const compiled = succeeded(
								compileWrite(
									checking(s),
									descOf(changeSetOf(s, form)),
									realityWrite(succeeded(testArtifacts(s, testCompile)))
								),
								"the write"
							)
							const first = defined(compiled.choices[0], "R's first put's choice")
							const expected = expectedOf(uniques, form)
							assert.deepEqual<Choice>(
								{ target: first.target, reason: first.reason },
								expected,
								`${form} beside ${uniques}`
							)
							c.note(featureOf(expected))
						})
				)
			)
	)
})
