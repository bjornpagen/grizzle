/**
 * The keys a family axis references fit a B-tree entry for every value their columns admit, in any order of their
 * columns, or the schema is refused when it compiles with UnrepresentableKey, where PostgreSQL would refuse the first
 * write that outgrew them (54000). A fold's running value rides the axes in the UNIQUE grizzle plans for them, which the
 * author never declared, so a fold refused for it is refused by its own name, the field it steps and the bound its
 * fields declare (KeyFault `foldAccumulator`), never by that UNIQUE.
 *
 * - A concat fold's axis key: the UNIQUE its predecessor and last axes reference, Line's (doc, at, ‹s›, after) for a concat
 *   fold that carries its running text `after` along them (laws/model/plan.ts #axis). The box: the fold's text, its
 *   pieces and accumulators one type, of no bound, or bounded by a contract to at most n bytes, or to at most n code
 *   points of 4 bytes each, with n every bound whose entry lies within one MAXALIGN step of BTMaxItemSize on either
 *   side, exhausted. The oracle: the B-tree entry nbtree.h bounds, counted by hand from the columns' layouts in any
 *   order as schema/representability.ts documents the count (entryBytes), refused exactly past BTMaxItemSize at the
 *   fold, by the fold's name, the largest byte bound that fits, counted by hand the same way (fittingBytes), and the
 *   running texts its digests would carry, and an unbounded text refused whatever its entry. Features: unbounded, and
 *   each bound's kind with each verdict.
 * - A sum fold's numeric: Entry's (account, at, after) for a sum of `amount` into Account's `total`, the amounts and
 *   accumulators one numeric type. The box: PostgreSQL's numeric of no typmod, and numeric(p, 2) at the least and the
 *   greatest precisions a field declares, exhausted. The oracle: a numeric of no typmod reaches numeric's own limit,
 *   far past BTMaxItemSize, and numeric(1000, 2), the widest a field declares, takes numeric_maximum_size's 512 bytes
 *   beside a uuid and a bigint: refused for no precision by the fold's name, installed for any. Features: refused,
 *   installed.
 * - A carried set's key: a set an axis carries is its roster's bit(n), n every code the roster has minted, holes
 *   included, sized exactly by the installation's codes (physical/ddl/tables.ts setUniqueBound), so a roster pruned of
 *   many handles refuses the UNIQUE when it is compiled rather than at an insert. The box: Tag's codes its two live
 *   handles, then every count of holes whose codes lie within a MAXALIGN step's worth of bytes of the most that fit,
 *   exhausted. The oracle: the entry counted by hand, a bit(n)'s varlena header, its 4-byte bit count and a byte per
 *   eight codes after Line's (order, at, ‹s›), each datum after its worst padding. Features: an entry at the bound, an
 *   entry past it.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { btreeMaxItemSize, typlens } from "#compiler/schema/representability.ts"
import { refused, refusedKey, succeeded } from "#test/support/assert.ts"
import { ownedInput } from "#test/support/policy.ts"
import {
	bytesOf,
	codesWith,
	docSchema,
	entryBytes,
	entryOf,
	fittingBytes,
	type Feature,
	fittingCodes,
	live,
	type NumericFeature,
	numericGen,
	type NumericType,
	owned,
	setBytes,
	type SetFeature,
	sumSchema,
	textGen,
	type TextType,
	verdictOf
} from "#test/unit/laws/model/axis-keys.fixtures.ts"

/** A family axis's key fits a B-tree entry for every value of the accumulators it carries, in any order of its columns, or is refused as UnrepresentableKey. */
export const aFamilyAxissKeyFitsABTreeEntryForEveryValueOfTheAccumulatorsItCarriesOrIsRefusedAsUnrepresentableKey =
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
				if (bytes === undefined) {
					c.note("unbounded")
				} else {
					c.pair(t.kind, verdictOf(bytes))
				}
				if (bytes !== undefined && entryBytes(bytes) <= btreeMaxItemSize) {
					succeeded(compiled, `an entry of ${entryBytes(bytes)} bytes fits`)
					return
				}
				const reason = refusedKey(refused(compiled, "UnrepresentableKey"))
				const foldAt = Arr.findFirstIndex(desc.statements, (s) => s.kind === "fold")
				assert.deepEqual(
					reason.at.path,
					["statements", ...Option.toArray(foldAt)],
					"the refusal is the fold's"
				)
				assert.equal(
					reason.subject,
					"the concat fold of Line.piece into Doc.text",
					"the fold the author declared"
				)
				assert.deepEqual(reason.key, ["piece"], "the field the fold steps")
				assert.deepEqual(reason.fault, {
					kind: "foldAccumulator",
					accumulator: "after",
					bytes: bytes === undefined ? undefined : entryBytes(bytes),
					limit: btreeMaxItemSize,
					bound: {
						kind: "byteBound",
						largest: fittingBytes,
						running: { before: "before", after: "after", end: "text" }
					}
				})
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
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\t\t\tat: this.#recognizer.foldLaw(familyKey(this.#family.id), carried.at).law.loc,",
				replacement: "\t\t\tat: this.#loc,",
				why: "The fold's refusal points at the statement whose law planned its family first, its ordered family's, not at the fold the author fixes; the concat fold's axis key fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\t\t\trest.some((c) => c.nullable)\n\t\t\t)",
				replacement: "\t\t\t\ttrue\n\t\t\t)",
				why: "The largest byte bound a refused fold names counts a null bitmap its axis's key never holds, a MAXALIGN step short of the bound that fits; the concat fold's axis key fails."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					"\t\tconst fold = carried === undefined ? undefined : this.#unboundedFold(carried, targetColumns)",
				replacement:
					"\t\tconst fold = carried === undefined || true ? undefined : this.#unboundedFold(carried, targetColumns)",
				why: "A fold's running text past the entry refused by the UNIQUE grizzle plans for its axes, (doc, at, after), which the author never declared, where the fold and its byte bound are what the author fixes."
			},
			{
				file: "packages/engine/src/schema/representability.ts",
				original: "\t\t\t(offset, c) => afterAtWorst(offset, c.datum),",
				replacement: "\t\t\t(offset, c) => alignUp(offset, c.datum.align) + c.datum.bytes,",
				why: "An entry measured in its own order as if every offset were exact: the fold's text past the any-order bound is admitted, its UNIQUE and the axes referencing it deciding apart."
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
				const reason = refusedKey(refused(compiled, "UnrepresentableKey"))
				const successor = defined(
					reason.fault.kind === "btreeEntry"
						? Option.getOrUndefined(
								Arr.findFirst(reason.fault.datums, (d) => Str.startsWith("__next_n_")(d.field))
							)
						: undefined,
					"the key holds the members' successor ‹s›"
				)
				assert.deepEqual(reason.fault, {
					kind: "btreeEntry",
					bytes,
					limit: btreeMaxItemSize,
					datums: [
						{ field: "order", bytes: typlens.uuid },
						{ field: "at", bytes: typlens.int8 },
						{ field: successor.field, bytes: typlens.int8 },
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

/** A sum fold over a numeric of no precision is refused by its own name, its summed field and its precision; a sum of a declared precision installs. */
export const aSumFoldOverANumericOfNoPrecisionIsRefusedByItsOwnNameItsSummedFieldAndItsPrecisionAndOneOfADeclaredPrecisionInstalls =
	property.exhaust(finite(numericGen), {
		needs: {},
		situations: ["refused", "installed"] satisfies ReadonlyArray<Reached<NumericFeature>>,
		check: (_, c: Case<NumericFeature>) => (t: NumericType) =>
			Effect.sync(() => {
				const desc = sumSchema(t)
				const owned = succeeded(ownedInput(desc))
				const compiled = compileInstallation(owned, installOptions(owned))
				if (t.kind === "precise") {
					succeeded(compiled, `a sum of numeric(${t.precision}, ${t.scale}) installs`)
					c.note("installed")
					return
				}
				const reason = refusedKey(refused(compiled, "UnrepresentableKey"))
				const foldAt = Arr.findFirstIndex(desc.statements, (s) => s.kind === "fold")
				assert.deepEqual(
					reason.at.path,
					["statements", ...Option.toArray(foldAt)],
					"the refusal is the fold's"
				)
				assert.equal(
					reason.subject,
					"the sum fold of Entry.amount into Account.total",
					"the fold the author declared"
				)
				assert.deepEqual(reason.key, ["amount"], "the field the fold sums")
				assert.ok(
					reason.fault.kind === "foldAccumulator" &&
						reason.fault.accumulator === "after" &&
						reason.fault.bound.kind === "precision" &&
						reason.fault.bytes !== undefined &&
						reason.fault.bytes > btreeMaxItemSize,
					"refused for the precision its running sum lacks, past the item limit"
				)
				c.note("refused")
			}),
		oracle: {
			kind: "specification",
			name: "numeric.c's limit on a numeric of no typmod and numeric_maximum_size of a declared precision, against nbtree.h's BTMaxItemSize"
		},
		box: "PostgreSQL's numeric of no typmod, and numeric(p, 2) at the least and the greatest precisions a field declares",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\tif (datum !== undefined && bytes <= btreeMaxItemSize) {",
				replacement: "\t\tif (datum !== undefined) {",
				why: "The bound check on a fold's running value dropped where the value has a bound at all: a sum of a numeric of no typmod passes the fold, so the UNIQUE grizzle plans for its axes refuses it, a key the author never declared, where the fold and the precision its fields lack are what the author fixes."
			}
		]
	})
