/**
 * A closed relation's constants through the command line, over drawn grids: `grizzle generate` drafts each constant as
 * its one hex literal, the installation's own, and `grizzle check` holds every literal to its content
 * (physical/ddl/literal.ts literalPackFault).
 *
 * - **A drafted folder passes:** check finds nothing in what generate drafted.
 * - **A changed digit is one finding at its file, by its fault:** one hex digit of either constant, its cells' or its
 *   key set's, changed to another is check's one finding, a literal pack at the file that holds it, at the statement
 *   that states it, counted from 1, with its fault (cli/check.ts CheckFinding): the content the oracle reads off the
 *   two literals, the closed relation, the first cell where the literal parts from the declared rows and that cell's
 *   key, or, where the change sets a bit past the last cell, a layout fault at that padding bit.
 *
 * The grid: Row (3 codes) by Col (2), row-major, each cell holding no row or a row of a Mark (3 codes), so its cells
 * take 2 bits, 12 in all, three whole digits, and its key set 6 bits, padded with 2 to two digits.
 *
 * Oracle: a second implementation of the fault, the grid's cells row-major read off the test oracle's bits of each
 * literal (test/support/closed/bit-text.ts), sharing no code with the engine's decoder.
 *
 * Features: either constant changed; a cell changed or a padding bit set.
 */

import { headNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, FileSystem, Option, Order, String as Str } from "effect"
import { check } from "#cli/check.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { metaFileName } from "#compiler/deploy/render/folder.ts"
import { splitStatements } from "#compiler/deploy/render/markers.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import type { PackConstant } from "#compiler/sql/ast.ts"
import { printObjectName, printStatement } from "#compiler/sql/print.ts"
import { defineConfig } from "#index.ts"
import {
	cliOver,
	configName,
	offlineOwner,
	resolvedConfig,
	workspace
} from "#test/pg/cli/support.ts"
import { succeeded } from "#test/support/assert.ts"
import { migrationFolders } from "#test/support/migrate/kit.ts"
import { owning } from "#test/support/policy.ts"
import {
	changedDigit,
	type Constant,
	type Drawn,
	faultOf,
	type Feature,
	foundOf,
	grids,
	now,
	schemaOf
} from "#test/unit/cli/literal-pack.fixtures.ts"

/**
 * Grizzle check over a closed relation's hex literals passes a drafted literal, and refuses any changed digit at its
 * file and statement, naming what it changes.
 *
 * Budget: its suite's count before the conversion (unit/cli/literal-pack: 2 independent cases and 12 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const grizzleCheckOverAClosedRelationsHexLiteralsPassesADraftedLiteralAndRefusesAnyChangedDigitAtItsFileAndStatementNamingWhatItChanges =
	property.explore(grids, {
		needs: {},
		situations: [
			"the cells' literal changed",
			"the key set's literal changed",
			"a cell changed",
			"a padding bit set"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (d: Drawn) =>
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const gridSchema = schemaOf(d)
					const config = defineConfig({
						schemas: [gridSchema],
						logins: [],
						migrations: "migrations",
						rolePrefixBytes: 0,
						connection: () => offlineOwner
					})
					const owned = owning(gridSchema)
					const installation = succeeded(compileInstallation(owned, installOptions(owned)))
					const grid = installation.names.closed("Grid")
					const packOf = (name: string): PackConstant =>
						defined(
							Arr.flatMap(installation.statements, (s) =>
								s.kind === "packConstant" && s.function.name === name ? [s] : []
							)[0],
							`the pack of ${name}`
						)
					const packs: Readonly<Record<Constant, PackConstant>> = {
						cells: packOf(grid.function.name),
						keys: packOf(grid.keys.name)
					}
					const ws = yield* workspace("literal-pack")
					const drafted = yield* cliOver(
						ws,
						config,
						["generate", configName, "--name", "init"],
						now(0)
					)
					assert.equal(drafted.code, 0, drafted.stderr)
					const schemaDir = `migrations/${headNonEmpty(owned.levels).installation.identifier}`
					const entries = yield* fs.readDirectory(`${ws}/${schemaDir}`)
					const folder = `${schemaDir}/${defined(
						migrationFolders(entries)[0],
						"the drafted folder"
					)}`
					const named = yield* fs.readDirectory(`${ws}/${folder}`)
					const files = Arr.sort(
						Arr.filter(named, (n) => n !== metaFileName),
						Order.String
					)
					const texts = yield* Effect.forEach(files, (name) =>
						Effect.map(fs.readFileString(`${ws}/${folder}/${name}`), (text) => ({
							name,
							text
						}))
					)
					const read = yield* resolvedConfig(config, `${ws}/${configName}`)
					const resolved = succeeded(read)
					const findings = Effect.map(Effect.orDie(check(resolved, ws, silentPhases)), (checks) =>
						Arr.flatMap(checks, (x) => Arr.map(x.findings, foundOf))
					)
					const held = yield* cliOver(ws, config, ["check", configName], now(1))
					assert.equal(held.code, 0, held.stderr)
					const drafts = yield* findings
					assert.deepEqual(drafts, [], "the drafted folder holds every literal")
					for (const constant of ["cells", "keys"] as const) {
						const p = packs[constant]
						const literalText = printStatement(p)
						const file = defined(
							Option.getOrUndefined(Arr.findFirst(texts, (t) => Str.includes(literalText)(t.text))),
							`the file generate drafted the ${constant} literal into`
						)
						const statement =
							defined(
								Option.getOrUndefined(
									Arr.findFirstIndex(splitStatements(file.text), (s) =>
										Str.includes(`X'${p.hex}'`)(s)
									)
								),
								"the literal is one of the file's statements"
							) + 1
						const change = d.changes[constant]
						const after = changedDigit(p.hex, change.digit, change.offset)
						const path = `${ws}/${folder}/${file.name}`
						const tamper = Str.replace(`X'${p.hex}'`, `X'${after}'`)
						yield* fs.writeFileString(path, tamper(file.text))
						const tampered = yield* cliOver(ws, config, ["check", configName], now(2))
						const found = yield* findings
						yield* fs.writeFileString(path, file.text)
						assert.equal(tampered.code, 1, `X'${after}' for X'${p.hex}' is refused`)
						const fault = faultOf(
							printObjectName(p.function),
							p.hex,
							after,
							Number(p.cells),
							p.width
						)
						assert.deepEqual(found, [
							{ kind: "literalPack", where: `${folder}/${file.name}`, statement, fault }
						])
						c.note(
							constant === "cells" ? "the cells' literal changed" : "the key set's literal changed"
						)
						c.note(fault.kind === "layout" ? "a padding bit set" : "a cell changed")
					}
				})
			),
		oracle: {
			kind: "second-implementation",
			name: "the grid's cells row-major, read off the oracle's bits of each literal"
		},
		budget: { runs: 2, steered: 12 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/check.ts",
				original: "\t\t\t\t\tpacks.push({ where, statement, ordinal: i + 1 })",
				replacement: "\t\t\t\t\tpacks.push({ where, statement, ordinal: i })",
				why: "A finding counts its file's statements from 0."
			},
			{
				file: "packages/engine/src/physical/ddl/literal.ts",
				original: "\t\t\treturn x.index < y.index ? x.index : y.index",
				replacement: "\t\t\treturn x.index < y.index ? y.index : x.index",
				why: "Where two literals hold different cells first, the later is named."
			},
			{
				file: "packages/grizzle/src/cli/check.ts",
				original: "\t\treturn fault === undefined",
				replacement: '\t\treturn fault?.kind !== "form"',
				why: "check finds only a literal pack off its printed form."
			}
		]
	})
