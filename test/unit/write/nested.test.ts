/**
 * A nested write through the whole program (write/frontend, write/family/nesting.ts, program/compile's family steps,
 * bind's chunks): an insert of an owner with its ordered family nested at its count field, a sum folded over it into
 * the owner's end, and an insert of a tree's roots with their children nested to any depth.
 *
 * The oracles: the specification as a checker. Each family step follows its stratum's own statements and its
 * nesting's shallower families; the owner's own row carries its drawn count and its folded end, a direct sum; every
 * member placed by a family step's chunks is at its slot, copying its owner's count, its group its owner's key; and a
 * tree's nodes come in pre-order with the intervals a direct numbering gives (`numberedOf`, a second implementation).
 *
 * Bound: one or two owners of zero to two lines each, of quantities 0 or 1; one or two trees of one to four nodes;
 * the transport in force and one that holds one row per statement. The program depends on the ChangeSet's shape alone,
 * so it is compiled once for each count of owners and trees, and each case binds its own facts.
 *
 * Features: each box's shapes (owners, trees, the transport), a set's repeated facts and keys, each tree depth and
 * shape.
 *
 * A bind spells no family's or layout's key for a row it fills (runtime/write/fill.ts filler, nesting.ts hostNodes):
 * a family is resolved by its id where the bind first meets it and a member's layout by its family, so a fresh write's
 * calls of familyKey and layoutKey binding a chain or a star of three to five nodes, every node the owner of its
 * children, are those binding two, a root and one member, whatever the nodes' number. Counted as work, never time
 * (test/support/kernel/calls.ts callCounts).
 */

import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str, Stream } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { columnKeyOf } from "#compiler/ir/law.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { succeeded } from "#test/support/assert.ts"
import { nestedRowsColumn } from "#test/support/compile.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"
import {
	caseGen,
	chainOf,
	nestedCompiled,
	Doc,
	docFact,
	type Feature,
	lawNames,
	Line,
	Nested,
	Node,
	numberedOf,
	setCaseGen,
	type SetFeature,
	type ShapeFeature,
	starOf,
	statedIdentity,
	treeFacts
} from "#test/unit/write/nested.fixtures.ts"

/** A nested write through the program writes owners with their folded families and trees with their nodes as their own rows and family steps, in order. */
export const aNestedWriteThroughTheProgramWritesOwnersWithTheirFoldedFamiliesAndTreesWithTheirNodesAsTheirOwnRowsAndFamilyStepsInOrder =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: ["an empty family", "a deep tree", "two trees"] satisfies ReadonlyArray<
			Reached<Feature>
		>,
		check: (_, c: Case<Feature>) => (box) =>
			Effect.gen(function* () {
				const docs = Arr.map(box.docs, (qtys, d) => ({
					id: uuidOf(100 + d),
					lines: Arr.map(qtys, (qty, i) => ({
						id: uuidOf(200 + 10 * d + i),
						qty: BigInt(qty)
					}))
				}))
				const roots = Arr.map(box.trees, (parentOf, t) => ({
					...treeFacts(parentOf, 300 + 10 * t),
					root: uuidOf(900 + t)
				}))
				const value = ChangeSet.empty(Nested).insert(Doc, docs).insert(Node, roots)
				const program = nestedCompiled(value)
				const members = yield* collectInputs(program.binding.groups, parsedOf(value).inputs)
				const bound = succeeded(
					bindWrite(flightOf(servableWrite(program), program.frontend.codes, noAdvice), {
						members,
						params: {},
						transport: inForce(bindFrame)
					})
				)
				assert.equal(bound.kind, "bound", "the facts bind")
				if (bound.kind !== "bound") {
					return
				}
				const { chunks } = bound
				const statements = program.artifact.statements
				const additions = defined(
					Option.getOrUndefined(
						Arr.findFirst(
							statements,
							(s) => s.step.kind === "familyWrite" && s.step.statement === "additions"
						)
					),
					"the stratum's family additions"
				)
				const owner = defined(
					Arr.findFirst(
						statements,
						(s) => s.step.kind === "write" && s.step.relation === "Doc"
					).pipe((o) => (o._tag === "Some" ? o.value : undefined)),
					"the owner's own insert"
				)
				assert.ok(
					additions.index > owner.index,
					"the stratum's family additions follow its own statements"
				)
				const group = defined(program.binding.groups[0], "the owner's slot group")
				const [input] = group.inputs
				const tops = bound.stated.slot(group, input, input.slot)
				for (const doc of docs) {
					const top = defined(
						Option.getOrUndefined(Arr.findFirst(tops, (t) => t.stated["id"] === doc.id)),
						"each owner's own row"
					)
					assert.deepEqual(
						top.filled(columnKeyOf("lines")),
						{ kind: "filled", value: BigInt(doc.lines.length) },
						"the owner's count, as the write fills it, is its family's length"
					)
					assert.deepEqual(
						top.filled(columnKeyOf("total")),
						{ kind: "filled", value: Arr.reduce(doc.lines, 0n, (s, l) => s + l.qty) },
						"the owner's end, as the write fills it, is its members' sum"
					)
					if (doc.lines.length === 0) {
						c.note("an empty family")
					}
				}
				const nodeLabels = nestedRowsColumn(program, chunks, "Node", 6)
				const expectedLabels = Arr.flatMap(box.trees, (parentOf, t) =>
					Arr.map(numberedOf(parentOf, 300 + 10 * t), (r) => r.label)
				)
				assert.deepEqual(nodeLabels, expectedLabels, "a tree's nodes go in pre-order, tree by tree")
				assert.deepEqual(
					nestedRowsColumn(program, chunks, "Node", 0),
					Arr.flatMap(box.trees, (parentOf, t) =>
						Arr.map(numberedOf(parentOf, 300 + 10 * t), () => uuidOf(900 + t))
					),
					"each node holds its tree's root value"
				)
				const starts = nestedRowsColumn(program, chunks, "Node", 1)
				const expectedStarts = Arr.flatMap(box.trees, (parentOf, t) =>
					Arr.map(numberedOf(parentOf, 300 + 10 * t), (r) => String(r.start))
				)
				assert.deepEqual(starts, expectedStarts, "each node's start is its pre-order position")
				if (Arr.some(box.trees, (p) => p.length >= 3 && Arr.every(p, (x, i) => x === i))) {
					c.note("a deep tree")
				}
				if (box.trees.length === 2) {
					c.note("two trees")
				}
			}),
		oracle: { kind: "specification", name: "the nested write's rows (w4-w7 §3.10)" },
		box: "one or two owners of up to two lines of quantity 0 or 1, one or two trees of up to four nodes",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original:
					"\t\t\t\tprimary.every((name) => Object.hasOwn(fact, name) || calls.values.has(name)),",
				replacement:
					"\t\t\t\t!primary.every((name) => Object.hasOwn(fact, name) || calls.values.has(name)),",
				why: "Operator mutant (negation) at packages/engine/src/runtime/write/bind.ts in ownRows, the arm-swap of its keyed check before LEGACYFLIGHTS: a row that states its whole key is judged unkeyed and one that states part of it keyed; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/** A nested write's facts are a set by identity (rule 0, ruling 1) writes a fact stated twice once, and refuses two facts at one key by that key's law before any SQL. */
export const aNestedWritesFactsAreASetByIdentityRule0Ruling1WritesAFactStatedTwiceOnceAndRefusesTwoFactsAtOneKeyByThatKeysLawBeforeAnySQL =
	property.exhaust(finite(setCaseGen), {
		needs: {},
		situations: [
			"an identical repeat in one member",
			"an identical repeat across members",
			"a conflict at the owner's key",
			"a member under two owners",
			"a member twice under one owner",
			"accepted with members"
		] satisfies ReadonlyArray<Reached<SetFeature>>,
		check: (_, c: Case<SetFeature>) => (box) =>
			Effect.gen(function* () {
				const stated = Arr.map(box.facts, docFact)
				const value = ChangeSet.empty(Nested)
					.insert(Doc, Arr.take(stated, box.inArray))
					.insert(Doc, Stream.fromIterable(Arr.drop(stated, box.inArray)))
				const setShaped = nestedCompiled(value)
				const members = yield* collectInputs(setShaped.binding.groups, parsedOf(value).inputs)
				const bound = succeeded(
					bindWrite(flightOf(servableWrite(setShaped), setShaped.frontend.codes, noAdvice), {
						members,
						params: {},
						transport: inForce(bindFrame)
					})
				)
				/** The specification: the stated facts as a set by identity, then the keys it holds twice. */
				const distinct = Arr.dedupeWith(
					box.facts,
					(a, b) => statedIdentity(a) === statedIdentity(b)
				)
				const repeated = distinct.length < box.facts.length
				const docs = Arr.map(distinct, (f) => f.doc)
				const lineIds = Arr.flatMap(distinct, (f) => f.lines)
				const docConflict = Arr.dedupe(docs).length < docs.length
				const lineConflict = Arr.dedupe(lineIds).length < lineIds.length
				if (repeated) {
					const ids = Arr.map(box.facts, statedIdentity)
					const front = Arr.take(ids, box.inArray)
					const back = Arr.drop(ids, box.inArray)
					c.note(
						Arr.some(front, (id) => Arr.contains(back, id))
							? "an identical repeat across members"
							: "an identical repeat in one member"
					)
				}
				if (docConflict) {
					c.note("a conflict at the owner's key")
					assertVariant(bound, "kind", "invariant-rejected", "two Docs at one key")
					assert.equal(bound.law, lawNames.primaryKeyLaw(Doc), "refused by Doc's key law")
					return
				}
				if (lineConflict) {
					c.note(
						Arr.some(distinct, (f) => Arr.dedupe(f.lines).length < f.lines.length)
							? "a member twice under one owner"
							: "a member under two owners"
					)
					assertVariant(bound, "kind", "invariant-rejected", "two Lines at one key")
					assert.equal(bound.law, lawNames.primaryKeyLaw(Line), "refused by Line's key law")
					return
				}
				assertVariant(bound, "kind", "bound", "a set with one fact at each key binds")
				const written = nestedRowsColumn(setShaped, bound.chunks, "Line", 0)
				assert.deepEqual(
					Arr.sort(written, Str.Order),
					Arr.sort(
						Arr.map(lineIds, (l) => uuidOf(200 + l)),
						Str.Order
					),
					"each Line of the set is written once"
				)
				if (lineIds.length > 0) {
					c.note("accepted with members")
				}
			}),
		oracle: {
			kind: "specification",
			name: "a ChangeSet's facts are a set by identity, two at one key refused by its key law"
		},
		box: "one to three Doc facts of two ids, each nesting up to two Lines of two ids, split between an array and a Stream member",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/nesting.ts",
				original: "\t\t\t\tsignature.push(held)\n",
				replacement: "",
				why: "A fact's signature is its own row's texts alone, never the rows it nests, so two owners at one key with different lines are one fact, not a key conflict; the set-by-identity property fails."
			}
		]
	})

/** A nested tree at depth and width numbers a chain's and a star's nodes in pre-order at sizes up to a hundred thousand, with no recursion. */
export const aNestedTreeAtDepthAndWidthNumbersAChainsAndAStarsNodesInPreOrderAtSizesUpToAHundredThousandWithNoRecursion =
	property.exhaust(
		finite((source) => ({
			shape: source.draw(element(["chain", "star"] as const)),
			n: source.draw(element([1, 2, 3, 99_999, 100_000] as const))
		})),
		{
			needs: {},
			situations: ["a chain", "a star", "a hundred thousand nodes"] satisfies ReadonlyArray<
				Reached<ShapeFeature>
			>,
			check: (_, c: Case<ShapeFeature>) => (box) =>
				Effect.gen(function* () {
					const root = box.shape === "chain" ? chainOf(box.n, 1000) : starOf(box.n, 1000)
					const value = ChangeSet.empty(Nested).insert(Node, [{ ...root, root: uuidOf(999) }])
					const treeShaped = nestedCompiled(value)
					const members = yield* collectInputs(treeShaped.binding.groups, parsedOf(value).inputs)
					const bound = succeeded(
						bindWrite(flightOf(servableWrite(treeShaped), treeShaped.frontend.codes, noAdvice), {
							members,
							params: {},
							transport: inForce(bindFrame)
						})
					)
					assertVariant(bound, "kind", "bound", "a tree binds")
					const { chunks } = bound
					const starts = nestedRowsColumn(treeShaped, chunks, "Node", 1)
					const ends = nestedRowsColumn(treeShaped, chunks, "Node", 5)
					assert.equal(starts.length, box.n, "every node is written once")
					for (let k = 0; k < box.n; k += 1) {
						const [start, end] =
							box.shape === "chain" ? [k, box.n] : k === 0 ? [0, box.n] : [k, k + 1]
						assert.equal(
							Number(defined(starts[k], "a start")),
							start,
							"a node's start is its pre-order position"
						)
						assert.equal(
							Number(defined(ends[k], "an end")),
							end,
							"a node's end is past its subtree"
						)
					}
					c.note(box.shape === "chain" ? "a chain" : "a star")
					if (box.n === 100_000) {
						c.note("a hundred thousand nodes")
					}
				}),
			oracle: {
				kind: "specification",
				name: "a chain's and a star's pre-order numbering in closed form"
			},
			box: "a chain and a star of 1, 2, 3, 99,999 and 100,000 nodes",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/runtime/write/fill.ts",
					original: "\t\t\treturn { start, end: start + size }",
					replacement: "\t\t\treturn { start, end: start + 1 }",
					why: "A tree node's end is its start plus one, never plus its subtree's size; the depth-and-width property fails on a chain's end."
				}
			]
		}
	)

/** A bind spells no family's or layout's key for a row it fills: a tree of any number of nodes spells a tree of two's. */
export const aBindSpellsNoFamilysOrLayoutsKeyForARowItFills = property.exhaust(
	finite((source) => ({
		shape: source.draw(element(["chain", "star"] as const)),
		n: source.draw(element([3, 4, 5] as const))
	})),
	{
		needs: {},
		situations: ["a chain", "a star"] satisfies ReadonlyArray<Reached<ShapeFeature>>,
		check: (_, c: Case<ShapeFeature>) => (box) =>
			Effect.gen(function* () {
				/** The key spellings of a fresh write's bind of one tree of `n` nodes of the box's shape. */
				const spelled = (n: number) =>
					Effect.gen(function* () {
						const root = box.shape === "chain" ? chainOf(n, 1000) : starOf(n, 1000)
						const value = ChangeSet.empty(Nested).insert(Node, [{ ...root, root: uuidOf(999) }])
						const treeShaped = nestedCompiled(value)
						const members = yield* collectInputs(treeShaped.binding.groups, parsedOf(value).inputs)
						const flight = flightOf(servableWrite(treeShaped), treeShaped.frontend.codes, noAdvice)
						const [bound, counts] = yield* callCounts(
							Effect.sync(() =>
								succeeded(bindWrite(flight, { members, params: {}, transport: inForce(bindFrame) }))
							),
							{
								families: { file: "packages/engine/src/ir/law.ts", name: "familyKey" },
								layouts: { file: "packages/engine/src/ir/fill.ts", name: "layoutKey" }
							}
						)
						assertVariant(bound, "kind", "bound", "a tree binds")
						return counts
					})
				const two = yield* spelled(2)
				const many = yield* spelled(box.n)
				assert.deepEqual(many, two, `a tree of ${box.n} nodes spells the keys a tree of two does`)
				c.note(box.shape === "chain" ? "a chain" : "a star")
			}),
		oracle: {
			kind: "specification",
			name: "a bind's families and layouts are resolved once each, whatever its rows' number"
		},
		box: "a chain and a star of 3, 4 and 5 nodes, each against a tree of two, its root and one member",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/fill.ts",
				original: "\t\t\t\tconst row = rowOf(node, layouts.member(current.family), {",
				replacement:
					'\t\t\t\tconst row = rowOf(node, layouts.at(node.relation, { kind: "member", family: current.family }), {',
				why: "Every member's row finds its layout by a key spelled for it, one layout key and one family key a row."
			},
			{
				file: "packages/engine/src/runtime/write/fill.ts",
				original:
					"\tconst familyOf = (id: FamilyId): FillFamily => {\n\t\tconst known = byId.get(id)",
				replacement:
					"\tconst familyOf = (id: FamilyId): FillFamily => {\n\t\tconst known: FillFamily | undefined = undefined",
				why: "Each family a node or a rule names is found by its key spelled again at every row that names it."
			}
		]
	}
)
