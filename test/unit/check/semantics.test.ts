import { assert, unorderedEqual } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { exprClosure } from "#compiler/ir/expr.ts"
import { exprsOf } from "#compiler/ir/rel.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput } from "#compiler/lower/conservative/types.ts"
import { queryInput } from "#compiler/program/input.ts"
import { failed, placeOf, refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import { caseSketchGen, resolveCase } from "#test/support/oracle/public/generate.ts"
import { noBindings, Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { noFunctions } from "#test/support/oracle/reference/functions.ts"
import { checkAuthored, checking, checkMemberOf, checkOptions } from "#test/support/policy.ts"
import {
	imported,
	lit,
	match,
	plainVar,
	queryDesc,
	rule,
	varRef
} from "#test/support/unit/check/dsl.ts"
import { kindOfType, schemaDescOf } from "#test/unit/check/drawn.ts"
import {
	type MemberFeature,
	memberDesc,
	memberFeatures,
	memberVerdict
} from "#test/unit/check/members.ts"
import {
	type ParamFeature,
	paramCaseDesc,
	paramCaseGen,
	paramFeatures,
	paramVerdict
} from "#test/unit/check/params.ts"
import { Lab } from "#test/unit/check/schemas.ts"
import {
	checkedNames,
	type DeclaredFeature,
	judgeDeclared,
	memberCaseSpace,
	memberLocOf,
	Tagged,
	taggedCaseGen,
	taggedFacts,
	type TakeBoundFeature,
	takeBoundFeatures,
	takeBoundGen,
	top,
	untagged,
	withinInt4
} from "#test/unit/check/semantics.fixtures.ts"

/** The checker's parameter, member and bound rules give every generated read's checked query exactly the read's own parameters, each of the type it is declared at. Its budget is its suite's before it was a property (test/unit/check/semantics.test.ts at 4ca3036a): 200 runs and 400 steered cases. */
export const theCheckersParameterMemberAndBoundRulesGiveEveryGeneratedReadsCheckedQueryExactlyTheReadsOwnParametersEachOfTheTypeItIsDeclaredAt =
	property.explore(caseSketchGen, {
		needs: {},
		budget: { runs: 200, steered: 400 },
		situations: [
			"a parameter declared by its field",
			"a parameter declared by its base",
			"a relation parameter",
			"an import bound to the read's parameter"
		] satisfies ReadonlyArray<Reached<DeclaredFeature>>,
		check: (_, k: Case<DeclaredFeature>) => (sketch) =>
			Effect.sync(() => {
				const c = k.draw(resolveCase(sketch))
				const built = buildSchema(c.schema)
				for (const read of c.reads) {
					if (read.kind !== "query") {
						continue
					}
					const input = succeeded(
						queryInput(buildRoot(built, built.schema, read.query)),
						"the builder admits a generated read"
					)
					const q = succeeded(
						checkQuery(checking(built.schema), input.desc, checkOptions("declared")),
						"the checker admits a generated read"
					)
					k.noteAll(judgeDeclared(read, q))
				}
			}),
		oracle: {
			kind: "specification",
			name: "the generated program's parameters and the descriptors it declares them with"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/expr.ts",
				original: `\t\t...(expr.id === key ? [] : [\`the table key equal to the expression's id \${expr.id}\`]),`,
				replacement: `\t\t...(expr.id !== key ? [] : [\`the table key equal to the expression's id \${expr.id}\`]),`,
				why: "Operator mutant 73cc341a78 at packages/engine/src/ir/expr.ts:1200 in entryProblems: `===` becomes `!==`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})

/** The checker's parameter, member and bound rules type each query's own parameters by the declarations their uses share, never an import's own, join a variable's fields within one family where one's kind guarantees the other's (31664c74c6), and refuse what those rules refuse. Its budget is its suite's before it was a property (test/unit/check/semantics.test.ts at 4ca3036a): 300 runs and 600 steered cases. */
export const theCheckersParameterMemberAndBoundRulesTypeEachQuerysOwnParametersByTheDeclarationsTheirUsesShareNeverAnImportsOwnJoinAVariablesFieldsWithinOneFamilyAndRefuseWhatThoseRulesRefuse =
	property.explore(paramCaseGen, {
		needs: {},
		budget: { runs: 300, steered: 600 },
		situations: [
			"declarations of two families",
			"a bound variable of another family",
			"a computed negation over an outer variable",
			"a variable bound to fields of two families",
			"a variable bound to fields no one of whose kinds guarantees the other's",
			"a variable joined across refinements",
			"a parameter widened",
			...Arr.map(
				[
					"a parameter a match binds",
					"a parameter a comparison reads",
					"a head parameter",
					"a negated source's parameter",
					"a computed negation over its own parameter",
					"a take's parameter",
					"an import bound to a parameter",
					"an import bound to a literal",
					"an import bound to a variable",
					"a negated import",
					"one name in two scopes"
				] as const,
				(f): readonly [ParamFeature, ParamFeature] => [f, "admitted"]
			)
		] satisfies ReadonlyArray<Reached<ParamFeature>>,
		check: (_, k: Case<ParamFeature>) => (c) =>
			Effect.sync(() => {
				const v = paramVerdict(c)
				const features = paramFeatures(c, v)
				k.noteAll(features)
				for (const f of features) {
					if (f !== "admitted" && v.kind === "admitted") {
						k.pair(f, "admitted")
					}
				}
				const result = checkAuthored(
					checking(schemaDescOf(c.schema)),
					paramCaseDesc(c),
					checkOptions("params")
				)
				if (v.kind === "refused") {
					const e = failed(result, `refused under ${Arr.join(v.rules, ", ")}`)
					assert.ok(
						Arr.contains(v.reasons, e.reason._tag),
						`one of the reasons ${Arr.join(v.reasons, ", ")} (${Arr.join(v.rules, ", ")}), not ${e.reason._tag}`
					)
					return
				}
				const q = succeeded(result, "the query the parameter rule admits")
				assert.deepEqual(
					new Map(
						Arr.flatMap(q.params, (p) =>
							p.kind === "scalar" ? [[p.name, kindOfType(p.type)] as const] : []
						)
					),
					new Map(v.params),
					"each own parameter of its declarations' common type"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the parameter rule restated over the drawn query (test/unit/check/params.ts)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/types.ts",
				original:
					"\tif (spanOf(a)?.width !== spanOf(b)?.width || exactDigitsOf(a) !== exactDigitsOf(b)) {",
				replacement:
					"\tif (spanOf(a)?.width === spanOf(b)?.width || exactDigitsOf(a) !== exactDigitsOf(b)) {",
				why: "Operator mutant e3bc5ac29a at packages/engine/src/scalar/compute/types.ts:286 in sameMeaning: `!==` becomes `===`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})

/** The checker's parameter, member and bound rules hold a member's head to its relation's heading for its op, every column entering its field at the field's own type, one heading and no attachment, refused at the member or the attachment. Its budget is its suite's before it was a property (test/unit/check/semantics.test.ts at 4ca3036a): 300 runs and 600 steered cases. */
export const theCheckersParameterMemberAndBoundRulesHoldAMembersHeadToItsRelationsHeadingForItsOpEveryColumnEnteringItsFieldAtTheFieldsOwnTypeOneHeadingAndNoAttachmentRefusedAtTheMemberOrTheAttachment =
	property.explore(memberCaseSpace, {
		needs: {},
		budget: { runs: 300, steered: 600 },
		situations: [
			"insert",
			"put",
			"delete",
			"admitted",
			"an attachment on an arm",
			"an attach stage",
			"no discriminant",
			"several headings",
			"a missing field",
			"an extra column",
			"a column of another type",
			"incompatible arms",
			"a parameter written as its field",
			"a sum written into a field",
			"two arms of one heading",
			"a numeric of another typmod",
			"a text of another pattern"
		] satisfies ReadonlyArray<Reached<MemberFeature>>,
		check: (_, k: Case<MemberFeature>) => (c) =>
			Effect.sync(() => {
				const v = memberVerdict(c)
				k.noteAll(memberFeatures(c, v))
				const result = checkMemberOf(checking(schemaDescOf(c.schema)), memberDesc(c), {})
				if (v.kind === "refused") {
					const e = refused(result, v.reason, v.rule)
					if (v.at !== "the union") {
						assert.deepEqual(
							placeOf(refusalLoc(e)),
							placeOf(memberLocOf(c, v.at)),
							`${v.rule}, located at ${v.at}`
						)
					}
					return
				}
				const q = succeeded(result, "the member the rule admits")
				assert.deepEqual(
					new Map(
						Arr.flatMap(q.params, (p) =>
							p.kind === "scalar" ? [[p.name, kindOfType(p.type)] as const] : []
						)
					),
					new Map(v.params),
					"each parameter of its field's kind"
				)
				const written = new Set(
					Arr.flatMap(exprClosure(Arr.flatMap(topoOrder(q.dag), (n) => exprsOf(n))), (e) =>
						e.kind === "param" && e.role === "write" ? [e.param] : []
					)
				)
				for (const name of v.params.keys()) {
					assert.ok(
						Arr.some(q.params, (p) => p.name === name && written.has(p.id)),
						`${name} is written as its field`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the member rule restated over the drawn member (test/unit/check/members.ts)"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/check/semantics.test.ts#theCheckersParameterMemberAndBoundRulesHoldAMembersHeadToItsRelationsHeadingForItsOpEveryColumnEnteringItsFieldAtTheFieldsOwnTypeOneHeadingAndNoAttachmentRefusedAtTheMemberOrTheAttachment:-:0.0.0.0.0.0.0.0.1.0.0.0.0.0.1.1.0.0.0.0.1.2.1.1.0.0.1"
				),
				reason:
					"a sum over a bigint, a computed numeric, written into a numeric(10, 2) field: compatible typed the head by its carrier alone and admitted it, where PostgreSQL's length coercion raises 22003 past the field's precision",
				since: "2026-11-10"
			}
		],
		kills: [
			{
				file: "packages/engine/src/check/member.ts",
				original: "\tif (missing.length > 0 || extra.length > 0) {",
				replacement: "\tif (missing.length > 0) {",
				why: "A member's head may hold a column its relation lacks (check/member.ts); the members property fails."
			}
		]
	})

/** The checker's parameter, member and bound rules bound take's parameter, which an import binds to a literal, by int4's positive range. Its budget is its suite's before it was a property (test/unit/check/semantics.test.ts at 4ca3036a): 60 runs and 60 steered cases. */
export const theCheckersParameterMemberAndBoundRulesBoundTakesParameterWhichAnImportBindsToALiteralByInt4sPositiveRange =
	property.explore(takeBoundGen, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: takeBoundFeatures satisfies ReadonlyArray<Reached<TakeBoundFeature>>,
		check: (_, c: Case<TakeBoundFeature>) => (bound) =>
			Effect.sync(() => {
				c.note(bound.kind)
				const importer = queryDesc(
					rule({
						vars: [plainVar("i")],
						matches: [match(imported(top, { k: lit(bound.value) }), { id: varRef("i") })],
						where: [],
						head: { id: varRef("i") },
						interiors: [],
						attach: []
					})
				)
				const r = checkAuthored(checking(Lab), importer, checkOptions("query"))
				if (withinInt4(bound.value)) {
					const q = succeeded(r, Formatter.format(bound))
					succeeded(
						lowerConservative(conservativeInput(q), {
							names: checkedNames,
							params: q.params,
							subject: { kind: "query" }
						}),
						"the admitted query lowers"
					)
					c.note("within")
				} else {
					refused(r, "MalformedDescription", Formatter.format(bound))
					c.note("outside")
				}
			}),
		oracle: {
			kind: "specification",
			name: "a take's bound is an integer of int4's positive range, 1 to 2^31 - 1"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\tif (k < 1n || k > BigInt(int4Max)) {",
				replacement: "\tif (k < 0n || k > BigInt(int4Max)) {",
				why: "A take of zero is admitted (check/checker.ts); the take's bound property fails."
			}
		]
	})

/** The checker's parameter, member and bound rules bind a negated match's parameter, which an import binds to a literal, to that literal. Its budget is its suite's before it was a property (test/unit/check/semantics.test.ts at 4ca3036a): 60 runs and 60 steered cases. */
export const theCheckersParameterMemberAndBoundRulesBindANegatedMatchsParameterWhichAnImportBindsToALiteralToThatLiteral =
	property.explore(taggedCaseGen, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: [
			"an item tagged at the label",
			"an item tagged at another label"
		] satisfies ReadonlyArray<
			Reached<"an item tagged at the label" | "an item tagged at another label">
		>,
		check: (_, k: Case<"an item tagged at the label" | "an item tagged at another label">) => (c) =>
			Effect.sync(() => {
				const importer = queryDesc(
					rule({
						vars: [plainVar("i")],
						matches: [match(imported(untagged, { l: lit(c.label) }), { id: varRef("i") })],
						where: [],
						head: { id: varRef("i") },
						interiors: [],
						attach: []
					})
				)
				const q = succeeded(
					checkAuthored(checking(Tagged), importer, checkOptions("query")),
					"the import"
				)
				const answer = Reference.of(q.dag, {
					schema: taggedFacts,
					facts: canonicalFacts({
						Item: Arr.map(c.items, (id) => [{ kind: "int", value: BigInt(id) }]),
						Tag: Arr.map(c.tags, ([item, label]) => [
							{ kind: "int", value: BigInt(item) },
							{ kind: "int", value: BigInt(label) }
						])
					}),
					params: {},
					functions: noFunctions,
					observer: unobserved
				}).eval(q.dag.roots[0], noBindings)
				const tagged = (item: number, at: (label: number) => boolean): boolean =>
					Arr.some(c.tags, ([i, l]) => i === item && at(l))
				unorderedEqual(
					Arr.map(answer.rows, (row) => row[0]),
					Arr.map(
						Arr.filter(c.items, (item) => !tagged(item, (l) => l === c.label)),
						(item) => BigInt(item)
					)
				)
				for (const item of c.items) {
					if (tagged(item, (l) => l === c.label)) {
						k.note("an item tagged at the label")
					}
					if (tagged(item, (l) => l !== c.label) && !tagged(item, (l) => l === c.label)) {
						k.note("an item tagged at another label")
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the items no Tag holds at the item and the bound label"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: "this.closedReads = closedReads(readable, this.patterns)",
				replacement: "{}",
				why: "Operator mutant 14ac793b0a at packages/engine/src/analysis/schema.ts:474 in <module>: `this.closedReads = closedReads(readable, this.patterns)` becomes `{}`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})
