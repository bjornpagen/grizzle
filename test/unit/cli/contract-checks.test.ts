/**
 * A configuration's contracts' checker files (cli/contracts.ts): generate compiles each contract its `contracts` lists
 * into `<migrations>/contract-checks/<name>.json`, writes the file whose bytes differ and removes the file of a contract
 * it no longer lists, and check holds each to its compile byte for byte, finding a listed contract with no file, a file
 * that parts from its compile and a file of no listed contract. The file generate wrote is the one a running
 * application imports: its JSON value is the runtime's checker, over which @bjornpagen/grizzle/runtime's contractParser
 * mints a value the contract holds and refuses one it does not, with no compiler loaded.
 *
 * Each case starts the migrations directory in one state: holding no checker file, the current one, one whose bytes were
 * edited, or the current one beside the file of a contract the configuration does not list. Oracle: specification, the
 * findings each state is owed, none once generate has run, and the contract's own verdict of a value inside it and one
 * outside it through the file generate wrote.
 *
 * Features: the state each case starts the directory in.
 */

import { readJson } from "@bjornpagen/grizzle-text/chunks"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, FileSystem, Path, Result } from "effect"
import { contractParser } from "#adapter/public/contract.ts"
import { resolveConfig } from "#cli/config.ts"
import { contractFindings, contractTexts, writeContracts } from "#cli/contracts.ts"
import { contract, defineConfig, Num, pg, relation, schema } from "#index.ts"
import { offlineOwner } from "#test/support/pg/cli/support.ts"

type State = "no file" | "the current file" | "an edited file" | "a file of no listed contract"

const states = [
	"no file",
	"the current file",
	"an edited file",
	"a file of no listed contract"
] as const satisfies ReadonlyArray<State>

const sittingKeyKey = Symbol("SittingKey")

/** qti-pie's sitting key: any nonnegative int8, the contract a running application parses a sitting's stage by. */
const SittingKey = contract<typeof sittingKeyKey>()("SittingKey", pg.bigint, (k) =>
	Num.within(k, 0n, 2n ** 63n - 1n)
)

/** The schema the configuration installs beside its contracts: one relation of a sitting key. */
const Sittings = schema("Sittings", [relation("Sitting", { stage: SittingKey }, ["stage"])], [])

/** The findings, by kind, the directory's state is owed before generate runs. */
const owed: Readonly<
	Record<State, ReadonlyArray<"contractMissing" | "contractStale" | "contractExtra">>
> = {
	"no file": ["contractMissing"],
	"the current file": [],
	"an edited file": ["contractStale"],
	"a file of no listed contract": ["contractExtra"]
}

/**
 * Generate writes each listed contract's checker file and removes any other, check finds exactly what each state of the
 * directory owes, and the file generate wrote is the runtime's checker of the contract.
 */
export const generateWritesEachContractsCheckerFileAndCheckHoldsItToItsCompile = property.exhaust(
	finite((source): State => source.draw(element(states))),
	{
		box: "the four states the contracts directory starts in: no file, the current one, an edited one, the current one beside a file of no listed contract",
		needs: {},
		situations: states satisfies ReadonlyArray<Reached<State>>,
		check: (_, c: Case<State>) => (state) =>
			Effect.scoped(
				Effect.gen(function* () {
					c.note(state)
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const directory = yield* fs.makeTempDirectoryScoped({
						prefix: "grizzle-contract-checks-"
					})
					const config = yield* resolveConfig(
						defineConfig({
							schemas: [Sittings],
							logins: [],
							contracts: [SittingKey],
							migrations: "migrations",
							rolePrefixBytes: 0,
							connection: () => offlineOwner
						}),
						path.join(directory, "grizzle.config.ts")
					)
					const texts = yield* Effect.fromResult(contractTexts(config))
					const file = path.join(config.migrations, "contract-checks", "SittingKey.json")
					if (state !== "no file") {
						yield* writeContracts(config, texts)
					}
					if (state === "an edited file") {
						const text = yield* fs.readFileString(file)
						yield* fs.writeFileString(file, `${text} `)
					}
					if (state === "a file of no listed contract") {
						yield* fs.writeFileString(
							path.join(config.migrations, "contract-checks", "Other.json"),
							"{}"
						)
					}
					const before = yield* contractFindings(config, texts, directory)
					assert.deepEqual(
						Arr.map(before, (f) => f.kind),
						[...owed[state]],
						`check's findings of ${state}`
					)
					yield* writeContracts(config, texts)
					const after = yield* contractFindings(config, texts, directory)
					assert.deepEqual(
						Arr.map(after, (f) => f.kind),
						[],
						"no finding once generate has run"
					)
					const left = yield* fs.readDirectory(path.join(config.migrations, "contract-checks"))
					assert.deepEqual(
						left,
						["SittingKey.json"],
						"generate leaves the listed contract's file alone"
					)
					const written = yield* fs.readFileString(file)
					const json = readJson([written])
					assert.ok(json.ok, "the checker file is JSON")
					const parser = contractParser(json.value, SittingKey, sittingKeyKey)
					assert.ok(
						Result.isSuccess(parser.parse(5n)),
						"a sitting key inside the contract is minted"
					)
					const outside = parser.parse(-1n)
					assert.ok(
						Result.isFailure(outside) && outside.failure._tag === "DomainRefused",
						"a sitting key outside the contract is refused by its domain"
					)
				})
			),
		oracle: {
			kind: "specification",
			name: "the findings each state of the directory owes, none after generate, and the contract's verdict through its file"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/contracts.ts",
				original: '\t\t\t} else if ((yield* matchesFile(held, text)).kind !== "same") {\n',
				replacement: "\t\t\t} else if (false) {\n",
				why: "check holds a committed checker file to nothing: an edited file, which a parser would read another check from, is no finding."
			},
			{
				file: "packages/grizzle/src/cli/contracts.ts",
				original: "\t\t\tif (file !== undefined && !listed.has(contract)) {\n",
				replacement: "\t\t\tif (false) {\n",
				why: "generate leaves the file of a contract the configuration no longer lists, which check then finds as extra after generate has run."
			}
		]
	}
)
