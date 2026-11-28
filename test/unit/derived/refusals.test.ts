/**
 * Runtime refusals for derived relations in descriptions TypeScript did not check (the type tests refuse each at the
 * type level): a JavaScript caller, or a SchemaDesc decoded from data, meets the same rules at construction or at
 * ownership, before any definition is read, and so at every entry that installs or analyzes a schema.
 *
 * - - Statements over derived relations: each case draws a law of a drawn shape (a key over drawn fields, mutable, a
 *   check, a containment in either or both directions, a family whose member or owner or both are derived) over the
 *   worked example's Reports level with a second derived relation beside AccountBudget, each slot drawn among the
 *   derived relations or the base's sides of its type, at least one derived. Mutable and a family name rows grizzle
 *   writes, which a derived relation's definition states, so ownership refuses each (MalformedDescription) at every
 *   entry. A key, a check and a containment are rules over the definition, which ownership owns and the analysis of
 *   derived relations reads; AccountBudget's definition counts and sums Task's rows by account, groups that do not hold
 *   Task's unit fields (id), so a probe of a touched group would fold again every row of a group that spans Task's
 *   units, and the entry that compiles the laws refuses each as UnsupportedLawFamily, naming the remedy, to group within
 *   a unit (analysis/theory/query.ts refuseAggregatesAcrossUnits: lane NOSETTINGS's 37b7e030f2 and 51aa55e1f8), where
 *   it installed each, its probes reading the groups a write touched (GroupedMatch). Oracle: that rule, restated per
 *   law shape. Features: each law shape, a law naming both derived relations, a containment out of and into a derived
 *   relation.
 * - Unwritable definitions: levels, parameters and contexts an unchecked description can still write down are refused
 *   as MalformedDescription, a derived definition reading no parameter and holding no session. Each case draws a schema
 *   of the derived oracle (drawn levels and definitions over drawn base relations), which ownership admits, and one
 *   mutation of a drawn derived relation of it: moved into the root schema, joined by a twin of its level that reads
 *   it, given a drawn parameter in its first arm's condition, or given a drawn context's match there; where the
 *   mutation has a control without the defect (the twin a level up, the condition over a literal), ownership admits
 *   the control. The builder refuses a parameterized definition at construction. Oracle: a derived relation stands
 *   above the root, reads only lower levels, reads no parameter and matches no context. Features: each mutation.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { isCompileError } from "#compiler/core/errors.ts"

import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { admitDerived } from "#compiler/schema/relation.ts"
import { Id } from "#test/support/ids.ts"
import { buildSchema } from "#test/support/pg/derived/oracle/gen.ts"
import {
	entries,
	type LawFeature,
	lawOf,
	lawSketchGen,
	mutated,
	type Mutation,
	ownedAtDoor,
	refusal,
	refusalsEverywhere,
	twinned,
	unwritableGen,
	writesRows
} from "#test/unit/derived/refusals.fixtures.ts"

/** The remedy a rule over AccountBudget is refused with: its groups, by account, span Task's units, keyed by id. */
const acrossUnits = "group within a unit, adding the unit's fields (id) to the grouping"

/**
 * Derived relation refusals refuse a statement writing a derived relation's rows at every entry, and a rule over an
 * aggregate whose groups span their units where the laws compile.
 *
 * Budget: 100 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/derived/refusals.test.ts:528 at 8cad5bce, its runs and its coverage's cases).
 */
export const derivedRelationRefusalsRefuseAStatementWritingADerivedRelationsRowsAtEveryEntryAndARuleOverAnAggregateAcrossUnitsWhereTheLawsCompile =
	property.explore(lawSketchGen, {
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: [
			"law key",
			"law mutable",
			"law check",
			"law contained",
			"law family",
			"a law naming both derived relations",
			"a containment out of a derived relation",
			"a containment into a derived relation"
		] satisfies ReadonlyArray<Reached<LawFeature>>,
		check: (_, c: Case<LawFeature>) => (law) =>
			Effect.sync(() => {
				c.note(`law ${law.kind}`)
				const { statement, named } = lawOf(law)
				if (Arr.dedupe(named).length > 1) {
					c.note("a law naming both derived relations")
				}
				if (law.kind === "contained") {
					if (law.left.kind === "derived") {
						c.note("a containment out of a derived relation")
					}
					if (law.right.kind === "derived") {
						c.note("a containment into a derived relation")
					}
				}
				const desc = { ...twinned, statements: [...twinned.statements, statement] }
				if (writesRows(law)) {
					for (const e of refusalsEverywhere(desc)) {
						assert.ok(e.reason._tag === "MalformedDescription", e.message)
					}
					return
				}
				const [owned, analyzed, installed] = entries(desc)
				assert.ok(owned?.ok === true, "ownership owns a rule over a derived relation")
				assert.ok(analyzed?.ok === true, "the analysis of derived relations reads it")
				const refused = refusal(defined(installed, "the installation's entry"))
				assert.equal(refused.reason._tag, "UnsupportedLawFamily", refused.message)
				assert.ok(
					Str.endsWith(acrossUnits)(refused.message),
					`the refusal names the remedy, to group within Task's unit: ${refused.message}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "a statement naming rows grizzle writes is refused at every entry; a rule over a definition that aggregates across its units is owned, and refused where the laws compile, naming the remedy to group within a unit"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/derived/refusals.test.ts#derivedRelationRefusalsRefuseAStatementWritingADerivedRelationsRowsAtEveryEntryAndARuleOverAnAggregateAcrossUnitsWhereTheLawsCompile:-:0.0.1.0"
				),
				reason:
					"A key over AccountBudget at its account, an aggregate whose groups by account span Task's units (id): installed with its probes reading the touched groups until NOSETTINGS's refusal (37b7e030f2, 51aa55e1f8), refused UnsupportedLawFamily on the merged tree, where the oracle said installed (floor stream 0xb011c592, case 0)",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\t\t\tconst free = freeUnitIn(body, at, unitOf)\n",
				replacement: "\t\t\t\t\tconst free = freeUnitIn(body, at, () => [])\n",
				why: "No binding leaves a unit free, so a rule over AccountBudget, whose groups by account span Task's units, compiles again, its probe folding every row of a touched account's tasks at each write: the installation succeeds where it is refused, and the property fails."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original:
					'desc.kind === "closed"\n\t\t\t\t\t? []\n\t\t\t\t\t: desc.slots.map((slot) => this.#slot(slot, primaryFields, loc, patterns))',
				replacement:
					'desc.kind === "closed" ? desc.slots.map((slot) => this.#slot(slot, primaryFields, loc, patterns)) : []',
				why: 'Operator mutant d6c6cf24b9 at packages/engine/src/analysis/schema.ts:822 in <module>: `desc.kind === "closed"      ? []      : desc.slots.map((slot) => this.#slot(slot, primaryFields, loc, patterns))` becomes `desc.kind === "closed" ? desc.slots.map((slot) => this.#slot(slot, primaryFields, loc, patterns)) : []`; the property fails (the census, lane TESTPOLICY2).'
			}
		]
	})

/**
 * Derived relation refusals refuse a level, parameter or context an unchecked description can still write down.
 *
 * Budget: 40 runs and 40 steered cases, what its suite stated before it became a property
 * (test/unit/derived/refusals.test.ts:598 at 8cad5bce, its runs and its coverage's cases).
 */
export const derivedRelationRefusalsRefuseALevelParameterOrContextAnUncheckedDescriptionCanStillWriteDown =
	property.explore(unwritableGen, {
		needs: {},
		budget: { runs: 40, steered: 40 },
		situations: [
			"a derived relation in a root schema",
			"a definition that reads its own level",
			"a parameterized definition",
			"a definition that matches a context"
		] satisfies ReadonlyArray<Reached<Mutation["kind"]>>,
		check: (_, c: Case<Mutation["kind"]>) => (sketch) =>
			Effect.gen(function* () {
				const { gen, mutation } = ((s) => ({
					gen: buildSchema(s.schema, { name: "Gen" }),
					mutation: s.mutation
				}))(sketch)
				return yield* Effect.sync(() => {
					c.note(mutation.kind)
					assert.ok(ownedAtDoor(gen.value).ok, "the generated schema is admitted")
					const { defective, control } = mutated(gen, mutation)
					const reason = refusal(ownedAtDoor(defective)).reason
					assert.equal(reason._tag, "MalformedDescription", mutation.kind)
					if (Option.isSome(control)) {
						const admitted = ownedAtDoor(control.value)
						assert.ok(admitted.ok, admitted.ok ? "" : admitted.error.message)
					}
					if (mutation.kind === "a parameterized definition") {
						const base = Arr.headNonEmpty(nonEmpty(gen.base, "a base relation"))
						const column = Arr.headNonEmpty(nonEmpty(base.columns, "a column")).name
						const parameterized = queryOver(gen.value).rule((r: RuleValue) => {
							const vars = varsOver(base.value, "base")
							const p = r.param(`p${mutation.parameter}`, Id)
							return r
								.match(base.value, { [column]: vars[column] })
								.where(r.eq(p, p))
								.find({ [column]: vars[column] })
						})
						assert.throws(
							() => admitDerived(`P${mutation.parameter}`, parameterized, []),
							(e) => isCompileError(e) && e.reason._tag === "MalformedDescription"
						)
					}
				})
			}),
		oracle: {
			kind: "specification",
			name: "a derived relation stands above the root, reads only lower levels, reads no parameter and matches no context"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/own.ts",
				original: "\t\t\tif (uses.inputs.size > 0) {",
				replacement: "\t\t\tif (uses.inputs.size > 1) {",
				why: "Ownership admits a definition that reads one parameter (schema/own.ts checkDerived); the unwritable definitions fail."
			}
		]
	})
