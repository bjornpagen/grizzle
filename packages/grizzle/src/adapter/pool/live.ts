import { Effect, Layer, Record as Rec, Result, type Scope } from "effect"
import {
	connectionRole,
	faultAt,
	liveSourceSettings,
	type ParsedConnection,
	parseConnection,
	type SettingPath
} from "#adapter/connection/config.ts"
import { readHost } from "#adapter/engine.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import { DbConfigRefused, type SettingFault } from "#adapter/errors/failures.ts"
import { liveSourceKey, type LiveSourceSessions } from "#adapter/live/layer.ts"
import { fanoutSource } from "#adapter/live/listen.ts"
import { makeSubscriptions, unsourced } from "#adapter/live/subscriptions.ts"
import { loginEnvironment, readServedLogin } from "#adapter/pool/served.ts"
import type { LoginBase, LiveSourceConfigShape, LiveSourceService } from "#adapter/types/layer.ts"
import type { LoginConnection } from "#adapter/wire/session.ts"
import type { AnyLogin } from "#compiler/plan/common.ts"
import type { ServedLive, ServedSession } from "#compiler/plan/serve.ts"

/**
 * LiveSource.layer: an installation's live source for the process, one per installation, which every DbLayer of a
 * login of it that serves a read requires (types/layer.ts LiveOf). Its config is the connection of the installation's
 * decoder login, its `password` that login's credential, and a served login of the installation, whose file carries the
 * installation's live source where the login serves a read. It is parsed once, where it is given; one no connection can
 * use fails the layer at stage config. Over a login that serves no read it holds no source: no layer that needs one
 * needs it, so a program may provide it wherever it provides a layer, and a read registered on it ends `failed`.
 *
 * Building the layer connects nothing: it builds the registry (live/subscriptions.ts) over the installation's fan-out
 * (live/listen.ts), whose listening session and candidacy for the installation's leader, both the decoder login's,
 * start at the first watch of any layer it serves and end with its scope.
 *
 * A LiveSource config parsed: its connection, and its installation's base, live source and sessions' texts.
 */
interface ParsedLive extends ParsedConnection {
	readonly base: string
	readonly source: ServedLive
	readonly session: ServedSession
}

/** The block a LiveSource config's settings sit in, as a refusal names their paths. */
const liveConfig: SettingPath = ["LiveSource"]

const refusedConfig = (fault: SettingFault): OpenError =>
	new OpenError({ reason: new DbConfigRefused(fault) })

const loginRefused: SettingFault = faultAt(liveConfig, "login", { kind: "servedLogin" })

/**
 * The config's served login, read once at the boundary as DbLayer.make's is (pool/served.ts readServedLogin): its
 * base, its file's live source and its sessions' texts.
 */
const liveLogin = <L extends AnyLogin>(
	config: LiveSourceConfigShape<L>
): Result.Result<Pick<ParsedLive, "base" | "source" | "session">, SettingFault> =>
	readHost(loginRefused, () =>
		Result.map(readServedLogin(config.login, loginRefused), (read) => ({
			base: read.base,
			source: read.file.live,
			session: read.file.session
		}))
	)

/** A LiveSource config, parsed once (connection/config.ts); a refusal is OpenError{stage: "config"}. */
const parseLiveConfig = <L extends AnyLogin>(
	config: LiveSourceConfigShape<L>
): Result.Result<ParsedLive, OpenError> =>
	Result.mapError(
		Result.flatMap(parseConnection(config, liveConfig, liveSourceSettings), (parsed) =>
			Result.map(liveLogin(config), (login) => ({ ...parsed, ...login }))
		),
		refusedConfig
	)

/**
 * The live source in the layer's scope: over a login that serves a read, the decoder login's connection, its role and
 * its slot the live source's stem under the config's role space, the fan-out's source over it with the candidacy each
 * process runs, and the registry over the source; over a login that serves none, the registry that holds no source
 * (live/subscriptions.ts unsourced), which connects nothing and never reads the credential, so a generic program may
 * provide it where no layer needs it.
 */
const makeLiveSource = (
	parsed: ParsedLive
): Effect.Effect<LiveSourceSessions, OpenError, Scope.Scope> => {
	const source = parsed.source
	switch (source.kind) {
		case "none":
			return Effect.succeed({ subscriptions: unsourced })
		case "source":
			return Effect.gen(function* () {
				const decoder = yield* Effect.fromResult(
					Result.mapError(connectionRole(parsed, liveConfig, source.stem), refusedConfig)
				)
				const connection: LoginConnection = {
					driver: parsed.driver,
					transport: parsed.transport,
					database: parsed.database,
					role: decoder,
					password: parsed.password,
					connectTimeoutMs: parsed.connectTimeoutMs
				}
				const fanout = yield* fanoutSource({
					connection,
					session: parsed.session,
					source,
					candidacy: {
						decoder: connection,
						session: parsed.session,
						source,
						slot: decoder,
						tables: new Map(Rec.toEntries(source.tables)),
						views: new Set(source.views)
					}
				})
				const subscriptions = yield* makeSubscriptions(fanout)
				return { subscriptions }
			})
	}
}

/**
 * The LiveSource layer of a config (see the header): the config parsed once, where LiveSource.layer is given it; then,
 * each time the layer is built, its refusal, the process environment its sessions would start in, then the source
 * built in the layer's scope, under its installation's base's key.
 */
export const liveSourceLayer = <const L extends AnyLogin>(
	config: LiveSourceConfigShape<L>
): Layer.Layer<LiveSourceService<LoginBase<L>>, OpenError> => {
	const read = parseLiveConfig(config)
	return Layer.unwrap(
		Effect.gen(function* () {
			const parsed = yield* Effect.fromResult(read)
			yield* loginEnvironment
			return Layer.effect(
				liveSourceKey<LiveSourceService<LoginBase<L>>>(parsed.base),
				makeLiveSource(parsed)
			)
		})
	)
}
