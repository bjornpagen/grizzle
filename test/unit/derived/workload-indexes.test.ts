/**
 * Workload indexes on a stored derived relation: its table takes indexes from the query workload exactly as any table
 * does. A workload request on it lands on an inherited key's unique index that serves it, merging the access into its
 * reasons, or becomes a workload index of its own, justified by the access. The migration generator drafts such an
 * index through the same rules as any index: built concurrently on a table that may hold rows, and created again with
 * the table a changed definition recreates. Every installation installs the table, the relation stored by the
 * installation's inference (analysis/derived/storage.ts).
 *
 * Each case draws a workload of programs over AccountBudget (each account's entries of the books counted and their
 * budgets summed, or a redefinition over the entries above a budget of 10), each comparing a drawn column of the table,
 * its key `account`, its count `tasks` or its computed numeric `budget`, by a drawn comparison a B-tree serves to a
 * parameter, served through a login as `grizzle generate` serves it (test/support/compiled-served.ts), so the indexes
 * the installation plans are those its programs' bound reads ask. Read off the typed plan a draft states, never its SQL
 * text.
 *
 * - Table indexes: a program over the key lands on the key's unique index, every other column takes one created index
 *   keyed by it alone, standing on access, compared as a set. Oracle: that rule, restated over the drawn programs.
 *   Features: an index of a column, the key's own index, two columns indexed, the empty workload.
 * - Drafts: over two drafts, the second's workload indexes are exactly those its workload asks for that the first's
 *   did not, each built concurrently, or all of them, each after the table, where a changed definition creates its
 *   table anew, named by its new canonical form (analysis/derived/canonical.ts), and drops the earlier one, compared as
 *   a set of the columns each index keys. Oracle: that rule, restated over both
 *   drafts' programs. Features: an index built concurrently, an index after its recreated view, a standing index the
 *   later draft keeps.
 */

import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { draftChain, fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"
import {
	type DraftCase,
	draftedWith,
	type DraftFeature,
	draftGen,
	type IndexCase,
	indexedColumns,
	type IndexFeature,
	keyColumn,
	keyIdent,
	onView,
	planned,
	programGen,
	programsOf,
	Redefined,
	Reports,
	servedOf,
	viewIndexes
} from "#test/unit/derived/workload-indexes.fixtures.ts"

/**
 * Workload indexes on a derived relation index a view column, its key on its key index, and a computed numeric's by its
 * proved bound.
 *
 * Budget: 40 runs and 60 steered cases, what its suite stated before it became a property
 * (test/unit/derived/workload-indexes.test.ts:218 at 8cad5bce, its runs and its coverage's cases).
 */
export const workloadIndexesOnADerivedRelationIndexAViewColumnItsKeyOnItsKeyIndexAndAComputedNumericsByItsProvedBound =
	property.explore(
		(source): IndexCase => ({
			programs: source.draw(array(programGen, { min: 0, max: 3 }))
		}),
		{
			needs: {},
			budget: { runs: 40, steered: 60 },
			situations: [
				"an index of a column",
				"the key's own index",
				"two columns indexed",
				"the empty workload"
			] satisfies ReadonlyArray<Reached<IndexFeature>>,
			check: (_, k: Case<IndexFeature>) => (c) =>
				Effect.sync(() => {
					const installation = servedOf(Reports, programsOf(c.programs, false))
					if (c.programs.length === 0) {
						k.note("the empty workload")
					}
					const indexes = viewIndexes(installation)
					const created = Arr.filter(indexes, (x) => x.index.kind === "created")
					const expected = indexedColumns(c.programs)
					if (expected.length > 0) {
						k.note("an index of a column")
					}
					if (expected.length > 1) {
						k.note("two columns indexed")
					}
					assert.deepEqual<ReadonlyArray<ReadonlyArray<string>>>(
						Arr.sort(
							Arr.map(created, (x) => Arr.map(x.keys, keyColumn)),
							Order.mapInput(Order.String, (keys: ReadonlyArray<string>) => Arr.join(keys, ","))
						),
						Arr.map(expected, (column) => [column])
					)
					for (const x of created) {
						assert.ok(
							Arr.every(x.requests, (r) => r.role === "access"),
							"a workload index stands on access"
						)
					}
					if (Arr.some(c.programs, (p) => p.column === "account")) {
						k.note("the key's own index")
						assert.ok(
							Arr.some(
								indexes,
								(x) =>
									x.index.kind === "installed" &&
									Arr.join(Arr.map(x.keys, keyColumn), ",") === "account" &&
									Arr.some(x.requests, (r) => r.role === "access")
							),
							"the key's unique index serves the access"
						)
					}
				}),
			oracle: {
				kind: "specification",
				name: "a program over the key lands on the key's index, any other column takes an index of its own, a deferred view none"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/physical/indexes/engine.ts",
					original: "\t\t\t...b.indexedViews().flatMap((view) =>",
					replacement: "\t\t\t...b.indexedViews().slice(0, 0).flatMap((view) =>",
					why: "A request whose columns an inherited unique index leads with takes an index of its own (physical/indexes/engine.ts planIndexes counts no view's unique index); the view indexes fail."
				}
			]
		}
	)

/**
 * Workload indexes on a derived relation build a later program's view index concurrently, and create every one again
 * after the view a redefinition recreates.
 *
 * Budget: 30 runs and 60 steered cases, what its suite stated before it became a property
 * (test/unit/derived/workload-indexes.test.ts:311 at 8cad5bce, its runs and its coverage's cases).
 */
export const workloadIndexesOnADerivedRelationBuildALaterProgramsViewIndexConcurrentlyAndCreateEveryOneAgainAfterTheViewARedefinitionRecreates =
	property.explore(
		(source): DraftCase => ({
			first: source.draw(draftGen),
			second: source.draw(draftGen)
		}),
		{
			needs: {},
			budget: { runs: 30, steered: 60 },
			situations: [
				"an index built concurrently",
				"an index after its recreated view",
				"a standing index the later draft keeps"
			] satisfies ReadonlyArray<Reached<DraftFeature>>,
			check: (_, k: Case<DraftFeature>) => (c) =>
				Effect.sync(() => {
					const draftOf = (d: DraftCase["first"]) => {
						const over = d.redefined ? Redefined : Reports
						return {
							desc: over,
							options: draftedWith(over, programsOf(d.programs, d.redefined)),
							declared: noDeclarations
						}
					}
					const second = defined(draftChain([draftOf(c.first), draftOf(c.second)], fromEmpty)[1])
					const steps = Arr.filter(planned(second), (p) => onView(p.statement))
					const indexes = Arr.filter(
						steps,
						(p) => p.statement.kind === "createIndex" && !p.statement.unique
					)
					const recreated = c.first.redefined !== c.second.redefined
					const before = indexedColumns(c.first.programs)
					const after = indexedColumns(c.second.programs)
					const expected = recreated
						? after
						: Arr.filter(after, (col) => !Arr.contains(before, col))
					if (!recreated && Arr.some(after, (col) => Arr.contains(before, col))) {
						k.note("a standing index the later draft keeps")
					}
					unorderedEqual<ReadonlyArray<string>>(
						Arr.map(indexes, (p) =>
							p.statement.kind === "createIndex" ? Arr.map(p.statement.keys, keyIdent) : []
						),
						Arr.map(expected, (col) => [identifierOf(identity.column(parsedName(col)))]),
						"one workload index of each column the draft adds"
					)
					const view = Arr.findFirstIndex(steps, (p) => p.statement.kind === "createStoredTable")
					assert.equal(
						Option.isSome(view),
						recreated,
						"the view is created again exactly when redefined"
					)
					assert.equal(
						Arr.some(steps, (p) => p.statement.kind === "drop"),
						recreated,
						"the earlier definition's table is dropped exactly when redefined, its successor named by its own form"
					)
					for (const index of indexes) {
						const at = steps.indexOf(index)
						if (recreated) {
							k.note("an index after its recreated view")
							assert.ok(
								Option.exists(view, (created) => created < at),
								"a recreated view's index follows its creation"
							)
						} else {
							k.note("an index built concurrently")
							assert.ok(
								index.statement.kind === "createIndex" && index.statement.concurrently,
								"a standing view's new index is built concurrently"
							)
						}
					}
				}),
			oracle: {
				kind: "specification",
				name: "a standing view takes the new indexes concurrently; a recreated one takes them all after its creation"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/deploy/diff/diff.ts",
					original: "\t\t\t{ ...index, concurrently: true }",
					replacement: "\t\t\t{ ...index, concurrently: false }",
					why: "An index on a standing relation is drafted without CONCURRENTLY (deploy/diff/diff.ts buildConcurrently); the drafts fail."
				}
			]
		}
	)
