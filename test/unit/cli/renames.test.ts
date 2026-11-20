/**
 * The rename declaration reader (packages/grizzle/src/cli/renames.ts) against D9's grammar, stated as a checker that
 * shares no code with it but the naming door's rule of a declared name (core/identity.ts parseDeclaredName) and its
 * reading of two names as one (declaredAlike):
 *
 * - a side is NAME (a relation), NAME.NAME (a field), NAME#HANDLE (a roster's handle) or @NAME (a login), where NAME
 *   is a declared name and HANDLE is text a PostgreSQL name holds: not empty, at most 63 UTF-8 bytes, with no NUL and
 *   no lone surrogate;
 * - a rename's readings are the splits of its text at one `=` into two sides of one kind; it parses exactly when it
 *   has one reading and its two sides are not one name, and then to that reading;
 * - a drop parses exactly when its text is a side;
 * - a command line's declarations parse exactly when each does, no old name is renamed or dropped twice, and no two
 *   renames share a new name, each kind kept in the order given;
 * - a handle rename's new roster resolves to the schema's roster whose name is alike, and one the schema lacks is
 *   refused, naming it.
 *
 * The spaces, generated: sides of every form, their names drawn from the identifier dictionary
 * (test/support/kernel/dict.ts), admitted and refused, alias groups among them, and the empty text; their handles from
 * a few letters, the signs `=`, `#`, `@` and `.`, characters of two, three and four UTF-8 bytes, a NUL and a lone
 * surrogate, short, straddling the 63 bytes a name holds, or holding a side of their own after an `=`, so a handle
 * rename splits two ways; renames of two sides, of two sides of one form, of a side and itself, and of a handle that
 * holds a side; command lines of up to three renames and two drops over a pool of three sides of one form, so swaps,
 * chains, repeats and merges arise, alike names among them; and handle renames to the schema's rosters, respelled
 * alike, or to a roster it may lack.
 *
 * Oracle: D9's grammar stated as a checker, sharing no code with the reader but the naming door's rule of a declared
 * name and its reading of two names as one.
 *
 * Features: each side's form, admitted and refused, a split two ways, a handle renamed to itself under its roster
 * spelled apart, swaps, chains, repeats and merges, and a roster respelled alike or lacking.
 */
import { assert, deepEquals } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { parseDeclarations, parseDrop, parseRename, rosterRenames } from "#cli/renames.ts"
import { type DeclaredName, declaredAlike } from "#compiler/core/identity.ts"
import { Roster } from "#compiler/ir/scalar.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	type Dropped,
	type Listed,
	listingFeatures,
	listingSpace,
	listRuling,
	parsedName,
	readingsOf,
	renameSpace,
	renameRuling,
	type Resolved,
	rosterCaseGen,
	sameSide,
	sideGen,
	sideOf,
	type Spelled,
	verdictOf
} from "#test/unit/cli/renames.fixtures.ts"

/**
 * The rename declaration reader reads every rename as D9 does: one reading of two sides that are not one name, or a
 * refusal.
 *
 * Budget: its suite's count before the conversion (unit/cli/renames-spelling: 300 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theRenameDeclarationReaderReadsEveryRenameAsD9DoesOneReadingOfTwoSidesThatAreNotOneNameOrARefusal =
	property.explore(renameSpace, {
		needs: {},
		situations: [
			"a parsed rename",
			"a parsed login rename",
			"a parsed handle rename",
			"a refused rename",
			"an ambiguous rename",
			"an unchanged rename",
			"an alike rename refused",
			"an alike handle rename refused"
		] satisfies ReadonlyArray<Reached<Spelled>>,
		check:
			(_, c: Case<Spelled>) =>
			([from, to]) =>
				Effect.sync(() => {
					const text = `${from}=${to}`
					const read = parseRename(text)
					const readings = readingsOf(text)
					const ruling = renameRuling(text)
					if (readings.length > 1) {
						c.note("an ambiguous rename")
					}
					if (ruling === undefined) {
						assert.ok(Result.isFailure(read), `D9 refuses ${Formatter.format(text)}`)
						const [only] = readings
						if (readings.length === 1 && only !== undefined && sameSide(only.from, only.to)) {
							c.note("an unchanged rename")
							if (!deepEquals(only.from, only.to)) {
								c.note("an alike rename refused")
								if (only.from.kind === "handle") {
									c.note("an alike handle rename refused")
								}
							}
						}
						c.note("a refused rename")
						return
					}
					assert.deepEqual(succeeded(read), ruling, `D9 reads ${Formatter.format(text)}`)
					c.note("a parsed rename")
					if (ruling.from.kind === "login") {
						c.note("a parsed login rename")
					}
					if (ruling.from.kind === "handle") {
						c.note("a parsed handle rename")
					}
				}),
		oracle: { kind: "specification", name: "D9's grammar, read as every split at an =" },
		budget: { runs: 300, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/renames.ts",
				original:
					'\t\t\treturn b.kind === "handle" && declaredAlike(a.roster, b.roster) && a.handle === b.handle',
				replacement:
					'\t\t\treturn b.kind === "handle" && a.roster === b.roster && a.handle === b.handle',
				why: "A handle rename's two sides are one name only when their rosters are spelled alike byte for byte."
			},
			{
				file: "packages/grizzle/src/cli/renames.ts",
				original:
					'\tconst [only, ...more] = splits\n\tif (more.length > 0) {\n\t\treturn refused({ kind: "ambiguous", given, readings: splits.length })',
				replacement:
					'\tconst [only, ...more] = splits\n\tif (more.length <= 0) {\n\t\treturn refused({ kind: "ambiguous", given, readings: splits.length })',
				why: "Operator mutant (comparison) at packages/grizzle/src/cli/renames.ts:225 in sidesOf: `>` becomes `<=`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * The rename declaration reader reads every drop as D9 reads a side, and a rename of one side as a refusal.
 *
 * Budget: its suite's count before the conversion (unit/cli/renames-drop: 200 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const theRenameDeclarationReaderReadsEveryDropAsD9ReadsASideAndARenameOfOneSideAsARefusal =
	property.explore(sideGen, {
		needs: {},
		situations: [
			"a parsed drop",
			"a parsed login drop",
			"a parsed handle drop",
			"a refused drop"
		] satisfies ReadonlyArray<Reached<Dropped>>,
		check: (_, c: Case<Dropped>) => (text) =>
			Effect.sync(() => {
				const side = sideOf(text)
				const read = parseDrop(text)
				if (side === undefined) {
					assert.ok(Result.isFailure(read), `D9 refuses ${Formatter.format(text)}`)
					c.note("a refused drop")
				} else {
					assert.deepEqual(succeeded(read), side)
					c.note("a parsed drop")
					if (side.kind === "login") {
						c.note("a parsed login drop")
					}
					if (side.kind === "handle") {
						c.note("a parsed handle drop")
					}
				}
				assert.equal(
					Result.isSuccess(parseRename(text)),
					renameRuling(text) !== undefined,
					"a rename of one side parses only where a handle holds its ="
				)
			}),
		oracle: { kind: "specification", name: "D9's grammar of a side" },
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/renames.ts",
				original:
					'\tif (Str.includes("\\u0000")(handle)) {\n\t\treturn "a handle holds no NUL, which ends a PostgreSQL name"\n\t}',
				replacement: "\t{}",
				why: 'Operator mutant (guard) at packages/grizzle/src/cli/renames.ts:127 in handleProblem: `if (Str.includes("\\u0000")(handle)) {\n\t\treturn "a handle holds no NUL, which end` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6).'
			}
		]
	})

/**
 * The rename declaration reader refuses a command line that renames or drops a name twice, or renames two to one.
 *
 * Budget: its suite's count before the conversion (unit/cli/renames-lists: 300 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const theRenameDeclarationReaderRefusesACommandLineThatRenamesOrDropsANameTwiceOrRenamesTwoToOne =
	property.explore(listingSpace, {
		needs: {},
		situations: ["parsed", "twice", "merged", "refused", "an alike repeat"] satisfies ReadonlyArray<
			Reached<Listed>
		>,
		check: (_, c: Case<Listed>) => (listing) =>
			Effect.sync(() => {
				const ruling = listRuling(listing)
				const read = parseDeclarations(listing.renames, listing.drops)
				c.noteAll(listingFeatures(listing))
				if (ruling === "refused") {
					assert.ok(
						Result.isFailure(read) &&
							read.failure.fault.kind !== "twice" &&
							read.failure.fault.kind !== "merged",
						"a declaration that does not parse refuses the command line"
					)
					return
				}
				if (ruling === "parsed") {
					assert.deepEqual(succeeded(read), {
						renames: Arr.map(listing.renames, (r) => succeeded(parseRename(r))),
						drops: Arr.map(listing.drops, (d) => succeeded(parseDrop(d)))
					})
					return
				}
				assert.equal(verdictOf(read), ruling)
			}),
		oracle: {
			kind: "specification",
			name: "D9: one declaration per old name and per new name, names alike being one"
		},
		budget: { runs: 300, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/renames.ts",
				original:
					'\tconst [only, ...more] = splits\n\tif (more.length > 0) {\n\t\treturn refused({ kind: "ambiguous", given, readings: splits.length })',
				replacement:
					'\tconst [only, ...more] = splits\n\tif (more.length <= 0) {\n\t\treturn refused({ kind: "ambiguous", given, readings: splits.length })',
				why: "Operator mutant (comparison) at packages/grizzle/src/cli/renames.ts:225 in sidesOf: `>` becomes `<=`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * The rename declaration reader resolves a handle rename's roster to the schema's alike one, and refuses one it lacks.
 *
 * Budget: its suite's count before the conversion (unit/cli/renames-rosters: 200 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theRenameDeclarationReaderResolvesAHandleRenamesRosterToTheSchemasAlikeOneAndRefusesOneItLacks =
	property.explore(rosterCaseGen, {
		needs: {},
		situations: ["resolved", "resolved alike", "two rosters", "unknown"] satisfies ReadonlyArray<
			Reached<Resolved>
		>,
		check: (_, c: Case<Resolved>) => (r) =>
			Effect.sync(() => {
				if (r.rosters.length > 1) {
					c.note("two rosters")
				}
				const declared = succeeded(
					parseDeclarations(
						Arr.map(r.renames, (to, at) => `Kind#h${at}=${to.roster}#${to.handle}`),
						[]
					)
				)
				const schema = Arr.map(r.rosters, (name) => parsedName(name))
				const resolved = rosterRenames(
					declared,
					Arr.map(schema, (closed) => Roster.of(closed, "ordered", ["n0"]))
				)
				const expected = new Map<DeclaredName, Map<string, string>>()
				for (const [at, to] of r.renames.entries()) {
					const roster = Arr.findFirst(schema, (closed) =>
						declaredAlike(closed, parsedName(to.roster))
					)
					if (Option.isNone(roster)) {
						assert.ok(
							Result.isFailure(resolved) &&
								resolved.failure.fault.kind === "unknownRoster" &&
								resolved.failure.fault.roster === to.roster,
							`${to.roster} is no roster of the schema`
						)
						c.note("unknown")
						return
					}
					if (roster.value !== to.roster) {
						c.note("resolved alike")
					}
					const handles = expected.get(roster.value) ?? new Map<string, string>()
					handles.set(`h${at}`, to.handle)
					expected.set(roster.value, handles)
				}
				assert.deepEqual(succeeded(resolved), expected)
				c.note("resolved")
			}),
		oracle: { kind: "specification", name: "declaredAlike rosters are one roster" },
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/renames.ts",
				original: "\treturn bytes > handleMaxBytes",
				replacement: "\treturn bytes <= handleMaxBytes",
				why: "Operator mutant (comparison) at packages/grizzle/src/cli/renames.ts:134 in handleProblem: `>` becomes `<=`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
