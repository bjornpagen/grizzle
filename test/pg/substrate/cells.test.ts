/**
 * The law of erasure's templates (fin.md §17), proved against PostgreSQL 19rc2: the migration's pack, the table CHECK a
 * closed law is, over its digit columns, the roster domains that keep each digit in range, function application with absence as
 * NULL, a domain re-pointed at a new constant and VALIDATEd, the RESTRICT drop of the old constant, and every write
 * after a domain's constraint changes judged by the new one, in a session that checked it before. Every template is the
 * RFC's, written by hand. That PostgreSQL refuses a VIRTUAL generation where a cell is STORED is the installation's
 * concern, which every closed law's suite installs; that a constant replaced in place stays folded in a session that
 * read it is why erasure never replaces one, which test/pg/closed/codes.test.ts holds of grizzle's own migrations (a
 * session open across a migration answers as a fresh one).
 *
 * Oracles, per proof:
 * - the pack: a second implementation, the host encoder (packages/engine/src/ir/cells.ts constantOf, and bitText, the
 *   test oracle of its text). "One
 *   constant, two consumers": PostgreSQL's DO block and the host must spell the same string, bit for bit;
 * - the domain template: the specification turned into a checker, a digit tuple is admitted exactly when each digit is
 *   a live code of its roster and the tuple is in the set. Why the digits are typed by their roster domains is the
 *   mixed-radix alias: over bare int2 digits the CHECK's row-major index `(x * |B| + y) * |C| + z` carries a digit past
 *   its roster into the next one's, so a tuple outside the set can land on a member's bit. The search proved it with a
 *   control table of bare digits beside the typed one; a control is no template grizzle ships, so it goes, its argument
 *   kept here;
 * - function application: the host reader (packages/engine/src/codec/bits.ts cell) over the host encoder's string;
 * - re-pointing, RESTRICT and the cached check: a model of the migration, which says which rows VALIDATE refuses,
 *   which dependents a drop names, and which codes a writer's session admits after the swap or a first constraint.
 *
 * The boxes are stated where each proof draws them (doctrine rules 9, 10): every relation over a key space of at most
 * four cells and a payload space of at most four codes; every digit of three rosters of two or three codes, one below
 * and two above each; every roster of at most three codes with every hole pattern, every removal and one appended code.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Array as Arr } from "effect"
import {
	cachedCheckCase,
	type CachedCheckFeature,
	cachedCheckGen,
	cellsSchemaTemplate,
	digitCase,
	type DigitFeature,
	digitGen,
	digitsTemplate,
	keyLawCase,
	type KeyLawFeature,
	keyLawGen,
	packCase,
	type PackFeature,
	packGen,
	readCase,
	type ReadFeature,
	readGen,
	readTemplate,
	repointCase,
	type RepointFeature,
	repointGen,
	restrictCase,
	type RestrictFeature,
	restrictGen,
	DEPENDENTS
} from "#test/pg/substrate/cells.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Pack every closed relation of the box into the string the host encoder writes, bit for bit, each case on the worker's seat of an empty schema, creating and dropping its pack.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/cells.test.ts at b42f20fb2).
 */
export const packEveryClosedRelationOfTheBoxIntoTheStringTheHostEncoderWritesBitForBit =
	property.exhaust(finite(packGen), {
		needs: { cells: Substrate.seat(cellsSchemaTemplate) },
		situations: [
			"a set",
			"a function",
			"empty",
			"full",
			"a two-coordinate key"
		] satisfies ReadonlyArray<Reached<PackFeature>>,
		check:
			({ cells }, k: Case<PackFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(cells, (seat) =>
						Effect.provideService(packCase(seat.value, c, k), Substrate, seat.substrate)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the host encoder (packages/engine/src/ir/cells.ts constantOf) and bitText, bit for bit"
		},
		box: "every relation over a key layout of at most four cells and a payload layout of at most four codes, each key cell absent or holding one payload code",
		kept: [],
		kills: []
	})

/**
 * Refuse a pack whose two rows share a key exactly where the host encoder refuses it as a key collision, each case on the worker's seat of an empty schema.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/cells.test.ts at b42f20fb2).
 */
export const refuseAPackWhoseTwoRowsShareAKeyExactlyWhereTheHostEncoderRefusesItAsAKeyCollision =
	property.exhaust(finite(keyLawGen), {
		needs: { cells: Substrate.seat(cellsSchemaTemplate) },
		situations: ["refused by its key", "packed"] satisfies ReadonlyArray<Reached<KeyLawFeature>>,
		check:
			({ cells }, k: Case<KeyLawFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(cells, (seat) =>
						Effect.provideService(keyLawCase(seat.value, c, k), Substrate, seat.substrate)
					)
				),
		oracle: { kind: "second-implementation", name: "the host encoder's key collision" },
		box: "every key layout of the key law's box with each key cell absent, holding one payload code or two different ones",
		kept: [],
		kills: []
	})

/**
 * Admit a digit tuple exactly when each digit is a live code and the tuple is in the set, refusing every other with 23514, and alias only without the roster domains, each case on the worker's seat of the digit templates, installed once per member.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/cells.test.ts at b42f20fb2).
 */
export const admitADigitTupleExactlyWhenEachDigitIsALiveCodeAndTheTupleIsInTheSetRefusingEveryOtherWith23514 =
	property.exhaust(finite(digitGen), {
		needs: { cells: Substrate.seat(digitsTemplate) },
		situations: [
			"typed admits a member",
			"typed refuses a hole",
			"typed refuses a digit out of range",
			"typed refuses a live tuple outside the set"
		] satisfies ReadonlyArray<Reached<DigitFeature>>,
		check:
			({ cells }, k: Case<DigitFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(cells, (seat) =>
						Effect.provideService(digitCase(seat.value.schema, c, k), Substrate, seat.substrate)
					)
				),
		oracle: {
			kind: "specification",
			name: "a tuple admitted exactly when each digit is a live code of its roster and the tuple is in the set"
		},
		box: "every digit tuple of three rosters of two or three codes, each digit from one below its roster to two past its last code",
		kept: [],
		kills: []
	})

/**
 * Read a function application as NULL where its cell is absent, past either end included, never as -1, and refuse a lookup through an absent cell, each case on the worker's seat of the application templates, installed once per member.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/cells.test.ts at b42f20fb2).
 */
export const readAFunctionApplicationAsNullWhereItsCellIsAbsentNeverAsMinusOneAndRefuseALookupThroughAnAbsentCell =
	property.exhaust(finite(readGen), {
		needs: { cells: Substrate.seat(readTemplate) },
		situations: [
			"applied to a present cell",
			"applied to an absent cell",
			"applied past either end",
			"a lookup through an absent cell refused",
			"a lookup admitted"
		] satisfies ReadonlyArray<Reached<ReadFeature>>,
		check:
			({ cells }, k: Case<ReadFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(cells, (seat) =>
						Effect.provideService(readCase(seat.value.schema, c, k), Substrate, seat.substrate)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the host reader (packages/engine/src/codec/bits.ts cell) over the host encoder's string"
		},
		box: "every application of f at each index from two below its first cell to two past its last, and every lookup through a cell of f into s",
		kept: [],
		kills: []
	})

/**
 * Re-point a roster's domain at a new constant, VALIDATE it naming the table and column of a row holding a removed code, and admit by the new constant after the swap, each case on the worker's seat of an empty schema, which it leaves as it found it.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/cells.test.ts at b42f20fb2).
 */
export const repointARostersDomainAtANewConstantValidateItNamingARowHoldingARemovedCodeAndAdmitByTheNewConstant =
	property.exhaust(finite(repointGen), {
		needs: { cells: Substrate.seat(cellsSchemaTemplate) },
		situations: [
			"validated",
			"validate names a row holding a removed code",
			"a removed code refused after the swap",
			"an appended code admitted after the swap"
		] satisfies ReadonlyArray<Reached<RepointFeature>>,
		check:
			({ cells }, k: Case<RepointFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(cells, (seat) =>
						Effect.provideService(repointCase(seat.value, c, k), Substrate, seat.substrate)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "a model of the migration: which rows VALIDATE refuses, and which codes the writer's session admits after the swap"
		},
		box: "every roster of one to three codes with every hole pattern, every removal of its live codes, one appended code or none, and every two rows of its live codes",
		kept: [],
		kills: []
	})

/**
 * Refuse DROP FUNCTION RESTRICT of a constant while any dependent a migration missed still reads it, naming each one, each case on the worker's seat of an empty schema, which it leaves as it found it.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/cells.test.ts at b42f20fb2).
 */
export const refuseDropFunctionRestrictOfAConstantWhileAnyDependentAMigrationMissedStillReadsItNamingEachOne =
	property.exhaust(finite(restrictGen), {
		needs: { cells: Substrate.seat(cellsSchemaTemplate) },
		situations: [
			"dropped",
			...Arr.map(DEPENDENTS, (d): RestrictFeature => `refused naming a missed ${d}`)
		] satisfies ReadonlyArray<Reached<RestrictFeature>>,
		check:
			({ cells }, k: Case<RestrictFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(cells, (seat) =>
						Effect.provideService(restrictCase(seat.value, c, k), Substrate, seat.substrate)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "a model of the migration: RESTRICT drops the constant exactly when no dependent is left, and names each one left"
		},
		box: "every set of installed dependents of the four kinds, and every subset of them a migration handled",
		kept: [],
		kills: []
	})

/**
 * Judge every write after a domain's constraint changes by the new constraint, a plain or a STORED generated column, in a session that already checked the domain or a new one, each case in a schema of its own on the worker's clone, as each case of the search made one.
 *
 * Its pre-conversion budget: the box (test/pg/substrate/cells.test.ts at b42f20fb2).
 */
export const judgeEveryWriteAfterADomainsConstraintChangesByTheNewConstraintInASessionThatCheckedItBeforeOrANewOne =
	property.exhaust(finite(cachedCheckGen), {
		needs: { substrate: Substrate.installing },
		situations: [
			"plain, warm, swapped",
			"plain, warm, added",
			"plain, fresh, swapped",
			"plain, fresh, added",
			"generated, warm, swapped",
			"generated, warm, added",
			"generated, fresh, swapped",
			"generated, fresh, added",
			"admitted",
			"refused"
		] satisfies ReadonlyArray<Reached<CachedCheckFeature>>,
		check:
			({ substrate }, k: Case<CachedCheckFeature>) =>
			(c) =>
				Effect.provideServiceEffect(Effect.scoped(cachedCheckCase(c, k)), Substrate, substrate),
		oracle: {
			kind: "specification",
			name: "a write after the change is admitted exactly when the new constant holds its code live"
		},
		box: "every column kind, session, change and a code live before, after, or in both",
		kept: [],
		kills: []
	})
