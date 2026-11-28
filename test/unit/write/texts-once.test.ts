/**
 * A write works out each value's canonical text once (runtime/write/cells.ts Texts): a nested level's value at its
 * admission (codec/recordset.ts RelationNormalizer admitOne), whose texts its walk carries by position to the rows it
 * fills, each nested row reading its key, cells and identity off them (runtime/write/nesting.ts nestedRowOf), the
 * same-key checks reading a nested row's key texts off them at its columns' positions (runtime/write/normalize.ts
 * rowReading), and a fresh owner's refill and its cells reading its walked row's texts again (runtime/write/bind.ts
 * freshOwners), never working one out again from the value.
 *
 * The schema: Doc(id) with an ordered family of Node(doc, at, kind), each Node the owner of a counted family of
 * Attr(doc, at, name, kind), its count `attrs`, `kind` a closed id of an ordered roster and Node's (doc, kind) a key
 * beside its primary key. A case draws one to three docs, each nesting one to three nodes, each of its own kind, and
 * each node zero to three attributes, inserted beside the docs in one ChangeSet, every attribute of some kind, so every
 * node is a nested owner whose group is fresh and every nested row is judged at a key over its kind. The write binds under
 * the installation's codes with each roster's ranks counted: a closed id's canonical text is its code, read off its
 * roster's ranks (ir/codes.ts codeOf), and no bind compares a kind, so each read of a rank is one text worked out of a
 * kind. The oracle is the rule: the reads are one per node, at its level's admission, and one per attribute, at its
 * slot's, however many nodes their attributes refill.
 *
 * Features: a node holding no attribute beside one holding some, every node holding some, none holding any.
 */

import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, type Gen, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { noSpellings } from "#compiler/ir/pattern.ts"
import { closedId, drawn, natural, int8 } from "#compiler/public/fields.ts"
import {
	closed,
	counted,
	fin,
	key,
	on,
	ordered,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
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

const kinds = ["leaf", "branch", "root"] as const

const Kind = closed.ordered("Kind", kinds)

const Doc = relation("Doc", { id: Id, n: drawn(natural) }, ["id"])
const Node = relation(
	"Node",
	{ doc: Id, at: drawn(natural), attrs: drawn(natural), kind: closedId(Kind) },
	["doc", "at"]
)
const Attr = relation("Attr", { doc: Id, at: natural, name: int8, kind: closedId(Kind) }, [
	"doc",
	"at",
	"name"
])
const Labels = schema(
	"Labels",
	[Kind, Doc, Node, Attr],
	[
		ordered(on(Node, "doc", "at"), fin(Doc, "n")),
		counted(on(Attr, "doc", "at"), fin(Node, "attrs")),
		key(on(Node, "doc", "kind"))
	]
)
const reality = realityWrite(succeeded(testArtifacts(Labels, testCompile)))

type Situation =
	| "a node holding no attribute beside one holding some"
	| "every node holding some"
	| "no node holding any"

/** A case: each doc's nodes, at most one of each kind, each node's count of attributes. */
const docsGen: Gen<ReadonlyArray<ReadonlyArray<number>>> = array(
	array(int(0, 3), { min: 1, max: kinds.length }),
	{ min: 1, max: 3 }
)

/** The kind of the i-th node or attribute of a case. */
const kindOf = (i: number): (typeof kinds)[number] => defined(kinds[i % kinds.length], "a kind")

/** A Map whose every read of a key is counted, a roster's ranks as a bind reads them. */
class CountedRanks extends Map<string, number> {
	reads = 0

	override get(key: string): number | undefined {
		this.reads += 1
		return super.get(key)
	}
}

/** The codebook `codes` with each roster's ranks counted, and the reads of them so far. */
const countedCodes = (
	codes: Codebook
): { readonly codes: Codebook; readonly reads: () => number } => {
	const ranks: Array<CountedRanks> = []
	const rosters = new Map(
		Arr.map([...codes.rosters], ([name, codec]) => {
			const rank = new CountedRanks(codec.rank)
			ranks.push(rank)
			return [name, { ...codec, rank }] as const
		})
	)
	return {
		codes: { rosters, spellings: noSpellings },
		reads: () => Arr.reduce(ranks, 0, (n, rank) => n + rank.reads)
	}
}

/** A write works out each nested and fresh value's canonical text once, at its admission. */
export const aWriteWorksOutEachNestedAndFreshValuesCanonicalTextOnceAtItsAdmission =
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
				const value = ChangeSet.empty(Labels)
					.insert(
						Doc,
						Arr.map(docs, (nodes, d) => ({
							id: uuidOf(d + 1),
							n: Arr.map(nodes, (_, at) => ({ kind: kindOf(at) }))
						}))
					)
					.insert(
						Attr,
						Arr.flatMap(docs, (nodes, d) =>
							Arr.flatMap(nodes, (attrs, at) =>
								Array.from({ length: attrs }, (_, name) => ({
									doc: uuidOf(d + 1),
									at: BigInt(at),
									name: BigInt(name),
									kind: kindOf(d + at + name)
								}))
							)
						)
					)
				const program = succeeded(compileWrite(checking(Labels), descOf(value), reality))
				const members = collectInputs(program.binding.groups, parsedOf(value).inputs)
				const counting = countedCodes(program.frontend.codes)
				const flight = flightOf(servableWrite(program), counting.codes, noAdvice)
				const bound = succeeded(
					withinMessage(bindWrite(flight, { members, params: {}, transport: inForce(bindFrame) }))
				)
				assertVariant(bound, "kind", "bound", "the docs and their attributes bind")
				bound.inserted()
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
					counting.reads(),
					nodes.length + Arr.reduce(nodes, 0, (n, attrs) => n + attrs),
					"one text of each node's kind and each attribute's, worked out at its admission"
				)
			}),
		oracle: {
			kind: "specification",
			name: "a write works out each value's canonical text once, where the value is admitted"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/nesting.ts",
				original: "\t\t\ttexts[field.at] = admittedTexts[place]\n",
				replacement: "",
				why: "A nested level's admitted fact is laid out without its admission's texts, so every nested row works each of its values' texts out again."
			},
			{
				file: "packages/engine/src/runtime/write/nesting.ts",
				original: "\t\tconst text = textAt(values, texts, c.at, c.spec)\n",
				replacement: "\t\tconst text = textAt(values, [], c.at, c.spec)\n",
				why: "A nested row works each of its cells' texts out again from its value, beside the text its walk carried."
			},
			{
				file: "packages/engine/src/runtime/write/normalize.ts",
				original:
					"\t\t\ttextsId(at.map((c) => keyText(c.spec, textAt(row.values, row.texts, c.at, c.spec))))",
				replacement:
					"\t\t\ttextsId(at.map((c) => keyText(c.spec, textAt(row.values, [], c.at, c.spec))))",
				why: "The same-key checks work a nested row's key texts out again from its values, beside the texts its write holds."
			},
			{
				file: "packages/engine/src/runtime/write/fill.ts",
				original: "\t\ttexts: node.texts.slice(),\n",
				replacement: "\t\ttexts: [],\n",
				why: "The walk drops its node's texts, so every row it fills works its caller's values' texts out again."
			},
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original: "\t\t\t\tconst texts = row.texts.slice()\n",
				replacement: "\t\t\t\tconst texts: Texts = []\n",
				why: "A fresh owner's refill drops its walked row's texts, so each owner a member names works its cells' texts out again."
			}
		]
	})
