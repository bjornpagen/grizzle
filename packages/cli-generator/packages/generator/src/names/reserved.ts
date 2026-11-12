/** Effect's built-in global flags a generated CLI keeps, with their one-letter forms. */
const builtInFlags: readonly string[] = ["completions", "h", "help", "log-level", "v", "version"]

const runtimeFlags: readonly string[] = [
	"accept",
	"allow-credentials-for-base-url",
	"base-url",
	"body",
	"body-file",
	"content-type",
	"describe",
	"dry-run",
	"error-format",
	"follow",
	"force",
	"idle-timeout",
	"max-error-bytes",
	"max-record-bytes",
	"output",
	"raw",
	"retries",
	"retry-unsafe",
	"server",
	"server-variable",
	"timeout",
	"verbose"
]

/**
 * The boolean flags: Effect negates every boolean flag as `no-<name>` and throws on a duplicate,
 * so each boolean's negation is reserved with it. Built-ins negate on their long names only.
 */
const booleanNames: readonly string[] = [
	"allow-credentials-for-base-url",
	"describe",
	"dry-run",
	"follow",
	"force",
	"help",
	"raw",
	"retry-unsafe",
	"verbose",
	"version"
]

/**
 * Flag names a specification may not claim (design 4.4): Effect's built-in flags, the runtime's
 * flags (including those not yet emitted, so later milestones rename nothing) and every
 * `no-<boolean>` negation. Flags and commands are two namespaces: a `--flag` token and a command
 * token never meet in effect/cli's parsing, and negation exists only for flags, so these names are
 * held against body, parameter and credential flags only, never against a group or command name.
 * `<scheme>-file` flags depend on the specification and are not listed here.
 */
export const reservedFlagNames: ReadonlySet<string> = new Set([
	...builtInFlags,
	...runtimeFlags,
	...booleanNames.map((name) => `no-${name}`)
])

/**
 * Group and command names a specification may not claim (design 4.4): the words an operator types
 * for the CLI's own help, version and completions. They are held against group and command names
 * only; an operation that folds to a runtime flag's name, such as `follow` or `timeout`, is a
 * command like any other.
 */
export const reservedCommandNames: ReadonlySet<string> = new Set(["completions", "help", "version"])

/**
 * The reserved environment names after `<PREFIX>_` (design 4.4). The per-scheme mutual TLS
 * names `<PREFIX>_<SCHEME>_CERT|KEY|CA` depend on the specification and are not listed here.
 */
export const reservedEnvSuffixes: readonly string[] = [
	"BASE_URL",
	"ERROR_FORMAT",
	"IDLE_TIMEOUT",
	"TIMEOUT"
]

/**
 * Words generated identifiers must not take (design 4.4): ECMAScript reserved, strict-mode and
 * contextual words, the literals, TypeScript keywords and predefined type names, CommonJS
 * names, and the JavaScript globals that schema names commonly fold to.
 */
export const reservedIdentifiers: ReadonlySet<string> = new Set([
	"abstract",
	"accessor",
	"AggregateError",
	"any",
	"arguments",
	"Array",
	"ArrayBuffer",
	"as",
	"assert",
	"asserts",
	"async",
	"Atomics",
	"await",
	"BigInt",
	"bigint",
	"BigInt64Array",
	"BigUint64Array",
	"Boolean",
	"boolean",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"DataView",
	"Date",
	"debugger",
	"declare",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"Error",
	"eval",
	"EvalError",
	"export",
	"exports",
	"extends",
	"false",
	"finally",
	"Float32Array",
	"Float64Array",
	"for",
	"from",
	"Function",
	"function",
	"get",
	"global",
	"globalThis",
	"if",
	"implements",
	"import",
	"in",
	"infer",
	"Infinity",
	"instanceof",
	"Int16Array",
	"Int32Array",
	"Int8Array",
	"interface",
	"Intl",
	"intrinsic",
	"is",
	"JSON",
	"keyof",
	"let",
	"Map",
	"Math",
	"module",
	"namespace",
	"NaN",
	"never",
	"new",
	"null",
	"Number",
	"number",
	"Object",
	"object",
	"of",
	"Omit",
	"out",
	"override",
	"package",
	"Partial",
	"Pick",
	"private",
	"Promise",
	"protected",
	"Proxy",
	"public",
	"RangeError",
	"Readonly",
	"readonly",
	"Record",
	"ReferenceError",
	"Reflect",
	"RegExp",
	"require",
	"Required",
	"return",
	"satisfies",
	"Set",
	"set",
	"SharedArrayBuffer",
	"static",
	"String",
	"string",
	"super",
	"switch",
	"Symbol",
	"symbol",
	"SyntaxError",
	"this",
	"throw",
	"true",
	"try",
	"type",
	"TypeError",
	"typeof",
	"Uint16Array",
	"Uint32Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"undefined",
	"unique",
	"unknown",
	"URIError",
	"URL",
	"URLSearchParams",
	"var",
	"void",
	"WeakMap",
	"WeakRef",
	"WeakSet",
	"while",
	"with",
	"yield"
])

/**
 * Windows device names, upper case; a file segment is compared case-insensitively.
 */
export const windowsDeviceNames: ReadonlySet<string> = new Set([
	"AUX",
	"CON",
	"NUL",
	"PRN",
	...Array.from({ length: 10 }, (_, digit) => `COM${digit}`),
	...Array.from({ length: 10 }, (_, digit) => `LPT${digit}`)
])
