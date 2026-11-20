/**
 * The keys a family axis references fit a B-tree entry for every value their columns admit: a text by its digest where
 * it would outgrow one, and anything else as itself or refused when the schema compiles with UnrepresentableKey, where
 * PostgreSQL would refuse the first write that outgrew it (54000).
 *
 * - A concat fold's axis key: the UNIQUE its predecessor and last axes reference, Line's (doc, at, after) for a concat
 *   fold that carries its running text `after` along them (laws/model/plan.ts #axis). The box: the fold's text, its
 *   pieces and accumulators one type, of no bound, or bounded by a contract to at most n bytes, or to at most n code
 *   points of 4 bytes each, with n every bound whose entry lies within one MAXALIGN step of BTMaxItemSize on either
 *   side, exhausted. The oracle: the B-tree entry nbtree.h bounds, counted by hand from the columns' layouts as
 *   schema/representability.ts documents the count (entryBytes): the UNIQUE holds `after` as itself where its entry fits
 *   BTMaxItemSize, and by its digest, 32 bytes, exactly where it would outgrow it, a text of no bound among them
 *   (schema/representability.ts keyImages), so the fold is admitted at every bound. Features: unbounded, and each
 *   bound's kind with each verdict.
 * - A carried set's key: a set an axis carries is its roster's bit(n), n every code the roster has minted, holes
 *   included, sized exactly by the installation's codes (physical/ddl/tables.ts setUniqueBound), so a roster pruned of
 *   many handles refuses the UNIQUE when it is compiled rather than at an insert. The box: Tag's codes its two live
 *   handles, then every count of holes whose codes lie within a MAXALIGN step's worth of bytes of the most that fit,
 *   exhausted. The oracle: the entry counted by hand, a bit(n)'s varlena header, its 4-byte bit count and a byte per
 *   eight codes after Line's (order, at) at their exact offsets. Features: an entry at the bound, an entry past it.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { btreeMaxItemSize, typlens } from "#compiler/schema/representability.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { ownedInput } from "#test/support/policy.ts"
import {
	axisKeyImaged,
	bytesOf,
	codesWith,
	docSchema,
	entryBytes,
	entryOf,
	type Feature,
	fittingCodes,
	live,
	owned,
	setBytes,
	type SetFeature,
	textGen,
	type TextType,
	verdictOf
} from "#test/unit/laws/model/axis-keys.fixtures.ts"

/** A family axis's key holds the text it carries as itself where its entry fits, and by its digest exactly where it would outgrow BTMaxItemSize. */
export const aFamilyAxissKeyHoldsTheTextItCarriesAsItselfWhereItsEntryFitsAndByItsDigestExactlyWhereItWouldOutgrowBTMaxItemSize =
	property.exhaust(finite(textGen), {
		needs: {},
		situations: [
			"unbounded",
			["octets", "an entry within the bound"],
			["octets", "an entry at the bound"],
			["octets", "an entry past the bound"],
			["code points", "an entry within the bound"],
			["code points", "an entry at the bound"],
			["code points", "an entry past the bound"]
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (t: TextType) =>
			Effect.sync(() => {
				const desc = docSchema(t)
				const owned = succeeded(ownedInput(desc))
				const compiled = compileInstallation(owned, installOptions(owned))
				const bytes = bytesOf(t)
				const model = succeeded(
					compiled,
					"a concat fold's axis key, its text held as itself or by its digest"
				).laws
				const imaged = axisKeyImaged(model)
				if (bytes === undefined) {
					c.note("unbounded")
					assert.ok(imaged, "a text of no bound held by its digest, 32 bytes, whatever its values")
					return
				}
				c.pair(t.kind, verdictOf(bytes))
				assert.equal(
					imaged,
					entryBytes(bytes) > btreeMaxItemSize,
					`an entry of ${entryBytes(bytes)} bytes held by the text's digest exactly where it outgrows BTMaxItemSize`
				)
			}),
		oracle: {
			kind: "specification",
			name: "nbtree.h's BTMaxItemSize over the entry counted from the columns' layouts"
		},
		box: "a concat fold's text of no bound, or of a byte or code point bound whose entry is within a MAXALIGN step of BTMaxItemSize",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/representability.ts",
				original: "\treturn bytes > btreeMaxItemSize",
				replacement: "\treturn bytes >= btreeMaxItemSize",
				why: "An entry of exactly BTMaxItemSize is refused (schema/representability.ts btreeEntry); the concat fold's axis key fails."
			},
			{
				file: "packages/engine/src/schema/representability.ts",
				original:
					"\tconst fits = entry.length === columns.length && btreeEntryBytes(entry) <= btreeMaxItemSize",
				replacement:
					"\tconst fits = entry.length === columns.length && btreeEntryBytes(entry) < btreeMaxItemSize",
				why: "A key whose entry is exactly BTMaxItemSize holds its text by its digest: the fold's text at the bound is imaged where it fits as itself."
			}
		]
	})

/** A carried set's key is sized by its roster's codes, holes included, and refused past the bound. */
export const aCarriedSetsKeyIsSizedByItsRostersCodesHolesIncludedAndRefusedPastTheBound =
	property.exhaust(finite(int(fittingCodes - live - 8, fittingCodes - live + 8)), {
		needs: {},
		situations: ["an entry at the bound", "an entry past it"] satisfies ReadonlyArray<
			Reached<SetFeature>
		>,
		check: (_, c: Case<SetFeature>) => (holes: number) =>
			Effect.sync(() => {
				const codes = live + holes
				const compiled = compileInstallation(
					owned,
					completeInstallOptions(owned, installationsOf(owned), [], [], codesWith(holes))
				)
				const bytes = entryOf(codes)
				if (bytes <= btreeMaxItemSize) {
					succeeded(compiled, `${holes} holes: an entry of ${bytes} bytes fits`)
					c.note(bytes === btreeMaxItemSize ? "an entry at the bound" : "an entry within the bound")
					return
				}
				const reason = refused(compiled, "UnrepresentableKey").reason
				if (reason._tag !== "UnrepresentableKey") {
					return assert.fail("an UnrepresentableKey reason")
				}
				assert.deepEqual(reason.fault, {
					kind: "btreeEntry",
					bytes,
					limit: btreeMaxItemSize,
					datums: [
						{ field: "order", bytes: typlens.uuid },
						{ field: "at", bytes: typlens.int8 },
						{ field: "after", bytes: setBytes(codes) }
					]
				})
				c.note("an entry past it")
			}),
		oracle: {
			kind: "specification",
			name: "VARBITTOTALLEN and nbtree.h's BTMaxItemSize, counted by hand"
		},
		box: "Tag's two live handles and every count of holes within eight codes of the most that fit",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/tables.ts",
				original: "\t\t\t\t? setDatumBound(codecOf(b.names.codes, base.roster).size)",
				replacement: "\t\t\t\t? setDatumBound(codecOf(b.names.codes, base.roster).size - 8)",
				why: "A set's datum counted a byte short (physical/ddl/tables.ts setUniqueBound); the carried set's key fails."
			}
		]
	})
