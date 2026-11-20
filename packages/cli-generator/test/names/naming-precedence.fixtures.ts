/**
 * What the property of naming-precedence.test.ts reads: operations drawn with every naming source the plan reads (the
 * author config's group, command and aliases, `x-forge-*` and `x-fern-sdk-*` names, tags, operationIds, routes), each
 * operation's names drawn from its own words so no two collide; and a model of design 4.4's precedence written from
 * commandName's stated rules.
 */

import {
	aimed,
	type Aimed,
	array,
	constant,
	element,
	type Gen,
	option,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, Record, Result, Schema, String as Str } from "effect"
import { AuthorConfig } from "#model/author-config.ts"
import { fixedDocumentUri } from "#model/brands.ts"
import { Api } from "#model/entities.ts"
import type { Json } from "#model/pointer.ts"
import { foldKebab, words } from "#names/fold.ts"
import { planNames } from "#names/index.ts"
import type { NamePlan, PlannedGroup } from "#names/index.ts"
import type { CommandNameSource, GroupNameSource } from "#names/plan.ts"

/** An extension's names: a group (its segments), a method, or both; an extension naming neither is no extension. */
type Hint =
	| Readonly<{ names: "group"; group: ReadonlyArray<string> }>
	| Readonly<{ names: "method"; method: string }>
	| Readonly<{ names: "both"; group: ReadonlyArray<string>; method: string }>

const hintGroup = (hint: Hint): Option.Option<ReadonlyArray<string>> =>
	hint.names === "method" ? Option.none() : Option.some(hint.group)

const hintMethod = (hint: Hint): Option.Option<string> =>
	hint.names === "group" ? Option.none() : Option.some(hint.method)

/** An `x-forge-aliases` entry: Forge and Fern names, or its own operationId. */
type AliasSketch = Readonly<{
	forge: Option.Option<Hint>
	fern: Option.Option<Hint>
	operationId: Option.Option<string>
}>

/** An author-config alias: a group (dotted or segments) and a method, at least one. */
type ConfigAliasSketch = Readonly<{
	group: Option.Option<ReadonlyArray<string>>
	method: Option.Option<string>
}>

/** One operation with every naming source drawn. */
type OperationSketch = Readonly<{
	slot: 0 | 1
	operationId: Option.Option<string>
	tags: ReadonlyArray<string>
	forge: Option.Option<Hint>
	fern: Option.Option<Hint>
	aliases: Option.Option<ReadonlyArray<AliasSketch>>
	configGroup: Option.Option<string>
	configCommand: Option.Option<string>
	configAliases: Option.Option<ReadonlyArray<ConfigAliasSketch>>
	skip: boolean
}>

const document = "file:///spec/openapi.json"

const escape = (token: string): string =>
	Str.replaceAll("/", "~1")(Str.replaceAll("~", "~0")(token))

const pathOf = (op: OperationSketch): string => `/p${op.slot}`

const homeOf = (op: OperationSketch): string => `/paths/${escape(pathOf(op))}/get`

const origin = (pointer: string): Json => ({ document, pointer })

const hintJson = (hint: Hint, pointer: string): Json =>
	Record.fromEntries([
		["pointer", pointer],
		...Option.match(hintGroup(hint), {
			onNone: () => [],
			onSome: (group) => [["group", group] as const]
		}),
		...Option.match(hintMethod(hint), {
			onNone: () => [],
			onSome: (method) => [["method", method] as const]
		})
	])

const namingJson = (op: OperationSketch): Option.Option<Json> => {
	const home = homeOf(op)
	const entries: ReadonlyArray<readonly [string, Json]> = [
		...Option.match(op.forge, {
			onNone: () => [],
			onSome: (hint) => [["forge", hintJson(hint, home)] as const]
		}),
		...Option.match(op.fern, {
			onNone: () => [],
			onSome: (hint) => [["fern", hintJson(hint, home)] as const]
		}),
		...Option.match(op.aliases, {
			onNone: () => [],
			onSome: (aliases) => [
				[
					"aliases",
					Arr.map(aliases, (alias, index) => {
						const pointer = `${home}/x-forge-aliases/${index}`
						return Record.fromEntries([
							["index", index],
							...Option.match(alias.forge, {
								onNone: () => [],
								onSome: (hint) => [["forge", hintJson(hint, pointer)] as const]
							}),
							...Option.match(alias.fern, {
								onNone: () => [],
								onSome: (hint) => [["fern", hintJson(hint, pointer)] as const]
							}),
							...Option.match(alias.operationId, {
								onNone: () => [],
								onSome: (id) => [["operationId", id] as const]
							})
						])
					})
				] as const
			]
		})
	]
	return Arr.isReadonlyArrayNonEmpty(entries)
		? Option.some(Record.fromEntries(entries))
		: Option.none()
}

const operationJson = (op: OperationSketch): Json =>
	Record.fromEntries([
		["deprecated", false],
		["docs", {}],
		["key", { method: "GET", path: pathOf(op) }],
		["origin", origin(homeOf(op))],
		["parameters", []],
		["responses", []],
		["rows", []],
		["security", { alternatives: [], declared: false, origin: origin(homeOf(op)), rows: [] }],
		["servers", []],
		["tags", op.tags],
		...Option.match(namingJson(op), {
			onNone: () => [],
			onSome: (naming) => [["naming", naming] as const]
		}),
		...Option.match(op.operationId, {
			onNone: () => [],
			onSome: (id) => [["operationId", id] as const]
		})
	])

const overrideJson = (op: OperationSketch): Option.Option<Json> => {
	const entries: ReadonlyArray<readonly [string, Json]> = [
		...Option.match(op.configGroup, {
			onNone: () => [],
			onSome: (group) => [["group", group] as const]
		}),
		...Option.match(op.configCommand, {
			onNone: () => [],
			onSome: (command) => [["command", command] as const]
		}),
		...Option.match(op.configAliases, {
			onNone: () => [],
			onSome: (aliases) => [
				[
					"aliases",
					Arr.map(aliases, (alias) =>
						Record.fromEntries([
							...Option.match(alias.group, {
								onNone: () => [],
								onSome: (group) => [["group", group] as const]
							}),
							...Option.match(alias.method, {
								onNone: () => [],
								onSome: (method) => [["method", method] as const]
							})
						])
					)
				] as const
			]
		}),
		...(op.skip ? [["skip", true] as const] : [])
	]
	return Arr.isReadonlyArrayNonEmpty(entries)
		? Option.some(Record.fromEntries(entries))
		: Option.none()
}

const configJsonOf = (c: ReadonlyArray<OperationSketch>): Json => {
	const keyed = Arr.flatMap(c, (op) =>
		Option.match(overrideJson(op), {
			onNone: () => [],
			onSome: (override) => [[op, override] as const]
		})
	)
	return {
		binName: "example",
		package: { name: "example-cli", version: "1.0.0" },
		naming: {
			operations: Record.fromEntries(
				Arr.flatMap(keyed, ([op, override]) =>
					Option.match(op.operationId, {
						onNone: () => [],
						onSome: (id) => [[id, override] as const]
					})
				)
			),
			byPointer: Record.fromEntries(
				Arr.flatMap(keyed, ([op, override]) =>
					Option.isNone(op.operationId) ? [[homeOf(op), override] as const] : []
				)
			)
		}
	}
}

/** One planned command as the model states it: its visible path, its alias index, and its sources. */
type Named = Readonly<{
	path: string
	alias: Option.Option<number>
	command: CommandNameSource
	group: GroupNameSource
}>

const commandOrder = Order.combine(
	Order.mapInput(Order.String, (n: Named) => n.path),
	Order.mapInput(Option.makeOrder(Order.Number), (n: Named) => n.alias)
)

const visiblePath = (
	group: PlannedGroup,
	groups: ReadonlyArray<PlannedGroup>
): ReadonlyArray<string> =>
	Option.match(
		Arr.findFirst(groups, (other) => other.tag === group.parent),
		{ onNone: () => [group.name], onSome: (parent) => [...visiblePath(parent, groups), group.name] }
	)

/** What the plan names: every command with its path, alias and sources, and its refusals' codes. */
export type Answer = Readonly<{ commands: ReadonlyArray<Named>; refusals: ReadonlyArray<string> }>

const answerOf = (plan: NamePlan): Answer => ({
	commands: Arr.sort(
		[
			...Arr.map(plan.root, (command): Named => ({
				path: command.name,
				alias: Option.fromUndefinedOr(command.alias),
				command: command.sources.command,
				group: command.sources.group
			})),
			...Arr.flatMap(plan.groups, (group) =>
				Arr.map(group.commands, (command): Named => ({
					path: Arr.join([...visiblePath(group, plan.groups), command.name], " "),
					alias: Option.fromUndefinedOr(command.alias),
					command: command.sources.command,
					group: command.sources.group
				}))
			)
		],
		commandOrder
	),
	refusals: Arr.map(
		Arr.filter(plan.diagnostics, (d) => d.severity === "refusal"),
		(d) => d.code
	)
})

export const actualOf = (c: ReadonlyArray<OperationSketch>) =>
	Effect.gen(function* () {
		const api = yield* Schema.decodeUnknownEffect(Api)({
			documents: [document],
			entry: document,
			info: {},
			informational: [],
			line: "3.1",
			openapi: "3.1.0",
			operations: Arr.map(c, operationJson),
			origin: origin(""),
			rows: [],
			schemas: { document: { $defs: {} }, origin: origin("/components/schemas"), rows: [] },
			securitySchemes: [],
			servers: [],
			tags: Arr.map(Arr.dedupe(Arr.flatMap(c, (op) => op.tags)), (name) => ({ name }))
		})
		const config = yield* Schema.decodeUnknownEffect(AuthorConfig)(configJsonOf(c))
		const configDocument = fixedDocumentUri("file:///spec/author-config.json")
		const plan = yield* planNames(api, { config, configDocument, strict: false })
		return answerOf(plan)
	})

const kebab = (text: string): string =>
	Result.match(foldKebab(text), { onFailure: () => "", onSuccess: (f) => f.name })

/** The `operationId` fold: a leading run of words equal to the innermost group's label is dropped, unless nothing remains. */
const foldOperationId = (operationId: string, label: Option.Option<string>): string => {
	const idWords = words(operationId)
	const group = Option.match(label, {
		onNone: () => [],
		onSome: (text) => Arr.map(words(text), Str.toLowerCase)
	})
	const leads =
		group.length > 0 &&
		idWords.length > group.length &&
		Arr.every(group, (word, index) =>
			Option.exists(Arr.get(idWords, index), (id) => Str.toLowerCase(id) === word)
		)
	return kebab(leads ? Arr.join(Arr.drop(idWords, group.length), " ") : operationId)
}

/** A command's group: its segments (unfolded) and the source that named it. */
type Group = Readonly<{ segments: ReadonlyArray<string>; source: GroupNameSource }>

const groupOf = (op: OperationSketch): Group =>
	Option.match(op.configGroup, {
		onSome: (group): Group => ({ segments: [group], source: "config" }),
		onNone: () => {
			const forge = Option.flatMap(op.forge, hintGroup)
			const fern = Option.flatMap(op.fern, hintGroup)
			return Option.isSome(forge)
				? { segments: forge.value, source: "x-forge" }
				: Option.isSome(fern)
					? { segments: fern.value, source: "x-fern" }
					: Option.match(Arr.head(op.tags), {
							onNone: (): Group => ({ segments: [], source: "none" }),
							onSome: (tag): Group => ({ segments: [tag], source: "tag" })
						})
		}
	})

const labelOf = (group: Group): Option.Option<string> => Arr.last(group.segments)

/** The name without a naming key: the `operationId` fold with the group-word drop, else the route form. */
const defaultName = (op: OperationSketch, group: Group): readonly [string, CommandNameSource] =>
	Option.match(op.operationId, {
		onNone: () => [kebab(`GET ${pathOf(op)}`), "route"] as const,
		onSome: (id) => [foldOperationId(id, labelOf(group)), "operationId"] as const
	})

const named = (
	group: Group,
	command: string,
	commandSource: CommandNameSource,
	alias: Option.Option<number>
): Named => ({
	path: Arr.join([...Arr.map(group.segments, kebab), command], " "),
	alias,
	command: commandSource,
	group: group.source
})

/**
 * Design 4.4's precedence: a primary's group from the config, else `x-forge-group-name`, else `x-fern-sdk-group-name`,
 * else the first tag; its command from the config, else `x-forge-method-name`, else `x-fern-sdk-method-name`, else the
 * operationId fold with the group-word drop, else the route. An extension alias takes its own Forge, else Fern, method
 * and group, else the fold of its own operationId; a config alias list replaces the extension's, each alias its own
 * method (else the operation's default name) and group; a skipped operation plans nothing.
 */
const expectedNamesOf = (op: OperationSketch): ReadonlyArray<Named> => {
	if (op.skip) {
		return []
	}
	const group = groupOf(op)
	const forgeMethod = Option.flatMap(op.forge, hintMethod)
	const fernMethod = Option.flatMap(op.fern, hintMethod)
	const [command, source]: readonly [string, CommandNameSource] = Option.isSome(op.configCommand)
		? [kebab(op.configCommand.value), "config"]
		: Option.isSome(forgeMethod)
			? [kebab(forgeMethod.value), "x-forge"]
			: Option.isSome(fernMethod)
				? [kebab(fernMethod.value), "x-fern"]
				: defaultName(op, group)
	const primary = named(group, command, source, Option.none())
	const aliases = Option.match(op.configAliases, {
		onSome: (list) =>
			Arr.map(list, (alias, index) => {
				const aliasGroup: Group = Option.match(alias.group, {
					onNone: () => ({ segments: [], source: "none" }),
					onSome: (segments) => ({ segments, source: "config" })
				})
				const [name, from]: readonly [string, CommandNameSource] = Option.match(alias.method, {
					onNone: () => defaultName(op, aliasGroup),
					onSome: (method) => [kebab(method), "config"] as const
				})
				return named(aliasGroup, name, from, Option.some(index))
			}),
		onNone: () =>
			Arr.map(
				Option.getOrElse(op.aliases, () => []),
				(alias, index) => {
					const forgeGroup = Option.flatMap(alias.forge, hintGroup)
					const fernGroup = Option.flatMap(alias.fern, hintGroup)
					const aliasGroup: Group = Option.isSome(forgeGroup)
						? { segments: forgeGroup.value, source: "x-forge" }
						: Option.isSome(fernGroup)
							? { segments: fernGroup.value, source: "x-fern" }
							: { segments: [], source: "none" }
					const forge = Option.flatMap(alias.forge, hintMethod)
					const fern = Option.flatMap(alias.fern, hintMethod)
					const [name, from]: readonly [string, CommandNameSource] = Option.isSome(forge)
						? [kebab(forge.value), "x-forge"]
						: Option.isSome(fern)
							? [kebab(fern.value), "x-fern"]
							: [
									foldOperationId(
										Option.getOrElse(alias.operationId, () => ""),
										labelOf(aliasGroup)
									),
									"operationId"
								]
					return named(aliasGroup, name, from, Option.some(index))
				}
			)
	})
	return [primary, ...aliases]
}

export const expectedOf = (c: ReadonlyArray<OperationSketch>): Answer => ({
	commands: Arr.sort(Arr.flatMap(c, expectedNamesOf), commandOrder),
	refusals: []
})

/** One slot's vocabulary: its operation ids, tags, extension and config names, alias names. */
type Words = Readonly<{
	ids: Arr.NonEmptyReadonlyArray<string>
	tags: Arr.NonEmptyReadonlyArray<string>
	forgeGroups: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>>
	fernGroups: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>>
	forgeMethods: Arr.NonEmptyReadonlyArray<string>
	fernMethods: Arr.NonEmptyReadonlyArray<string>
	aliasMethods: Arr.NonEmptyReadonlyArray<string>
	aliasGroups: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>>
	aliasIds: Arr.NonEmptyReadonlyArray<string>
	configGroups: Arr.NonEmptyReadonlyArray<string>
	configCommands: Arr.NonEmptyReadonlyArray<string>
}>

/** Each slot's own words, so two operations never fold alike. */
const WORDS: readonly [Words, Words] = [
	{
		ids: ["fetch", "things_get", "zones_status_edit"],
		tags: ["things", "sites"],
		forgeGroups: [["forge-group"], ["accounts", "members"]],
		fernGroups: [["fern-group"], ["things"]],
		forgeMethods: ["forgeMethod", "suspend"],
		fernMethods: ["fernMethod", "listAll"],
		aliasMethods: ["pause", "halt"],
		aliasGroups: [["zones"], ["zones", "settings"]],
		aliasIds: ["pauseZone", "haltZone"],
		configGroups: ["configured", "regions"],
		configCommands: ["configured-command", "freeze"]
	},
	{
		ids: ["store", "items_put", "rows_drop_all"],
		tags: ["items", "boxes"],
		forgeGroups: [["vault"], ["teams", "seats"]],
		fernGroups: [["shelf"], ["items"]],
		forgeMethods: ["keepThing", "lock"],
		fernMethods: ["putThing", "dropAll"],
		aliasMethods: ["thaw", "wake"],
		aliasGroups: [["rows"], ["rows", "cells"]],
		aliasIds: ["thawRow", "wakeRow"],
		configGroups: ["stash", "lands"],
		configCommands: ["stashed", "melt"]
	}
]

const hintGen =
	(
		groups: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>>,
		methods: Arr.NonEmptyReadonlyArray<string>
	): Gen<Hint> =>
	(s) => {
		const names = s.draw(element(["group", "method", "both"] as const))
		const group = s.draw(element(groups))
		const method = s.draw(element(methods))
		return names === "group"
			? { names, group }
			: names === "method"
				? { names, method }
				: { names, group, method }
	}

const operationGen =
	(slot: 0 | 1): Gen<OperationSketch> =>
	(s) => {
		const w = WORDS[slot]
		const aliasGen =
			(index: number): Gen<AliasSketch> =>
			(inner) => {
				const kind = inner.draw(element(["forge", "fern", "operationId"] as const))
				const method = w.aliasMethods[index] ?? "pause"
				const hint: Hint = Option.match(inner.draw(option(element(w.aliasGroups))), {
					onNone: () => ({ names: "method", method }),
					onSome: (group) => ({ names: "both", group, method })
				})
				return kind === "operationId"
					? {
							forge: Option.none(),
							fern: Option.none(),
							operationId: Option.some(w.aliasIds[index] ?? "pauseZone")
						}
					: kind === "forge"
						? {
								forge: Option.some(hint),
								fern: Option.none(),
								operationId: Option.none()
							}
						: {
								forge: Option.none(),
								fern: Option.some(hint),
								operationId: Option.none()
							}
			}
		const configAliasGen =
			(index: number): Gen<ConfigAliasSketch> =>
			(inner) =>
				inner.draw(element(["method", "group", "both"] as const)) === "group"
					? { group: Option.some(w.aliasGroups[index] ?? ["zones"]), method: Option.none() }
					: {
							group: inner.draw(option(element(w.aliasGroups))),
							method: Option.some(w.aliasMethods[index] ?? "pause")
						}
		return {
			slot,
			operationId: s.draw(option(element(w.ids))),
			tags: s.draw(array(element(w.tags), { min: 0, max: 1 })),
			forge: s.draw(option(hintGen(w.forgeGroups, w.forgeMethods))),
			fern: s.draw(option(hintGen(w.fernGroups, w.fernMethods))),
			aliases: s.draw(
				option((inner) =>
					Array.from({ length: inner.draw(element([1, 2])) }, (_, index) =>
						inner.draw(aliasGen(index))
					)
				)
			),
			configGroup: s.draw(option(element(w.configGroups))),
			configCommand: s.draw(option(element(w.configCommands))),
			configAliases: s.draw(
				option((inner) =>
					Array.from({ length: inner.draw(element([1, 2])) }, (_, index) =>
						inner.draw(configAliasGen(index))
					)
				)
			),
			skip: s.draw(
				weighted([
					[3, constant(false)],
					[1, constant(true)]
				])
			)
		}
	}

const caseGen =
	(
		slots: Gen<ReadonlyArray<0 | 1>>,
		adjust: (op: OperationSketch) => OperationSketch
	): Gen<ReadonlyArray<OperationSketch>> =>
	(s) =>
		Arr.map(s.draw(slots), (slot) => adjust(s.draw(operationGen(slot))))

export type Feature =
	| `a command named by ${CommandNameSource}`
	| `a group named by ${GroupNameSource}`
	| "a group word dropped"
	| "an extension alias"
	| "a config alias"
	| "a skipped operation"
	| "a nested extension group"

export const featuresOf = (c: ReadonlyArray<OperationSketch>): ReadonlyArray<Feature> =>
	Arr.dedupe(
		Arr.flatMap(c, (op): ReadonlyArray<Feature> => {
			const all = expectedNamesOf(op)
			const group = groupOf(op)
			const dropped =
				Option.isSome(op.operationId) &&
				Option.isNone(op.configCommand) &&
				Option.isNone(Option.flatMap(op.forge, hintMethod)) &&
				Option.isNone(Option.flatMap(op.fern, hintMethod)) &&
				foldOperationId(op.operationId.value, labelOf(group)) !== kebab(op.operationId.value)
			return [
				...Arr.flatMap(all, (n): ReadonlyArray<Feature> => [
					`a command named by ${n.command}`,
					`a group named by ${n.group}`
				]),
				...(dropped && !op.skip ? ["a group word dropped" as const] : []),
				...(Option.isSome(op.aliases) &&
				Option.isNone(op.configAliases) &&
				Arr.some(all, (n) => Option.isSome(n.alias))
					? ["an extension alias" as const]
					: []),
				...(Option.isSome(op.configAliases) && Arr.some(all, (n) => Option.isSome(n.alias))
					? ["a config alias" as const]
					: []),
				...(op.skip ? ["a skipped operation" as const] : []),
				...(group.segments.length > 1 && !op.skip ? ["a nested extension group" as const] : [])
			]
		})
	)

const none = (op: OperationSketch): OperationSketch => ({
	...op,
	forge: Option.none(),
	fern: Option.none(),
	aliases: Option.none(),
	configGroup: Option.none(),
	configCommand: Option.none(),
	configAliases: Option.none(),
	skip: false
})

const one = constant<ReadonlyArray<0 | 1>>([0])

const both = constant<ReadonlyArray<0 | 1>>([0, 1])

/** Operations, aimed at every command and group source, the group-word drop, aliases of each kind, skips and nesting. */
export const precedenceSpace: Aimed<ReadonlyArray<OperationSketch>, Feature> = aimed(
	caseGen(element<ReadonlyArray<0 | 1>>([[0], [1], [0, 1]]), (op) => op),
	[
		[
			"a command named by config",
			caseGen(one, (op) => ({
				...op,
				configCommand: Option.some("configured-command"),
				skip: false
			}))
		],
		[
			"a command named by x-forge",
			caseGen(one, (op) => ({
				...none(op),
				forge: Option.some({ names: "method", method: "forgeMethod" }),
				fern: Option.some({ names: "method", method: "fernMethod" })
			}))
		],
		[
			"a command named by x-fern",
			caseGen(one, (op) => ({
				...none(op),
				fern: Option.some({ names: "method", method: "fernMethod" })
			}))
		],
		[
			"a command named by operationId",
			caseGen(one, (op) => ({ ...none(op), operationId: Option.some("fetch") }))
		],
		[
			"a command named by route",
			caseGen(one, (op) => ({ ...none(op), operationId: Option.none() }))
		],
		[
			"a group named by config",
			caseGen(one, (op) => ({
				...none(op),
				configGroup: Option.some("configured"),
				tags: ["things"]
			}))
		],
		[
			"a group named by x-forge",
			caseGen(one, (op) => ({
				...none(op),
				forge: Option.some({ names: "group", group: ["forge-group"] }),
				fern: Option.some({ names: "group", group: ["fern-group"] })
			}))
		],
		[
			"a group named by x-fern",
			caseGen(one, (op) => ({
				...none(op),
				fern: Option.some({ names: "group", group: ["fern-group"] }),
				tags: ["things"]
			}))
		],
		["a group named by tag", caseGen(one, (op) => ({ ...none(op), tags: ["things"] }))],
		["a group named by none", caseGen(one, (op) => ({ ...none(op), tags: [] }))],
		[
			"a group word dropped",
			caseGen(one, (op) => ({
				...none(op),
				operationId: Option.some("things_get"),
				tags: ["things"]
			}))
		],
		[
			"an extension alias",
			caseGen(one, (op) => ({
				...none(op),
				operationId: Option.some("zones_status_edit"),
				aliases: Option.some([
					{
						forge: Option.some({ names: "both", group: ["zones", "settings"], method: "pause" }),
						fern: Option.none(),
						operationId: Option.none()
					}
				])
			}))
		],
		[
			"a config alias",
			caseGen(one, (op) => ({
				...none(op),
				operationId: Option.some("zones_status_edit"),
				configAliases: Option.some([
					{ group: Option.some(["zones"]), method: Option.some("pause") }
				])
			}))
		],
		[
			"a skipped operation",
			caseGen(both, (op) => ({
				...op,
				operationId: Option.some(op.slot === 0 ? "fetch" : "store"),
				skip: op.slot === 0
			}))
		],
		[
			"a nested extension group",
			caseGen(one, (op) => ({
				...none(op),
				forge: Option.some({ names: "both", group: ["accounts", "members"], method: "suspend" })
			}))
		]
	]
)
