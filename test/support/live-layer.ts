import { Effect, Layer, type Redacted, Ref, Scope } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import { CredentialError } from "#adapter/errors/failures.ts"
import { DbLayer, LiveSource } from "#adapter/public/layer.ts"
import { roleNameOf } from "#adapter/served/served.ts"
import type {
	DbConfigShape,
	DbConnection,
	DbLayerOf,
	LiveOf,
	LiveSourceService,
	LoginBase,
	ServedLogin
} from "#adapter/types/layer.ts"
import type { AnyLogin } from "#compiler/public/schema.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import type { SubstrateShape } from "#test/support/substrate/substrate.ts"

/**
 * The live source every DbLayer of a test or a bench is given (adapter types/layer.ts LiveOf): LiveSource.layer over the
 * layer's own connection (its driver, its transport, its database, its role prefix and its connect timeout) as the
 * installation's decoder login, built beside the login's layer. A login whose served file holds no live source gets
 * the source of no source, which connects nothing and never reads its credential, so every site gives one alike; a
 * site whose layer reads through a tap (test/support/wire-tap.ts) so reads its source's sessions too.
 */

/** A login's DbLayer with its installation's live source given: what it still requires, none for a known login. */
export type SourcedLayer<L> = Layer.Layer<
	DbLayerOf<L>,
	OpenError,
	Exclude<LiveOf<L>, LiveSourceService<LoginBase<L>>>
>

/** An installation's decoder login's credential by its role, issued once for the installation. */
export type DecoderOf = (role: string) => Effect.Effect<Redacted.Redacted, CredentialError>

/** The decoder credential of a file that holds no live source: never asked for, and the defect of asking. */
const noDecoder = (name: string): Effect.Effect<Redacted.Redacted> =>
	Effect.die(new Error(`login ${name}'s installation holds no live source, so no decoder`))

/**
 * DbLayer.make of `config`, given the LiveSource.layer of its login over its own connection as the decoder login,
 * whose credential `decoder` gives, read only when the source first connects, at its process's first watch.
 */
const sourced = <const L extends AnyLogin>(
	config: DbConfigShape<NoInfer<L>> & { readonly login: ServedLogin<L> },
	decoder: DbConnection["password"]
): SourcedLayer<L> => {
	const connection: DbConnection = {
		driver: config.driver,
		transport: config.transport,
		database: config.database,
		password: decoder,
		connectTimeoutMs: config.connectTimeoutMs,
		...(config.rolePrefix === undefined ? {} : { rolePrefix: config.rolePrefix })
	}
	return Layer.provide(
		DbLayer.make(config),
		LiveSource.layer({ ...connection, login: config.login })
	)
}

/**
 * The DbLayer of `config`'s login over `installed`, given its installation's live source, the decoder's credential read
 * off the installation (install-migrate.ts Installed decoder) only when the source first connects, so a login whose
 * served file names no decoder (ServedLogin decoder) never asks for it: what a test serves a login of an installed
 * schema with.
 */
export const sourcedDbLayer = <const L extends AnyLogin>(
	installed: Installed,
	config: DbConfigShape<NoInfer<L>> & { readonly login: ServedLogin<L> }
): SourcedLayer<L> =>
	sourced(
		config,
		config.login.decoder.kind === "none"
			? noDecoder(config.login.name)
			: Effect.sync(() => installed.decoder().password)
	)

/**
 * The decoders of a site that holds the substrate but no Installed: each decoder login's credential issued by the
 * substrate the first time a layer asks for it, in `scope`, the installation's, and held for every later layer, since
 * each issue sets the role a new password and its finalizer drops the role.
 */
export const decodersIn = (
	substrate: SubstrateShape,
	scope: Scope.Scope
): Effect.Effect<DecoderOf> =>
	Effect.map(
		Ref.make<ReadonlyMap<string, Redacted.Redacted>>(new Map()),
		(issued) => (role) =>
			Effect.gen(function* () {
				const held = (yield* Ref.get(issued)).get(role)
				if (held !== undefined) {
					return held
				}
				const credentials = yield* Effect.mapError(
					Scope.provide(substrate.login(role), scope),
					(cause) => new CredentialError({ cause })
				)
				yield* Ref.update(issued, (all) => new Map([...all, [role, credentials.password]]))
				return credentials.password
			})
	)

/**
 * The DbLayer of `config`'s login, given the live source of the installation its served file names: its decoder login,
 * the served login's `decoder`, whose role roleNameOf names under the config's role prefix as an operator names it,
 * its credential `decoderOf`'s, asked for only when the source first connects; a login that serves no read names no
 * decoder, and its source never asks.
 */
export const servedSourcedLayer = <const L extends AnyLogin>(
	decoderOf: DecoderOf,
	config: DbConfigShape<NoInfer<L>> & { readonly login: ServedLogin<L> }
): SourcedLayer<L> => {
	const decoder = config.login.decoder
	return sourced(
		config,
		decoder.kind === "none"
			? noDecoder(config.login.name)
			: Effect.flatMap(
					Effect.sync(() => roleNameOf(decoder, config)),
					decoderOf
				)
	)
}

/**
 * The decoders of a layer built offline, by a unit test that never connects: its live source never asks a decoder's
 * credential, and asking is the defect.
 */
export const offlineDecoders: DecoderOf = () =>
	Effect.die(
		new Error("a layer built offline connects nothing, so its live source asks no decoder")
	)
