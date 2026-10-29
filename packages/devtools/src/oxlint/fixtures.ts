#!/usr/bin/env -S node

import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Inspectable,
	Option,
	Path,
	Record,
	Result,
	Schema,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RuleTester } from "oxlint/plugins-dev"
import { NO_COMMENT_CASES } from "#oxlint/fixer-cases.ts"
import { FIXTURE_RULES } from "#oxlint/fixture-rules.ts"
import { noComment } from "#oxlint/rules/no-comment.ts"
import { DevtoolFailure } from "#shared/devtool.ts"
import { statusOf } from "#shared/finding.ts"
import { fixtureMismatchesOf, renderFixtureMismatches } from "#shared/fixtures.ts"
import { relativeTo, Repository } from "#shared/repository.ts"
import { runDevtool } from "#shared/run.ts"

/**
 * The plugin's fixtures: oxlint itself, with src/oxlint/fixtures.config.ts, over src/oxlint/fixtures, so each rule
 * runs through the configuration loader, its options' validation and the plugin's loading exactly as a project's
 * oxlint runs it. Every rule's violating fixture marks the lines it must report and its clean fixture draws none.
 * no-comment, whose fixes a marker comment would disturb, runs its cases on oxlint's RuleTester instead.
 */

const PACKAGE_ROOT = `${import.meta.dirname}/../..`
const CONFIG = `${import.meta.dirname}/fixtures.config.ts`
const FIXTURES_ROOT = `${import.meta.dirname}/fixtures`
const PLUGIN = "devtools"

const OxlintReport = Schema.fromJsonString(
	Schema.Struct({
		diagnostics: Schema.Array(
			Schema.Struct({
				message: Schema.String,
				code: Schema.optionalKey(Schema.String),
				filename: Schema.String,
				labels: Schema.Array(Schema.Struct({ span: Schema.Struct({ line: Schema.Finite }) }))
			})
		)
	})
)

const decodeReport = Schema.decodeUnknownEffect(OxlintReport)

/** One diagnostic oxlint reported, at its first label's line when it has one. */
type Reported = Readonly<{
	file: string
	code: Option.Option<string>
	line: Option.Option<number>
	message: string
}>

/** Every fixture is TSX, so a JSX rule and a TypeScript rule read their fixtures alike. */
const EXTENSION = ".tsx"

const ruleCode = (rule: string): string => `${PLUGIN}(${rule})`

/** Whether a diagnostic is the report of `rule` at a line of its own fixture directory. */
const isReportOf = (diagnostic: Reported, rule: string): boolean =>
	Option.contains(diagnostic.code, ruleCode(rule)) &&
	Option.isSome(diagnostic.line) &&
	Str.includes(`/fixtures/${rule}/`)(diagnostic.file)

/** A fixer case its rule disagrees with: the case's code, and what oxlint's RuleTester said. */
type CaseFailure = Readonly<{ name: string; detail: string }>

/** no-comment's cases on oxlint's RuleTester, each case's failure collected instead of thrown, and how many ran. */
const fixerCases = Effect.sync(() => {
	const failures: Array<CaseFailure> = []
	const suites: Array<string> = []
	let ran = 0
	RuleTester.describe = (suite, method) => {
		suites.push(suite)
		method()
		suites.pop()
	}
	RuleTester.it = (name, method) => {
		ran += 1
		const outcome = Result.try({ try: () => method(), catch: (cause) => cause })
		if (Result.isFailure(outcome)) {
			failures.push({
				name: Arr.join([...suites, name], " > "),
				detail: Inspectable.toStringUnknown(outcome.failure)
			})
		}
	}
	new RuleTester().run("no-comment", noComment, NO_COMMENT_CASES)
	return { ran, failures }
})

const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const { root } = yield* Repository
	const rules = Record.keys(FIXTURE_RULES)
	const output = yield* spawner
		.string(
			ChildProcess.make(
				"oxlint",
				["-c", CONFIG, "--format", "json", "--disable-nested-config", FIXTURES_ROOT],
				{ cwd: PACKAGE_ROOT }
			)
		)
		.pipe(Effect.mapError((cause) => DevtoolFailure.make({ detail: "oxlint did not run", cause })))
	const report = yield* decodeReport(output).pipe(
		Effect.mapError((cause) =>
			DevtoolFailure.make({ detail: `oxlint printed no JSON report:\n${output}`, cause })
		)
	)
	const reported = Arr.map(report.diagnostics, (diagnostic): Reported => ({
		file: path.resolve(PACKAGE_ROOT, diagnostic.filename),
		code: Option.fromUndefinedOr(diagnostic.code),
		line: Option.map(Arr.head(diagnostic.labels), (label) => label.span.line),
		message: diagnostic.message
	}))
	const foreign = Arr.filter(
		reported,
		(diagnostic) => !Arr.some(rules, (rule) => isReportOf(diagnostic, rule))
	)
	const texts = yield* Effect.forEach(rules, (rule) =>
		Effect.forEach(["violating", "clean"], (role) => {
			const file = `${FIXTURES_ROOT}/${rule}/${role}${EXTENSION}`
			return Effect.map(Effect.option(fs.readFileString(file)), (text) => [file, text] as const)
		})
	)
	const textOf = new Map(Arr.flatten(texts))
	const mismatches = fixtureMismatchesOf({
		root: FIXTURES_ROOT,
		extensionOf: () => EXTENSION,
		rules,
		runOf: ({ rule, file }) =>
			Option.map(Option.flatten(Option.fromUndefinedOr(textOf.get(file))), (text) => ({
				text,
				reported: Arr.filterMap(reported, (diagnostic) =>
					diagnostic.file === file && isReportOf(diagnostic, rule)
						? Result.fromOption(diagnostic.line, () => undefined)
						: Result.failVoid
				)
			}))
	})
	const cases = yield* fixerCases
	yield* Console.log(
		Arr.join(
			[
				...Arr.map(
					cases.failures,
					(failure) => `no-comment case ${failure.name}\n${failure.detail}`
				),
				`no-comment: ${cases.ran - cases.failures.length} of ${cases.ran} cases agree`,
				...Arr.map(
					foreign,
					(diagnostic) =>
						`${relativeTo(root)(diagnostic.file)}${Option.match(diagnostic.line, {
							onNone: () => "",
							onSome: (line) => `:${line}`
						})} ${Option.match(diagnostic.code, {
							onNone: () => "(no rule)",
							onSome: (code) => code
						})} ${diagnostic.message}`
				),
				renderFixtureMismatches({ tool: "oxlint plugin", root, rules: rules.length, mismatches })
			],
			"\n"
		)
	)
	return statusOf([...cases.failures, ...foreign, ...mismatches])
})

runDevtool(main)
