/**
 * The worlds generators (test/support/worlds/generate), each against the harness's own rules, which judge what a
 * generator drew without the generator's help:
 *
 * - Invalid kinds: every invalid kind of the vocabulary is offered by some witness state, and every draw of its
 *   generator there is classified as that kind (generate/classify.ts invalidKindsOf), names only sessions the state
 *   holds, keeps the serial rule (drive/index.ts serial) and is offered (generate/offered.ts). The witness states are
 *   each fixture over the empty reality and lawful realities drawn on the label's floor stream, under every session
 *   layout, the folder applied or left unfinished. Every kind of the vocabulary is a required situation, which a
 *   witness whose turn aims at it reaches (invalidKindSpace).
 * - Actions: under swarm weights, every drawn action keeps the same harness rules; walks reach live and invalid ones.
 * - Realities: every drawn reality of every base breaks no law, is its own repair, holds one fact per primary key, and
 *   every value in its field's domain.
 * - Installations: a lawful one breaks no write-list rule, a planted one is classified as its defect, every role sits
 *   in exactly one login, and every query entry is one grizzle builds (ruleFaults).
 * - Forced moves: under weights of zero, a state with no live session draws a forced move, and any other an offered
 *   kind; an open is live and a direct writer begins SERIALIZABLE. The forced moves are restated here from the model's
 *   own state (forcedOf), apart from the offering the generator draws by (generate/offered.ts forcedMoves), which must
 *   agree with them.
 * - The small box: from every reality of the box, after drawn steps, the box's actions in a state are duplicate-free up
 *   to renaming the values the state does not hold, cover every kind the state offers, and keep the serial rule.
 *
 * Oracles: the specification, each rule above stated apart from the generator it judges but one. Whether a kind is
 * offered (the invalid kinds, the actions, and the small box's cover) is judged by generate/offered.ts applicable and
 * namesOffered, the policy actionGen and the box draw through, so a fault in that policy moves its judge with it; only
 * the features that every action kind is reached notice a kind it drops. The policy is the serial driver's schedule and
 * what the model leaves to the runner, not a refusal the model states: the model's step (model/step.ts) takes a
 * perturbation and a second direct transaction where the policy offers neither (a direct transaction open, a folder
 * unfinished, the catalog past its contract), so it cannot judge the policy, and a copy of the policy here would drift
 * with it. Features: every invalid
 * kind; live and invalid actions; realities with facts and empty; every installation kind, two logins and a query
 * entry; each forced move and an unforced one; the box's kinds.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, Record } from "effect"
import { assert } from "#test/support/assert.ts"
import { projection, violations } from "#test/support/laws/model.ts"
import { serial } from "#test/support/worlds/drive/index.ts"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import { invalidKindsOf } from "#test/support/worlds/generate/classify.ts"
import { inDomain, knownNonEmpty } from "#test/support/worlds/generate/domain.ts"
import { defaultScope, enumerateActions } from "#test/support/worlds/generate/enumerate.ts"
import { applicable, forcedMoves } from "#test/support/worlds/generate/offered.ts"
import { lawfulOf } from "#test/support/worlds/generate/reality.ts"
import { actionKinds } from "#test/support/worlds/generate/weights.ts"
import { installKinds } from "#test/support/worlds/invalid/migrations.ts"
import { docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import { ruleFaults } from "#test/support/worlds/model/host.ts"
import { initialState, settle, step } from "#test/support/worlds/model/step.ts"
import type { ActionKind } from "#test/support/worlds/model/types.ts"
import { invalidKindWords } from "#test/unit/world-model/generate.dictionary.ts"
import {
	actionsGen,
	boxGen,
	canonicalAction,
	docs,
	type Feature,
	forcedGen,
	forcedOf,
	holdsHarnessRules,
	type InstallFeature,
	installsGen,
	invalidKindSpace,
	offering,
	realitiesGen
} from "#test/unit/world-model/generate.fixtures.ts"

/** The worlds generators draw every invalid kind where a witness state offers it, each draw of its kind, naming held sessions under the serial rule. */
export const theWorldsGeneratorsDrawEveryInvalidKindWhereAWitnessStateOffersItEachDrawOfItsKindNamingHeldSessionsUnderTheSerialRule =
	property.explore(invalidKindSpace, {
		needs: {},
		situations: Arr.map(invalidKindWords, (k): Feature => `invalid:${k}`) satisfies ReadonlyArray<
			Reached<Feature>
		>,
		check: (_, c: Case<Feature>) => (kind) =>
			Effect.sync(() => {
				const offered = Arr.findFirst(offering, (w) => w.invalidGen(kind) !== undefined)
				if (Option.isNone(offered)) {
					return assert.fail(`no witness state offers ${kind}`)
				}
				const state = offered.value.state
				const gen = offered.value.invalidGen(kind)
				if (gen === undefined) {
					return assert.fail(`the witness state stopped offering ${kind}`)
				}
				const action = c.draw(gen)
				const found = invalidKindsOf(state, action)
				assert.ok(
					found.includes(kind),
					`drawn for ${kind}, a ${action.kind} classified ${Arr.join(found, ", ")}`
				)
				holdsHarnessRules(state, action)
				c.note(`invalid:${kind}`)
			}),
		oracle: {
			kind: "specification",
			name: "the invalid-kind classifier and the harness rules, judging each draw of a kind"
		},
		kept: [],
		kills: []
	})

/** The worlds generators draw actions under swarm weights that name only sessions the state holds, keep the serial rule, and are offered. */
export const theWorldsGeneratorsDrawActionsUnderSwarmWeightsThatNameOnlySessionsTheStateHoldsKeepTheSerialRuleAndAreOffered =
	property.explore(actionsGen, {
		needs: {},
		situations: ["live", "invalid"] satisfies ReadonlyArray<Reached<"live" | "invalid">>,
		check:
			(_, c: Case<"live" | "invalid">) =>
			({ state, actions }) =>
				Effect.sync(() => {
					for (const action of actions) {
						holdsHarnessRules(state, action)
						c.note(invalidKindsOf(state, action).length === 0 ? "live" : "invalid")
					}
				}),
		oracle: {
			kind: "specification",
			name: "the harness rules: held sessions, the serial rule, what the state offers"
		},
		kept: [],
		kills: []
	})

/** The worlds generators draw lawful realities of every base: each fact in its domain, one per primary key, repair a no-op on them. */
export const theWorldsGeneratorsDrawLawfulRealitiesOfEveryBaseEachFactInItsDomainOnePerPrimaryKeyRepairANoOpOnThem =
	property.explore(realitiesGen, {
		needs: {},
		situations: ["facts", "empty"] satisfies ReadonlyArray<Reached<"facts" | "empty">>,
		check:
			(_, c: Case<"facts" | "empty">) =>
			({ base, state, reality }) =>
				Effect.sync(() => {
					assert.deepEqual(violations(state.host, reality), [], "the drawn reality breaks a law")
					assert.equal(
						lawfulOf(state.host, reality),
						reality,
						"repairing a lawful reality changed it"
					)
					const count = Arr.reduce(base.relations, 0, (n, relation) => {
						const facts = reality.get(relation.name) ?? []
						const keys = new Set(Arr.map(facts, (f) => projection(f, relation.key)))
						assert.equal(
							keys.size,
							facts.length,
							`two facts of ${relation.name} share a primary key`
						)
						const outside = Arr.flatMap(facts, (fact) =>
							Arr.filter(relation.fields, (field) => {
								const v = fact[field.name]
								return v === undefined || !inDomain(field.domain, v)
							})
						)
						assert.deepEqual(
							Arr.map(outside, (f) => f.name),
							[],
							`a fact of ${relation.name} holds a value outside its field's domain`
						)
						return n + facts.length
					})
					c.note(count > 0 ? "facts" : "empty")
				}),
		oracle: {
			kind: "specification",
			name: "the law model's violations, the repair's fixed point, keys and domains"
		},
		kept: [],
		kills: []
	})

/** The worlds generators draw installations whose rules the host model admits, lawful or with one write-list defect planted. */
export const theWorldsGeneratorsDrawInstallationsWhoseRulesTheHostModelAdmitsLawfulOrWithOneWriteListDefectPlanted =
	property.explore(installsGen, {
		needs: {},
		situations: [
			"live",
			"install:unwritable-write",
			"install:two-writes-one-relation",
			"two logins",
			"query"
		] satisfies ReadonlyArray<Reached<InstallFeature>>,
		check:
			(_, c: Case<InstallFeature>) =>
			({ kind, install }) =>
				Effect.sync(() => {
					const found = installKinds(install)
					if (kind === "live") {
						assert.deepEqual(found, [], "a lawful installation breaks the writable rule")
					} else {
						assert.ok(
							found.includes(kind),
							`planted as ${kind}, classified ${Arr.join(found, ", ")}`
						)
					}
					c.note(kind)
					const roles = new Set(Arr.map(install.roles, (r) => r.name))
					const held = Arr.flatMap(install.logins, (l) => l.roles)
					assert.equal(held.length, roles.size, "a role in two logins, or in none")
					assert.deepEqual(new Set(held), roles, "a login holds a role the installation lacks")
					if (install.logins.length > 1) {
						c.note("two logins")
					}
					const queries = Arr.flatMap(install.roles, (role) =>
						Arr.flatMap(Record.toEntries(role.entries), ([name, entry]) =>
							entry.kind === "query" ? [{ role: role.name, name, rules: entry.rules }] : []
						)
					)
					if (queries.length > 0) {
						c.note("query")
					}
					for (const q of queries) {
						assert.deepEqual(
							ruleFaults(install.base, q.rules),
							[],
							`${q.role}.${q.name} is no query grizzle builds`
						)
					}
				}),
		oracle: {
			kind: "specification",
			name: "the write-list classifier, the login partition and the rule-fault checker"
		},
		kept: [],
		kills: []
	})

/** The worlds generators draw the forced moves under weights of zero, and only live inputs under validity of zero. */
export const theWorldsGeneratorsDrawTheForcedMovesUnderWeightsOfZeroAndOnlyLiveInputsUnderValidityOfZero =
	property.explore(forcedGen, {
		needs: {},
		situations: ["forced open-db", "forced direct-begin", "unforced"] satisfies ReadonlyArray<
			Reached<`forced ${ActionKind}` | "unforced">
		>,
		check:
			(_, c: Case<`forced ${ActionKind}` | "unforced">) =>
			({ state, action }) =>
				Effect.sync(() => {
					const forced = forcedOf(state)
					assert.deepEqual(
						Arr.sort(forcedMoves(state), Order.String),
						Arr.sort(forced, Order.String),
						"the generator's forced moves are the ones the model's state forces"
					)
					if (forced.length > 0) {
						assert.ok(
							forced.includes(action.kind),
							`with no open session, a ${action.kind} was drawn, not ${Arr.join(forced, " or ")}`
						)
						c.note(`forced ${action.kind}`)
					} else {
						assert.ok(applicable(state, action.kind), `a ${action.kind} the state does not offer`)
						c.note("unforced")
					}
					if (action.kind === "open-db") {
						assert.deepEqual(
							invalidKindsOf(state, action),
							[],
							"an open under validity of zero drew an invalid input"
						)
					}
					if (action.kind === "direct-begin") {
						assert.equal(
							action.isolation,
							"serializable",
							"a direct writer under validity of zero began below SERIALIZABLE"
						)
					}
				}),
		oracle: {
			kind: "specification",
			name: "the forced moves and the offered kinds of the state"
		},
		kept: [],
		kills: []
	})

/** The worlds generators enumerate a finite box, duplicate-free up to renaming, covering every action kind the state offers. */
export const theWorldsGeneratorsEnumerateAFiniteBoxDuplicateFreeUpToRenamingCoveringEveryActionKindTheStateOffers =
	property.explore(boxGen, {
		needs: {},
		situations: [
			"kind open-db",
			"kind direct-begin",
			"kind migrate",
			"kind tamper",
			"kind drift",
			"kind wild"
		] satisfies ReadonlyArray<Reached<`kind ${ActionKind}`>>,
		check:
			(_, c: Case<`kind ${ActionKind}`>) =>
			({ reality, steps }) =>
				Effect.sync(() => {
					let state = initialState(docsInstall, docs.state.names, reality)
					for (let taken = 0; taken < steps; taken += 1) {
						const offered = enumerateActions(state, defaultScope)
						const [firstKind, ...moreKinds] = [...new Set(Arr.map(offered, (x) => x.kind))]
						if (firstKind === undefined) {
							break
						}
						const kind = c.draw(element([firstKind, ...moreKinds]))
						const ofKind = knownNonEmpty(
							Arr.filter(offered, (x) => x.kind === kind),
							"the box's actions of a kind"
						)
						state = settle(
							c.draw(element(step(state, c.draw(element(ofKind))))),
							installedNames
						).next
					}
					const actions = enumerateActions(state, defaultScope)
					const keys = Arr.map(actions, (x) => canonicalAction(state, x))
					assert.equal(
						new Set(keys).size,
						keys.length,
						"the box holds one action twice, up to renaming unheld values"
					)
					for (const kind of actionKinds) {
						if (applicable(state, kind)) {
							assert.ok(
								Arr.some(actions, (x) => x.kind === kind),
								`the state offers a ${kind} and the box holds none`
							)
						}
					}
					for (const x of actions) {
						c.note(`kind ${x.kind}`)
						assert.ok(serial(state, x), `the box holds a ${x.kind} the serial rule refuses`)
					}
				}),
		oracle: {
			kind: "specification",
			name: "the box's canonical form up to renaming, the offered kinds and the serial rule"
		},
		kept: [],
		kills: []
	})
