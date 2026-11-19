/**
 * Hex, the one spelling of every bit string grizzle writes (core/hex.ts): a closed relation's constant (ir/cells.ts
 * literalOf and constantOfLiteral, sql/print.ts writePack and readLiteralPack, physical/ddl/literal.ts literalPackFault),
 * a roster's live codes and bits domain, and a set's literal.
 *
 * - **Every bit string a drafted migration writes is one hex constant:** over generated schemas (one to three rosters
 *   of 1 to 9 codes, so most widths pad; a closed relation keyed by one or two of them with no payload, a closed-id
 *   payload or an open one, at a drawn density; a stored relation holding two sets over a drawn roster, their union,
 *   intersection and difference generated, the singleton of a closed id generated, the empty set with its code's bit
 *   set, a row check against a drawn set literal, and a containment into the closed
 *   relation; an or fold over a counted family whose accumulator starts at the empty set), the first migration's every
 *   file lexes to statements in which every bit-string constant is X'…' of hex digits cast, with no binary B'' constant,
 *   no text cast to a bit type, no string_agg and no || beside a bit string; and its snapshot's every bit literal is
 *   the bits kind of hex digits, a set's at its bits domain's width, every bits domain is bit(n) with n its roster's
 *   codes rounded up to whole digits, every live constant the hex of its roster's live codes, and every constant's
 *   literal the whole digits its cells take, its padding 0 and its row count its held cells.
 * - **decode ∘ encode = id:** over drawn strings of cells (0 to 40 cells of 1 to 9, 31 or 32 bits), the encoder's
 *   literal is the test oracle's hex of the cells' bits padded to whole digits, it decodes back to the constant, and
 *   its printed statement reads back to its parts and holds.
 * - **Any flipped digit is refused, naming the constant:** every digit of every drawn literal changed to another
 *   (the last digit, which holds the padding, to all fifteen others) is refused by `grizzle check`'s reader naming the
 *   constant's function, as a 1 set in the padding where the change sets one and otherwise as content its digest does
 *   not state; and over installed closed relations, product and dependent keys alike, every changed digit of a
 *   relation's own constant names the relation, the first cell it changes and that cell's key. A lowercase digit, an
 *   edited row count and a literal out of its printed form are refused too.
 *
 * Oracles: the test oracle's bit texts and hex (test/support/closed/bit-text.ts), sharing no code with the engine's
 * encoder; the odometer and the dependent sum's enumeration for a changed cell's key.
 *
 * Features: each roster width, padded or whole; each closed relation's key and payload kind; each set expression; a
 * changed cell and a padding bit set; a lowercase digit, an edited row count and a literal out of its printed form.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { maxStringLength } from "#compiler/core/canonical.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { draftMigration } from "#compiler/deploy/render/generate.ts"
import { emptySnapshot, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { constantDigestOf, constantOfLiteral, literalOf } from "#compiler/ir/cells.ts"
import { literalPackFault } from "#compiler/physical/ddl/literal.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import type { ObjectName, PackConstant } from "#compiler/sql/ast.ts"
import { pack } from "#compiler/sql/constants.ts"
import { printObjectName, printStatement, readLiteralPack } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { hexOfText, installedText, setText, wholeDigits } from "#test/support/closed/bit-text.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { ownedInput, owning } from "#test/support/policy.ts"
import {
	type CellString,
	changedAt,
	cellConstantOf,
	type Draft,
	type DraftFeature,
	draws,
	fileViolations,
	flips,
	type InstalledDraw,
	type InstalledFeature,
	installedSchemaOf,
	kindAt,
	type LiteralFeature,
	odometer,
	pointsOf,
	replacedAt,
	restated,
	rosterName,
	schemaOf,
	schemas,
	snapshotViolations,
	strings,
	valueOf,
	versionAt
} from "#test/unit/physical/literal.fixtures.ts"

/** A drafted migration's bit strings writes every bit string of a drafted migration as one hex constant, and its snapshot alike. Its budget is its suite's before it was a property (test/unit/physical/literal.test.ts at 4ca3036a): 80 runs and 160 steered cases. */
export const aDraftedMigrationsBitStringsWritesEveryBitStringOfADraftedMigrationAsOneHexConstantAndItsSnapshotAlike =
	property.explore(schemas, {
		needs: {},
		budget: { runs: 80, steered: 160 },
		situations: [
			"no payload",
			"a closed-id payload",
			"an open payload",
			"a padded set",
			"a whole-digit set",
			"a padded constant",
			"a whole-digit constant",
			"a constant of no row",
			"a containment's side",
			"an or fold",
			"a set literal of no handle"
		] satisfies ReadonlyArray<Reached<DraftFeature>>,
		check: (_2, c: Case<DraftFeature>) => (d: Draft) =>
			Effect.sync(() => {
				const owned = owning(schemaOf(d))
				const installation = succeeded(compileInstallation(owned, installOptions(owned)))
				const draft = succeeded(
					draftMigration({
						previous: emptySnapshot({ schemaName: "Hex", schema: installation.names.schema }),
						installation,
						workload: noWorkload,
						declared: { renames: [], drops: [] },
						abandoned: []
					})
				)
				const widths = new Map(
					Arr.map(d.sizes, (size, i) => {
						const domain = identity.bitsDomain(parsedName(rosterName(i)), wholeDigits(size))
						return [identifierOf(domain), wholeDigits(size)] as const
					})
				)
				const setRosters = [d.setRoster, d.key[0], ...(d.fold ? [d.foldRoster] : [])]
				const lives = new Set(
					Arr.map(setRosters, (r) => {
						const size = defined(d.sizes[r])
						return hexOfText(
							setText(
								size,
								Array.from({ length: size }, (_, code) => code)
							)
						)
					})
				)
				const domains = new Set(widths.keys())
				for (const file of draft.folder.files) {
					assert.deepEqual(fileViolations(file.text, domains), [], file.name)
				}
				assert.deepEqual(
					snapshotViolations(draft.snapshot, widths, lives),
					[],
					"the snapshot's bit strings"
				)
				c.note(d.payload)
				for (const r of setRosters) {
					c.note(defined(d.sizes[r]) % 4 === 0 ? "a whole-digit set" : "a padded set")
				}
				for (const s of installation.statements) {
					if (s.kind !== "packConstant") {
						continue
					}
					const bits = s.cells * BigInt(s.width)
					c.note(bits % 4n === 0n ? "a whole-digit constant" : "a padded constant")
					if (s.rows === 0) {
						c.note("a constant of no row")
					}
				}
				if (d.contained) {
					c.note("a containment's side")
				}
				if (d.fold) {
					c.note("an or fold")
				}
				if (d.literal.length === 0) {
					c.note("a set literal of no handle")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the one spelling: X'…' of whole hex digits, cast, at the bits domain's width, nothing else"
		},
		kept: [],
		kills: []
	})

/** A closed constant's hex literal decodes to its constant, is the oracle's hex of its padded bits, reads back printed, and refuses every changed digit. Its budget is its suite's before it was a property (test/unit/physical/literal.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const aClosedConstantsHexLiteralDecodesToItsConstantIsTheOraclesHexOfItsPaddedBitsReadsBackPrintedAndRefusesEveryChangedDigit =
	property.explore(strings, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"a padded literal",
			"a whole-digit literal",
			"a literal of no digit",
			"a 32-bit cell",
			"no cell held",
			"every cell held",
			"a change in the padding alone",
			"a change in a cell"
		] satisfies ReadonlyArray<Reached<LiteralFeature>>,
		check: (_, c: Case<LiteralFeature>) => (d: CellString) =>
			Effect.sync(() => {
				const constant = cellConstantOf(d)
				const hex = literalOf(constant)
				assert.equal(
					hex,
					hexOfText(succeeded(installedText(constant, maxStringLength))),
					"the literal is the oracle's hex of the cells' bits padded to whole digits"
				)
				assert.deepEqual(
					succeeded(constantOfLiteral(hex, constant.cells, constant.width)),
					constant,
					"decode ∘ encode = id"
				)
				const digest = constantDigestOf(constant)
				const fn: ObjectName = {
					schema: "hex",
					name: identifierOf(identity.closedConstant(digest))
				}
				const rows = constant.entries.length
				const printed = printStatement(
					pack(fn, constant.cells, constant.width, { hex, rows, digest })
				)
				assert.deepEqual(readLiteralPack(printed), {
					function: printObjectName(fn),
					rows: BigInt(rows),
					cells: constant.cells,
					width: BigInt(constant.width),
					digest,
					hex
				})
				assert.equal(literalPackFault(undefined, printed), undefined, "an untampered literal holds")
				for (const flipped of flips(hex)) {
					const changed = changedAt(hex, flipped, constant.cells, constant.width)
					const fault = literalPackFault(undefined, restated(printed, hex, flipped))
					assert.deepEqual(
						fault === undefined
							? undefined
							: {
									kind: fault.kind,
									function: "function" in fault ? fault.function : undefined
								},
						{
							kind: changed.kind === "padding" ? "layout" : "content",
							function: printObjectName(fn)
						},
						`X'${flipped}' for X'${hex}'`
					)
					c.note(
						changed.kind === "padding" ? "a change in the padding alone" : "a change in a cell"
					)
				}
				const letter = Arr.findFirstIndex(Array.from(hex), (digit) => valueOf(digit) >= 10)
				if (Option.isSome(letter)) {
					const lower = replacedAt(hex, letter.value, Str.toLowerCase(defined(hex[letter.value])))
					assert.deepEqual(literalPackFault(undefined, restated(printed, hex, lower)), {
						kind: "layout",
						function: printObjectName(fn),
						fault: { kind: "digit", at: letter.value }
					})
				}
				assert.deepEqual(
					literalPackFault(
						undefined,
						Str.replace(`${rows} rows in `, `${rows + 1} rows in `)(printed)
					),
					{
						kind: "rows",
						function: printObjectName(fn),
						stated: BigInt(rows + 1),
						held: BigInt(rows)
					}
				)
				assert.deepEqual(literalPackFault(undefined, Str.replace("X'", "Y'")(printed)), {
					kind: "form"
				})
				assert.deepEqual(
					literalPackFault(undefined, `${printed} || X'0'::bit varying`),
					{ kind: "form" },
					"a literal joined to another is out of the form"
				)
				const bits = d.cells * d.width
				c.note(
					bits === 0
						? "a literal of no digit"
						: bits % 4 === 0
							? "a whole-digit literal"
							: "a padded literal"
				)
				if (d.width >= 31 && d.cells > 0) {
					c.note("a 32-bit cell")
				}
				if (d.cells > 0 && rows === 0) {
					c.note("no cell held")
				}
				if (d.cells > 0 && rows === d.cells) {
					c.note("every cell held")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the test oracle's bit text of the cells, padded to whole hex digits and written in hex"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/hex.ts",
				original: "\t\t(firstBit >> (position % hexDigitBits))",
				replacement: "\t\t(1 << (position % hexDigitBits))",
				why: "A hex digit's bits are written least significant first (core/hex.ts); the literal is no longer the oracle's hex of the cells' bits."
			},
			{
				file: "packages/engine/src/ir/cells.ts",
				original: "\t\tconst value = 1n + entry.payload",
				replacement: "\t\tconst value = entry.payload",
				why: "literalOf (ir/cells.ts) writes a present cell as its payload code, not 1 + payload, so a payload of code 0 reads as absent."
			}
		]
	})

/** A changed digit of an installed relation's constant names the relation, the first cell a change reaches and its key, or the padding it sets, for every digit. Its budget is its suite's before it was a property (test/unit/physical/literal.test.ts at 4ca3036a): 60 runs and 120 steered cases. */
export const aChangedDigitOfAnInstalledRelationsConstantNamesTheRelationTheFirstCellAChangeReachesAndItsKeyOrThePaddingItSetsForEveryDigit =
	property.explore(draws, {
		needs: {},
		budget: { runs: 60, steered: 120 },
		situations: [
			"a set",
			"a function",
			"a dependent key",
			"a change in the padding alone",
			"a change in a cell",
			"an owner function"
		] satisfies ReadonlyArray<Reached<InstalledFeature>>,
		check: (_, c: Case<InstalledFeature>) => (d: InstalledDraw) =>
			Effect.sync(() => {
				const owned = succeeded(ownedInput(installedSchemaOf(d)))
				const installation: Installation = succeeded(
					compileInstallation(owned, installOptions(owned))
				)
				const keysOf = (relation: string): ReadonlyArray<ReadonlyArray<string>> =>
					relation === "C"
						? pointsOf(d)
						: Arr.map(odometer([2, 2]), ([v, k]) => [versionAt(defined(v)), kindAt(defined(k))])
				/** The declared closed relation whose own constant `fn` is, the first in declared order. */
				const relationOf = (fn: string): string | undefined =>
					Arr.findFirst(Rec.values(installation.owned.relations), (r) => {
						if (r.desc.kind !== "closedRelation") {
							return false
						}
						const constant = installation.names.closed(r.desc.name)
						return (
							printObjectName(constant.function) === fn || printObjectName(constant.keys) === fn
						)
					}).pipe(
						Option.map((r) => r.desc.name),
						Option.getOrUndefined
					)
				const packs = Arr.filter(
					installation.statements,
					(s): s is PackConstant => s.kind === "packConstant"
				)
				for (const p of packs) {
					const printed = printStatement(p)
					assert.equal(
						literalPackFault(installation, printed),
						undefined,
						"the drafted literal holds"
					)
					const relation = relationOf(printObjectName(p.function))
					if (relation === undefined) {
						c.note("an owner function")
					}
					for (const flipped of flips(p.hex)) {
						const changed = changedAt(p.hex, flipped, p.cells, p.width)
						const fault = literalPackFault(installation, restated(printed, p.hex, flipped))
						const fn = printObjectName(p.function)
						if (changed.kind === "padding") {
							assert.deepEqual(
								fault === undefined
									? undefined
									: {
											kind: fault.kind,
											function: "function" in fault ? fault.function : undefined
										},
								{ kind: "layout", function: fn },
								`X'${flipped}' sets the padding of ${fn}`
							)
							c.note("a change in the padding alone")
							continue
						}
						assert.deepEqual(
							fault,
							{
								kind: "content",
								function: fn,
								relation,
								differs: {
									cell: changed.cell,
									key:
										relation === undefined
											? undefined
											: defined(keysOf(relation)[Number(changed.cell)], "the cell's point")
								}
							},
							`X'${flipped}' changes ${fn}`
						)
						c.note("a change in a cell")
					}
				}
				c.note(d.shape)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the odometer and the dependent sum's enumeration of the key, and the oracle's cells of each literal"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/literal.ts",
				original: "\t\t\treturn x.index < y.index ? x.index : y.index",
				replacement: "\t\t\treturn x.index < y.index ? y.index : x.index",
				why: "Where two literals hold different cells first, the later is named."
			}
		]
	})
