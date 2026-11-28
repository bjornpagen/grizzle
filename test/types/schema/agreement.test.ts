/**
 * The schema agreement (test/support/agreement/schemas.ts), a program a batch checks disarmed, each case a module of
 * its own: over drawn schemas and probes, the types infer what the engine describes, each field's host, fact and keys,
 * and refuse exactly what it refuses, naming its refusal. Oracle: the engine's description of each drawn schema. The
 * witnesses reach every construct, every fault and every refusal it names. Beside it, the kept faults no drawn probe
 * plants, each alone on one base.
 */
import { ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr } from "effect"
import {
	keptFaultCase,
	schemaAimed,
	schemaProgram,
	schemaRequired
} from "#test/support/agreement/schemas.ts"
import { agreement, boxAgreement } from "#test/support/types/batch/agreement.ts"
import { schemaKeptBox } from "#test/types/schema/agreement.dictionary.ts"

/**
 * Over drawn schemas and probes, the types infer what the engine describes and refuse exactly what it refuses. Its
 * budget, 48 runs and the runner's 200 steered cases, is the pre-conversion suite's rotating count (48), restored
 * because it costs no more: at TEST_SEED=777, run beside the runner's default of 150, the whole run's process tree took
 * 226.3 CPU-s against 328.9, every situation reached and every kill killed alike (budgets/schemas.*.txt)
 * (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets, 2026-11-16, load 470 to 670).
 */
export const schemas = agreement(schemaAimed, {
	budget: { runs: 48, steered: 200 },
	situations: schemaRequired,
	notes: (c) => c.notes,
	checking: "disarmed",
	program: schemaProgram,
	oracle: { kind: "second-implementation", name: "the engine's description of each drawn schema" },
	kept: [
		{
			token: ReplayToken(
				"test/types/schema/agreement.test.ts#schemas:7fffffffffffffffffffffffffffffffffffffffffffffffffffffffff.1:1.0.1.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.2.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
			),
			reason:
				"a contract over a numeric(7, 2) field, whose descriptor is NumericTypmodField<Decimal> since numeric's host follows its scale (4da9792ba), where the model wrote the bare NumericTypmodField, Decimal | bigint (TEST_SEED=655968417; its token drawn again at the merged tree, whose schemas agreement declares 231 requirements where the token's steering named 243, VALUECELL's deletion of the alternatives pack and probe (271ffecf2) among the twelve gone: the floor's first failure under the kill that forgets numeric's scale)",
			since: "2026-11-19"
		},
		{
			token: ReplayToken(
				"test/types/schema/agreement.test.ts#schemas:7fffffffffffffffffffffffffffffffffffffffffffffffffffffffff.0:5.0.0.1.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.2.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
			),
			reason:
				"a contract over another, Code over Cents, both under the program's one Key: BRAND's KeyApart (97c8891645) refuses it in the types while the engine admits it, TypesDisagreed at case-0.ts:31 (floor 0x70a719f7, case 0, on the merged tree); each pool contract is under a key of its own since",
			since: "2026-11-27"
		},
		{
			token: ReplayToken(
				"test/types/schema/agreement.test.ts#schemas:7fffffffffffffffffffffffffffffffffffffffffffffffffffffffff.1:0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.1.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.1.0.0.0.0.1.0.0.0.1.0.0.1.2.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
			),
			reason:
				"a containment of Counts(owner) in Account(owner), Account in the declared unit over its id: NOSETTINGS refuses a probed law over an aggregate whose groups span the units (UnsupportedLawFamily), which no type tracks, and the generator drew it as admitted (floor 0x70a719f7, case 1, behind case 0); now the declared class aggregateAcrossUnits",
			since: "2026-11-27"
		}
	],
	kills: [
		{
			file: "packages/engine/src/schema/own.ts",
			original: '\t\tif (st.kind === "mutable" && !unitOf.has(st.relation)) {',
			replacement: '\t\tif (st.kind === "mutable" && unitOf.size < 0) {',
			why: "Ownership admits mutable(R) over a relation in no unit (schema/own.ts ownUnits), which the types refuse: the mutableOutsideUnit fault's schema is admitted by the engine and the agreement's program fails."
		},
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original: "\tMutable<unknown> extends Statements[number]\n\t\t? unknown",
			replacement: "\tStatements extends Statements\n\t\t? unknown",
			why: "The types admit mutable(R) over a relation in no unit (MutablesUnder refuses nothing), which the engine refuses: the mutableOutsideUnit fault typechecks under its directive and the agreement's program fails."
		},
		{
			file: "packages/engine/src/scalar/values/convert.ts",
			original: "\t\t? bigint\n\t\t: Decimal\n",
			replacement: "\t\t? Decimal\n\t\t: Decimal\n",
			why: "numeric(p, 0)'s host is a Decimal again, where the engine reads a bigint (types/fields NumericHostOf); the numericAtScaleZero situation's case fails."
		},
		{
			file: "packages/engine/src/scalar/values/convert.ts",
			original: "\t\t: Decimal\n",
			replacement: "\t\t: Decimal | bigint\n",
			why: "numeric(p, s)'s host forgets its scale at a literal scale other than 0, Decimal | bigint, where the engine reads a Decimal (types/fields NumericHostOf); the kept numeric(7, 2) case fails."
		},
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original: "\t\t\t: true extends SameAs<UnderName<Relations, NameStated<R>>, R>",
			replacement: "\t\t\t: NameStated<R> extends keyof Relations",
			why: "A statement's relation is admitted wherever the schema holds a relation of its name, the relation held under another name among them (types/schema/schema.ts Undeclared); the agreement's program fails."
		},
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original:
				"\treadonly statements: readonly [...Below, ...StatementsFromNames<Named, SpelledOver>]",
			replacement:
				'\treadonly statements: readonly [\n\t\t...Below,\n\t\t...StatementsFromNames<Named, SpelledOver>,\n\t\t...ReadonlyArray<Fragments["statements"][number]>\n\t]',
			why: "A level's statements are an open tuple again, its fragments' statements spread as ReadonlyArray after its own (types/schema/schema.ts), so every drawn schema's StatementsOf is no longer the tuple its calls wrote; the agreement's program fails."
		},
		{
			file: "packages/engine/src/analysis/theory/families.ts",
			original:
				'\tconst parent = drawnOfTree(fieldTerm(t, parentTerm, "a tree\'s side", loc))\n\tconst at = drawnOfTree(fieldTerm(t, atTerm, "a tree\'s side", loc))',
			replacement:
				'\tconst parent = drawnField(t, fieldTerm(t, parentTerm, "a tree\'s side", loc), "parent", loc)\n\tconst at = drawnField(t, fieldTerm(t, atTerm, "a tree\'s side", loc), "index", loc)',
			why: "A tree's parent and index go back on the generic family check (analysis/theory/families.ts treeShape), so the engine refuses a caller's parent or index as MalformedDescription where the types name the tree's shape; the treeSideWritten probe fails placement."
		},
		{
			file: "packages/engine/src/ir/monoid.ts",
			original: '\t\t\treturn base.caps.includes("minMax") && first !== undefined',
			replacement: "\t\t\treturn first !== undefined",
			why: "max admits a closed id of an unordered roster (ir/monoid.ts bounded), which has no least value and no order, so the engine admits the planted fold where the types refuse it; the unorderedMax probe fails."
		},
		{
			file: "packages/engine/src/types/schema/statements.ts",
			original: "\t\t\t: [D] extends [Unordered]\n\t\t\t\t? false\n\t\t\t\t: true",
			replacement: "\t\t\t: [D] extends [Unordered]\n\t\t\t\t? true\n\t\t\t\t: true",
			why: "A fold's max over a closed id of an unordered roster is typed admitted (types/schema/statements.ts MonoidAdmits), where the engine refuses it; the unorderedMax probe fails."
		}
	]
})

/**
 * Each kept fault, a side over a selection by counted, ordered and tree, on the base the agreement's floor first drew:
 * the types refuse exactly what the engine refuses.
 */
export const keptFaults = boxAgreement(schemaKeptBox, {
	box: "every kept fault, each alone on one base",
	situations: [],
	notes: (fault) => keptFaultCase(fault).notes,
	checking: "disarmed",
	program: (faults, entry) => schemaProgram(Arr.map(faults, keptFaultCase), entry),
	oracle: { kind: "second-implementation", name: "the engine's description of the kept base" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/laws/model/plan.ts",
			original: `return \`\${c.draws.kind} \${c.draws.family.owner}.\${c.draws.family.count}\${\n\t\t\t\tc.draws.kind === "before" || c.draws.kind === "after"\n\t\t\t\t\t? \` \${c.draws.fold} \${c.draws.plane}\`\n\t\t\t\t\t: ""\n\t\t\t}\`\n\t\tcase "indexPred":\n\t\t\treturn \`indexPred \${c.named.owner}.\${c.named.count}\``,
			replacement: `return \`indexPred \${c.named.owner}.\${c.named.count}\`   case "indexPred":    return \`\${c.draws.kind} \${c.draws.family.owner}.\${c.draws.family.count}\${     c.draws.kind === "before" || c.draws.kind === "after"      ? \` \${c.draws.fold} \${c.draws.plane}\`      : ""    }\``,
			why: `Operator mutant 8ff921a20b at packages/engine/src/laws/model/plan.ts:3196 in lawColumnText: \`return \`\${c.draws.kind} \${c.draws.family.owner}.\${c.draws.family.count}\${     c.draws.kind === "before" || c.draws.kind === "after"      ? \` \${c.draws.fold} \${c.draws.plane}\`      : ""    }\`   case "indexPred":    return \`indexPred \${c.named.owner}.\${c.named.count}\`\` becomes \`return \`indexPred \${c.named.owner}.\${c.named.count}\`   case "indexPred":    return \`\${c.draws.kind} \${c.draws.family.owner}.\${c.draws.family.count}\${     c.draws.kind === "before" || c.draws.kind === "after"      ? \` \${c.draws.fold} \${c.draws.plane}\`      : ""    }\`\`; the property fails (the census, lane TESTPOLICY2).`
		}
	]
})
