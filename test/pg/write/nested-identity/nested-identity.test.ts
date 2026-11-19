import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { Db } from "#adapter/public/db.ts"
import { maxStringLength } from "#compiler/core/canonical.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	aOf,
	Bodies,
	type BodiesFeature,
	caseGen,
	situations,
	bodiesInstall,
	bodiesTemplate,
	downstreamAims
} from "#test/pg/write/nested-identity/nested-identity.fixtures.ts"
import { answered, rowsOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A nested write whose texts sum past the longest string is accepted by PostgreSQL and reads back as written, its identities never joined into one text.
 *
 * Its pre-conversion budget: runs 8, coverage cases 8 (test/pg/write/nested-identity/nested-identity.test.ts at 991e0f9ab).
 */
export const aNestedWriteWhoseTextsSumPastTheLongestStringIsAcceptedByPostgreSQLAndReadsBackAsWrittenItsIdentitiesNeverJoinedIntoOneText =
	property.explore(aimed(caseGen, downstreamAims), {
		needs: { fixture: Substrate.seat(bodiesTemplate) },
		situations: situations satisfies ReadonlyArray<Reached<BodiesFeature>>,
		check:
			({ fixture }, cx: Case<BodiesFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Bodies, {}, bodiesInstall, taken)
								const s = yield* Substrate
								const names = namesOf(o.installed)
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.app, {})

									yield* replaceRows(s.admin, installationGroup(names), [])
									/** One body per length, shared by every member of that length. */
									const bodies = new Map(
										Arr.map(Arr.dedupe(c.lengths), (n) => [n, aOf(n)] as const)
									)
									const bodyOf = (n: number): "" | `a${string}` =>
										defined(bodies.get(n), "a body's length")
									const id = uuidOf(1)
									const members = Arr.map(c.lengths, (n) => ({ body: bodyOf(n) }))
									const outcome = yield* answered(
										db.workload.insertOwner.once({
											params: {},
											facts: { insert: { Owner: [{ id, members }] } }
										})
									)
									if (outcome.kind !== "accepted") {
										return assert.fail(`a lawful nested write is accepted, not ${outcome.kind}`)
									}
									const added = (name: string): bigint | undefined =>
										Option.getOrUndefined(Arr.findFirst(outcome.counts, (n) => n.relation === name))
											?.added
									assert.equal(added("Owner"), 1n, "the owner is added once")
									if (c.lengths.length > 0) {
										assert.equal(
											added("Member"),
											BigInt(c.lengths.length),
											"each member is added once"
										)
									}
									const read = yield* rowsOf(db.workload.members.once({ params: {}, facts: {} }))
									assert.equal(read.length, c.lengths.length, "every member reads back")
									for (const row of read) {
										const at = Number(row.at)
										const length = defined(c.lengths[at], "a member at a slot the write drew")
										assert.equal(row.owner, id, "a member reads back under its owner")
										assert.equal(row.body.length, length, "a body reads back at its length")
										assert.ok(row.body === bodyOf(length), "a body reads back as written")
									}
									const [owner] = yield* rowsOf(db.workload.owners.once({ params: {}, facts: {} }))
									assert.equal(
										defined(owner, "the owner reads back").members,
										BigInt(c.lengths.length),
										"the owner's count is its members'"
									)
									if (c.lengths.length === 0) {
										cx.note("an owner with no members")
									} else {
										cx.note("accepted and read back with members")
									}
									if (Arr.dedupe(c.lengths).length > 1) {
										cx.note("members of two lengths")
									}
									if (Arr.reduce(c.lengths, 0, (n, l) => n + l) > maxStringLength) {
										cx.note("bodies summing past the longest string")
									}
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL accepts every lawful nested write, and the reader gives back each body at its slot as written"
		},
		budget: { runs: 8, steered: 8 },
		kept: [],
		kills: []
	})
