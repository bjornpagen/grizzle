import { registerHooks } from "node:module"
import { pathToFileURL } from "node:url"
import { Array as Arr, Option, pipe, String as Str } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"

/**
 * The runtime half of the dependency audit, run by deps.test.ts in a child Node process:
 *
 *   node test/unit/deps/runtime-probe.ts <repo root> <module>...
 *
 * Before any src/ module loads, it records every module URL Node resolves, and traps RegExp: construction through
 * the global and every match, since RegExp.prototype.test, String.prototype.match and the rest all reach
 * RegExp.prototype.exec (a regular expression literal is built by the intrinsic, not the global, but matching it
 * still reaches exec). Each trapped call is attributed to the frame that made it: the stack is captured from the trap
 * function itself, so neither the trap nor this file's bookkeeping is ever the frame reported.
 *
 * It then loads each module named on the command line and drives the paths where src/ parses text: the text pipeline
 * as schema compilation runs it (str.regex, the grammar check and lowering, the NFA membership used for literal
 * checks), over refused patterns as well as admitted ones; the text codecs of every scalar carrier that reads
 * PostgreSQL output (integers, int4range and int8range, real, double precision and vector components, numeric, money,
 * uuid); and the conditional aggregate's lowering, which reads numeric literal payloads. It prints one JSON line: every
 * resolution with the module that asked for it, every trapped call with its frame, and the line of the positive
 * control, which constructs and runs a RegExp from this file so the parent can tell a silent trap from a quiet
 * production path. Each module's load is recorded apart: what it resolved and trapped while it loaded.
 */
interface Trapped {
	readonly kind: string
	readonly frame: string
}

/** A module URL Node resolved, and the URL of the module whose import asked for it. */
interface Resolution {
	readonly importer: string
	readonly url: string
}

/**
 * The probe traps the process's RegExp: it is the process's entry, so the global it replaces is its own to declare.
 */
declare global {
	var RegExp: RegExpConstructor
}

const [root, ...modules]: ReadonlyArray<string> = process.argv.slice(2)
if (root === undefined) {
	throw new Error("usage: runtime-probe.ts <repo root> <module>...")
}

const isUserFrame = (frame: string): boolean =>
	!Str.includes("<anonymous>")(frame) &&
	!Str.includes("node:internal")(frame) &&
	!Str.includes("(native)")(frame)

/**
 * The frames of the stack below `trap`: Error.captureStackTrace omits `trap` and everything it called, so the first
 * frame is the trap's caller, or a builtin (String.prototype.match, Reflect.construct) between it and the trap.
 */
const framesBelow = (trap: (...args: never) => unknown): Array<string> => {
	const limit = Error.stackTraceLimit
	Error.stackTraceLimit = 64
	const holder = { stack: "" }
	Error.captureStackTrace(holder, trap)
	Error.stackTraceLimit = limit
	return Arr.map(Str.split(holder.stack, "\n").slice(1), (line) => Str.trim(line))
}

/**
 * The first frame below the trap that is neither a builtin nor Node's own: the code that asked for the RegExp, or
 * undefined when only Node's own code is below it, which no module of the repository is.
 */
const callerFrame = (trap: (...args: never) => unknown): Option.Option<string> =>
	Arr.findFirst(framesBelow(trap), isUserFrame)

/**
 * The line of this file the call is written on, for the positive control. Read without a RegExp, which the trap
 * would see.
 */
const lineHere = (): number => {
	const frame = Option.getOrThrowWith(
		Arr.findFirst(framesBelow(lineHere), isUserFrame),
		() => new Error("no frame of this file below lineHere")
	)
	const parts = Str.split(Str.endsWith(")")(frame) ? Str.slice(0, -1)(frame) : frame, ":")
	const line = Number(parts[parts.length - 2])
	if (!Number.isInteger(line)) {
		throw new Error(`no line in the frame ${frame}`)
	}
	return line
}

/** Where one module named on the command line began loading: the counts of resolutions and trapped calls before it. */
interface LoadStart {
	readonly module: string
	readonly resolvedFrom: number
	readonly trappedFrom: number
}

/**
 * What a probe run records: every module URL Node resolves with its importer, every trapped call with the frame that
 * made it, and where each module named on the command line began loading.
 */
interface Recorder {
	readonly resolved: Array<Resolution>
	readonly trapped: Array<Trapped>
	readonly loads: Array<LoadStart>
	/** A trapped call is recorded with the module that made it; one only Node's own code made is no module's. */
	readonly record: (kind: string, trap: (...args: never) => unknown) => void
}

/** A fresh recorder, the run's own. */
const recorder = (): Recorder => {
	const trapped: Array<Trapped> = []
	return {
		resolved: [],
		trapped,
		loads: [],
		record: (kind, trap) => {
			const frame = callerFrame(trap)
			if (Option.isSome(frame)) {
				trapped.push({ kind, frame: frame.value })
			}
		}
	}
}

/**
 * Records into `run` every module URL Node resolves from now on, with its importer, and traps RegExp: construction
 * through the global, and every match through RegExp.prototype.exec. Only the process's entry resolves with no
 * importer, and it loaded before the hooks, so a resolution without one fails the probe.
 */
const installTraps = (run: Recorder): void => {
	registerHooks({
		resolve: (specifier, context, nextResolve) => {
			const result = nextResolve(specifier, context)
			const importer = context.parentURL
			if (importer === undefined) {
				throw new Error(`${result.url} resolved with no importer`)
			}
			run.resolved.push({ importer, url: result.url })
			return result
		}
	})
	const NativeRegExp = RegExp
	const nativeExec = NativeRegExp.prototype.exec
	NativeRegExp.prototype.exec = function exec(this: RegExp, input: string) {
		run.record("exec", exec)
		return nativeExec.call(this, input)
	}
	globalThis.RegExp = new Proxy(NativeRegExp, {
		construct: function construct(
			target,
			args: [pattern: string | RegExp, flags: string | undefined]
		) {
			run.record("new RegExp", construct)
			return new target(args[0], args[1])
		},
		apply: function apply(target, receiver, args) {
			run.record("RegExp()", apply)
			const made: unknown = Reflect.apply(target, receiver, args)
			return made
		}
	})
}

const run = recorder()
installTraps(run)

/**
 * The positive control, its line and its match: its construction and its match must both be trapped, attributed to
 * exactly this line. The control constructs through the trapped global RegExp, never a literal.
 */
const control: readonly [number, boolean] = [lineHere(), new RegExp("^a+$", "u").test("aa")]

for (const module of modules) {
	run.loads.push({ module, resolvedFrom: run.resolved.length, trappedFrom: run.trapped.length })
	await import(pathToFileURL(`${root}/${module}`).href)
}

/** Trapped calls made before the drivers run come from loading; the drivers' own are counted after. */
const loaded = run.trapped.length
const loadedResolved = run.resolved.length

/**
 * What loading each module named on the command line resolved and trapped, in the order they loaded: a module already
 * loaded by one before it resolves nothing again, so the loads together hold every module the entries reach.
 */
const loads: ReadonlyArray<
	Readonly<{
		module: string
		resolved: ReadonlyArray<Resolution>
		trapped: ReadonlyArray<Trapped>
	}>
> = Arr.map(run.loads, (start, i) => {
	const next = run.loads[i + 1]
	return {
		module: start.module,
		resolved: run.resolved.slice(
			start.resolvedFrom,
			next === undefined ? loadedResolved : next.resolvedFrom
		),
		trapped: run.trapped.slice(start.trappedFrom, next === undefined ? loaded : next.trappedFrom)
	}
})

/**
 * The text pipeline, over every family pattern of the regex differential tests and a set of refused sources.
 * Each driven module is imported by a literal specifier, so it has its own module type; the probe lives at
 * test/unit/deps under the root it is given, so each resolves to the same URL as the root-relative path.
 */
const field = await import("#compiler/text/field.ts")
const parse = await import("#compiler/scalar/regex/parse.ts")
const programPatterns = (await import("#compiler/scalar/regex/patterns.ts")).ProgramPatterns.of
const refinement = await import("#compiler/text/refinement.ts")
const loc = await import("#compiler/core/loc.ts")
const generators = await import("#test/unit/text/generators.ts")

/** Values the trap must not see validated by JavaScript: drawn from every family's alphabet. */
const probes = (alphabet: ReadonlyArray<number>): Array<string> => {
	const chars = Arr.map(alphabet, (cp) => String.fromCodePoint(cp))
	return ["", ...chars, Arr.join(chars, ""), pipe(Arr.join(chars.slice(0, 3), ""), Str.repeat(3))]
}

/** Each admitted family pattern's checked probe values, in the order the pipeline ran them. */
const admittedChecks: ReadonlyArray<ReadonlyArray<boolean>> = Arr.flatMap(
	generators.families,
	(family, fi) =>
		Arr.flatMap(family.patterns, ([source, flags], pi) => {
			field.regexField(source, [flags])
			const result = refinement.analyzeText([{ source, flags }], loc.SourceLoc("probe", [fi, pi]))
			if (!result.ok) {
				return []
			}
			const { regex } = refinement.textInfo(result.value)
			const check = result.value.check
			if (check.kind !== "tautology") {
				refinement.membership(check, refinement.domainValue)
			}
			if (regex === "wildcard") {
				return [[]]
			}
			const automata = programPatterns(regex.patterns)
			return [Arr.map(probes(family.alphabet), (value) => automata.member(regex, value))]
		})
)
/** A flags word the description boundary refuses never reaches the analysis. */
const refused = Arr.filter(
	[
		["(a)\\2", "u"],
		["(?<n>a)\\k<m>", "u"],
		["(?=a)[", "u"],
		["\\p{L}", "u"],
		["a*?", "u"],
		["(?i:a)", "u"],
		["a", "i"],
		["a", "uu"],
		["\ud800", "u"]
	] as const,
	([source, flags]) =>
		!parse.isRegexFlags(flags) ||
		!refinement.analyzeText([{ source, flags }], loc.SourceLoc("probe", ["refused"])).ok
).length

/** The text codecs: every carrier's conversion of PostgreSQL's output texts. */
const reader = await import("#compiler/codec/read.ts")
const wire = await import("#test/support/wire.ts")
const values: Readonly<typeof import("#compiler/scalar/values/float.ts")> =
	await import("#compiler/scalar/values/float.ts")
const codecSupport = await import("#test/unit/codec/support.ts")
const codecTypes = codecSupport.types
const codecTexts: ReadonlyArray<readonly [keyof typeof codecTypes, ReadonlyArray<string>]> = [
	["int2", ["0", "-32768", "32767", "1", "-1", "12345", "100", "-100"]],
	["int4", ["0", "-2147483648", "2147483647", "42"]],
	["int8", ["9223372036854775807", "-9223372036854775808", "0", "17"]],
	["cents", ["0", "12", "7"]],
	["numeric", ["0", "1.50", "-0.001", "NaN", "Infinity", "-Infinity", "1000"]],
	["numeric72", ["12345.67", "1.50", "-0.01"]],
	[
		"float4",
		["0", "-1e-45", "3.4028235e+38", "NaN", "-Infinity", "Infinity", "0.1", "1.5", "-2.5e-08"]
	],
	["float8", ["0", "5e-324", "1.7976931348623157e+308", "Infinity", "NaN", "1e+21", "-0.5"]],
	["money", ["12.05", "-0.01", "0.00", "-92233720368547758.08"]],
	["bool", ["t", "f", "true", "false"]],
	["uuid", ["a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "00000000-0000-0000-0000-000000000000"]],
	["text", ["", "abc", "a b"]],
	["kind", ["0", "1", "2"]],
	["kinds", ["000", "101", "111"]],
	["range4", ["[-3,8)", "[1,2147483647)", "[-2147483648,0)"]],
	["range8", ["[1,2)", "[-9223372036854775808,9223372036854775807)"]],
	["vector3", ["[1,2,3]", "[1.5,-0.002,3e+38]", "[0,0,1]"]],
	["embedding", ["[1,2,3,4]"]]
]
const codecsDecoded = Arr.flatMap(codecTexts, ([name, texts]) => {
	const built = reader.scalarReader(codecTypes[name], codecSupport.kindCodes)
	return Arr.map(texts, (t) => built.convert(wire.outputText(t)))
}).length

const floatsDecoded = Arr.map(["1.5", "-0", "3.4028235e+38", "1e-45", "1e+00"], (t) => {
	values.convertReal(t)
	values.convertDouble(t)
	return values.convertComponent(t, 0, t.length)
}).length

/**
 * The conditional aggregate's lowering reads a numeric literal's payload as
 * text: conditional sums over integer, bigint, numeric(1, 0) (from bigints and from texts) and numeric(5, 1) branches
 * compile under the trap. Which of them lower to count(*) FILTER is R24's rule, which unit/compute/aggregate.test.ts
 * states exhaustively; here a compile that is refused fails the probe.
 */
const { Compute } = await import("#compiler/public/compute.ts")
const { pg, uuid }: Readonly<typeof import("#compiler/public/fields.ts")> =
	await import("#compiler/public/fields.ts")
const { query, v }: Readonly<typeof import("#compiler/public/query.ts")> =
	await import("#compiler/public/query.ts")
const { relation, schema }: Readonly<typeof import("#compiler/public/schema.ts")> =
	await import("#compiler/public/schema.ts")
const { compileTemplate, testCompile } = await import("#test/support/compile.ts")
const Flagged = relation("Flagged", { id: uuid, flag: pg.boolean }, ["id"])
const Flags = schema("Flags", { Flagged }, [])
/** The query compiled, or the probe fails. */
const compiles = (q: unknown): void => {
	const template = compileTemplate(q, undefined, testCompile)
	if (!template.ok) {
		throw new Error(`the conditional sum is refused: ${template.error.message}`)
	}
}
const flags = query(Flags)
for (const q of [
	flags.rule((r) => {
		const { id, flag } = v(Flagged, "flagged")
		return r
			.match(Flagged, { id, flag })
			.find({ n: r.sum(Compute.cond(flag, Compute.literal(pg.integer, 1), 0)) })
	}),
	flags.rule((r) => {
		const { id, flag } = v(Flagged, "flagged")
		return r
			.match(Flagged, { id, flag })
			.find({ n: r.sum(Compute.cond(flag, Compute.literal(pg.bigint, 1n), 0n)) })
	}),
	flags.rule((r) => {
		const { id, flag } = v(Flagged, "flagged")
		return r.match(Flagged, { id, flag }).find({
			n: r.sum(
				Compute.cond(
					flag,
					Compute.literal(pg.numeric(1, 0), 1n),
					Compute.literal(pg.numeric(1, 0), 0n)
				)
			)
		})
	}),
	flags.rule((r) => {
		const { id, flag } = v(Flagged, "flagged")
		return r.match(Flagged, { id, flag }).find({
			n: r.sum(
				Compute.cond(
					flag,
					Compute.literal(pg.numeric(1, 0), "1"),
					Compute.literal(pg.numeric(1, 0), "0")
				)
			)
		})
	}),
	flags.rule((r) => {
		const { id, flag } = v(Flagged, "flagged")
		return r.match(Flagged, { id, flag }).find({
			n: r.sum(
				Compute.cond(
					flag,
					Compute.literal(pg.numeric(5, 1), "1.0"),
					Compute.literal(pg.numeric(5, 1), "0")
				)
			)
		})
	})
]) {
	compiles(q)
}

process.stdout.write(
	`${jsonText({
		control: control[1],
		controlLine: control[0],
		protoAccessor: Object.getOwnPropertyDescriptor(Object.prototype, "__proto__") !== undefined,
		resolved: Arr.map(run.resolved, (r) => ({ importer: r.importer, url: r.url })),
		trapped: Arr.map(run.trapped, (t) => ({ kind: t.kind, frame: t.frame })),
		loads: Arr.map(loads, (load) => ({
			module: load.module,
			resolved: Arr.map(load.resolved, (r) => ({ importer: r.importer, url: r.url })),
			trapped: Arr.map(load.trapped, (t) => ({ kind: t.kind, frame: t.frame }))
		})),
		loadedTrapped: loaded,
		admitted: admittedChecks.length,
		checked: Arr.reduce(admittedChecks, 0, (n, checks) => n + checks.length),
		refused,
		decoded: codecsDecoded + floatsDecoded
	})}\n`
)
