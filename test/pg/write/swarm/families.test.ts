/**
 * The family writer under a swarm every lawful ChangeSet stores the reference's rows, every unlawful one is refused by a law it breaks, and every refusal when it compiles is one the oracle states.
 *
 * Its pre-conversion budget: runs 24, coverage cases 160 (test/pg/write/swarm/families.test.ts at d8eed1786).
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { aimed, recorded } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { type LawId } from "#compiler/core/ids.ts"
import { caseGen } from "#test/pg/write/swarm/case.ts"
import { changeSetOf, putsOf } from "#test/pg/write/swarm/changes.ts"
import {
	aims,
	causeNote,
	type Situation,
	situations,
	statesCause,
	stepShapes,
	storesExactly,
	recordedSwarmCases
} from "#test/pg/write/swarm/families.fixtures.ts"
import {
	expectStep,
	hostSchema,
	immediateKeysOf,
	justified,
	type Laws,
	nothingStored
} from "#test/pg/write/swarm/oracle.ts"
import { buildSwarm } from "#test/pg/write/swarm/spec.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import { installFullWorld } from "#test/support/installed.ts"
import { lawNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { oneFlight } from "#test/support/one-flight.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"
export const theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates =
	property.explore(aimed(recorded(caseGen, recordedSwarmCases), aims), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ substrate }, c: Case<Situation>) =>
			({ spec, steps }) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const built = buildSwarm(spec)
						const declared = built.rename("Swarm")
						const done = yield* installFullWorld(
							declared,
							{},
							{ ambient: ordinarySession, label: "swarm" }
						)
						const value = built.rename(done.schema)
						const names = namesOf(done)
						const lawNames = lawNamesOf(value)
						const laws: Laws = {
							of: (s) => lawNames.lawOf(s),
							primaryKey: (name) => lawNames.primaryKeyLaw({ name })
						}
						const host = hostSchema(spec, built, laws)
						const keys = immediateKeysOf(spec, done.installation)
						const world = fullWorld(value, {})
						yield* Effect.gen(function* () {
							const db = yield* openServedDb(done, world.server.roles.app, {})
							const flight = yield* oneFlight(db.ctx, done.as(world.server))
							let state = nothingStored
							for (const [i, step] of steps.entries()) {
								const label = `step ${String(i)} (${step.kind}) of ${Formatter.format(spec)}`
								const { changes, facts, params, queryPuts, queried } = changeSetOf(
									spec,
									built,
									value,
									state,
									step
								)
								const expected = expectStep(spec, built, laws, host, state, step, queryPuts)
								for (const ownerWrite of queried) {
									const refusals = ownerWrite.refusals
									const stated = `${label}: an owner's write from a query beside an append to a counted family it owns, which the compile refuses naming one of ${Formatter.format(refusals)}`
									const fromQuery = yield* Effect.result(db.load({ queried: ownerWrite.changes }))
									if (Result.isSuccess(fromQuery)) {
										return assert.fail(`${stated}, compiled`)
									}
									const refused = fromQuery.failure
									if (refused instanceof OpenError) {
										return assert.fail(`${stated}, failed with ${refused._tag}: ${refused.message}`)
									}
									const error = refused.error
									const reason = isCompileError(error) ? error.reason : undefined
									assert.ok(
										reason?._tag === "QueriedOwnerAppend" &&
											Arr.some(
												refusals,
												(r) =>
													r.op === reason.op &&
													r.owner === reason.owner &&
													r.family.owner === reason.family.owner &&
													r.family.count === reason.family.count &&
													r.member === reason.member
											),
										`${stated}, refused with ${Formatter.format(error)}`
									)
									c.note("an owner's write from a query beside its family's append refused")
								}
								const loaded = yield* Effect.result(db.load({ step: changes }))
								if (Result.isFailure(loaded)) {
									const refused = loaded.failure
									if (refused instanceof OpenError) {
										return assert.fail(`${label} failed with ${refused._tag}: ${refused.message}`)
									}
									const error = refused.error
									if (!isCompileError(error)) {
										return assert.fail(
											`${label}: no served call can supply it: ${Formatter.format(error)}`
										)
									}
									const reason = error.reason
									if (reason._tag === "UnorderableStratum") {
										const cycle = reason.cycle
										for (const [k, at] of cycle.entries()) {
											const next = defined(cycle[(k + 1) % cycle.length], "the cycle's next write")
											assert.ok(
												justified(spec, keys, putsOf(spec, state, step), at, next),
												`${label}: refused with UnorderableStratum, whose order ${at.relation} ${at.op} before ${next.relation} ${next.op} no write of the stratum requires; the cycle: ${Formatter.format(cycle)}`
											)
										}
										c.note("a stratum no order keeps refused")
										return
									}
									if (expected.kind === "uncompiled") {
										if (reason._tag === "UnsupportedOperation" && expected.later) {
											c.note("a refill after an earlier stratum refused")
											return
										}
										if (reason._tag === "UnsupportedOperation" && expected.partial) {
											c.note("a delete leaving another owner's groups partial refused")
											return
										}
										if (reason._tag === "StaleDerivedRead") {
											const cause = reason.cause
											assert.ok(
												statesCause(spec, expected, cause),
												`${label}: refused as stale (${Formatter.format(cause)}), a cause the reference does not state: ${Formatter.format(expected)}`
											)
											assert.ok(
												Arr.some(
													expected.origins,
													(w) => w.relation === reason.member && w.op === reason.op
												),
												`${label}: the refusal names a ${reason.op} of ${reason.member} as the write that leaves a value stale, none of the writes whose path first reaches a refill (${Formatter.format(expected.origins)}): ${error.message}`
											)
											c.note(causeNote(cause))
											return
										}
									}
									return assert.fail(
										`${label}: refused when it compiles, ${error.message}, where the oracle expects ${expected.kind}`
									)
								}
								const served = memberCalls(flight.context, member(loaded.success, "step"))
								const applied = yield* Effect.result(
									flight.judged(label, writeAnswerOf(writeOnce(served)({ params, facts })))
								)
								if (Result.isFailure(applied)) {
									return assert.fail(
										`${label} failed with ${applied.failure.kind}: ${applied.failure.message}`
									)
								}
								const outcome = applied.success
								switch (expected.kind) {
									case "uncompiled":
										return assert.fail(
											`${label}: ${outcome.kind}, where the reference finds it refused when it compiles: ${Formatter.format(expected)}`
										)
									case "refused": {
										assert.equal(
											outcome.kind,
											"refused",
											`${label}: the laws ${Formatter.format([...expected.laws])} are broken`
										)
										if (outcome.kind !== "refused") {
											return
										}
										const named = Arr.map(refusedEntries(outcome.refused), (law): LawId =>
											names.reported(law)
										)
										const broken = (law: LawId) => expected.laws.has(law)
										assert.ok(
											outcome.refused.kind === "every"
												? Arr.every(named, broken)
												: Arr.some(named, broken),
											`${label}: refused by ${Formatter.format(named)} (${outcome.refused.kind}), where the laws broken are ${Formatter.format([...expected.laws])}`
										)
										yield* storesExactly(done, spec, built, state, `the refused ${label}`)
										c.note("an unlawful write refused by a law it breaks")
										if (step.kind === "insert" && step.conflict !== undefined) {
											c.note("two facts at one key refused by its key")
										}
										if (step.kind === "insert" && step.orphan !== undefined) {
											c.note("a member naming no owner refused by its family")
										}
										return
									}
									case "written": {
										assert.equal(outcome.kind, expected.changed ? "accepted" : "unchanged", label)
										yield* storesExactly(done, spec, built, expected.next, label)
										c.noteAll(stepShapes(spec, state, step, expected))
										state = expected.next
									}
								}
							}
						}).pipe(Effect.scoped)
					}).pipe(Effect.scoped),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "second-implementation",
			name: "the reference writer (families/fill.ts writtenRows) and the law model (laws/model.ts) over the facts written"
		},
		budget: { runs: 24, steered: 160 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:1"
				),
				reason:
					"VALUEONE's run at 95b9ad11: a follow-up puts R3, the mutable owner of an ordered family whose generated, immutable R4 members copy R3's caller field, stated twice, so its second put of R3 is a query member; the compile refuses it as a put from a query leaving R4's copy stale (StaleDerivedRead, cause query), checked before the immutable refill, where the reference stated the immutable R4 alone",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:r"
				),
				reason:
					"pantry's importWrite (1ce7c08f, drawn alone by the deleted test/pg/write/stratum-order): R2's rows name R1's rows whole and own R3's, every owner immutable, all in one stratum; one additions statement for R1's and R3's rows could land neither before nor after R2's insert, and the stratum was refused as UnorderableStratum",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:2"
				),
				reason:
					"pantry's importWrite with its nesting (f6f1afbf, drawn alone by the deleted test/pg/write/stratum-order): R0's insert nests its ordered R4 members beside the stratum whose rows land on both sides of R2's insert, so the family planner plans it, every relation mutable; then a delete of everything, R2's rows before the R1 rows they name",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:3"
				),
				reason:
					"two counted families on a cycle, each a member of the other's owner and each copying its owner's caller field, both rows inserted by their slots: each additions statement read the other's rows from the table, so each followed the other and the stratum was refused as UnorderableStratum, where the slots hold every value copied",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:4"
				),
				reason:
					"TEST_SEED=2029266199's case 2: a cycle of families, a counted family whose members copy their owner's caller field and a sequence of its owners nested under them, inserted with no rows: its additions read the copied owners' rows after the statement that nests them, which follows theirs by its owner axis, so the stratum was refused as UnorderableStratum",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:5"
				),
				reason:
					"unit/write/fill-order's TEST_SEED=2002821052, case 38, written: a counted family whose members copy their owner's generated g and a sequence of its owners nested under them, one member's owner nested under that member: its additions read g from the table after the statement that nests the owners, which follows theirs by its owner axis, so the stratum was refused as UnorderableStratum, where the nested rows hold the v that g is generated from",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:6"
				),
				reason:
					"TEST_SEED=881675980's case 2, its shape alone: two counted families on a cycle, R0's summing its R1 members' copy of R0's caller field, each relation inserted by its slot: R1's slot, an owner's, carried every drawn and accumulated column of R1 at its start, its copy among them, which the fresh owner's fill read as given, so R0's end was written at the sum of starts and its fold's foreign key refused a lawful write",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:7"
				),
				reason:
					"TEST_SEED=1608381433's case 10: an ordered member's put beside an append to the counted family it owns, whose count its stored members copy, the owner axis deferred since the put re-places the owner; the planner on the host refused it, its members' copies left stale",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:0.1.0.0.0.0.0.0.0.0.0.3.0.0.0.0.0.0.3.0.0.0.0.0.0.0.0.0.0.0.3.0.0.0.0.0.0.0.0.0.0.0.1.0.2.1.3"
				),
				reason:
					"1bf3dbb: a counted family's or end, its owner inserted beside its members, one member per fact",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:8"
				),
				reason:
					"e9227af: the owners with one member contained in their members, on a cycle with the counted family's owner axis, and an owner's check over its count",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:9"
				),
				reason:
					"8310ede: an ordered member deleted, a counted member inserted and their counts, beside a pure set both read gaining a value, in one stratum",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:a"
				),
				reason:
					"75fed88: a cycle of families, R1 owning an ordered family of R0 and R0 a counted family of R1, written by one nested insert",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:b"
				),
				reason:
					"an ordered member's delete re-places the next, which owns a counted member copying its index along an owner axis",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:s"
				),
				reason:
					"72f7d03: an owner fact stated twice at its key with another v and the same nested member",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:c"
				),
				reason:
					"refill: an owner's put changing the v its counted members copy, which their fold steps, beside two more members inserted under it",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:d"
				),
				reason:
					"found: a counted member inserted beside a pure set its relation reads trading one value for another, refused as unorderable through an update in place that changes no value the key reads",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:e"
				),
				reason:
					"found: a counted member that owns a sequence appended to a stored owner's group, on a cycle of families, dies binding its edit",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:f"
				),
				reason:
					"found: a put from a query into a relation with a generated field dies compiling its insert",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:g"
				),
				reason:
					"found: a put of an ordered member whose g its owner's last copy reads, read again by a tree's last copy, beside a referrer's put: once refused as a refill cycle naming the referrer's put as its write, then refilled on the host from a read, now refused when it compiles as a refill of the tree's values",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:h"
				),
				reason:
					"found: a counted family's sum fold stepping its member's copy along an ordered family's owner axis, once refused as unfillable where the reference admits it, written and refilled after the ordered owner's put",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:t"
				),
				reason:
					"found: a first counted member inserted under a stored owner whose members copy the owner's generated field dies encoding the edit",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:u"
				),
				reason:
					"found: an immutable counted member that owns a counted family, inserted beside its own members, once inserted at its empty family's count and max end, which its members' owner axis refuses",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:i"
				),
				reason:
					"found: a mutable owner's counted members, immutable, owning it back in a counted family with a sum fold, all inserted in one stratum, once refused for the immutable owner's empty count",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:j"
				),
				reason:
					"found: a counted member's members inserted beside it, named before it, their owner axis immediate, once appended by a statement that ran before their owner's, as the relations' names ordered them",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:k"
				),
				reason:
					"found: a put of a stored ordered member that owns a counted family, beside a member appended to it, once written with the put fact's count at its start over the stored one by the family planner",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:l"
				),
				reason:
					"a put of an owner whose v two owner axes carry, into an ordered family's members' copies and on into a counted family's members' copies, which its sum fold steps: the refill reaches the fold through the middle relation's rows, which the stratum neither puts nor deletes, and rides in the call's one flight",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:m"
				),
				reason:
					"a put of an owner whose ordered members copy its v along the owner axis and that copy along their predecessor axis, beside a delete of one of those members: the members' removals statement draws the delete's re-placements and the put's refill together in the call's one flight",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:n"
				),
				reason:
					"a put of an owner whose counted members copy its v, which their sum fold steps, beside a member appended under it, whose recount the stored members' copies of the count take: one member relation refilled from the owner's put and recounted by the append, both in the call's one flight",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:o"
				),
				reason:
					"found failing alike at 9059cfc2 and every pin after it, shrunk with no budget: R6's rows, nested under R3's insert in an ordered family, append to the counted families of R5, an immutable owner whose further facts the ChangeSet wrote one member per fact, each from a query; the served compile refused such an owner's write only beside a member write of its own, so R5's rows went in at their counts' starts and R6's foreign key into R5's n6 refused the lawful insert",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:v"
				),
				reason:
					"KEYEDWRITE's red (TEST_SEED=3927981720, the rotating stream, case 8), reduced by hand to the two relations it needs, since a shrink with no budget drifted to another failure: R1's counted members copy R0's generated g (g = v) along its owner axis and sum the copy into R0's end; a put of R0's v alone changes g, which the put's cascade carries into the copy, and the refill ahead of it drew the members' running sums from the stored g, so the cascade's row broke the fold's CHECK",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:p"
				),
				reason:
					"TEST_SEED=2978792241's rotating case 13 at grizzle 4f7ecea5: R0, its own tree, owns a counted family of R2, and R2 is also a member of R4's counted n6; two R0 rows are inserted and a delete of everything by field equality names R0 alone, since R4 holds no row. The compile refuses it as UnsupportedOperation, R2's rows nested under R0 being members of a family whose owner R4 the stratum does not delete, as the README states; the oracle expected it written",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:q"
				),
				reason:
					"FRESHDRAW's rotating-stream case at grizzle 4083315c3: R1 owns the counted n0 of R2, R2 the counted n1 and the ordered n3 of R0, and R0 the ordered n2 of R1, so the owner keys run around R1, R0 and R2, n0's deferred (R1 is re-placed by a put) and n1's and n2's immediate; a follow-up puts R1's row 7 and nests two new R2 rows under it. Its additions insert R1's row again with its n0 members riding it, R2's rows at their copies of its count, which no reference from R0 reads; the compile ordered every rider's rows as appended, put R1's additions before R0's along R0's key into R2 and after them along R1's key into R0, and refused the stratum as UnorderableStratum, where R2's additions, then R0's, then R1's keep every immediate key",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/swarm/families.test.ts#theFamilyWriterUnderASwarmEveryLawfulChangeSetStoresTheReferencesRowsEveryUnlawfulOneIsRefusedByALawItBreaksAndEveryRefusalWhenItCompilesIsOneTheOracleStates:-:0.0.0.0.1.1.1.0.0.1.1.1.0.1.1.0.0.1.0.1.1.1.1.1.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.1.0.0.1.3.1.0.1.0.0.0.1.1.0.0.1.2.0.0.0.2.0.0.1.0.0.1.1.0.0.0.0.0.0.0.0.1.1.0.3.3.0.0.0.0.1.0.1.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"CO-PG's case at grizzle 9653f3d5c: R1 owns counted, ordered and counted families of R2 and the owner-into-members law of the first, and a plain insert of one R1 row with no member is refused at COMMIT by that law's deferred foreign key, so the shell sends the diagnosis flight (adapter/apply/run.ts unmatchedWitness) and the call takes two round trips, which the one-flight judge refused as `round trips on the wire 2 !== 1` until it admitted a diagnosis after a refusal at COMMIT by a deferred foreign key",
				since: "2026-11-23"
			}
		],
		kills: [
			{
				file: "packages/grizzle/src/adapter/apply/run.ts",
				original: 'runFramed(session, { ...frame, end: "ROLLBACK" }, [',
				replacement: "runFramed(session, frame, [",
				why: "The diagnosis of a refusal at COMMIT ends as the write's own flight does, with COMMIT, where it ends ROLLBACK: an unlawful write a deferred foreign key refuses at COMMIT, such as an owner the owner-into-members law leaves with no member, sends a second flight that tries to commit the write's statements again, which the one-flight judge refuses as a diagnosis not ending ROLLBACK, if the shell has not already died on the COMMIT the diagnosis met."
			}
		]
	})
