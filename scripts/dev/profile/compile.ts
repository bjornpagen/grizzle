#!/usr/bin/env -S node
import { parseArgs } from "node:util"
import { DevtoolFailure, failureFrom } from "@grizzle/devtools/devtool"
import { runDevtool } from "@grizzle/devtools/run"
import {
	Array as Arr,
	Console,
	Crypto,
	Effect,
	FileSystem,
	Option,
	Order,
	pipe,
	type PlatformError,
	Record as Rec,
	Schema,
	String as Str
} from "effect"
import { Hex } from "effect/encoding"
import { compilePhases, fixtures } from "#scripts/dev/profile/phases.ts"

const parseSettings = Effect.fn("parseSettings")(function* (args: ReadonlyArray<string>) {
	const { values } = yield* Effect.try({
		try: () =>
			parseArgs({
				args: [...args],
				options: {
					fixture: { type: "string", multiple: true },
					each: { type: "boolean", default: false },
					repeat: { type: "string", default: "1" },
					dump: { type: "string" }
				}
			}),
		catch: failureFrom("compile.ts")
	})
	const repeat = Number(values.repeat)
	if (!Number.isInteger(repeat) || repeat < 1) {
		return yield* DevtoolFailure.make({
			detail: `--repeat must be a positive integer, not ${values.repeat}`
		})
	}
	return {
		wanted: values.fixture ?? ["payroll"],
		repeat,
		each: values.each,
		dump: Option.fromUndefinedOr(values.dump)
	}
})

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/** The texts of the parts, in order, joined by commas. */
const joined = (
	parts: ReadonlyArray<Effect.Effect<string, Schema.SchemaError | PlatformError.PlatformError>>
) => Effect.map(Effect.all(parts), (items) => Arr.join(items, ","))

const byKey: Order.Order<readonly [string, unknown]> = Order.mapInput(
	Order.String,
	([key]: readonly [string, unknown]) => key
)

/**
 * A JSON text of any compiler output that depends only on its content, never on which objects it shares: Maps, Sets and
 * class instances by their enumerable fields, functions by name, bigints as strings. An object's fields are written in
 * key order, as canonical encoding writes them, so the order a builder or a decoder set them in is no content. A Map
 * keeps its own order, which a reader may iterate. A subtree whose text is long is written once, in a table under its
 * SHA-256, and referred to by that digest, so the dump stays small however much the output shares, and two runs that
 * share differently (one memoizes, the other recomputes) dump the same bytes.
 */
const dumpText = Effect.fn("dumpText")(function* (root: unknown) {
	const crypto = yield* Crypto.Crypto
	const table = new Map<string, string>()
	const onStack = new Set<object>()
	const objectText = (
		v: object
	): Effect.Effect<string, Schema.SchemaError | PlatformError.PlatformError> => {
		if (v instanceof Map) {
			return Effect.map(
				joined(
					Arr.map([...v], ([k, x]) => Effect.map(joined([go(k), go(x)]), (pair) => `[${pair}]`))
				),
				(items) => `{"<map>":[${items}]}`
			)
		}
		if (v instanceof Set) {
			return Effect.map(joined(Arr.map([...v], go)), (items) => `{"<set>":[${items}]}`)
		}
		if (Arr.isArray(v)) {
			return Effect.map(joined(Arr.map(v, go)), (items) => `[${items}]`)
		}
		return Effect.map(
			joined(
				Arr.map(Arr.sort(Rec.toEntries({ ...v }), byKey), ([k, x]) =>
					Effect.map(Effect.all([encodeJson(k), go(x)]), ([key, text]) => `${key}:${text}`)
				)
			),
			(fields) => `{${fields}}`
		)
	}
	/** The text a subtree is referred to by: itself, or the digest it is tabled under once it is long. */
	const shared = (
		text: string
	): Effect.Effect<string, Schema.SchemaError | PlatformError.PlatformError> =>
		text.length > 4096
			? Effect.gen(function* () {
					const digest = pipe(
						Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(text))),
						Str.slice(0, 24)
					)
					table.set(digest, text)
					return yield* encodeJson(`<sub ${digest}>`)
				})
			: Effect.succeed(text)
	const go = (
		v: unknown
	): Effect.Effect<string, Schema.SchemaError | PlatformError.PlatformError> => {
		if (typeof v === "bigint") {
			return encodeJson(`${v}n`)
		}
		if (typeof v === "function") {
			return encodeJson(`<function ${v.name}>`)
		}
		if (typeof v === "symbol") {
			return encodeJson(v.toString())
		}
		if (v === undefined) {
			return Effect.succeed('"<undefined>"')
		}
		if (v === null || typeof v !== "object") {
			return encodeJson(v)
		}
		if (onStack.has(v)) {
			return Effect.succeed('"<cycle>"')
		}
		return Effect.gen(function* () {
			onStack.add(v)
			const whole = yield* objectText(v)
			onStack.delete(v)
			return yield* shared(whole)
		})
	}
	const top = yield* go(root)
	return Arr.join([top, ...Arr.map(Arr.sort([...table], byKey), ([k, t]) => `${k} ${t}`)], "\n")
})

/**
 * Times each compile phase of a fixture's install path with no database (phases.ts), and optionally dumps every
 * compiler output. With --dump <file> it writes every output as content-only JSON (dumpText), so two runs can be
 * compared byte for byte.
 *
 *   node scripts/dev/profile/compile.ts [--fixture payroll|work|...] [--repeat N] [--each] [--dump /tmp/out.json]
 *
 * Profile with `node --cpu-prof --cpu-prof-dir=/tmp/prof scripts/dev/profile/compile.ts --fixture payroll`, then
 * `node scripts/dev/profile/read.ts /tmp/prof/<file>.cpuprofile`.
 */
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const args = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	const settings = yield* parseSettings(args)
	const timings = new Map<string, Array<number>>()
	/** Runs `f` and records its time under `phase`, by performance.now() around the synchronous work. */
	const timed = <A>(phase: string, f: () => A): A => {
		const start = performance.now()
		const a = f()
		const list = timings.get(phase) ?? []
		list.push(performance.now() - start)
		timings.set(phase, list)
		return a
	}
	const chosen = Arr.filter(fixtures, (x) => Arr.contains(settings.wanted, x.label))
	/** Every round compiles every chosen fixture; the first round's outputs are kept for the dump. */
	const firstRound = yield* Effect.sync(() =>
		Arr.map(chosen, (f) => ({
			label: f.label,
			outputs: compilePhases({ fixture: f, timed, each: settings.each })
		}))
	)
	yield* Effect.forEach(
		Arr.drop(
			Arr.makeBy(settings.repeat, (round) => round),
			1
		),
		() =>
			Effect.sync(() => {
				for (const f of chosen) {
					compilePhases({ fixture: f, timed, each: settings.each })
				}
			}),
		{ discard: true }
	)
	const ms = (x: number): string => `${pipe(x.toFixed(0), Str.padStart(8))} ms`
	yield* Effect.forEach(
		[...timings],
		([phase, list]) =>
			Console.log(
				`${Str.padEnd(28)(phase)} ${ms(Arr.reduce(list, Number.POSITIVE_INFINITY, (least, x) => Math.min(least, x)))} min ${ms(Arr.reduce(list, 0, (a, b) => a + b) / list.length)} mean`
			),
		{ discard: true }
	)
	if (!Option.isSome(settings.dump)) {
		return
	}
	const dumped = yield* Effect.forEach(firstRound, ({ label, outputs }) =>
		Effect.map(dumpText(outputs), (text) => `== ${label}\n${text}\n`)
	)
	yield* fs.writeFileString(settings.dump.value, Arr.join(dumped, ""))
	yield* Console.log(`dumped ${settings.dump.value}`)
})

runDevtool(Effect.as(main, 0))
