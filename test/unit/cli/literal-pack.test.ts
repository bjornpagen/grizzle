/**
 * A closed relation's constant through the command line, over drawn grids: `grizzle generate` drafts the constant as its
 * two arrays, its cells and its payloads, each one literal, the installation's own, and `grizzle check` holds every
 * literal to its content (physical/ddl/literal.ts literalPackFault).
 *
 * - **A drafted folder passes:** check finds nothing in what generate drafted.
 * - **An edit is one finding at its file, by its fault:** an edit of either literal (an element one up or down, dropped,
 *   written twice or with a leading 0, an element added past the last, the cells' sentinel dropped) is check's one
 *   finding, a literal pack at the file that holds it, at the statement that states it, counted from 1, with its fault
 *   (cli/check.ts CheckFinding): the layout fault the oracle reads where the edit breaks the literal's spelling, order or
 *   range, and otherwise the content, the closed relation, the first cell where the literal parts from the declared
 *   rows and that cell's key, a payloads literal's the cell its cells hold at the place it changes.
 *
 * The grid: Row (3 codes) by Col (2), row-major, each cell holding no row or a row of a Mark (3 codes), so its cells are
 * its held indexes, 0 to 5, and its payloads their marks.
 *
 * Oracle: a second implementation of the fault, the grid's literal read element by element by the oracle
 * (unit/physical/literal.fixtures.ts oracleRead), sharing no code with the engine's decoder.
 *
 * Features: either array edited; an edit out of order or range, and one of another constant.
 */

import { headNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, FileSystem, Option, Order, String as Str } from "effect"
import { check } from "#cli/check.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { metaFileName } from "#compiler/deploy/render/folder.ts"
import { splitStatements } from "#compiler/deploy/render/markers.ts"
import { cellsOfLiteral } from "#compiler/ir/cells.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import type { PackConstant } from "#compiler/sql/ast.ts"
import { printObjectName, printStatement } from "#compiler/sql/print.ts"
import { defineConfig } from "#index.ts"
import { succeeded } from "#test/support/assert.ts"
import { migrationFolders } from "#test/support/migrate/kit.ts"
import {
	cliOver,
	configName,
	offlineOwner,
	resolvedConfig,
	workspace
} from "#test/support/pg/cli/support.ts"
import { owning } from "#test/support/policy.ts"
import {
	type Drawn,
	editOf,
	faultOf,
	type GridArray,
	type Feature,
	foundOf,
	grids,
	gridSchemaOf
} from "#test/unit/cli/literal-pack.fixtures.ts"

/**
 * Grizzle check over a closed relation's literal passes a drafted literal, and refuses any edit at its file and
 * statement, naming what it changes.
 *
 * Budget: its suite's count before the conversion (unit/cli/literal-pack: 2 independent cases and 12 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const grizzleCheckOverAClosedRelationsLiteralPassesADraftedLiteralAndRefusesAnyEditAtItsFileAndStatementNamingWhatItChanges =
	property.explore(grids, {
		needs: {},
		situations: [
			"the cells' literal edited",
			"the payloads' literal edited",
			"an edit out of order or range",
			"an edit of another constant"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (d: Drawn) =>
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const gridSchema = gridSchemaOf(d)
					const config = defineConfig({
						contracts: [],
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
					if (grid.constant.payloads.kind !== "codes") {
						return assert.fail("a grid of three marks installs its payloads")
					}
					const packs: Readonly<Record<GridArray, PackConstant>> = {
						cells: packOf(grid.constant.cells.name),
						payloads: packOf(grid.constant.payloads.function.name)
					}
					const cells = succeeded(cellsOfLiteral(packs.cells.text, 6n))
					const ws = yield* workspace("literal-pack")
					const drafted = yield* cliOver(ws, config, ["generate", configName, "--name", "init"])
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
					const held = yield* cliOver(ws, config, ["check", configName])
					assert.equal(held.code, 0, held.stderr)
					const drafts = yield* findings
					assert.deepEqual(drafts, [], "the drafted folder holds every literal")
					for (const array of ["cells", "payloads"] as const) {
						const p = packs[array]
						const literalText = printStatement(p)
						const file = defined(
							Option.getOrUndefined(Arr.findFirst(texts, (t) => Str.includes(literalText)(t.text))),
							`the file generate drafted the ${array}' literal into`
						)
						const statement =
							defined(
								Option.getOrUndefined(
									Arr.findFirstIndex(splitStatements(file.text), (s) =>
										Str.includes(`'${p.text}'::`)(s)
									)
								),
								"the literal is one of the file's statements"
							) + 1
						const edit = editOf(d, array, p.text, p.layout)
						const path = `${ws}/${folder}/${file.name}`
						const tamper = Str.replace(`'${p.text}'::`, `'${edit.text}'::`)
						yield* fs.writeFileString(path, tamper(file.text))
						const tampered = yield* cliOver(ws, config, ["check", configName])
						const found = yield* findings
						yield* fs.writeFileString(path, file.text)
						assert.equal(tampered.code, 1, `${edit.what}, ${edit.text} for ${p.text}, is refused`)
						const fault = faultOf(printObjectName(p.function), p.layout, p.text, edit.text, cells)
						assert.deepEqual(found, [
							{ kind: "literalPack", where: `${folder}/${file.name}`, statement, fault }
						])
						c.note(array === "cells" ? "the cells' literal edited" : "the payloads' literal edited")
						c.note(
							fault.kind === "layout"
								? "an edit out of order or range"
								: "an edit of another constant"
						)
					}
				})
			),
		oracle: {
			kind: "second-implementation",
			name: "the grid's cells row-major, read off the oracle's reading of each literal"
		},
		budget: { runs: 2, steered: 12 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/cli/literal-pack.test.ts#grizzleCheckOverAClosedRelationsLiteralPassesADraftedLiteralAndRefusesAnyEditAtItsFileAndStatementNamingWhatItChanges:-:0.2.1.2.2.2.0.8y"
				),
				reason:
					"rotating seed 0x5046cf55, case 0, shrunk: the payloads' last entry written twice, a payload past every cell, which pairs with none",
				since: "2026-11-24"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/literal.ts",
				original:
					"\treturn position === undefined || indexes === undefined ? undefined : indexes[position]\n",
				replacement:
					"\treturn position === undefined || indexes === undefined\n\t\t? undefined\n\t\t: indexes[Math.min(position, indexes.length - 1)]\n",
				why: "A payload past every cell read as the last cell's (physical/ddl/literal.ts cellApart): the finding names a cell the edit left alone."
			},
			{
				file: "packages/grizzle/src/cli/check.ts",
				original: "\t\t\t\t\tpacks.push({ where, statement, ordinal: i + 1 })",
				replacement: "\t\t\t\t\tpacks.push({ where, statement, ordinal: i })",
				why: "A finding counts its file's statements from 0."
			},
			{
				file: "packages/grizzle/src/cli/check.ts",
				original: "\t\treturn fault === undefined",
				replacement: '\t\treturn fault?.kind !== "form"',
				why: "check finds only a literal pack off its printed form."
			}
		]
	})
