/**
 * The type/engine agreements over drawn queries (test/support/agreement/queries.ts), each a program a batch checks
 * disarmed:
 *
 * 1. Evidence (`evidence`): the drawn queries, the engine's verdict on each stated as types: each query's claimed keys
 *    lie over the engine's, its cardinality is the engine's, and its records, parameters and reads the engine's decoded
 *    heading and parameters. A refused query raises exactly its directive's refusal, so a claimed key the engine does
 *    not prove, a cardinality the engine does not state, or a record or parameter the engine does not deliver, fails
 *    its assertion. One class is declared, the one the types cannot decide: a closed relation's column of distinct
 *    constant values, which the engine keys the relation by (README "Closed relations") and the types cannot see, as
 *    a value no literal types (ToneWeight's weight, a Cents bigint). A query over ToneWeight whose cardinality its
 *    rows prove more of than its declared key does is of the class, and is stated under its declared key's reading,
 *    the types' (test/support/agreement/queries.ts closedDistinct); a query its rows prove less of is no class, and
 *    holds the types to the engine. The kept case holds one of the class; no witness reaches it. Each query no take
 *    closes, of one heading, is paged: its page is of that very ordered query, and its unordered self is refused a
 *    page.
 * 2. Order invariance, in the same program: the batch's queries again in the other order, as a second module, and
 *    every query's head and keys asserted equal across the two, so TypeScript's evidence never depends on unrelated
 *    statements' order.
 * 3. Admission (`admission`, test/support/agreement/admission.ts): every position a constant stands in against every
 *    constant kind, each under every value and stage its kind has, a parameter of the column's descriptor and of
 *    another's among them, a self-join's second scope among them, the program admitting exactly what the engine admits;
 *    every combinator over every shape of query; and the scope axis: a query matched, as it is and bound, over each
 *    level against its rule's schema, a relation parameter bound to each kind of source, each query at each level of
 *    the import's, the rule's and of neither, a write's parameters bound by ChangeSet.bind to each kind of value, and a
 *    relational negation at each place in a rule's filters, each admitted cell's parameters the ones a call of it
 *    supplies. Beside it, the argument axis (`arguments`, test/support/agreement/arguments.ts):
 *    every shape of a query's parameters against every form of argument, through every method that takes one, the
 *    program admitting exactly what the runtime's reading of an argument admits.
 * 4. Faults (`faults`): queries of the same generator, each planting one fault at a site whose drawn value the engine
 *    decides; a query it refuses is stated under the refusal its reason is, at the fault's site, and one it admits as a
 *    clean query is.
 * 5. Filter order (`reordered`): every drawn query's verdict, the engine's, is the same with each rule's filters in the
 *    other order, so a variable two filters fix is fixed to both values, whichever is written first, as the types read
 *    it.
 *
 * The witnesses of the clean space reach every construct the evidence types reason about, and those of the faulted
 * space every fault refused and each whose site may hold a valid value admitted, so neither program is vacuous; the
 * admission and argument boxes hold every position, kind, shape and form by construction.
 */
import { assert } from "@bjornpagen/testing/assert"
import { oneOf } from "@bjornpagen/testing/gen"
import { property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { admissionProgram } from "#test/support/agreement/admission.ts"
import { argumentProgram } from "#test/support/agreement/arguments.ts"
import {
	agreementCases,
	agreementReached,
	evidencePrelude,
	evidenceProgram,
	evidenceRequired,
	evidenceSpace,
	faultCases,
	faultProgram,
	faultSpace,
	faultsRequired,
	reorderedVerdicts
} from "#test/support/agreement/queries.ts"
import { agreement, boxAgreement } from "#test/types/batch/agreement.ts"
import { argumentBox, admissionBox } from "#test/types/evidence/agreement.dictionary.ts"

/**
 * Over drawn queries in two orders, the types accept a query, its records and its parameters exactly as the engine
 * does, and its keys. It runs the runner's default budget, not the pre-conversion suite's rotating count (240): at
 * TEST_SEED=777, run beside it, the default's whole process tree took 208.5 CPU-s against the old count's 272.6, the
 * old count's floor needing 200 steered cases where the default's needed 150
 * (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets/r2/evidence.*.txt, 2026-11-16, load 470 to 670).
 */
export const evidence = agreement(evidenceSpace, {
	situations: evidenceRequired,
	notes: agreementReached,
	checking: "disarmed",
	program: evidenceProgram,
	oracle: { kind: "second-implementation", name: "the engine's verdict on each drawn query" },
	kept: [
		{
			token: ReplayToken(
				"test/types/evidence/agreement.test.ts#evidence:-:1m.2.1.2.1.2.2.1.1.2.0.2.2.1.0.1.1.3.0.3.1.0.2.0.0.1.1.1.2.3.2.0.3.0.0.1.3.2.1.2.2.1.2.0.1.3.1.3.3.0.1.3.0.3.3.3.3.1.3.2.2.3.1.1.2.1.0.0.4.2.4.2.0.0.1.1.1.2.1.0.1.0.1.4.2.0.1.0.1.0.0.0.6.2.1.1.1.1.3.2.1.2.1.1.2.5.0.1.1.4.1"
			),
			reason:
				"a rule fixing Slot's key by a constant item and r.allen(slot.during, ALLEN.converse(ALLEN.equals), a span parameter): the engine proves get, an equality its equals mask lowers to, where the types read every mask as stating nothing (TEST_SEED=2458598146); its head's cosine distance reads Slot's embedding, which the fixed key determines, one value per delivered row, so the head's rows are natively distinct and keyed (trunk red at 055ecb6fd, where every float a projection computed told its rows apart as members)",
			since: "2026-11-16"
		},
		{
			token: ReplayToken(
				"test/types/evidence/agreement.test.ts#evidence:-:13.2.1.0.1.2.1.0.0.3.1.2.0.1.3.2.1.1.2.3.2.2.3.1.0.1.1.0.2.3.3.3.2.1.2.0.1.3.2.0.3.0.1.3.3.2.2.0.2.1.2.2.2.0.1.1.3.2.2.3.0.1.3.3.3.0.0.1.1.1.0.0.3.1.0.0.0.6.3.0.2.0.0.0.1.1.3.2.0.0.0.0.1.1.1.1.0.3.3.1.1.0.0.1.0.1.1.0.1.2.2.0.0.0.0.0.1.t.1.1.9.c.1.1.1.4.0.0.a.1.2.1.0.2.1.0.0.5.1.0.1.0.0.0.0.0.1.2"
			),
			reason:
				"a union of three rules of constants, h0 low throughout and b y, x, x, two rules alike: the engine keys it by b, the fields its rules do not all fix alike, where the types, which required every two rules told apart, keyed it by its whole heading (TEST_SEED=1635200356)",
			since: "2026-11-16"
		},
		{
			token: ReplayToken(
				"test/types/evidence/agreement.test.ts#evidence:-:c.0.0.0.0.3.0.0.0.0.2.0.0.2.2.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.2.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.2.2.3.3.0.4.1.2.0.1.2.0.2.0.0"
			),
			reason:
				"a union of three rules of constants, d z, y, x and b x, z, z: the engine keeps d alone, which tells all three apart, and drops b, the first separator of two pairs that d tells apart too, so the union is keyed by d, not by b and d",
			since: "2026-11-16"
		},
		{
			token: ReplayToken(
				"test/types/evidence/agreement.test.ts#evidence:-:0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.5.0.0.1.0.0.1.0.0"
			),
			reason:
				"ToneWeight matched with a flag fixing its tone by p0 or its weight by p1, its tone in the head: the engine proves at most one row under both readings, its weights distinct, where the types, which read its declared key, the tone, prove many under the weight's; the declared class, a closed relation's column of distinct constant values (TEST_SEED=669114265)",
			since: "2026-11-18"
		},
		{
			token: ReplayToken(
				"test/types/evidence/agreement.test.ts#evidence:800002180008004000000000.33:0.0.0.1.1.0.1.0.0.0.0.0.0.1.0.0.0.0.0.0.1.0.0.0.0.0.0.0.3.0.0.0.0.0.3.1.3.1.0.0.0.0.0.0.0.0.0.0.1.1.0.0.0.0.0.0.0.1.1.0.0.3.0.3.1.0.1.0.2.0.2.0.2.0.2.0.0.0.0.2.0.0.0.1.0.2.0.0.0.0.0.0.0.1.p.0.0.0.0.0"
			),
			reason:
				"an approximate search over a region of Item, a relation parameter, Owned bound and Slot that negates OwnerCounts at the parameter's id: OwnerCounts is computed at the keys the region reads, a key set of the statement's WITH that reads the region's own sources, Slot among them, which its first read defined inside the scope that reads Slot through the search's ordered stream, so the key set read that very stream again, its query spliced into the WITH a second time under a column list of Slot's heading, short of the stream's distance, and a second search that may find fewer rows than the region's, the negation then missing keys; the key set reads Slot itself (TEST_SEED=2219874524, trunk red since 7c0f2c554)",
			since: "2026-11-24"
		}
	],
	kills: [
		{
			file: "packages/engine/src/logical/props.ts",
			original: "\t\t\t\treaches(reached, c)",
			replacement: "\t\t\t\tfalse",
			why: "A float a projection computes from columns its delivered row determines is held apart in a zero's sign (logical/props.ts oneValuePerRow), so the kept allen-mask query's head claims no key, where the types prove one; the program fails."
		},
		{
			file: "packages/engine/src/types/db/workload.ts",
			original:
				'type PagedArgument<O> = O extends OrderedBase ? PageOf<O> : Refusal<"page needs an ordered query">',
			replacement: "type PagedArgument<O> = O extends OrderedBase ? PageOf<O> : unknown",
			why: "paged takes a query no orderBy made (types/db/workload.ts PagedArgument answers unknown for it), so a paged query's unordered self is admitted; the agreements' program fails."
		},
		{
			file: "packages/engine/src/check/approximate/trace.ts",
			original: "\tconst scored = zeroPeeled(out.expr).term\n",
			replacement: "\tconst scored = out.expr\n",
			why: "An approximate search's score is read without its canonical zero, which the merge completion puts on a float its head delivers (check/complete.ts), so the lowering refuses a cosine distance the checker admitted; a clean drawn query's nearest search dies."
		},
		{
			file: "packages/engine/src/types/query/terms.ts",
			original: "	readonly [K in AnyKeyOf<Head>]: BindingAt<C, K> | StatedAt<C, K>",
			replacement: "	readonly [K in AnyKeyOf<Head>]: BindingAt<C, K>",
			why: "A negation's binding meets its field as a match's does, of one identity: a Cents variable bound to a natural field in r.not is refused by the types, where the engine correlates the two by base carrier; the program of the witness of a negation across refining types fails."
		},
		{
			file: "packages/engine/src/query/build/terms.ts",
			original: "export const negationPairing = sameCarrier",
			replacement: "export const negationPairing = compatible",
			why: "The builder binds a negation's variable only to a field of its identity: a Cents variable in r.not of a natural field is refused when the rule is built, where the types admit it; the program of the witness of a negation across refining types fails."
		},
		{
			file: "packages/engine/src/types/query/rule.ts",
			original: "\t\tb: B & RefinedEquality<A, B>",
			replacement: "\t\tb: B & Operand<T<A>, SqlOfTerm<A>, LanguageOf<A>>",
			why: "r.eq takes only an operand that meets its first's type: a Cents variable equated with a natural one is refused by the types, where the engine types the equality at their carrier; the program of the witness of an equality across refining types fails."
		},
		{
			file: "packages/engine/src/scalar/compute/typing.ts",
			original: "\t\tif (!meets(against.nominal, term.nominal) && !refinedPair(against, term)) {",
			replacement: "\t\tif (!meets(against.nominal, term.nominal)) {",
			why: "The engine refuses an equality of two refinements of one base carrier, where the types admit it: the program of the witness of an equality across refining types fails."
		},
		{
			file: "packages/engine/src/lower/shapes/index.ts",
			original: "\t\t\t\tconst statement = cx.atStatementRoot(dispatch)\n",
			replacement: "\t\t\t\tconst statement = cx\n",
			why: "A statement's CTE and the key set it is computed at are lowered in the scope of the read that first defines them (lower/shapes/index.ts dispatchIn), so the kept search's negation's key set reads Slot through the search's ordered stream, spliced into the WITH a second time; the lowering fails its audit."
		}
	]
})

/**
 * Over drawn queries each planting one fault, the types refuse exactly the faults the engine refuses, at the fault's
 * site and under the refusal its reason is, and state an admitted one as a clean query is stated. It runs the runner's
 * default budget, not the pre-conversion suite's rotating count (152): at TEST_SEED=777, run beside it, the default's
 * whole process tree took 95.9 CPU-s against the old count's 104.4, both reaching every situation
 * (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets/r2/faults.*.txt, 2026-11-16, load 470 to 670).
 */
export const faults = agreement(faultSpace, {
	situations: faultsRequired,
	notes: agreementReached,
	checking: "disarmed",
	program: faultProgram,
	oracle: { kind: "second-implementation", name: "the engine's verdict on each faulted query" },
	kept: [
		{
			token: ReplayToken(
				"test/types/evidence/agreement.test.ts#faults:-:6.h.0.0.0.0.0.0.0.3.1.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.1.0.0.0.0.0.3.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.2.1.0.1.0.1.1.1.1.1.0.3.1.0.1.2.1.1.1.1.1.0.0"
			),
			reason:
				"a union of two rules whose constant heads differ at four fields, three of them roster handles: the types keyed it by each of the four, where the engine keeps the first in heading order, d (TEST_SEED=1635200356)",
			since: "2026-11-16"
		},
		{
			token: ReplayToken(
				"test/types/evidence/agreement.test.ts#faults:7fffffff.11:0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0"
			),
			reason:
				"a Reader query over Item binding its cost, a Cents contract that declares nonnegative, to a parameter: its map's entry is ParamType of the contract's domain, its brand and declared fact with it, where the oracle wrote the plain base's, bigint, once a contract's descriptor held its carrier and contract alone (011a72711) and its domain was read off the base (test/support/agreement/heading.ts paramDomain)",
			since: "2026-11-19"
		}
	],
	kills: [
		{
			file: "packages/engine/src/types/query/rule.ts",
			original: "\t{ readonly [K in Name]: ParamType<D, Sql, H> },",
			replacement: "\t{ readonly [K in Name]: ParamType<H, Sql, H> },",
			why: "A scalar parameter's map entry is typed by its descriptor's host values, not its domain (types/query/rule.ts ParamTerm), so a contract's declared facts leave it; the kept Cents parameter's entry disagrees with the engine's."
		}
	]
})

/**
 * Every constant kind at every position, under every value and stage of its kind, every combinator over every shape
 * of query and every cell of the scope axis: the types admit exactly what the engine admits, and name its refusal.
 */
export const admission = boxAgreement(admissionBox, {
	box: "every position against every constant kind, under every value and stage of the kind; every combinator over every shape under every wrapper; every level, relation source, write binding and negation place of the scope axis",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: (cells, entry) => admissionProgram(cells, evidencePrelude(entry)),
	oracle: {
		kind: "second-implementation",
		name: "the engine's compilation of each cell's statement"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/check/checker.ts",
			original: 'k === c.name && h.kind === "parent" && h.column === c.parent',
			replacement: "true",
			why: 'Operator mutant 21a6720246 at packages/engine/src/check/checker.ts:3856 in <module>: `k === c.name && h.kind === "parent" && h.column === c.parent` becomes `true`; the property fails (the census, lane TESTPOLICY2).'
		},
		{
			file: "packages/engine/src/types/query/query.ts",
			original: "\t): BoundSource<\n\t\tBoundOver<Over, B, P>,\n",
			replacement: "\t): BoundSource<\n\t\tOver,\n",
			why: "A bound import keeps its query's schema whatever its relation parameter is bound to, so a rule over Agree matching byIds bound to a query over AgreeAbove (aboveRule) is admitted by the types, where the engine refuses it a level above the rule (ForeignLevel)."
		},
		{
			file: "packages/engine/src/types/query/query.ts",
			original:
				'\t\t? Refusal<"a relation parameter binds a query over a level of the schema it is bound in, or over a schema that schema is a level of">\n',
			replacement: "\t\t? unknown\n",
			why: "A relation parameter takes a query over a level apart from the import's (apart), which the engine refuses by the levels rule, so the types admit what the engine refuses."
		},
		{
			file: "packages/engine/src/query/build/query.ts",
			original: "\tconst over = highestLevel(levels)\n",
			replacement: "\tconst over = state.schema.over\n",
			why: "The bound import keeps its query's level, so the engine admits a query over Apart bound into byIds (apart) and a rule over Agree matching a bound import that reads AgreeAbove (aboveRule), both of which the types refuse."
		},
		{
			file: "packages/engine/src/types/core/phantom.ts",
			original:
				'\t: "sourceParams" extends keyof B\n\t\t? B["sourceParams" & keyof B]\n\t\t: unknown\n',
			replacement: "\t: unknown\n",
			why: "No program's parameter reader reads a bound query's, those its bind map needs (core/phantom.ts BundleParams, types/query/query.ts ParamsOf), so a write whose ids is bound to a bound query whose bind map reads the call's q (callerBoundQuery) states p alone where the engine needs p and q; the program fails."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original:
				"\t\tUnionToIntersection<{ [K in keyof A]-?: ParamsContribution<ParamsOf<A[K]>> }[keyof A]>\n",
			replacement: "\t\tUnionToIntersection<{ [K in keyof A]-?: ParamsOf<A[K]> }[keyof A]>\n",
			why: "ChangeSet.bind folds its bind map's values as maps, so the value bound to p, which needs none, is unknown beside the query of q (valueBeside) and erases q: the write states no parameter where the engine needs q; the program fails."
		}
	]
})

/**
 * Every shape of a query's parameters against every form of argument: the types admit exactly what the runtime's
 * reading of an argument admits.
 */
export const argumentForms = boxAgreement(argumentBox, {
	box: "every parameter shape against every form of argument it has one of",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: (cells, entry) => argumentProgram(cells, evidencePrelude(entry)),
	oracle: { kind: "second-implementation", name: "the runtime's reading of each argument" },
	kept: [],
	kills: []
})

/** Over drawn queries, clean and faulted, the engine's verdict is the same with each rule's filters in the other order. */
export const reordered = property.explore(oneOf([agreementCases, faultCases]), {
	situations: [],
	needs: {},
	check: () => (c) =>
		Effect.sync(() => {
			const verdicts = reorderedVerdicts(c)
			assert.equal(
				verdicts.reordered,
				verdicts.written,
				`the filters' order moves the verdict of\n${c.source}`
			)
		}),
	oracle: {
		kind: "specification",
		name: "a rule's filters are a conjunction, whose order is no part of it"
	},
	kept: [
		{
			token: ReplayToken(
				"test/types/evidence/agreement.test.ts#reordered:-:1.0.1.0.0.0.0.0.0.1.0.3.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.7.1"
			),
			reason:
				"a count over two matches of OwnerCounts, Rollup's live derived relation keyed by its owner, each binding its owner to a parameter: each match binds a key of the relation, so the fold reads each fact once, where the engine read a live derived relation as an import of its definition, a set keyed by its whole heading, and refused the fold as binding none of its keys, (owner, items), naming no relation; the types, and a stored OwnerCounts, read its proven key (TEST_SEED=2219874524, trunk red since e1b52df00 made OwnerCounts live)",
			since: "2026-11-24"
		}
	],
	kills: [
		{
			file: "packages/engine/src/query/build/rule.ts",
			original: "!isPlainRecord(head)",
			replacement: "isPlainRecord(head)",
			why: "Operator mutant deee5fdd24 at packages/engine/src/query/build/rule.ts:470 in ruleValue: `!isPlainRecord(head)` becomes `isPlainRecord(head)`; the property fails (the census, lane TESTPOLICY2)."
		},
		{
			file: "packages/engine/src/query/build/state.ts",
			original: '\t\t\tdesc: { kind: "relation", name: derived.name },',
			replacement: '\t\t\tdesc: { kind: "query", query: derived.query, bind: {} },',
			why: "A rule reads a derived relation as an import of its definition (query/build/state.ts sourceInfo), a set the checker keys by its whole heading, so the kept count over OwnerCounts, each match binding its owner, is refused as binding none of its keys; the property dies on the generator's defect."
		}
	]
})
