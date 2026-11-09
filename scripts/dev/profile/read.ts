#!/usr/bin/env -S node
import { parseArgs } from "node:util"
import { DevtoolFailure, failureFrom } from "@grizzle/devtools/devtool"
import { runDevtool } from "@grizzle/devtools/run"
import { regex } from "arkregex"
import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Option,
	Order,
	pipe,
	Result,
	String as Str
} from "effect"
import { trustedJson } from "#compiler/core/trusted.ts"

interface CallFrame {
	readonly functionName: string
	readonly url: string
	readonly lineNumber: number
}

/** A node of the profile's call tree; V8 leaves out the children of a leaf. */
interface ProfileNode {
	readonly id: number
	readonly callFrame: CallFrame
	readonly children?: ReadonlyArray<number>
}

/** A V8 .cpuprofile, as node --cpu-prof writes it. */
interface Profile {
	readonly nodes: ReadonlyArray<ProfileNode>
	readonly samples: ReadonlyArray<number>
	readonly timeDeltas: ReadonlyArray<number>
}

/** The command line, parsed once. */
interface Settings {
	readonly path: string
	readonly top: number
	readonly filter: Option.Option<string>
	/** Restricts every table to the samples whose stack holds a function matching this substring. */
	readonly under: Option.Option<string>
	/** Prints the inclusive time of the direct callees of the functions matching this substring. */
	readonly callees: Option.Option<string>
}

const parseSettings = Effect.fn("parseSettings")(function* (args: ReadonlyArray<string>) {
	const { values, positionals } = yield* Effect.try({
		try: () =>
			parseArgs({
				args: [...args],
				allowPositionals: true,
				options: {
					top: { type: "string", default: "40" },
					filter: { type: "string" },
					under: { type: "string" },
					callees: { type: "string" }
				}
			}),
		catch: failureFrom("read.ts")
	})
	const path = Arr.head(positionals)
	if (Option.isNone(path)) {
		return yield* DevtoolFailure.make({
			detail: "usage: read.ts <file.cpuprofile> [--top N] [--filter substring]"
		})
	}
	const settings: Settings = {
		path: path.value,
		top: Number(values.top),
		filter: Option.fromUndefinedOr(values.filter),
		under: Option.fromUndefinedOr(values.under),
		callees: Option.fromUndefinedOr(values.callees)
	}
	return settings
})

const short = (url: string): string =>
	Option.match(Str.indexOf("/grizzle/")(url), {
		onSome: (at) => Str.slice(at + "/grizzle/".length)(url),
		onNone: () => Str.replace(regex("^.*node_modules/"), "nm/")(url)
	})

/** Milliseconds per key: the tables the profile is read into. */
type Tally = Map<string, number>

const add = (tally: Tally, key: string, ms: number): void => {
	tally.set(key, (tally.get(key) ?? 0) + ms)
}

/** The profile read into its tables: self time per file and per function, inclusive time, and the callees asked for. */
interface Tables {
	readonly total: number
	readonly selfFile: Tally
	readonly selfFn: Tally
	readonly inclusive: Tally
	readonly callees: Tally
}

const tablesOf = (profile: Profile, settings: Settings): Tables => {
	const nodes = new Map(Arr.map(profile.nodes, (n) => [n.id, n] as const))
	const parent = new Map(
		Arr.flatMap(profile.nodes, (n) => Arr.map(n.children ?? [], (c) => [c, n.id] as const))
	)
	const fnKey = (id: number): string =>
		Option.match(Option.fromUndefinedOr(nodes.get(id)), {
			onNone: () => "?",
			onSome: ({ callFrame: f }) =>
				`${f.functionName === "" ? "(anonymous)" : f.functionName} ${short(f.url)}:${f.lineNumber + 1}`
		})
	const fileKey = (id: number): string =>
		Option.match(Option.fromUndefinedOr(nodes.get(id)), {
			onNone: () => "?",
			onSome: ({ callFrame: f }) => (short(f.url) === "" ? "(native)" : short(f.url))
		})
	/** The sample's stack, innermost first. */
	const stackOf = (sample: number): ReadonlyArray<number> =>
		Option.match(Option.fromUndefinedOr(parent.get(sample)), {
			onNone: () => [sample],
			onSome: (up) => [sample, ...stackOf(up)]
		})
	const matching = (needle: string) => (id: number) => pipe(fnKey(id), Str.includes(needle))
	/** Each sample with its stack and its time, a sample's delta being the time since the one before it. */
	const stacks = Arr.filterMap(Arr.zip(profile.samples, profile.timeDeltas), ([sample, delta]) => {
		const stack = stackOf(sample)
		const kept = Option.match(settings.under, {
			onNone: () => true,
			onSome: (u) => Arr.some(stack, matching(u))
		})
		return kept ? Result.succeed({ sample, stack, ms: delta / 1000 }) : Result.failVoid
	})
	const tables: Tables = {
		total: Arr.reduce(stacks, 0, (sum, s) => sum + s.ms),
		selfFile: new Map(),
		selfFn: new Map(),
		inclusive: new Map(),
		callees: new Map()
	}
	for (const { sample, stack, ms } of stacks) {
		add(tables.selfFn, fnKey(sample), ms)
		add(tables.selfFile, fileKey(sample), ms)
		for (const k of new Set(Arr.map(stack, fnKey))) {
			add(tables.inclusive, k, ms)
		}
		/** The outermost frame matching, and the frame it called on this sample's stack. */
		const outermost = Option.flatMap(settings.callees, (c) => Arr.findLastIndex(stack, matching(c)))
		for (const at of Option.toArray(outermost)) {
			add(
				tables.callees,
				Option.match(Arr.get(stack, at - 1), { onNone: () => "(self)", onSome: fnKey }),
				ms
			)
		}
	}
	return tables
}

const byTimeDescending: Order.Order<readonly [string, number]> = Order.flip(
	Order.mapInput(Order.Number, ([, ms]: readonly [string, number]) => ms)
)

const table = (settings: Settings, total: number, title: string, tally: Tally): string => {
	const rows = Arr.filter([...tally], ([k]) =>
		Option.match(settings.filter, { onNone: () => true, onSome: (f) => Str.includes(f)(k) })
	)
	return Arr.join(
		[
			`\n${title}`,
			...Arr.map(
				Arr.take(Arr.sort(rows, byTimeDescending), settings.top),
				([k, v]) =>
					`${pipe(v.toFixed(0), Str.padStart(8))} ms ${pipe(((100 * v) / total).toFixed(1), Str.padStart(5))}%  ${k}`
			)
		],
		"\n"
	)
}

/**
 * Aggregates a V8 .cpuprofile (node --cpu-prof) by self time per function and per file, and inclusive time per
 * function, so a profile reads without a browser.
 *
 *   node scripts/dev/profile/read.ts <file.cpuprofile> [--top N] [--filter substring] [--under substring]
 *                                    [--callees substring]
 */
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const args = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	const settings = yield* parseSettings(args)
	const text = yield* fs
		.readFileString(settings.path)
		.pipe(Effect.mapError(failureFrom(`${settings.path} could not be read`)))
	const profile = yield* Effect.try({
		try: () => trustedJson<Profile>(text),
		catch: failureFrom(`${settings.path} is not JSON`)
	})
	const t = tablesOf(profile, settings)
	yield* Console.log(`total ${t.total.toFixed(0)} ms`)
	yield* Console.log(table(settings, t.total, "self time by file", t.selfFile))
	yield* Console.log(table(settings, t.total, "self time by function", t.selfFn))
	yield* Console.log(table(settings, t.total, "inclusive time by function", t.inclusive))
	yield* Effect.forEach(
		Option.toArray(settings.callees),
		(c) => Console.log(table(settings, t.total, `callees of ${c}`, t.callees)),
		{ discard: true }
	)
})

runDevtool(Effect.as(main, 0))
