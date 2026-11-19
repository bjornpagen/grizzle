/**
 * A containment implies a foreign key at its source's keys: wherever a containment from an unselected source, every
 * column of which holds a value on every row, carries a declared key K of its source whole into a declared key T of its
 * target, the law model installs `FOREIGN KEY (K) REFERENCES target (T)` beside whatever discharges it, its own foreign
 * key where it is exactly that (laws/model/plan.ts keyReferences). PostgreSQL's estimate of a join on exactly K and T
 * reads only a foreign key whose every column the join's clauses match (costsize.c get_foreign_key_join_selectivity),
 * so a superkey's, a family axis's or a selected target's reference, wider or over law columns, leaves a one-to-one
 * join estimated as if its columns were independent: QTI's binding_fit check estimated declaration_identifier ⋈
 * declaration_base_type ⋈ declaration at 1,493 rows against 61,093 and ran 104 s, which JUDGESIZE3 measured.
 *
 * The box (key-references.fixtures.ts): a counted family of one member per owner, keyed by its group, and an ordered
 * one; S's containments into a superkey, exactly a key in another order, a selected target, from a selected source, at
 * a pred term, at a part of S's key, into no key, and into S itself; and the selected target judged whole or held by its
 * foreign key. The oracle is the specification: the foreign keys from exactly a declared key of their source are those
 * the box's statements carry into a declared key of their target, one per pair of keys, each carrying exactly the law
 * that states it, and deferred exactly where that law is held only at COMMIT.
 *
 * Features: a counted family's owner axis, a containment into a superkey, a containment's own reference at the keys, a
 * selected target judged whole, a selected target held natively, an immediate reference.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { assert } from "#test/support/assert.ts"
import {
	caseGen,
	expectedReferences,
	keyReferencesOf,
	lawOf,
	referenceText,
	schemaOf,
	type Statement
} from "#test/unit/laws/model/key-references.fixtures.ts"
import { modelOf } from "#test/unit/laws/model/natives.ts"

type Feature =
	| "a counted family's owner axis"
	| "a containment into a superkey"
	| "a containment's own reference at the keys"
	| "a selected target judged whole"
	| "a selected target held natively"
	| "an immediate reference"

/** The foreign keys from a key are exactly the containments that carry a source's key whole into a target's key, one
 * each, deferred where their law is. */
export const theForeignKeysFromAKeyIntoAKeyAreExactlyTheContainmentsCarryingASourcesKeyWholeIntoATargetsKey =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: [
			"a counted family's owner axis",
			"a containment into a superkey",
			"a containment's own reference at the keys",
			"a selected target judged whole",
			"a selected target held natively",
			"an immediate reference"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, k: CaseOf<Feature>) => (c) =>
			Effect.sync(() => {
				const model = modelOf(schemaOf(c))
				const laws = model.theory.laws
				const references = keyReferencesOf(model)
				assert.deepEqual(
					Arr.sort(Arr.map(references, referenceText), Order.String),
					Arr.sort(Arr.map(expectedReferences(laws), referenceText), Order.String),
					`the foreign keys from a key, the selected target ${c.selected}`
				)
				const selected = lawOf(laws, "selected target").id
				const whole = Arr.some(model.rules, (r) => r.law.id === selected && r.rule.kind === "whole")
				assert.equal(
					whole,
					c.selected === "whole",
					"the selected target is judged whole exactly where U is immutable"
				)
				for (const r of references) {
					if (!r.deferrable) {
						k.note("an immediate reference")
					}
					const carries = (statement: Statement) => Arr.contains(r.laws, lawOf(laws, statement).id)
					if (carries("family")) {
						k.note("a counted family's owner axis")
					}
					if (carries("superkey")) {
						k.note("a containment into a superkey")
					}
					if (carries("exact")) {
						k.note("a containment's own reference at the keys")
					}
					if (carries("selected target")) {
						k.note(whole ? "a selected target judged whole" : "a selected target held natively")
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the box's containments that carry a source's declared key whole from an unselected source into a declared key of their target, each its law's, one per pair of keys, deferred where its law is"
		},
		box: "a counted family keyed by its group and an ordered one; S into a superkey, a key in another order, a selected target, from a selected source, at a pred term, at a part of its key, into no key and into itself; the selected target judged whole or held natively",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					'\t\t\t\t{ kind: "Unique", relation: target.relation, columns: targetColumns, entry },\n\t\t\t\t...keyReferences(foreignKey, this.#loc)',
				replacement:
					'\t\t\t\t{ kind: "Unique", relation: target.relation, columns: targetColumns, entry }',
				why: "A family axis implies no foreign key at its source's keys, so M's key reaches O's only by the owner axis's wider key, over M's copy of O's count, which a join on (o) alone does not match; the family's reference fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\t\tforeignKey,\n\t\t\t...keyReferences(foreignKey, loc)\n",
				replacement: "\t\t\tforeignKey\n",
				why: "A stated containment discharged by its own foreign key implies none at its source's keys, so S's key reaches T's only by the superkey's, and U's held natively only over U's law columns; the superkey's reference fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					'\treturn c.column.kind === "term" && c.column.term.kind === "field"\n\t\t? c.column.term.column\n\t\t: undefined',
				replacement: "\treturn undefined",
				why: "A selected target's law column is no field of its relation, so a containment into U's selected facts references U's key nowhere; the selected target's reference fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\t\t\t\t\treturn judgedPlan(law, discharge.rule, implied)",
				replacement: "\t\t\t\t\t\treturn judgedPlan(law, discharge.rule, [])",
				why: "A containment the judge holds whole installs nothing, so S's key reaches U's by no foreign key where U is immutable; the whole selected target's reference fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\tif (!columns.every(total)) {",
				replacement: "\tif (false) {",
				why: "A reference out of a column NULL where its guard fails counts as one out of every row: the last axis, which binds only the owners whose count is above 0, gives O(o) into M(o), refusing an owner with no member, and the pred source gives S(g, i) into X(g, i), refusing a fact whose k is 0; both extra references fail."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\t\t\t!scalarKeys(target).some((k) => k.length === met.length && k.every((f) => met.includes(f))) ||",
				replacement: "\t\t\tfalse ||",
				why: "S's key met at W's (g, j), which no key of W holds apart, gives a reference into columns no UNIQUE holds; the extra reference into W fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\t\t(relation.name === target.name && key.every((f, i) => met[i] === f)) ||",
				replacement: "\t\t\tfalse ||",
				why: "S's key met at itself gives S(g, i) into S(g, i), which every row satisfies by itself and every insert probes; the extra reference fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					'\t\t\t(columns.length === key.length && targetColumns.every((c) => c.kind === "field"))',
				replacement: "\t\t\tfalse",
				why: "A containment that is exactly S's key into E's implies itself again, at S's key's order, a second foreign key over the same pair of keys; the one reference per key pair fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\t\t\tdeferral: reference.deferral,",
				replacement: '\t\t\t\tdeferral: "immediate",',
				why: "A reference is immediate whatever its law's deferral, so the superkey's and the exact one's, into targets a write may replace, and the selected target's, which the judge holds only at COMMIT, refuse a transaction's statement their laws admit; their deferral fails."
			}
		]
	})
