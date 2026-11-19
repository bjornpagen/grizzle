/**
 * A derived relation over vectors on PostgreSQL 19: the viewer of a view of embeddings reaches the vector type only
 * through the view, runs under the search policy, reads its vectors exactly, and is refused a search over it.
 *
 * - Privileges: the viewer holds the view and not the tables or the type behind it.
 * - Policy: the viewer's session shows the search policy before and after the vector library loads, and the snapshot
 *   names it as the login's defaults.
 * - Exact reads: for each account and a drawn probe, the viewer's typed scoring of the view delivers exactly the
 *   owner's complete scan of it, scored with pgvector's own operator.
 * - Refusal: an approximateNearest over the view is refused by the checker, and by a served workload's compile at the
 *   program.
 *
 * Oracle: a second implementation, the owner's complete scan of the view scored with pgvector's <=>.
 *
 * Features: each account scored, and a search over the view refused.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { element, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { checkQuery } from "#compiler/check/index.ts"
import * as Result from "#compiler/core/result.ts"
import { searchPolicySettings } from "#compiler/physical/ddl/roles.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { workload as servedPrograms } from "#compiler/program/workload/value.ts"
import { admittedPolicy, textRows, vectorParam, vectorText } from "#test/pg/vector/ann/support.ts"
import {
	derivedAccountA,
	derivedAccountB,
	openedIn,
	reportsTemplate,
	policySettings,
	type ViewCase,
	type ViewFeature
} from "#test/pg/vector/derived/derived.fixtures.ts"
import { assert, defined, refused } from "#test/support/assert.ts"
import { rowsOf } from "#test/support/calls.ts"
import { roleNamesOf } from "#test/support/kernel/naming.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { servedJson } from "#test/support/served-db.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/**
 * ApproximateNearest over a derived relation the viewer reaches the vector type only through the view, runs under the search policy, reads its vectors exactly, and is refused a search over it.
 *
 * Its pre-conversion budget: runs 8, coverage cases 12 (test/pg/vector/derived/derived.test.ts at d8eed1786).
 */
export const approximateNearestOverADerivedRelationTheViewerReachesTheVectorTypeOnlyThroughTheViewRunsUnderTheSearchPolicyReadsItsVectorsExactlyAndIsRefusedASearchOverIt =
	property.explore(
		(source): ViewCase => ({
			account: source.draw(element(["A", "B"] as const)),
			probe: source.draw(int(0, 99)),
			take: source.draw(int(1, 20))
		}),
		{
			needs: { reports: Substrate.freshOf(reportsTemplate) },
			situations: [
				"account A scored",
				"account B scored",
				"a search over the view refused"
			] satisfies ReadonlyArray<Reached<ViewFeature>>,
			check:
				({ reports }, k: Case<ViewFeature>) =>
				(c) =>
					Effect.flatMap(reports, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(taken)
								const s = yield* Substrate
								const viewer = o.installed.role(o.fixture.viewer)
								const session = yield* s.session({
									...worldSession(o.installed.world(o.fixture.viewer)),
									label: "viewer"
								})
								return yield* Effect.gen(function* () {
									const db = yield* Db.open(o.served.login.roles.viewer, {})

									/** The viewer's own view is its one path to the vector type. */
									const privileges = yield* s.admin.queryValues(
										`SELECT pg_catalog.has_table_privilege($1::text, $2::text, 'SELECT')::text, pg_catalog.has_table_privilege($1::text, $3::text, 'SELECT')::text, pg_catalog.has_table_privilege($1::text, $4::text, 'SELECT')::text, pg_catalog.has_table_privilege($1::text, $5::text, 'SELECT')::text, pg_catalog.has_schema_privilege($1::text, 'vector_ext', 'USAGE')::text`,
										[
											viewer,
											roleNamesOf(o.installed, o.fixture.viewer).view("Embeddings"),
											o.table("Embeddings"),
											o.table("Document"),
											o.table("DocumentEmbedding")
										]
									)
									assert.deepEqual(textRows(privileges), [
										["true", "false", "false", "false", "true"]
									])
									for (const p of searchPolicySettings) {
										const rows = yield* session.values(`SHOW ${p.parameter}`, [])
										assert.deepEqual(rows, [[p.value]], p.parameter)
									}
									yield* session.values(
										`SELECT vector_ext.vector_dims('[1]'::vector_ext.vector)`,
										[]
									)
									for (const p of searchPolicySettings) {
										const rows = yield* session.values(`SHOW ${p.parameter}`, [])
										assert.deepEqual(rows, [[p.value]], p.parameter)
									}
									assert.deepEqual(
										admittedPolicy(o.installed.snapshot, o.installed.as(o.fixture.server).role),
										policySettings
									)
									const account = c.account === "A" ? derivedAccountA : derivedAccountB
									const vector = o.probe(c.probe)
									/**
									 * A complete scan of the view, as the owner sees it: every embedded document of the
									 * account with the native distance, the same C function `cosine_distance` calls.
									 */
									const oracle = yield* Effect.map(
										s.admin.queryValues(
											`SELECT "document"::text, ("value" OPERATOR(vector_ext.<=>) $1::vector_ext.vector)::text FROM ${o.table("Embeddings")} WHERE "account" = $2::uuid ORDER BY 1`,
											[vectorText(vector), account]
										),
										textRows
									)
									assert.notDeepEqual(oracle, [], "the view holds the account's embedded documents")
									const rows = yield* rowsOf(
										db.workload.scored.once({
											params: {
												account,
												vector: vectorParam(vector)
											},
											facts: {}
										})
									)
									const pairs: ReadonlyArray<ReadonlyArray<string | number>> = Arr.map(
										rows,
										(r) => [r.document, r.distance]
									)
									assert.deepEqual(
										Arr.sortWith(pairs, (row) => String(row[0]), Order.String),
										Arr.map(oracle, ([document, distance]) => [
											defined(document, "a document"),
											Number(distance)
										])
									)
									k.note(c.account === "A" ? "account A scored" : "account B scored")
									/**
									 * A ranked vector must be a stored relation's field: a search over the view is refused by the
									 * checker, and by the compile of a served workload that holds it, at the program.
									 */
									const nearest = o.fixture.scored.approximateNearest({
										by: "distance",
										take: c.take
									})
									refused(
										Result.flatMap(queryInput(nearest), (input) =>
											checkQuery(checking(o.fixture.viewer), input.desc, checkOptions("query"))
										),
										"UnsupportedOperation",
										"the checker refuses the search"
									)
									const refusal = yield* Effect.flip(
										Effect.asVoid(
											servedJson(o.installed, o.fixture.server, [
												servedPrograms(o.fixture.viewer, { nearest })
											])
										)
									)
									assert.deepEqual(refusal.place, {
										kind: "program",
										role: "viewer",
										program: "nearest"
									})
									k.note("a search over the view refused")
								}).pipe(Effect.scoped, withLayer(o.served.layer))
							}),
							Substrate,
							taken.substrate
						)
					),
			oracle: {
				kind: "second-implementation",
				name: "the owner's complete scan of the view, scored with pgvector's own operator"
			},
			budget: { runs: 8, steered: 12 },
			kept: [],
			kills: []
		}
	)
