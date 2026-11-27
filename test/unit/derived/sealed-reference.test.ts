/**
 * A derived relation unit-local in one unit that otherwise reads only relations of a unit sealed at founding is stored
 * in its own unit, those relations read by reference (analysis/theory/unit.ts storedUnit, ir/unit.ts StoredUnit
 * `references`): a package's rows at a key never change once founded, and every read of one stands at a package a
 * learner's row it reads beside names through a containment the schema states, so every package it reads was founded,
 * its every row written, before that learner's row stood, and a write changes the stored rows only at the learner units
 * it writes. Its upkeep reads the learner's relations alone (StoredUpkeep `reads`), no delta rule reads a reference's
 * writes, and its stored unit names each reference (StoredUnit `references`), over which a data step's re-check makes it
 * its definition's rows again (physical/ddl/recheck.ts).
 *
 * The box is every definition of sealed-reference.fixtures.ts over a package's content and a learner's attempts, marks
 * and notes: each attempt with its item's maximum (ledger's AttemptCredit), the same through a copy of the items read in
 * place at the attempt's package and item, each attempt at an item not adaptive (ItemSessionOpen), each attempt not
 * ended through a hint that counts none, the uncounted attempts a stored import read by its name, which reads the
 * content's hints by reference (CountedAttempt), each attempted item's maximum through a stored import of the attempts,
 * each mark of the kind a containment's selection admits and of any kind, each note with its item's maximum and its
 * hints, a note held to no content, each attempt beside package 0's item, and each attempt with its item's maximum
 * through a stored relation of the content alone (AttemptCredit over the stored MaximumOutcome); the package unit sealed
 * or not, and the
 * attempts' containment into the content stated or not.
 *
 * The oracle is the rule restated as a model (sealed-reference.fixtures.ts holdingOf): under an unsealed package unit,
 * live for its unit key, the content leading with a package where the learner's rows lead with a learner; under a
 * sealed one, stored at the learner relation's key where every read of content is reached, live for its reference
 * otherwise; and for each stored one, its upkeep reads no reference, its delta rules read no reference's delta, and its
 * stored unit names each reference.
 *
 * Features: each shape's holding, sealed and not.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { succeeded } from "#test/support/assert.ts"
import { compiledOf } from "#test/unit/analysis/theory/rule-query.fixtures.ts"
import {
	deltasReadIn,
	derivedName,
	holdingOf,
	holdingStated,
	referenceCase,
	referenceSchemaOf,
	type Shape
} from "#test/unit/derived/sealed-reference.fixtures.ts"

type ReferenceFeature = `${"stored" | "live"} ${Shape}` | "live for its unit key, unsealed"

/**
 * A derived relation over a learner's rows and a sealed package's content is stored in the learner's unit exactly where
 * every read of the content stands at a key a learner's row reaches by a stated containment, its upkeep reading the
 * content by reference and its stored unit naming each reference; live otherwise.
 */
export const aDerivedRelationReadsASealedUnitsRelationsByReferenceExactlyWhereALearnersRowReachesEveryKeyItReads =
	property.exhaust(finite(referenceCase), {
		needs: {},
		situations: [
			"stored credit",
			"stored copied credit",
			"stored not adaptive",
			"stored counted",
			"stored attempted items",
			"stored marked of kind 1",
			"stored graded",
			"live credit",
			"live marked of any kind",
			"live noted",
			"live noted hints",
			"live constant package",
			"live for its unit key, unsealed"
		] satisfies ReadonlyArray<Reached<ReferenceFeature>>,
		check: (_, c: Case<ReferenceFeature>) => (drawn) =>
			Effect.sync(() => {
				const artifacts = succeeded(
					compiledOf(referenceSchemaOf(drawn)),
					"every schema of the box compiles"
				)
				const expected = holdingOf(drawn)
				assert.deepEqual(holdingStated(artifacts), expected, Formatter.format(drawn))
				switch (expected.kind) {
					case "stored": {
						c.note(`stored ${drawn.shape}`)
						const upkeep = defined(
							Option.getOrUndefined(
								Arr.findFirst(artifacts.laws.theory.upkeeps, (u) => u.relation === derivedName)
							),
							"the stored relation's upkeep"
						)
						const references = new Set(expected.references)
						assert.ok(
							Arr.every(upkeep.reads, (r) => !references.has(r.relation)),
							`${Formatter.format(drawn)}: the upkeep reads no relation it reads by reference`
						)
						if (upkeep.form.kind === "delta") {
							const gained = deltasReadIn(upkeep.form.gained)
							assert.ok(
								Arr.every(expected.references, (r) => !gained.has(r)),
								`${Formatter.format(drawn)}: no gained rule reads a reference's delta`
							)
						}
						const named: ReadonlyArray<string> = Arr.sort(upkeep.stored.references, Order.String)
						assert.deepEqual(
							named,
							expected.references,
							`${Formatter.format(drawn)}: its stored unit names each reference, which a data step's re-check refills it over`
						)
						break
					}
					case "live":
						c.note(
							drawn.sealing === "unsealed"
								? "live for its unit key, unsealed"
								: `live ${drawn.shape}`
						)
						break
				}
			}),
		oracle: {
			kind: "specification",
			name: "the rule restated (sealed-reference.fixtures.ts holdingOf): stored at the learner relation's key, its content read by reference, exactly where the package unit is sealed and every read of content stands at a key a learner's row reaches by a stated containment over every row its read admits"
		},
		box: "eleven definitions over a package's content and a learner's rows, the package unit sealed or not, the attempts' containment into the content stated or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\treturn sealed.length > 0 && sealed.length < read.length\n",
				replacement: "\treturn false && sealed.length < read.length\n",
				why: "No relation read by reference: a learner's credit over a package's content is live for its unit key, the content leading with a package where the attempt leads with a learner, so the result page re-derives every attempt's credit (ledger's AttemptCredit, CountedAttempt, ItemSessionOpen: 16.8M pages, the player's 1.4M-attempt rescan)."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\tconst unreached = unreachedReference(definition, references, units)\n",
				replacement: "\t\t\tconst unreached = undefined\n",
				why: "A read of content at a key no learner's row reaches stored: a note's item maximum kept in the learner's unit though the note names a package no founding wrote, so the package's later founding changes the stored rows at a unit no write touched."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\t\t\t\tc.selection.every((conjunct) => implies(conditions, conjunct))\n",
				replacement: "\t\t\t\t\t\ttrue\n",
				why: "A containment over a selection read as one over every row: a mark of any kind with its item's maximum stored, though only marks of kind 1 name an item a founding wrote."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\tfor (const [unit, ...fields] of reachedHeads(query)) {\n",
				replacement:
					"\t\t\tfor (const [unit, ...fields] of new TupleSet<ReadonlyArray<string>>()) {\n",
				why: "A stored relation's head read as reaching no key: each attempted item's maximum live, though its attempted items, a stored import read by its name, are every one an item a founding wrote."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\t\treturn allDefined(fields) && given(unit, fields)\n",
				replacement: "\t\t\t\treturn false\n",
				why: "A reference-only import read at a key its reader reaches taken as unreached: the credit over a copy of Item's rows, a query of the content read in place at the attempt's package and item, live."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: "\t\t\tsealed: (unit) => foundedAt(owned, unit),\n",
				replacement: "\t\t\tsealed: () => true,\n",
				why: "Every declared unit read as sealed: a learner's credit over an unsealed package's content stored, though a later write of the package changes it at a unit no write touched."
			},
			{
				file: "packages/engine/src/analysis/theory/theory.ts",
				original:
					"\t\t\t\t\t\tholder: (relation) => holder(relation) && !unit.references.includes(relation),\n",
				replacement: "\t\t\t\t\t\tholder: (relation) => holder(relation),\n",
				why: "A delta rule read from a reference's writes: each publish's founding rows joined to the learners' attempts by package and item, a read no key of the attempts leads with."
			}
		]
	})
