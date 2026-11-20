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
	faultCases,
	faultProgram,
	faultsRequired,
	reorderedVerdicts
} from "#test/support/agreement/queries.ts"
import { agreement, boxAgreement } from "#test/types/batch/agreement.ts"
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
 *    level against its rule's schema, a relation parameter bound to each kind of source, and a relational negation at
 *    each place in a rule's filters. Beside it, the argument axis (`arguments`, test/support/agreement/arguments.ts):
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
import { argumentBox, admissionBox } from "#test/types/evidence/agreement.dictionary.ts"

/**
 * Over drawn queries in two orders, the types accept a query, its records and its parameters exactly as the engine
 * does, and its keys. It runs the runner's default budget, not the pre-conversion suite's rotating count (240): at
 * TEST_SEED=777, run beside it, the default's whole process tree took 208.5 CPU-s against the old count's 272.6, the
 * old count's floor needing 200 steered cases where the default's needed 150
 * (~/.cache/grizzle-release/TESTSYS/GZ-TYPES/measure/budgets/r2/evidence.*.txt, 2026-11-16, load 470 to 670).
 */
export const evidence = agreement(agreementCases, {
	situations: evidenceRequired,
	notes: agreementReached,
	checking: "disarmed",
	program: evidenceProgram,
	oracle: { kind: "second-implementation", name: "the engine's verdict on each drawn query" },
	kept: [
		{
			token: ReplayToken(
				"test/types/evidence/agreement.test.ts#evidence:-:1m.2.3.a.3.b.c.4.7.8.1.a.b.7.2.6.3.d.2.g.7.0.b.1.2.6.7.5.c.e.8.1.f.2.2.4.e.a.4.8.8.7.9.1.5.d.7.h.d.2.7.f.1.h.h.d.f.3.d.8.2.d.4.6.a.1.0.0.6.3.6.3.0.0.2.1.1.2.1.0.1.0.2.6.2.0.2.0.1.0.0.0.6.2.3.1.1.2.3.2.1.2.1.1.2.5.1.1.2.4.1"
			),
			reason:
				"a rule fixing Slot's key by a constant item and r.allen(slot.during, ALLEN.converse(ALLEN.equals), a span parameter): the engine proves get, an equality its equals mask lowers to, where the types read every mask as stating nothing (TEST_SEED=2458598146)",
			since: "2026-11-16"
		},
		{
			token: ReplayToken(
				"test/types/evidence/agreement.test.ts#evidence:-:13.2.6.2.6.c.3.2.1.d.6.c.1.7.h.a.6.6.8.g.8.9.f.4.2.3.3.2.b.h.f.f.9.3.a.2.4.f.9.1.f.0.6.h.g.a.a.0.9.6.a.9.c.0.6.5.e.a.9.g.2.6.h.f.h.1.0.2.1.1.0.0.4.1.0.0.0.6.4.0.3.0.0.0.1.1.3.3.0.1.0.0.1.1.2.2.1.4.3.2.1.0.0.1.1.1.1.0.2.2.4.0.0.1.0.1.2.t.1.1.9.c.1.3.1.4.0.0.a.2.2.2.0.2.2.0.0.5.1.0.1.0.0.0.0.0.1.2"
			),
			reason:
				"a union of three rules of constants, h0 low throughout and b y, x, x, two rules alike: the engine keys it by b, the fields its rules do not all fix alike, where the types, which required every two rules told apart, keyed it by its whole heading (TEST_SEED=1635200356)",
			since: "2026-11-16"
		},
		{
			token: ReplayToken(
				"test/types/evidence/agreement.test.ts#evidence:-:c.0.a.9.1.h.7.1.7.d.g.8.c.g.2.a.1.5.b.4.a.3.b.4.8.1.b.f.4.3.d.7.b.7.e.6.3.5.g.b.0.f.e.5.e.a.3.7.3.a.5.a.0.1.e.0.3.3.0.d.7.9.b.7.f.0.0.1.2.2.3.3.0.4.1.2.0.1.2.0.2.0.0"
			),
			reason:
				"a union of three rules of constants, d z, y, x and b x, z, z: the engine keeps d alone, which tells all three apart, and drops b, the first separator of two pairs that d tells apart too, so the union is keyed by d, not by b and d",
			since: "2026-11-16"
		},
		{
			token: ReplayToken(
				"test/types/evidence/agreement.test.ts#evidence:-:0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.h.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.f.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.5.0.0.1.0.0.1.0.0"
			),
			reason:
				"ToneWeight matched with a flag fixing its tone by p0 or its weight by p1, its tone in the head: the engine proves at most one row under both readings, its weights distinct, where the types, which read its declared key, the tone, prove many under the weight's; the declared class, a closed relation's column of distinct constant values (TEST_SEED=669114265)",
			since: "2026-11-18"
		}
	],
	kills: [
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
export const faults = agreement(faultCases, {
	situations: faultsRequired,
	notes: agreementReached,
	checking: "disarmed",
	program: faultProgram,
	oracle: { kind: "second-implementation", name: "the engine's verdict on each faulted query" },
	kept: [
		{
			token: ReplayToken(
				"test/types/evidence/agreement.test.ts#faults:-:6.h.0.b.2.4.0.9.2.h.f.2.b.c.6.9.d.0.8.7.1.0.3.1.2.1.f.a.c.4.6.2.h.7.f.5.d.9.6.a.4.e.d.2.0.2.9.5.e.4.d.d.e.7.b.h.c.8.e.d.0.7.b.9.b.5.1.0.0.3.0.2.3.0.3.0.3.1.2.1.1.0.3.2.0.1.2.1.1.3.1.1.0.0"
			),
			reason:
				"a union of two rules whose constant heads differ at four fields, three of them roster handles: the types keyed it by each of the four, where the engine keeps the first in heading order, d (TEST_SEED=1635200356)",
			since: "2026-11-16"
		},
		{
			token: ReplayToken(
				"test/types/evidence/agreement.test.ts#faults:7fffffff.11:0.0.0.0.0.0.f.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.f.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.1.0.0.0.0.0.0"
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
	box: "every position against every constant kind, under every value and stage of the kind; every combinator over every shape under every wrapper; every level, relation source and negation place of the scope axis",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: (cells, entry) => admissionProgram(cells, evidencePrelude(entry)),
	oracle: {
		kind: "second-implementation",
		name: "the engine's compilation of each cell's statement"
	},
	kept: [],
	kills: []
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
	kept: [],
	kills: []
})
