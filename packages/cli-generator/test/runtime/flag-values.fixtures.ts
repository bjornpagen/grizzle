/** What the properties of flag-values.test.ts read: the command lines and settings they draw, and their models. */

import { assert } from "@bjornpagen/testing/assert"
import {
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Cause,
	ConfigProvider,
	Console,
	Effect,
	Exit,
	Option,
	Predicate,
	Ref,
	Runtime,
	Stdio,
	Stream,
	String as Str
} from "effect"
import { CliConfig, CliOutput, Command, Flag } from "effect/cli"
import * as Client from "#runtime-src/runtime/client.ts"
import * as Input from "#runtime-src/runtime/input.ts"
import * as Output from "#runtime-src/runtime/output.ts"
import { RunCredentials, type ScrubEntry } from "#runtime-src/runtime/redact.ts"
import { recordingConsole } from "#test/support/console.ts"
import { metavarOf } from "#test/support/help.ts"
import { appendingTo } from "#test/support/stdio.ts"

/** A flag of the drawn entry command, by its long name. */
export type FlagName =
	| "p"
	| "limit"
	| "ratio"
	| "ids"
	| "total"
	| "old"
	| "olds"
	| "quiet"
	| "password-file"
	| "avatar"

/** What a flag's value is checked against: any text, the JSON integer or number grammar, or no value at all. */
type Domain = "string" | "integer" | "number" | "boolean"

/** Each flag's domain, whether it repeats, and whether it is deprecated, in the command's declaration order. */
const FLAGS: ReadonlyArray<
	readonly [FlagName, Domain, "once" | "repeated", "current" | "deprecated"]
> = [
	["p", "string", "once", "current"],
	["limit", "integer", "once", "current"],
	["ratio", "number", "once", "current"],
	["ids", "integer", "repeated", "current"],
	["total", "integer", "once", "current"],
	["old", "string", "once", "deprecated"],
	["olds", "string", "repeated", "deprecated"],
	["quiet", "boolean", "once", "deprecated"],
	["password-file", "string", "once", "current"],
	["avatar", "string", "once", "current"]
]

const domainOf = (flag: FlagName): Domain =>
	Option.match(
		Arr.findFirst(FLAGS, ([name]) => name === flag),
		{ onNone: () => "string", onSome: ([, domain]) => domain }
	)

/** One flag the operator gave: its values, one per occurrence, each in its own token or after `=`. */
export type Given = Readonly<{
	flag: FlagName
	values: ReadonlyArray<string>
	form: "token" | "equals"
}>

/** A built-in the operator typed after everything else. */
export type BuiltIn = "--help" | "--version" | "-h" | "-v"

/** One command line of the entry: the positional's kind, deprecation and text, the flags given, a built-in. */
export type Line = Readonly<{
	idKind: Input.NumericKind
	idDeprecated: boolean
	id: string
	given: ReadonlyArray<Given>
	passwordHelp: Option.Option<string>
	avatarHelp: Option.Option<string>
	builtIn: Option.Option<BuiltIn>
}>

const isDigit = (char: string | undefined): boolean =>
	char !== undefined && char >= "0" && char <= "9"

/** The end of the run of digits starting at `at`. */
const digitsFrom = (text: string, at: number): number => {
	let end = at
	while (isDigit(text[end])) {
		end += 1
	}
	return end
}

/** An RFC 8259 integer part at `at`: `0`, or a nonzero digit and more digits; the end, or -1. */
const integerPart = (text: string, at: number): number => {
	if (text[at] === "0") {
		return at + 1
	}
	return isDigit(text[at]) ? digitsFrom(text, at) : -1
}

/** Whether `text` is a JSON integer: an optional minus, then an integer part, then the end. */
const isIntegerText = (text: string): boolean =>
	integerPart(text, Str.startsWith("-")(text) ? 1 : 0) === text.length

/** Whether `text` is a JSON number (RFC 8259 section 6), read left to right by its grammar's parts. */
const isNumberText = (text: string): boolean => {
	let at = integerPart(text, Str.startsWith("-")(text) ? 1 : 0)
	if (at === -1) {
		return false
	}
	if (text[at] === ".") {
		const end = digitsFrom(text, at + 1)
		if (end === at + 1) {
			return false
		}
		at = end
	}
	if (text[at] === "e" || text[at] === "E") {
		const sign = text[at + 1] === "+" || text[at + 1] === "-" ? at + 2 : at + 1
		const end = digitsFrom(text, sign)
		if (end === sign) {
			return false
		}
		at = end
	}
	return at === text.length
}

/**
 * Whether effect's lexer reads `arg`, in a token of its own, as a value: anything not starting with `-`, a lone `-`,
 * or a negative number (`-3`, `-3.`, `-.5`, `-1e2`); anything else starting with `-` is read as flags.
 */
const lexedAsValue = (arg: string): boolean => {
	if (!Str.startsWith("-")(arg) || arg === "-") {
		return true
	}
	const whole = digitsFrom(arg, 1)
	const point = arg[whole] === "." ? digitsFrom(arg, whole + 1) : whole
	const mantissa = whole > 1 || point > whole + 1
	if (!mantissa) {
		return false
	}
	if (arg[point] === "e" || arg[point] === "E") {
		const sign = arg[point + 1] === "+" || arg[point + 1] === "-" ? point + 2 : point + 1
		const end = digitsFrom(arg, sign)
		return end > sign && end === arg.length
	}
	return point === arg.length
}

const admits = (domain: Domain, text: string): boolean => {
	switch (domain) {
		case "string":
		case "boolean":
			return true
		case "integer":
			return isIntegerText(text)
		case "number":
			return isNumberText(text)
	}
}

const digits: Gen<string> = string(element(["0", "1", "2", "5", "9"]), { min: 1, max: 22 })

/** Digits with one leading zero dropped, or `whenEmpty` when that leaves none. */
const noLeadingZero = (drawn: string, whenEmpty: string): string => {
	const rest = Str.startsWith("0")(drawn) ? Str.slice(1)(drawn) : drawn
	return rest === "" ? whenEmpty : rest
}

const integerText: Gen<string> = weighted<string>([
	[3, map(digits, (drawn) => noLeadingZero(drawn, "0"))],
	[2, map(digits, (drawn) => `-${noLeadingZero(drawn, "7")}`)],
	[1, constant("9007199254740993")],
	[3, element(["007", "1.0", "1e2", "+1", " 1", "", "abc", "x-secret", "1 ", "-", "--1", "0x10"])]
])

const numberText: Gen<string> = weighted<string>([
	[
		4,
		(source) =>
			`${element(["", "-"])(source)}${noLeadingZero(digits(source), "0")}${element(["", ".50", ".0", ".125"])(source)}${element(["", "e2", "E+2", "e-3"])(source)}`
	],
	[3, element(["1.", ".5", "NaN", "Infinity", "0x10", "1,5", "-.5", "-1.", "1e", "x-secret"])]
])

const stringText: Gen<string> = element([
	"plain",
	"a b",
	"v-secret",
	"",
	"-",
	"-bad_.host-",
	"-xh",
	"--x",
	"-3"
])

const textOf = (domain: Domain): Gen<string> => {
	switch (domain) {
		case "integer":
			return integerText
		case "number":
			return numberText
		case "string":
		case "boolean":
			return stringText
	}
}

const givenOf =
	(entry: readonly [FlagName, Domain, "once" | "repeated", "current" | "deprecated"]): Gen<Given> =>
	(source) => {
		const [flag, domain, repeats] = entry
		return {
			flag,
			values:
				domain === "boolean"
					? []
					: array(textOf(domain), { min: 1, max: repeats === "repeated" ? 3 : 1 })(source),
			form: element(["token", "equals"])(source)
		}
	}

const givenFlags: Gen<ReadonlyArray<Given>> = (source) =>
	Arr.flatMap(FLAGS, (entry) =>
		Option.toArray(
			weighted<Option.Option<Given>>([
				[3, constant(Option.none())],
				[1, map(givenOf(entry), Option.some)]
			])(source)
		)
	)

const help: Gen<Option.Option<string>> = option(constant("The password."))

const line: Gen<Line> = (source) => {
	const idKind = element(["integer", "number"] as const)(source)
	return {
		idKind,
		idDeprecated: element([false, true])(source),
		id: textOf(idKind)(source),
		given: givenFlags(source),
		passwordHelp: help(source),
		avatarHelp: help(source),
		builtIn: Option.none()
	}
}

/** The line with every value admitted and every separate value read as a value, so only the built-in decides. */
const clean = (drawn: Line): Line => ({
	...drawn,
	id: "7",
	given: Arr.map(drawn.given, (given) => ({
		...given,
		values: Arr.map(given.values, (value) =>
			admits(domainOf(given.flag), value) && lexedAsValue(value) ? value : "1"
		)
	}))
})

const withBuiltIn = (builtIn: BuiltIn): Gen<Line> =>
	map(line, (drawn) => ({ ...clean(drawn), builtIn: Option.some(builtIn) }))

const withGiven = (extra: Given): Gen<Line> =>
	map(line, (drawn) => ({
		...clean(drawn),
		given: [...Arr.filter(drawn.given, (given) => given.flag !== extra.flag), extra]
	}))

/** Command lines, with a constructed case for each situation a plain draw reaches rarely. */
export const lines = {
	space: weighted<Line>([
		[12, line],
		[1, withBuiltIn("--help")],
		[1, withBuiltIn("--version")],
		[1, oneOf([withBuiltIn("-h"), withBuiltIn("-v")])]
	]),
	help: withBuiltIn("--help"),
	version: withBuiltIn("--version"),
	alias: oneOf([withBuiltIn("-h"), withBuiltIn("-v")]),
	pastSafe: withGiven({ flag: "limit", values: ["9007199254740993"], form: "token" }),
	dashToken: withGiven({ flag: "p", values: ["-bad_.host-"], form: "token" }),
	dashEquals: withGiven({ flag: "p", values: ["-bad_.host-"], form: "equals" }),
	repeatedRefused: withGiven({ flag: "ids", values: ["1", "x-secret"], form: "token" }),
	twoDeprecated: map(withGiven({ flag: "old", values: ["v"], form: "token" }), (drawn) => ({
		...drawn,
		given: [
			...Arr.filter(drawn.given, (given) => given.flag !== "olds"),
			{ flag: "olds", values: ["a", "b"], form: "token" } as const
		]
	})),
	argumentRefused: map(line, (drawn) => ({ ...clean(drawn), id: "x-secret" }))
} as const

/** What one command line reaches. */
export type LineFeature =
	| "an integer past 2^53 handed on"
	| "a number's own text handed on"
	| "an integer near-miss refused"
	| "a number near-miss refused"
	| "a repeated flag refused by one item"
	| "a repeated flag handed on whole"
	| "an argument refused"
	| "a dash-led value in its own token"
	| "a dash-led value after ="
	| "a negative number in its own token"
	| "a deprecated flag given"
	| "two deprecated flags given"
	| "a deprecated argument"
	| "help requested"
	| "version requested"
	| "a short alias typed"

/** Every token of the line, the positional first and the built-in last. */
const argvOf = (drawn: Line): ReadonlyArray<string> => [
	drawn.id,
	...Arr.flatMap(drawn.given, (given) =>
		given.values.length === 0
			? [`--${given.flag}`]
			: Arr.flatMap(given.values, (value) =>
					given.form === "token" ? [`--${given.flag}`, value] : [`--${given.flag}=${value}`]
				)
	),
	...Option.toArray(drawn.builtIn)
]

const tokenValues = (drawn: Line): ReadonlyArray<string> => [
	drawn.id,
	...Arr.flatMap(drawn.given, (given) => (given.form === "token" ? given.values : []))
]

/** The inputs that fail their check, in the order the parser checks them: the positional, then the flags as declared. */
const refusedOf = (drawn: Line): ReadonlyArray<string> => [
	...(admits(drawn.idKind, drawn.id) ? [] : ["<id>"]),
	...Arr.flatMap(FLAGS, ([flag, domain]) =>
		Arr.some(
			drawn.given,
			(given) => given.flag === flag && Arr.some(given.values, (value) => !admits(domain, value))
		)
			? [`--${flag}`]
			: []
	)
]

/** The same line with every refused value replaced by `x`, which every checked domain refuses as well. */
const sentinelTwin = (drawn: Line): Line => ({
	...drawn,
	id: admits(drawn.idKind, drawn.id) ? drawn.id : "x",
	given: Arr.map(drawn.given, (given) => ({
		...given,
		values: Arr.map(given.values, (value) => (admits(domainOf(given.flag), value) ? value : "x"))
	}))
})

/** What the model expects of one line. */
type Expected =
	| Readonly<{ kind: "help" }>
	| Readonly<{ kind: "version" }>
	| Readonly<{ kind: "unparsed" }>
	| Readonly<{ kind: "refused"; first: string }>
	| Readonly<{ kind: "accepted"; values: HandedValues; notices: string }>

/** What the handler receives: the fields of the entry command's input. */
type HandedValues = Readonly<{
	id: string
	p: Option.Option<string>
	limit: Option.Option<string>
	ratio: Option.Option<string>
	ids: ReadonlyArray<string>
	total: Option.Option<Input.JsonNumber>
	old: Option.Option<string>
	olds: ReadonlyArray<string>
	quiet: Option.Option<boolean>
	password: Option.Option<string>
	avatar: Option.Option<string>
}>

const valuesOf = (drawn: Line, flag: FlagName): ReadonlyArray<string> =>
	Arr.flatMap(drawn.given, (given) => (given.flag === flag ? given.values : []))

const single = (drawn: Line, flag: FlagName): Option.Option<string> =>
	Arr.head(valuesOf(drawn, flag))

const isGiven = (drawn: Line, flag: FlagName): boolean =>
	Arr.some(drawn.given, (given) => given.flag === flag)

const notice = (label: string): string => `Notice: the parameter ${label} is deprecated\n`

/** The model's verdict: built-ins first, then the lexer, then each value's check, then what the handler gets. */
const expectedOf = (drawn: Line): Expected => {
	if (Option.isSome(drawn.builtIn)) {
		switch (drawn.builtIn.value) {
			case "--help":
				return { kind: "help" }
			case "--version":
				return { kind: "version" }
			case "-h":
			case "-v":
				return { kind: "unparsed" }
		}
	}
	if (!Arr.every(tokenValues(drawn), lexedAsValue)) {
		return { kind: "unparsed" }
	}
	const refused = refusedOf(drawn)
	if (Arr.isReadonlyArrayNonEmpty(refused)) {
		return { kind: "refused", first: Arr.headNonEmpty(refused) }
	}
	return {
		kind: "accepted",
		values: {
			id: drawn.id,
			p: single(drawn, "p"),
			limit: single(drawn, "limit"),
			ratio: single(drawn, "ratio"),
			ids: valuesOf(drawn, "ids"),
			total: Option.map(single(drawn, "total"), (text) => new Input.JsonNumber(text)),
			old: single(drawn, "old"),
			olds: valuesOf(drawn, "olds"),
			quiet: isGiven(drawn, "quiet") ? Option.some(true) : Option.none(),
			password: single(drawn, "password-file"),
			avatar: single(drawn, "avatar")
		},
		notices: Arr.join(
			[
				...(drawn.idDeprecated ? [notice("<id>")] : []),
				...Arr.flatMap(FLAGS, ([flag, , , deprecation]) =>
					deprecation === "deprecated" && isGiven(drawn, flag) ? [notice(`--${flag}`)] : []
				)
			],
			""
		)
	}
}

/** The situations a line reaches, read from the sketch and the model's verdict. */
export const lineFeatures = (drawn: Line): ReadonlyArray<LineFeature> => {
	const expected = expectedOf(drawn)
	const accepted = expected.kind === "accepted"
	const refused = expected.kind === "refused"
	const anyValue = (flags: ReadonlyArray<FlagName>, holds: (value: string) => boolean) =>
		Arr.some(
			drawn.given,
			(given) => Arr.contains(flags, given.flag) && Arr.some(given.values, holds)
		)
	const deprecatedGiven = Arr.filter(drawn.given, (given) =>
		Arr.contains(["old", "olds", "quiet"], given.flag)
	)
	const facts: ReadonlyArray<readonly [boolean, LineFeature]> = [
		[
			accepted &&
				anyValue(["limit", "ids", "total"], (value) => Str.replace("-", "")(value).length > 16),
			"an integer past 2^53 handed on"
		],
		[
			accepted &&
				anyValue(
					["ratio"],
					(value) => Str.includes(".")(value) || Str.includes("e")(Str.toLowerCase(value))
				),
			"a number's own text handed on"
		],
		[
			refused && anyValue(["limit", "ids", "total"], (value) => !isIntegerText(value)),
			"an integer near-miss refused"
		],
		[refused && anyValue(["ratio"], (value) => !isNumberText(value)), "a number near-miss refused"],
		[
			refused &&
				Arr.some(
					drawn.given,
					(given) =>
						given.flag === "ids" && given.values.length > 1 && Arr.some(given.values, isIntegerText)
				),
			"a repeated flag refused by one item"
		],
		[
			accepted && Arr.some(drawn.given, (given) => given.flag === "ids" && given.values.length > 1),
			"a repeated flag handed on whole"
		],
		[refused && !admits(drawn.idKind, drawn.id), "an argument refused"],
		[
			Arr.some(
				drawn.given,
				(given) => given.form === "token" && Arr.some(given.values, (value) => !lexedAsValue(value))
			),
			"a dash-led value in its own token"
		],
		[
			accepted &&
				Arr.some(
					drawn.given,
					(given) =>
						given.form === "equals" &&
						Arr.some(given.values, (value) => Str.startsWith("-")(value) && !lexedAsValue(value))
				),
			"a dash-led value after ="
		],
		[
			accepted &&
				Arr.some(
					drawn.given,
					(given) =>
						given.form === "token" &&
						Arr.some(given.values, (value) => Str.startsWith("-")(value) && value !== "-")
				),
			"a negative number in its own token"
		],
		[accepted && deprecatedGiven.length > 0, "a deprecated flag given"],
		[accepted && deprecatedGiven.length > 1, "two deprecated flags given"],
		[accepted && drawn.idDeprecated, "a deprecated argument"],
		[expected.kind === "help", "help requested"],
		[expected.kind === "version", "version requested"],
		[
			Option.exists(drawn.builtIn, (builtIn) => builtIn === "-h" || builtIn === "-v"),
			"a short alias typed"
		]
	]
	return Arr.flatMap(facts, ([holds, feature]) => (holds ? [feature] : []))
}

/** What one run of the entry did: its exit code, what the handler received, and what reached stdout and stderr. */
type Ran = Readonly<{
	exit: number
	seen: ReadonlyArray<HandedValues>
	stdout: string
	stderr: string
}>

const exitCode = (exit: Exit.Exit<unknown, unknown>): number =>
	Exit.isSuccess(exit) ? 0 : Runtime.getErrorExitCode(Cause.squash(exit.cause))

const result = "the command result\n"

const entryCommand = (drawn: Line, seen: Array<HandedValues>) => {
	const id = Input.numericArgument("id", drawn.idKind)
	return Command.make(
		"list",
		{
			id: drawn.idDeprecated ? id.pipe(Input.deprecatedArgument("id")) : id,
			p: Flag.String("p").pipe(Flag.optional),
			limit: Input.numericFlag("limit", "integer").pipe(Flag.optional),
			ratio: Input.numericFlag("ratio", "number").pipe(Flag.optional),
			ids: Input.numericFlag("ids", "integer").pipe(Flag.atLeast(0)),
			total: Input.int64Flag("total").pipe(Flag.optional),
			old: Flag.String("old").pipe(Flag.optional, Input.deprecated("old")),
			olds: Flag.String("olds").pipe(Flag.atLeast(0), Input.deprecated("olds")),
			quiet: Flag.Boolean("quiet").pipe(Flag.optional, Input.deprecated("quiet")),
			password: Input.secretFileFlag("password-file", drawn.passwordHelp),
			avatar: Input.secretPartFlag("avatar", drawn.avatarHelp).pipe(Flag.optional)
		},
		(values) =>
			Effect.gen(function* () {
				const stdio = yield* Stdio.Stdio
				seen.push(values)
				yield* Stream.run(Stream.make(result), stdio.stdout())
			})
	)
}

/**
 * One run of the generated entry's shape (bin.ts and main.ts): the built-in flags without short aliases, the command
 * tree's formatter and presenter, a fresh run record and run credentials, `exitForHelp` inside `finalCatch`; stdout and
 * stderr are recorded whether the Console or Stdio wrote them.
 */
const ran = (drawn: Line) =>
	Effect.suspend(() => {
		const seen: Array<HandedValues> = []
		const stdout: Array<string> = []
		const stderr: Array<string> = []
		const command = entryCommand(drawn, seen)
		const printedLines = { log: stdout, error: stderr }
		return Command.runWith(command, { renderErrors: false, version: "1.2.3" })(argvOf(drawn)).pipe(
			Output.exitForHelp,
			Output.finalCatch([], { envPrefix: "ACME" }),
			Effect.provideService(
				Stdio.Stdio,
				Stdio.make({
					args: Effect.succeed([]),
					stdin: Stream.empty,
					stdout: appendingTo(stdout),
					stderr: appendingTo(stderr)
				})
			),
			Effect.provideServiceEffect(RunCredentials, Ref.make<ReadonlyArray<ScrubEntry>>([])),
			Effect.provideServiceEffect(Output.RunRecord, Ref.make<Output.RunRecordState>({})),
			Effect.provideService(CliOutput.Formatter, Output.formatter(command)),
			Effect.provideService(CliOutput.Presenter, Output.presenter),
			Effect.provideService(CliConfig.CliConfig, CliConfig.make({ builtIns: Output.builtIns })),
			Effect.provideService(Console.Console, recordingConsole(printedLines, "\n")),
			Effect.exit,
			Effect.map((exit): Ran => ({
				exit: exitCode(exit),
				seen,
				stdout: Arr.join(stdout, ""),
				stderr: Arr.join(stderr, "")
			}))
		)
	})

const secretNote = "Read the value from a file or stdin (-); it is never echoed"

const rowRest = (helpText: string, left: string): Option.Option<string> =>
	Option.map(
		Arr.findFirst(Arr.map(Str.split("\n")(helpText), Str.trim), Str.startsWith(`${left} `)),
		(row) => Arr.join(Arr.filter(Str.split(" ")(Str.slice(left.length)(row)), Str.isNonEmpty), " ")
	)

/** The help rows the model expects: each numeric input labelled by its kind, each secret flag by `path|-` and its note. */
const expectedRows = (drawn: Line): ReadonlyArray<readonly [string, string]> => [
	["id", drawn.idKind],
	["--limit", "integer"],
	["--ratio", "number"],
	["--ids", "integer"],
	["--total", "integer"],
	[
		"--password-file",
		`path|- ${Option.match(drawn.passwordHelp, { onNone: () => secretNote, onSome: (text) => `${text} ${secretNote}` })}`
	],
	[
		"--avatar",
		`path|- ${Option.match(drawn.avatarHelp, { onNone: () => secretNote, onSome: (text) => `${text} ${secretNote}` })}`
	]
]

/** The help rows the run printed, read the same way: what follows each row's left column. */
const printedRows = (drawn: Line, helpText: string): ReadonlyArray<readonly [string, string]> =>
	Arr.map(expectedRows(drawn), ([left, expected]) => [
		left,
		Str.includes(" ")(expected)
			? Option.getOrElse(rowRest(helpText, left), () => "")
			: Option.getOrElse(metavarOf(helpText, left), () => "")
	])

/** A whole-number setting the operator gives, by flag or by variable. */
export type Source =
	| "--timeout"
	| "--retries"
	| "--idle-timeout"
	| "ACME_TIMEOUT"
	| "ACME_IDLE_TIMEOUT"

/** One whole-number setting and the text given for it. */
export type Setting = Readonly<{ source: Source; raw: string }>

/** What a setting case reaches. */
export type SettingFeature =
	| "a whole number taken"
	| "leading zeros taken"
	| "past the safe integers refused"
	| "a sign refused"
	| "a negative number refused"
	| "a fraction refused"
	| "zero idle seconds refused"
	| "a variable refused"
	| "a flag refused"

const wholeText: Gen<string> = weighted<string>([
	[3, digits],
	[1, element(["9007199254740991", "9007199254740992", "99999999999999999999", "0", "00"])],
	[3, element(["abc", "1.5", "-1", "+1", "", " 1", "1e2", "0x10", "1_000"])]
])

/** Settings: every source with texts inside and outside each one's domain. */
export const settings: Gen<Setting> = (source) => ({
	source: element([
		"--timeout",
		"--retries",
		"--idle-timeout",
		"ACME_TIMEOUT",
		"ACME_IDLE_TIMEOUT"
	] as const)(source),
	raw: wholeText(source)
})

/** A setting whose text is a whole number behind a sign, which no setting takes. */
const signed: Gen<Setting> = (source) => ({
	...settings(source),
	raw: `${element(["-", "+"] as const)(source)}${int(0, 99)(source)}`
})

/** A setting of a source that takes zero, its text a negative whole number, which a digits check alone refuses. */
const negativeTimed: Gen<Setting> = (source) => ({
	source: element(["--timeout", "--retries", "ACME_TIMEOUT"] as const)(source),
	raw: `-${int(1, 99)(source)}`
})

/**
 * Settings aimed at a whole number of seconds with leading zeros, zero idle seconds, a text past the safe integers, a
 * fraction, a signed number, and a negative number where zero is taken.
 */
export const settingArms = {
	leadingZeros: map(int(1, 99), (n): Setting => ({ source: "--timeout", raw: `00${n}` })),
	zeroIdle: map(element(["--idle-timeout", "ACME_IDLE_TIMEOUT"] as const), (source): Setting => ({
		source,
		raw: "0"
	})),
	pastSafe: map(settings, (drawn): Setting => ({ ...drawn, raw: "9007199254740992" })),
	fraction: map(settings, (drawn): Setting => ({ ...drawn, raw: "1.5" })),
	sign: signed,
	negative: negativeTimed
} as const

const maxSafe = 9_007_199_254_740_991n

/** Whether a source is an idle timeout, which takes 1 or more. */
const isIdle = (source: Source): boolean =>
	source === "--idle-timeout" || source === "ACME_IDLE_TIMEOUT"

/** The model's whole number: ASCII digits only, at most the largest safe integer, and 1 or more for an idle timeout. */
const wholeOf = (setting: Setting): Option.Option<number> => {
	const allDigits = setting.raw.length > 0 && Arr.every(Str.split("")(setting.raw), isDigit)
	if (!allDigits || BigInt(setting.raw) > maxSafe) {
		return Option.none()
	}
	const value = Number(setting.raw)
	return isIdle(setting.source) && value < 1 ? Option.none() : Option.some(value)
}

const messages: Readonly<Record<Source, string>> = {
	"--timeout": "--timeout must be a whole number of seconds, 0 or more",
	"--retries": "--retries must be a whole number",
	"--idle-timeout": "--idle-timeout must be a whole number of seconds, 1 or more",
	ACME_TIMEOUT: "--timeout must be a whole number of seconds, 0 or more",
	ACME_IDLE_TIMEOUT: "ACME_IDLE_TIMEOUT must be a whole number of seconds, 1 or more"
}

/** What a setting reads as: the whole number, or the one message naming its source and never the text. */
export type SettingRead =
	| Readonly<{ kind: "taken"; value: number }>
	| Readonly<{ kind: "refused"; message: string }>
	| Readonly<{ kind: "unset" }>

/** Whether a source is a variable, read through the platform's env provider rather than parsed as a flag. */
const isVariable = (source: Source): boolean =>
	source === "ACME_TIMEOUT" || source === "ACME_IDLE_TIMEOUT"

/**
 * What a variable left unset reads as (design: without one, an attempt waits as long as its server takes, and so does a
 * body): no timeout is an untimed attempt, 0, and no idle timeout is unset.
 */
const unsetRead = (source: Source): SettingRead =>
	source === "ACME_TIMEOUT" ? { kind: "taken", value: 0 } : { kind: "unset" }

/**
 * The model's reading of a setting. The platform's env provider reads a variable set to the empty string as unset, so
 * an empty variable is no text to refuse; an empty flag is a value given, and refused.
 */
export const expectedSetting = (setting: Setting): SettingRead =>
	isVariable(setting.source) && setting.raw === ""
		? unsetRead(setting.source)
		: Option.match(wholeOf(setting), {
				onNone: (): SettingRead => ({ kind: "refused", message: messages[setting.source] }),
				onSome: (value): SettingRead => ({ kind: "taken", value })
			})

/** The situations a setting case reaches. */
export const settingFeatures = (setting: Setting): ReadonlyArray<SettingFeature> => {
	const taken = Option.isSome(wholeOf(setting))
	const refused = expectedSetting(setting).kind === "refused"
	const variable = isVariable(setting.source)
	const facts: ReadonlyArray<readonly [boolean, SettingFeature]> = [
		[taken, "a whole number taken"],
		[taken && Str.startsWith("0")(setting.raw) && setting.raw.length > 1, "leading zeros taken"],
		[
			refused && setting.raw.length > 15 && Arr.every(Str.split("")(setting.raw), isDigit),
			"past the safe integers refused"
		],
		[
			refused && (Str.startsWith("-")(setting.raw) || Str.startsWith("+")(setting.raw)),
			"a sign refused"
		],
		[
			refused && Str.startsWith("-")(setting.raw) && !isIdle(setting.source),
			"a negative number refused"
		],
		[refused && Str.includes(".")(setting.raw), "a fraction refused"],
		[refused && setting.raw === "0", "zero idle seconds refused"],
		[refused && variable, "a variable refused"],
		[refused && !variable, "a flag refused"]
	]
	return Arr.flatMap(facts, ([holds, feature]) => (holds ? [feature] : []))
}

const messageOf = (failure: unknown): string => {
	if (Predicate.hasProperty(failure, "userMessage") && Predicate.isString(failure.userMessage)) {
		return failure.userMessage
	}
	return Predicate.hasProperty(failure, "message") && Predicate.isString(failure.message)
		? failure.message
		: "no message"
}

const settled = <A, E, R>(effect: Effect.Effect<A, E, R>, value: (a: A) => Option.Option<number>) =>
	Effect.map(Effect.exit(effect), (exit): SettingRead =>
		Exit.isSuccess(exit)
			? Option.match(value(exit.value), {
					onNone: (): SettingRead => ({ kind: "unset" }),
					onSome: (taken): SettingRead => ({ kind: "taken", value: taken })
				})
			: { kind: "refused", message: messageOf(Cause.squash(exit.cause)) }
	)

/** How the runtime reads a setting: the flag's own parse, or the effective value from the drawn variable. */
export const actualSetting = (setting: Setting) => {
	const parsed = (flag: Flag.Flag<Option.Option<number>>, name: string) =>
		settled(flag.parse({ arguments: [], flags: { [name]: [setting.raw] } }), ([, value]) => value)
	switch (setting.source) {
		case "--timeout":
			return parsed(Client.timeoutSetting.flag, "timeout")
		case "--retries":
			return parsed(Client.retriesSetting.flag, "retries")
		case "--idle-timeout":
			return parsed(Output.idleTimeoutSetting.flag, "idle-timeout")
		case "ACME_TIMEOUT":
			return settled(
				Client.effectiveTimeoutSeconds("ACME").pipe(
					Effect.provideService(
						ConfigProvider.ConfigProvider,
						ConfigProvider.fromEnv({ env: { ACME_TIMEOUT: setting.raw } })
					)
				),
				Option.some
			)
		case "ACME_IDLE_TIMEOUT":
			return settled(
				Output.effectiveIdleTimeoutSeconds("ACME").pipe(
					Effect.provideService(
						ConfigProvider.ConfigProvider,
						ConfigProvider.fromEnv({ env: { ACME_IDLE_TIMEOUT: setting.raw } })
					)
				),
				(value) => value
			)
	}
}

/**
 * The line's run against the model: requested help and version print to stdout and run nothing; a line the lexer
 * reads as flags, or a short alias, is exit 2 and runs nothing; a refused value is exit 2, names the first refused
 * input, and prints exactly what the same line with every refused value replaced prints (so no refused text reaches
 * it); an admitted line hands every value on as typed, prints the result, and one notice per deprecated input given.
 */
export const lineHolds = (drawn: Line) =>
	Effect.gen(function* () {
		const expected = expectedOf(drawn)
		const run = yield* ran(drawn)
		switch (expected.kind) {
			case "help":
				assert.deepEqual([run.exit, run.seen, run.stderr], [0, [], ""])
				assert.deepEqual(printedRows(drawn, run.stdout), expectedRows(drawn))
				assert.deepEqual(
					[Str.includes("USAGE")(run.stdout), Str.includes(Output.dashValueEscape)(run.stdout)],
					[true, true]
				)
				assert.deepEqual(
					[Str.includes(", -h")(run.stdout), Str.includes(", -v")(run.stdout)],
					[false, false]
				)
				return
			case "version":
				assert.deepEqual(
					[run.exit, run.seen, run.stderr, Str.includes("1.2.3")(run.stdout)],
					[0, [], "", true]
				)
				return
			case "unparsed":
				assert.deepEqual([run.exit, run.seen, run.stdout], [2, [], ""])
				return
			case "refused": {
				const twin = yield* ran(sentinelTwin(drawn))
				assert.deepEqual([run.exit, run.seen, run.stdout], [2, [], ""])
				assert.deepEqual(Str.includes(`  ${expected.first}: `)(run.stderr), true)
				assert.deepEqual(run.stderr, twin.stderr)
				return
			}
			case "accepted":
				assert.deepEqual(run, {
					exit: 0,
					seen: [expected.values],
					stdout: result,
					stderr: expected.notices
				})
		}
	})
