/**
 * Dependent-sum keys on closed relations, from the declaration to the planned constants (schema/relation.ts slotField,
 * schema/own.ts, physical/ddl/constants.ts plannedKey, ir/cells.ts KeySpace):
 *
 * - **The planned string is the dependent sum:** over every count relation of four owners, each counting 0 to 2 slots
 *   or holding no row, and each of three slotted shapes (two slots, one slot, a closed id before a slot), the slotted
 *   relation's pack holds exactly Σ over owners of its block, each row at the position the dependent sum's enumeration
 *   gives its key, and its owner functions hold each owner's base and count. The rows held are a sparse half of the
 *   points that no exchange of a block's coordinates maps to itself (heldPoints), so a block enumerated in another order
 *   of its coordinates moves some row. Oracle: that enumeration, written out from the count relation's rows and the
 *   installation's codes, sharing nothing with the planner's index.
 * - **A fault planted in a valid declaration is refused where it is planted:** a drawn declaration of the box above
 *   compiles, and the same declaration with one fault planted is refused as MalformedDescription at the relation and
 *   field the fault breaks, by the builder that takes it or by the compiler: a row whose slot is past its owner's
 *   count, a count past the slot roster's codes, a count that is not natural, an owner key that does not pair with the
 *   key's first fields, a slot inside the owner prefix, two owner prefixes, a slot in the payload or in an ordinary
 *   relation, a fin over an ordinary relation, a family over a closed relation's fin, and a count relation outside the
 *   schema. Oracle: the planted fault, each with the site its rule names.
 * - **A payload code a bigint:** a payload space of n codes is refused exactly when n is past 2^63, whose greatest code,
 *   n - 1, is bigint's greatest value (payloadCodesBound), the refusal naming the constant, the bound and n; and a
 *   declared relation over five drawn payload rosters is planned exactly when the product of their sizes is within it.
 *
 * Features: each count an owner holds and each slotted shape; each planted fault; a payload within the bound planned
 * and one past it refused.
 */

import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { payloadCodesBound, payloadMaxCodes } from "#compiler/physical/ddl/constants.ts"
import { closedId } from "#compiler/public/fields.ts"
import { closed, schema } from "#compiler/public/schema.ts"
import { refusalLoc, refused, succeeded, throwsRefused } from "#test/support/assert.ts"
import {
	type Bounded,
	codesGen,
	compiled,
	declarations,
	type Declared,
	faultedGen,
	type FaultKind,
	faultKinds,
	faultTags,
	greatest,
	type Planned,
	planned,
	plant,
	rosterOf,
	schemaOf,
	sizesGen
} from "#test/unit/physical/fin.fixtures.ts"

/** A slotted closed relation's planned constants packs exactly the dependent sum, each row at its key's position. */
export const aSlottedClosedRelationsPlannedConstantsPacksExactlyTheDependentSumEachRowAtItsKeysPosition =
	property.exhaust(finite(declarations), {
		needs: {},
		situations: [
			"an owner with no row",
			"an owner counting no slot",
			"every owner counting slots",
			"an empty space",
			"a closed id before a slot",
			"two slots"
		] satisfies ReadonlyArray<Reached<Planned>>,
		check: (_, c: Case<Planned>) => (value) => planned(value, c),
		oracle: {
			kind: "second-implementation",
			name: "the dependent sum enumerated owner by owner from the count relation's rows"
		},
		box: "every count relation of 4 owners, each holding no row or counting 0 to 2 slots, under 3 slotted shapes",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/cells.ts",
				original:
					"\t\tblockRadices(space.block, space.counts, owner),\n\t\tdigits.slice(space.owner.length)",
				replacement:
					"\t\tblockRadices(space.block, space.counts, owner).toReversed(),\n\t\tdigits.slice(space.owner.length).toReversed()",
				why: "A block's codes are read least significant first."
			}
		]
	})

/** A fault planted in a valid slotted declaration admits a valid declaration and refuses it with any one fault planted, at the site the fault breaks. Its budget is its suite's before it was a property (test/unit/physical/fin.test.ts at 4ca3036a): 200 runs and 400 steered cases. */
export const aFaultPlantedInAValidSlottedDeclarationAdmitsAValidDeclarationAndRefusesItWithAnyOneFaultPlantedAtTheSiteTheFaultBreaks =
	property.explore(faultedGen, {
		needs: {},
		budget: { runs: 200, steered: 400 },
		situations: faultKinds satisfies ReadonlyArray<Reached<FaultKind>>,
		check: (_, k: Case<FaultKind>) => (c) =>
			Effect.sync(() => {
				succeeded(compiled(schemaOf(c.declaration)), "the declaration without its fault")
				const planted = plant(c)
				const tag = faultTags[c.fault.kind]
				const refusal =
					planted.stage === "builder"
						? throwsRefused(planted.attempt, tag, c.fault.kind)
						: refused(planted.attempt(), tag, c.fault.kind)
				const at = refusalLoc(refusal, c.fault.kind)
				assert.deepEqual({ path: at.path, label: at.label }, planted.at, c.fault.kind)
				k.note(c.fault.kind)
			}),
		oracle: {
			kind: "specification",
			name: "the planted fault: its rule's reason at the relation and slot the rule names"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/base/tuple-map.ts",
				original:
					'if (\n\t\t\tx !== y &&\n\t\t\t!(typeof x === "number" && typeof y === "number" && Number.isNaN(x) && Number.isNaN(y))\n\t\t) {\n\t\t\treturn false\n\t\t}',
				replacement: "{}",
				why: 'Operator mutant fe4ffa61b6 at packages/text/src/base/tuple-map.ts:39 in sameFrom: `if (    x !== y &&    !(typeof x === "number" && typeof y === "number" && Number.isNaN(x) && Number.isNaN(y))   ) {    return false   }` becomes `{}`; the property fails (the census, lane TESTPOLICY2).'
			}
		]
	})

/** A bigint payload code refuses a payload space exactly when its greatest code is past bigint's greatest value, naming the constant, the bound and the codes. Its budget is its suite's before it was a property (test/unit/physical/fin.test.ts at 4ca3036a): 200 runs and 100 steered cases. */
export const aBigintPayloadCodeRefusesAPayloadSpaceExactlyWhenItsGreatestCodeIsPastBigintsGreatestValueNamingTheConstantTheBoundAndTheCodes =
	property.explore(codesGen, {
		needs: {},
		budget: { runs: 200, steered: 100 },
		situations: [
			"at the bound",
			"one past the bound",
			"within the bound",
			"past the bound"
		] satisfies ReadonlyArray<Reached<Bounded>>,
		check: (_, k: Case<Bounded>) => (codes) =>
			Effect.sync(() => {
				assert.equal(payloadMaxCodes, greatest)
				const refusal = payloadCodesBound(codes, "the constant")
				if (codes <= greatest) {
					assert.equal(refusal, undefined, `${codes} codes fit a bigint payload code`)
					k.note(codes === greatest ? "at the bound" : "within the bound")
					return
				}
				const reason = defined(refusal, `${codes} codes are past an integer's`).reason
				assertVariant(reason, "_tag", "ResourceBound")
				assert.deepEqual(reason.bound, {
					kind: "payloadCodes",
					constant: "the constant",
					limit: payloadMaxCodes,
					needed: codes
				})
				k.note(codes === greatest + 1n ? "one past the bound" : "past the bound")
			}),
		oracle: {
			kind: "specification",
			name: "a payload code is a bigint: at most 2^63 codes, the greatest 2^63 - 1"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/constants.ts",
				original: "\tcodes > payloadMaxCodes",
				replacement: "\tcodes >= payloadMaxCodes",
				why: "A payload space of exactly 2^63 codes is refused, whose greatest code is bigint's greatest value."
			}
		]
	})

/** A bigint payload code plans a declared relation exactly when the product of its payload rosters' sizes is within the bound. Its budget is its suite's before it was a property (test/unit/physical/fin.test.ts at 4ca3036a): 12 runs and 16 steered cases. */
export const aBigintPayloadCodePlansADeclaredRelationExactlyWhenTheProductOfItsPayloadRostersSizesIsWithinTheBound =
	property.explore(sizesGen, {
		needs: {},
		budget: { runs: 12, steered: 16 },
		situations: [
			"a payload within the bound planned",
			"a payload past the bound refused"
		] satisfies ReadonlyArray<Reached<Declared>>,
		check: (_, k: Case<Declared>) => (sizes) =>
			Effect.sync(() => {
				const Key = closed.ordered("Key", ["k"])
				const rosters = Arr.map(sizes, (size, i) => rosterOf(`R${i}`, size))
				const Wide = closed.relation(
					"Wide",
					{
						key: closedId(Key),
						...Rec.fromEntries(Arr.map(rosters, (r, i) => [`p${i}`, closedId(r)] as const))
					},
					["key"],
					[
						{
							key: "k",
							...Rec.fromEntries(Arr.map(rosters, (_, i) => [`p${i}`, "h0"] as const))
						}
					]
				)
				const installation = compiled(schema("Wide", [Key, ...rosters, Wide], []))
				const codes = Arr.reduce(sizes, 1n, (product, size) => product * BigInt(size))
				if (codes <= greatest) {
					succeeded(installation, `${Arr.join(Arr.map(sizes, String), " × ")} payload codes`)
					k.note("a payload within the bound planned")
					return
				}
				const reason = refused(installation, "ResourceBound").reason
				assertVariant(reason, "_tag", "ResourceBound")
				assert.deepEqual(reason.bound, {
					kind: "payloadCodes",
					constant: "closed relation Wide",
					limit: payloadMaxCodes,
					needed: codes
				})
				k.note("a payload past the bound refused")
			}),
		oracle: {
			kind: "specification",
			name: "a payload space holds the product of its rosters' sizes, at most 2^63"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: "this.#scope = scope",
				replacement: "{}",
				why: "Operator mutant 1870d7a524 at packages/engine/src/scalar/compute/typing.ts:1612 in <module>: `this.#scope = scope` becomes `{}`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})
