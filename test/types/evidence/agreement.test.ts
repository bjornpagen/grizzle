import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Situations, unreachedOf } from "@grizzle/testing/features"
import { Array as Arr, Effect } from "effect"
import { admissionSize } from "#test/support/agreement/admission.ts"
import {
	type AgreementNote,
	agreementCount,
	agreementFaults,
	agreementFeatures,
	agreementKept,
	agreementPairs,
	agreementWitnesses,
	type FaultNote,
	faultCount,
	faultWitnesses,
	reorderedVerdicts
} from "#test/support/agreement/queries.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"
import { typeRun } from "#test/types/batch/provided.ts"

/**
 * The type/engine agreements, one program the type batch checks:
 *
 * 1. Evidence: the drawn queries (test/support/agreement/queries.ts), the engine's verdict on each stated as types:
 *    each get is written as db.get, under a refusal directive where the engine refuses it, and each query's claimed
 *    keys are asserted to lie over the engine's, its cardinality the engine's, and its records, parameters and reads
 *    the engine's decoded heading and parameters. The batch checks the program disarmed, so it raises exactly its
 *    directives' refusals: a get the types refuse and the engine proves is a diagnostic no directive names, a get the
 *    types accept and the engine refuses is a directive whose refusal never comes, and a claimed key the engine does
 *    not prove, or a record or parameter the engine does not deliver, fails its assertion.
 *    Each query no take closes, of one heading, is paged: its page is of that very ordered query, its unordered self
 *    is refused a page, and a drawn page request is admitted exactly where the runtime's request reader admits it.
 * 2. Order invariance: the same queries in a second drawn order, as a second module, and every query's head and keys
 *    asserted equal across the two, so TypeScript's evidence never depends on unrelated statements' order.
 * 3. Admission (test/support/agreement/admission.ts): every position a constant stands in against every constant
 *    kind, a parameter of the column's descriptor and of another's among them, a self-join's second scope among them,
 *    the program admitting exactly what the engine admits; every combinator over every shape of query; and the scope
 *    axis: a query matched, as it is and bound, over each level against its rule's schema, a relation parameter bound
 *    to each kind of source, and a relational negation at each place in a rule's filters. Beside it, the argument axis
 *    (test/support/agreement/arguments.ts): every shape of a query's parameters against every form of argument,
 *    through every method that takes one, the program admitting exactly what the runtime's reading of an argument
 *    admits.
 * 4. Faults: queries of the same generator, each planting one fault at a site whose drawn value the engine decides; a
 *    query it refuses is stated under the refusal its reason is, at the fault's site, and one it admits as a clean
 *    query is.
 * 5. Filter order: every drawn query's verdict, the engine's, is the same with each rule's filters in the other order,
 *    so a variable two filters fix is fixed to both values, whichever is written first, as the types read it.
 *
 * The floor's witnesses (agreementWitnesses, faultWitnesses), the same in every run, reach every construct the
 * evidence types reason about, a constant in each position, both verdicts, a variable two filters fix, a contract in a
 * head, a self-join whose get the engine proves, which pinnedSelfJoin draws by construction, a span parameter opposite
 * each span predicate and in a producer, a distance to a vector parameter, a search whose get the engine proves, a
 * closed relation, a roster and a derived relation matched, each span construct over a span of dates, its parameter and
 * its width in days beside an integer span's width, an extension's Db reading a base query and a base Db
 * refused an extension's, a keyed get admitted through each kind of key position and with a name beside its key, and
 * refused for a key field missing, alone or with a name in its place, a union looked up by each field its rules fix to a
 * constant, pinned by one of them and not by another, and every fault refused, each whose site may hold a valid value
 * admitted too, so the program is never vacuous on any seed; the admission matrix holds every position and kind by
 * construction.
 */
const required: Situations<AgreementNote> = [
	...agreementFeatures,
	"get proved",
	"get refused",
	"a key below the heading",
	"a variable two filters fix",
	"a contract in the head",
	"a page request admitted",
	"a page request refused",
	"an unordered page refused",
	"a span parameter opposite r.allen",
	"a span parameter opposite r.pointIn",
	"a producer over a span parameter",
	"a distance to a vector parameter",
	"a search get proves",
	"a closed relation matched",
	"r.allen over date spans",
	"a date's point test",
	"a producer over date spans",
	"a date span parameter",
	"a width in days",
	"a width over integer endpoints",
	"a roster matched",
	"a derived relation's get proved",
	"an extension's Db read a base query",
	"a base Db refused an extension query",
	"a keyed get admitted",
	"a keyed get naming a field beside its key admitted",
	"a keyed get missing a key field refused",
	"a keyed get naming a field in a key field's place refused",
	"a keyed get through a candidate key",
	"a keyed get of a closed relation",
	"a keyed get of a roster",
	"a union lookup pinned by one of several separators",
	...agreementPairs
]

/**
 * The faults whose site may hold a value the engine admits: a valid name, a field of the source, a key, one type, a
 * cosine distance to a vector of the same dimensions, an order by a field of the heading, spans of one endpoint type,
 * a pack of a span, a search by its distance to a query vector over a head that neither counts nor produces spans.
 */
const admissible = [
	"scopeName",
	"stranger",
	"unkeyedFold",
	"unionTypes",
	"cosineDims",
	"cosineTerm",
	"orderHidden",
	"spanEndpoints",
	"packTerm",
	"nearestBy",
	"nearestSource"
] as const

const faultsRequired: Situations<AgreementNote | FaultNote> = [
	...Arr.map(agreementFaults, (fault): FaultNote => `${fault} refused`),
	...Arr.map(admissible, (fault): FaultNote => `${fault} admitted`),
	"a contract's span refused against its base's"
]

layer(NodeServices.layer, { excludeTestServices: true })("the type/engine agreement", (it) => {
	it.effect(
		`over ${agreementCount} drawn queries in two orders, ${faultCount} faulted ones and ${admissionSize} admission cells, the types accept a query, its get, its records and its parameters exactly as the engine does, its keys, and every constant exactly where the engine admits it`,
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("evidence/agreement")
				assert.deepEqual(actual, expected)
			})
	)

	it(`over ${agreementCount} drawn queries, the engine's verdict is the same with each rule's filters in the other order`, () => {
		assert.deepEqual(reorderedVerdicts(typeRun().seed), [], "verdicts the filters' order moves")
	})

	it("each kept case still draws what it was kept for", () => {
		for (const { kept, drawn } of agreementKept()) {
			assert.deepEqual(
				Arr.filter(kept.reaches, (n) => !drawn.notes.has(n)),
				[],
				kept.note
			)
		}
	})

	it("the floor's witnesses reach every construct, both verdicts and a proved self-join", () => {
		assert.deepEqual(
			unreachedOf(required, [agreementWitnesses().tally]),
			[],
			"constructs or verdicts no floor witness reached"
		)
	})

	it("the faulted floor's witnesses reach every fault refused, and each whose site may hold a valid value admitted", () => {
		assert.deepEqual(
			unreachedOf(faultsRequired, [faultWitnesses().tally]),
			[],
			"faults no floor witness reached"
		)
	})
})
