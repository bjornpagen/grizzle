/**
 * Hex, the one spelling of every bit string grizzle writes (core/hex.ts), a roster's live codes and bits domain and a
 * set's literal; and a closed relation's constant, its cells' and its payloads' bigint[] literals (ir/cells.ts
 * cellsLiteralOf, payloadsLiteralOf and their readers, sql/print.ts writePack and readLiteralPack, physical/ddl/literal.ts
 * literalPackFault).
 *
 * - **Every bit string a drafted migration writes is one hex constant, and every array of a constant one literal:**
 *   over generated schemas (one to three rosters of 1 to 9 codes, so most widths pad; a closed relation keyed by one or
 *   two of them with no payload, a closed-id payload or an open one, at a drawn density; a stored relation holding two
 *   sets over a drawn roster, their union, intersection and difference generated, the singleton of a closed id
 *   generated, the empty set with its code's bit set, a row check against a drawn set literal, and a containment into
 *   the closed relation; an or fold over a counted family whose accumulator starts at the empty set), the first
 *   migration's every file lexes to statements in which every bit-string constant is X'…' of hex digits cast, with no
 *   binary B'' constant, no text cast to a bit type, no string_agg and no || beside a bit string; and its snapshot's
 *   every bit literal is the bits kind of hex digits, a set's at its bits domain's width, every bits domain is bit(n)
 *   with n its roster's codes rounded up to whole bytes, every live constant the hex of its roster's live codes, and
 *   every closed constant's array's literal one the oracle reads over its layout, its row count its elements.
 * - **decode ∘ encode = id:** over drawn constants (0 to 40 cells over 1 to 9 payload codes or the most a bigint payload
 *   holds, 2^63), each array's literal is the oracle's spelling of it, it decodes back to the array, and its printed
 *   statement reads back to its parts and holds.
 * - **Every edit is refused, naming the array:** each element one up and one down, dropped, written twice or with a
 *   leading 0, an element added past the last and a cells literal's sentinel dropped, is refused by `grizzle check`'s
 *   reader naming the array's function, as the layout fault the oracle reads where it breaks the spelling, the order or
 *   the range, and otherwise as content its digest does not state; and over installed closed relations, product and
 *   dependent keys alike, every such edit of a relation's own arrays names the relation, the first cell it changes and
 *   that cell's key. An edited row count and a literal out of its printed form are refused too.
 *
 * Oracles: the test oracle's bit texts and hex (test/support/closed/bit-text.ts), and its spelling and reading of a
 * literal (test/support/closed/codes.ts, literal.fixtures.ts oracleRead), sharing no code with the engine's encoder;
 * the odometer and the dependent sum's enumeration for a changed cell's key.
 *
 * Features: each roster width, padded or whole; each closed relation's key and payload kind; each set expression; an
 * edit out of order or range and one of another constant; an edited row count and a literal out of its printed form.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { maxStringLength } from "#compiler/core/canonical.ts"
import type { ConstantDigest } from "#compiler/core/fingerprint.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { draftMigration } from "#compiler/deploy/render/generate.ts"
import { emptySnapshot, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import {
	cellsDigestOf,
	cellsLiteralOf,
	cellsOfLiteral,
	type Constant,
	payloadsDigestOf,
	payloadsLiteralOf,
	payloadsOfLiteral
} from "#compiler/ir/cells.ts"
import { literalPackFault } from "#compiler/physical/ddl/literal.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import type { ObjectName, PackConstant, PackLayout } from "#compiler/sql/ast.ts"
import { type ConstantFunctions, pack } from "#compiler/sql/constants.ts"
import { printObjectName, printStatement, readLiteralPack } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { joined } from "#test/support/chunked.ts"
import { hexOfText, setText, setWidth } from "#test/support/closed/bit-text.ts"
import { oracleLiteral, oracleCells, oraclePayloads } from "#test/support/closed/codes.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { ownedInput, owning } from "#test/support/policy.ts"
import {
	codeConstantOf,
	type CodeString,
	type Draft,
	type DraftFeature,
	draws,
	editsOf,
	fileViolations,
	firstCellApart,
	firstPlaceApart,
	type InstalledDraw,
	type InstalledFeature,
	installedSchemaOf,
	kindAt,
	type LiteralFeature,
	mostPoints,
	odometer,
	oracleRead,
	pointsOf,
	restated,
	rosterName,
	schemaOf,
	schemas,
	snapshotViolations,
	strings,
	versionAt
} from "#test/unit/physical/literal.fixtures.ts"

/** A drafted migration writes every bit string as one hex constant and every array of a closed constant as one literal, and its snapshot alike. Its budget is its suite's before it was a property (test/unit/physical/literal.test.ts at 4ca3036a): 80 runs and 160 steered cases. */
export const aDraftedMigrationWritesEveryBitStringAsOneHexConstantAndEveryArrayOfAClosedConstantAsOneLiteral =
	property.explore(schemas, {
		needs: {},
		budget: { runs: 80, steered: 160 },
		situations: [
			"no payload",
			"a closed-id payload",
			"an open payload",
			"a padded set",
			"a whole-digit set",
			"a constant of payload codes",
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
						const domain = identity.bitsDomain(parsedName(rosterName(i)), setWidth(size))
						return [identifierOf(domain), setWidth(size)] as const
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
					assert.deepEqual(fileViolations(joined(file.text), domains), [], file.name)
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
					if (s.layout.kind === "payloads") {
						c.note("a constant of payload codes")
					}
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
			name: "the one spelling: X'…' of whole hex digits, cast, at the bits domain's width, nothing else; a constant's literal as the oracle reads it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/scalar.ts",
				original: '\treturn b.carrier === "code" || b.carrier === "bits" ? b.roster : undefined',
				replacement: '\treturn b.carrier === "code" ? b.roster : undefined',
				why: 'Operator mutant fa5a114568 at packages/engine/src/ir/scalar.ts:750 in rosterOf: `b.carrier === "code" || b.carrier === "bits"` becomes `b.carrier === "code"`; the property fails (the census, lane TESTPOLICY2).'
			}
		]
	})

/**
 * One array of a constant as the test states it: its layout, its literal, its elements past any sentinel and its digest.
 */
interface Stated {
	readonly layout: PackLayout
	readonly text: string
	readonly elements: ReadonlyArray<bigint>
	readonly digest: ConstantDigest<"closed-constant">
}

/** The arrays a constant installs, each as its literal, the engine's, and its elements, the oracle's. */
const statedArrays = (constant: Constant): ReadonlyArray<Stated> => {
	const cells = Arr.drop(oracleCells(constant), 1)
	const payloads = oraclePayloads(constant)
	return [
		{
			layout: { kind: "cells", cells: constant.cells },
			text: succeeded(cellsLiteralOf(constant, maxStringLength)),
			elements: cells,
			digest: cellsDigestOf(constant.cells, cells)
		},
		...(payloads === undefined
			? []
			: [
					{
						layout: { kind: "payloads", points: constant.points } as const,
						text: succeeded(payloadsLiteralOf(constant, maxStringLength)),
						elements: payloads,
						digest: payloadsDigestOf(constant.points, payloads)
					}
				])
	]
}

/** A closed constant's literals decode to its arrays, are the oracle's spelling of them, read back printed, and refuse every edit. Its budget is its suite's before it was a property (test/unit/physical/literal.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const aClosedConstantsLiteralsDecodeToItsArraysAreTheOraclesSpellingOfThemReadBackPrintedAndRefuseEveryEdit =
	property.explore(strings, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"a set",
			"a function",
			"a payload space at the most codes",
			"a literal of no code",
			"no cell held",
			"every cell held",
			"an edit out of order or range",
			"an edit of another constant"
		] satisfies ReadonlyArray<Reached<LiteralFeature>>,
		check: (_, c: Case<LiteralFeature>) => (d: CodeString) =>
			Effect.sync(() => {
				const constant = codeConstantOf(d)
				const arrays = statedArrays(constant)
				assert.equal(arrays.length, constant.points > 1n ? 2 : 1, "payloads exactly past one code")
				for (const array of arrays) {
					assert.equal(
						array.text,
						oracleLiteral(
							array.layout.kind === "cells" ? [-1n, ...array.elements] : array.elements
						),
						`the ${array.layout.kind}' literal is the oracle's spelling`
					)
					assert.deepEqual(
						succeeded(
							array.layout.kind === "cells"
								? cellsOfLiteral(array.text, array.layout.cells)
								: payloadsOfLiteral(array.text, array.layout.points)
						),
						array.elements,
						"decode ∘ encode = id"
					)
					const fn: ObjectName = {
						schema: "codes",
						name: identifierOf(identity.closedConstant(array.digest))
					}
					const rows = array.elements.length
					const printed = printStatement(
						pack(fn, array.layout, { text: array.text, rows, digest: array.digest })
					)
					assert.deepEqual(readLiteralPack(printed), {
						function: printObjectName(fn),
						rows: BigInt(rows),
						layout: array.layout,
						digest: array.digest,
						text: array.text
					})
					assert.equal(
						literalPackFault(undefined, printed),
						undefined,
						"an untampered literal holds"
					)
					for (const edit of editsOf(array.text, array.layout)) {
						const read = oracleRead(edit.text, array.layout)
						assert.deepEqual(
							literalPackFault(undefined, restated(printed, array.text, edit.text)),
							read.kind === "fault"
								? { kind: "layout", function: printObjectName(fn), fault: read.fault }
								: {
										kind: "content",
										function: printObjectName(fn),
										relation: undefined,
										differs: undefined
									},
							`${edit.what}: ${edit.text} for ${array.text}`
						)
						c.note(
							read.kind === "fault"
								? "an edit out of order or range"
								: "an edit of another constant"
						)
					}
					assert.deepEqual(
						literalPackFault(
							undefined,
							Str.replace(`: ${rows} rows `, `: ${rows + 1} rows `)(printed)
						),
						{
							kind: "rows",
							function: printObjectName(fn),
							stated: BigInt(rows + 1),
							held: BigInt(rows)
						}
					)
					assert.deepEqual(literalPackFault(undefined, Str.replace("'{", "'[")(printed)), {
						kind: "layout",
						function: printObjectName(fn),
						fault: { kind: "array" }
					})
					assert.deepEqual(
						literalPackFault(undefined, `${printed} || '{1}'::bigint[]`),
						{ kind: "form" },
						"a literal joined to another is out of the form"
					)
					if (array.layout.kind === "payloads") {
						assert.deepEqual(
							literalPackFault(
								undefined,
								Str.replace(
									` of ${array.layout.points} payload codes`,
									" of 0 payload codes"
								)(printed)
							),
							{ kind: "form" },
							"a comment stating no payload code is out of the form"
						)
					}
				}
				const rows = constant.entries.length
				c.note(constant.points === 1n ? "a set" : "a function")
				if (constant.points === mostPoints) {
					c.note("a payload space at the most codes")
				}
				if (rows === 0) {
					c.note("a literal of no code")
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
			name: "the test oracle's spelling of each array and its reading of every edited literal, element by element"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/cells.ts",
				original: "\t\tindex <= before",
				replacement: "\t\tindex < before",
				why: "cellsOfLiteral admits an index written twice: the edit is refused as content, not as the order fault the oracle reads."
			},
			{
				file: "packages/engine/src/ir/cells.ts",
				original: "\t\t\t: index >= cells",
				replacement: "\t\t\t: index > cells",
				why: "cellsOfLiteral admits the index one past the last cell; an element past every other is refused as content, not as the cell fault the oracle reads."
			},
			{
				file: "packages/engine/src/ir/cells.ts",
				original: '(code >= points ? { kind: "code", at, code } : undefined)',
				replacement: '(code > points ? { kind: "code", at, code } : undefined)',
				why: "payloadsOfLiteral admits a payload code at the payload codes; an edit one up of the greatest code is refused as content, not as the code fault the oracle reads."
			},
			{
				file: "packages/engine/src/ir/cells.ts",
				original:
					'\ttext !== "" && isAsciiDigits(text, 0, text.length) && (text === "0" || !text.startsWith("0"))',
				replacement: '\ttext !== "" && isAsciiDigits(text, 0, text.length)',
				why: "A literal reads an element with a leading 0 as its value, a second spelling of one array; the edit is refused as content, not as the element fault the oracle reads."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: "\treturn n === undefined || n === 0n ? undefined : n",
				replacement: "\treturn n",
				why: "readLiteralPack reads a comment stating no payload code; the property fails where it is out of the form."
			}
		]
	})

/** An edit of an installed relation's arrays names the relation, the first cell it changes and its key, or the layout fault it makes, for every edit. Its budget is its suite's before it was a property (test/unit/physical/literal.test.ts at 4ca3036a): 60 runs and 120 steered cases. */
export const anEditOfAnInstalledRelationsArraysNamesTheRelationTheFirstCellItChangesAndItsKeyOrItsLayoutFault =
	property.explore(draws, {
		needs: {},
		budget: { runs: 60, steered: 120 },
		situations: [
			"a set",
			"a function",
			"a dependent key",
			"an edit out of order or range",
			"an edit of another constant",
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
				/** A constant the names read, and the relation it is its own of, none for an owner function. */
				interface Named {
					readonly functions: ConstantFunctions
					readonly relation: string | undefined
				}
				/** Each constant the names read. */
				const constants = Arr.flatMap(["Model", "C"] as const, (name): ReadonlyArray<Named> => {
					const closed = installation.names.closed(name)
					const owners =
						closed.key.kind === "product" ? [] : [closed.key.bases, ...closed.key.counts]
					return [
						{ functions: closed.constant, relation: name },
						...Arr.map(owners, (functions): Named => ({ functions, relation: undefined }))
					]
				})
				const packs = Arr.filter(
					installation.statements,
					(s): s is PackConstant => s.kind === "packConstant"
				)
				const elementsOf = (fn: string): ReadonlyArray<bigint> => {
					const p = defined(
						Option.getOrUndefined(Arr.findFirst(packs, (x) => printObjectName(x.function) === fn)),
						`the pack of ${fn}`
					)
					const read = oracleRead(p.text, p.layout)
					return read.kind === "elements" ? read.elements : assert.fail(`the drafted ${fn} reads`)
				}
				for (const p of packs) {
					const printed = printStatement(p)
					assert.equal(
						literalPackFault(installation, printed),
						undefined,
						"the drafted literal holds"
					)
					const fn = printObjectName(p.function)
					const owner = Option.getOrUndefined(
						Arr.findFirst(
							constants,
							(k) =>
								printObjectName(k.functions.cells) === fn ||
								(k.functions.payloads.kind === "codes" &&
									printObjectName(k.functions.payloads.function) === fn)
						)
					)
					const relation = owner?.relation
					if (owner !== undefined && relation === undefined) {
						c.note("an owner function")
					}
					const was = elementsOf(fn)
					for (const edit of editsOf(p.text, p.layout)) {
						const fault = literalPackFault(installation, restated(printed, p.text, edit.text))
						const read = oracleRead(edit.text, p.layout)
						if (read.kind === "fault") {
							assert.deepEqual(
								fault,
								{ kind: "layout", function: fn, fault: read.fault },
								`${edit.what} of ${fn}`
							)
							c.note("an edit out of order or range")
							continue
						}
						const place = firstPlaceApart(was, read.elements)
						const cell =
							p.layout.kind === "cells"
								? firstCellApart(was, read.elements)
								: owner === undefined || place === undefined
									? undefined
									: elementsOf(printObjectName(owner.functions.cells))[place]
						assert.deepEqual(
							fault,
							{
								kind: "content",
								function: fn,
								relation,
								differs:
									cell === undefined
										? undefined
										: {
												cell,
												key:
													relation === undefined
														? undefined
														: defined(keysOf(relation)[Number(cell)], "the cell's point")
											}
							},
							`${edit.what} of ${fn}`
						)
						c.note("an edit of another constant")
					}
				}
				c.note(d.shape)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the odometer and the dependent sum's enumeration of the key, and the oracle's reading of each literal"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/literal.ts",
				original: "\t\t\treturn x < y ? x : y",
				replacement: "\t\t\treturn x < y ? y : x",
				why: "Where two cells literals hold different indexes first, the later is named."
			}
		]
	})
