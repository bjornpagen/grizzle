/**
 * Share and evaluation keys from encoded templates (ir/dag-digest.ts DagDigests): one DAG's digests, each node's and
 * expression's derivation form written once as its template, beside its namings.
 *
 * - Exactness: every sub-query's digest, and the roots' together, is the digest of its normal form's table encoded
 *   whole (normalizeReach, derivationForm, digest), whichever way its enclosing nodes are read. Oracle: the table's own
 *   digest, a second implementation of the same bytes. Its DAGs call no volatile function, whose form also holds its
 *   label (test/unit/lower/shapes/share-statements pins that).
 * - Work: digesting every node of a DAG writes at most one template for each node and expression it holds, however
 *   many digests reach it, where each digest encoded its whole reach.
 *
 * Features: names followed and labelled; a DAG of every kind of node and generated DAGs.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { maxStringLength } from "#compiler/core/canonical.ts"
import { DagDigests, DagTemplates } from "#compiler/ir/dag-digest.ts"
import { nodesByLabel, topoOrder } from "#compiler/ir/dag.ts"
import { exprClosure } from "#compiler/ir/expr.ts"
import { exprsOf } from "#compiler/ir/rel.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import {
	boundCaseGen,
	type DigestFeature,
	digestCaseGen,
	tableDigest,
	tableUnits
} from "#test/unit/ir/dag-digest.fixtures.ts"

/** Every sub-query's digest from its DAG's templates is its normal form's table's digest, and each node's and expression's template is written once for all of them. */
export const everySubQuerysDigestFromItsDAGsTemplatesIsItsNormalFormsTablesDigestAndEachTemplateIsWrittenOnceForAllOfThem =
	property.explore(digestCaseGen, {
		needs: {},
		situations: [
			"followed",
			"labelled",
			"every kind of node",
			"a generated DAG"
		] satisfies ReadonlyArray<Reached<DigestFeature>>,
		check: (_, c: Case<DigestFeature>) => (k) =>
			Effect.sync(() => {
				const templates = new DagTemplates("derivation")
				const digests = new DagDigests(() => nodesByLabel(k.dag), maxStringLength, templates)
				const nodes = topoOrder(k.dag)
				for (const node of nodes) {
					assert.equal(
						succeeded(digests.digest([node], k.domain, k.outer)),
						succeeded(tableDigest(k.dag, [node], k.domain, k.outer)),
						`the digest of ${node.id}, ${k.outer}`
					)
				}
				assert.equal(
					succeeded(digests.digest(k.dag.roots, k.domain, k.outer)),
					succeeded(tableDigest(k.dag, k.dag.roots, k.domain, k.outer)),
					"the digest of the roots together"
				)
				const exprs = new Set(exprClosure(Arr.flatMap(nodes, (node) => exprsOf(node))))
				assert.ok(
					templates.written <= nodes.length + exprs.size,
					`${nodes.length + 1} digests write ${templates.written} templates, at most one each of ${nodes.length} nodes and ${exprs.size} expressions`
				)
				const written = templates.written
				for (const node of nodes) {
					succeeded(digests.digest([node], k.domain, k.outer))
				}
				assert.equal(templates.written, written, "digesting every node again writes no template")
				c.note(k.outer)
				c.note(k.every ? "every kind of node" : "a generated DAG")
			}),
		oracle: {
			kind: "second-implementation",
			name: "the digest of the normal form's table encoded whole (normalizeReach, derivationForm, digest)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/dag-digest.ts",
				original: "\t\tthis.#nodes.set(node, template)\n",
				replacement: "",
				why: "A node's template is written again by every digest that reaches it, as every digest encoded its whole reach: the templates written pass one for each node and expression."
			},
			{
				file: "packages/engine/src/ir/dag-digest.ts",
				original: "\t\tif (at * 10 < count) {",
				replacement: "\t\tif (false) {",
				why: "Entries are written in their numbers' order, not their names' code unit order, so n#10 follows n#9: a table of more than ten nodes or expressions is another text, and its digest differs."
			},
			{
				file: "packages/engine/src/ir/dag-digest.ts",
				original:
					"\t\t\t\tnodeText: (id) => (numbering.outside(id) ? numbering.outsideName(id) : undefined),\n",
				replacement: "\t\t\t\tnodeText: () => undefined,\n",
				why: "A name of a node outside the reach is written as a number where the labelled form writes its label: an evaluation key that reads an enclosing node differs."
			}
		]
	})

/** A key whose table's text passes its limit is refused, its length stated as a true lower bound: past the limit and no more than the text's whole length; one at its limit is digested. */
export const aKeyWhoseTablesTextPassesItsLimitIsRefusedItsLengthStatedAsATrueLowerBoundAndOneAtItsLimitIsDigested =
	property.explore(boundCaseGen, {
		needs: {},
		situations: ["refused", "at its limit"],
		check: (_, c: Case<"refused" | "at its limit">) => (k) =>
			Effect.sync(() => {
				const roots = k.dag.roots
				const length = succeeded(tableUnits(k.dag, roots, k.outer))
				/** The refusal under `limit`, its length stated past the limit and within the text's. */
				const atLeast = (limit: number): number => {
					const under = new DagDigests(
						() => nodesByLabel(k.dag),
						limit,
						new DagTemplates("derivation")
					).digest(roots, "bound", k.outer)
					const reason = refused(under, "ResourceBound").reason
					assert.ok(
						reason._tag === "ResourceBound" && reason.bound.kind === "stringLengthAtLeast",
						`a table of ${length} code units under a limit of ${limit}: ${Formatter.format(reason)}`
					)
					assert.equal(reason.bound.limit, limit, "the limit it states")
					assert.ok(
						reason.bound.atLeast > limit && reason.bound.atLeast <= length,
						`a table of ${length} code units under a limit of ${limit} states at least ${reason.bound.atLeast}`
					)
					return reason.bound.atLeast
				}
				atLeast(Math.floor(((length - 1) * k.share) / 100))
				assert.equal(
					atLeast(length - 1),
					length,
					"refused at its last piece, the text's whole length"
				)
				c.note("refused")
				succeeded(
					new DagDigests(() => nodesByLabel(k.dag), length, new DagTemplates("derivation")).digest(
						roots,
						"bound",
						k.outer
					)
				)
				c.note("at its limit")
			}),
		oracle: {
			kind: "specification",
			name: "the table's canonical text's length (normalizeReach, derivationForm, encode), the bound's limit"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original: "\tif (written > limit) {",
				replacement: "\tif (false) {",
				why: "No canonical text is ever refused for its length: the key past its limit is digested."
			},
			{
				file: "packages/engine/src/core/canonical.ts",
				original: '{ kind: "stringLengthAtLeast", limit, atLeast: written }',
				replacement: '{ kind: "stringLengthAtLeast", limit, atLeast: written + 1 }',
				why: "The refusal states one code unit more than the text holds where it is refused: at the table's last piece it passes the text's whole length, no lower bound."
			}
		]
	})
