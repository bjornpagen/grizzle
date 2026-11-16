/**
 * A generated field's rule, as the checked schema applies it (check/generated.ts, analysis/schema.ts), and where a closed
 * read may stand, judged by the specification turned into a checker (testing doctrine, rule 3): `expectedOfGraph`,
 * `expectedOfInputs`, `expectedOfLevels` and `expectedOfPosition` state the rule again over each case's own shape,
 * sharing no code with the checker they judge.
 *
 * The law is "admitted iff no generated field reads a generated field" (PostgreSQL: "A generation expression cannot
 * reference another generated column", doc/src/sgml/ddl.sgml). A refusal is GeneratedRefused {at, relation, field,
 * rule}, checked in this order:
 * 1. each generated field in field-name order (code units): first `notRowLocal {input}`, the first input beyond its row
 *    in the order its description states it (pre-order), then `readsGenerated {read}`, the least generated field it
 *    reads in code units, itself included;
 * 2. only then the typing, least field first: `type {declared, expression}` where the expression's type is not the
 *    declared one (OPEN-U4 (a)).
 * A closed read of a closed relation declared above the field's level is MalformedDescription at the field; a closed
 * read in a query's head, a binding, an aggregate or a producer is UnsupportedOperation, and in a rule's filter it is
 * admitted. Every assertion reads the refusal's structured fields and its location's path, never its text.
 *
 * The boxes, each exhausted (rule 9):
 * - **Read graphs:** a caller-written key and up to three fields, each written by its caller (a boolean) or generated
 *   from any subset of them, declared of its expression's type (boolean) or another (integer): every graph over at
 *   most four fields, 5,000 cases. Self-reads, 2-cycles, 3-cycles and acyclic chains are named features, all refused
 *   alike at the least generated field that reads one, naming the least one it reads.
 * - **Inputs beyond the row:** two fields, each written or generated from up to two items in order, an item a read of
 *   either field, one of the five inputs beyond a row, or a parameter nested one level down: 5,476 cases. The relational
 *   negation holds a variable among its bindings, so a walk that visits a node's operands before the node answers the
 *   variable; the nested parameter before a shallow input tells pre-order from breadth-first.
 * - **Levels:** the reading relation and the closed relations each at the root level or its extension, read by C.at or
 *   C.row, bare or under an operation: 16 cases.
 * - **Query positions:** C.at and C.row in a filter, a head, a binding, an aggregate and a producer: 10 cases.
 *
 * The fields are declared in the order b, Z, a, whose code-unit order is Z, a, b and whose locale order is a, b, Z,
 * and a field's reads are stated in declaration order, so declaration order, locale order and "the first read stated"
 * each answer another field than the rule does.
 *
 * Features: self-reads, 2-cycles, 3-cycles and acyclic chains; each input beyond a row, pre-order against
 * breadth-first; each level of a closed read; each place a query states a term.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { refused, succeeded } from "#test/support/assert.ts"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"
import {
	expectedOfGraph,
	expectedOfInputs,
	expectedOfLevels,
	type GraphFeature,
	graphFeature,
	graphGen,
	graphSchema,
	type InputFeature,
	inputFeatures,
	inputsGen,
	inputsSchema,
	judged,
	levelGen,
	levelSchema,
	type Position,
	positionGen,
	positionQuery,
	positions,
	positionsSchema
} from "#test/unit/check/derived.fixtures.ts"

/** A generated field's rule and where a closed read stands admits a relation exactly when no generated field reads a generated field, refusing at the least edge, and types only then. */
export const aGeneratedFieldsRuleAndWhereAClosedReadStandsAdmitsARelationExactlyWhenNoGeneratedFieldReadsAGeneratedFieldRefusingAtTheLeastEdgeAndTypesOnlyThen =
	property.exhaust(finite(graphGen), {
		needs: {},
		situations: [
			"a self-read",
			"a 2-cycle",
			"a 3-cycle",
			"an acyclic chain",
			"a type refused",
			"admitted"
		] satisfies ReadonlyArray<Reached<GraphFeature>>,
		check: (_, c: Case<GraphFeature>) => (graph) =>
			Effect.sync(() => {
				judged(graphSchema(graph), expectedOfGraph(graph), Formatter.format(graph))
				c.note(graphFeature(graph))
			}),
		oracle: {
			kind: "specification",
			name: "the generated-field rule restated over the graph (expectedOfGraph)"
		},
		box: "every read graph over a caller-written key and up to three fields, each written or generated from any subset of them, of its expression's type or another",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/generated.ts",
				original: "\tconst reads = [...fieldReads(expr, new Set())].toSorted(compareStrings)",
				replacement:
					"\tconst reads = [...fieldReads(expr, new Set())].toSorted((a, b) => a.localeCompare(b))",
				why: "A generated field's reads ordered by locale (check/generated.ts); the read graphs property fails."
			},
			{
				file: "packages/engine/src/check/generated.ts",
				original: "\tconst read = reads.find(generated)",
				replacement: "\tconst read = reads.findLast(generated)",
				why: "The least generated field a field reads is passed over for the greatest (check/generated.ts); the read graphs property fails."
			}
		]
	})

/** A generated field's rule and where a closed read stands refuses each generated field in field-name order at its first input beyond the row in pre-order, before its reads. */
export const aGeneratedFieldsRuleAndWhereAClosedReadStandsRefusesEachGeneratedFieldInFieldNameOrderAtItsFirstInputBeyondTheRowInPreOrderBeforeItsReads =
	property.exhaust(finite(inputsGen), {
		needs: {},
		situations: [
			"beyond the row: var",
			"beyond the row: param",
			"beyond the row: parent",
			"beyond the row: value",
			"beyond the row: absent",
			"a nested input before a shallow one",
			"a read refused before a greater field's input",
			"admitted"
		] satisfies ReadonlyArray<Reached<InputFeature>>,
		check: (_, c: Case<InputFeature>) => (fields) =>
			Effect.sync(() => {
				judged(inputsSchema(fields), expectedOfInputs(fields), Formatter.format(fields))
				for (const feature of inputFeatures(fields)) {
					c.note(feature)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the generated-field rule restated over the items (expectedOfInputs)"
		},
		box: "two fields, each written or generated from up to two items in order: a read of either field, one of the five inputs beyond a row, or a parameter nested one level down",
		kept: [],
		kills: []
	})

/** A generated field's rule and where a closed read stands refuses a generated field's closed read of a closed relation above its level, and admits one at or below it. */
export const aGeneratedFieldsRuleAndWhereAClosedReadStandsRefusesAGeneratedFieldsClosedReadOfAClosedRelationAboveItsLevelAndAdmitsOneAtOrBelowIt =
	property.exhaust(finite(levelGen), {
		needs: {},
		situations: ["above", "at or below"] satisfies ReadonlyArray<Reached<"above" | "at or below">>,
		check: (_, k: Case<"above" | "at or below">) => (c) =>
			Effect.sync(() => {
				judged(levelSchema(c), expectedOfLevels(c), Formatter.format(c))
				k.note(c.closed > c.reader ? "above" : "at or below")
			}),
		oracle: { kind: "specification", name: "the level rule (expectedOfLevels)" },
		box: "the reading relation and the closed relations each at the root level or its extension, read by C.at or C.row, bare or under an operation",
		kept: [],
		kills: []
	})

/** A generated field's rule and where a closed read stands admits a closed read in a rule's filter and refuses one in a head, a binding, an aggregate or a producer. */
export const aGeneratedFieldsRuleAndWhereAClosedReadStandsAdmitsAClosedReadInARulesFilterAndRefusesOneInAHeadABindingAnAggregateOrAProducer =
	property.exhaust(finite(positionGen), {
		needs: {},
		situations: positions satisfies ReadonlyArray<Reached<Position>>,
		check: (_, k: Case<Position>) => (c) =>
			Effect.sync(() => {
				const why = Formatter.format(c)
				const result = checkAuthored(
					checking(positionsSchema),
					positionQuery(c),
					checkOptions("query")
				)
				if (c.position === "filter") {
					succeeded(result, why)
				} else {
					refused(result, "UnsupportedOperation", why)
				}
				k.note(c.position)
			}),
		oracle: { kind: "specification", name: "a closed read stands in a filter only" },
		box: "C.at and C.row at each of the five places a query states a term",
		kept: [],
		kills: []
	})
