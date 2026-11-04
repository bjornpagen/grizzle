#!/usr/bin/env -S node
import { availableParallelism, loadavg } from "node:os"
import { styleText } from "node:util"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Array as Arr, Console, Effect, FileSystem, Layer, Option, String as Str } from "effect"
import { repoRoot } from "#bench/cold/identity.ts"
import { type BenchCommand, parseBenchArgs, runSuite } from "#bench/harness/cli.ts"
import {
	firstLine,
	type GateOutcome,
	type GateRecord,
	gateOutcomes,
	verdictReason
} from "#bench/harness/gate.ts"
import { gateListing, listedStatuses, renderGateListing } from "#bench/harness/listing.ts"
import { gateCatalog } from "#bench/harness/rules.ts"
import {
	defaultGateDirectories,
	discoverGates,
	type GateSummary,
	readRecords,
	runGates,
	summarizeRecords,
	writeSummary
} from "#bench/harness/runner.ts"
import { InitializedCluster } from "#test/support/cluster.ts"
import { sweep } from "#test/support/substrate/shared.ts"
import { dropRole } from "#test/support/substrate/substrate.ts"

/**
 * The benchmark harness entry point, `pnpm bench`. Not part of `pnpm check`: benchmarks run separately, and each record
 * names this machine, a virtual machine whose timings are treated as noisy. The command line is bench/harness/cli.ts's;
 * a command line it cannot read exits with status 2, a run that found a failure or could not complete with 1.
 */
const colors: Readonly<Record<GateOutcome, Parameters<typeof styleText>[0]>> = {
	pass: "green",
	fail: "red",
	error: "red",
	missing: "gray"
}

const shown = (path: string): string =>
	Str.startsWith(`${repoRoot}/`)(path) ? Str.slice(repoRoot.length + 1)(path) : path

const printRecord = (record: GateRecord, path: string): Effect.Effect<void> => {
	switch (record.kind) {
		case "failed":
			return Console.info(
				`${styleText("bold", record.name)} (${record.file}): ${styleText("red", "failed")}: ${firstLine(record.cause)} -> ${shown(path)}`
			)
		case "ran": {
			const source = record.identity.source
			return Effect.andThen(
				Console.info(
					`${styleText("bold", record.name)} (${record.file}): ${record.cases.length} cases in ${record.runPhases.runMs} ms, ` +
						`grizzle ${Str.slice(0, 12)(source.gitSha)}${source.gitDirty ? " (dirty)" : ""} -> ${shown(path)}`
				),
				Effect.forEach(
					record.verdicts,
					(v) =>
						Console.info(
							`  ${Str.padEnd(18)(v.gate)}${styleText(colors[v.outcome], Str.padEnd(12)(v.outcome))}${v.outcome === "pass" ? "" : firstLine(verdictReason(v))}`
						),
					{ discard: true }
				)
			)
		}
	}
}

const printSummary = (summary: GateSummary): Effect.Effect<void> =>
	Console.info(
		Arr.join(
			Arr.map(
				Arr.filter(gateOutcomes, (o) => summary.outcomes[o] > 0),
				(o) => styleText(colors[o], `${summary.outcomes[o]} ${o}`)
			),
			", "
		)
	)

/**
 * Whether a run found what fails it: a run that failed, a release that leaked, or a verdict that is `fail` or `error`.
 */
const failedRecord = (record: GateRecord): boolean =>
	record.kind === "failed" ||
	record.release.kind === "leaked" ||
	Arr.some(record.verdicts, (v) => v.outcome === "fail" || v.outcome === "error")

const failed = (summary: GateSummary, records: ReadonlyArray<GateRecord>): boolean =>
	Arr.some(records, failedRecord) ||
	(records.length === 0 &&
		Arr.some(summary.gates, (g) => g.outcome === "fail" || g.outcome === "error"))

type GatesCommand = Extract<BenchCommand, { readonly kind: "gates" }>

/**
 * The gates the command selects, run and recorded, or with --report the summary rebuilt from the records on disk; its
 * status. Once no gate runs, the sweep drops the databases they ran in, which nothing drops while one runs
 * (test/support/pg.ts freshDatabase).
 */
/** The sweep, with the initialised cluster read for it as its layer builds. */
const sweepCluster = Effect.scoped(
	Effect.flatMap(Layer.build(InitializedCluster.layer), (context) =>
		Effect.provideContext(sweep(dropRole), context)
	)
)

const gates = Effect.fn("gates")(function* (command: GatesCommand) {
	if (command.report) {
		const records = yield* readRecords(command.outDir)
		const summary = summarizeRecords(records)
		yield* writeSummary(command.outDir, summary)
		yield* printSummary(summary)
		return failed(summary, []) ? 1 : 0
	}
	const run = yield* runGates({
		quick: command.quick,
		outDir: command.outDir,
		directories: command.directories,
		only: command.only,
		onRecord: printRecord
	}).pipe(Effect.ensuring(Effect.orDie(sweepCluster)))
	yield* printSummary(run.summary)
	return failed(run.summary, run.records) ? 1 : 0
})

const allGates = (quick: boolean): GatesCommand => ({
	kind: "gates",
	quick,
	only: [],
	directories: defaultGateDirectories,
	outDir: `${repoRoot}/bench/results`,
	report: false
})

/**
 * The full-scale run of every gate, then the gate listing, bench/results/GATES.md, from every record on disk. The
 * machine's load average is printed first: full-scale timings are information only on a quiet machine.
 */
const full = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const load = Option.match(Arr.head(loadavg()), {
		onNone: () => "no load average",
		onSome: (average) => `load average ${average.toFixed(2)}`
	})
	yield* Console.info(`${load} over ${availableParallelism()} cores; run on a quiet machine`)
	const command = allGates(false)
	const status = yield* gates(command)
	const discovered = yield* discoverGates(defaultGateDirectories)
	const records = yield* readRecords(command.outDir)
	const listing = gateListing(
		Arr.map(discovered, (d) => ({ file: d.file, gates: d.gate.gates })),
		records
	)
	const markdown = `${command.outDir}/GATES.md`
	yield* fs.makeDirectory(command.outDir, { recursive: true })
	yield* fs.writeFileString(markdown, renderGateListing(listing))
	yield* Console.info(
		`${Arr.join(
			Arr.map(listedStatuses, (s) => `${s}: ${Arr.filter(listing, (g) => g.status === s).length}`),
			", "
		)} -> ${shown(markdown)}`
	)
	return status
})

const list = Effect.fn("list")(function* (
	command: Extract<BenchCommand, { readonly kind: "list" }>
) {
	const discovered = yield* discoverGates(command.directories)
	yield* Effect.forEach(
		gateCatalog,
		(entry) => {
			const files = Arr.map(
				Arr.filter(discovered, (d) => Arr.contains(d.gate.gates, entry.id)),
				(d) => d.file
			)
			const where =
				files.length === 0 ? styleText("gray", "  (no bench file)") : `  ${Arr.join(files, ", ")}`
			return Console.info(
				`${Str.padEnd(18)(entry.id)}${Str.padEnd(7)(entry.owner)}${entry.title}${where}`
			)
		},
		{ discard: true }
	)
	return 0
})

/** Gates, then the cold-start benchmark, each to completion; the worse status. */
const all = Effect.fn("all")(function* (quick: boolean) {
	const status = yield* gates(allGates(quick))
	yield* Console.info(styleText("bold", "bench/cold"))
	const cold = yield* runSuite("cold", quick ? ["--quick"] : [])
	return Math.max(status, cold)
})

const run = (command: BenchCommand) => {
	switch (command.kind) {
		case "gates":
			return gates(command)
		case "list":
			return list(command)
		case "full":
			return full
		case "suite":
			return runSuite(command.suite, command.args)
		case "all":
			return all(command.quick)
	}
}

const setStatus = (status: number): Effect.Effect<void> =>
	Effect.sync(() => {
		process.exitCode = status
	})

const main = Effect.gen(function* () {
	const args = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	const command = yield* parseBenchArgs(args)
	yield* Effect.flatMap(run(command), setStatus)
}).pipe(
	Effect.catchTag("UsageError", (e) => Effect.andThen(Console.error(e.reason), setStatus(2))),
	Effect.catch((e) => Effect.andThen(Console.error(e), setStatus(1)))
)

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)))
