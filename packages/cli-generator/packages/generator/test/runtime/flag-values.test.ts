/**
 * Every value an operator types reaches the generated CLI's handler exactly as typed, or is refused before the handler
 * runs, with a message that names the input and never its text. An `integer` or `number` flag or argument takes its
 * text unchanged (digits past 2^53, `1.50`, `-2.5e-3`) when the JSON grammar admits it and is exit 2 otherwise, each
 * item of a repeated flag checked; a value that starts with "-" in a token of its own is read as flags, exit 2, while
 * `--flag=-value` carries it; each deprecated flag or argument given writes one stderr notice naming it, however often
 * it repeats, and none when absent; `--help` and `--version` answer on stdout with no short alias, help labelling
 * every numeric input by its kind and every secret-file flag by `path|-` and its never-echoed note. A whole-number
 * setting (`--timeout`, `--retries`, `--idle-timeout`, `<PREFIX>_TIMEOUT`, `<PREFIX>_IDLE_TIMEOUT`) is ASCII digits
 * within the safe integers, an idle timeout 1 or more, and is refused otherwise with its one fixed message.
 */

import { deepStrictEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualSetting,
	expectedSetting,
	type LineFeature,
	lineFeatures,
	lineHolds,
	lines,
	type SettingFeature,
	settingArms,
	settingFeatures,
	settings
} from "#test/runtime/flag-values.fixtures.ts"

/**
 * A command line of the generated entry is handed on, refused, or answered by a built-in exactly as the model says. It
 * replaces 41 example cases (numeric-flag.test.ts's flag, argument and help cases, dash-value.test.ts,
 * deprecated-flag.test.ts); its budget is that count, 41 drawn lines, and up to 48 steered while a situation is unreached.
 */
export const commandLine = property.explore(
	aimed(lines.space, [
		["help requested", lines.help],
		["version requested", lines.version],
		["a short alias typed", lines.alias],
		["an integer past 2^53 handed on", lines.pastSafe],
		["a dash-led value in its own token", lines.dashToken],
		["a dash-led value after =", lines.dashEquals],
		["a repeated flag refused by one item", lines.repeatedRefused],
		["two deprecated flags given", lines.twoDeprecated],
		["an argument refused", lines.argumentRefused]
	]),
	{
		needs: {},
		situations: [
			"an integer past 2^53 handed on",
			"a number's own text handed on",
			"an integer near-miss refused",
			"a number near-miss refused",
			"a repeated flag refused by one item",
			"a repeated flag handed on whole",
			"an argument refused",
			"a dash-led value in its own token",
			"a dash-led value after =",
			"a negative number in its own token",
			"a deprecated flag given",
			"two deprecated flags given",
			"a deprecated argument",
			"help requested",
			"version requested",
			"a short alias typed"
		] satisfies ReadonlyArray<Reached<LineFeature>>,
		check: (_, c: Case<LineFeature>) => (drawn) =>
			Effect.gen(function* () {
				c.noteAll(lineFeatures(drawn))
				yield* lineHolds(drawn)
			}),
		oracle: {
			kind: "specification",
			name: "the entry's command-line contract: JSON grammar per numeric input, the lexer's dash rule, one notice per deprecated input, built-ins on stdout"
		},
		kept: [],
		budget: { runs: 41, steered: 48 },
		kills: [
			{
				file: "packages/generator/src/runtime-src/runtime/input.ts",
				original:
					"Flag.String(name).pipe(\n\t\tFlag.withMetavar(kind),\n\t\tFlag.mapEffect(numericText(kind, (cause) => usage(name, cause)))\n\t)",
				replacement: "Flag.String(name).pipe(Flag.withMetavar(kind))",
				why: "A numeric flag's text is never checked, so `--limit abc` reaches the handler; the property fails (EOCG-EMIT's handoff, mutant 17bf87d53d)."
			},
			{
				file: "packages/generator/src/runtime-src/runtime/input.ts",
				original:
					"Flag.String(name).pipe(\n\t\tFlag.withMetavar(kind),\n\t\tFlag.mapEffect(numericText(kind, (cause) => usage(name, cause)))\n\t)",
				replacement:
					"Flag.String(name).pipe(Flag.mapEffect(numericText(kind, (cause) => usage(name, cause))))",
				why: "A numeric flag's help label is `string`, not its kind; the property fails (EOCG-EMIT's handoff, mutant 67fa9e64ed)."
			},
			{
				file: "packages/generator/src/runtime-src/runtime/input.ts",
				original:
					'Flag.String(name).pipe(\n\t\tFlag.withMetavar("path|-"),\n\t\tFlag.optional,\n\t\tFlag.withDescription(secretHelp(description))\n\t)',
				replacement:
					"Flag.String(name).pipe(Flag.optional, Flag.withDescription(secretHelp(description)))",
				why: "A secret-file flag's help label is `string`, not `path|-`; the property fails (EOCG-EMIT's handoff, mutant 29eb91b5ad)."
			},
			{
				file: "packages/generator/src/runtime-src/runtime/input.ts",
				original:
					'Flag.String(name).pipe(Flag.withMetavar("path|-"), Flag.withDescription(secretHelp(description)))',
				replacement: 'Flag.String(name).pipe(Flag.withMetavar("path|-"))',
				why: "A secret part's flag loses its help, so neither the description nor the never-echoed note is shown; the property fails (EOCG-EMIT's handoff, mutant 1cd3545b30)."
			},
			{
				file: "packages/generator/src/runtime-src/runtime/input.ts",
				original:
					'Flag.String(name).pipe(\n\t\tFlag.withMetavar("integer"),\n\t\tFlag.mapEffect((raw) => jsonNumber(raw, name).pipe(Effect.mapError(asCliError)))\n\t)',
				replacement:
					"Flag.String(name).pipe(Flag.mapEffect((raw) => jsonNumber(raw, name).pipe(Effect.mapError(asCliError))))",
				why: "An int64 field's help label is `string`, not `integer`; the property fails (CATCH's evidence, mutant 240e98be14)."
			},
			{
				file: "packages/generator/src/runtime-src/runtime/input.ts",
				original:
					"numericGrammar[kind](text)\n\t\t\t? Effect.succeed(text)\n\t\t\t: Effect.fail(asCliError(refuse(numericCause[kind])))",
				replacement:
					"numericGrammar[kind](text) ? Effect.fail(asCliError(refuse(numericCause[kind]))) : Effect.succeed(text)",
				why: "The numeric check refuses exactly the texts its grammar admits; the property fails (CATCH's evidence, mutant 64edf154da)."
			},
			{
				file: "packages/generator/src/runtime-src/runtime/input.ts",
				original: "jsonNumberGrammar.test(text)",
				replacement: "false",
				why: "No text is a JSON number, so `--ratio 1.50` is refused; the property fails (CATCH's evidence, mutant e5d8e775a2)."
			},
			{
				file: "packages/generator/src/runtime-src/runtime/input.ts",
				original: `self.pipe(Flag.mapEffect(noticeDeprecated(\`--\${name}\`)))`,
				replacement: "self",
				why: "A deprecated flag given writes no notice; the property fails (CATCH's evidence, mutant 28198e16a8)."
			},
			{
				file: "packages/generator/src/runtime-src/runtime/input.ts",
				original: `self.pipe(Argument.mapEffect(noticeDeprecated(\`<\${name}>\`)))`,
				replacement: "self",
				why: "A deprecated argument given writes no notice; the property fails (CATCH's evidence, mutant 9931060016)."
			},
			{
				file: "packages/generator/src/runtime-src/runtime/input.ts",
				original:
					"(Option.isOption(value) && Option.isNone(value)) || (Arr.isArray(value) && value.length === 0)",
				replacement: "(Option.isOption(value) && Option.isNone(value))",
				why: "An absent repeated deprecated flag, an empty list, writes a notice; the property fails (CATCH's evidence, mutant d42737f007)."
			},
			{
				file: "packages/generator/src/runtime-src/runtime/output.ts",
				original: '\tCliError.isCliError(error) && error._tag === "ShowHelp"',
				replacement: '\tCliError.isCliError(error) && error._tag !== "ShowHelp"',
				why: "Requested help is not the entry's exit 0; the property fails (CATCH's evidence, mutant 2db63a862d)."
			},
			{
				file: "packages/generator/src/runtime-src/runtime/output.ts",
				original: `isRootHelp(doc) ? \`\${text.trimEnd()}\\n\\nFLAG VALUES\\n  \${dashValueEscape}\` : text`,
				replacement: `isRootHelp(doc) ? text : \`\${text.trimEnd()}\\n\\nFLAG VALUES\\n  \${dashValueEscape}\``,
				why: "Root help loses the `--flag=-value` escape line; the property fails (CATCH's evidence, mutant 4a18350196)."
			},
			{
				file: "packages/generator/src/runtime-src/runtime/output.ts",
				original: "yield* Console.log(sanitize(format.formatVersion(event.name, event.version)))",
				replacement: "{}",
				why: "`--version` prints nothing; the property fails (CATCH's evidence, mutant e8a4769f5a)."
			},
			{
				file: "packages/generator/src/runtime-src/runtime/output.ts",
				original: "\t\t\thelp.errors.length === 0\n\t\t\t\t? flushHeldHelp(false)",
				replacement: "\t\t\thelp.errors.length === 1\n\t\t\t\t? flushHeldHelp(false)",
				why: "Help with no parse error fails and help with one succeeds, so `--help` is not exit 0; the property fails (CATCH's evidence, mutant 9e7135dcd6)."
			}
		]
	}
)

/**
 * A whole-number setting is taken as its number or refused with its one message, from the flag or the variable. It
 * replaces 14 example cases (numeric-flag.test.ts's whole-number messages); its budget is that count, 14 drawn
 * settings, and up to 16 steered while a situation is unreached.
 */
export const wholeNumbers = property.explore(
	aimed(settings, [
		["leading zeros taken", settingArms.leadingZeros],
		["zero idle seconds refused", settingArms.zeroIdle],
		["past the safe integers refused", settingArms.pastSafe],
		["a fraction refused", settingArms.fraction]
	]),
	{
		needs: {},
		situations: [
			"a whole number taken",
			"leading zeros taken",
			"past the safe integers refused",
			"a sign refused",
			"a fraction refused",
			"zero idle seconds refused",
			"a variable refused",
			"a flag refused"
		] satisfies ReadonlyArray<Reached<SettingFeature>>,
		check: (_, c: Case<SettingFeature>) => (setting) =>
			Effect.gen(function* () {
				c.noteAll(settingFeatures(setting))
				const read = yield* actualSetting(setting)
				deepStrictEqual(read, expectedSetting(setting))
			}),
		oracle: {
			kind: "specification",
			name: "ASCII digits within the safe integers (1 or more for an idle timeout), else the setting's one message"
		},
		kept: [],
		budget: { runs: 14, steered: 16 },
		kills: [
			{
				file: "packages/generator/src/runtime-src/runtime/client.ts",
				original: "Schema.isPattern(/^\\d+$/u)",
				replacement: "Schema.isPattern(/^-?\\d+$/u)",
				why: "A signed text passes the digits check, so `--timeout -1` is taken as -1 seconds; the property fails."
			},
			{
				file: "packages/generator/src/runtime-src/runtime/output.ts",
				original: "(seconds) => seconds >= 1,",
				replacement: "(seconds) => seconds >= 0,",
				why: "An idle timeout of 0 seconds is taken, so every body read times out at once; the property fails."
			}
		]
	}
)
