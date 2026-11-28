import net from "node:net"
import {
	Array as Arr,
	Data,
	Effect,
	Option,
	Record as Rec,
	Redacted,
	Result,
	String as Str
} from "effect"
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
import type { DbConfigShape, Transport, Verify } from "#adapter/types/layer.ts"
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
 * - The keys of each block's type, the top level, each kind of transport and the pool, are exactly the reader's roster
 *   of its settings (connectionSettings and servedLoginSettings' settings, transportSettings by kind, poolSettings).
 * - Each setting of each roster left out of an otherwise valid config over either transport, for a login whose role
 *   reads no context and one whose role reads Session: the types refuse it exactly where the reader does; and a key no
 *   roster names, in each block, both refuse, as both refuse each setting of the other transport's kind in a transport
 *   (a CA beside a Unix socket, a directory beside a network host). Each call stands on one line, so its refusal is the
 *   line's, wherever the checker reports it.
 * - The channels the reader cannot see, each a type-only contract stated with its reason (typeOnly): a password is a
 *   Redacted or an Effect yielding one that fails only with CredentialError and needs no service; verify fails only
 *   with TokenRefused; and the driver's Client has pipeline mode, which every flight's one round trip needs. Over every
 *   combination of a transport, a password or none, a verify and a driver, the reader admits each config but one
 *   missing the verify a login reading a context needs, a network transport's without a password, and a Unix socket's
 *   with one, and the types admit exactly what the reader admits and every contract holds. Each is stated as whether
 *   DbLayer.make's parameter takes the config's type (Takes): a call would raise the Effect language service's
 *   restatement of the checker's refusal beside it.
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

/** The blocks a DbConfig nests, and each one's roster as the reader reads it, a transport's by its kind. */
type Block = "top" | "transport" | "pool"

/** The kinds of transport, each a roster of its own (transportSettings). */
type Kind = Transport["kind"]

const kinds: Arr.NonEmptyReadonlyArray<Kind> = ["sslRequest", "unixSocket"]

const rosterOf = (block: Block, kind: Kind): Arr.NonEmptyReadonlyArray<string> => {
	switch (block) {
		case "top":
			return [...connectionSettings, ...servedLoginSettings.settings]
		case "transport":
			return transportSettings[kind]
		case "pool":
			return poolSettings
	}
}

const blocks: Arr.NonEmptyReadonlyArray<Block> = ["top", "transport", "pool"]

/** The other kind of transport than `kind`. */
const otherKind = (kind: Kind): Kind => (kind === "sslRequest" ? "unixSocket" : "sslRequest")

/** The settings of the other kind's transport that `kind`'s holds none of. */
const foreignSettings = (kind: Kind): ReadonlyArray<string> =>
	Arr.filter(
		transportSettings[otherKind(kind)],
		(key) => !Arr.contains(transportSettings[kind], key)
	)

/**
 * A password as a config states it: a Redacted, an Effect of one by its error and service channels, plain text, which
 * neither admits, or none.
 */
type Password = "redacted" | "credential" | "otherFailure" | "service" | "text" | "none"
const passwords: Arr.NonEmptyReadonlyArray<Password> = [
	"redacted",
	"credential",
	"otherFailure",
	"service",
	"text",
	"none"
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
	readonly kind: Kind
	readonly password: Password
	readonly verify: VerifyKind
	readonly driver: Driver
}

/** A valid transport of each kind, and the program's text of each of its settings, in its roster's order. */
const transportOf = {
	sslRequest: {
		value: {
			kind: "sslRequest",
			host: "localhost",
			port: 5433,
			open: () => new net.Socket(),
			ca: "PEM",
			servername: "localhost"
		},
		text: [
			["kind", '"sslRequest"'],
			["host", '"localhost"'],
			["port", "5433"],
			["open", "() => new net.Socket()"],
			["ca", '"PEM"'],
			["servername", '"localhost"']
		]
	},
	unixSocket: {
		value: { kind: "unixSocket", directory: "/run/postgresql", port: 5432 },
		text: [
			["kind", '"unixSocket"'],
			["directory", '"/run/postgresql"'],
			["port", "5432"]
		]
	}
} as const satisfies {
	readonly [K in Kind]: {
		readonly value: Extract<Transport, { readonly kind: K }>
		readonly text: ReadonlyArray<readonly [string, string]>
	}
}

/** The program's text of the other kind's setting `key`, stated beside a transport of `kind`. */
const foreignText = (kind: Kind, key: string): string => {
	const texts: ReadonlyArray<readonly [string, string]> = transportOf[otherKind(kind)].text
	const found = Arr.findFirst(texts, ([k]) => k === key)
	if (Option.isNone(found)) {
		throw new Error(`${key} is no setting of the other transport`)
	}
	return found.value[1]
}

const pool = { max: 1 } as const

/** A verify that refuses every token. */
const verifyToken: Verify = (token) => Effect.fail(new TokenRefused({ cause: token }))

/** What a verify failing with another error than TokenRefused fails with. */
class Unverified extends Data.TaggedError("Unverified")<{ readonly token: string }> {}

/**
 * A valid config of the login over a transport of `kind`: every setting, a password over the network and none over a
 * Unix socket, and verify where the login's role reads a context.
 */
const validConfig = (login: LoginName, kind: Kind): LoginConfig => {
	const connection =
		kind === "sslRequest"
			? {
					driver: pgDriver,
					transport: transportOf.sslRequest.value,
					database: "work",
					password: Redacted.make("secret"),
					pool
				}
			: { driver: pgDriver, transport: transportOf.unixSocket.value, database: "work", pool }
	return login === "PlainLogin"
		? { login, config: { ...connection, login: servedOf.PlainLogin } }
		: { login, config: { ...connection, login: servedOf.WebLogin, verify: verifyToken } }
}

/** The config over `kind` with `key` of `block` left out, the rest as valid. */
const omitted = (login: LoginName, kind: Kind, block: Block, key: string): LoginConfig =>
	edited(validConfig(login, kind), (config) => {
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

/** The config over `kind` with the key `key`, which `block`'s roster does not name, in `block`. */
const stranger = (login: LoginName, kind: Kind, block: Block, key: string): LoginConfig => {
	const extra: Readonly<Record<string, unknown>> = { [key]: 1 }
	return edited(validConfig(login, kind), (config) => {
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
	const password: Readonly<Record<string, unknown>> =
		c.password === "none"
			? {}
			: {
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
	return edited(validConfig(c.login, c.kind), (config) => {
		const copy = Object.assign({ ...config }, password, c.driver === "pg" ? {} : driver)
		if (c.password === "none") {
			Reflect.deleteProperty(copy, "password")
		}
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

/** A key a config's block holds beside its roster's: the block, the key and its value's text. */
interface Extra {
	readonly block: Block
	readonly key: string
	readonly value: string
}

/** The setting lines of a valid config of the login over `kind`, in the program, each with the block it is of. */
const settingLines = (
	login: LoginName,
	kind: Kind,
	omit: { readonly block: Block; readonly key: string } | undefined,
	extra: Extra | undefined
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
					...(extra?.block === block
						? [{ text: `\t\t${extra.key}: ${extra.value},`, block, key: extra.key }]
						: []),
					{ text: "\t},", block: "top" as const, key: `${block}.end` }
				]
			: [])
	]
	return [
		...line("top", "driver", "\tdriver: pgDriver,"),
		...nested("transport", transportOf[kind].text),
		...line("top", "database", '\tdatabase: "work",'),
		...(kind === "sslRequest"
			? line("top", "password", '\tpassword: Redacted.make("secret"),')
			: []),
		...nested("pool", [["max", "1"]]),
		...line("top", "login", `\tlogin: ${login}Served,`),
		...(login === "WebLogin" ? line("top", "verify", "\tverify: verifyToken,") : []),
		...(extra?.block === "top"
			? [{ text: `\t${extra.key}: ${extra.value},`, block: "top" as const, key: extra.key }]
			: [])
	]
}

/**
 * A config left out one setting, or given a stranger key, as one DbLayer.make call on one line, under its directive
 * where the reader refuses it: the contract is that the call does not compile, wherever the checker reports it.
 */
const callOf = (
	name: string,
	login: LoginName,
	kind: Kind,
	omit: { readonly block: Block; readonly key: string } | undefined,
	extra: Extra | undefined,
	admitted: boolean
): Stated => {
	const settings = Arr.join(
		Arr.map(settingLines(login, kind, omit, extra), (l) => Str.trim(l.text)),
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
				: "// @ts-expect-error -- refused: a key no setting of its block names, the other transport's among them",
			line
		]
	}
}

/** The program's statement of a channel case: its config's type taken by DbLayer.make's parameter, or refused. */
const channelOf = (c: ChannelCase, i: number): Stated => {
	const admitted = readerAdmits(channelConfig(c))
	const broken = Arr.filter(Rec.toEntries(typeOnly), ([, holds]) => !holds(c))
	const password = {
		redacted: ', password: Redacted.make("secret")',
		credential: ", password: credentialPassword",
		otherFailure: ", password: failingPassword",
		service: ", password: servicedPassword",
		text: ', password: "secret"',
		none: ""
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
			`const k${i} = { ...${c.kind === "sslRequest" ? "base" : "socketBase"}, login: ${c.login}Served${password}${verify}${driver} } as const`,
			...(refused
				? [
						`// @ts-expect-error -- refused: ${Arr.isReadonlyArrayNonEmpty(broken) ? broken[0][0] : "the reader refuses the config"}`
					]
				: []),
			`export type c${i} = Expect<Takes<typeof ${c.login}, typeof k${i}>>`
		]
	}
}

/** Every channel case: each login, transport, password, verify and driver, once. */
const channelCases: ReadonlyArray<ChannelCase> = Arr.flatMap(loginNames, (login) =>
	Arr.flatMap(kinds, (kind) =>
		Arr.flatMap(passwords, (password) =>
			Arr.flatMap(verifies, (verify) =>
				Arr.map(drivers, (driver): ChannelCase => ({ login, kind, password, verify, driver }))
			)
		)
	)
)

/** A cell of the box. */
type ConfigCell =
	| Readonly<{ kind: "keys"; block: Block; transport: Kind }>
	| Readonly<{
			kind: "omission"
			login: LoginName
			transport: Kind
			block: Block
			key: string
			at: number
	  }>
	| Readonly<{ kind: "stranger"; login: LoginName; transport: Kind; block: Block }>
	| Readonly<{ kind: "foreign"; login: LoginName; transport: Kind; key: string }>
	| Readonly<{ kind: "channel"; channel: ChannelCase }>
	| Readonly<{ kind: "relabelled"; given: LoginName; target: LoginName }>

/** The cells of configBox, minted as a dictionary in its door (test/types/api/config.dictionary.ts). */
export const configBoxItems: Arr.NonEmptyReadonlyArray<ConfigCell> = [
	...Arr.flatMap(kinds, (transport) =>
		Arr.map(blocks, (block): ConfigCell => ({ kind: "keys", block, transport }))
	),
	...Arr.flatMap(loginNames, (login) =>
		Arr.flatMap(kinds, (transport) =>
			Arr.flatMap(blocks, (block) =>
				Arr.map(rosterOf(block, transport), (key, at): ConfigCell => ({
					kind: "omission",
					login,
					transport,
					block,
					key,
					at
				}))
			)
		)
	),
	...Arr.flatMap(loginNames, (login) =>
		Arr.flatMap(kinds, (transport) =>
			Arr.map(blocks, (block): ConfigCell => ({ kind: "stranger", login, transport, block }))
		)
	),
	...Arr.flatMap(loginNames, (login) =>
		Arr.flatMap(kinds, (transport) =>
			Arr.map(foreignSettings(transport), (key): ConfigCell => ({
				kind: "foreign",
				login,
				transport,
				key
			}))
		)
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
					`export type k_${cell.transport}_${cell.block} = Expect<Equals<keyof ${
						{
							top: "DbConfigShape<typeof PlainLogin>",
							transport: { sslRequest: "SslRequestTransport", unixSocket: "UnixSocketTransport" }[
								cell.transport
							],
							pool: "PoolBounds"
						}[cell.block]
					}, ${union(rosterOf(cell.block, cell.transport))}>>`
				]
			}
		case "omission":
			return callOf(
				`o_${cell.login}_${cell.transport}_${cell.block}_${cell.at}`,
				cell.login,
				cell.transport,
				{ block: cell.block, key: cell.key },
				undefined,
				readerAdmits(omitted(cell.login, cell.transport, cell.block, cell.key))
			)
		case "stranger": {
			if (readerAdmits(stranger(cell.login, cell.transport, cell.block, "extra"))) {
				throw new Error(`the reader admits a key no roster of ${cell.block} names`)
			}
			return callOf(
				`s_${cell.login}_${cell.transport}_${cell.block}`,
				cell.login,
				cell.transport,
				undefined,
				{ block: cell.block, key: "extra", value: "1" },
				false
			)
		}
		case "foreign": {
			if (readerAdmits(stranger(cell.login, cell.transport, "transport", cell.key))) {
				throw new Error(`the reader admits ${cell.key} beside a transport of ${cell.transport}`)
			}
			return callOf(
				`f_${cell.login}_${cell.transport}_${cell.key}`,
				cell.login,
				cell.transport,
				undefined,
				{ block: "transport", key: cell.key, value: foreignText(cell.transport, cell.key) },
				false
			)
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
	'export const socketBase = { driver: pgDriver, transport: { kind: "unixSocket", directory: "/run/postgresql", port: 5432 }, database: "work", pool: { max: 1 } } as const',
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
