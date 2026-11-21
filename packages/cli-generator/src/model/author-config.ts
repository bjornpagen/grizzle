import type { Json } from "@bjornpagen/grizzle-text/utf8"
import { regex } from "arkregex"
import {
	Array as Arr,
	Data,
	Effect,
	Option,
	Predicate,
	Record,
	Result,
	String as Str
} from "effect"
import type { Brand } from "effect"
import { isDocumentUri } from "#model/brands.ts"
import type { DocumentUri } from "#model/brands.ts"
import { makeDiagnostic, sortDiagnostics } from "#model/diagnostic.ts"
import type { Diagnostic } from "#model/diagnostic.ts"
import { isJson } from "#model/json-tree.ts"
import type { JsonObject } from "#model/json-tree.ts"
import { formatPointer, isJsonPointer, nonEmptyPointerPattern } from "#model/pointer.ts"
import {
	all,
	anything,
	array,
	boolean,
	check,
	member,
	members,
	optionalMember,
	record,
	refine,
	string,
	struct
} from "#runtime/read.ts"
import type { Reader, ReadIssue, ReadIssues, Refusal } from "#runtime/read.ts"

const binNamePattern = regex("^[a-z][a-z0-9-]*$", "u")

/**
 * The command a generated package installs: a lowercase letter, then lowercase letters, digits and
 * hyphens.
 */
export type BinName = string & Brand.Brand<"BinName">

const isBinName = (value: unknown): value is BinName =>
	Predicate.isString(value) && binNamePattern.test(value)

const environmentNamePattern = regex("^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$", "u")

const parameterKeyPattern = regex("^(?:cookie|header|path|query):.+$", "u")

const flagNamePattern = regex(
	"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$",
	"u"
)

/**
 * A flag name as the kebab fold writes one: dot-separated kebab segments, each led by a letter.
 */
export type FlagName = string & Brand.Brand<"FlagName">

const isFlagName = (value: unknown): value is FlagName =>
	Predicate.isString(value) && flagNamePattern.test(value)

const rowId = "CFG-1"

/**
 * A semver 2.0.0 version core number: no leading zero.
 */
const semverNumber = "(?:0|[1-9]\\d*)"

/**
 * A semver 2.0.0 pre-release identifier: a number with no leading zero, or alphanumerics and
 * hyphens with at least one non-digit.
 */
const semverPreRelease = "(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)"

/**
 * A semver 2.0.0 build identifier: alphanumerics and hyphens.
 */
const semverBuild = "[0-9a-zA-Z-]+"

/**
 * semver 2.0.0 (semver.org), whose grammar is visible ASCII with no whitespace, so the version is
 * safe as a header value and an emitted literal. arkregex cannot infer a pattern this deep (its
 * type-level parse is circular to TypeScript), so it is typed as matching any string.
 */
const semverPattern = regex.as(
	`^${semverNumber}\\.${semverNumber}\\.${semverNumber}(?:-${semverPreRelease}(?:\\.${semverPreRelease})*)?(?:\\+${semverBuild}(?:\\.${semverBuild})*)?$`,
	"u"
)

/**
 * A version as semver 2.0.0 writes one (`semverPattern`).
 */
export type PackageVersion = string & Brand.Brand<"PackageVersion">

const isPackageVersion = (value: unknown): value is PackageVersion =>
	Predicate.isString(value) && semverPattern.test(value)

/**
 * `commands.module`: a path relative to the package root that stays inside it, `./` then plain
 * segments, no `.`, `..` or empty segment, no absolute path, no backslash.
 */
export type CommandsModule = string & Brand.Brand<"CommandsModule">

const isCommandsModule = (value: unknown): value is CommandsModule => {
	if (!Predicate.isString(value)) {
		return false
	}
	const [lead, ...rest] = Str.split(value, "/")

	return (
		lead === "." &&
		rest.length > 0 &&
		!Str.includes("\\")(value) &&
		Arr.every(rest, (part) => part !== "" && part !== "." && part !== "..")
	)
}

/**
 * The Security Scheme Object subset an author may add (D-OQ3 (b)); normalization refuses a type
 * or scheme the runtime cannot send exactly as it does a declared one.
 */
export interface AddedScheme {
	readonly deprecated?: boolean
	readonly flows?: JsonObject
	readonly in?: string
	readonly name?: string
	readonly scheme?: string
	readonly type: string
}

/**
 * What `security.add` adds (D-OQ3 (b)): its schemes, by name, and the requirement naming them.
 */
export interface AddedSecurity {
	readonly requirement: ReadonlyArray<Readonly<Record<string, ReadonlyArray<string>>>>
	readonly schemes: Readonly<Record<string, AddedScheme>>
}

/**
 * The environment variable a declared scheme's credential is read from (D-AD11).
 */
export interface CredentialVariable {
	readonly env: string
}

/**
 * `security` as the generator reads it: `add`, the scheme and requirement an author adds (D-OQ3
 * (b)), apart from `credentials`, every other key of the config's `security`, each a declared
 * scheme's name with its credential environment variable (D-AD11); so no scheme is named `add`.
 */
export interface AuthorSecurity {
	readonly add?: AddedSecurity
	readonly credentials: Readonly<Record<string, CredentialVariable>>
}

/**
 * An alias group, like the naming extensions' group keys (design 4.4): a dotted string split at
 * `.`, or an array whose elements are kept whole; no segment is empty.
 */
export type AliasGroup = string | Arr.NonEmptyReadonlyArray<string>

/**
 * One alias command for an operation, named like the extension keys: by a group, with or without
 * a method, or by a method alone.
 */
export type ConfigAlias =
	| { readonly group: AliasGroup; readonly method?: string }
	| { readonly group?: never; readonly method: string }

/**
 * A renamed body field's flag.
 */
export interface FieldOverride {
	readonly flag: FlagName
}

/**
 * A renamed parameter's flag.
 */
export interface ParameterOverride {
	readonly flag?: string
}

/**
 * The naming an author gives one operation. `aliases` replaces the operation's `x-forge-aliases`;
 * an empty list drops them.
 */
export interface OperationOverride {
	readonly aliases?: ReadonlyArray<ConfigAlias>
	readonly command?: string
	/**
	 * Renames a body field's flag, keyed by the field's pointer relative to the body root.
	 */
	readonly fields?: Readonly<Record<string, FieldOverride>>
	readonly group?: string
	readonly parameters?: Readonly<Record<string, ParameterOverride>>
	readonly skip?: boolean
}

/**
 * The author config (design 4.8, D-AD11); `decodeAuthorConfig` is the only constructor. Overrides
 * are keyed by `operationId`, or by JSON Pointer for operations that have none.
 */
export interface AuthorConfig {
	readonly acceptedOrigins?: ReadonlyArray<DocumentUri>
	readonly allowInsecure?: boolean
	readonly binName: BinName
	readonly commands?: { readonly module: CommandsModule; readonly names: ReadonlyArray<string> }
	readonly envPrefix?: string
	readonly naming?: {
		readonly byPointer?: Readonly<Record<string, OperationOverride>>
		readonly operations?: Readonly<Record<string, OperationOverride>>
	}
	/**
	 * Opt-in switches for behavior outside the OpenAPI specification (D-AD11, D-OQ1), each separate
	 * and never inferred from the other: `deepObjectBrackets` for nested members in the bracket
	 * convention, `deepObjectScalars` for a scalar `deepObject` value as `name=value` (design 6.1
	 * Scalar switch). Absent and `false` both mean strict.
	 */
	readonly nonStandard?: {
		readonly deepObjectBrackets?: boolean
		readonly deepObjectScalars?: boolean
	}
	readonly package: { readonly name: string; readonly version: PackageVersion }
	readonly retrievalUri?: DocumentUri
	readonly security?: AuthorSecurity
	readonly servers?: { readonly accepted: ReadonlyArray<string> }
}

/**
 * The author config was refused; every diagnostic is a `document`-scope refusal, sorted by pointer.
 */
class AuthorConfigRefused extends Data.TaggedError("AuthorConfigRefused")<{
	readonly diagnostics: ReadonlyArray<Diagnostic>
}> {}

/**
 * Where the config was read from and, when known, the folded `info.title` that a missing `binName`
 * hint suggests.
 */
export interface AuthorConfigContext {
	readonly document: DocumentUri
	readonly foldedTitle?: string
}

/**
 * The rules a refusal names after `CFG-1/` (design 4.8).
 */
const rules = [
	"invalid-bin-name",
	"invalid-field-flag",
	"invalid-field-pointer",
	"invalid-version",
	"invalid-value",
	"missing-bin-name",
	"missing-key",
	"unknown-key",
	"unsafe-commands-module",
	"unsupported-key"
] as const

type Rule = (typeof rules)[number]

/**
 * The reason a reader of this module gives the keyword it refuses for: the rule the value breaks.
 */
const because = (rule: Rule): string => rule

/**
 * A refusal at the read value's own place, for `rule`.
 */
const refusedFor = (rule: Rule): Result.Result<never, ReadIssues> =>
	Result.fail([{ path: [], refusal: { _tag: "Keyword", reason: because(rule) } }])

/**
 * A member that is present only when it was read: `{ [key]: value }`, or no member.
 */
const present = <K extends string, A>(
	key: K,
	value: Option.Option<A>
): { readonly [Key in K]?: A } =>
	Option.match(value, { onNone: () => ({}), onSome: (read) => Record.singleton(key, read) })

const nonEmptyText = check(string, Str.isNonEmpty, because("invalid-value"))

const documentUri = refine(string, isDocumentUri, because("invalid-value"))

const json = refine(anything, isJson, because("invalid-value"))

const environmentName = check(
	string,
	(name) => environmentNamePattern.test(name),
	because("invalid-value")
)

/**
 * A key the map does not admit is a stray key, refused under `rule`.
 */
const keyWhere = (admits: (key: string) => boolean, rule: Rule): Reader<string> =>
	check(string, admits, because(rule))

/**
 * A dotted alias group admits no empty segment.
 */
const dottedGroup = check(
	string,
	(group) => Arr.every(Str.split(group, "."), Str.isNonEmpty),
	because("invalid-value")
)

const groupList = refine(array(nonEmptyText), Arr.isReadonlyArrayNonEmpty, because("invalid-value"))

const aliasGroup: Reader<AliasGroup> = (value) =>
	Arr.isArray(value) ? groupList(value) : dottedGroup(value)

const configAlias: Reader<ConfigAlias> = (value) =>
	Result.flatMap(members(value), (object) =>
		Result.flatMap(
			struct(
				object,
				{
					group: optionalMember(object, "group", aliasGroup),
					method: optionalMember(object, "method", nonEmptyText)
				},
				false
			),
			({ group, method }): Result.Result<ConfigAlias, ReadIssues> =>
				Option.match(group, {
					onNone: () =>
						Option.match(method, {
							onNone: () => refusedFor("invalid-value"),
							onSome: (named) => Result.succeed({ method: named })
						}),
					onSome: (grouped) => Result.succeed({ group: grouped, ...present("method", method) })
				})
		)
	)

const fieldOverride: Reader<FieldOverride> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{ flag: member(object, "flag", refine(anything, isFlagName, because("invalid-field-flag"))) },
			false
		)
	)

const parameterOverride: Reader<ParameterOverride> = (value) =>
	Result.flatMap(members(value), (object) =>
		Result.map(
			struct(object, { flag: optionalMember(object, "flag", nonEmptyText) }, false),
			(read) => present("flag", read.flag)
		)
	)

const operationOverride: Reader<OperationOverride> = (value) =>
	Result.flatMap(members(value), (object) =>
		Result.map(
			struct(
				object,
				{
					aliases: optionalMember(object, "aliases", array(configAlias)),
					command: optionalMember(object, "command", nonEmptyText),
					fields: optionalMember(
						object,
						"fields",
						record(
							keyWhere((pointer) => nonEmptyPointerPattern.test(pointer), "invalid-field-pointer"),
							fieldOverride
						)
					),
					group: optionalMember(object, "group", nonEmptyText),
					parameters: optionalMember(
						object,
						"parameters",
						record(
							keyWhere((key) => parameterKeyPattern.test(key), "unknown-key"),
							parameterOverride
						)
					),
					skip: optionalMember(object, "skip", boolean)
				},
				false
			),
			(read) => ({
				...present("aliases", read.aliases),
				...present("command", read.command),
				...present("fields", read.fields),
				...present("group", read.group),
				...present("parameters", read.parameters),
				...present("skip", read.skip)
			})
		)
	)

const naming: Reader<NonNullable<AuthorConfig["naming"]>> = (value) =>
	Result.flatMap(members(value), (object) =>
		Result.map(
			struct(
				object,
				{
					byPointer: optionalMember(
						object,
						"byPointer",
						record(keyWhere(isJsonPointer, "unknown-key"), operationOverride)
					),
					operations: optionalMember(
						object,
						"operations",
						record(keyWhere(Str.isNonEmpty, "unknown-key"), operationOverride)
					)
				},
				false
			),
			(read) => ({
				...present("byPointer", read.byPointer),
				...present("operations", read.operations)
			})
		)
	)

const addedScheme: Reader<AddedScheme> = (value) =>
	Result.flatMap(members(value), (object) =>
		Result.map(
			struct(
				object,
				{
					deprecated: optionalMember(object, "deprecated", boolean),
					flows: optionalMember(object, "flows", record(string, json)),
					in: optionalMember(object, "in", string),
					name: optionalMember(object, "name", string),
					scheme: optionalMember(object, "scheme", string),
					type: member(object, "type", string)
				},
				false
			),
			(read) => ({
				...present("deprecated", read.deprecated),
				...present("flows", read.flows),
				...present("in", read.in),
				...present("name", read.name),
				...present("scheme", read.scheme),
				type: read.type
			})
		)
	)

const addedSecurity: Reader<AddedSecurity> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				requirement: member(object, "requirement", array(record(string, array(string)))),
				schemes: member(
					object,
					"schemes",
					record(keyWhere(Str.isNonEmpty, "unknown-key"), addedScheme)
				)
			},
			false
		)
	)

const credentialVariable: Reader<CredentialVariable> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(object, { env: member(object, "env", environmentName) }, false)
	)

/**
 * `security`: `add`, and every other key a credential's scheme.
 */
const security: Reader<AuthorSecurity> = (value) =>
	Result.flatMap(members(value), (object) =>
		Result.map(
			all({
				add: optionalMember(object, "add", addedSecurity),
				credentials: record(
					keyWhere(Str.isNonEmpty, "unknown-key"),
					credentialVariable
				)(Record.remove(object, "add"))
			}),
			(read) => ({ ...present("add", read.add), credentials: read.credentials })
		)
	)

const commands: Reader<NonNullable<AuthorConfig["commands"]>> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				module: member(
					object,
					"module",
					refine(anything, isCommandsModule, because("unsafe-commands-module"))
				),
				names: member(object, "names", array(nonEmptyText))
			},
			false
		)
	)

const nonStandard: Reader<NonNullable<AuthorConfig["nonStandard"]>> = (value) =>
	Result.flatMap(members(value), (object) =>
		Result.map(
			struct(
				object,
				{
					deepObjectBrackets: optionalMember(object, "deepObjectBrackets", boolean),
					deepObjectScalars: optionalMember(object, "deepObjectScalars", boolean)
				},
				false
			),
			(read) => ({
				...present("deepObjectBrackets", read.deepObjectBrackets),
				...present("deepObjectScalars", read.deepObjectScalars)
			})
		)
	)

const authorPackage: Reader<AuthorConfig["package"]> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				name: member(object, "name", nonEmptyText),
				version: member(
					object,
					"version",
					refine(anything, isPackageVersion, because("invalid-version"))
				)
			},
			false
		)
	)

const servers: Reader<NonNullable<AuthorConfig["servers"]>> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(object, { accepted: member(object, "accepted", array(nonEmptyText)) }, false)
	)

/**
 * A key the design names but this release does not consume: refused, not ignored.
 */
const unsupported: Reader<never> = () => refusedFor("unsupported-key")

/**
 * `binName`, whose absence is a rule of its own.
 */
const binNameOf = (object: Readonly<Record<string, unknown>>): Result.Result<BinName, ReadIssues> =>
	Result.flatMap(
		optionalMember(object, "binName", refine(anything, isBinName, because("invalid-bin-name"))),
		Option.match({
			onNone: () =>
				Result.fail([
					{ path: ["binName"], refusal: { _tag: "Keyword", reason: because("missing-bin-name") } }
				]),
			onSome: Result.succeed
		})
	)

const authorConfig: Reader<AuthorConfig> = (value) =>
	Result.flatMap(members(value), (object) =>
		Result.map(
			struct(
				object,
				{
					acceptedOrigins: optionalMember(object, "acceptedOrigins", array(documentUri)),
					allowInsecure: optionalMember(object, "allowInsecure", boolean),
					assertPatterns: optionalMember(object, "assertPatterns", unsupported),
					binName: binNameOf(object),
					commands: optionalMember(object, "commands", commands),
					envPrefix: optionalMember(object, "envPrefix", environmentName),
					naming: optionalMember(object, "naming", naming),
					nonStandard: optionalMember(object, "nonStandard", nonStandard),
					package: member(object, "package", authorPackage),
					retrievalUri: optionalMember(object, "retrievalUri", documentUri),
					security: optionalMember(object, "security", security),
					servers: optionalMember(object, "servers", servers)
				},
				false
			),
			(read) => ({
				...present("acceptedOrigins", read.acceptedOrigins),
				...present("allowInsecure", read.allowInsecure),
				binName: read.binName,
				...present("commands", read.commands),
				...present("envPrefix", read.envPrefix),
				...present("naming", read.naming),
				...present("nonStandard", read.nonStandard),
				package: read.package,
				...present("retrievalUri", read.retrievalUri),
				...present("security", read.security),
				...present("servers", read.servers)
			})
		)
	)

const messages: Readonly<Record<Rule, string>> = {
	"invalid-bin-name": `binName must match ${binNamePattern.source}.`,
	"invalid-field-flag":
		"A body field flag must be a kebab name such as foo-bar, with dots between nested segments.",
	"invalid-field-pointer":
		"A fields key must be the body field's RFC 6901 pointer from the body root, such as /meta/name.",
	"invalid-value": "An author config value is not valid.",
	"invalid-version": "package.version must be a semver 2.0.0 version such as 1.2.3.",
	"missing-bin-name": "The author config has no binName.",
	"missing-key": "A required author config key is missing.",
	"unknown-key": "The author config has a key this generator does not define.",
	"unsafe-commands-module":
		"commands.module must be ./ followed by plain path segments inside the package.",
	"unsupported-key": "The author config key assertPatterns is not supported in this release."
}

const hintOf = (rule: Rule, context: AuthorConfigContext): string | undefined =>
	rule === "missing-bin-name" && context.foldedTitle !== undefined
		? `The folded info.title is "${context.foldedTitle}"; add "binName": "${context.foldedTitle}" if that is the name you want.`
		: undefined

/**
 * The rule a refusal breaks: a keyword's reason, which every reader here words as its rule; a
 * missing member's, a stray member's, or a value of the wrong kind's.
 */
const ruleOf = (refusal: Refusal): Effect.Effect<Rule> => {
	switch (refusal._tag) {
		case "Keyword":
			return Option.match(
				Arr.findFirst(rules, (rule) => rule === refusal.reason),
				{
					onNone: () =>
						Effect.die(`no reader of the author config refuses for "${refusal.reason}"`),
					onSome: Effect.succeed
				}
			)
		case "Required":
			return Effect.succeed("missing-key")
		case "AdditionalProperties":
			return Effect.succeed("unknown-key")
		case "Type":
		case "Const":
		case "Enum":
		case "AdditionalItems":
		case "False":
		case "Limit":
		case "UniqueItems":
		case "NoAlternative":
		case "ManyAlternatives":
			return Effect.succeed("invalid-value")
	}
}

const diagnose = (issue: ReadIssue, context: AuthorConfigContext): Effect.Effect<Diagnostic> =>
	Effect.flatMap(ruleOf(issue.refusal), (rule) =>
		makeDiagnostic({
			code: `${rowId}/${rule}`,
			document: context.document,
			element: "Author config",
			hint: hintOf(rule, context),
			message: messages[rule],
			openapi: "",
			pointer: formatPointer(Arr.map(issue.path, String)),
			scope: "document",
			severity: "refusal",
			specSection: context.document
		})
	)

/**
 * The refusal of a config for every issue its reading met, in pointer order (design 3.7).
 */
const refusalOf = (
	issues: ReadIssues,
	context: AuthorConfigContext
): Effect.Effect<never, AuthorConfigRefused> =>
	Effect.flatMap(
		Effect.forEach(issues, (issue) => diagnose(issue, context)),
		(diagnostics) =>
			Effect.fail(
				new AuthorConfigRefused({ diagnostics: sortDiagnostics([context.document], diagnostics) })
			)
	)

/**
 * Reads untrusted author config JSON into an `AuthorConfig`, or the refusals that explain why not.
 * Every problem is reported at once; unknown keys are refused.
 */
export const decodeAuthorConfig = Effect.fnUntraced(function* decodeAuthorConfig(
	input: Json,
	context: AuthorConfigContext
): Effect.fn.Return<AuthorConfig, AuthorConfigRefused> {
	return yield* Result.match(authorConfig(input), {
		onFailure: (issues) => refusalOf(issues, context),
		onSuccess: Effect.succeed
	})
})
