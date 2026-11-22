/**
 * The names of a query's records (program/records.ts): each relation records derive a name for, the root `${stem}Row`
 * and each attachment's, is refused where its identifier passes PostgreSQL's (core/identity.ts maxIdentifierBytes) as
 * RecordNameTooLong, naming its path, the name, its identifier's bytes and the bound, and never cut short; a name its
 * author states for an attachment's path in records' options replaces the derived one, and leads the derived names of
 * the attachments under it that repeat a name.
 *
 * - The box of positions and bytes: each position a name is derived at (positions) at one byte below the bound, at it
 *   and one past it. Oracle: the README's naming rule restated (record-names.fixtures.ts namedCell), and the bound.
 * - The faults of the options: each refused where the options are read, for its own rule.
 * - The documents metis reads in one step, an item's scan and each stimulus's below one read, under den's stems: the
 *   refusal names a path, and a name stated there, repeated until none is refused, compiles records whose every
 *   identifier fits, each stated name the relation's at its path. Oracle: the bound, and the names stated.
 *
 * Features: the refused positions and the faults, every one reached; every stem of the documents' refused before its
 *   names are stated.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rcd, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { maxIdentifierBytes } from "#compiler/core/identity.ts"
import { recordsBuilder } from "#compiler/program/records.ts"
import { sha256 } from "#compiler/public/fields.ts"
import {
	denStem,
	documentsRead,
	identifierBytes,
	longestStep,
	namedCell,
	type OptionFault,
	optionFaults,
	type Position,
	positions,
	relationNames
} from "#test/unit/program/record-names.fixtures.ts"

/** The owner every records value of the properties holds. */
const owner = Object.freeze({ digest: sha256, root: sha256 })

/** What a cell of the box reaches: a fit at a position, or a refusal at one. */
type NamedFeature = `${Position} fits` | `${Position} refused`

/**
 * A derived name fits exactly when its identifier is within PostgreSQL's bound; past it, the refusal names the path, the
 * name, its identifier's bytes and the bound, and the fix it names compiles: a name stated at the path, or for the root
 * a shorter stem.
 */
export const aDerivedRecordNamePastPostgresBoundIsRefusedByNameAndItsFixCompiles = property.exhaust(
	finite((source) => ({
		position: source.draw(element(positions)),
		bytes: source.draw(int(maxIdentifierBytes - 1, maxIdentifierBytes + 1))
	})),
	{
		needs: {},
		situations: [
			"root fits",
			"root refused",
			"attachment fits",
			"attachment refused",
			"repeated fits",
			"repeated refused",
			"under a stated parent fits",
			"under a stated parent refused"
		] satisfies ReadonlyArray<Reached<NamedFeature>>,
		check: (_, c: Case<NamedFeature>) => (cell) =>
			Effect.sync(() => {
				const what = Formatter.format(cell)
				const built = namedCell(cell.position, cell.bytes)
				assert.equal(
					identifierBytes(built.derived),
					cell.bytes,
					`${what}: the cell's name takes its bytes`
				)
				const made = catchCompileError(() =>
					recordsBuilder(
						built.stem,
						built.query,
						owner,
						["digest", "root"],
						[{ names: built.names }]
					)
				)
				if (cell.bytes <= maxIdentifierBytes) {
					c.note(`${cell.position} fits`)
					assert.ok(made.ok, `${what}: a name within the bound compiles`)
					assert.ok(
						relationNames(made.value.relations).includes(built.derived),
						`${what}: the relation is named as records derive it`
					)
					return
				}
				c.note(`${cell.position} refused`)
				assert.ok(!made.ok, `${what}: a name past the bound is refused`)
				const reason = made.error.reason
				assert.ok(reason._tag === "RecordNameTooLong", `${what}: the refusal is RecordNameTooLong`)
				assert.deepEqual(
					{
						records: reason.records,
						path: reason.path,
						name: reason.name,
						bytes: reason.bytes,
						limit: reason.limit
					},
					{
						records: built.stem,
						path: built.path,
						name: built.derived,
						bytes: cell.bytes,
						limit: maxIdentifierBytes
					},
					`${what}: the refusal names the relation`
				)
				assert.equal(
					identifierBytes(reason.name),
					reason.bytes,
					`${what}: its bytes are its identifier's`
				)
				const fixed =
					cell.position === "root"
						? catchCompileError(() =>
								recordsBuilder(
									Str.slice(1)(built.stem),
									built.query,
									owner,
									["digest", "root"],
									[{ names: built.names }]
								)
							)
						: catchCompileError(() =>
								recordsBuilder(
									built.stem,
									built.query,
									owner,
									["digest", "root"],
									[{ names: { ...built.names, [Arr.join(built.path, ".")]: "Fixed" } }]
								)
							)
				assert.ok(fixed.ok, `${what}: the fix the refusal names compiles`)
				if (cell.position !== "root") {
					assert.ok(
						relationNames(fixed.value.relations).includes("Fixed"),
						`${what}: the stated name is the relation's`
					)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the README's naming rule restated, each name's identifier against PostgreSQL's bound"
		},
		box: "each position a records relation's name is derived at, at one byte under PostgreSQL's identifier bound, at it and one past it",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/records.ts",
				original: '\tif (parsed.ok || parsed.error.kind !== "length") {',
				replacement: '\tif (parsed.ok || parsed.error.kind === "length") {',
				why: "A derived name past the bound is built as it is, refused by the relation's builder as the generic IdentifierTooLong of a relation name, which names no path and no fix."
			},
			{
				file: "packages/engine/src/program/records.ts",
				original: '\tthrow CompileError.make({\n\t\t_tag: "RecordNameTooLong",',
				replacement:
					'\treturn name.slice(0, maxIdentifierBytes)\n\tthrow CompileError.make({\n\t\t_tag: "RecordNameTooLong",',
				why: "A derived name past the bound is cut short silently: the cell one byte past it compiles, or meets the relation builder's generic refusal, where it is refused by name."
			},
			{
				file: "packages/engine/src/core/identity.ts",
				original:
					'\treturn bytes > maxIdentifierBytes\n\t\t? Result.err({ kind: "length", conversion, bytes })',
				replacement:
					'\treturn bytes >= maxIdentifierBytes\n\t\t? Result.err({ kind: "length", conversion, bytes })',
				why: "A name whose identifier takes exactly PostgreSQL's bound is refused, where PostgreSQL keeps it whole."
			},
			{
				file: "packages/engine/src/program/records.ts",
				original: '\t\tbuilding.names.get(path.join(".")) ??',
				replacement: "\t\tbuilding.names.get(a.name) ??",
				why: "A stated name is read by the attachment's name alone, not its path: a name stated two levels down is never met, so the fix the refusal names fails, and the stated parent leads nothing."
			}
		]
	}
)

/** What a fault of the options reaches: its refusal. */
type FaultFeature = `${OptionFault} refused`

/** Each fault of records' options is refused where the options are read, for its own rule. */
export const recordsOptionsAreReadOnceAndEachFaultIsRefusedForItsRule = property.exhaust(
	finite((source) => source.draw(element(optionFaults))),
	{
		needs: {},
		situations: [
			"a stray path refused",
			"an overlong stated name refused",
			"options that are no record refused",
			"a sixth argument refused"
		] satisfies ReadonlyArray<Reached<FaultFeature>>,
		check: (_, c: Case<FaultFeature>) => (fault) =>
			Effect.sync(() => {
				const built = namedCell("repeated", maxIdentifierBytes - 1)
				const options: ReadonlyArray<unknown> =
					fault === "a stray path"
						? [{ names: { nowhere: "Fixed" } }]
						: fault === "an overlong stated name"
							? [{ names: { one: Str.repeat(maxIdentifierBytes + 1)("N") } }]
							: fault === "options that are no record"
								? [["names"]]
								: [{ names: {} }, {}]
				const made = catchCompileError(() =>
					recordsBuilder(built.stem, built.query, owner, ["digest", "root"], options)
				)
				c.note(`${fault} refused`)
				assert.ok(!made.ok, `${fault}: refused`)
				const reason = made.error.reason
				const expected =
					fault === "a stray path"
						? "Refused"
						: fault === "an overlong stated name"
							? "IdentifierTooLong"
							: "MalformedDescription"
				assert.equal(reason._tag, expected, `${fault}: refused for its rule`)
				if (reason._tag === "Refused") {
					assert.equal(
						reason.refusal,
						"records' names name only the query's attachments, each by its path",
						`${fault}: the refusal of the one vocabulary`
					)
				}
			}),
		oracle: { kind: "universal", name: "each fault's rule: the refusal it names" },
		box: "each fault of records' options",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/records.ts",
				original: "\t\t\tif (!paths.has(path)) {",
				replacement: "\t\t\tif (!paths.has(path) && path === path.toUpperCase()) {",
				why: "A stated name of a path no attachment has is taken and never read: a stray path compiles."
			},
			{
				file: "packages/engine/src/program/records.ts",
				original: "\tif (options.length > 1) {",
				replacement: "\tif (options.length > 2) {",
				why: "A sixth argument is ignored where records takes five at most."
			}
		]
	}
)

/**
 * The documents metis reads in one step, under den's stem for a step's read: each name the refusal reports, stated at
 * its path, until none is refused, compiles records whose every identifier fits PostgreSQL's bound, each stated name the
 * relation's at its path; no name is stated past the read's attachments.
 */
export const metisDocumentsReadInOneStepCompileOnceTheNamesTheRefusalsReportAreStated =
	property.exhaust(
		finite((source) => source.draw(int(0, longestStep))),
		{
			needs: {},
			situations: ["refused before names"] satisfies ReadonlyArray<Reached<"refused before names">>,
			check: (_, c: Case<"refused before names">) => (step) =>
				Effect.sync(() => {
					const stem = denStem(step)
					const stated = new Map<string, string>()
					const attempt = () =>
						catchCompileError(() =>
							recordsBuilder(
								stem,
								documentsRead,
								owner,
								["digest", "root"],
								[{ names: Rcd.fromEntries(stated) }]
							)
						)
					let made = attempt()
					assert.ok(!made.ok, `stem ${stem}: the read's derived names pass the bound`)
					c.note("refused before names")
					while (!made.ok) {
						const reason = made.error.reason
						if (reason._tag !== "RecordNameTooLong" || reason.path.length === 0) {
							return assert.fail(
								`stem ${stem}: a refusal whose fix is a stated name, not ${Formatter.format(reason)}`
							)
						}
						const path = Arr.join(reason.path, ".")
						assert.ok(!stated.has(path), `stem ${stem}: ${path} is refused once`)
						stated.set(path, `Named${stated.size}`)
						made = attempt()
					}
					const relations = made.value.relations
					for (const r of relations) {
						assert.ok(
							identifierBytes(r.name) <= maxIdentifierBytes,
							`stem ${stem}: ${r.name}'s identifier fits`
						)
					}
					for (const name of stated.values()) {
						assert.ok(
							relationNames(relations).includes(name),
							`stem ${stem}: the stated ${name} is a relation's`
						)
					}
					assert.ok(
						Arr.every(Array.from(stated.keys()), (path) => defined(path, "a path").length > 0),
						`stem ${stem}: every stated name is an attachment's`
					)
				}),
			oracle: {
				kind: "universal",
				name: "PostgreSQL's identifier bound, and each stated name the relation's at its path"
			},
			box: "den's stems for a step reading an item's documents, its step's name one letter to as many as leave the records' root within the bound",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/program/records.ts",
					original: '\t\tbuilding.names.get(path.join(".")) ??',
					replacement: '\t\tbuilding.names.get(path.slice(0, 1).join(".")) ??',
					why: "A stated name is read at its path's first attachment alone: a name stated under it is never met, the refusal at that path comes back, and metis's read never compiles."
				}
			]
		}
	)
