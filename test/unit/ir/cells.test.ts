/**
 * The cells encoder (ir/cells.ts), every rule against an oracle that shares none of its arithmetic.
 *
 * - The naive tuple-set model: a relation is the list of its tuples in the odometer's order of its key space, and a
 *   constant is decoded by reading every cell of its bit text the way PostgreSQL's substring reads it, each present cell
 *   mapped back to its key and payload by the odometer. decode ∘ encode = id over every closed relation of a box. The
 *   bit text is the test oracle's (test/support/closed/bit-text.ts), each held cell 1 + its payload code; the engine's
 *   own hex literal of a constant (literalOf) is unit/physical/literal.test.ts's.
 * - The odometer: every point of a space counted in row-major order, which the mixed-radix index must number
 *   bijectively, and which no out-of-range digit may reach, the alias (a digit past its radix carrying into its
 *   neighbour, 400 as 37 at PostgreSQL's scale) among them.
 * - The slot list: a fin coordinate's slots listed owner by owner, whose positions its prefix offsets must be.
 * - The intent a roster's declarations were drawn with, and the spec of a side's key restated as a checker.
 *
 * Where a space is small it is enumerated whole (exhaust), and the bound is in each generator's documentation; where it
 * is not (16-bit codes, payload spaces past 2^53, declaration histories), it is searched (explore).
 *
 * Features: each search names the shapes, relations, statements, rosters, sides and edits it must reach.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { aimed, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import {
	addressed,
	bijection,
	box,
	type Declaration,
	dense,
	type Dependent,
	type Edited,
	exact,
	headings,
	histories,
	history,
	holePattern,
	type Holes,
	type Keyed,
	keying,
	type Owners,
	owners,
	patterns,
	type Payload,
	payloadSizes,
	type Relation,
	roundTrip,
	setOfRows,
	type Shape,
	shapes,
	small,
	spaces,
	type Stated,
	statement,
	theorem,
	widePayloadSizes
} from "#test/unit/ir/cells.fixtures.ts"

/** The row-major index is a bijection from the in-range digits onto the odometer's count, and aliases no digit out of range. */
export const theRowMajorIndexIsABijectionFromTheInRangeDigitsOntoTheOdometersCountAndAliasesNoDigitOutOfRange =
	property.exhaust(finite(shapes), {
		needs: {},
		situations: [
			"one coordinate",
			"three coordinates",
			"an empty coordinate",
			"an aliasing digit"
		] satisfies ReadonlyArray<Reached<Shape>>,
		check: (_, c: Case<Shape>) => (value) => bijection(value, c),
		oracle: {
			kind: "second-implementation",
			name: "the odometer: every point counted in row-major order"
		},
		box: "every key shape of one to three coordinates of 0 to 5 codes, at every point, each digit moved just outside its range",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/cells.ts",
				original:
					"\t\tif (digit === undefined || !Number.isInteger(digit) || digit < 0 || digit >= size) {",
				replacement:
					"\t\tif (digit === undefined || !Number.isInteger(digit) || digit < 0 || digit > size) {",
				why: "rowMajorIndex accepts a digit at its radix, which carries into its neighbour; the row-major index's and the dependent key space's properties fail."
			}
		]
	})

/** A fin coordinate numbers each owner's slots densely after every earlier owner's, and names no slot an owner lacks. */
export const aFinCoordinateNumbersEachOwnersSlotsDenselyAfterEveryEarlierOwnersAndNamesNoSlotAnOwnerLacks =
	property.exhaust(finite(owners), {
		needs: {},
		situations: [
			"an owner with no slot",
			"several owners with slots",
			"no owner"
		] satisfies ReadonlyArray<Reached<Owners>>,
		check: (_, c: Case<Owners>) => (value) => dense(value, c),
		oracle: {
			kind: "second-implementation",
			name: "every owner's slots listed owner by owner"
		},
		box: "every owner roster of 0 to 4 owners, each holding 0 to 3 slots",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/cells.ts",
				original:
					"\treturn run !== undefined && at >= 0n && at < run.count ? run.start + at : undefined",
				replacement:
					"\treturn run !== undefined && at >= 0n && at <= run.count ? run.start + at : undefined",
				why: "finDigit accepts a slot at its owner's count, the next owner's first slot; the fin coordinate's property fails."
			}
		]
	})

/** A dependent key space numbers the dependent sum bijectively in owner order, and aliases no slot digit at or past its count. */
export const aDependentKeySpaceNumbersTheDependentSumBijectivelyInOwnerOrderAndAliasesNoSlotDigitAtOrPastItsCount =
	property.exhaust(finite(spaces), {
		needs: {},
		situations: [
			"an owner with no slot",
			"a block of two slots",
			"a closed id after a slot",
			"a closed id before a slot",
			"two counts",
			"an empty space",
			"an aliasing slot digit"
		] satisfies ReadonlyArray<Reached<Dependent>>,
		check: (_, c: Case<Dependent>) => (value) => theorem(value, c),
		oracle: {
			kind: "second-implementation",
			name: "the dependent sum's points listed owner by owner, each block in its odometer's order, and the naive decoder of the encoded string"
		},
		box: "every dependent space of 1 to 3 owners, a block of 1 or 2 coordinates with a slot, each count 0 to 2, every slot digit 0 to 3",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/cells.ts",
				original:
					"\t\tif (digit === undefined || !Number.isInteger(digit) || digit < 0 || digit >= size) {",
				replacement:
					"\t\tif (digit === undefined || !Number.isInteger(digit) || digit < 0 || digit > size) {",
				why: "rowMajorIndex accepts a digit at its radix, which carries into its neighbour; the row-major index's and the dependent key space's properties fail."
			},
			{
				file: "packages/engine/src/ir/cells.ts",
				original: "\treturn local === undefined ? undefined : finDigit(space.fin, owner, local)",
				replacement:
					"\treturn local === undefined ? undefined : finDigit(space.fin, owner, local + 1n)",
				why: "keyIndex reads a dependent key's slot one place on; the dependent key space's property fails."
			}
		]
	})

/** A relation's string of cells decodes back to exactly its tuples, in cells · w bits, reading absent past either end. */
export const aRelationsStringOfCellsDecodesBackToExactlyItsTuplesInCellsWBitsReadingAbsentPastEitherEnd =
	property.exhaust(finite(box), {
		needs: {},
		situations: [
			"a set",
			"a function",
			"an empty key space",
			"an empty payload space",
			"every cell present",
			"three key coordinates"
		] satisfies ReadonlyArray<Reached<Relation>>,
		check: (_, c: Case<Relation>) => (value) => roundTrip(value, c),
		oracle: {
			kind: "second-implementation",
			name: "the naive tuple-set model, its bit text read cell by cell as PostgreSQL's substring reads it"
		},
		box: "every closed relation over a key of at most 4 points and a payload of none, one coordinate of 0 to 3 codes, or two of 2",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/cells.ts",
				original: "\twhile (1n << BigInt(width) <= points) {",
				replacement: "\twhile (1n << BigInt(width) < points) {",
				why: "cellWidth is one bit short when the payload space is a power of two; decode ∘ encode = id fails."
			}
		]
	})

/**
 * A relation's string of cells is the same for its rows in any order and repeated, and refuses two payloads at one
 * key.
 *
 * Budget: 400 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/ir/cells.test.ts:732 at 8cad5bce, its runs and its coverage's cases).
 */
export const aRelationsStringOfCellsIsTheSameForItsRowsInAnyOrderAndRepeatedAndRefusesTwoPayloadsAtOneKey =
	property.explore(statement, {
		needs: {},
		budget: { runs: 400, steered: 300 },
		situations: [
			"rows out of index order",
			"a row stated twice",
			"a key collision",
			"a set",
			"a function"
		] satisfies ReadonlyArray<Reached<Stated>>,
		check: (_, c: Case<Stated>) => (value) => setOfRows(value, c),
		oracle: {
			kind: "universal",
			name: "a relation is a set of rows: any order and any repetition encode alike, two payloads at one key refused"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/cells.ts",
				original: "\t\tif (earlier === undefined) {",
				replacement: "\t\tif (earlier === undefined || earlier.payload !== payload) {",
				why: "constantOf keeps the later of two payloads at one key instead of refusing the collision; the string of cells' order and collision property fails."
			}
		]
	})

/**
 * A cell's width is the binary length of 1 + the largest payload code, exactly, past 2^53.
 *
 * Budget: 300 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/ir/cells.test.ts:790 at 8cad5bce, its runs and its coverage's cases).
 */
export const aCellsWidthIsTheBinaryLengthOf1TheLargestPayloadCodeExactlyPast253 = property.explore(
	aimed(payloadSizes, [["a payload space past 2^53 points", widePayloadSizes]]),
	{
		needs: {},
		budget: { runs: 300, steered: 200 },
		situations: [
			"a set",
			"an empty payload space",
			"a payload space past 2^53 points"
		] satisfies ReadonlyArray<Reached<Payload>>,
		check: (_, c: Case<Payload>) => (value) => exact(value, c),
		oracle: {
			kind: "specification",
			name: "the binary length of 1 + the largest payload code, in bigint arithmetic"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/cells.ts",
				original: "\twhile (1n << BigInt(width) <= points) {",
				replacement: "\twhile (1n << BigInt(width) > points) {",
				why: "Operator mutant (comparison) at packages/engine/src/ir/cells.ts:193 in cellWidth: `<=` becomes `>`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	}
)

/** A roster's codes leave a hole for each removed handle, never reused, under every hole pattern of up to five codes. */
export const aRostersCodesLeaveAHoleForEachRemovedHandleNeverReusedUnderEveryHolePatternOfUpToFiveCodes =
	property.exhaust(finite(patterns), {
		needs: {},
		situations: [
			"no hole",
			"a leading hole",
			"an inner hole",
			"a trailing hole",
			"growth past a hole"
		] satisfies ReadonlyArray<Reached<Holes>>,
		check: (_, c: Case<Holes>) => (value) => holePattern(value, c),
		oracle: {
			kind: "specification",
			name: "the intent the roster's declarations were drawn with"
		},
		box: "every roster of 1 to 5 codes under every hole pattern that leaves a handle live, grown by 0 to 2 handles, then by one more past its holes",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/cells.ts",
				original: "\tlet minted = previous.length",
				replacement:
					'\tlet minted = previous.findIndex((slot) => slot.kind === "hole")\n\tminted = minted === -1 ? previous.length : minted',
				why: "rosterCodes mints a new handle at a hole's code; the roster codes' property fails."
			}
		]
	})

/**
 * A roster's codes keep each handle's code through renames, append new handles past every code minted, and refuse an
 * ordered roster's reorder; an unordered roster's declaration holds its codes in any order.
 *
 * Budget: 400 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/ir/cells.test.ts:1111 at 8cad5bce, its runs and its coverage's cases).
 */
export const aRostersCodesKeepEachHandlesCodeThroughRenamesAppendNewHandlesPastEveryCodeMintedAndRefuseAnOrderedRostersReorder =
	property.explore(history, {
		needs: {},
		budget: { runs: 400, steered: 300 },
		situations: [
			"a removal",
			"a rename",
			"a growth",
			"a name used again",
			"a name renamed away and declared again",
			"a reorder",
			"an unordered roster declared out of its codes' order",
			"an unordered roster growing past a reorder"
		] satisfies ReadonlyArray<Reached<Declaration>>,
		check: (_, c: Case<Declaration>) => (value) => histories(value, c),
		oracle: {
			kind: "specification",
			name: "the intent a roster's declaration history was drawn with: renames keep codes, new handles are minted past every code, and only an ordered roster's order is its codes'"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/cells.ts",
				original: "\t\tif (before !== undefined && claim.code < before.code) {",
				replacement: "\t\tif (before !== undefined && claim.code < before.code - 1) {",
				why: "rosterCodes admits two kept neighbours swapped; the roster codes' property fails to see the reorder refused."
			},
			{
				file: "packages/engine/src/ir/cells.ts",
				original: "\tunordered: () => undefined",
				replacement: "\tunordered: firstInversion",
				why: "rosterCodes refuses an unordered roster declared out of its codes' order, as it refuses an ordered one's; the roster codes' property fails where an unordered roster's declaration reorders its handles."
			}
		]
	})

/** A side is keyed by the smallest declared key it contains, else by all its fields, and its rows never collide. */
export const aSideIsKeyedByTheSmallestDeclaredKeyItContainsElseByAllItsFieldsAndItsRowsNeverCollide =
	property.exhaust(finite(headings), {
		needs: {},
		situations: [
			"keyed by a declared key",
			"keyed by all its fields",
			"the smallest of several contained keys",
			"the first of tied keys",
			"a key in another order than the terms",
			"a projection's repeats are one row"
		] satisfies ReadonlyArray<Reached<Keyed>>,
		check: (_, c: Case<Keyed>) => (value) => keying(value, c),
		oracle: {
			kind: "specification",
			name: "a side's key restated: the smallest declared key its terms contain, else all its fields"
		},
		box: "every heading of one to three fields with zero to two declared keys, each key and the side's terms any ordered choice of its fields",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/cells.ts",
				original: "\t\t\t(best === undefined || declared.length < best.length)",
				replacement: "\t\t\t(best === undefined || declared.length > best.length)",
				why: "sideOf keys a side by its largest contained declared key; the side's property fails."
			}
		]
	})

/** A constant's digest names a constant by its content alone, and every edit of one cell, a move or a swap of two, by another. */
export const aConstantsDigestNamesAConstantByItsContentAloneAndEveryEditOfOneCellAMoveOrASwapOfTwoByAnother =
	property.exhaust(finite(small), {
		needs: {},
		situations: [
			"a cell made present",
			"a cell made absent",
			"a payload changed",
			"the key space grown",
			"another layout, the same constant",
			"a cell moved",
			"two cells swapped"
		] satisfies ReadonlyArray<Reached<Edited>>,
		check: (_, c: Case<Edited>) => (value) => addressed(value, c),
		oracle: {
			kind: "universal",
			name: "a digest of the constant's content alone: equal content one digest, every edit another"
		},
		box: "every closed relation over a key of at most 3 points and a payload of none, 2 or 3 codes, under every edit of one cell, a move and a swap of two",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/cells.ts",
				original: "\t\t\tentries: constant.entries.map((entry) => [entry.index, entry.payload])",
				replacement: "\t\t\tentries: constant.entries.map((entry) => [entry.index])",
				why: "constantDigestOf is blind to payloads; the digest's property fails on a cell given another payload."
			}
		]
	})
