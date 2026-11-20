import {
	Array as Arr,
	Console,
	Context,
	Effect,
	Option,
	Order,
	Record as Rec,
	Schema
} from "effect"
import type { Command } from "effect/cli"
import { Flag, GlobalFlag } from "effect/cli"
import { Servers } from "#runtime/base-url.ts"
import type { MediaDeclaration } from "#runtime/negotiate.ts"

const Location = Schema.Literals(["body", "cookie", "header", "path", "query", "querystring"])

/**
 * The per-flag binding a generated command declares: where the value goes on the wire.
 */
export interface ParameterBinding {
	readonly location: typeof Location.Type
	readonly pointer: string
	readonly wireName: string
}

/**
 * A constant parameter a generated command sends without a flag: where its value goes, its use
 * site, and the value as JSON text.
 */
export interface ConstantBinding {
	readonly location: typeof Location.Type
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
	 * Present only when the operation has a constant parameter.
	 */
	readonly constants?: readonly ConstantBinding[]
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
	"effect-openapi-cli-generator/runtime-src/runtime/describe/Binding"
) {}

/**
 * The `--describe` document. Fields are alphabetical, and `describeVersion` only gains fields.
 * `requestMedia` and `responses` are the spec's keys as spelled, in order; `security` is the
 * effective requirement's alternatives; `servers` are the effective server URLs (the operation's or
 * path item's override, else the root's from `Servers`, empty when that service is absent).
 * `refusedFields` are the body properties refused at `field` scope, in request media then property
 * order; it is present on every command, empty when none is refused. `constants` are the parameters
 * the command sends as their one value without a flag, in parameter order, empty when there is none.
 */
export const Description = Schema.Struct({
	commands: Schema.Array(
		Schema.Struct({
			constants: Schema.Array(
				Schema.Struct({
					location: Location,
					pointer: Schema.String,
					value: Schema.String,
					wireName: Schema.String
				})
			),
			document: Schema.String,
			flags: Schema.Array(
				Schema.Struct({
					location: Location,
					name: Schema.String,
					pointer: Schema.String,
					wireName: Schema.String
				})
			),
			method: Schema.String,
			path: Schema.Array(Schema.String),
			pathTemplate: Schema.String,
			pointer: Schema.String,
			refusedFields: Schema.Array(Schema.Struct({ mediaType: Schema.String, name: Schema.String })),
			requestMedia: Schema.Array(Schema.String),
			responses: Schema.Array(Schema.String),
			security: Schema.Array(Schema.Array(Schema.String)),
			servers: Schema.Array(Schema.String)
		})
	),
	describeVersion: Schema.Literal(1)
})

type Entry = (typeof Description.Type)["commands"][number]

const byName = Order.mapInput(Order.String, (flag: Entry["flags"][number]) => flag.name)

/**
 * The refused fields, read from the media declaration's `refused` list: the one the `--body` guard
 * reads.
 */
const refusedFieldsOf = ({ refused, request }: MediaDeclaration): Entry["refusedFields"] =>
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
): Entry => ({
	constants: binding.constants ?? [],
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
): readonly Entry[] => [
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
): typeof Description.Type => ({
	commands: walk(root, [], rootServers),
	describeVersion: 1
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

const encodeDescription = Schema.encodeEffect(Schema.fromJsonString(Description, { space: 2 }))

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
				encodeDescription(describeTree(command, rootServers)).pipe(
					Effect.orDie,
					Effect.flatMap(Console.log)
				)
			)
		)
})
