/**
 * A containment between ordinary relations whose side is a selection is discharged one of two ways, chosen when the
 * schema compiles (laws/model/plan.ts ContainmentDischarge): natively, by its foreign key, the UNIQUE it references,
 * the reverse index over its source's columns and the law columns its selected sides lower to; or whole, by the rule
 * judge, its violation read over the units a transaction wrote, as a unit-local rule over a query is
 * (analysis/theory/unit.ts wholeRule, physical/ddl/rules.ts addRules), installing nothing on either relation. The law
 * is one law either way: its identity, its evidence and its violation query are the theory's.
 *
 * The box, exhausted: a unit's header H and its bodies B and C, grouped by g, with B's fence into H's open groups; D,
 * keyed apart; and containments from C's facts of kind 1 into B, from B's facts of kind 1 or 2
 * into C's of kind 2, from C into B, from C's facts of kind 3 into D at i alone, and from C's facts whose kind plus one
 * is at least 4 into B; with no relation mutable, or B, C, both or D; H, a header, is immutable.
 *
 * - **discharge**: the specification, the decision table: a fence native, since a hold refuses by it and a retirement
 *   relies on its foreign key's locks and its check at the statement (physical/ddl/retire.ts); a containment of two
 *   unselected sides native, the enforcement of the existence evidence a catalog reads; one with a side selected by a
 *   computed value native, its law column computing it where a query's site may refuse it; one joined across units, or
 *   over a mutable relation, native; and the box's two others whole. Each law is held exactly one way, and the laws
 *   that give containment evidence are those whose source selects by fixed fields alone (analysis/theory/theory.ts
 *   evidenceSides), whatever their discharge, a whole one's committed-snapshot.
 * - **migration**: a migration that changes a containment's discharge checks its rows only where no previous
 *   installation held the law: the selected containment absent, native or whole before, and native or whole after,
 *   drafted from the previous version's snapshot. The law is checked over every row exactly when it is added whole,
 *   a new law the judge holds; a native one now whole is held already, its natives having held this very law on every
 *   write (deploy/diff/diff.ts heldBefore); and a native one PostgreSQL validates as it adds its foreign key.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { assert, defined } from "#test/support/assert.ts"
import {
	asDrafted,
	compile,
	draftChain,
	fromEmpty,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import {
	caseGen,
	checkedLaws,
	containments,
	dischargedIn,
	evidenced,
	expected,
	lawOf,
	type MigrationCase,
	migrationCaseGen,
	schemaOf,
	versionOf
} from "#test/unit/laws/model/discharge.fixtures.ts"

type Feature =
	| "a whole containment"
	| "a native fence over immutable relations"
	| "a native containment of unselected sides"
	| "a native containment selected by a computed value"
	| "a native containment across units"
	| "a native containment over a mutable relation"
	| "the evidence of a whole containment"

/** A containment between selected sides is discharged whole where it is unit-local, no fence and selected by
 * comparisons, and natively otherwise, its evidence the theory's either way. */
export const aContainmentWithASelectedSideIsDischargedWholeWhereItIsUnitLocalAndNoFenceAndNativelyOtherwiseItsEvidenceTheSame =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: [
			"a whole containment",
			"a native fence over immutable relations",
			"a native containment of unselected sides",
			"a native containment selected by a computed value",
			"a native containment across units",
			"a native containment over a mutable relation",
			"the evidence of a whole containment"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, k: CaseOf<Feature>) => (c) =>
			Effect.sync(() => {
				const installation = compile(schemaOf(c), asDrafted)
				const theory = installation.laws.theory
				for (const of of containments) {
					const law = lawOf(theory.laws, of)
					const want = expected(c, of)
					assert.equal(
						dischargedIn(installation, law.id),
						want,
						`the ${of} containment, ${c.mutable} mutable`
					)
					if (want === "whole") {
						k.note("a whole containment")
						for (const e of Arr.filter(theory.evidence.containments, (e) => e.law === law.id)) {
							assert.equal(e.context, "committedSnapshot", `the ${of} containment holds at COMMIT`)
							k.note("the evidence of a whole containment")
						}
						continue
					}
					switch (of) {
						case "fence":
						case "second fence":
							if (c.mutable === "none") {
								k.note("a native fence over immutable relations")
							}
							break
						case "plain":
							k.note("a native containment of unselected sides")
							break
						case "computed":
							k.note("a native containment selected by a computed value")
							break
						case "across":
							k.note("a native containment across units")
							break
						case "selected":
						case "listed":
							k.note("a native containment over a mutable relation")
							break
					}
				}
				assert.deepEqual(
					Arr.sort(
						Arr.map(theory.evidence.containments, (e) => String(e.law)),
						Order.String
					),
					Arr.sort(
						Arr.map(evidenced, (of) => String(lawOf(theory.laws, of).id)),
						Order.String
					),
					`the containments that give evidence, each whose source selects by fixed fields alone, whichever way it is discharged, ${c.mutable} mutable`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the decision table: a fence, unselected sides, a computed selection, a join across units or a mutable relation native, every other whole; the evidence the same either way"
		},
		box: "a retirable unit H of bodies B and C, D keyed apart, seven containments between them, no relation mutable, or B, C, both or D",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: '\t\tlaw.source.kind === "retirable" ||',
				replacement: "\t\tfalse ||",
				why: "A fence over immutable relations is discharged whole, its foreign key gone, which a hold and a retirement rely on; the fence's discharge fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\t\t(d.from.selection.conjuncts.length === 0 && d.to.selection.conjuncts.length === 0) ||",
				replacement: "\t\tfalse ||",
				why: "A containment of two unselected sides is discharged whole, so no foreign key enforces the existence evidence a catalog reads; the plain containment's discharge fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: '\t\tcase "field":\n\t\tcase "literal":\n\t\t\treturn true',
				replacement:
					'\t\tcase "field":\n\t\tcase "literal":\n\t\tcase "compute":\n\t\t\treturn true',
				why: "A computed selection reads alike in a query: the computed containment's discharge fails, and a pattern's match over an unbounded text would be refused where it compiles."
			},
			{
				file: "packages/engine/src/analysis/theory/theory.ts",
				original: '\t\t} else if (d.kind === "containment") {',
				replacement: '\t\t} else if (d.kind === "containment" && immediate.has(law.id)) {',
				why: "Only an immediately enforced containment gives evidence, so a whole one loses the evidence its law gives, as a law-level rule would; the evidence fails."
			}
		]
	})

/** A migration case's versions, its feature. */
type MigrationFeature = `${MigrationCase["before"]} then ${MigrationCase["after"]}`

/** A migration checks a containment's rows only where no previous installation held its law. */
export const aMigrationChecksAContainmentsRowsOnlyWhereNoPreviousInstallationHeldItsLaw =
	property.exhaust(finite(migrationCaseGen), {
		needs: {},
		situations: [
			"absent then whole",
			"native then whole",
			"whole then whole",
			"whole then native",
			"absent then native",
			"native then native"
		] satisfies ReadonlyArray<Reached<MigrationFeature>>,
		check: (_, k: CaseOf<MigrationFeature>) => (c) =>
			Effect.sync(() => {
				const after = versionOf(c.after)
				const drafted = draftChain(
					[
						{ desc: versionOf(c.before), options: asDrafted, declared: noDeclarations },
						{ desc: after, options: asDrafted, declared: noDeclarations }
					],
					fromEmpty
				)
				const second = defined(drafted[1], "the second migration")
				const law = lawOf(compile(after, asDrafted).laws.theory.laws, "selected")
				const checked = Arr.filter(checkedLaws(second), (id) => id === law.id).length
				assert.equal(
					checked,
					c.before === "absent" && c.after === "whole" ? 1 : 0,
					`the selected containment's checks, ${c.before} then ${c.after}`
				)
				k.note(`${c.before} then ${c.after}`)
			}),
		oracle: {
			kind: "specification",
			name: "the plan's own steps: a containment's check exactly where it is added whole"
		},
		box: "the selected containment absent, native or whole, then native or whole, each drafted from the previous version's snapshot",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: '\t\t\treturn check.meaning === "stated"',
				replacement: "\t\t\treturn false",
				why: "A containment its natives held is checked again over every row when it is discharged whole, as a new law is; native then whole fails."
			}
		]
	})
