import net from "node:net"
import { Array as Arr, Data, Effect, Record as Rec, Redacted, Result, String as Str } from "effect"
import pgDriver from "pg"
import {
	connectionSettings,
	poolSettings,
	servedLoginSettings,
	transportSettings
} from "#adapter/connection/config.ts"
import { TokenError } from "#adapter/errors/failures.ts"
import { parseServedConfig } from "#adapter/pool/served.ts"
import { served } from "#adapter/served/served.ts"
import type { DbConfigShape, Verify } from "#adapter/types/layer.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import { PlainLogin, WebLogin } from "#test/support/agreement/access-schema.ts"
import { testConnectTimeout } from "#test/support/limits.ts"
import {
	identifiers,
	preludeAt,
	preludeImports,
	type PreludeAt,
	preludeFrom
} from "#test/support/prelude.ts"

/**
 * The DbConfig agreement: DbLayer.make's config over a served login, as its type states it and as its reader reads it
 * (connection/config.ts parseConnection, pool/served.ts parseServedConfig), over every setting the reader's own rosters
 * name and every channel a setting's Effect or function states, and the one TypeScript program that states each verdict
 * as types, which the type tier checks (test/types/api/config.test.ts). The reader is the oracle: it refuses a config
 * with DbConfigRefused, and so does the layer once it reads the served file, for a config without the verify a login
 * whose role reads a context needs (verifyRequired, as the login's roles read their contexts).
 *
 * - The keys of each block's type, the top level, the transport and the pool, are exactly the reader's roster of its
 *   settings (connectionSettings and servedLoginSettings' settings, transportSettings, poolSettings).
 * - Each setting of each roster left out of an otherwise valid config, for a login whose role reads no context and one
 *   whose role reads Session: the types refuse it exactly where the reader does, at the call (TS2345) for a top-level
 *   setting and at its block's property (TS2741) for a nested one; and a key no roster names, in each block, both
 *   refuse at the key (TS2353).
 * - The channels the reader cannot see, each a type-only contract stated with its reason (typeOnly): a password is a
 *   Redacted or an Effect yielding one that fails only with CredentialError and needs no service; verify fails only
 *   with TokenError; and the driver's Client has pipeline mode, which every flight's one round trip needs. Over every
 *   combination of a password, a verify and a driver, the reader admits each config but the one missing the verify a
 *   login reading a context needs, and the types admit exactly what the reader admits and every contract holds. Each
 *   is stated as whether DbLayer.make's parameter takes the config's type (Takes, TS2344): a call would raise the
 *   Effect language service's restatement of the checker's refusal beside it.
 * - A config is of the login it names: a valid config of one login is taken for its own and never for the other
 *   (Takes, TS2344).
 */
const logins = { PlainLogin, WebLogin } as const
type LoginName = keyof typeof logins

/**
 * Each login served as its type, over the members of its served file served(...) reads: its base, its PostgreSQL role
 * and its roles' names. The reader reads no more of it.
 */
const servedOf = {
	PlainLogin: served<typeof PlainLogin>(
		{ base: "Work", role: "plain", roles: [{ name: "reader" }] },
		"plain"
	),
	WebLogin: served<typeof WebLogin>(
		{ base: "Work", role: "web", roles: [{ name: "member" }] },
		"web"
	)
} as const

/**
 * Whether the login's layer needs a verify: a role of it reads a context, some query entry of its relations matching
 * one, as the role its served file holds types its contexts.
 */
const verifyRequired = (login: LoginName): boolean =>
	Arr.some(loginDescOf(logins[login])?.roles ?? [], (role) =>
		Arr.some(
			role.relations,
			(entry) => entry.kind === "world" && queryUses(entry.query).contexts.size > 0
		)
	)

const loginNames: Arr.NonEmptyReadonlyArray<LoginName> = ["PlainLogin", "WebLogin"]

/** A config of either login, by the login it is of, so each is given to DbLayer.make at its own type. */
type LoginConfig =
	| { readonly login: "PlainLogin"; readonly config: DbConfigShape<typeof PlainLogin> }
	| { readonly login: "WebLogin"; readonly config: DbConfigShape<typeof WebLogin> }

/** A config of either login edited by `edit`, which keeps a config's type. */
const edited = (
	c: LoginConfig,
	edit: <C extends LoginConfig["config"]>(config: C) => C
): LoginConfig =>
	c.login === "PlainLogin"
		? { login: c.login, config: edit(c.config) }
		: { login: c.login, config: edit(c.config) }

/** The blocks a DbConfig nests, and each one's roster as the reader reads it. */
type Block = "top" | "transport" | "pool"

const rosterOf: { readonly [B in Block]: Arr.NonEmptyReadonlyArray<string> } = {
	top: [...connectionSettings, ...servedLoginSettings.settings],
	transport: transportSettings,
	pool: poolSettings
}

const blocks: Arr.NonEmptyReadonlyArray<Block> = ["top", "transport", "pool"]

/**
 * A password as a config states it: a Redacted, an Effect of one by its error and service channels, or plain text,
 * which neither admits.
 */
type Password = "redacted" | "credential" | "otherFailure" | "service" | "text"
const passwords: Arr.NonEmptyReadonlyArray<Password> = [
	"redacted",
	"credential",
	"otherFailure",
	"service",
	"text"
]

/** A verify as a config states it: none, one failing with TokenError, or one failing with another error. */
type VerifyKind = "none" | "token" | "otherFailure"
const verifies: Arr.NonEmptyReadonlyArray<VerifyKind> = ["none", "token", "otherFailure"]

/** A driver: node-postgres, or one whose Client has no pipeline mode. */
type Driver = "pg" | "unpipelined"
const drivers: Arr.NonEmptyReadonlyArray<Driver> = ["pg", "unpipelined"]

/**
 * The type-only contracts: the channels and the pipeline mode no reader of a JavaScript value can see, each with its
 * reason, and whether a drawn config keeps it.
 */
const typeOnly = {
	"a password Effect fails only with CredentialError": (c: ChannelCase) =>
		c.password !== "otherFailure",
	"a password Effect needs no service": (c: ChannelCase) => c.password !== "service",
	"verify fails only with TokenError": (c: ChannelCase) => c.verify !== "otherFailure",
	"a driver's Client has pipeline mode, which every flight's one round trip needs": (
		c: ChannelCase
	) => c.driver === "pg"
} as const

interface ChannelCase {
	readonly login: LoginName
	readonly password: Password
	readonly verify: VerifyKind
	readonly driver: Driver
}

const transport = {
	kind: "sslRequest",
	host: "localhost",
	port: 5433,
	open: () => new net.Socket(),
	ca: "PEM",
	servername: "localhost"
} as const

const pool = { max: 1, min: 0, idleTimeoutMs: testConnectTimeout.value } as const

/** A verify that refuses every token. */
const verifyToken: Verify = (token) => Effect.fail(new TokenError({ cause: token }))

/** What a verify failing with another error than TokenError fails with. */
class Unverified extends Data.TaggedError("Unverified")<{ readonly token: string }> {}

/** A valid config of the login: every setting, and verify where the login's role reads a context. */
const validConfig = (login: LoginName): LoginConfig => {
	const connection = {
		driver: pgDriver,
		transport,
		database: "work",
		password: Redacted.make("secret"),
		connectTimeoutMs: testConnectTimeout.value,
		pool
	}
	return login === "PlainLogin"
		? { login, config: { ...connection, login: servedOf.PlainLogin } }
		: { login, config: { ...connection, login: servedOf.WebLogin, verify: verifyToken } }
}

/** The config with `key` of `block` left out, the rest as valid. */
const omitted = (login: LoginName, block: Block, key: string): LoginConfig =>
	edited(validConfig(login), (config) => {
		switch (block) {
			case "top": {
				const copy = { ...config }
				Reflect.deleteProperty(copy, key)
				return copy
			}
			case "transport": {
				const copy = { ...config.transport }
				Reflect.deleteProperty(copy, key)
				return Object.assign({ ...config }, { transport: copy })
			}
			case "pool": {
				const copy = { ...config.pool }
				Reflect.deleteProperty(copy, key)
				return Object.assign({ ...config }, { pool: copy })
			}
		}
	})

/** The config with a key no roster names in `block`. */
const stranger = (login: LoginName, block: Block): LoginConfig => {
	const extra: Readonly<Record<string, unknown>> = { extra: 1 }
	return edited(validConfig(login), (config) => {
		switch (block) {
			case "top":
				return Object.assign({ ...config }, extra)
			case "transport":
				return Object.assign(
					{ ...config },
					{ transport: Object.assign({ ...config.transport }, extra) }
				)
			case "pool":
				return Object.assign({ ...config }, { pool: Object.assign({ ...config.pool }, extra) })
		}
	})
}

/** A channel case's config as a JavaScript caller passes it: every Effect and function opaque to the reader. */
const channelConfig = (c: ChannelCase): LoginConfig => {
	const password: Readonly<Record<string, unknown>> = {
		password:
			c.password === "redacted"
				? Redacted.make("secret")
				: c.password === "text"
					? "secret"
					: Effect.succeed(Redacted.make("secret"))
	}
	const verify: Readonly<Record<string, unknown>> =
		c.verify === "none"
			? {}
			: {
					verify: (token: string) =>
						Effect.fail(
							c.verify === "token" ? new TokenError({ cause: token }) : new Unverified({ token })
						)
				}
	const driver: Readonly<Record<string, unknown>> = {
		driver: { Client: pgDriver.Client, Pool: pgDriver.Pool, DatabaseError: pgDriver.DatabaseError }
	}
	return edited(validConfig(c.login), (config) => {
		const copy = Object.assign({ ...config }, password, c.driver === "pg" ? {} : driver)
		if (c.verify === "none") {
			Reflect.deleteProperty(copy, "verify")
		}
		return Object.assign(copy, verify)
	})
}

/**
 * The reader's verdict on a config: its parse admits it (pool/served.ts parseServedConfig), and it gives the verify its
 * login's layer refuses it without (verifyRequired).
 */
const readerAdmits = (c: LoginConfig): boolean => {
	const parsed =
		c.login === "PlainLogin" ? parseServedConfig(c.config) : parseServedConfig(c.config)
	const passed: unknown = c.config.verify
	return Result.isSuccess(parsed) && (passed !== undefined || !verifyRequired(c.login))
}

/** One statement of the program, under its directive where the types must refuse it. */
interface Stated {
	readonly lines: ReadonlyArray<string>
}

const union = (names: ReadonlyArray<string>): string => Arr.join(Arr.map(names, jsonText), " | ")

/** The setting lines of a valid config of the login, in the program, each with the block it is of. */
const settingLines = (
	login: LoginName,
	omit: { readonly block: Block; readonly key: string } | undefined,
	extra: Block | undefined
): ReadonlyArray<{ readonly text: string; readonly block: Block; readonly key: string }> => {
	const kept = (block: Block, key: string): boolean =>
		omit === undefined || omit.block !== block || omit.key !== key
	const line = (block: Block, key: string, text: string) =>
		kept(block, key) ? [{ text, block, key }] : []
	const nested = (
		block: "transport" | "pool",
		entries: ReadonlyArray<readonly [string, string]>
	) => [
		...line("top", block, `\t${block}: {`),
		...(kept("top", block)
			? [
					...Arr.flatMap(entries, ([key, value]) => line(block, key, `\t\t${key}: ${value},`)),
					...(extra === block ? [{ text: "\t\textra: 1,", block, key: "extra" }] : []),
					{ text: "\t},", block: "top" as const, key: `${block}.end` }
				]
			: [])
	]
	return [
		...line("top", "driver", "\tdriver: pgDriver,"),
		...nested("transport", [
			["kind", '"sslRequest"'],
			["host", '"localhost"'],
			["port", "5433"],
			["open", "() => new net.Socket()"],
			["ca", '"PEM"'],
			["servername", '"localhost"']
		]),
		...line("top", "database", '\tdatabase: "work",'),
		...line("top", "password", '\tpassword: Redacted.make("secret"),'),
		...line("top", "connectTimeoutMs", "\tconnectTimeoutMs: 1000,"),
		...nested("pool", [
			["max", "1"],
			["min", "0"],
			["idleTimeoutMs", "1000"]
		]),
		...line("top", "login", `\tlogin: ${login}Served,`),
		...(login === "WebLogin" ? line("top", "verify", "\tverify: verifyToken,") : []),
		...(extra === "top" ? [{ text: "\textra: 1,", block: "top" as const, key: "extra" }] : [])
	]
}

/** A config left out one setting, or given a stranger key, as one DbLayer.make call under its directive. */
const callOf = (
	name: string,
	login: LoginName,
	omit: { readonly block: Block; readonly key: string } | undefined,
	extra: Block | undefined,
	admitted: boolean
): Stated => {
	const lines = settingLines(login, omit, extra)
	const call = `export const ${name} = DbLayer.make({`
	if (admitted) {
		return { lines: [call, ...Arr.map(lines, (l) => l.text), "})"] }
	}
	if (extra !== undefined) {
		return {
			lines: [
				call,
				...Arr.flatMap(lines, (l) =>
					l.key === "extra"
						? [
								`${indentOf(l.text)}// @ts-expect-error -- TS2353: a key no setting of its block names`,
								l.text
							]
						: [l.text]
				),
				"})"
			]
		}
	}
	if (omit === undefined || omit.block === "top") {
		return {
			lines: [
				"// @ts-expect-error -- TS2345: a setting the reader requires is left out",
				call,
				...Arr.map(lines, (l) => l.text),
				"})"
			]
		}
	}
	return {
		lines: [
			call,
			...Arr.flatMap(lines, (l) =>
				l.block === "top" && l.key === omit.block
					? [
							`\t// @ts-expect-error -- TS2741: a setting of its block the reader requires is left out`,
							l.text
						]
					: [l.text]
			),
			"})"
		]
	}
}

/** A line's leading tabs, which its directive stands at. */
const indentOf = (line: string): string =>
	Str.slice(0, line.length - Str.trimStart(line).length)(line)

/** The program's statement of a channel case: its config's type taken by DbLayer.make's parameter, or refused. */
const channelOf = (c: ChannelCase, i: number): Stated => {
	const admitted = readerAdmits(channelConfig(c))
	const broken = Arr.filter(Rec.toEntries(typeOnly), ([, holds]) => !holds(c))
	const password = {
		redacted: 'Redacted.make("secret")',
		credential: "credentialPassword",
		otherFailure: "failingPassword",
		service: "servicedPassword",
		text: '"secret"'
	}[c.password]
	const verify = {
		none: "",
		token: ", verify: verifyToken",
		otherFailure: ", verify: verifyFailing"
	}[c.verify]
	const driver = c.driver === "pg" ? "" : ", driver: unpipelined"
	const refused = !admitted || Arr.isReadonlyArrayNonEmpty(broken)
	return {
		lines: [
			`const k${i} = { ...base, login: ${c.login}Served, password: ${password}${verify}${driver} } as const`,
			...(refused
				? [
						`// @ts-expect-error -- TS2344: ${Arr.isReadonlyArrayNonEmpty(broken) ? broken[0][0] : "the reader refuses the config"}`
					]
				: []),
			`export type c${i} = Expect<Takes<typeof ${c.login}, typeof k${i}>>`
		]
	}
}

/** Every channel case: each login, password, verify and driver, once. */
const channelCases: ReadonlyArray<ChannelCase> = Arr.flatMap(loginNames, (login) =>
	Arr.flatMap(passwords, (password) =>
		Arr.flatMap(verifies, (verify) =>
			Arr.map(drivers, (driver): ChannelCase => ({ login, password, verify, driver }))
		)
	)
)

/** The DbConfig program's prelude (test/support/programs/dbconfig.ts), every repository name it reads. */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/dbconfig.ts"))

export const configEntriesFrom = (entry: (path: string) => string): PreludeAt =>
	preludeFrom(prelude, entry)

/** The program: the blocks' keys, every omission and stranger, and every channel case. */
export const configModule = (entries: PreludeAt): string => {
	const omissions = Arr.flatMap(loginNames, (login) =>
		Arr.flatMap(blocks, (block) =>
			Arr.map(rosterOf[block], (key, at) =>
				callOf(
					`o_${login}_${block}_${at}`,
					login,
					{ block, key },
					undefined,
					readerAdmits(omitted(login, block, key))
				)
			)
		)
	)
	const strangers = Arr.flatMap(loginNames, (login) =>
		Arr.map(blocks, (block) => {
			if (readerAdmits(stranger(login, block))) {
				throw new Error(`the reader admits a key no roster of ${block} names`)
			}
			return callOf(`s_${login}_${block}`, login, undefined, block, false)
		})
	)
	const channels = Arr.map(channelCases, channelOf)
	const relabelled = Arr.flatMap(loginNames, (given) =>
		Arr.map(loginNames, (target): Stated => ({
			lines: [
				...(given === target
					? []
					: ["// @ts-expect-error -- TS2344: a config is of the login it names"]),
				`export type r_${given}_${target} = Expect<Takes<typeof ${target}, typeof v_${given}>>`
			]
		}))
	)
	const text = Arr.join(
		[
			"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
			"type Expect<T extends true> = T",
			"/** Whether DbLayer.make takes the config C for the login L: whether C is assignable to its parameter. */",
			"type Takes<L, C> = [C] extends [DbConfigShape<L>] ? true : false",
			"declare const file: unknown",
			'const PlainLoginServed = served<typeof PlainLogin>(file, "plain")',
			'const WebLoginServed = served<typeof WebLogin>(file, "web")',
			"declare const verifyToken: Verify",
			"declare const verifyFailing: (token: string) => Effect.Effect<unknown, Error>",
			"declare const credentialPassword: Effect.Effect<Redacted.Redacted, CredentialError>",
			"declare const failingPassword: Effect.Effect<Redacted.Redacted, Error>",
			'declare const servicedPassword: Effect.Effect<Redacted.Redacted, CredentialError, "Vault">',
			'declare const unpipelined: Omit<typeof pgDriver, "Client"> & { readonly Client: new (config: ClientConfig) => Omit<Client, "pipeline"> }',
			'const base = { driver: pgDriver, transport: { kind: "sslRequest", host: "localhost", port: 5433, open: () => new net.Socket(), ca: "PEM", servername: "localhost" }, database: "work", connectTimeoutMs: 1000, pool: { max: 1, min: 0, idleTimeoutMs: 1000 } } as const',
			"",
			`export type k_top = Expect<Equals<keyof DbConfigShape<typeof PlainLogin>, ${union(rosterOf.top)}>>`,
			`export type k_transport = Expect<Equals<keyof Transport, ${union(rosterOf.transport)}>>`,
			`export type k_pool = Expect<Equals<keyof PoolBounds, ${union(rosterOf.pool)}>>`,
			"",
			"const v_PlainLogin = { ...base, login: PlainLoginServed, password: credentialPassword } as const",
			"const v_WebLogin = { ...base, login: WebLoginServed, password: credentialPassword, verify: verifyToken } as const",
			"",
			...Arr.flatMap([...omissions, ...strangers, ...channels, ...relabelled], (s) => [
				...s.lines,
				""
			])
		],
		"\n"
	)
	return Arr.join(
		[
			"// Generated by test/support/agreement/dbconfig.ts: the DbConfig type/reader agreement.",
			'import net from "node:net"',
			'import pgDriver, { type Client, type ClientConfig } from "pg"',
			...preludeImports(entries, identifiers(text)),
			"",
			text
		],
		"\n"
	)
}

/** The size of the program's space: every omission, stranger, channel case and relabelling. */
export const configSize =
	Arr.reduce(blocks, 0, (n, b) => n + rosterOf[b].length) * loginNames.length +
	blocks.length * loginNames.length +
	channelCases.length +
	loginNames.length * loginNames.length
