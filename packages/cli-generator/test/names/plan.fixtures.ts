/**
 * What the property of plan.test.ts reads: normalized APIs drawn from the names that collide, fold alike or take a
 * name the generated modules hold (operation ids, routes, tags with parents, path and query parameters, JSON, multipart
 * and binary bodies over component schemas), author configs that rename, skip or miss; the plan for them; and design
 * 4.4's laws over every plan, written apart from the planner.
 */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import {
	aimed,
	type Aimed,
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	option,
	uniqueKeys
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Record, Result, String as Str } from "effect"
import { emitDomainSchemas } from "#emit/domain.ts"
import { decodeAuthorConfig } from "#model/author-config.ts"
import {
	fixedDocumentUri,
	fixedMediaRange,
	isMethodToken,
	isPathTemplate,
	isWireName,
	stripUnsafeText
} from "#model/brands.ts"
import type { Api, Body, Operation, Origin, Parameter } from "#model/entities.ts"
import { formatPointer } from "#model/pointer.ts"
import { fixedNamespaces, groupModuleNames, rootModuleNames } from "#names/domain.ts"
import { foldIdentifier, isSafeFileSegment, isSafeIdentifier } from "#names/fold.ts"
import { planNames } from "#names/index.ts"
import type { NamePlan, PlannedCommand } from "#names/index.ts"
import { familyOf } from "#names/plan.ts"
import { reservedFlagNames, reservedIdentifiers } from "#names/reserved.ts"
import { branded } from "#test/support/brands.ts"

const document = "file:///spec/openapi.json"

const escape = (token: string): string =>
	Str.replaceAll("/", "~1")(Str.replaceAll("~", "~0")(token))

/** A drawn parameter: where it is sent, its wire name, and whether it is a boolean. */
type ParameterSketch = Readonly<{
	location: "path" | "query" | "header"
	name: string
	boolean: boolean
}>

/** A drawn operation. */
type OperationSketch = Readonly<{
	operationId: Option.Option<string>
	method: "GET" | "POST" | "PUT" | "PATCH"
	path: string
	tags: ReadonlyArray<string>
	parameters: ReadonlyArray<ParameterSketch>
	body: Option.Option<Readonly<{ codec: "json" | "multipart" | "binary"; schema: string }>>
}>

/** A drawn API and its author config's naming. */
export type PlanCase = Readonly<{
	operations: ReadonlyArray<OperationSketch>
	parents: ReadonlyArray<readonly [tag: string, parent: string]>
	renames: ReadonlyArray<readonly [operationId: string, command: string]>
	skips: ReadonlyArray<string>
	strays: ReadonlyArray<string>
	strict: boolean
}>

/** Body schemas: plain objects, ones folding to a tag's namespace or a name a cli module imports, a binary string. */
const DEFS: Readonly<Record<string, Json>> = {
	Users: { properties: { url: { type: "string" }, name: { type: "string" } }, type: "object" },
	Imports: { properties: { file: { format: "binary", type: "string" } }, type: "object" },
	Schema: { properties: { f0: { type: "string" } }, type: "object" },
	Command: { properties: { f1: { type: "string" }, verbose: { type: "string" } }, type: "object" },
	user_update: {
		properties: {
			address: { properties: { city: { type: "string" } }, type: "object" },
			notify: { type: "string" }
		},
		type: "object"
	},
	binary: { format: "binary", type: "string" },
	boolean: { type: "boolean" },
	string: { type: "string" }
}

const origin = (tokens: ReadonlyArray<string>): Origin => ({
	document: fixedDocumentUri(document),
	pointer: formatPointer(tokens)
})

const operationTokens = (op: OperationSketch): ReadonlyArray<string> => [
	"paths",
	op.path,
	Str.toLowerCase(op.method)
]

/** An operation's pointer as the oracle writes it. */
const operationPointer = (op: OperationSketch): string =>
	`/paths/${escape(op.path)}/${Str.toLowerCase(op.method)}`

const parameterOf = (
	home: ReadonlyArray<string>,
	parameter: ParameterSketch,
	index: number
): Parameter => ({
	deprecated: false,
	docs: {},
	location: parameter.location,
	origin: origin([...home, "parameters", String(index)]),
	required: parameter.location === "path",
	rows: [],
	schema: { key: parameter.boolean ? "boolean" : "string" },
	serialization: {
		allowReserved: false,
		explode: parameter.location === "query",
		kind: "style",
		objectValued: false,
		origin: origin([...home, "parameters", String(index)]),
		rows: [],
		rules: "3.1",
		style: parameter.location === "query" ? "form" : "simple"
	},
	wireName: branded(isWireName, parameter.name)
})

const bodyOf = (
	home: ReadonlyArray<string>,
	body: Readonly<{ codec: "json" | "multipart" | "binary"; schema: string }>
): Body => {
	const media =
		body.codec === "json"
			? "application/json"
			: body.codec === "multipart"
				? "multipart/form-data"
				: "image/png"
	return {
		alternatives: [
			{
				codec: body.codec,
				encoding: [],
				mediaType: fixedMediaRange(media),
				origin: origin([...home, "requestBody", "content", media]),
				prefixEncoding: [],
				rows: [],
				schema: { key: body.schema }
			}
		],
		docs: {},
		origin: origin([...home, "requestBody"]),
		required: true,
		rows: []
	}
}

const operationOf = (op: OperationSketch): Operation => {
	const home = operationTokens(op)
	return {
		deprecated: false,
		docs: {},
		key: { method: branded(isMethodToken, op.method), path: branded(isPathTemplate, op.path) },
		origin: origin(home),
		parameters: Arr.map(op.parameters, (parameter, index) => parameterOf(home, parameter, index)),
		responses: [],
		rows: [],
		security: { alternatives: [], declared: false, origin: origin(home), rows: [] },
		servers: [],
		tags: Arr.map(op.tags, stripUnsafeText),
		...Option.match(op.operationId, {
			onNone: () => ({}),
			onSome: (operationId) => ({ operationId })
		}),
		...Option.match(op.body, {
			onNone: () => ({}),
			onSome: (body) => ({ body: bodyOf(home, body) })
		})
	}
}

const apiOf = (c: PlanCase): Api => ({
	documents: [fixedDocumentUri(document)],
	entry: fixedDocumentUri(document),
	info: {},
	informational: [],
	line: "3.1",
	openapi: "3.1.0",
	operations: Arr.map(c.operations, operationOf),
	origin: origin([]),
	rows: [],
	schemas: { defs: DEFS, origin: origin(["components", "schemas"]), rows: [] },
	securitySchemes: [],
	servers: [],
	tags: Arr.map(
		Arr.dedupe([
			...Arr.flatMap(c.operations, (op) => op.tags),
			...Arr.flatMap(c.parents, ([tag, parent]) => [parent, tag])
		]),
		(name) =>
			Option.match(
				Arr.findFirst(c.parents, ([tag]) => tag === name),
				{
					onNone: () => ({ name }),
					onSome: ([, parent]) => ({ name, parent })
				}
			)
	)
})

const configJsonOf = (c: PlanCase): Json => ({
	binName: "example",
	package: { name: "example-cli", version: "1.0.0" },
	naming: {
		operations: Record.fromEntries([
			...Arr.map(c.renames, ([id, command]) => [id, { command }] as const),
			...Arr.map(c.skips, (id) => [id, { skip: true }] as const),
			...Arr.map(c.strays, (id) => [id, { command: "elsewhere" }] as const)
		])
	}
})

/** The plan for a case, with the domain module emitted for the keys its bodies name. */
export const planOf = (c: PlanCase) =>
	Effect.gen(function* () {
		const api = apiOf(c)
		const configDocument = fixedDocumentUri("file:///spec/author-config.json")
		const config = yield* decodeAuthorConfig(configJsonOf(c), { document: configDocument })
		const plan = yield* planNames(api, { config, configDocument, strict: c.strict })
		const keys = Arr.dedupe(
			Arr.flatMap(c.operations, (op) =>
				Option.match(op.body, {
					onNone: () => [],
					onSome: (body) => (body.codec === "binary" ? [] : [body.schema])
				})
			)
		)
		const domain = yield* emitDomainSchemas(new Map(Record.toEntries(DEFS)), keys, plan.domain)
		return { plan, domainText: domain.content }
	})

const commandsOf = (plan: NamePlan): ReadonlyArray<PlannedCommand> => [
	...plan.root,
	...Arr.flatMap(plan.groups, (g) => g.commands)
]

const camelOf = (name: string): string =>
	Result.match(foldIdentifier(name, "camel"), { onFailure: () => "", onSuccess: (f) => f.name })

const pascalOf = (name: string): string =>
	Result.match(foldIdentifier(name, "pascal"), { onFailure: () => "", onSuccess: (f) => f.name })

/** A whole-body flag: `--body`, `--body-file` or `--part`, the runtime's own names for the body. */
const isWholeBody = (flag: PlannedCommand["flags"][number]): boolean =>
	flag.source._tag === "Body" &&
	(flag.source.kind === "body" || flag.source.kind === "body-file" || flag.source.kind === "part")

const duplicates = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.filter(values, (v, i) =>
			Arr.findFirstIndex(values, (w) => w === v).pipe(Option.exists((first) => first !== i))
		)
	)

const imports = (commands: ReadonlyArray<PlannedCommand>, plan: NamePlan): ReadonlyArray<string> =>
	Arr.flatMap(commands, (command) =>
		Arr.flatMap(command.operation.body?.alternatives ?? [], (alternative) =>
			alternative.codec === "binary"
				? []
				: Option.match(
						Option.fromUndefinedOr(
							alternative.schema === undefined ? undefined : plan.domain.get(alternative.schema.key)
						),
						{ onNone: () => [], onSome: (name) => [String(name)] }
					)
		)
	)

/**
 * Design 4.4's laws over one plan, each broken law a line: every operation accounted for once; names and identifiers
 * unique where they share a scope, none a name the modules hold; an identifier or namespace suffixed only when its fold
 * is taken, and then noticed; flags and positionals unique and none reserved; every imported domain name exported and
 * none a group's own namespace.
 */
export const brokenLawsOf = (
	c: PlanCase,
	planned: Readonly<{ plan: NamePlan; domainText: string }>
): ReadonlyArray<string> => {
	const { plan, domainText } = planned
	const commands = commandsOf(plan)
	const primaries = Arr.filter(commands, (command) => command.alias === undefined)
	const refusedAt = (pointer: string): boolean =>
		Arr.some(
			plan.diagnostics,
			(d) =>
				d.severity === "refusal" &&
				d.scope === "operation" &&
				(d.pointer === pointer || Str.startsWith(`${pointer}/`)(d.pointer))
		)
	const skipped = (op: OperationSketch): boolean =>
		Option.exists(op.operationId, (id) => Arr.contains(c.skips, id))
	const accounting = Arr.flatMap(c.operations, (op) => {
		const pointer = operationPointer(op)
		const count = Arr.filter(
			primaries,
			(command) => command.operation.origin.pointer === pointer
		).length
		const refused = refusedAt(pointer)
		return skipped(op)
			? count === 0 &&
				Arr.some(plan.diagnostics, (d) => d.code === "OPR-06/skipped" && d.pointer === pointer)
				? []
				: [`skipped ${pointer} is planned or not noticed`]
			: count + (refused ? 1 : 0) === 1
				? []
				: [`${pointer} has ${count} commands and ${refused ? "a" : "no"} refusal`]
	})
	const modules = [plan.root, ...Arr.map(plan.groups, (g) => g.commands)]
	const held = (root: boolean): ReadonlySet<string> =>
		new Set([...fixedNamespaces, ...(root ? rootModuleNames : groupModuleNames)])
	const moduleLaws = Arr.flatMap(modules, (moduleCommands, index) => {
		const root = index === 0
		const names = Arr.map(moduleCommands, (command) => command.name)
		const identifiers = Arr.map(moduleCommands, (command) => command.identifier)
		const families = Arr.flatMap(identifiers, familyOf)
		return [
			...Arr.map(duplicates(names), (name) => `command name ${name} twice in one module`),
			...Arr.map(duplicates(identifiers), (id) => `identifier ${id} twice in one module`),
			...Arr.flatMap(identifiers, (id) => [
				...(reservedIdentifiers.has(id) || !isSafeIdentifier(id)
					? [`identifier ${id} is no safe identifier`]
					: []),
				...(held(root).has(id) ? [`identifier ${id} is a name the module holds`] : []),
				...(Arr.contains(families, id)
					? [`identifier ${id} is another command's family member`]
					: [])
			]),
			...Arr.flatMap(moduleCommands, (command) => {
				const base = camelOf(command.name)
				const id = command.identifier
				const others = Arr.filter(moduleCommands, (other) => other !== command)
				const taken =
					held(root).has(base) ||
					Arr.some(
						others,
						(other) => other.identifier === base || Arr.contains(familyOf(other.identifier), base)
					)
				const noticed = Arr.some(
					plan.diagnostics,
					(d) => d.code === "OPR-06/renamed" && d.pointer === command.operation.origin.pointer
				)
				return id === base || command.alias !== undefined
					? []
					: [
							...(taken ? [] : [`identifier ${id} suffixed though ${base} is free`]),
							...(noticed ? [] : [`identifier ${id} renamed without an OPR-06/renamed notice`])
						]
			}),
			...Arr.flatMap(moduleCommands, (command) => {
				const flagNames = Arr.flatMap(command.flags, (flag) =>
					flag.boolean ? [flag.name, `no-${flag.name}`] : [flag.name]
				)
				const all = [...flagNames, ...Arr.map(command.positionals, (p) => p.name)]
				return [
					...Arr.map(duplicates(all), (name) => `flag ${name} twice on ${command.name}`),
					...Arr.flatMap(command.flags, (flag) =>
						reservedFlagNames.has(flag.name) && !isWholeBody(flag)
							? [`flag ${flag.name} is reserved`]
							: []
					),
					...Arr.map(
						duplicates(Arr.map(command.flags, (flag) => flag.identifier)),
						(id) => `flag identifier ${id} twice on ${command.name}`
					)
				]
			})
		]
	})
	const namespaces = Arr.map(plan.groups, (g) => g.namespace)
	const segments = Arr.map(plan.groups, (g) => g.segment)
	const groupLaws = [
		...Arr.map(duplicates(namespaces), (ns) => `namespace ${ns} twice`),
		...Arr.map(duplicates(segments), (segment) => `segment ${segment} twice`),
		...Arr.flatMap(plan.groups, (g) => {
			const ns = g.namespace
			const base = pascalOf(g.name)
			const own = imports(g.commands, plan)
			const noticed = Arr.some(
				plan.diagnostics,
				(d) =>
					d.code === "TAG-02/renamed" &&
					Arr.some(g.commands, (command) =>
						Str.startsWith(command.operation.origin.pointer)(d.pointer)
					)
			)
			return [
				...(fixedNamespaces.has(ns) || ns === "Root" || ns === "RootCli"
					? [`namespace ${ns} is held`]
					: []),
				...(Arr.contains(own, ns) ? [`namespace ${ns} is a domain name its commands import`] : []),
				...(isSafeFileSegment(g.segment) &&
				!Arr.contains(["root", "servers", "security"], g.segment)
					? []
					: [`segment ${g.segment} is not one a file may take`]),
				...(ns !== base && Arr.isReadonlyArrayNonEmpty(g.commands) && !noticed
					? [`namespace ${ns} renamed from ${base} without a TAG-02/renamed notice`]
					: [])
			]
		})
	]
	const imported = Arr.dedupe(
		Arr.flatMap(modules, (moduleCommands) => imports(moduleCommands, plan))
	)
	const domainLaws = Arr.flatMap(imported, (name) => [
		...(Str.includes(`export const ${name} =`)(domainText)
			? []
			: [`domain name ${name} is not exported`]),
		...(fixedNamespaces.has(name) ? [`domain name ${name} is a fixed namespace`] : [])
	])
	const strayLaws = Arr.flatMap(c.strays, (id) =>
		Arr.some(
			plan.diagnostics,
			(d) =>
				d.code === "CFG-1/unmatched-override" &&
				d.pointer === `/naming/operations/${escape(id)}` &&
				d.severity === (c.strict ? "refusal" : "notice")
		)
			? []
			: [`override ${id} matches nothing and is not reported`]
	)
	return [...accounting, ...moduleLaws, ...groupLaws, ...domainLaws, ...strayLaws]
}

const IDS = [
	"users-update",
	"users-update-meta",
	"users-group",
	"users-set-avatar",
	"users-set-avatar-input",
	"users-create",
	"things_get",
	"things/get",
	"things",
	"things-list",
	"list",
	"services",
	"servers",
	"security",
	"status",
	"table",
	"root",
	"args",
	"groups",
	"!!!",
	"2fa",
	"delete",
	"imports-create"
] as const

const TAGS = [
	"users",
	"things",
	"Root",
	"servers",
	"SECURITY",
	"roots",
	"Groups",
	"Arr",
	"Command",
	"effect",
	"schema",
	"imports"
] as const

const PARAMS = ["id", "name", "notify", "verbose", "is-ready", "If-Match", "page"] as const

const operationGen =
	(ids: Gen<Option.Option<string>>, tags: Gen<ReadonlyArray<string>>): Gen<OperationSketch> =>
	(s) => {
		const segment = s.draw(element(["users", "things", "imports", "plain", "a"]))
		const pathParams = s.draw(array(element(["id", "parentId", "name"]), { min: 0, max: 2 }))
		const uniquePath = Arr.dedupe(pathParams)
		const path = `/${segment}${s.draw(int(0, 99))}${Arr.join(
			Arr.map(uniquePath, (p) => `/{${p}}`),
			""
		)}`
		const others = s.draw(uniqueKeys(element(PARAMS), { min: 0, max: 2 }))
		return {
			operationId: s.draw(ids),
			method: s.draw(element(["GET", "POST", "PUT", "PATCH"] as const)),
			path,
			tags: s.draw(tags),
			parameters: [
				...Arr.map(uniquePath, (name): ParameterSketch => ({
					location: "path",
					name,
					boolean: false
				})),
				...Arr.map(others, (name): ParameterSketch => ({
					location: name === "If-Match" ? "header" : "query",
					name,
					boolean: name === "notify" || name === "is-ready"
				}))
			],
			body: s.draw(
				option((inner) => {
					const codec = inner.draw(element(["json", "multipart", "binary"] as const))
					return {
						codec,
						schema:
							codec === "binary"
								? "binary"
								: inner.draw(element(["Users", "Imports", "Schema", "Command", "user_update"]))
					}
				})
			)
		}
	}

const idGen = option(element(IDS))

const tagsGen = array(element(TAGS), { min: 0, max: 1 })

const caseGen =
	(operations: Gen<ReadonlyArray<OperationSketch>>): Gen<PlanCase> =>
	(s) => {
		const ops = s.draw(operations)
		const ids = Arr.getSomes(Arr.map(ops, (op) => op.operationId))
		const pickIds = (): ReadonlyArray<string> =>
			Arr.isReadonlyArrayNonEmpty(ids) && s.draw(int(0, 3)) === 0 ? [s.draw(element(ids))] : []
		const renamed = pickIds()
		const skips = Arr.filter(pickIds(), (id) => !Arr.contains(renamed, id))
		return {
			operations: ops,
			parents: s.draw(element([[], [["users", "things"]], [["imports", "users"]]] as const)),
			renames: Arr.map(
				renamed,
				(id) => [id, s.draw(element(["fetch", "update", "list-all"]))] as const
			),
			skips,
			strays: s.draw(array(element(["missing", "gone"]), { min: 0, max: 1 })),
			strict: s.draw(boolean)
		}
	}

/** Distinct operations: every operation its own pointer, as a document's paths make them. */
const operationsGen =
	(
		op: Gen<OperationSketch>,
		size: Readonly<{ min: number; max: number }>
	): Gen<ReadonlyArray<OperationSketch>> =>
	(s) =>
		Arr.dedupeWith(s.draw(array(op, size)), (a, b) => operationPointer(a) === operationPointer(b))

export type Feature =
	| "a command collision refused"
	| "a group collision refused"
	| "an empty name refused"
	| "a reserved segment refused"
	| "a flag collision refused"
	| "an identifier suffixed"
	| "a namespace suffixed"
	| "a root binding avoided"
	| "a parent chain nested"
	| "a renamed command"
	| "a skipped operation"
	| "an unmatched override"
	| "a multipart body's schema import"
	| "a positional and a boolean flag"

export const featuresOf = (plan: NamePlan): ReadonlyArray<Feature> => {
	const codes = Arr.map(plan.diagnostics, (d) => d.code)
	const when = (holds: boolean, feature: Feature): ReadonlyArray<Feature> =>
		holds ? [feature] : []
	const commands = commandsOf(plan)
	return [
		...when(Arr.contains(codes, "OPR-06/command-collision"), "a command collision refused"),
		...when(Arr.contains(codes, "OPR-06/group-collision"), "a group collision refused"),
		...when(Arr.contains(codes, "OPR-06/empty-name"), "an empty name refused"),
		...when(Arr.contains(codes, "TAG-02/reserved-segment"), "a reserved segment refused"),
		...when(
			Arr.contains(codes, "PRM-02/flag-collision") || Arr.contains(codes, "RQB-03/flag-collision"),
			"a flag collision refused"
		),
		...when(Arr.contains(codes, "OPR-06/renamed"), "an identifier suffixed"),
		...when(Arr.contains(codes, "TAG-02/renamed"), "a namespace suffixed"),
		...when(
			Arr.some(plan.root, (command) => rootModuleNames.has(camelOf(command.name))),
			"a root binding avoided"
		),
		...when(
			Arr.some(plan.groups, (g) => g.parent !== undefined),
			"a parent chain nested"
		),
		...when(
			Arr.some(commands, (command) => command.sources.command === "config"),
			"a renamed command"
		),
		...when(Arr.contains(codes, "OPR-06/skipped"), "a skipped operation"),
		...when(Arr.contains(codes, "CFG-1/unmatched-override"), "an unmatched override"),
		...when(
			Arr.some(plan.groups, (g) =>
				Arr.some(g.commands, (command) =>
					Arr.some(command.operation.body?.alternatives ?? [], (a) => a.codec === "multipart")
				)
			),
			"a multipart body's schema import"
		),
		...when(
			Arr.some(
				commands,
				(command) =>
					Arr.isReadonlyArrayNonEmpty(command.positionals) &&
					Arr.some(command.flags, (flag) => flag.boolean)
			),
			"a positional and a boolean flag"
		)
	]
}

const fixed = (
	ops: ReadonlyArray<Partial<OperationSketch> & Readonly<{ path: string }>>
): Gen<PlanCase> =>
	caseGen(
		constant(
			Arr.map(ops, (op): OperationSketch => ({
				operationId: Option.none(),
				method: "GET",
				tags: [],
				parameters: [],
				body: Option.none(),
				...op
			}))
		)
	)

const get = (
	id: string,
	path: string,
	tags: ReadonlyArray<string>
): Partial<OperationSketch> & Readonly<{ path: string }> => ({
	operationId: Option.some(id),
	path,
	tags
})

/** APIs, aimed at each refusal, rename and reservation the plan makes. */
export const planSpace: Aimed<PlanCase, Feature> = aimed(
	caseGen(operationsGen(operationGen(idGen, tagsGen), { min: 1, max: 5 })),
	[
		[
			"a command collision refused",
			fixed([get("things_get", "/a", []), get("things/get", "/b", [])])
		],
		[
			"a group collision refused",
			fixed([get("things", "/things", []), get("things-list", "/things/all", ["things"])])
		],
		["an empty name refused", fixed([get("!!!", "/plain", [])])],
		[
			"a reserved segment refused",
			fixed([
				get("a", "/a", ["Root"]),
				get("b", "/b", ["servers"]),
				get("c", "/c", ["SECURITY"]),
				get("d", "/d", ["roots"])
			])
		],
		[
			"a flag collision refused",
			fixed([
				{
					...get("make", "/things", []),
					method: "POST",
					parameters: [{ location: "query", name: "name", boolean: false }],
					body: Option.some({ codec: "json", schema: "Users" })
				}
			])
		],
		[
			"an identifier suffixed",
			fixed([
				get("users-update", "/u1", ["users"]),
				get("users-update-meta", "/u2", ["users"]),
				get("users-group", "/u3", ["users"]),
				get("users-set-avatar-input", "/u5", ["users"])
			])
		],
		[
			"a namespace suffixed",
			fixed([
				get("list-effect", "/e", ["effect"]),
				get("list-groups", "/g", ["Groups"]),
				get("list-schema", "/s", ["schema"]),
				get("list-users", "/u", ["users"])
			])
		],
		[
			"a root binding avoided",
			fixed([
				get("services", "/services", []),
				get("table", "/table", []),
				get("args", "/args", []),
				get("status", "/status", [])
			])
		],
		[
			"a parent chain nested",
			(s) => ({
				...s.draw(
					fixed([
						{
							...get("avatar-put", "/users/{id}/avatar", ["users"]),
							parameters: [{ location: "path", name: "id", boolean: false }]
						}
					])
				),
				parents: [["users", "things"]]
			})
		],
		[
			"a renamed command",
			(s) => ({ ...s.draw(fixed([get("list", "/l", [])])), renames: [["list", "fetch"]] })
		],
		[
			"a skipped operation",
			(s) => ({
				...s.draw(fixed([get("talk", "/talk", []), get("list", "/l", [])])),
				skips: ["talk"]
			})
		],
		[
			"an unmatched override",
			(s) => ({
				...s.draw(fixed([get("list", "/l", [])])),
				strays: ["missing"],
				strict: s.draw(boolean)
			})
		],
		[
			"a multipart body's schema import",
			fixed([
				{
					...get("imports-create", "/imports", ["imports"]),
					method: "POST",
					body: Option.some({ codec: "multipart", schema: "Imports" })
				}
			])
		],
		[
			"a positional and a boolean flag",
			fixed([
				{
					...get("get-pair", "/parents/{parentId}/things/{itemId}", []),
					parameters: [
						{ location: "path", name: "itemId", boolean: false },
						{ location: "path", name: "parentId", boolean: false },
						{ location: "query", name: "is-ready", boolean: true }
					]
				}
			])
		]
	]
)
