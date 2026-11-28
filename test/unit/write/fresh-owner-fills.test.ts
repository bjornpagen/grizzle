/**
 * A bind fills a nested owner once more only where its stratum appends a member to one of its counted families
 * (runtime/write/bind.ts freshOwners): the walk drew the owner's counts and ends at its empty families' values, which no
 * member changes, so an owner its stratum appends nothing to keeps its walked row, and the fresh fill runs the filler
 * once for each owner a member names. A bind's fill calls are its nestings' walks and those owners' fills alone, never
 * one per stored or nested row. And a row is its fill's cells (runtime/write/cells.ts Cells) to the end: a nested row,
 * a refilled owner's and the row the write inserts of it are the cells a fill call returned, never a copy.
 *
 * The schema: Doc(id) with an ordered family of Node(doc, at), each Node the owner of a counted family of Attr(doc, at,
 * name), its count `attrs`. A case draws one to three docs, each nesting one to four nodes, and each node zero to three
 * attributes, inserted beside the docs in one ChangeSet, so every node is a nested owner whose group is fresh. The
 * filler the bind runs is the write's own, each call counted and each row it returns kept. The oracle is the rule: the
 * calls are one per doc's walk and one per node that holds an attribute, no call fills a row whose every family is
 * empty, every node's `attrs` is its attributes' count, 0 where it holds none, and every node's inserted row holds the
 * very cells a fill call returned for it.
 *
 * Features: a node holding no attribute beside one holding some, every node holding some, none holding any.
 */

import { assert, assertVariant } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, type Gen, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { StoredRelationName } from "#compiler/core/ids.ts"
import { columnKeyOf } from "#compiler/ir/law.ts"
import { drawn, natural, int8 } from "#compiler/public/fields.ts"
import { counted, fin, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import type { Cells } from "#compiler/runtime/write/cells.ts"
import type { FilledNode, Filler } from "#compiler/runtime/write/fill.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf, uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"
import { withinMessage } from "#test/support/worlds/execute/offline.ts"

const Doc = relation("Doc", { id: Id, n: drawn(natural) }, ["id"])
const Node = relation("Node", { doc: Id, at: drawn(natural), attrs: drawn(natural) }, ["doc", "at"])
const Attr = relation("Attr", { doc: Id, at: natural, name: int8 }, ["doc", "at", "name"])
const Pages = schema(
	"Pages",
	[Doc, Node, Attr],
	[
		ordered(on(Node, "doc", "at"), fin(Doc, "n")),
		counted(on(Attr, "doc", "at"), fin(Node, "attrs"))
	]
)
const reality = realityWrite(succeeded(testArtifacts(Pages, testCompile)))

type Situation =
	| "a node holding no attribute beside one holding some"
	| "every node holding some"
	| "no node holding any"

/** A case: each doc's nodes, each node's count of attributes. */
const docsGen: Gen<ReadonlyArray<ReadonlyArray<number>>> = array(
	array(int(0, 3), { min: 1, max: 4 }),
	{ min: 1, max: 3 }
)

/** A bind fills a nested owner again only where its stratum appends a member to one of its counted families, once per such owner. */
export const aBindFillsANestedOwnerAgainOnlyWhereItsStratumAppendsAMemberToOneOfItsCountedFamiliesOncePerSuchOwner =
	property.explore(docsGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"a node holding no attribute beside one holding some",
			"every node holding some",
			"no node holding any"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (docs) =>
			Effect.sync(() => {
				const value = ChangeSet.empty(Pages)
					.insert(
						Doc,
						Arr.map(docs, (nodes, d) => ({ id: uuidOf(d + 1), n: Arr.map(nodes, () => ({})) }))
					)
					.insert(
						Attr,
						Arr.flatMap(docs, (nodes, d) =>
							Arr.flatMap(nodes, (attrs, at) =>
								Array.from({ length: attrs }, (_, name) => ({
									doc: uuidOf(d + 1),
									at: BigInt(at),
									name: BigInt(name)
								}))
							)
						)
					)
				const program = succeeded(compileWrite(checking(Pages), descOf(value), reality))
				const members = collectInputs(program.binding.groups, parsedOf(value).inputs)
				const flight = flightOf(servableWrite(program), program.frontend.codes, noAdvice)
				/** Each fill call's families' member counts. */
				const calls: Array<ReadonlyArray<number>> = []
				/** The cells of every row a fill call returned, its root's and each member's. */
				const returned = new Set<Cells>()
				const keep = (row: FilledNode): void => {
					returned.add(row.values)
					for (const g of row.families) {
						for (const m of g.members) {
							keep(m)
						}
					}
				}
				const fill: Filler = (root, position, left) => {
					calls.push(Arr.map(root.families, (g) => g.members.length))
					const filled = flight.prepared.fill(root, position, left)
					if (filled.ok) {
						keep(filled.value)
					}
					return filled
				}
				const bound = succeeded(
					withinMessage(
						bindWrite(
							{ ...flight, prepared: { ...flight.prepared, fill } },
							{ members, params: {}, transport: inForce(bindFrame) }
						)
					)
				)
				assertVariant(bound, "kind", "bound", "the docs and their attributes bind")
				const nodes = Arr.flatten(docs)
				const holding = Arr.filter(nodes, (attrs) => attrs > 0).length
				c.note(
					holding === 0
						? "no node holding any"
						: holding === nodes.length
							? "every node holding some"
							: "a node holding no attribute beside one holding some"
				)
				assert.equal(
					calls.length,
					docs.length + holding,
					"one fill per doc's walk and one per node holding an attribute"
				)
				assert.ok(
					Arr.every(calls, (families) => Arr.some(families, (n) => n > 0)),
					"no fill call fills a row whose every family is empty"
				)
				const stored = Arr.flatMap(
					bound.inserted(),
					(stratum) => stratum.rows.get(StoredRelationName("Node")) ?? []
				)
				assert.deepEqual(
					Arr.sort(
						Arr.map(stored, (row) =>
							String(row.values[flight.prepared.columns("Node").at(columnKeyOf("attrs"))])
						),
						Order.String
					),
					Arr.sort(
						Arr.map(nodes, (attrs) => String(attrs)),
						Order.String
					),
					"every node's attrs is its attributes' count"
				)
				assert.ok(
					Arr.every(stored, (row) => returned.has(row.values)),
					"every node's inserted row is the cells a fill call returned, never a copy"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the walk draws a nested owner's empty families, which only an appended member changes"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original: "\t\t\t\t\tif (inputs.every((i) => i.members.length === 0)) {",
				replacement: "\t\t\t\t\tif (inputs.length < 0) {",
				why: "Every nested owner is filled again, its counted families empty or not, one fill of each of its columns for each row of the nesting."
			},
			{
				file: "packages/engine/src/runtime/write/nesting.ts",
				original: "\tconst { values, texts } = row\n",
				replacement: "\tconst { texts } = row\n\tconst values = row.values.slice()\n",
				why: "A nested row copies its walk's cells, one copy of every row a nesting fills, where the row is the walk's own."
			},
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original: "rows.push({ ...row, values: drawn, texts, cells: ownerCells(drawn, texts) })",
				replacement:
					"rows.push({ ...row, values: drawn.slice(), texts, cells: ownerCells(drawn, texts) })",
				why: "A refilled nested owner copies its refill's cells, one copy of every owner a member names, where the row is the refill's own."
			},
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original: "\t\t\t\t\t\tof.set(key, { values: filled, scanned: [] })",
				replacement: "\t\t\t\t\t\tof.set(key, { values: filled.slice(), scanned: [] })",
				why: "The rows the write inserts copy each row's cells from its one source, one copy of every inserted row, where only a row two sources give is built anew."
			}
		]
	})
