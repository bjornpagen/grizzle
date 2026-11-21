/**
 * An embedding names each hidden attribute of the table it embeds anew, numbered among its draft's
 * (analysis/physical/fds.ts DependencyDraft embed, `#hiddenIn`), and gives each implication it carries an origin of one
 * cell over the embedded implication's own (`originOf`, embeddedIn): a fact a chain of embeddings carries up is named
 * alike at every depth, and its origin costs one cell an embedding, where each embedding wrote the embedded name whole
 * into its own and copied the whole path of namespaces. On the ledger's judge (edullm qti-pie's result composition
 * without its login, at hub f4f1f78de) the attribute names of the tables embedded were 150 characters long on average
 * and 2,368 at most, each hashed again wherever a closure learned it, and their origins 44 namespaces on average and 277
 * at most.
 *
 * Oracle: a bound read off the chain, and identity: the longest name the table atop a chain of k embeddings holds is no
 * longer than its namespace's and the digits of k, the hidden attributes the top draft numbers being fewer than k;
 * every origin an embedding gives is one cell whose rest is an origin of the table it embeds, the same object; and the
 * chain keeps its meaning, `a` the key of the table atop it.
 *
 * Features: a chain of one embedding, of two, and of thirty-two.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	asTheyAre,
	type Dependencies,
	DependencyDraft,
	hiddenIn,
	rowAttribute,
	structural
} from "#compiler/analysis/physical/fds.ts"

type Situation =
	| "a chain of one embedding"
	| "a chain of two embeddings"
	| "a chain of thirty-two embeddings"

/** The depths of the box, one to thirty-two embeddings. */
const depths = [1, ...Array.from({ length: 31 }, (_, i) => i + 2)] as const

/**
 * The tables of a chain of `depth` embeddings, the scan first: a table of heading a, b, where a determines b and b
 * identifies a row; then each table over a alone, embedding the one below under the namespace `input`, its a as a, its b
 * and every hidden attribute of it hidden, its row as the embedding's row, which identifies the table's own.
 */
const chainOf = (depth: number): ReadonlyArray<Dependencies> => {
	const scan = new DependencyDraft(["a", "b"])
	scan.imply(["a"], ["b"], structural)
	scan.identify(["b"], structural)
	const tables: Array<Dependencies> = [scan.freeze(["a", "b"])]
	for (let k = 0; k < depth; k++) {
		const below = defined(tables[k], "the table below")
		const draft = new DependencyDraft(["a"])
		const row = hiddenIn("input", rowAttribute)
		draft.embed(below, {
			namespace: "input",
			column: (c) => (c === "a" ? [{ column: "a", just: structural }] : []),
			row,
			localize: asTheyAre
		})
		draft.identify([row], structural)
		tables.push(draft.freeze(["a"]))
	}
	return tables
}

/** The longest name of an attribute a table's implications read or derive. */
const longestName = (table: Dependencies): number =>
	Arr.reduce(
		Arr.flatMap(table.implications, (i) => Arr.map([...i.from, ...i.at, ...i.to], (a) => a.length)),
		0,
		(m, n) => Math.max(m, n)
	)

/** A chain of embeddings names its attributes alike at every depth, and each embedding's origins share the ones below. */
export const aChainOfEmbeddingsNamesItsHiddenAttributesAlikeAtEveryDepthAndEachOriginIsOneCellOverTheOneBelow =
	property.exhaust(
		finite((s) => s.draw(element(depths))),
		{
			needs: {},
			situations: [
				"a chain of one embedding",
				"a chain of two embeddings",
				"a chain of thirty-two embeddings"
			] satisfies ReadonlyArray<Reached<Situation>>,
			check: (_, c: Case<Situation>) => (depth) =>
				Effect.sync(() => {
					const tables = chainOf(depth)
					const top = defined(tables[depth], "the table atop the chain")
					assert.deepEqual(
						top.keyAmong(["a"])?.columns,
						["a"],
						`a is the key of the table atop a chain of ${depth}`
					)
					/** A hidden attribute's name: the namespace's, and its number among the fewer than `depth` the draft names. */
					const bound = hiddenIn("input", rowAttribute).length + String(depth).length
					assert.ok(
						longestName(top) <= bound,
						`the longest name atop a chain of ${depth} is ${longestName(top)} characters, at most ${bound}`
					)
					for (const [k, table] of Arr.drop(tables, 1).entries()) {
						const below = new Set(
							Arr.map(defined(tables[k], "the table below").implications, (i) => i.origin)
						)
						for (const i of table.implications) {
							assert.ok(
								i.origin.kind === "own" || below.has(i.origin.within),
								`an origin at depth ${k + 1} is one cell over an origin of the table below`
							)
						}
					}
					if (depth === 1) {
						c.note("a chain of one embedding")
					}
					if (depth === 2) {
						c.note("a chain of two embeddings")
					}
					if (depth === 32) {
						c.note("a chain of thirty-two embeddings")
					}
				}),
			oracle: {
				kind: "universal",
				name: "a bound and identity: the longest name atop a chain of k embeddings is its namespace's and the digits of k, and every origin an embedding gives is one cell over an origin of the table below"
			},
			box: "every chain of one to thirty-two embeddings of a scan of heading a, b, b hidden at each",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/physical/fds.ts",
					original:
						"\t\t\t\t: renamed.getOrInsertComputed(a, () => (isHidden(a) ? this.#hiddenIn(ns) : hiddenIn(ns, a)))\n",
					replacement: "\t\t\t\t: renamed.getOrInsertComputed(a, () => hiddenIn(ns, a))\n",
					why: "Each embedding writes a hidden attribute's whole name into its own, as at f4f1f78de: a name grows by its namespace at every depth, past the digits of the chain's depth from a chain of two, and the property fails."
				},
				{
					file: "packages/engine/src/analysis/physical/fds.ts",
					original:
						"\t\tconst originOf = (o: Origin): Origin => origins.getOrInsertComputed(o, () => embeddedIn(ns, o))\n",
					replacement:
						"\t\tconst originOf = (o: Origin): Origin => embeddedIn(ns, structuredClone(o))\n",
					why: "Each embedding copies the whole path of an origin, as it copied its namespaces at f4f1f78de: no origin it gives shares the table below's, and the property fails."
				}
			]
		}
	)
