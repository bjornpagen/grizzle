/**
 * The optimized lowering of checked public programs builds only DAGs the validator admits.
 *
 * Each read is lowered as a template compiles it (program/compile.ts compileQuery): checked, its conservative artifact
 * lowered from the checked DAG, its optimized artifact from the checked DAG restated (everyParentTakes) and annotated
 * under the query's evidence (logical/annotate.ts queryEvidence). The optimized pipeline builds its DAG valid by
 * construction and checks nothing; the property reads the DAG it leaves back through the strict re-reader
 * (test/support/oracle/dag-validate.ts), so a rewrite that leaves a reader's checked claim unstated, an attachment's
 * delivered type or an order's keys, is the defect the re-reader raises, never a refusal of the program. The lowering
 * may refuse a program otherwise, which is not this property's subject, nor are the checker and the conservative
 * lowering.
 *
 * The rewrite this guards: an identity projection redirected onto its input hands its readers an input the demand pass
 * redefined, which states none of the projection's evidence unless it takes it over (lower/optimize/simplify/rules.ts
 * identityProjection). The readers that check that evidence are an option or bare attachment's child, by its card, and a
 * take, by the keys that make its order total. The reads are generated public programs (oracle/public/generate.ts),
 * and planted ones beside them for the take, which the generator's orders over every column rarely bring to an
 * identity. A third search holds R07 (lower/optimize/closed) to its statement: a roster match a plain match also binds
 * is dropped, and one an import bound to its variable alone reads is lowered.
 *
 * Oracle: the strict DAG re-reader and the lowering's own audit (checkedLowering), a specification of a valid DAG; and
 * R07's statement, which no Closed occurrence may outlive.
 *
 * Features: an option or bare child, and a take, over an identity projection's input; each roster form.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { boolean, element, finite, shuffled } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import { closedId } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { Id } from "#test/support/ids.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	type HandleName,
	handleNames,
	type IdentityFeature,
	lowered,
	lowersValid,
	plantedGen,
	plantedRead,
	type RosterFeature
} from "#test/unit/lower/public-programs.fixtures.ts"

/**
 * The optimized lowering of checked public programs builds no DAG that breaks a rule for a generated read.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/lower/public-programs.test.ts:266 at 8cad5bce, its runs and its coverage's cases).
 */
export const theOptimizedLoweringOfCheckedPublicProgramsBuildsNoDAGThatBreaksARuleForAGeneratedRead =
	property.explore(caseSketchGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"an option or bare child over an identity projection's input"
		] satisfies ReadonlyArray<Reached<IdentityFeature>>,
		check: (_, n: Case<IdentityFeature>) => (sketch) =>
			Effect.sync(() => {
				const c = n.draw(resolveCase(sketch))
				const built = buildSchema(c.schema)
				for (const read of c.reads) {
					if (read.kind === "query") {
						lowersValid(built.schema, buildRoot(built, built.schema, read.query), n, () =>
							printCase(c)
						)
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the strict DAG re-reader and the lowering's audit (checkedLowering)"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/lower/public-programs.test.ts#theOptimizedLoweringOfCheckedPublicProgramsBuildsNoDAGThatBreaksARuleForAGeneratedRead@small-stack:-:2.1.0.1.0.0.1.0.1.0.1.2.0.1.0.1.2.1.0.1.2.1.2.1.0.1.0.1.0.1.0.1.2.1.0.1.0.1.0.1.0.0.1.0.0.0.1.0.1.0.1.0.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.2.0.0.0.0.0.pa8.0.0.2.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.1.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.pa8.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.1.0.0"
				),
				reason:
					"a count attached by a column its head holds at a parameter, a bare child of exactly one row per parent, which the constant columns' restriction at that value claimed at most one",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/propagate/index.ts",
				original:
					"\t\t\tconst own = of(cell).get(column)\n\t\t\tif (own !== undefined) {\n\t\t\t\treturn own\n\t\t\t}\n",
				replacement: "\t\t\treturn of(cell).get(column)\n",
				why: "A kept value judged against a cell's own values alone: an attachment's child kept at the value its correlation already fixes it at per parent is restricted, a count delivered bare claims at most one row, and the DAG breaks the rule that a bare child is exactly one row per parent."
			},
			{
				file: "packages/engine/src/query/build/rule.ts",
				original: "\t\t\tif (!ref.scope.active) {",
				replacement: "\t\t\tif (ref.scope.active) {",
				why: "Operator mutant (negation) at packages/engine/src/query/build/rule.ts:311 in finishRule: `!ref.scope.active` becomes `ref.scope.active`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/** The optimized lowering of checked public programs builds no DAG that breaks a rule for a planted read. */
export const theOptimizedLoweringOfCheckedPublicProgramsBuildsNoDAGThatBreaksARuleForAPlantedRead =
	property.exhaust(finite(plantedGen), {
		needs: {},
		situations: [
			"an option or bare child over an identity projection's input",
			"a take over an identity projection's input"
		] satisfies ReadonlyArray<Reached<IdentityFeature>>,
		check: (_, n: Case<IdentityFeature>) => (p) =>
			Effect.sync(() => {
				const { schema: planted, read } = plantedRead(p)
				lowersValid(planted, read, n, () => Formatter.format(p))
			}),
		oracle: {
			kind: "specification",
			name: "the strict DAG re-reader and the lowering's audit (checkedLowering)"
		},
		box: "takes of the first one to three items over every found column set, filtered or not, ordered by each found column either way; and routes with one to three scans of Stop in a child that finds nothing",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/simplify/rules.ts",
				original:
					"\t\treturn collapseInto(cx, cell, node, inputCell, () => {\n\t\t\tcertify(cx, simplifyRules.identityProjection, [inputCell.id], node.heading, [inputCell.id])\n\t\t})",
				replacement:
					"\t\tif (!exclusive(cx, inputCell)) {\n\t\t\treturn false\n\t\t}\n\t\tcertify(cx, simplifyRules.identityProjection, [inputCell.id], node.heading, [inputCell.id])\n\t\tcx.editor.redirect(cell, inputCell)\n\t\treturn true",
				why: "An identity projection removed while its input keeps its own metadata, not the projection's evidence, so an option's child over it states no card; the public-programs-planted search fails."
			}
		]
	})

/**
 * The optimized lowering of checked public programs lowers a roster match an import bound to its variable reads, and
 * drops one a plain match also binds.
 *
 * Budget: 40 runs and 40 steered cases, what its suite stated before it became a property
 * (test/unit/lower/public-programs.test.ts:336 at 8cad5bce, its runs and its coverage's cases).
 */
export const theOptimizedLoweringOfCheckedPublicProgramsLowersARosterMatchAnImportBoundToItsVariableReadsAndDropsOneAPlainMatchAlsoBinds =
	property.explore(
		(source) => {
			/** Two to four distinct handles in any order: one, and one to three of the others. */
			const first = source.draw(element(handleNames))
			const handles: readonly [HandleName, ...HandleName[]] = [
				first,
				...source.draw(
					shuffled(
						Arr.filter(handleNames, (h) => h !== first),
						{ min: 1, max: 3 }
					)
				)
			]
			return { handles, twin: source.draw(boolean) }
		},
		{
			needs: {},
			budget: { runs: 40, steered: 40 },
			situations: [
				"an import bound to a variable only a roster match binds",
				"roster match dropped beside a plain binder"
			] satisfies ReadonlyArray<Reached<RosterFeature>>,
			check:
				(_, n: Case<RosterFeature>) =>
				({ handles, twin }) =>
					Effect.sync(() => {
						const Tier = closed.ordered("Tier", handles)
						const Item = relation("Item", { id: Id, tier: closedId(Tier) }, ["id"])
						const Plant = schema("Plant", [Tier, Item], [])
						/** The items of the tier a parameter names, by their tier. */
						const ofTier = query(Plant).rule((r) => {
							const { tier } = v(Item, "item")
							return r
								.match(Item, { tier })
								.where(r.eq(tier, r.param("k", closedId(Tier))))
								.find({ tier })
						})
						const read = query(Plant).rule((r) => {
							const { id: x } = v(Tier, "tier")
							const matched = r.match(Tier, { id: x })
							const { id } = v(Item, "item")
							return (twin ? matched.match(Item, { id, tier: x }) : matched)
								.match(ofTier.bind({ k: x }), { tier: x })
								.find({ x })
						})
						const l = lowered(Plant, read)
						assert.ok(
							l.kind === "lowered",
							"the checker and the conservative lowering admit the read"
						)
						if (!l.optimized.ok) {
							assert.fail(`the optimized lowering refused: ${l.optimized.error.message}`)
						}
						if (!twin) {
							n.note("an import bound to a variable only a roster match binds")
							return
						}
						const dag = l.optimized.value.query.dag
						const closedSources = Arr.flatMap(topoOrder(dag), (node) =>
							node.kind === "MatchRegion"
								? Arr.filter(node.occurrences, (o) => o.source.kind === "Closed")
								: []
						)
						assert.deepEqual(
							closedSources,
							[],
							"R07 drops the roster match a plain match also binds"
						)
						n.note("roster match dropped beside a plain binder")
					}),
			oracle: {
				kind: "specification",
				name: "R07: a roster match a plain match also binds is dropped, one an import alone reads is lowered"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/closed/index.ts",
					original: "\t\tevidence === undefined ||",
					replacement: '\t\tevidence === undefined ||\n\t\tevidence.kind === "roster" ||',
					why: "R07 takes no roster occurrence for a membership, so a roster match a plain match also binds is kept; the public-programs-roster search fails."
				}
			]
		}
	)
