/**
 * The names of a query's records (program/records.ts): each relation records derive a name for, the root `${stem}Row`
 * and each attachment's whose path records' options state no name for, is admitted at any length, its name the schema
 * type's key and never cut short, and its table and whole view are hashed at the naming door over the name, spelled
 * after the records' stem and the relation's path (core/identity.ts identity.derivedTable, identity.derivedWholeView), `__<stem>_<digest>`, within
 * PostgreSQL's identifier whatever the name's length; a name its author states for an attachment's path is declared,
 * its table and whole view its conversion, refused past PostgreSQL's identifier as IdentifierTooLong where records are
 * built, and leads the derived names of the attachments under it that repeat a name.
 *
 * - The box of positions, bytes and namings: each position a name is derived at (positions) at one byte below the
 *   bound, at it and one past it, the relation named as records derive it or by a name of as many bytes stated at its
 *   path. Oracle: the README's naming rule restated (record-names.fixtures.ts namedCell), the bound, and the naming
 *   door's two forms.
 * - The faults of the options: each refused where the options are read, for its own rule.
 * - The documents metis reads in one step, an item's scan and each stimulus's below one read, under den's stems, the
 *   case that was refused before records' derived names were hashed: with no name stated, its records compile, a level
 *   listing them compiles, and every relation's table and whole view is hashed, within the bound, and its own. Oracle:
 *   the bound, and the naming door's census.
 *
 * Features: every cell of the box reached; every stem of the documents holding a derived name past the bound.
 */
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rcd, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import {
	censusOf,
	conversionOf,
	type Identity,
	maxIdentifierBytes
} from "#compiler/core/identity.ts"
import { lawsOf } from "#compiler/program/laws.ts"
import { recordsBuilder } from "#compiler/program/records.ts"
import { sha256 } from "#compiler/public/fields.ts"
import { schema } from "#compiler/public/schema.ts"
import { type OwnedRelation, ownedIdentities, wholeViewOf } from "#compiler/schema/own.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
import { succeeded } from "#test/support/assert.ts"
import { owning } from "#test/support/policy.ts"
import {
	type CellNaming,
	denStem,
	documentsRead,
	identifierBytes,
	longestStep,
	namedCell,
	Names,
	namingsAt,
	type OptionFault,
	optionFaults,
	type Position,
	positions,
	relationNames,
	statedOfBytes
} from "#test/unit/program/record-names.fixtures.ts"

/** The owner every records value of the properties holds. */
const owner = Object.freeze({ digest: sha256, root: sha256 })

/** What a cell of the box reaches: a name within the bound or past it, derived or stated, at a position. */
type NamedFeature = `${Position} ${CellNaming} ${"within" | "past"}`

/** Whether an identity is hashed, `__<stem>_<digest>`, and fits PostgreSQL's identifier. */
const hashedWithin = (named: Identity<"table" | "wholeView">): boolean =>
	named.form === "hashed" &&
	Str.startsWith("__")(named.identifier) &&
	utf8Length(named.identifier) <= maxIdentifierBytes

/**
 * The stored relations of records listed in a level over the documents' schema, by name, each with its table's and
 * whole view's identities, as ownership names them; the level's laws compiled (lawsOf), so the level compiles.
 */
const installedRecords = (
	made: {
		readonly relations: ReadonlyArray<AnyRelation>
		readonly rules: ReadonlyArray<Statement>
	},
	what: string
): ReadonlyMap<string, Extract<OwnedRelation, { readonly kind: "relation" }>> => {
	const level = schema.extend([Names], "Stored", made.relations, made.rules)
	lawsOf(level)
	const owned = owning(level)
	const census = succeeded(
		censusOf(ownedIdentities(owned)),
		`${what}: the installation's census admits every identity`
	)
	return new Map(
		Arr.map(made.relations, (r) => {
			const relation = owned.relations[r.name]
			if (relation?.kind !== "relation") {
				return assert.fail(`${what}: ${r.name} is an owned stored relation`)
			}
			if (relation.named.form === "hashed") {
				assert.ok(
					census.hashed.has(relation.ident),
					`${what}: ${r.name}'s hashed table is in the census`
				)
			}
			return [r.name, relation] as const
		})
	)
}

/**
 * A derived name is admitted at any length, its table and whole view hashed within PostgreSQL's identifier; a stated name
 * is declared, its table and whole view its conversion within the bound, refused past it as IdentifierTooLong.
 */
export const aDerivedRecordNameIsAdmittedAtAnyLengthAndHashedWhereAStatedOneIsDeclared =
	property.exhaust(
		finite((source) => {
			const position = source.draw(element(positions))
			return {
				position,
				bytes: source.draw(int(maxIdentifierBytes - 1, maxIdentifierBytes + 1)),
				naming: source.draw(element(namingsAt(position)))
			}
		}),
		{
			needs: {},
			situations: [
				"root derived within",
				"root derived past",
				"attachment derived within",
				"attachment derived past",
				"repeated derived within",
				"repeated derived past",
				"under a stated parent derived within",
				"under a stated parent derived past",
				"attachment stated within",
				"attachment stated past",
				"repeated stated within",
				"repeated stated past",
				"under a stated parent stated within",
				"under a stated parent stated past"
			] satisfies ReadonlyArray<Reached<NamedFeature>>,
			check: (_, c: Case<NamedFeature>) => (cell) =>
				Effect.sync(() => {
					const what = Formatter.format(cell)
					const built = namedCell(cell.position, cell.bytes)
					c.note(
						`${cell.position} ${cell.naming} ${cell.bytes <= maxIdentifierBytes ? "within" : "past"}`
					)
					const key = Arr.join(built.path, ".")
					const name = cell.naming === "derived" ? built.derived : statedOfBytes(cell.bytes)
					assert.equal(
						identifierBytes(name),
						cell.bytes,
						`${what}: the cell's name takes its bytes`
					)
					const made = catchCompileError(() =>
						recordsBuilder(
							built.stem,
							built.query,
							owner,
							["digest", "root"],
							[
								{
									names: cell.naming === "derived" ? built.names : { ...built.names, [key]: name }
								}
							]
						)
					)
					if (cell.naming === "stated" && cell.bytes > maxIdentifierBytes) {
						assert.ok(!made.ok, `${what}: a stated name past the bound is refused`)
						const reason = made.error.reason
						assert.ok(
							reason._tag === "IdentifierTooLong",
							`${what}: the refusal is IdentifierTooLong, not ${reason._tag}`
						)
						assert.equal(reason.bytes, cell.bytes, `${what}: the refusal names its bytes`)
						return
					}
					const records = succeeded(made, `${what}: the records are built`)
					assert.ok(
						relationNames(records.relations).includes(name),
						`${what}: the relation is named as its cell names it`
					)
					const installed = installedRecords(records, what)
					for (const [n, relation] of installed) {
						const statedHere = n === name && cell.naming === "stated"
						const stated = statedHere || Arr.contains(Rcd.values(built.names), n)
						if (stated) {
							assert.deepEqual(
								relation.desc.naming,
								{ kind: "declared" },
								`${what}: ${n} is declared`
							)
							assert.deepEqual<ReadonlyArray<string>>(
								[relation.named.form, relation.ident, wholeViewOf(relation).identifier],
								["readable", conversionOf(n), conversionOf(n)],
								`${what}: ${n}'s table and whole view are its conversion`
							)
							continue
						}
						assert.ok(
							relation.desc.naming.kind === "derived" && relation.desc.naming.stem === built.stem,
							`${what}: ${n} is derived from the stem`
						)
						assert.ok(hashedWithin(relation.named), `${what}: ${n}'s table is hashed and fits`)
						assert.ok(
							hashedWithin(wholeViewOf(relation)),
							`${what}: ${n}'s whole view is hashed and fits`
						)
					}
					if (cell.naming === "derived") {
						const measured = installed.get(name)
						assert.deepEqual(
							measured?.desc.naming,
							{ kind: "derived", stem: built.stem, path: built.path },
							`${what}: the measured relation is derived at its path`
						)
					}
					const tables = Arr.map(Array.from(installed.values()), (r) => r.ident)
					assert.equal(
						Arr.dedupe(tables).length,
						tables.length,
						`${what}: every relation has a table of its own`
					)
				}),
			oracle: {
				kind: "second-implementation",
				name: "the README's naming rule restated, each name's conversion against PostgreSQL's bound and the naming door's two forms"
			},
			box: "each position a records relation's name is derived at, at one byte under PostgreSQL's identifier bound, at it and one past it, derived or stated at its path",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/schema/own.ts",
					original: "\t\t\t\t\tnamed: identity.derivedTable(name, spelling),",
					replacement: "\t\t\t\t\tnamed: identity.table(name),",
					why: "A derived relation's table is rendered readable, its name's conversion: past the bound it is an identifier PostgreSQL cuts short, and within it no hashed name."
				},
				{
					file: "packages/engine/src/schema/own.ts",
					original: "\t\t\t\t\twhole: identity.derivedWholeView(name, spelling)",
					replacement: "\t\t\t\t\twhole: identity.wholeView(name)",
					why: "A derived relation's whole view is rendered readable, its name's conversion, past the bound an identifier PostgreSQL cuts short."
				},
				{
					file: "packages/engine/src/schema/relation.ts",
					original: "\t\t\treturn requireDerivedName(name, label, kind)",
					replacement: "\t\t\treturn requireDeclaredName(name, label, kind)",
					why: "A derived name is admitted by the declared-name rule: one past the bound is refused where records are built."
				},
				{
					file: "packages/engine/src/core/identity.ts",
					original: "\t\tconst parsed = parseDerivedName(name)\n\t\tif (!parsed.ok) {",
					replacement: "\t\tconst parsed = parseDeclaredName(name)\n\t\tif (!parsed.ok) {",
					why: "Ownership declares a derived name by the declared-name rule: a level listing records whose derived name passes the bound does not compile."
				},
				{
					file: "packages/engine/src/program/records.ts",
					original: "\t\t\t: [stated, declaredNaming]",
					replacement: "\t\t\t: [stated, derivedNaming(building.stem, path)]",
					why: "A stated name is installed as a derived one, hashed: its table and whole view are not its conversion."
				},
				{
					file: "packages/engine/src/core/identity.ts",
					original:
						'\treturn bytes > maxIdentifierBytes\n\t\t? Result.err({ kind: "length", conversion, bytes })',
					replacement:
						'\treturn bytes >= maxIdentifierBytes\n\t\t? Result.err({ kind: "length", conversion, bytes })',
					why: "A stated name whose conversion takes exactly PostgreSQL's bound is refused, where PostgreSQL keeps it whole."
				},
				{
					file: "packages/engine/src/program/records.ts",
					original: '\tconst stated = building.names.get(path.join("."))',
					replacement: "\tconst stated = building.names.get(a.name)",
					why: "A stated name is read by the attachment's name alone, not its path: a name stated two levels down is never met, and its relation is derived."
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
 * The documents metis reads in one step, under den's stem for a step's read, the case refused before records' derived
 * names were hashed: with no name stated, its records compile, a level listing them compiles, and every relation's
 * table and whole view is hashed within PostgreSQL's identifier, each table its own.
 */
export const metisDocumentsReadInOneStepCompileWithNoNameStatedEachRelationHashedWithinTheBound =
	property.exhaust(
		finite((source) => source.draw(int(0, longestStep))),
		{
			needs: {},
			situations: ["a derived name past the bound"] satisfies ReadonlyArray<
				Reached<"a derived name past the bound">
			>,
			check: (_, c: Case<"a derived name past the bound">) => (step) =>
				Effect.sync(() => {
					const stem = denStem(step)
					const what = `stem ${stem}`
					const made = succeeded(
						catchCompileError(() =>
							recordsBuilder(stem, documentsRead, owner, ["digest", "root"], [])
						),
						`${what}: the read's records are built with no name stated`
					)
					const names = relationNames(made.relations)
					assert.ok(
						Arr.some(names, (n) => identifierBytes(n) > maxIdentifierBytes),
						`${what}: the read derives a name past the bound`
					)
					c.note("a derived name past the bound")
					const installed = installedRecords(made, what)
					for (const [n, relation] of installed) {
						assert.ok(hashedWithin(relation.named), `${what}: ${n}'s table is hashed and fits`)
						assert.ok(
							hashedWithin(wholeViewOf(relation)),
							`${what}: ${n}'s whole view is hashed and fits`
						)
					}
					const tables = Arr.map(Array.from(installed.values()), (r) => r.ident)
					assert.equal(
						Arr.dedupe(tables).length,
						names.length,
						`${what}: every relation has a table of its own`
					)
				}),
			oracle: {
				kind: "universal",
				name: "PostgreSQL's identifier bound, and the naming door's census over the level's identities"
			},
			box: "den's stems for a step reading an item's documents, its step's name one letter to as many as left the records' root's conversion within the bound",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/schema/own.ts",
					original: "\t\t\t\t\tnamed: identity.derivedTable(name, spelling),",
					replacement: "\t\t\t\t\tnamed: identity.table(name),",
					why: "A derived relation's table is rendered readable, its name's conversion: metis's deep reads name tables PostgreSQL cuts short."
				},
				{
					file: "packages/engine/src/schema/own.ts",
					original: "\t\t\t\t\tnamed: identity.derivedTable(name, spelling),",
					replacement: "\t\t\t\t\tnamed: identity.derivedTable(r.naming.stem, [r.naming.stem]),",
					why: "A derived relation's table is named by its records' stem alone: every relation of one records is one table."
				}
			]
		}
	)
