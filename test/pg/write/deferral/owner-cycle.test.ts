import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import type { Statement } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import {
	brokenBy,
	buildOf,
	caseGen,
	type MemberRow,
	type OwnerRow,
	type ReferrerRow,
	type Situation,
	situations,
	uuidOf
} from "#test/pg/write/deferral/owner-cycle.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import { installFullWorld } from "#test/support/installed.ts"
import { lawIdOf, namesOf } from "#test/support/kernel/naming.ts"
import { refusedLaws, refusedEntries } from "#test/support/refused.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A law's key on a cycle with a family's owner axis is deferred, so every lawful write of owners and members is accepted and every other refused by its law.
 *
 * Its pre-conversion budget: runs 16, coverage cases 60 (test/pg/write/deferral/owner-cycle.test.ts at d8eed1786).
 */
export const aLawsKeyOnACycleWithAFamilysOwnerAxisIsDeferredSoEveryLawfulWriteOfOwnersAndMembersIsAcceptedAndEveryOtherRefusedByItsLaw =
	property.explore(caseGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ substrate }, n: CaseOf<Situation>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const built = buildOf(c.spec)
						const declared = built.rename("Cycle")
						const done = yield* installFullWorld(declared, {}, [], {
							ambient: ordinarySession,
							label: "cycle"
						})
						const value = built.rename(done.schema)
						const names = namesOf(done)
						const world = fullWorld(value, {}, [])
						const lawOf = (s: Statement): LawId => lawIdOf(value, s)
						const ownerFact = (o: OwnerRow, nested: boolean) => ({
							id: uuidOf(o.id),
							x: o.x,
							flag: o.flag,
							...(c.spec.family === "ordered"
								? {
										n: nested
											? Arr.map(
													Arr.filter(c.members, (m) => m.owner === o.id),
													(m) => ({ id: uuidOf(m.id), x: m.x, flag: m.flag })
												)
											: []
									}
								: {})
						})
						const memberFact = (m: MemberRow) =>
							c.spec.bare
								? { o: uuidOf(m.owner), x: m.x }
								: { id: uuidOf(m.id), o: uuidOf(m.owner), x: m.x, flag: m.flag }
						const referrerFact = (r: ReferrerRow) => ({
							id: uuidOf(r.id),
							o: uuidOf(r.owner),
							x: r.x
						})
						const withReferrers = (changes: ReturnType<typeof ChangeSet.empty>) =>
							c.spec.referrer ? changes.insert(built.R, []) : changes
						/** R's facts under its relation where the spec holds R, none otherwise. */
						const referred = c.spec.referrer ? { R: Arr.map(c.referrers, referrerFact) } : {}
						const owners = (nested: boolean) => Arr.map(c.owners, (o) => ownerFact(o, nested))
						const members = Arr.map(c.members, memberFact)
						const everything = {
							owners: c.owners,
							members: c.members,
							referrers: c.referrers
						}
						/** Each step: the ChangeSet, its call's facts, and the state it leaves where it is lawful. */
						const steps = [
							...(c.separately
								? [
										{
											state: { owners: c.owners, members: [], referrers: [] },
											changes: ChangeSet.empty(value).insert(built.O, []),
											facts: { insert: { O: owners(false) } }
										},
										{
											state: everything,
											changes: withReferrers(
												c.spec.family === "counted"
													? ChangeSet.empty(value).insert(built.M, [])
													: ChangeSet.empty(value).put(built.M, [])
											),
											facts:
												c.spec.family === "counted"
													? { insert: { M: members, ...referred } }
													: {
															put: { M: members },
															...(c.spec.referrer ? { insert: referred } : {})
														}
										}
									]
								: [
										{
											state: everything,
											changes: withReferrers(
												c.spec.family === "counted"
													? ChangeSet.empty(value).insert(built.O, []).insert(built.M, [])
													: ChangeSet.empty(value).insert(built.O, [])
											),
											facts: {
												insert:
													c.spec.family === "counted"
														? { O: owners(false), M: members, ...referred }
														: { O: owners(true), ...referred }
											}
										}
									]),
							{
								state: { owners: [], members: [], referrers: [] },
								changes: (() => {
									const deleted = ChangeSet.empty(value).delete(built.O, []).delete(built.M, [])
									return c.spec.referrer ? deleted.delete(built.R, []) : deleted
								})(),
								facts: {
									delete: {
										O: Arr.map(c.owners, (o) => ({ id: uuidOf(o.id), x: o.x, flag: o.flag })),
										M: members,
										...referred
									}
								}
							}
						]
						/** Each step's ChangeSet, a member of the full role's workload under its index. */
						const workload = Rec.fromEntries(
							Arr.map(steps, (step, i): readonly [string, unknown] => [
								`step${String(i)}`,
								step.changes
							])
						)
						yield* withServedDb(done, world.server.roles.app, {}, ({ serve }) =>
							Effect.gen(function* () {
								const served = yield* serve(workload)
								let stored: ReadonlyArray<OwnerRow> = []
								let size = 0
								for (const [i, step] of steps.entries()) {
									const broken = brokenBy(
										c.spec,
										built,
										step.state.owners,
										step.state.members,
										step.state.referrers
									)
									const outcome = yield* writeAnswerOf(
										writeOnce(member(served, `step${String(i)}`))({
											params: {},
											facts: step.facts
										})
									)
									const label = `${Formatter.format(c)}, step ${String(i)}`
									if (Arr.isReadonlyArrayNonEmpty(broken)) {
										assert.equal(outcome._tag, "refused", label)
										if (outcome._tag === "refused") {
											const laws = Arr.map(broken, lawOf)
											assert.ok(
												Arr.some(refusedEntries(outcome.refused), (law) =>
													laws.includes(names.reported(law))
												),
												`${label}: refused by ${Formatter.format(refusedLaws(outcome.refused))}, a law the model finds broken`
											)
										}
										n.note("an unlawful write refused with a law it breaks")
										return
									}
									const next =
										step.state.owners.length +
										step.state.members.length +
										step.state.referrers.length
									assert.equal(
										outcome._tag,
										step.state.owners === stored && next === size ? "unchanged" : "accepted",
										label
									)
									stored = step.state.owners
									size = next
								}
								n.note("owners, members and referrers deleted together")
								if (c.spec.referrer && Arr.isReadonlyArrayNonEmpty(c.referrers)) {
									n.note("a plain relation keyed into members written beside them")
								}
								n.noteAll([
									`${c.spec.family}: a lawful write accepted`,
									`${c.spec.law}: a lawful write accepted`,
									`${c.spec.owners}: a lawful write accepted`
								])
								if (c.separately) {
									n.note("owners and members written separately")
								}
							})
						).pipe(Effect.scoped)
					}).pipe(Effect.scoped),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "second-implementation",
			name: "the laws over the facts written, judged directly"
		},
		budget: { runs: 16, steered: 60 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/deferral/owner-cycle.test.ts#aLawsKeyOnACycleWithAFamilysOwnerAxisIsDeferredSoEveryLawfulWriteOfOwnersAndMembersIsAcceptedAndEveryOtherRefusedByItsLaw:-:0.0.1.1.1.1.0.0.0.1.0.1.1.0.0"
				),
				reason:
					"downstream: a counted family keyed by its owner, the owners with one member contained in their members, and an owner's check",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/write/deferral/owner-cycle.test.ts#aLawsKeyOnACycleWithAFamilysOwnerAxisIsDeferredSoEveryLawfulWriteOfOwnersAndMembersIsAcceptedAndEveryOtherRefusedByItsLaw:-:0.1.1.0.0.1.0.0.0.0.0.0.0"
				),
				reason:
					"found: an owner inserted with no member its mirror names, once an UnorderableStratum: the members' additions followed the owner's insert to recount it, and the owner's insert followed the additions by its law's immediate key",
				since: "2026-11-19"
			}
		],
		kills: []
	})
