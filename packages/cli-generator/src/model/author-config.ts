import { regex } from "arkregex"
import { Array as Arr, Data, Effect, Option, Record, String as Str } from "effect"
import { isDocumentUri } from "#model/brands.ts"
import type { DocumentUri } from "#model/brands.ts"
import { makeDiagnostic, sortDiagnostics } from "#model/diagnostic.ts"
import type { Diagnostic } from "#model/diagnostic.ts"
import { isArray, isObject } from "#model/json-tree.ts"
import type { JsonObject } from "#model/json-tree.ts"
import { formatPointer, isJsonPointer, nonEmptyPointerPattern } from "#model/pointer.ts"
import type { Json } from "#model/pointer.ts"

const binNamePattern = regex("^[a-z][a-z0-9-]*$", "u")

const environmentNamePattern = regex("^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$", "u")

const parameterKeyPattern = regex("^(?:cookie|header|path|query):.+$", "u")

/**
 * A flag name as the kebab fold writes one: dot-separated kebab segments, each led by a letter.
 */
const flagNamePattern = regex(
	"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$",
	"u"
)

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
	readonly flag: string
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
	readonly binName: string
	readonly commands?: { readonly module: string; readonly names: ReadonlyArray<string> }
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
	readonly package: { readonly name: string; readonly version: string }
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

type Rule =
	| "invalid-bin-name"
	| "invalid-field-flag"
	| "invalid-field-pointer"
	| "invalid-version"
	| "invalid-value"
	| "missing-bin-name"
	| "missing-key"
	| "unknown-key"
	| "unsafe-commands-module"
	| "unsupported-key"

/**
 * The reference tokens of a value in the config, from its root.
 */
type Path = ReadonlyArray<string>

/**
 * A refusal as the reader meets it: the rule the value breaks, at the value's tokens.
 */
interface Finding {
	readonly rule: Rule
	readonly path: Path
}

/**
 * Records a refusal and reads nothing: each reader reports every refusal it meets, so a config is
 * refused for all of its problems at once.
 */
type Refuse = (rule: Rule, path: Path) => Option.Option<never>

/**
 * Reads the value at `path` into an `A`: what the value holds, or nothing exactly when the reader
 * refused something in it, so a config reads to nothing exactly when it has a refusal.
 */
type Reader<A> = (value: Json, path: Path, refuse: Refuse) => Option.Option<A>

/**
 * A string `admits` admits; any other value is refused under `rule`.
 */
const textWhere =
	(admits: (text: string) => boolean, rule: Rule): Reader<string> =>
	(value, path, refuse) =>
		typeof value === "string" && admits(value) ? Option.some(value) : refuse(rule, path)

const anyText: Reader<string> = (value, path, refuse) =>
	typeof value === "string" ? Option.some(value) : refuse("invalid-value", path)

const nonEmptyText = textWhere(Str.isNonEmpty, "invalid-value")

const matching = (pattern: RegExp, rule: Rule): Reader<string> =>
	textWhere((candidate) => pattern.test(candidate), rule)

const truthValue: Reader<boolean> = (value, path, refuse) =>
	typeof value === "boolean" ? Option.some(value) : refuse("invalid-value", path)

const anyJson: Reader<Json> = (value) => Option.some(value)

const documentUri: Reader<DocumentUri> = (value, path, refuse) =>
	typeof value === "string" && isDocumentUri(value)
		? Option.some(value)
		: refuse("invalid-value", path)

const environmentName = matching(environmentNamePattern, "invalid-value")

/**
 * `commands.module` is relative to the package root and stays inside it: `./` then plain
 * segments, no `.`, `..` or empty segment, no absolute path, no backslash.
 */
const commandsModule = textWhere((module) => {
	const [lead, ...rest] = Str.split(module, "/")

	return (
		lead === "." &&
		rest.length > 0 &&
		!Str.includes("\\")(module) &&
		Arr.every(rest, (part) => part !== "" && part !== "." && part !== "..")
	)
}, "unsafe-commands-module")

const listOf =
	<A>(item: Reader<A>): Reader<ReadonlyArray<A>> =>
	(value, path, refuse) =>
		isArray(value)
			? Option.all(Arr.map(value, (each, index) => item(each, [...path, `${index}`], refuse)))
			: refuse("invalid-value", path)

const nonEmptyListOf =
	<A>(item: Reader<A>): Reader<Arr.NonEmptyReadonlyArray<A>> =>
	(value, path, refuse) =>
		Option.flatMap(listOf(item)(value, path, refuse), (items) =>
			Arr.isReadonlyArrayNonEmpty(items) ? Option.some(items) : refuse("invalid-value", path)
		)

/**
 * An object whose every key `admits` admits, each member read by `item`; a key it does not admit
 * is refused under `stray`.
 */
const mapOf =
	<A>(
		admits: (key: string) => boolean,
		stray: Rule,
		item: Reader<A>
	): Reader<Readonly<Record<string, A>>> =>
	(value, path, refuse) =>
		isObject(value)
			? Option.map(
					Option.all(
						Arr.map(Record.toEntries(value), ([key, member]) =>
							admits(key)
								? Option.map(item(member, [...path, key], refuse), (read) => [key, read] as const)
								: refuse(stray, [...path, key])
						)
					),
					Record.fromEntries
				)
			: refuse("invalid-value", path)

/**
 * An object of the members `keys` declares, read by `read`; any other key is refused under the rule
 * `stray` gives it, and its members are read all the same, so their refusals are reported too.
 */
const struct =
	<A>(
		keys: ReadonlyArray<string>,
		stray: (key: string) => Rule,
		read: (members: JsonObject, path: Path, refuse: Refuse) => Option.Option<A>
	): Reader<A> =>
	(value, path, refuse) => {
		if (!isObject(value)) {
			return refuse("invalid-value", path)
		}
		const strays = Arr.map(
			Arr.filter(Record.keys(value), (key) => !Arr.contains(keys, key)),
			(key) => refuse(stray(key), [...path, key])
		)
		const members = read(value, path, refuse)

		return Option.flatMap(Option.all(strays), () => members)
	}

const unknownKey = (): Rule => "unknown-key"

/**
 * The member `key` of an object, refused under `missing` when the object has none.
 */
const required = <A>(
	members: JsonObject,
	key: string,
	path: Path,
	refuse: Refuse,
	read: Reader<A>,
	missing: Rule
): Option.Option<A> =>
	Option.match(Record.get(members, key), {
		onNone: () => refuse(missing, [...path, key]),
		onSome: (member) => read(member, [...path, key], refuse)
	})

/**
 * The member `key` of an object when it has one.
 */
const optional = <A>(
	members: JsonObject,
	key: string,
	path: Path,
	refuse: Refuse,
	read: Reader<A>
): Option.Option<Option.Option<A>> =>
	Option.match(Record.get(members, key), {
		onNone: () => Option.some(Option.none()),
		onSome: (member) => Option.map(read(member, [...path, key], refuse), Option.some)
	})

/**
 * A member that is present only when it was read: `{ [key]: value }`, or no member.
 */
const present = <K extends string, A>(
	key: K,
	value: Option.Option<A>
): { readonly [Key in K]?: A } =>
	Option.match(value, { onNone: () => ({}), onSome: (read) => Record.singleton(key, read) })

/**
 * The optional member `key` of an object as the member it is in the read value.
 */
const optionalMember = <K extends string, A>(
	members: JsonObject,
	key: K,
	path: Path,
	refuse: Refuse,
	read: Reader<A>
): Option.Option<{ readonly [Key in K]?: A }> =>
	Option.map(optional(members, key, path, refuse, read), (value) => present(key, value))

/**
 * A dotted alias group admits no empty segment.
 */
const dottedGroup = textWhere(
	(group) => Arr.every(Str.split(group, "."), Str.isNonEmpty),
	"invalid-value"
)

const aliasGroup: Reader<AliasGroup> = (value, path, refuse) =>
	isArray(value)
		? nonEmptyListOf(nonEmptyText)(value, path, refuse)
		: dottedGroup(value, path, refuse)

const configAlias: Reader<ConfigAlias> = (value, path, refuse) =>
	Option.flatMap(
		struct(["group", "method"], unknownKey, (members) =>
			Option.all({
				group: optional(members, "group", path, refuse, aliasGroup),
				method: optional(members, "method", path, refuse, nonEmptyText)
			})
		)(value, path, refuse),
		({ group, method }): Option.Option<ConfigAlias> =>
			Option.match(group, {
				onNone: () =>
					Option.match(method, {
						onNone: () => refuse("invalid-value", path),
						onSome: (named) => Option.some({ method: named })
					}),
				onSome: (grouped) => Option.some({ group: grouped, ...present("method", method) })
			})
	)

const fieldOverride: Reader<FieldOverride> = struct(["flag"], unknownKey, (members, path, refuse) =>
	Option.map(
		required(
			members,
			"flag",
			path,
			refuse,
			matching(flagNamePattern, "invalid-field-flag"),
			"missing-key"
		),
		(flag) => ({ flag })
	)
)

const parameterOverride: Reader<ParameterOverride> = struct(
	["flag"],
	unknownKey,
	(members, path, refuse) => optionalMember(members, "flag", path, refuse, nonEmptyText)
)

const operationOverride: Reader<OperationOverride> = struct(
	["aliases", "command", "fields", "group", "parameters", "skip"],
	unknownKey,
	(members, path, refuse) =>
		Option.map(
			Option.all({
				aliases: optionalMember(members, "aliases", path, refuse, listOf(configAlias)),
				command: optionalMember(members, "command", path, refuse, nonEmptyText),
				fields: optionalMember(
					members,
					"fields",
					path,
					refuse,
					mapOf(
						(pointer) => nonEmptyPointerPattern.test(pointer),
						"invalid-field-pointer",
						fieldOverride
					)
				),
				group: optionalMember(members, "group", path, refuse, nonEmptyText),
				parameters: optionalMember(
					members,
					"parameters",
					path,
					refuse,
					mapOf((key) => parameterKeyPattern.test(key), "unknown-key", parameterOverride)
				),
				skip: optionalMember(members, "skip", path, refuse, truthValue)
			}),
			(read) => ({
				...read.aliases,
				...read.command,
				...read.fields,
				...read.group,
				...read.parameters,
				...read.skip
			})
		)
)

const naming: Reader<NonNullable<AuthorConfig["naming"]>> = struct(
	["byPointer", "operations"],
	unknownKey,
	(members, path, refuse) =>
		Option.map(
			Option.all({
				byPointer: optionalMember(
					members,
					"byPointer",
					path,
					refuse,
					mapOf(isJsonPointer, "unknown-key", operationOverride)
				),
				operations: optionalMember(
					members,
					"operations",
					path,
					refuse,
					mapOf(Str.isNonEmpty, "unknown-key", operationOverride)
				)
			}),
			(read) => ({ ...read.byPointer, ...read.operations })
		)
)

const addedScheme: Reader<AddedScheme> = struct(
	["deprecated", "flows", "in", "name", "scheme", "type"],
	unknownKey,
	(members, path, refuse) =>
		Option.map(
			Option.all({
				deprecated: optionalMember(members, "deprecated", path, refuse, truthValue),
				flows: optionalMember(
					members,
					"flows",
					path,
					refuse,
					mapOf(() => true, "unknown-key", anyJson)
				),
				in: optionalMember(members, "in", path, refuse, anyText),
				name: optionalMember(members, "name", path, refuse, anyText),
				scheme: optionalMember(members, "scheme", path, refuse, anyText),
				type: required(members, "type", path, refuse, anyText, "missing-key")
			}),
			(read) => ({
				...read.deprecated,
				...read.flows,
				...read.in,
				...read.name,
				...read.scheme,
				type: read.type
			})
		)
)

const addedSecurity: Reader<AddedSecurity> = struct(
	["requirement", "schemes"],
	unknownKey,
	(members, path, refuse) =>
		Option.all({
			requirement: required(
				members,
				"requirement",
				path,
				refuse,
				listOf(mapOf(() => true, "unknown-key", listOf(anyText))),
				"missing-key"
			),
			schemes: required(
				members,
				"schemes",
				path,
				refuse,
				mapOf(Str.isNonEmpty, "unknown-key", addedScheme),
				"missing-key"
			)
		})
)

const credentialVariable: Reader<CredentialVariable> = struct(
	["env"],
	unknownKey,
	(members, path, refuse) =>
		Option.map(required(members, "env", path, refuse, environmentName, "missing-key"), (env) => ({
			env
		}))
)

const security: Reader<AuthorSecurity> = (value, path, refuse) =>
	isObject(value)
		? Option.map(
				Option.all({
					add: optionalMember(value, "add", path, refuse, addedSecurity),
					credentials: mapOf(Str.isNonEmpty, "unknown-key", credentialVariable)(
						Record.remove(value, "add"),
						path,
						refuse
					)
				}),
				(read) => ({ ...read.add, credentials: read.credentials })
			)
		: refuse("invalid-value", path)

const commands: Reader<NonNullable<AuthorConfig["commands"]>> = struct(
	["module", "names"],
	unknownKey,
	(members, path, refuse) =>
		Option.all({
			module: required(members, "module", path, refuse, commandsModule, "missing-key"),
			names: required(members, "names", path, refuse, listOf(nonEmptyText), "missing-key")
		})
)

const nonStandard: Reader<NonNullable<AuthorConfig["nonStandard"]>> = struct(
	["deepObjectBrackets", "deepObjectScalars"],
	unknownKey,
	(members, path, refuse) =>
		Option.map(
			Option.all({
				deepObjectBrackets: optionalMember(members, "deepObjectBrackets", path, refuse, truthValue),
				deepObjectScalars: optionalMember(members, "deepObjectScalars", path, refuse, truthValue)
			}),
			(read) => ({ ...read.deepObjectBrackets, ...read.deepObjectScalars })
		)
)

const authorPackage: Reader<AuthorConfig["package"]> = struct(
	["name", "version"],
	unknownKey,
	(members, path, refuse) =>
		Option.all({
			name: required(members, "name", path, refuse, nonEmptyText, "missing-key"),
			version: required(
				members,
				"version",
				path,
				refuse,
				matching(semverPattern, "invalid-version"),
				"missing-key"
			)
		})
)

const servers: Reader<NonNullable<AuthorConfig["servers"]>> = struct(
	["accepted"],
	unknownKey,
	(members, path, refuse) =>
		Option.map(
			required(members, "accepted", path, refuse, listOf(nonEmptyText), "missing-key"),
			(accepted) => ({ accepted })
		)
)

/**
 * Keys the design names but this release does not consume; they are refused, not ignored.
 */
const unsupportedKeys: ReadonlyArray<string> = ["assertPatterns"]

const authorConfig: Reader<AuthorConfig> = struct(
	[
		"acceptedOrigins",
		"allowInsecure",
		"binName",
		"commands",
		"envPrefix",
		"naming",
		"nonStandard",
		"package",
		"retrievalUri",
		"security",
		"servers"
	],
	(key) => (Arr.contains(unsupportedKeys, key) ? "unsupported-key" : "unknown-key"),
	(members, path, refuse) =>
		Option.map(
			Option.all({
				acceptedOrigins: optionalMember(
					members,
					"acceptedOrigins",
					path,
					refuse,
					listOf(documentUri)
				),
				allowInsecure: optionalMember(members, "allowInsecure", path, refuse, truthValue),
				binName: required(
					members,
					"binName",
					path,
					refuse,
					matching(binNamePattern, "invalid-bin-name"),
					"missing-bin-name"
				),
				commands: optionalMember(members, "commands", path, refuse, commands),
				envPrefix: optionalMember(members, "envPrefix", path, refuse, environmentName),
				naming: optionalMember(members, "naming", path, refuse, naming),
				nonStandard: optionalMember(members, "nonStandard", path, refuse, nonStandard),
				package: required(members, "package", path, refuse, authorPackage, "missing-key"),
				retrievalUri: optionalMember(members, "retrievalUri", path, refuse, documentUri),
				security: optionalMember(members, "security", path, refuse, security),
				servers: optionalMember(members, "servers", path, refuse, servers)
			}),
			(read) => ({
				...read.acceptedOrigins,
				...read.allowInsecure,
				binName: read.binName,
				...read.commands,
				...read.envPrefix,
				...read.naming,
				...read.nonStandard,
				package: read.package,
				...read.retrievalUri,
				...read.security,
				...read.servers
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

const diagnose = (finding: Finding, context: AuthorConfigContext): Effect.Effect<Diagnostic> =>
	makeDiagnostic({
		code: `${rowId}/${finding.rule}`,
		document: context.document,
		element: "Author config",
		hint: hintOf(finding.rule, context),
		message: messages[finding.rule],
		openapi: "",
		pointer: formatPointer(finding.path),
		scope: "document",
		severity: "refusal",
		specSection: context.document
	})

/**
 * The refusal of a config for every finding its reading met, in pointer order (design 3.7): the
 * reading meets each value once, so no two findings share a pointer and a rule.
 */
const refusalOf = (
	findings: ReadonlyArray<Finding>,
	context: AuthorConfigContext
): Effect.Effect<never, AuthorConfigRefused> =>
	Effect.flatMap(
		Effect.forEach(findings, (finding) => diagnose(finding, context)),
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
	const findings: Array<Finding> = []
	const read = authorConfig(input, [], (rule, path) => {
		findings.push({ rule, path })
		return Option.none()
	})

	return yield* Option.match(read, {
		onNone: () => refusalOf(findings, context),
		onSome: Effect.succeed
	})
})
