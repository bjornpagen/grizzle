import {
	Array as Arr,
	Console,
	Context,
	Data,
	Effect,
	Option,
	Order,
	Record as Rec,
	Result
} from "effect"
import type { Command } from "effect/cli"
import { Flag, GlobalFlag } from "effect/cli"
import { Servers } from "#runtime/base-url.ts"
import { indentedJsonText, parseJson } from "#runtime/json.ts"
import type { InvalidJsonText } from "#runtime/json.ts"
import type { MediaDeclaration } from "#runtime/negotiate.ts"
import { anything, array, literal, member, members, string, struct, union } from "#runtime/read.ts"
import type { ReadIssues, Reader } from "#runtime/read.ts"

/**
 * Where a command's value goes on the wire: a parameter's location, or the request body.
 */
export const locations = ["body", "cookie", "header", "path", "query", "querystring"] as const

/**
 * One of the `locations`.
 */
export type Location = (typeof locations)[number]

/**
 * The per-flag binding a generated command declares: where the value goes on the wire.
 */
export type ParameterBinding = {
	readonly location: Location
	readonly pointer: string
	readonly wireName: string
}

/**
 * A constant parameter a generated command sends without a flag: where its value goes, its use
 * site, and the value as JSON text.
 */
export type ConstantBinding = {
	readonly location: Location
	readonly pointer: string
	readonly value: string
	readonly wireName: string
}

/**
 * The structural subset of a command's operation binding that `--describe` reads. The generated
 * operation metadata satisfies it and carries more.
 */
export interface CommandBinding {
	/**
	 * The parameters the command sends as their one value without a flag, empty when there is none.
	 */
	readonly constants: readonly ConstantBinding[]
	readonly operation: {
		readonly media: MediaDeclaration
		readonly method: string
		readonly origin: { readonly document: string; readonly pointer: string }
		readonly pathTemplate: string
		readonly security: readonly (readonly string[])[]
		/**
		 * Present only when the operation or its path item overrides the root servers.
		 */
		readonly servers?: { readonly servers: readonly { readonly url: string }[] }
	}
	readonly parameters: { readonly [flag: string]: ParameterBinding }
}

/**
 * The `Command.annotate` key under which a generated command carries its binding.
 */
export class Binding extends Context.Service<Binding, CommandBinding>()(
	"@bjornpagen/grizzle-cli-generator/runtime-src/runtime/describe/Binding"
) {}

/**
 * A bound command's flag as `--describe` lists it: its binding and its name. The document's
 * records are type aliases, never interfaces, so each is `Schema.Json`, which `indentedJsonText`
 * writes and an interface's missing index signature would refuse.
 */
export type DescribedFlag = ParameterBinding & {
	readonly name: string
}

/**
 * A body property refused at `field` scope, under the request media that holds it.
 */
export type RefusedField = {
	readonly mediaType: string
	readonly name: string
}

/**
 * A bound command as `--describe` lists it, at its path from the root command.
 */
export type DescribedCommand = {
	readonly constants: readonly ConstantBinding[]
	readonly document: string
	readonly flags: readonly DescribedFlag[]
	readonly method: string
	readonly path: readonly string[]
	readonly pathTemplate: string
	readonly pointer: string
	readonly refusedFields: readonly RefusedField[]
	readonly requestMedia: readonly string[]
	readonly responses: readonly string[]
	readonly security: readonly (readonly string[])[]
	readonly servers: readonly string[]
}

/**
 * The version a `--describe` document states, which only gains fields.
 */
const describeVersion = 1

/**
 * The `--describe` document. Fields are alphabetical, and `describeVersion` only gains fields.
 * `requestMedia` and `responses` are the spec's keys as spelled, in order; `security` is the
 * effective requirement's alternatives; `servers` are the effective server URLs (the operation's or
 * path item's override, else the root's from `Servers`, empty when that service is absent).
 * `refusedFields` are the body properties refused at `field` scope, in request media then property
 * order; it is present on every command, empty when none is refused. `constants` are the parameters
 * the command sends as their one value without a flag, in parameter order, empty when there is none.
 */
export type Description = {
	readonly commands: readonly DescribedCommand[]
	readonly describeVersion: typeof describeVersion
}

const locationReader: Reader<Location> = union(Arr.map(locations, literal))

const constantReader: Reader<ConstantBinding> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				location: member(object, "location", locationReader),
				pointer: member(object, "pointer", string),
				value: member(object, "value", string),
				wireName: member(object, "wireName", string)
			},
			anything
		)
	)

const flagReader: Reader<DescribedFlag> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				location: member(object, "location", locationReader),
				name: member(object, "name", string),
				pointer: member(object, "pointer", string),
				wireName: member(object, "wireName", string)
			},
			anything
		)
	)

const refusedFieldReader: Reader<RefusedField> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{ mediaType: member(object, "mediaType", string), name: member(object, "name", string) },
			anything
		)
	)

const commandReader: Reader<DescribedCommand> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				constants: member(object, "constants", array(constantReader)),
				document: member(object, "document", string),
				flags: member(object, "flags", array(flagReader)),
				method: member(object, "method", string),
				path: member(object, "path", array(string)),
				pathTemplate: member(object, "pathTemplate", string),
				pointer: member(object, "pointer", string),
				refusedFields: member(object, "refusedFields", array(refusedFieldReader)),
				requestMedia: member(object, "requestMedia", array(string)),
				responses: member(object, "responses", array(string)),
				security: member(object, "security", array(array(string))),
				servers: member(object, "servers", array(string))
			},
			anything
		)
	)

/**
 * A parsed JSON value read as a `--describe` document of this runtime's version: its fields
 * exactly, each read by its type, and a member a later version gains admitted and dropped, as
 * `describeVersion` only gains fields.
 */
const descriptionReader: Reader<Description> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				commands: member(object, "commands", array(commandReader)),
				describeVersion: member(object, "describeVersion", literal(describeVersion))
			},
			anything
		)
	)

/**
 * JSON text that is no `--describe` document of this runtime's: every place it breaks the
 * document's fields or version.
 */
export class UnreadableDescription extends Data.TaggedError("UnreadableDescription")<{
	readonly issues: ReadIssues
}> {}

/**
 * A `--describe` document read back from the text a generated CLI printed, by the module that
 * writes it, so the format has one owner: the `Description`, or why the text is none.
 */
export const readDescription = (
	text: string
): Result.Result<Description, InvalidJsonText | UnreadableDescription> =>
	Result.flatMap(parseJson(text), (value) =>
		Result.mapError(descriptionReader(value), (issues) => new UnreadableDescription({ issues }))
	)

const byName = Order.mapInput(Order.String, (flag: DescribedFlag) => flag.name)

/**
 * The refused fields, read from the media declaration's `refused` list: the one the `--body` guard
 * reads.
 */
const refusedFieldsOf = ({ refused, request }: MediaDeclaration): readonly RefusedField[] =>
	refused === undefined
		? []
		: Arr.flatMap(request, (mediaType) =>
				Arr.map(
					Option.getOrElse(Rec.get(refused, mediaType), (): readonly string[] => []),
					(name) => ({ mediaType, name })
				)
			)

const entryOf = (
	path: readonly string[],
	binding: CommandBinding,
	rootServers: readonly string[]
): DescribedCommand => ({
	constants: Arr.map(binding.constants, (constant) => ({
		location: constant.location,
		pointer: constant.pointer,
		value: constant.value,
		wireName: constant.wireName
	})),
	document: binding.operation.origin.document,
	flags: Arr.sort(
		Arr.map(Rec.toEntries(binding.parameters), ([name, parameter]) => ({
			location: parameter.location,
			name,
			pointer: parameter.pointer,
			wireName: parameter.wireName
		})),
		byName
	),
	method: binding.operation.method,
	path,
	pathTemplate: binding.operation.pathTemplate,
	pointer: binding.operation.origin.pointer,
	refusedFields: refusedFieldsOf(binding.operation.media),
	requestMedia: binding.operation.media.request,
	responses: Rec.keys(binding.operation.media.responses),
	security: binding.operation.security,
	servers:
		binding.operation.servers === undefined
			? rootServers
			: Arr.map(binding.operation.servers.servers, (server) => server.url)
})

const walk = (
	command: Command.Command.Any,
	path: readonly string[],
	rootServers: readonly string[]
): readonly DescribedCommand[] => [
	...Option.match(Context.getOption(command.annotations, Binding), {
		onNone: () => [],
		onSome: (binding) => [entryOf(path, binding, rootServers)]
	}),
	...Arr.flatMap(command.subcommands, (group) =>
		Arr.flatMap(group.commands, (child) => walk(child, [...path, child.name], rootServers))
	)
]

/**
 * Describes a command tree: every bound command in tree order, with its flags sorted by name.
 * Paths are relative to the root command, and unbound commands (groups) are not listed.
 * `rootServers` are the root level's server URLs, which commands without an override inherit.
 */
export const describeTree = (
	root: Command.Command.Any,
	rootServers: readonly string[]
): Description => ({
	commands: walk(root, [], rootServers),
	describeVersion
})

/**
 * The root servers from the `Servers` service `main.ts` provides around `Command.run`. An action's
 * type admits no requirement, so the service is read optionally; absent, the list is empty.
 */
const rootServerUrls = Effect.serviceOption(Servers).pipe(
	Effect.map(
		Option.match({
			onNone: () => [],
			onSome: ({ table }) => Arr.map(table.servers, (server) => server.url)
		})
	)
)

/**
 * `--describe`: prints the live command tree as one `Description` JSON document and stops.
 */
export const describeFlag = GlobalFlag.Action({
	flag: Flag.Boolean("describe").pipe(
		Flag.withDescription("Print the command tree and its operation bindings as JSON"),
		Flag.withDefault(false)
	),
	run: (_, { command }) =>
		rootServerUrls.pipe(
			Effect.flatMap((rootServers) =>
				Console.log(indentedJsonText(describeTree(command, rootServers)))
			)
		)
})
