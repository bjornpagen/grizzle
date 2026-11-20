/** What the properties of presenter.test.ts read: drawn invocations of a small CLI, formatters, and what reaches each stream. */

import {
	type Aimed,
	aimed,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import {
	Array as Arr,
	Cause,
	Console,
	Effect,
	Exit,
	Layer,
	Option,
	Runtime,
	Stdio,
	String as Str
} from "effect"
import { CliError, CliOutput, Command, Flag } from "effect/cli"
import * as Output from "#runtime-src/runtime/output.ts"
import { runCredentialsLayer } from "#runtime-src/runtime/redact.ts"
import { appendingTo } from "#test/support/stdio.ts"

/** A value a person typed that the CLI refuses: it must never reach any stream. */
const CANARY = "CANARY-SECRET-123"

const login = Command.make(
	"login",
	{ port: Flag.Int("port").pipe(Flag.withDescription("Callback port.")) },
	() => Effect.void
).pipe(Command.withDescription("Sign in."))

const cli = Command.make("example").pipe(
	Command.withDescription("Example CLI."),
	Command.withSubcommands([login])
)

/** How the CLI is invoked: help asked for, the version, no subcommand, or a flag given a value it refuses. */
export type Invocation = "requested help" | "version" | "implicit help" | "an invalid value"

const INVOCATIONS: Arr.NonEmptyReadonlyArray<Invocation> = [
	"requested help",
	"version",
	"implicit help",
	"an invalid value"
]

/** Characters that drive a terminal or hide text, and plain ones beside them. */
const HOSTILE: Arr.NonEmptyReadonlyArray<string> = [
	"\u001B",
	"[",
	"3",
	"m",
	"\u009B",
	"\u0085",
	"\u0000",
	"\u007F",
	"​",
	"‮",
	" ",
	"x",
	" ",
	"é"
]

/** A drawn presentation: the invocation, whether the formatter's texts carry hostile characters, and error rendering. */
export type Presentation = Readonly<{
	invocation: Invocation
	hostile: string
	formatter: "value-free" | "hostile"
	renderErrors: boolean
}>

const presentations: Gen<Presentation> = (s) => ({
	invocation: s.draw(element(INVOCATIONS)),
	hostile: s.draw(string(characterOf(HOSTILE), { min: 1, max: 8 })),
	formatter: s.draw(
		weighted([
			[1, constant<"value-free" | "hostile">("value-free")],
			[1, constant<"value-free" | "hostile">("hostile")]
		])
	),
	renderErrors: s.draw(
		weighted([
			[1, constant(true)],
			[1, constant(false)]
		])
	)
})

const argvOf = (invocation: Invocation): ReadonlyArray<string> => {
	switch (invocation) {
		case "requested help":
			return ["login", "--help"]
		case "version":
			return ["--version"]
		case "implicit help":
			return []
		case "an invalid value":
			return ["login", "--port", CANARY]
	}
}

const formatterOf = (presentation: Presentation): CliOutput.Formatter =>
	presentation.formatter === "value-free"
		? Output.valueFreeFormatter
		: {
				formatCliError: Output.valueFreeFormatter.formatCliError,
				formatError: Output.valueFreeFormatter.formatError,
				formatErrors: () => `bad${presentation.hostile}`,
				formatHelpDoc: () => `help${presentation.hostile}`,
				formatVersion: () => `v${presentation.hostile}`
			}

/** What a run leaves: its two streams and its exit code. */
export type Presented = Readonly<{ stdout: string; stderr: string; exitCode: number }>

/** Runs the CLI as the generated entry does: the presenter and formatter in context, exitForHelp inside finalCatch. */
export const presentedOf = (presentation: Presentation) =>
	Effect.scoped(
		Effect.gen(function* () {
			const out: Array<string> = []
			const err: Array<string> = []
			const pushTo =
				(into: Array<string>) =>
				(...parts: ReadonlyArray<unknown>) => {
					into.push(`${Arr.join(Arr.map(parts, String), " ")}\n`)
				}
			const console: Console.Console = Object.assign({}, globalThis.console, {
				error: pushTo(err),
				log: pushTo(out)
			})
			const stdio = Stdio.layerTest({ stderr: appendingTo(err), stdout: appendingTo(out) })
			const context = yield* Layer.build(
				Layer.mergeAll(
					stdio,
					runCredentialsLayer,
					CliOutput.layer(formatterOf(presentation)),
					CliOutput.layerPresenter(Output.presenter)
				)
			)
			const exit = yield* Command.runWith(cli, {
				renderErrors: presentation.renderErrors,
				version: "1.2.3"
			})(argvOf(presentation.invocation)).pipe(
				Output.exitForHelp,
				Output.finalCatch([]),
				Effect.provideContext(context),
				Effect.provideService(Console.Console, console),
				Effect.exit
			)
			const presented: Presented = {
				stdout: Arr.join(out, ""),
				stderr: Arr.join(err, ""),
				exitCode: Exit.isSuccess(exit) ? 0 : Runtime.getErrorExitCode(Cause.squash(exit.cause))
			}
			return presented
		})
	)

/** What the design says sanitizing leaves: every control, format and surrogate character but LF and TAB gone. */
const neutral = (text: string): string =>
	Arr.join(
		Arr.filter(
			Arr.fromIterable(text),
			(character) => character === "\n" || character === "\t" || !unsafe.test(character)
		),
		""
	)

const unsafe: Readonly<RegExp> = regex("[\\p{Cc}\\p{Cf}\\p{Cs}\\u2028\\u2029]", "u")

/**
 * The facts the routing table states for a presentation: requested help and the version on stdout, sanitized, exit 0;
 * implicit help on stderr, sanitized, exit 0; an invalid value on stderr only, exit 2, never quoting the value, its help
 * and errors sanitized when errors are rendered; and no terminal-driving character on either stream.
 */
export type Facts = Readonly<{
	stdout: Option.Option<string>
	stderrHolds: ReadonlyArray<string>
	stderrEmpty: boolean
	exitCode: number
	quotesTheValue: boolean
	drivesATerminal: boolean
}>

export const expectedFacts = (presentation: Presentation): Facts => {
	const hostile = presentation.formatter === "hostile"
	const help = hostile ? `help${neutral(presentation.hostile)}\n` : ""
	switch (presentation.invocation) {
		case "requested help":
			return {
				stdout: hostile ? Option.some(help) : Option.none(),
				stderrHolds: [],
				stderrEmpty: true,
				exitCode: 0,
				quotesTheValue: false,
				drivesATerminal: false
			}
		case "version":
			return {
				stdout: hostile ? Option.some(`v${neutral(presentation.hostile)}\n`) : Option.none(),
				stderrHolds: [],
				stderrEmpty: true,
				exitCode: 0,
				quotesTheValue: false,
				drivesATerminal: false
			}
		case "implicit help":
			return {
				stdout: Option.some(""),
				stderrHolds: hostile ? [help] : ["Example CLI.", "login"],
				stderrEmpty: false,
				exitCode: 0,
				quotesTheValue: false,
				drivesATerminal: false
			}
		case "an invalid value":
			return {
				stdout: Option.some(""),
				stderrHolds:
					hostile && presentation.renderErrors
						? [help, `bad${neutral(presentation.hostile)}\n`]
						: ["--port"],
				stderrEmpty: false,
				exitCode: 2,
				quotesTheValue: false,
				drivesATerminal: false
			}
	}
}

/** The facts a run's streams and exit show, read in the fields the routing table states. */
export const factsOf = (presentation: Presentation, presented: Presented): Facts => {
	const expected = expectedFacts(presentation)
	return {
		stdout: Option.map(expected.stdout, () => presented.stdout),
		stderrHolds: Arr.filter(expected.stderrHolds, (part) => Str.includes(part)(presented.stderr)),
		stderrEmpty: presented.stderr === "",
		exitCode: presented.exitCode,
		quotesTheValue: Str.includes(CANARY)(`${presented.stdout}${presented.stderr}`),
		drivesATerminal: Arr.some(["\u001B", "\u009B", "\u0085", "‮"], (character) =>
			Str.includes(character)(`${presented.stdout}${presented.stderr}`)
		)
	}
}

export type PresentationFeature =
	| `${Invocation}, ${"value-free" | "hostile"}`
	| "errors rendered"
	| "errors left to finalCatch"

export const presentationFeatures = (
	presentation: Presentation
): ReadonlyArray<PresentationFeature> => [
	`${presentation.invocation}, ${presentation.formatter}`,
	...(presentation.invocation === "an invalid value"
		? [
				presentation.renderErrors
					? ("errors rendered" as const)
					: ("errors left to finalCatch" as const)
			]
		: [])
]

/** A failure exitForHelp is given: help asked for with one or more errors, help with none, or any other failure. */
export type HelpExit = Readonly<{ kind: "help" | "another failure"; errors: number }>

export const helpExits: Gen<HelpExit> = (s) => ({
	kind: s.draw(
		weighted([
			[2, constant<HelpExit["kind"]>("help")],
			[1, constant<HelpExit["kind"]>("another failure")]
		])
	),
	errors: s.draw(int(0, 3))
})

/** What exitForHelp makes of a failure: help with errors exits 2, help with none succeeds, any other passes through. */
export const helpExitOf = (exit: HelpExit) => {
	const failure: Effect.Effect<void, Output.InternalError | CliError.ShowHelp> =
		exit.kind === "another failure"
			? Effect.fail(Output.InternalError.make({}))
			: Effect.fail(
					CliError.ShowHelp.make({
						commandPath: [],
						errors: Array.from({ length: exit.errors }, (_, at) =>
							CliError.InvalidValue.make({
								expected: "port",
								kind: "flag",
								option: `port${at}`,
								value: "x"
							})
						)
					})
				)
	return Effect.map(Effect.exit(Output.exitForHelp(failure)), (ended) =>
		Exit.isSuccess(ended) ? 0 : Runtime.getErrorExitCode(Cause.squash(ended.cause))
	)
}

export const expectedHelpExit = (exit: HelpExit): number =>
	exit.kind === "another failure" ? 70 : exit.errors > 0 ? 2 : 0

export type HelpExitFeature = "help with errors" | "help without errors" | "another failure"

export const helpExitFeatures = (exit: HelpExit): ReadonlyArray<HelpExitFeature> => [
	exit.kind === "another failure"
		? "another failure"
		: exit.errors > 0
			? "help with errors"
			: "help without errors"
]

/** Presentations, aimed at each invocation and formatter, and at errors rendered or not, while each is pending. */
export const aimedPresentations: Aimed<Presentation, PresentationFeature> = aimed(presentations, [
	...Arr.flatMap(INVOCATIONS, (invocation) =>
		Arr.map(
			["value-free", "hostile"] as const,
			(formatter) =>
				[
					`${invocation}, ${formatter}` as const,
					map(presentations, (drawn): Presentation => ({ ...drawn, invocation, formatter }))
				] as const
		)
	),
	[
		"errors rendered",
		map(presentations, (drawn): Presentation => ({
			...drawn,
			invocation: "an invalid value",
			renderErrors: true
		}))
	],
	[
		"errors left to finalCatch",
		map(presentations, (drawn): Presentation => ({
			...drawn,
			invocation: "an invalid value",
			renderErrors: false
		}))
	]
])
