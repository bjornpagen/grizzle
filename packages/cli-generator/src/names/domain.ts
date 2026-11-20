import { Array as Arr, Order, Result } from "effect"
import { fixedSafeIdentifier, foldIdentifier } from "#names/fold.ts"
import type { SafeIdentifier } from "#names/fold.ts"
import { suffixedIdentifier } from "#names/plan.ts"

/**
 * The names a cli module imports by name from packages, as [name, module specifier]: the one list
 * the cli emitter writes those imports from and the names plan reserves from.
 */
export const packageImports: readonly (readonly [string, string])[] = [
	["Effect", "effect"],
	["Layer", "effect"],
	["Option", "effect"],
	["Schema", "effect"],
	["Argument", "effect/cli"],
	["Command", "effect/cli"],
	["Flag", "effect/cli"]
]

/**
 * The runtime namespaces a cli module imports, as [name, module path]: the one list the cli
 * emitter writes its imports from and the names plan reserves from.
 */
export const runtimeNamespaces: readonly (readonly [string, string])[] = [
	["Auth", "../runtime/auth.ts"],
	["BaseUrl", "../runtime/base-url.ts"],
	["Describe", "../runtime/describe.ts"],
	["Input", "../runtime/input.ts"],
	["Multipart", "../runtime/multipart.ts"],
	["Negotiate", "../runtime/negotiate.ts"],
	["Output", "../runtime/output.ts"],
	["Serialize", "../runtime/serialize.ts"],
	["Sse", "../runtime/sse.ts"]
]

/**
 * The namespaces `cli/root.ts` imports besides the fixed ones, as [name, module specifier]: the
 * `Groups` runtime namespace and the `Arr` array namespace of the lazy root, and the `Client`
 * runtime namespace whose timeout, retry and verbose settings only the root registers.
 */
export const rootNamespaceImports: readonly (readonly [string, string])[] = [
	["Arr", "effect/Array"],
	["Client", "../runtime/client.ts"],
	["Groups", "../runtime/groups.ts"]
]

/**
 * The names every cli module imports besides its domain schemas and api namespaces: every
 * package import and every runtime namespace. No planned module-level name takes one.
 */
export const fixedNamespaces: ReadonlySet<string> = new Set([
	...Arr.map(packageImports, ([name]) => name),
	...Arr.map(runtimeNamespaces, ([name]) => name)
])

/**
 * The names `cli/root.ts` holds besides the fixed namespaces: its own namespace imports, the
 * `services` layer it defines, the `servers` and `security` tables it reads from
 * `api/servers.ts` and `api/security.ts`, the `credentialFiles` settings it mints once for the
 * root and the `Auth` layer, and the lazy root's `table` of group loaders, `root` function and its
 * `args` and `groups` parameters.
 */
export const rootModuleNames: ReadonlySet<string> = new Set([
	...Arr.map(rootNamespaceImports, ([name]) => name),
	"args",
	"credentialFiles",
	"groups",
	"root",
	"security",
	"servers",
	"services",
	"table"
])

/**
 * The names a group's cli module holds besides the fixed namespaces: the `group` command it exports, which its parent's
 * module reads as `<alias>.group`. The root module exports no `group`, so a root command keeps that name.
 */
export const groupModuleNames: ReadonlySet<string> = new Set(["group"])

/**
 * The one namespace `domain/schemas.ts` imports, as [name, module path]: the runtime's reader library, whose
 * combinators its readers are built of. The domain emitter writes the import from it and the names plan reserves it.
 */
export const domainNamespace = ["Read", "../runtime/read.ts"] as const

/**
 * `domain/schemas.ts` imports `domainNamespace`; a cli module imports the fixed namespaces beside the
 * domain names it reads, and `cli/root.ts` also its own names. Keywords, predefined types and
 * globals never get here: the fold suffixes them with `_`.
 */
const reserved: ReadonlySet<string> = new Set([
	domainNamespace[0],
	...fixedNamespaces,
	...rootModuleNames
])

/** The base of a key with no letters or digits to fold. */
const unnamed = fixedSafeIdentifier("Definition")

/**
 * The export name of every schema key in `domain/schemas.ts`, the one owner of those names: the
 * names plan imports them and the domain emitter checks Effect's output against them. Keys go in
 * code-point order; each folds to Pascal case, and a fold that is reserved (`Schema`, the fixed
 * cli imports, the `cli/root.ts` names) or already taken gets the first
 * free numeric suffix from 2. The same keys always give the same names, whatever their input
 * order.
 */
export const domainIdentifiers = (keys: Iterable<string>): ReadonlyMap<string, SafeIdentifier> => {
	const assigned = new Set<string>()
	const taken = (candidate: string): boolean => reserved.has(candidate) || assigned.has(candidate)
	const identifiers = new Map<string, SafeIdentifier>()
	for (const key of Arr.sort(Arr.dedupe([...keys]), Order.String)) {
		const folded = foldIdentifier(key, "pascal")
		const base = Result.isSuccess(folded) ? folded.success.name : unnamed
		const identifier = taken(base) ? suffixedIdentifier(base, taken) : base
		assigned.add(identifier)
		identifiers.set(key, identifier)
	}

	return identifiers
}
