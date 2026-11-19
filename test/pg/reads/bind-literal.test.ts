/**
 * An imported query's parameters bound to literals read exactly the rows the query reads with those values passed as
 * its parameters.
 *
 * The imported query reads a group's items scored at least a bound, keeps those no mark of a given tag names, and
 * takes the first k by score: a parameter in a match, in a filter, in a relational negation and as take's bound. The
 * schema is installed once; each case replaces its facts (items of distinct ids in two groups, marks of distinct items
 * and tags over them, both sets by construction) and draws bindings of values inside and outside the facts. Each
 * binding is bound to literals in an importing rule (`query.bind({ ... })`), and the importer, which has no parameters
 * of its own, is served beside the query as one file of the login.
 *
 * - Property: for every binding, the importer reads exactly the rows, as a set, that the query reads executed with the
 *   binding's values as its parameters.
 * - Oracle: a differential between the two paths, the literal bound at compile and the parameter bound at execution.
 * - Features: an importer reading no row, the take cutting the eligible rows, a mark excluding an eligible item, and a
 *   binding outside the facts, each from a host model of the query over the drawn facts.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { query, v } from "#compiler/public/query.ts"
import {
	type BindFeature,
	bindingGen,
	factsGen,
	featuresOf,
	Item,
	Mark,
	Scores,
	topOver
} from "#test/pg/reads/bind-literal.fixtures.ts"
import { installed } from "#test/pg/reads/support.ts"
import { unorderedEqual } from "#test/support/assert.ts"
import { readOnce } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * An imported query's parameters bound to literals read the rows the query reads with those values as its parameters.
 *
 * Its pre-conversion budget: runs 24, coverage cases 24 (test/pg/reads/bind-literal.test.ts at d8eed1786).
 */
export const anImportedQuerysParametersBoundToLiteralsReadTheRowsTheQueryReadsWithThoseValuesAsItsParameters =
	property.explore(
		(source) =>
			[source.draw(factsGen), source.draw(array(bindingGen, { min: 1, max: 4 }))] as const,
		{
			needs: { substrate: Substrate.installing },
			situations: [
				"an importer reading no row",
				"the take cutting the eligible rows",
				"a mark excluding an eligible item",
				"a binding outside the facts"
			] satisfies ReadonlyArray<Reached<BindFeature>>,
			check:
				({ substrate }, c: Case<BindFeature>) =>
				([facts, bindings]) =>
					Effect.provideServiceEffect(
						Effect.gen(function* () {
							const s = yield* Substrate
							const opened = yield* installed(
								Scores,
								{},
								{ label: "real", programs: { top: topOver(Scores) } }
							)
							const names = namesOf(opened.installed)
							const itemInsert = `INSERT INTO ${names.table(Item)} (${names.column(Item, "id")}, ${names.column(Item, "grp")}, ${names.column(Item, "score")}) VALUES ($1::int4, $2::int4, $3::int4)`
							const markInsert = `INSERT INTO ${names.table(Mark)} (${names.column(Mark, "item")}, ${names.column(Mark, "tag")}) VALUES ($1::int4, $2::text)`
							const top = topOver(opened.schema)
							return yield* Effect.gen(function* () {
								yield* replaceRows(s.admin, installationGroup(names), [
									...Arr.map(facts.items, (i) => ({
										sql: itemInsert,
										params: [String(i.id), String(i.grp), String(i.score)]
									})),
									...Arr.map(facts.marks, (m) => ({
										sql: markInsert,
										params: [String(m.item), m.tag]
									}))
								])
								/** Each binding's importer, by its index. */
								const imports = Rec.fromEntries(
									Arr.map(bindings, (b, i) => [
										`imported${i}`,
										query(opened.schema).rule((r) => {
											const bound = top.bind({ grp: b.grp, lo: b.lo, k: b.k, tag: b.tag })
											const { id, score } = v(bound, "bound")
											return r.match(bound, { id, score }).find({ id, score })
										})
									])
								)
								yield* withServedDb(opened.installed, opened.server.roles.app, {}, ({ serve }) =>
									Effect.gen(function* () {
										const served = yield* serve({ top, ...imports })
										for (const [i, b] of bindings.entries()) {
											const direct = yield* readOnce(member(served, "top"))({
												params: { ...b },
												facts: {}
											})
											const viaImport = yield* readOnce(member(served, `imported${i}`))({
												params: {},
												facts: {}
											})
											unorderedEqual(
												viaImport,
												direct,
												`${Formatter.format(b)} over ${Formatter.format(facts)}`
											)
											c.noteAll(featuresOf(facts, b))
										}
									})
								)
							}).pipe(Effect.scoped)
						}).pipe(Effect.scoped),
						Substrate,
						substrate
					),
			oracle: {
				kind: "second-implementation",
				name: "the query executed with the binding's values as its parameters"
			},
			budget: { runs: 24, steered: 24 },
			kept: [],
			kills: []
		}
	)
