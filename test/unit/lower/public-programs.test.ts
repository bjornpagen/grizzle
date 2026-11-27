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
					"test/unit/lower/public-programs.test.ts#theOptimizedLoweringOfCheckedPublicProgramsBuildsNoDAGThatBreaksARuleForAGeneratedRead@small-stack:-:4.1.0.0.1.0.1.0.1.0.1.0.1.0.1.0.1.2.1.0.1.0.1.0.1.2.1.0.1.2.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.0.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.3.0.0.0.0.0.0.0.0.0.0.0.0.4.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.2.guu.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0"
				),
				reason:
					"a union of two counts grouped by Bool, each arm at Bool = 0 (1) and Bool = $p0_0 ($p0_1), its result ordered by column0, the key its arms' literals tell apart: the constant columns read Bool as the parameter, `$p0_0 = 0` left and column0 projected as $p0_0, so since fafc65db0a, whose claims are each pass's output's analysis, the union proved no key in column0 and the order broke the DAG's rule (rotating 0xb475cf76, case 150). A column's canonical value is its most specific name, a literal over a parameter (lower/optimize/propagate fixings)",
				since: "2026-11-26"
			},
			{
				token: ReplayToken(
					"test/unit/lower/public-programs.test.ts#theOptimizedLoweringOfCheckedPublicProgramsBuildsNoDAGThatBreaksARuleForAGeneratedRead@small-stack:-:4.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1.2.0.1.0.1.0.1.0.1.0.1.0.1.0.1.2.1.0.1.0.1.0.0.1.0.1.0.1.0.1.0.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.4.0.0.0.0.0.0.0.35s.0.0.0.0.0.0.3.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.xpn.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.guu.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.guu.0.1.0.0.0.0.0.0.0.0.0.2.0.6bk.0.0.0.0.0.0.1.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.2.0.0.1.0.1.0.2.2.1.0.1.0.0.0.0.0.0.0.0"
				),
				reason:
					"a union of two arms, Bool's Red (Green) beside Rel0x0, keyed by Bool, and the relation parameter rel2_0 at its Bool and field1, side0 the literal 0 (1), its result ordered by (column0, side0), the key the arms' column0 and their literals make: R02 reads Rel0x0 as an existence test of rel2_0's rows, and the semi-join kept none of its key's determination of field1, so, since fafc65db0a's claims are their output's analysis, each arm was keyed by (column0, column1) alone and the order no total order of what the DAG proves (rotating 0xc1c125c3, case 89, red at fafc65db0a's own tip, main d3bb3996b lowers it). A semi-join keeps its right side's dependencies among its paired columns (logical/props.ts pairedDependencies)",
				since: "2026-11-26"
			},
			{
				token: ReplayToken(
					"test/unit/lower/public-programs.test.ts#theOptimizedLoweringOfCheckedPublicProgramsBuildsNoDAGThatBreaksARuleForAGeneratedRead@small-stack:-:4.1.0.1.0.1.0.1.0.0.1.0.0.1.2.1.2.1.0.0.1.2.1.2.1.0.1.0.1.2.1.0.1.2.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.4.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.1.0.0.0.0.0.3.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.cn4.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.guu.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.guu.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.guu.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.2.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.guu.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.2.guu.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.guu.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.1.0.0.0.0.1.xpn.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.guu.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.2.2.2.2.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.1"
				),
				reason:
					"a union of two rules over Rel0x0 at Bool = $p2_0 ($p2_1), each finding column0 and column1 copies of Bool and column2, taken first by (column1, column2): the checker completed the order over the key (column0, column2), column1 of column0's class, and constant propagation made both copies the arm's parameter, two outputs of one value no class held, so each arm, and the union, lost column0 = column1 and the take's order covered no key of what the DAG proves (rotating 0xb0cdb3bd, case 10). A projection's outputs of one parameter or one outer column, values known only by their names, are equal as copies of one column are (logical/props.ts projectProps, unknownValue)",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\t\t\tappendAll(deps, pairedDependencies(reading.on, right))\n",
				replacement: "",
				why: "A semi-join keeps none of its right side's dependencies: the kept union's arms, whose relation R02 reads as an existence test, are keyed by (column0, column1), and its order on (column0, side0) is no total order of what the DAG proves."
			},
			{
				file: "packages/engine/src/lower/optimize/propagate/index.ts",
				original: "\t\treturn f === undefined || literal.has(f.column)\n",
				replacement: "\t\treturn f === undefined\n",
				why: "A column a conjunct equates with a literal read as the parameter another conjunct equates it with: the kept union's arms project the parameters, no literal tells them apart, and its order on column0 is no total order of what the DAG proves."
			},
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\t\tconst value = name === undefined ? undefined : unknownValue(name)\n",
				replacement: "\t\t\tconst value = undefined\n",
				why: "A projection's outputs of one parameter are no class: the kept union's arms, whose copies of Bool constant propagation made the parameter, lose column0 = column1, and the take's order on (column1, column2) covers no key of what the DAG proves."
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
