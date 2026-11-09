#!/usr/bin/env -S node
import { styleText } from "node:util"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
	Array as Arr,
	Console,
	Data,
	Effect,
	Layer,
	pipe,
	Record,
	Result,
	String as Str
} from "effect"
import { repoRoot } from "#bench/cold/identity.ts"
import {
	type ColdOptions,
	type ColdSeries,
	coldDefaults,
	coldQuick,
	recordFile,
	runColdBench
} from "#bench/cold/run.ts"
import { InitializedCluster } from "#test/support/cluster.ts"
import { sweep } from "#test/support/substrate/shared.ts"
import { dropRole, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The cold-start benchmark's entry point. Run with
 *
 *   node bench/cold/main.ts [--quick] [--samples N] [--database-samples N] [--warm N] [--out DIR]
 *
 * against the local cluster. It writes its record, with its full identity, to bench/results/cold/cold.json
 * (or DIR/cold.json) and prints a summary. The record is information; the exit status reports only whether the run
 * completed.
 */
/** A command line the benchmark cannot read, and why. */
class ColdUsage extends Data.TaggedError("ColdUsage")<{ readonly reason: string }> {}

const usage = (reason: string): Effect.Effect<never, ColdUsage> =>
	Effect.fail(new ColdUsage({ reason }))

/** The parsed command line: the options and the directory the record goes to. */
interface Cold {
	readonly options: ColdOptions
	readonly outDir: string
}

const count = (flag: string, value: string): Effect.Effect<number, ColdUsage> => {
	const n = Number(value)
	return Number.isInteger(n) && n >= 1
		? Effect.succeed(n)
		: usage(`${flag} needs a positive integer`)
}

/** The value after a flag, and the arguments after it. */
const valueOf = (
	flag: string,
	rest: ReadonlyArray<string>
): Effect.Effect<readonly [string, ReadonlyArray<string>], ColdUsage> =>
	Arr.match(rest, {
		onEmpty: () => usage(`${flag} needs a value`),
		onNonEmpty: ([value, ...after]) => Effect.succeed([value, after] as const)
	})

const parse = (args: ReadonlyArray<string>, cold: Cold): Effect.Effect<Cold, ColdUsage> =>
	Arr.match(args, {
		onEmpty: () => Effect.succeed(cold),
		onNonEmpty: ([flag, ...rest]) =>
			Effect.gen(function* () {
				switch (flag) {
					case "--quick":
						return yield* parse(rest, cold)
					case "--samples": {
						const [value, after] = yield* valueOf(flag, rest)
						const samples = yield* count(flag, value)
						return yield* parse(after, { ...cold, options: { ...cold.options, samples } })
					}
					case "--database-samples": {
						const [value, after] = yield* valueOf(flag, rest)
						const databaseSamples = yield* count(flag, value)
						return yield* parse(after, { ...cold, options: { ...cold.options, databaseSamples } })
					}
					case "--warm": {
						const [value, after] = yield* valueOf(flag, rest)
						const warmRepeats = yield* count(flag, value)
						return yield* parse(after, { ...cold, options: { ...cold.options, warmRepeats } })
					}
					case "--out": {
						const [outDir, after] = yield* valueOf(flag, rest)
						return yield* parse(after, { ...cold, outDir })
					}
					default:
						return yield* usage(`unknown argument ${flag}`)
				}
			})
	})

const line = (
	label: string,
	s: { readonly p50: number; readonly p95: number; readonly n: number }
): string =>
	`  ${Str.padEnd(40)(label)} p50 ${pipe(s.p50.toFixed(3), Str.padStart(10))} ms   p95 ${pipe(s.p95.toFixed(3), Str.padStart(10))} ms   (n=${s.n})`

const print = (title: string, series: ColdSeries): Effect.Effect<void> =>
	Console.info(
		Arr.join(
			[
				styleText("bold", title),
				line("process wall", series.processWallMs),
				...Arr.map(Record.toEntries(series.phases), ([phase, s]) => line(phase, s)),
				...Arr.flatMap(Record.toEntries(series.queries), ([query, measures]) =>
					Arr.filterMap(Record.toEntries(measures), ([measure, s]) =>
						Str.endsWith("Ms")(measure)
							? Result.succeed(line(`${query}.${measure}`, s))
							: Result.failVoid
					)
				)
			],
			"\n"
		)
	)

/**
 * Once the series has run, the sweep drops the database it ran in, which nothing drops while it runs
 * (test/support/pg.ts freshDatabase).
 */
const main = Effect.gen(function* () {
	const args = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	const { options, outDir } = yield* parse(args, {
		options: Arr.contains(args, "--quick") ? coldQuick : coldDefaults,
		outDir: `${repoRoot}/bench/results/cold`
	})
	/** The series runs in a database of its own, built in a scope that closes once the series has run. */
	const isolated = Effect.gen(function* () {
		const substrate = yield* Layer.build(Substrate.isolatedLayer)
		return yield* Effect.provide(runColdBench(options, outDir), substrate)
	})
	const record = yield* Effect.scoped(isolated).pipe(Effect.ensuring(Effect.orDie(sweep(dropRole))))
	const { source, server, pgPin, runtime } = record.identity
	yield* Console.info(
		`grizzle ${Str.slice(0, 12)(source.gitSha)}${source.gitDirty ? " (dirty)" : ""}, ` +
			`PostgreSQL ${server.serverVersion} (${pgPin.tag}), node ${runtime.node}`
	)
	yield* print("load (fresh process per sample)", record.load)
	yield* print("database (fresh process per sample)", record.database)
	yield* Console.info(`record: ${recordFile(outDir)}`)
})

const services = Layer.mergeAll(NodeServices.layer, InitializedCluster.layer)

NodeRuntime.runMain(main.pipe(Effect.provide(services)))
