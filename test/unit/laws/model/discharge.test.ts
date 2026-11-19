/**
 * A scalar containment between ordinary relations is discharged one of two ways, chosen when the schema compiles
 * (laws/model/plan.ts ContainmentDischarge): natively, by its foreign key, the UNIQUE it references, the reverse index
 * over its source's columns and the law columns its selected sides lower to; or whole, by the rule judge, its violation
 * read over the units a transaction wrote, as a unit-local rule over a query is (analysis/theory/unit.ts wholeRule,
 * physical/ddl/rules.ts addRules), installing nothing on either relation. The law is one law either way: its
 * identity, its evidence and its violation query are the theory's.
 *
 * The box, exhausted: a unit's header H and its bodies B and C, grouped by g, with B's and C's fences into H's open
 * groups; D, keyed apart; E, keyed by the unit at its every field; F, with a field beyond a superkey of its key; G,
 * with a declared key (g, j) beside its primary key; containments from C's facts of kind 1 into B, from B's facts of
 * kind 1 or 2 into C's of kind 2, from C into B at its primary key, into G at its declared key, into F at a superkey
 * and into E, from C's facts of kind 4 into E, from C's facts of kind 3 into D at i alone, and from C's facts whose
 * kind plus one is at least 4 into B; with one containment into a target no key holds or none, plain and unit-local,
 * across units, or selected by a computed value; and with no relation mutable, or B, C, both or D; H, a header, is
 * immutable.
 *
 * - **discharge**: the specification, the decision table: a fence native, since a hold refuses by it and a retirement
 *   relies on its foreign key's locks and its check at the statement (physical/ddl/retire.ts); every plain containment
 *   into a target a key holds native, at its declared key or a superkey, its foreign key stating it exactly with no
 *   law column, the plain one into E's every field immediate, the existence evidence a read inside a transaction relies
 *   on; one with a side selected by a computed value native, its law column computing it where a query's site may
 *   refuse it; one joined across units, or over a mutable relation, native; the selected ones whole; and the plain
 *   one into a target no key holds whole where it is unit-local over immutable relations, the schema refused anywhere
 *   else, as one across units or selected by a computed value is. Each law is held exactly one way, and the laws that
 *   give containment evidence are those whose source selects by fixed fields alone (analysis/theory/theory.ts
 *   evidenceSides), whatever their discharge, a whole one's committed-snapshot, which the law model's existence
 *   evidence reads too where its sides select nothing.
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
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import {
	asDrafted,
	compile,
	compilation,
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
	unkeyedExpected,
	versionOf
} from "#test/unit/laws/model/discharge.fixtures.ts"

type Feature =
	| "a whole containment"
	| "a native fence over immutable relations"
	| "a native plain containment into a declared key"
	| "a native plain containment into a superkey"
	| "the immediate evidence of a plain containment into a target referenced whole"
	| "a native containment selected by a computed value"
	| "a native containment across units"
	| "a native containment over a mutable relation"
	| "the evidence of a whole containment"
	| "a whole plain containment into a target no key holds"
	| "the existence evidence of a whole containment"
	| "a refusal over a mutable relation"
	| "a refusal across units"
	| "a refusal of a computed selection"

/** A containment is discharged whole where it is unit-local, no fence, selected by comparisons, and selected or into a
 * target no key holds, natively otherwise, and refused into a target no key holds where it is not whole, its evidence
 * the theory's either way. */
export const aContainmentIsWholeWhereItIsUnitLocalNoFenceAndSelectedOrIntoATargetNoKeyHoldsNativeOtherwiseItsEvidenceTheSame =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: [
			"a whole containment",
			"a native fence over immutable relations",
			"a native plain containment into a declared key",
			"a native plain containment into a superkey",
			"the immediate evidence of a plain containment into a target referenced whole",
			"a native containment selected by a computed value",
			"a native containment across units",
			"a native containment over a mutable relation",
			"the evidence of a whole containment",
			"a whole plain containment into a target no key holds",
			"the existence evidence of a whole containment",
			"a refusal over a mutable relation",
			"a refusal across units",
			"a refusal of a computed selection"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, k: CaseOf<Feature>) => (c) =>
			Effect.sync(() => {
				const result = compilation(schemaOf(c), asDrafted)
				const unkeyed = unkeyedExpected(c)
				if (unkeyed === "refused") {
					refused(
						result,
						"UnsupportedLawFamily",
						`the ${c.unkeyed} containment, ${c.mutable} mutable`
					)
					k.note(
						c.unkeyed === "unkeyed across"
							? "a refusal across units"
							: c.unkeyed === "unkeyed computed"
								? "a refusal of a computed selection"
								: "a refusal over a mutable relation"
					)
					return
				}
				const installation = succeeded(result)
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
						case "into declared key":
							k.note("a native plain containment into a declared key")
							break
						case "into superkey":
							k.note("a native plain containment into a superkey")
							break
						case "into whole":
							for (const e of Arr.filter(theory.evidence.containments, (e) => e.law === law.id)) {
								assert.equal(
									e.context,
									"immediate",
									`the ${of} containment holds at every statement`
								)
								k.note(
									"the immediate evidence of a plain containment into a target referenced whole"
								)
							}
							break
						case "computed":
							k.note("a native containment selected by a computed value")
							break
						case "across":
							k.note("a native containment across units")
							break
						case "selected":
						case "listed":
						case "selected into whole":
							k.note("a native containment over a mutable relation")
							break
					}
				}
				const wholes = unkeyed === "whole" ? [lawOf(theory.laws, "unkeyed")] : []
				for (const law of wholes) {
					assert.equal(
						dischargedIn(installation, law.id),
						"whole",
						`the ${c.unkeyed} containment, ${c.mutable} mutable`
					)
					k.note("a whole plain containment into a target no key holds")
					const existence = Arr.filter(installation.laws.existence, (e) => e.law === law.id)
					assert.deepEqual(
						Arr.map(existence, (e) => e.context),
						["committedSnapshot"],
						`the existence evidence a query reads of the ${c.unkeyed} containment, its sides unselected`
					)
					k.note("the existence evidence of a whole containment")
				}
				assert.deepEqual(
					Arr.sort(
						Arr.map(theory.evidence.containments, (e) => String(e.law)),
						Order.String
					),
					Arr.sort(
						[
							...Arr.map(evidenced, (of) => String(lawOf(theory.laws, of).id)),
							...Arr.map(wholes, (law) => String(law.id))
						],
						Order.String
					),
					`the containments that give evidence, each whose source selects by fixed fields alone, whichever way it is discharged, ${c.mutable} mutable, ${c.unkeyed}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the decision table: a fence, a plain containment into a target a key holds, a computed selection, a join across units or a mutable relation native, every other whole where it is unit-local, a containment into a target no key holds refused where it is not; the evidence the same either way"
		},
		box: "a retirable unit H of bodies B and C, D keyed apart, E keyed by the unit at its every field, F with a field beyond a superkey, G with a declared key beside its primary key, eleven containments into a key of each, one into a target no key holds or none, and no relation mutable, or B, C, both or D",
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
				original: "\t\t(isPlain(d) && keyHolds(projected, d.to)) ||",
				replacement:
					"\t\t(isPlain(d) && d.to.rel.fields.every((f) => d.to.terms.some((t) => t.column === f))) ||",
				why: "A plain containment into a declared key of a target holding a field it does not reference is judged whole where it is unit-local, as 59de77629 judged it though its foreign key states it exactly, its key gone and its writers serializable; the plain containment's discharge fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\tfixedKeyOf(projected, to) !== undefined || keysOf(projected, to).some((k) => keyedBy(k, to))",
				replacement:
					"\tfixedKeyOf(projected, to) !== undefined || keysOf(projected, to).some((k) => keyedBy(k, to) && k.terms.length === to.terms.length)",
				why: "A target a key holds within a superkey counts as no key's, so the plain containment into F at (g, i, kind) is judged whole though its superkey's UNIQUE states it exactly; the into-superkey containment's discharge fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\t(isPlain(d) && keyHolds(projected, d.to)) ||",
				replacement: "\t\tisPlain(d) ||",
				why: "Every plain containment is native, into a target no key holds too, which no UNIQUE the law model may add states, so the unit-local one the judge holds whole is refused; the unkeyed containment's compile fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\tfixedKeyOf(projected, to) !== undefined || keysOf(projected, to).some((k) => keyedBy(k, to))",
				replacement: "\ttrue",
				why: "Every target counts as one a key holds, so the plain containment into B at (g, kind) is native over a UNIQUE (g, kind) of B, which refuses facts the schema admits: the unkeyed containment's discharge fails, and the one across units compiles."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\td.from.selection.conjuncts.length === 0 && d.to.selection.conjuncts.length === 0",
				replacement: "\ttrue",
				why: "A selected containment into a target a key holds is native, its law columns, UNIQUE and index restored; the selected containment's discharge fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: '\t\tcase "field":\n\t\tcase "literal":\n\t\t\treturn true',
				replacement:
					'\t\tcase "field":\n\t\tcase "literal":\n\t\tcase "compute":\n\t\t\treturn true',
				why: "A computed selection reads alike in a query: the computed containment's discharge fails, and a pattern's match over an unbounded text would be refused where it compiles."
			},
			{
				file: "packages/engine/src/laws/model/model.ts",
				original: "\t\t\texistence: existenceConstraints(evidence.containments),",
				replacement:
					"\t\t\texistence: existenceConstraints(evidence.containments.filter((c) => natives.some((n) => n.object.lawIds.includes(c.law)))),",
				why: "A containment gives existence evidence only where a native object enforces it, as the reader of pg_constraint's foreign keys did: the unkeyed containment the judge holds whole loses the existence evidence a query's rewrite reads at a committed snapshot; the existence evidence fails."
			},
			{
				file: "packages/engine/src/analysis/theory/theory.ts",
				original: '\t\t} else if (d.kind === "containment") {',
				replacement: '\t\t} else if (d.kind === "containment" && immediate.has(law.id)) {',
				why: "Only an immediately enforced containment gives evidence, so a whole one and a deferred native one lose the evidence their law gives; the evidence fails."
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
