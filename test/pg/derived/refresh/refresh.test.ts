import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { OpenError } from "#adapter/errors/execution.ts"
import { runRefresh } from "#adapter/refresh/run.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { refreshMember } from "#compiler/program/workload/value.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	build,
	calls,
	leasesNeed,
	levelOrder,
	passed,
	raisedOf,
	type RefreshFeature,
	refusalsOf,
	reportsTemplate,
	unbuilt,
	viewsOf
} from "#test/pg/derived/refresh/refresh.fixtures.ts"
import { assert, assertVariant, succeeded } from "#test/support/assert.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A refresh member is refused where it is built or compiled unless it names in-scope derived relations of the schema, and otherwise refreshes exactly what it names, once each, in level order, plain until populated.
 */
export const aRefreshMemberIsRefusedWhereItIsBuiltOrCompiledUnlessItNamesInScopeDerivedRelationsOfTheSchemaAndOtherwiseRefreshesExactlyWhatItNamesOnceEachInLevelOrderPlainUntilPopulated =
	property.exhaust(finite(calls), {
		needs: { reports: Substrate.freshOf(reportsTemplate), leasesNeed },
		situations: [
			"refused: outside the scope",
			"refused: base relation",
			"refused: another definition",
			"refused: a string",
			"refused: look-alike",
			"refused: a getter",
			"refreshed plain",
			"refreshed concurrently",
			"named against level order",
			"named twice",
			"an unpopulated input"
		] satisfies ReadonlyArray<Reached<RefreshFeature>>,
		check:
			({ reports, leasesNeed }, c: Case<RefreshFeature>) =>
			(names) =>
				Effect.flatMap(reports, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const { leases, model } = yield* leasesNeed
							const s = yield* Substrate
							const installed = taken.value
							const f = build(installed.declared)
							/** Every view unpopulated, as one created before a migration populated what it creates is until its
							 * first refresh: the plain form's case. */
							const emptied = Effect.forEach(
								["StudentWeekly", "WeekBusy", "WeekSittings"] as const,
								(name) =>
									s.admin.query(
										`REFRESH MATERIALIZED VIEW ${printObjectName(installed.names.relation(name))} WITH NO DATA`,
										[]
									),
								{ discard: true }
							)
							yield* emptied
							/** pg_class.relispopulated of each view, read as the owner. */
							const populated = Effect.forEach(
								["StudentWeekly", "WeekBusy", "WeekSittings"] as const,
								(name) =>
									Effect.map(
										s.admin.queryValues(
											"SELECT c.relispopulated FROM pg_catalog.pg_class AS c WHERE c.oid = $1::regclass",
											[printObjectName(installed.names.relation(name))]
										),
										(rows) => [name, rows[0]?.[0] === true] as const
									)
							)
							const { ctx, load } = yield* openServedDb(installed, f.server.roles.partial, {})
							const counting = {
								...ctx,
								pool: {
									...ctx.pool,
									lease: Effect.suspend(() => {
										leases.count++
										return ctx.pool.lease
									})
								}
							}

							const refusals = refusalsOf(names)
							const listed = viewsOf(names)
							const views = Arr.filter(levelOrder, (view) => listed.includes(view))
							const built = Result.try({
								try: () => refreshMember(Arr.map(names, (n) => passed(f, n))),
								catch: (error) => error
							})
							if (Arr.some(refusals, (r) => unbuilt.includes(r))) {
								assert.ok(Result.isFailure(built), `refresh(...) builds ${Arr.join(names, ", ")}`)
								assert.ok(isCompileError(built.failure), String(built.failure))
								assert.equal(built.failure.reason._tag, "MalformedDescription")
								for (const r of refusals) {
									c.note(`refused: ${r}`)
								}
							} else {
								const loaded = yield* Effect.result(
									load({ r: succeeded(built, "a refresh member of materialized relations") })
								)
								if (refusals.length > 0) {
									assert.ok(Result.isFailure(loaded), `the compile admits ${Arr.join(names, ", ")}`)
									const refused = loaded.failure
									assert.ok(!(refused instanceof OpenError), Formatter.format(refused))
									assert.deepEqual(refused.place, {
										kind: "program",
										role: "partial",
										program: "r"
									})
									for (const r of refusals) {
										c.note(`refused: ${r}`)
									}
								} else {
									const refresh = member(succeeded(loaded, "the refresh member"), "r")
									assertVariant(refresh, "kind", "refresh", "a refresh member")
									const before = leases.count
									const outcome = yield* Effect.result(
										Effect.scoped(runRefresh(counting, refresh.refresh))
									)
									const leased = leases.count - before
									if (
										views.includes("WeekBusy") &&
										!views.includes("StudentWeekly") &&
										!model.has("StudentWeekly")
									) {
										assert.deepEqual(
											raisedOf(outcome),
											{ by: "server", sqlstate: "55000" },
											"a level-2 view over an unpopulated input"
										)
										c.note("an unpopulated input")
									} else {
										assert.deepEqual(
											Arr.map(succeeded(outcome, Arr.join(names, ", ")).statements, (st) => [
												st.relation,
												st.concurrently
											]),
											Arr.map(views, (view) => [view, model.has(view)]),
											"one statement per named view, in level order, plain until populated"
										)
										assert.equal(leased, 1, "one session")
										for (const view of views) {
											c.note(model.has(view) ? "refreshed concurrently" : "refreshed plain")
											model.add(view)
										}
										if (listed[0] === "WeekBusy" && views.length === 2) {
											c.note("named against level order")
										}
										if (listed.length > views.length) {
											c.note("named twice")
										}
									}
								}
							}
							const populatedViews = yield* populated
							assert.deepEqual(populatedViews, [
								["StudentWeekly", model.has("StudentWeekly")],
								["WeekBusy", model.has("WeekBusy")],
								["WeekSittings", false]
							])
						}),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "refresh(...)'s stated rules: refused where it is built or compiled unless it names in-scope derived relations, else one statement per relation in level order, plain until populated, against a model of the populated views"
		},
		box: "every member naming one to three of the two in-scope relations, the relation outside the scope, the base relation, another definition under an in-scope name, a string and two look-alikes, in every order, on one installation",
		kept: [],
		kills: []
	})
