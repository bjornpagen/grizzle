import net from "node:net"
import { Array as Arr, Data, Effect, Record as Rec, Redacted, Result, String as Str } from "effect"
import pgDriver from "pg"
import {
	connectionSettings,
	poolSettings,
	servedLoginSettings,
	transportSettings
} from "#adapter/connection/config.ts"
import { TokenRefused } from "#adapter/errors/failures.ts"
import { parseServedConfig } from "#adapter/pool/served.ts"
import { served } from "#adapter/served/served.ts"
import type { DbConfigShape, Verify } from "#adapter/types/layer.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import { PlainLogin, WebLogin } from "#test/support/agreement/access-schema.ts"
import { compiledServedFile } from "#test/support/compiled-served.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

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
 *   whose role reads Session: the types refuse it exactly where the reader does; and a key no roster names, in each
 *   block, both refuse. Each call stands on one line, so its refusal is the line's, wherever the checker reports it.
 * - The channels the reader cannot see, each a type-only contract stated with its reason (typeOnly): a password is a
 *   Redacted or an Effect yielding one that fails only with CredentialError and needs no service; verify fails only
 *   with TokenRefused; and the driver's Client has pipeline mode, which every flight's one round trip needs. Over every
 *   combination of a password, a verify and a driver, the reader admits each config but the one missing the verify a
 *   login reading a context needs, and the types admit exactly what the reader admits and every contract holds. Each
 *   is stated as whether DbLayer.make's parameter takes the config's type (Takes): a call would raise the Effect
 *   language service's restatement of the checker's refusal beside it.
 * - A config is of the login it names: a valid config of one login is taken for its own and never for the other
 *   (Takes).
 *
 * Each block's keys, each omission and stranger, each channel case and each relabelling is a cell of the box; the
 * served logins, the declared channels and the valid configs the cells read are the batch's own.
 */
const logins = { PlainLogin, WebLogin } as const
type LoginName = keyof typeof logins

/**
 * Each login served as its type, over its real served file, compiled with no database (compiled-served.ts
 * compiledServedFile): served(...) reads it whole, and the reader reads the login it makes.
 */
const servedOf = {
	PlainLogin: served<typeof PlainLogin>(compiledServedFile(PlainLogin), "plain"),
	WebLogin: served<typeof WebLogin>(compiledServedFile(WebLogin), "web")
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

/** A verify as a config states it: none, one failing with TokenRefused, or one failing with another error. */
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
	"verify fails only with TokenRefused": (c: ChannelCase) => c.verify !== "otherFailure",
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

const pool = { max: 1 } as const

/** A verify that refuses every token. */
const verifyToken: Verify = (token) => Effect.fail(new TokenRefused({ cause: token }))

/** What a verify failing with another error than TokenRefused fails with. */
class Unverified extends Data.TaggedError("Unverified")<{ readonly token: string }> {}

/** A valid config of the login: every setting, and verify where the login's role reads a context. */
const validConfig = (login: LoginName): LoginConfig => {
	const connection = {
		driver: pgDriver,
		transport,
		database: "work",
		password: Redacted.make("secret"),
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
							c.verify === "token" ? new TokenRefused({ cause: token }) : new Unverified({ token })
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
		...nested("pool", [["max", "1"]]),
		...line("top", "login", `\tlogin: ${login}Served,`),
		...(login === "WebLogin" ? line("top", "verify", "\tverify: verifyToken,") : []),
		...(extra === "top" ? [{ text: "\textra: 1,", block: "top" as const, key: "extra" }] : [])
	]
}

/**
 * A config left out one setting, or given a stranger key, as one DbLayer.make call on one line, under its directive
 * where the reader refuses it: the contract is that the call does not compile, wherever the checker reports it.
 */
const callOf = (
	name: string,
	login: LoginName,
	omit: { readonly block: Block; readonly key: string } | undefined,
	extra: Block | undefined,
	admitted: boolean
): Stated => {
	const settings = Arr.join(
		Arr.map(settingLines(login, omit, extra), (l) => Str.trim(l.text)),
		" "
	)
	const line = `export const ${name} = DbLayer.make({ ${settings} })`
	if (admitted) {
		return { lines: [line] }
	}
	return {
		lines: [
			extra === undefined
				? "// @ts-expect-error -- refused: a setting the reader requires is left out"
				: "// @ts-expect-error -- refused: a key no setting of its block names",
			line
		]
	}
}

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
						`// @ts-expect-error -- refused: ${Arr.isReadonlyArrayNonEmpty(broken) ? broken[0][0] : "the reader refuses the config"}`
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

/** A cell of the box. */
type ConfigCell =
	| Readonly<{ kind: "keys"; block: Block }>
	| Readonly<{ kind: "omission"; login: LoginName; block: Block; key: string; at: number }>
	| Readonly<{ kind: "stranger"; login: LoginName; block: Block }>
	| Readonly<{ kind: "channel"; channel: ChannelCase }>
	| Readonly<{ kind: "relabelled"; given: LoginName; target: LoginName }>

/** The cells of configBox, minted as a dictionary in its door (test/types/api/config.dictionary.ts). */
export const configBoxItems: Arr.NonEmptyReadonlyArray<ConfigCell> = [
	...Arr.map(blocks, (block): ConfigCell => ({ kind: "keys", block })),
	...Arr.flatMap(loginNames, (login) =>
		Arr.flatMap(blocks, (block) =>
			Arr.map(rosterOf[block], (key, at): ConfigCell => ({
				kind: "omission",
				login,
				block,
				key,
				at
			}))
		)
	),
	...Arr.flatMap(loginNames, (login) =>
		Arr.map(blocks, (block): ConfigCell => ({ kind: "stranger", login, block }))
	),
	...Arr.map(channelCases, (channel): ConfigCell => ({ kind: "channel", channel })),
	...Arr.flatMap(loginNames, (given) =>
		Arr.map(loginNames, (target): ConfigCell => ({ kind: "relabelled", given, target }))
	)
]

/** A cell's statement, under its directive where the reader refuses it. */
const cellOf = (cell: ConfigCell, index: number): Stated => {
	switch (cell.kind) {
		case "keys":
			return {
				lines: [
					`export type k_${cell.block} = Expect<Equals<keyof ${
						{ top: "DbConfigShape<typeof PlainLogin>", transport: "Transport", pool: "PoolBounds" }[
							cell.block
						]
					}, ${union(rosterOf[cell.block])}>>`
				]
			}
		case "omission":
			return callOf(
				`o_${cell.login}_${cell.block}_${cell.at}`,
				cell.login,
				{ block: cell.block, key: cell.key },
				undefined,
				readerAdmits(omitted(cell.login, cell.block, cell.key))
			)
		case "stranger": {
			if (readerAdmits(stranger(cell.login, cell.block))) {
				throw new Error(`the reader admits a key no roster of ${cell.block} names`)
			}
			return callOf(`s_${cell.login}_${cell.block}`, cell.login, undefined, cell.block, false)
		}
		case "channel":
			return channelOf(cell.channel, index)
		case "relabelled":
			return {
				lines: [
					...(cell.given === cell.target
						? []
						: ["// @ts-expect-error -- refused: a config is of the login it names"]),
					`export type r_${cell.given}_${cell.target} = Expect<Takes<typeof ${cell.target}, typeof v_${cell.given}>>`
				]
			}
	}
}

/** The DbConfig program's prelude (test/support/programs/dbconfig.ts), every repository name it reads. */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/dbconfig.ts"))

/** The driver and the socket module, read as a caller does, the served logins, the channels and the valid configs. */
const configHeader: ReadonlyArray<string> = [
	'import net from "node:net"',
	'import pgDriver, { type Client, type ClientConfig } from "pg"',
	"",
	"export type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
	"export type Expect<T extends true> = T",
	"/** Whether DbLayer.make takes the config C for the login L: whether C is assignable to its parameter. */",
	"export type Takes<L, C> = [C] extends [DbConfigShape<L>] ? true : false",
	"export declare const file: unknown",
	'export const PlainLoginServed = served<typeof PlainLogin>(file, "plain")',
	'export const WebLoginServed = served<typeof WebLogin>(file, "web")',
	"export declare const verifyToken: Verify",
	"export declare const verifyFailing: (token: string) => Effect.Effect<unknown, Error>",
	"export declare const credentialPassword: Effect.Effect<Redacted.Redacted, CredentialError>",
	"export declare const failingPassword: Effect.Effect<Redacted.Redacted, Error>",
	'export declare const servicedPassword: Effect.Effect<Redacted.Redacted, CredentialError, "Vault">',
	'export declare const unpipelined: Omit<typeof pgDriver, "Client"> & { readonly Client: new (config: ClientConfig) => Omit<Client, "pipeline"> }',
	'export const base = { driver: pgDriver, transport: { kind: "sslRequest", host: "localhost", port: 5433, open: () => new net.Socket(), ca: "PEM", servername: "localhost" }, database: "work", pool: { max: 1 } } as const',
	"export const v_PlainLogin = { ...base, login: PlainLoginServed, password: credentialPassword } as const",
	"export const v_WebLogin = { ...base, login: WebLoginServed, password: credentialPassword, verify: verifyToken } as const",
	""
]

/** The program over a batch's cells, each a statement of its own. */
export const configProgram = (
	cells: Arr.NonEmptyReadonlyArray<ConfigCell>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/support/agreement/dbconfig.ts: the DbConfig type/reader agreement.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: configHeader },
			...Arr.map(cells, (cell, at) => ({
				owner: caseOwned(at),
				lines: [...cellOf(cell, at).lines, ""]
			}))
		]
	)
]
