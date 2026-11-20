/**
 * rowEvaluator reads a relation where a source of it is first evaluated, and once (program/evaluate.ts
 * rowEvaluatorOver `readingOf`): its stored relation's fields and checks, its derived relation's definition, checked
 * where it is read, and its closed relation's heading, each read for the first source of the relation it prepares and
 * held for every other, so an evaluator never reads a relation no source of it evaluates. The host judge of a schema of
 * hundreds of relations reads the few its tests evaluate, where it read every one, checking every live definition again,
 * where it was built.
 *
 * The count is work, never time: V8's precise coverage counts each function's calls (kernel/calls.ts callCounts). The
 * box: a stored relation R beneath one, two or three live derived relations D1 to D3 over it (evaluator-reads.fixtures.ts
 * schemasOfCopies); each case evaluates rows of R, of D1 or of both, each through its relation alone or beside a
 * selection of it. Over each schema, the law model compiled before the count, an evaluator built and the case evaluated
 * reads exactly the relations the case evaluates and checks exactly the definitions among them, at every count of
 * copies.
 *
 * Features: a stored relation read, a derived relation read, a relation read by two sources, both read.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Result } from "effect"
import { rowEvaluator } from "#adapter/public/host.ts"
import { select } from "#compiler/public/schema.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import {
	checksOf,
	D1,
	featuresOf,
	R,
	readsCaseGen,
	readsOf,
	type ReadsCase,
	type ReadsFeature,
	readSites,
	schemasOfCopies
} from "#test/unit/program/evaluator-reads.fixtures.ts"

/** A row of R and of D1, inside every domain. */
const row = { k: 1, x: 2 } as const

/**
 * The evaluation a case makes over `schema`, its law model compiled before the count: an evaluator built, then each
 * source the case reads, an admitted row through each, counted (readSites).
 */
const evaluateCase = (c: ReadsCase, schema: (typeof schemasOfCopies)[number]["schema"]) => {
	Result.getOrThrow(rowEvaluator(schema))
	return callCounts(
		Effect.sync(() => {
			const evaluate = Result.getOrThrow(rowEvaluator(schema))
			if (c.stored !== "none") {
				const admitted = Result.getOrThrow(evaluate.admit(R, row))
				evaluate(R, admitted)
				if (c.stored === "and a selection") {
					evaluate(
						select(R, (r) => r.ne(r.x, 0)),
						admitted
					)
				}
			}
			if (c.copy !== "none") {
				const admitted = Result.getOrThrow(evaluate.admit(D1, row))
				evaluate(D1, admitted)
				if (c.copy === "and a selection") {
					evaluate(
						select(D1, (d) => d.ne(d.x, 0)),
						admitted
					)
				}
			}
		}),
		readSites
	)
}

/**
 * An evaluator reads exactly the relations its sources evaluate, each once, and checks exactly their definitions,
 * however many relations its schema holds.
 *
 */
export const anEvaluatorReadsExactlyTheRelationsItsSourcesEvaluateEachOnceAndChecksExactlyTheirDefinitionsHoweverManyRelationsItsSchemaHolds =
	property.exhaust(finite(readsCaseGen), {
		needs: {},
		situations: [
			"a stored relation read",
			"a derived relation read",
			"a relation read by two sources",
			"both read"
		] satisfies ReadonlyArray<Reached<ReadsFeature>>,
		check: (_, k: Case<ReadsFeature>) => (c) =>
			Effect.gen(function* () {
				for (const feature of featuresOf(c)) {
					k.note(feature)
				}
				for (const { copies, schema } of schemasOfCopies) {
					const [, counts] = yield* evaluateCase(c, schema)
					const at = `${Formatter.format(c)} over ${copies} copies`
					assert.equal(counts.read, readsOf(c), `${at}: each relation it evaluates read once`)
					assert.equal(
						counts.checked,
						checksOf(c),
						`${at}: each definition it evaluates checked once`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the relations a case evaluates and the definitions among them, counted (kernel/calls.ts callCounts)"
		},
		box: "rows of R, of D1 or of both, each through its relation alone or beside a selection of it, over R beneath one, two and three live derived relations",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/evaluate.ts",
				original: "\t\t\treadings.set(relation, read)\n",
				replacement: "",
				why: "A relation is read again for each source of it the evaluator prepares, so a selection beside its relation reads it twice, and a derived relation's definition is checked twice."
			},
			{
				file: "packages/engine/src/program/evaluate.ts",
				original: "\t\tconst readings = new Map<string, RelationReading>()\n",
				replacement:
					"\t\tconst readings = new Map<string, RelationReading>()\n\t\tfor (const name of [...model.checked.relations.keys(), ...model.checked.closed.keys(), ...Object.keys(model.owned.relations)]) {\n\t\t\tconst read = relationReadingOf(model, codes, name)\n\t\t\tif (read !== undefined) {\n\t\t\t\treadings.set(name, read)\n\t\t\t}\n\t\t}\n",
				why: "Every relation of the model is read where the evaluator is built, each live definition checked, so a schema of more copies reads and checks more, whatever the case evaluates."
			}
		]
	})
