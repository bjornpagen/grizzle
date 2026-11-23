/**
 * A stored generated field is determined by the fields its generation reads (ir/keys.ts GeneratedRead, the rule
 * `generated`): PostgreSQL computes it from its own row by an immutable expression, so a key over generated digests makes
 * the texts they are generated from a key alternative, every reading of the relation keyed by them, as a key over the
 * texts themselves would, which no index holds.
 *
 * A query reading a drawn relation of generated fields (digests of one to three texts, a float's negation, a digest chosen
 * by a float's sign, an integer converted to money) and candidate keys over them is keyed by exactly the relation's
 * minimal keys under its declared keys and the dependency of each generation reading no float on what it reads; every
 * proof is one the key kernel accepts, and the kernel refuses a generated step the Base does not stamp. A relation with a
 * generation PostgreSQL would refuse as not immutable, a conversion to money, is refused when the schema compiles
 * (check/generated.ts generatedVolatilityRule), so every generation the rule reads is immutable. Oracle: every column
 * set's closure by brute force, and PostgreSQL's catalog volatility of the conversion, as the registry states it.
 *
 * No generated field escapes the rule another way: every one is STORED, there being no virtual generated field, so a
 * non-stored generation is not expressible, and a non-deterministic one is refused. A generation reading a float is
 * expressible, and states nothing: a float's -0 and +0 are one key value and two values a generation may tell apart.
 *
 * A stored derived relation reading the relation whole is keyed by the same keys, each indexed but one over the unbounded
 * texts, which another key's index holds as its alternative (analysis/derived/analyze.ts): no view of a digest-keyed
 * relation is refused for the texts its digests key.
 *
 * Features: a key over a digest of one text, of several, over two digests, beside a written field, over a generation
 * reading a float and over a mixed one; a stable generation refused.
 */

import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import {
	declaredKey,
	generationDetermines,
	implication,
	rowsKey,
	soleFactor
} from "#compiler/ir/keys.ts"
import {
	analyzeLogical,
	checkerEvidence,
	everyNode,
	queryEvidence
} from "#compiler/logical/annotate.ts"
import { storedKeyPremise } from "#compiler/logical/props.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { KeyKernel } from "#test/support/keys/kernel.ts"
import { checkAuthored, checkedIn, checkOptions } from "#test/support/policy.ts"
import {
	featuresOf,
	generatedOf,
	generatedCaseGen,
	type GeneratedFeature,
	generatedName,
	oracleKeys,
	readsFloat,
	readsOf,
	relationName,
	scanOf,
	schemaOf,
	statedKeys,
	viewName,
	viewSchemaOf
} from "#test/unit/analysis/logical/generated-keys.fixtures.ts"

/**
 * A query reading a relation of generated fields is keyed by exactly the relation's minimal keys under its declared keys
 * and each generation reading no float, determined by what it reads; the kernel accepts every proof, and accepts a
 * generated step exactly where the Base stamps its generation.
 */
export const aRelationOfGeneratedFieldsIsKeyedByExactlyTheClosureOfItsKeysAndItsGenerationsReadingNoFloat =
	property.explore(generatedCaseGen, {
		needs: {},
		situations: [
			"a key over a digest of one text",
			"a key over a digest of several texts",
			"a key over two digests",
			"a key over a digest and a written field",
			"a key over a generation reading a float",
			"a key over a mixed generation",
			"a stable generation refused"
		] satisfies ReadonlyArray<Reached<GeneratedFeature>>,
		check: (_, k: Case<GeneratedFeature>) => (c) =>
			Effect.sync(() => {
				const checked = checkedIn(schemaOf(c))
				const stable = Arr.filter(generatedOf(c), ({ g }) => g.kind === "money")
				if (Arr.isReadonlyArrayNonEmpty(stable)) {
					const { reason } = refused(checked, "GeneratedRefused", "a stable generation is refused")
					assertVariant(reason, "_tag", "GeneratedRefused", "a stable generation")
					assert.ok(
						Arr.some(stable, ({ name }) => name === reason.field),
						`refused at a stable generation, not ${reason.field}`
					)
					assert.equal(reason.rule.kind, "stable", "refused as stable")
					k.note("a stable generation refused")
					return
				}
				const query = succeeded(
					checkAuthored(
						succeeded(checked, "the schema checks"),
						scanOf(c, relationName),
						checkOptions("scan")
					),
					"the scan checks"
				)
				const analysis = succeeded(
					analyzeLogical(query.dag, checkerEvidence, everyNode),
					"the scan analyzes"
				)
				const root = {
					node: analysis.of(query.dag.roots[0]).node,
					props: defined(analysis.props.get(query.dag.roots[0]), "the scan's properties, kept")
				}
				assert.deepEqual(
					statedKeys(root.props.keys),
					oracleKeys(c),
					"the scan's keys are the relation's minimal keys"
				)
				const kernel = new KeyKernel(analysis.dag, { keyedViews: false })
				for (const proof of root.props.keys) {
					assert.deepEqual(kernel.check(proof, root.node), [], "the key kernel accepts each proof")
				}
				const base = Option.getOrThrow(
					Arr.findFirst([...nodesByLabel(query.dag).values()], (n) => n.kind === "Base")
				)
				const held = analysis.of(base).node
				const heading = Arr.map(base.heading, (h) => h.name)
				for (const declared of c.keys) {
					for (const { g, name, at } of generatedOf(c)) {
						if (!declared.includes(name)) {
							continue
						}
						const reads = readsOf(g)
						const forgedKey = [
							...reads,
							...Arr.filter(declared, (x) => x !== name && !reads.includes(x))
						]
						const forged = rowsKey(
							forgedKey,
							implication(forgedKey, [
								generationDetermines({ field: generatedName(at), reads }),
								declaredKey(
									declared,
									heading,
									[storedKeyPremise(relationName, declared, false)],
									"immediate"
								)
							]),
							[],
							soleFactor(forgedKey)
						)
						const faults = kernel.check(forged, held)
						if (readsFloat(g)) {
							assert.ok(
								faults.length > 0,
								`the kernel refuses ${name} from ${Formatter.format(reads)}, which reads a float`
							)
						} else {
							assert.deepEqual(faults, [], `the kernel accepts ${name} from what it reads`)
						}
					}
				}
				const viewed = succeeded(checkedIn(viewSchemaOf(c)), "the view of the relation checks")
				const overView = succeeded(
					checkAuthored(viewed, scanOf(c, viewName), checkOptions("view scan")),
					"the view's scan checks"
				)
				const viewAnalysis = succeeded(
					analyzeLogical(overView.dag, queryEvidence, everyNode),
					"the view's scan analyzes"
				)
				const viewRoot = {
					node: viewAnalysis.of(overView.dag.roots[0]).node,
					props: defined(
						viewAnalysis.props.get(overView.dag.roots[0]),
						"the view scan's properties, kept"
					)
				}
				assert.deepEqual(
					statedKeys(viewRoot.props.keys),
					oracleKeys(c),
					"the view is keyed by every key of its definition, through its indexes"
				)
				const viewKernel = new KeyKernel(viewAnalysis.dag, { keyedViews: true })
				for (const proof of viewRoot.props.keys) {
					assert.deepEqual(
						viewKernel.check(proof, viewRoot.node),
						[],
						"the key kernel accepts each proof over the view"
					)
				}
				for (const feature of featuresOf(c)) {
					k.note(feature)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "every column set's closure by brute force under the declared keys and each generation reading no float, the sets that determine every column with no proper subset that does; a conversion to money stable, as PostgreSQL's catalog and scalar/compute/registry.ts castOverloads state it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\t\t\t\t\t\t\t\t\t...reading.generated.map(generationDetermines)\n",
				replacement: "",
				why: "A Base states no generated field's dependency (logical/props.ts logicalPropsOf, Base): the texts a key's digests read are no key."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original:
					"\t\treturn reads.some((r) => fields.some((x) => x.name === r && isFloat(x.type)))\n",
				replacement: "\t\treturn false\n",
				why: "A generation reading a float is stamped (analysis/schema.ts generatedReadsOf): its reads become a key, though -0 and +0 are one key value it tells apart."
			},
			{
				file: "test/support/keys/kernel.ts",
				original:
					"\t\treturn Arr.some(stamped, (g) => sameSet(g.reads, d.from) && sameSet([g.field], d.to))\n",
				replacement: "\t\treturn true\n",
				why: "The kernel accepts a generated step the Base does not stamp (test/support/keys/kernel.ts #generated): a float's generation forged as a dependency passes."
			},
			{
				file: "packages/engine/src/analysis/derived/analyze.ts",
				original: "\t\tif (!layout.ok && !stated) {\n",
				replacement: "\t\tif (!layout.ok) {\n",
				why: "A derived relation refuses every unrepresentable inherited key (analysis/derived/analyze.ts analyzeDerivedRelation): the view of a relation keyed by its texts' digests is refused for the texts, which its digests' index keys."
			},
			{
				file: "packages/engine/src/check/generated.ts",
				original: '\tvolatility === "stable" ? { kind: "stable" } : undefined\n',
				replacement: "\tundefined\n",
				why: "A stable generation is admitted (check/generated.ts generatedVolatilityRule): a relation generating money from an integer compiles, and fails to install."
			}
		]
	})
