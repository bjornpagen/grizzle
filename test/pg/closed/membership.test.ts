/**
 * R07 over a closed relation's installed constants (lower/optimize/closed): a query that only tests membership of a
 * declared closed relation's every fact reads one bit of the relation's installed key set (closedHas, lowered by
 * lower/conservative/expr closedRead to `inSet(keys, mixedRadix(key))`), and it delivers exactly what the same query
 * delivers with the relation joined as a VALUES list of its facts' codes, the conservative artifact of the same
 * template. PostgreSQL runs both, so the oracle is the VALUES join, a second implementation that shares nothing with
 * the constant's packing or its mixed-radix read; the model's own verdict (each item whose key the facts hold) is
 * checked beside it.
 *
 * Each case draws one to three rosters, each with a valid history of A8's model (test/support/closed/generate.ts:
 * growth, removals weighted up, re-additions), so its codes have holes and a live handle's code is often past its
 * declared position; a closed relation keyed by one closed id of each, holding a drawn subset of their live key
 * points, so the key set is sparse, empty or full, with an integer payload or none; and a stored relation holding one
 * item at every live key point. The installation is planned under the history's codes, as a deployment reaches them.
 * The query matches the items and the relation, each key field read as an item's variable, a literal handle or a
 * parameter, and finds the items' ids.
 *
 * The verdicts agree on every case. That R07 read the key set, its certificate recorded, is a required feature, so a
 * search whose cases never reach the rewrite fails as unreached rather than comparing the conservative read with
 * itself; which rewrite the optimizer chose, and the SQL text it printed, are its own, never asserted.
 *
 * Features: a key code past its declared position, a key of two fields or more, a parameter and a literal key field, a
 * payload left unread, no fact, every live point a fact, a sparse key set, and R07's read.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import {
	caseGen,
	deliveredIds,
	itemIdsOf,
	itemsInsert,
	type MembershipFeature,
	modelIds,
	notesOf,
	paramsOf,
	queryOf,
	schemaOf,
	sorted
} from "#test/pg/closed/membership.fixtures.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { codebookOfStates } from "#test/support/closed/generate.ts"
import {
	compileTemplate,
	installationSql,
	installedCodes,
	testCompile
} from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { ownedInput } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * R07 over closed constants a membership read through the installed key set delivers what the VALUES join delivers.
 *
 * Its pre-conversion budget: runs 48, coverage cases 48 (test/pg/closed/membership.test.ts at d8eed1786).
 */
export const r07OverClosedConstantsAMembershipReadThroughTheInstalledKeySetDeliversWhatTheVALUESJoinDelivers =
	property.explore(caseGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"a key code past its declared position",
			"a key of two fields or more",
			"a parameter key field",
			"a literal key field",
			"a payload left unread",
			"no fact",
			"every live point a fact",
			"a sparse key set",
			"R07 read the key set"
		] satisfies ReadonlyArray<Reached<MembershipFeature>>,
		check:
			({ substrate }, notes: Case<MembershipFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const name = yield* s.schema({ create: false, label: "membership" })
						const installation = identity.schema(parsedSchemaName(name))
						const codes = codebookOfStates([...c.rosters, itemIdsOf(c)])
						const built = schemaOf(name, c)
						const owned = succeeded(ownedInput(built.base))
						const compiled = succeeded(
							compileInstallation(
								owned,
								completeInstallOptions(owned, [installation], [], [], codes)
							)
						)
						yield* transaction(s.admin, [
							...installationSql(compiled, s.database),
							itemsInsert(compiled.names, c, codes)
						])
						const template = succeeded(
							compileTemplate(queryOf(built, c), built.base, {
								...testCompile,
								installation,
								codes: installedCodes(codes)
							})
						)
						const [optimized] = template.optimized
						const [conservative] = template.conservative
						assert.equal(template.optimized.length, 1, "the query is one statement")
						const params = paramsOf(c)
						const declared = { params: template.params, codes }
						const rewritten = yield* deliveredIds(defined(optimized), params, declared)
						const joined = yield* deliveredIds(defined(conservative), params, declared)
						assert.deepEqual(
							rewritten,
							joined,
							`the key set's read and the VALUES join deliver one set of items:\n${defined(optimized).sql}`
						)
						assert.deepEqual(
							joined,
							sorted(modelIds(c)),
							"the VALUES join delivers the model's items"
						)
						if (Arr.some(template.certificates, (cert) => cert.rule === "R07.closedMembership")) {
							notes.note("R07 read the key set")
						}
						notes.noteAll(notesOf(c))
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "the VALUES join of Grid's facts, the template's conservative artifact, on PostgreSQL; and the model's items whose key Grid holds"
		},
		budget: { runs: 48, steered: 48 },
		kept: [],
		kills: []
	})
