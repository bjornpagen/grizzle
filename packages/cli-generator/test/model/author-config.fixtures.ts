/** What the property of author-config.test.ts reads: its space, its model of the refusals and its helpers. */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import {
	aimed,
	type Aimed,
	array,
	boolean,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Effect, Exit, Option, Order, Predicate, Record, String as Str } from "effect"
import { decodeAuthorConfig } from "#model/author-config.ts"
import type { AuthorConfigContext } from "#model/author-config.ts"
import { fixedDocumentUri } from "#model/brands.ts"
import type { Diagnostic } from "#model/diagnostic.ts"

/** The rule a refusal names after `CFG-1/` (design 4.8). */
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

/** A fault planted in a config: where its refusal points, the rule it names, and a value its message must not echo. */
type Planted = Readonly<{ at: ReadonlyArray<string>; rule: Rule; secret: Option.Option<string> }>

/** One top-level member of a config, absent when a fault removes it, and the faults planted in it. */
type Member = Readonly<{
	key: string
	value: Option.Option<Json>
	planted: ReadonlyArray<Planted>
}>

/** A config as drawn: its members, or a value that is no object at all; and the folded title its context offers. */
export type ConfigCase = Readonly<{
	root:
		| Readonly<{ kind: "object"; members: ReadonlyArray<Member> }>
		| Readonly<{ kind: "other"; value: Json }>
	foldedTitle: Option.Option<string>
}>

export type Feature =
	| "a valid config"
	| "a missing bin name"
	| "an invalid bin name"
	| "an unsafe commands module"
	| "an unsupported key"
	| "an unknown key"
	| "a missing key"
	| "an invalid version"
	| "an invalid value"
	| "an invalid field pointer"
	| "an invalid field flag"
	| "an alias refused"
	| "a key escaped in its pointer"
	| "a value at the root that is no object"
	| "several refusals in pointer order"
	| "a hint naming the folded title"

const ruleFeature: Readonly<Record<Rule, Feature>> = {
	"invalid-bin-name": "an invalid bin name",
	"invalid-field-flag": "an invalid field flag",
	"invalid-field-pointer": "an invalid field pointer",
	"invalid-version": "an invalid version",
	"invalid-value": "an invalid value",
	"missing-bin-name": "a missing bin name",
	"missing-key": "a missing key",
	"unknown-key": "an unknown key",
	"unsafe-commands-module": "an unsafe commands module",
	"unsupported-key": "an unsupported key"
}

const plant = (at: ReadonlyArray<string>, rule: Rule): Planted => ({
	at,
	rule,
	secret: Option.none()
})

const plantSecret = (at: ReadonlyArray<string>, rule: Rule, secret: string): Planted => ({
	at,
	rule,
	secret: Option.some(secret)
})

const valid = (key: string, value: Json): Member => ({
	key,
	value: Option.some(value),
	planted: []
})

const faulty = (key: string, value: Json, planted: Planted): Member => ({
	key,
	value: Option.some(value),
	planted: [planted]
})

/** A bin name the pattern `^[a-z][a-z0-9-]*$` admits, built letter by letter. */
const binNameGen: Gen<string> = (s) =>
	`${s.draw(characterOf(["a", "b", "x", "z"]))}${s.draw(string(characterOf(["a", "q", "0", "9", "-"]), { min: 0, max: 6 }))}`

/** A semver 2.0.0 version: three numbers, then a prerelease and build metadata or neither. */
const versionGen: Gen<string> = (s) => {
	const core = `${s.draw(int(0, 12))}.${s.draw(int(0, 12))}.${s.draw(int(0, 12))}`
	const pre = s.draw(option(array(element(["rc", "1", "0", "alpha-1", "x9"]), { min: 1, max: 3 })))
	const build = s.draw(option(array(element(["build", "5", "001", "sha-abc"]), { min: 1, max: 2 })))
	const preText = Option.match(pre, { onNone: () => "", onSome: (ids) => `-${Arr.join(ids, ".")}` })
	const buildText = Option.match(build, {
		onNone: () => "",
		onSome: (ids) => `+${Arr.join(ids, ".")}`
	})
	return `${core}${preText}${buildText}`
}

/** Versions semver 2.0.0 refuses: a missing part, a leading zero, an empty identifier, whitespace, a prefix, controls. */
const badVersion = element([
	"1",
	"1.0",
	"01.0.0",
	"1.0.0-",
	"1.0.0+",
	"1.0.0-01",
	"1.0.0 ",
	" 1.0.0",
	"1.0.0-'rc'\u2028",
	"v1.0.0",
	"1.0.0\n",
	""
])

const badBinName = element(["", "1abc", "-abc", "ab_c", "ab c", "abc\n", "Example"])

/** `commands.module` values that leave the package, or are not `./` and plain segments. */
const badModule = element([
	"/abs/commands.ts",
	"../outside.ts",
	"./a/../x.ts",
	".\\x.ts",
	"./a//x.ts",
	"./",
	"."
])

const moduleGen: Gen<string> = (s) =>
	`./${Arr.join(s.draw(array(element(["custom", "commands.ts", "a", "x.ts", "lib"]), { min: 1, max: 3 })), "/")}`

const flagGen = element(["foo-bar-raw", "meta.label", "x", "a1.b-2"])

const badFlag = element(["", "Foo", "foo bar", "--foo", "foo-", "1foo", "foo..bar", "foo_bar"])

const badFieldKey = element(["foo_bar", "", "/a~2b", "a/b~"])

/** An alias entry the config admits: a dotted or array group with a method, a group alone, or a method alone. */
const aliasGen: Gen<Json> = oneOf<Json>([
	(s) => ({
		group: s.draw(element(["zones", "zones.settings", "a.b.c"])),
		method: s.draw(element(["pause", "halt"]))
	}),
	(s) => ({ group: s.draw(array(element(["zones", "settings", "v2.x"]), { min: 1, max: 2 })) }),
	(s) => ({ method: s.draw(element(["pause", "halt"])) })
])

const entryOf = <A>(key: string, value: Option.Option<A>): Option.Option<readonly [string, A]> =>
	Option.map(value, (present) => [key, present] as const)

/** One operation override, every member optional and valid. */
const overrideGen: Gen<Json> = (s) =>
	Record.fromEntries(
		Arr.getSomes([
			entryOf("aliases", s.draw(option(array(aliasGen, { min: 0, max: 2 })))),
			entryOf("command", s.draw(option(element(["update", "list-all"])))),
			entryOf(
				"fields",
				Option.map(s.draw(option(element(["/foo_bar", "/meta/name", "/a~1b"]))), (field) => ({
					[field]: { flag: s.draw(flagGen) }
				}))
			),
			entryOf("group", s.draw(option(element(["ops", "users"])))),
			entryOf(
				"parameters",
				Option.map(
					s.draw(option(element(["header:If-Match", "query:page", "path:id"]))),
					(key) => ({
						[key]: { flag: "renamed" }
					})
				)
			),
			entryOf("skip", s.draw(option(boolean)))
		])
	)

/** Where a naming override sits: under an operationId, or under an operation's pointer. */
type Container = Readonly<{ name: "operations" | "byPointer"; key: string }>

const containerGen: Gen<Container> = oneOf<Container>([
	(s) => ({ name: "operations", key: s.draw(element(["make", "users-update", "a/b~c"])) }),
	(s) => ({ name: "byPointer", key: s.draw(element(["/paths/~1x/post", "/paths/~1health/get"])) })
])

/** What a naming fault breaks: a field's pointer key, a field's flag, or an alias. */
type NamingFault = "field pointer" | "field flag" | "alias"

/** A naming fault planted in an override: the override, and the refusals at the override's tokens `at`. */
type PlantedOverride = Readonly<{
	override: Json
	planted: (at: ReadonlyArray<string>) => Planted
}>

/** An alias fault: the entry, where below `aliases/<index>` its refusal points, and its rule. */
type AliasFault = readonly [entry: Json, tail: ReadonlyArray<string>, rule: Rule]

const aliasFault = element<AliasFault>([
	[{}, [], "invalid-value"],
	[{ method: "" }, ["method"], "invalid-value"],
	[{ group: "" }, ["group"], "invalid-value"],
	[{ group: "a..b" }, ["group"], "invalid-value"],
	[{ group: ["a", ""] }, ["group", "1"], "invalid-value"],
	["x", [], "invalid-value"],
	[{ command: "x", method: "y" }, ["command"], "unknown-key"]
])

const plantedOverrideGen = (fault: NamingFault): Gen<PlantedOverride> => {
	switch (fault) {
		case "field pointer":
			return (s) => {
				const key = s.draw(badFieldKey)
				return {
					override: { fields: { [key]: { flag: "foo" } } },
					planted: (at) => plant([...at, "fields", key], "invalid-field-pointer")
				}
			}
		case "field flag":
			return (s) => ({
				override: { fields: { "/x": { flag: s.draw(badFlag) } } },
				planted: (at) => plant([...at, "fields", "/x", "flag"], "invalid-field-flag")
			})
		case "alias":
			return oneOf<PlantedOverride>([
				(s) => {
					const [entry, tail, rule] = s.draw(aliasFault)
					const index = s.draw(int(0, 1))
					return {
						override: { aliases: index === 0 ? [entry] : [{ method: "halt" }, entry] },
						planted: (at) => plant([...at, "aliases", `${index}`, ...tail], rule)
					}
				},
				constant<PlantedOverride>({
					override: { aliases: { method: "x" } },
					planted: (at) => plant([...at, "aliases"], "invalid-value")
				})
			])
	}
}

/** The `naming` member: overrides under both containers that decode, one of them carrying `fault` when one is drawn. */
const namingGen =
	(fault: Option.Option<NamingFault>): Gen<Member> =>
	(s) => {
		const container = s.draw(containerGen)
		const planted = Option.map(fault, (kind) => s.draw(plantedOverrideGen(kind)))
		const other = container.name === "operations" ? "byPointer" : "operations"
		const otherKey = container.name === "operations" ? "/paths/~1other/get" : "other"
		const value: Json = {
			[container.name]: {
				[container.key]: Option.match(planted, {
					onNone: () => s.draw(overrideGen),
					onSome: (one) => one.override
				})
			},
			[other]: { [otherKey]: s.draw(overrideGen) }
		}
		return {
			key: "naming",
			value: Option.some(value),
			planted: Option.match(planted, {
				onNone: () => [],
				onSome: (one) => [one.planted(["naming", container.name, container.key])]
			})
		}
	}

/** Which members a case plants a fault in, each one or none. */
type Faults = Readonly<{
	binName: Option.Option<"missing" | "invalid" | "not a string">
	pkg: Option.Option<"unknown key" | "missing version" | "invalid version">
	commands: boolean
	assertPatterns: boolean
	extra: boolean
	typed: Option.Option<"allowInsecure" | "envPrefix">
	naming: Option.Option<NamingFault>
	nonStandard: Option.Option<"not a boolean" | "unknown key">
}>

const noFaults: Faults = {
	binName: Option.none(),
	pkg: Option.none(),
	commands: false,
	assertPatterns: false,
	extra: false,
	typed: Option.none(),
	naming: Option.none(),
	nonStandard: Option.none()
}

/** A fault one time in five. */
const rarely = <A>(gen: Gen<A>): Gen<Option.Option<A>> =>
	weighted<Option.Option<A>>([
		[4, constant(Option.none())],
		[1, map(gen, Option.some)]
	])

const sometimes: Gen<boolean> = map(rarely(constant(true)), Option.isSome)

/** Each member's fault drawn on its own, mostly absent. */
const faultsGen: Gen<Faults> = (s) => ({
	binName: s.draw(rarely(element(["missing", "invalid", "not a string"]))),
	pkg: s.draw(rarely(element(["unknown key", "missing version", "invalid version"]))),
	commands: s.draw(sometimes),
	assertPatterns: s.draw(sometimes),
	extra: s.draw(sometimes),
	typed: s.draw(rarely(element(["allowInsecure", "envPrefix"]))),
	naming: s.draw(rarely(element(["field pointer", "field flag", "alias"]))),
	nonStandard: s.draw(rarely(element(["not a boolean", "unknown key"])))
})

const binNameMember = (fault: Faults["binName"]): Gen<Member> =>
	Option.match(fault, {
		onNone: (): Gen<Member> => map(binNameGen, (name) => valid("binName", name)),
		onSome: (kind): Gen<Member> => {
			switch (kind) {
				case "missing":
					return constant<Member>({
						key: "binName",
						value: Option.none(),
						planted: [plant(["binName"], "missing-bin-name")]
					})
				case "invalid":
					return map(badBinName, (name) =>
						faulty("binName", name, plant(["binName"], "invalid-bin-name"))
					)
				case "not a string":
					return constant(faulty("binName", 3, plant(["binName"], "invalid-bin-name")))
			}
		}
	})

const packageMember = (fault: Faults["pkg"]): Gen<Member> =>
	Option.match(fault, {
		onNone: (): Gen<Member> =>
			map(versionGen, (version) => valid("package", { name: "example-cli", version })),
		onSome: (kind): Gen<Member> => {
			switch (kind) {
				case "unknown key":
					return constant(
						faulty(
							"package",
							{ extra: 1, name: "x", version: "1.0.0" },
							plant(["package", "extra"], "unknown-key")
						)
					)
				case "missing version":
					return constant(
						faulty("package", { name: "x" }, plant(["package", "version"], "missing-key"))
					)
				case "invalid version":
					return map(badVersion, (version) =>
						faulty(
							"package",
							{ name: "x", version },
							plantSecret(["package", "version"], "invalid-version", version)
						)
					)
			}
		}
	})

/** An optional member: absent or valid, or faulty when its fault is drawn. */
const optionalMember = (
	planted: boolean,
	faultyGen: Gen<Member>,
	validGen: Gen<Member>
): Gen<ReadonlyArray<Member>> =>
	planted
		? map(faultyGen, (one) => [one])
		: oneOf<ReadonlyArray<Member>>([constant([]), map(validGen, (one) => [one])])

const commandsMember = (planted: boolean): Gen<ReadonlyArray<Member>> =>
	optionalMember(
		planted,
		map(badModule, (module) =>
			faulty(
				"commands",
				{ module, names: ["login"] },
				plantSecret(["commands", "module"], "unsafe-commands-module", module)
			)
		),
		(s) =>
			valid("commands", {
				module: s.draw(moduleGen),
				names: s.draw(array(element(["login", "logout"]), { min: 0, max: 2 }))
			})
	)

const assertPatternsMember = (planted: boolean): Gen<ReadonlyArray<Member>> =>
	planted
		? map(boolean, (on) => [
				faulty("assertPatterns", on, plant(["assertPatterns"], "unsupported-key"))
			])
		: constant([])

const extraMember = (planted: boolean): Gen<ReadonlyArray<Member>> =>
	planted
		? map(element(["bogus", "aaa", "zzz", "a/b~c", "~"]), (key) => [
				faulty(key, 1, plant([key], "unknown-key"))
			])
		: constant([])

const allowInsecureMember = (planted: boolean): Gen<ReadonlyArray<Member>> =>
	optionalMember(
		planted,
		constant(faulty("allowInsecure", "yes", plant(["allowInsecure"], "invalid-value"))),
		map(boolean, (on) => valid("allowInsecure", on))
	)

const envPrefixMember = (planted: boolean): Gen<ReadonlyArray<Member>> =>
	optionalMember(
		planted,
		map(element(["lower", "Example", "A__B"]), (prefix) =>
			faulty("envPrefix", prefix, plant(["envPrefix"], "invalid-value"))
		),
		map(element(["EXAMPLE", "PETS_API", "A1"]), (prefix) => valid("envPrefix", prefix))
	)

const namingMember = (fault: Option.Option<NamingFault>): Gen<ReadonlyArray<Member>> =>
	Option.isSome(fault)
		? map(namingGen(fault), (one) => [one])
		: oneOf<ReadonlyArray<Member>>([constant([]), map(namingGen(fault), (one) => [one])])

const switchName = element(["deepObjectBrackets", "deepObjectScalars"])

const nonStandardMember = (fault: Faults["nonStandard"]): Gen<ReadonlyArray<Member>> =>
	Option.match(fault, {
		onNone: () =>
			oneOf<ReadonlyArray<Member>>([
				constant([]),
				(s) => [
					valid(
						"nonStandard",
						Record.fromEntries(
							Arr.getSomes([
								entryOf("deepObjectBrackets", s.draw(option(boolean))),
								entryOf("deepObjectScalars", s.draw(option(boolean)))
							])
						)
					)
				]
			]),
		onSome: (kind): Gen<ReadonlyArray<Member>> =>
			kind === "not a boolean"
				? (s) => {
						const name = s.draw(switchName)
						return [
							faulty(
								"nonStandard",
								{ [name]: s.draw(element(["true", 1])) },
								plant(["nonStandard", name], "invalid-value")
							)
						]
					}
				: (s) => {
						const key = s.draw(element(["x", "scalars"]))
						return [
							faulty(
								"nonStandard",
								{ [s.draw(switchName)]: true, [key]: 1 },
								plant(["nonStandard", key], "unknown-key")
							)
						]
					}
	})

/** The members no fault reaches, each present or absent. */
const plainMembers: Gen<ReadonlyArray<Member>> = (s) =>
	Arr.flatten([
		s.draw(
			optionalMember(
				false,
				constant(valid("acceptedOrigins", [])),
				map(
					array(element(["https://eu.example.com", "https://us.example.com"]), { min: 0, max: 2 }),
					(origins) => valid("acceptedOrigins", origins)
				)
			)
		),
		s.draw(
			optionalMember(
				false,
				constant(valid("retrievalUri", "")),
				constant(valid("retrievalUri", "https://example.com/openapi.json"))
			)
		),
		s.draw(
			optionalMember(
				false,
				constant(valid("servers", {})),
				map(
					array(element(["https://api.example.com", "http://localhost:8080"]), { min: 0, max: 2 }),
					(accepted) => valid("servers", { accepted })
				)
			)
		),
		s.draw(
			optionalMember(false, constant(valid("security", {})), (inner) =>
				valid(
					"security",
					Record.fromEntries([
						...Arr.map(
							inner.draw(array(element(["bearerAuth", "apiKey", "addon"]), { min: 0, max: 2 })),
							(scheme) => [scheme, { env: "EXAMPLE_TOKEN" }] as const
						),
						...(inner.draw(boolean)
							? [
									[
										"add",
										{
											requirement: [{ authorToken: [] }],
											schemes: { authorToken: { scheme: "bearer", type: "http" } }
										}
									] as const
								]
							: [])
					])
				)
			)
		)
	])

/** A config with `faults` planted member by member, under a context whose folded title is drawn by `title`. */
const caseOf =
	(faults: Gen<Faults>, title: Gen<Option.Option<string>>): Gen<ConfigCase> =>
	(s) => {
		const drawnFaults = s.draw(faults)
		const members = Arr.flatten([
			[s.draw(binNameMember(drawnFaults.binName)), s.draw(packageMember(drawnFaults.pkg))],
			s.draw(commandsMember(drawnFaults.commands)),
			s.draw(assertPatternsMember(drawnFaults.assertPatterns)),
			s.draw(extraMember(drawnFaults.extra)),
			s.draw(allowInsecureMember(Option.contains(drawnFaults.typed, "allowInsecure"))),
			s.draw(envPrefixMember(Option.contains(drawnFaults.typed, "envPrefix"))),
			s.draw(namingMember(drawnFaults.naming)),
			s.draw(nonStandardMember(drawnFaults.nonStandard)),
			s.draw(plainMembers)
		])
		return { root: { kind: "object", members }, foldedTitle: s.draw(title) }
	}

const titleGen: Gen<Option.Option<string>> = option(element(["example-api", "pets"]))

const titled: Gen<Option.Option<string>> = map(element(["example-api", "pets"]), Option.some)

const nonObject: Gen<ConfigCase> = (s) => ({
	root: { kind: "other", value: s.draw(element<Json>([[], null, "config", 3])) },
	foldedTitle: s.draw(titleGen)
})

const only = (faults: Partial<Faults>): Gen<Faults> => constant({ ...noFaults, ...faults })

const aimedAt = (faults: Partial<Faults>): Gen<ConfigCase> => caseOf(only(faults), titleGen)

/** Configs, most with no fault or one, aimed at each refusal while it is pending. */
export const configSpace: Aimed<ConfigCase, Feature> = aimed(
	weighted([
		[3, caseOf(faultsGen, titleGen)],
		[1, nonObject]
	]),
	[
		["a valid config", aimedAt({})],
		["a missing bin name", aimedAt({ binName: Option.some("missing") })],
		["an invalid bin name", aimedAt({ binName: Option.some("invalid") })],
		["an unsafe commands module", aimedAt({ commands: true })],
		["an unsupported key", aimedAt({ assertPatterns: true })],
		["an unknown key", aimedAt({ extra: true })],
		["a missing key", aimedAt({ pkg: Option.some("missing version") })],
		["an invalid version", aimedAt({ pkg: Option.some("invalid version") })],
		["an invalid value", aimedAt({ typed: Option.some("allowInsecure") })],
		["an invalid field pointer", aimedAt({ naming: Option.some("field pointer") })],
		["an invalid field flag", aimedAt({ naming: Option.some("field flag") })],
		["an alias refused", aimedAt({ naming: Option.some("alias") })],
		[
			"a key escaped in its pointer",
			aimedAt({ extra: true, naming: Option.some("field pointer") })
		],
		["a value at the root that is no object", nonObject],
		[
			"several refusals in pointer order",
			aimedAt({
				binName: Option.some("missing"),
				extra: true,
				nonStandard: Option.some("unknown key")
			})
		],
		["a hint naming the folded title", caseOf(only({ binName: Option.some("missing") }), titled)]
	]
)

/** The config JSON a case holds. */
const inputOf = (c: ConfigCase): Json =>
	c.root.kind === "other"
		? c.root.value
		: Record.fromEntries(
				Arr.flatMap(c.root.members, (m) => Arr.getSomes([entryOf(m.key, m.value)]))
			)

/** Every fault planted in a case; a root that is no object is the one refusal at the root. */
const plantedOf = (c: ConfigCase): ReadonlyArray<Planted> =>
	c.root.kind === "other"
		? [plant([], "invalid-value")]
		: Arr.flatMap(c.root.members, (m) => m.planted)

/** RFC 6901's escape of one token: `~` as `~0`, then `/` as `~1`. */
const escaped = (token: string): string =>
	Str.replaceAll("/", "~1")(Str.replaceAll("~", "~0")(token))

/** A pointer's text: each escaped token after a `/`. */
const pointerText = (tokens: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(tokens, (token) => `/${escaped(token)}`),
		""
	)

const canonicalIndex = regex("^(?:0|[1-9][0-9]*)$", "u")

/** Design 3.7's pointer order, over the text's tokens as written: two array indices by number, any other pair by code units. */
const tokenOrder: Order.Order<string> = Order.make((left, right) =>
	canonicalIndex.test(left) && canonicalIndex.test(right)
		? Order.Number(Number(left), Number(right))
		: Order.String(left, right)
)

const plantedOrder: Order.Order<Planted> = Order.combine(
	Order.mapInput(Order.Array(tokenOrder), (p: Planted) => Arr.map(p.at, escaped)),
	Order.mapInput(Order.String, (p: Planted) => p.rule)
)

const document = fixedDocumentUri("file:///work/author.json")

const contextOf = (c: ConfigCase): AuthorConfigContext =>
	Option.match(c.foldedTitle, {
		onNone: () => ({ document }),
		onSome: (foldedTitle) => ({ document, foldedTitle })
	})

/** A refusal as the property compares it: where and what, and what it carries of its context. */
type Refusal = Readonly<{
	pointer: string
	code: string
	scope: string
	severity: string
	document: string
	row: string
	hint: "no hint" | "a hint naming the folded title" | "another hint"
	echoes: ReadonlyArray<string>
}>

/** What the decoder answers: the config it read, or its refusals in the order it reports them. */
export type Answer =
	| Readonly<{ kind: "decoded"; config: unknown }>
	| Readonly<{ kind: "refused"; refusals: ReadonlyArray<Refusal> }>

/** The planted values long enough that a message or hint holding one can only have echoed it. */
const secretsOf = (c: ConfigCase): ReadonlyArray<string> =>
	Arr.filter(
		Arr.getSomes(Arr.map(plantedOf(c), (p) => p.secret)),
		(secret) => Str.trim(secret).length >= 4
	)

/** `security` as the config reads it (AuthorSecurity): its `add` apart from its credentials, every other key. */
const securityRead = (security: unknown): unknown =>
	Predicate.isObject(security)
		? {
				...Option.match(Record.get(security, "add"), {
					onNone: () => ({}),
					onSome: (add) => ({ add })
				}),
				credentials: Record.remove(security, "add")
			}
		: security

/** A config object with its `security`, when it has one, as the config reads it. */
const withSecurityRead = (config: Readonly<Record<string, unknown>>): unknown =>
	Option.match(Record.get(config, "security"), {
		onNone: () => config,
		onSome: (security) => ({ ...config, security: securityRead(security) })
	})

/** The config a case with no fault reads to: its JSON, but its `security` as the config reads it. */
const readOf = (input: Json): unknown =>
	Predicate.isObject(input) ? withSecurityRead(input) : input

/**
 * What the decoder must answer: the config itself, its `security` read apart from `add`; or each planted refusal once,
 * in design 3.7's order, a document refusal of row CFG-1 in the config's document, hinting the folded title exactly
 * for a missing bin name under a context that knows one, echoing no planted value.
 */
export const expectedOf = (c: ConfigCase): Answer => {
	const planted = plantedOf(c)
	return Arr.isReadonlyArrayNonEmpty(planted)
		? {
				kind: "refused",
				refusals: Arr.map(Arr.sort(planted, plantedOrder), (p): Refusal => ({
					pointer: pointerText(p.at),
					code: `CFG-1/${p.rule}`,
					scope: "document",
					severity: "refusal",
					document,
					row: "CFG-1",
					hint:
						p.rule === "missing-bin-name" && Option.isSome(c.foldedTitle)
							? "a hint naming the folded title"
							: "no hint",
					echoes: []
				}))
			}
		: { kind: "decoded", config: readOf(inputOf(c)) }
}

const hintOf = (c: ConfigCase, hint: string | undefined): Refusal["hint"] =>
	hint === undefined
		? "no hint"
		: Option.exists(c.foldedTitle, (title) => Str.includes(title)(hint))
			? "a hint naming the folded title"
			: "another hint"

/** A refusal as the model reads it: its context checked, its message and hint searched for planted values. */
const refusalOf =
	(c: ConfigCase) =>
	(d: Diagnostic): Refusal => ({
		pointer: d.pointer,
		code: d.code,
		scope: d.scope,
		severity: d.severity,
		document: d.document,
		row: d.row,
		hint: hintOf(c, d.hint),
		echoes: Arr.filter(
			secretsOf(c),
			(secret) => Str.includes(secret)(d.message) || Str.includes(secret)(d.hint ?? "")
		)
	})

/** What the decoder answered for a case, read as the model states it. */
export const actualOf = (c: ConfigCase): Effect.Effect<Answer> =>
	Effect.gen(function* () {
		const exit = yield* Effect.exit(decodeAuthorConfig(inputOf(c), contextOf(c)))
		if (Exit.isSuccess(exit)) {
			return { kind: "decoded", config: exit.value }
		}
		return {
			kind: "refused",
			refusals: Arr.flatMap(exit.cause.reasons, (reason) =>
				reason._tag === "Fail" ? Arr.map(reason.error.diagnostics, refusalOf(c)) : []
			)
		}
	})

/** The situations a case reaches, read off its planted faults. */
export const featuresOf = (c: ConfigCase): ReadonlyArray<Feature> => {
	const planted = plantedOf(c)
	const escapedKey = Arr.some(planted, (p) =>
		Arr.some(p.at, (token) => Str.includes("/")(token) || Str.includes("~")(token))
	)
	const hinted =
		Option.isSome(c.foldedTitle) && Arr.some(planted, (p) => p.rule === "missing-bin-name")
	const when = (holds: boolean, feature: Feature): ReadonlyArray<Feature> =>
		holds ? [feature] : []
	return [
		...when(c.root.kind === "other", "a value at the root that is no object"),
		...when(Arr.isReadonlyArrayEmpty(planted), "a valid config"),
		...when(planted.length > 1, "several refusals in pointer order"),
		...when(escapedKey, "a key escaped in its pointer"),
		...when(
			Arr.some(planted, (p) => Arr.contains(p.at, "aliases")),
			"an alias refused"
		),
		...when(hinted, "a hint naming the folded title"),
		...Arr.map(planted, (p) => ruleFeature[p.rule])
	]
}
