import type { TextChunks } from "@bjornpagen/grizzle-text/chunks"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	type PlatformError,
	Result,
	String as Str
} from "effect"
import { matchesFile } from "#adapter/boundary/files.ts"
import { toResult } from "#adapter/engine.ts"
import type { ResolvedConfig } from "#cli/config.ts"
import { type CliError, ContractEntryRefused, cliError, MigrationsUnread } from "#cli/errors.ts"
import { visibleEntries, writeAtomically, writeText } from "#cli/files.ts"
import { contractFileOf, contractText, Engine } from "#compiler/plan/common.ts"
import { contractPath, contractsDirectory } from "#compiler/plan/serve.ts"

/**
 * The configuration's contracts' checker files (engine runtime/contract.ts ContractFile): each contract its `contracts`
 * lists compiled where the configuration names it (engine program/contract.ts contractFileOf), written as a served
 * artifact (served/json.ts contractText) to `<migrations>/contract-checks/<name>.json` (contractPath), which a running
 * application imports and @bjornpagen/grizzle/runtime's contractParser reads, loading no compiler. generate writes each
 * whose bytes differ and removes the file of a contract the configuration no longer lists; check holds each to its
 * compile byte for byte, as it holds a served file.
 */

/** A contract's checker file as generate writes it: the contract's declared name and the file's text. */
export interface ContractText {
	readonly contract: string
	readonly text: TextChunks
}

/**
 * Each listed contract's checker file, compiled, in configured order; refused at the first entry that does not compile,
 * or that names a contract another entry names, whose file it would share.
 */
export const contractTexts = (
	config: ResolvedConfig
): Result.Result<ReadonlyArray<ContractText>, CliError> => {
	const out: Array<ContractText> = []
	for (const [index, contract] of config.contracts.entries()) {
		const compiled = toResult(
			Engine.flatMap(contractFileOf(contract), (file) =>
				Engine.map(contractText(file), (text) => ({ contract: file.contract, text }))
			)
		)
		if (Result.isFailure(compiled)) {
			return Result.fail(
				cliError(
					new ContractEntryRefused({
						index,
						fault: { kind: "uncompiled", error: compiled.failure }
					})
				)
			)
		}
		const other = Arr.findFirstIndex(out, (c) => c.contract === compiled.success.contract)
		if (Option.isSome(other)) {
			return Result.fail(
				cliError(
					new ContractEntryRefused({
						index,
						fault: { kind: "shared", name: compiled.success.contract, other: other.value }
					})
				)
			)
		}
		out.push(compiled.success)
	}
	return Result.succeed(out)
}

/** The checker files the contracts directory holds, by contract: each visible entry `<name>.json`, its path. */
const committedContracts = Effect.fn("committedContracts")(function* (
	config: ResolvedConfig
): Effect.fn.Return<
	ReadonlyMap<string, string>,
	PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = path.join(config.migrations, contractsDirectory)
	if (!(yield* fs.exists(directory))) {
		return new Map()
	}
	const entries = yield* visibleEntries(fs, directory)
	return new Map(
		Arr.map(entries, (entry) => [
			Str.endsWith(".json")(entry) ? Str.slice(0, -".json".length)(entry) : entry,
			path.join(directory, entry)
		])
	)
})

/**
 * Brings the contracts directory to `texts`: each file whose bytes differ from its text written by rename, the directory
 * made first when it writes one, then each file of a contract `texts` does not hold removed; returns the paths written
 * and removed.
 */
export const writeContracts = Effect.fn("writeContracts")(
	function* (
		config: ResolvedConfig,
		texts: ReadonlyArray<ContractText>
	): Effect.fn.Return<
		{ readonly written: ReadonlyArray<string>; readonly removed: ReadonlyArray<string> },
		PlatformError.PlatformError,
		FileSystem.FileSystem | Path.Path
	> {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const committed = yield* committedContracts(config)
		if (texts.length > 0) {
			yield* fs.makeDirectory(path.join(config.migrations, contractsDirectory), { recursive: true })
		}
		const written: Array<string> = []
		for (const { contract, text } of texts) {
			const target = path.join(config.migrations, contractPath(contract))
			const held = committed.get(contract)
			const same =
				held !== undefined && (yield* matchesFile(held, text)).kind === "same" && held === target
			if (!same) {
				const file = yield* writeAtomically(
					path.join(config.migrations, contractsDirectory),
					`${contract}.json`,
					(scratch) => writeText(scratch, text)
				)
				written.push(file)
			}
		}
		const listed = new Set(Arr.map(texts, (t) => t.contract))
		const removed: Array<string> = []
		for (const contract of Arr.sort(Arr.fromIterable(committed.keys()), Order.String)) {
			const file = committed.get(contract)
			if (file !== undefined && !listed.has(contract)) {
				yield* fs.remove(file, { recursive: true })
				removed.push(file)
			}
		}
		return { written, removed }
	},
	(effect, config) =>
		Effect.mapError(effect, (cause) =>
			cliError(new MigrationsUnread({ directory: config.migrations, cause }))
		)
)

/** What a contract's checker file is found to be, against its compile: missing, stale, or of no listed contract. */
export type ContractFinding =
	| { readonly kind: "contractMissing"; readonly contract: string; readonly where: string }
	| { readonly kind: "contractStale"; readonly contract: string; readonly where: string }
	| { readonly kind: "contractExtra"; readonly where: string }

/**
 * The findings of the committed checker files against `texts`, each where it lies relative to `cwd`: a listed contract
 * with no file, a file whose bytes part from its compile, each read a block at a time and held to the text as it is read
 * (adapter/boundary/files.ts matchesFile), and an entry of no listed contract.
 */
export const contractFindings = Effect.fn("contractFindings")(
	function* (
		config: ResolvedConfig,
		texts: ReadonlyArray<ContractText>,
		cwd: string
	): Effect.fn.Return<
		ReadonlyArray<ContractFinding>,
		PlatformError.PlatformError,
		FileSystem.FileSystem | Path.Path
	> {
		const path = yield* Path.Path
		const committed = yield* committedContracts(config)
		const where = (file: string) => path.relative(cwd, file)
		const found: Array<ContractFinding> = []
		for (const { contract, text } of texts) {
			const target = path.join(config.migrations, contractPath(contract))
			const held = committed.get(contract)
			if (held === undefined || held !== target) {
				found.push({ kind: "contractMissing", contract, where: where(target) })
			} else if ((yield* matchesFile(held, text)).kind !== "same") {
				found.push({ kind: "contractStale", contract, where: where(held) })
			}
		}
		const listed = new Set(Arr.map(texts, (t) => t.contract))
		for (const [contract, file] of committed) {
			if (!listed.has(contract) || file !== path.join(config.migrations, contractPath(contract))) {
				found.push({ kind: "contractExtra", where: where(file) })
			}
		}
		return found
	},
	(effect, config) =>
		Effect.mapError(effect, (cause) =>
			cliError(new MigrationsUnread({ directory: config.migrations, cause }))
		)
)

/** A contract finding's line, as check prints it: where, what, and the fix. */
export const contractFindingText = (finding: ContractFinding): string => {
	switch (finding.kind) {
		case "contractMissing":
			return `${finding.where}: the contract ${finding.contract} has no checker file (an ungenerated change); run grizzle generate, which writes it`
		case "contractStale":
			return `${finding.where}: the contract ${finding.contract}'s checker file differs from what the contract compiles to (an ungenerated change); run grizzle generate, which writes it again`
		case "contractExtra":
			return `${finding.where}: the checker file is of a contract the configuration's contracts does not list; run grizzle generate, which removes it`
	}
}
