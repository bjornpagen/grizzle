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
import { makeSubscriptions } from "#adapter/live/subscriptions.ts"
import { loginEnvironment, readServedLogin } from "#adapter/pool/served.ts"
import type { LoginBase, LiveSourceConfigShape, LiveSourceService } from "#adapter/types/layer.ts"
import type { LoginConnection } from "#adapter/wire/session.ts"
import type { AnyLogin } from "#compiler/plan/common.ts"
import type { ServedLive, ServedSession } from "#compiler/plan/serve.ts"

/**
 * LiveSource.layer: an installation's live source for the process, one per installation, which every DbLayer of a
 * login of it that serves a read requires (types/layer.ts LiveOf). Its config is the connection of the installation's
 * decoder login, its `password` that login's credential, and a served login of the installation that serves a read,
 * whose file carries the installation's live source. It is parsed once, where it is given; one no connection can use,
 * or a login that serves no read, fails the layer at stage config.
 *
 * Building the layer connects nothing: it builds the registry (live/subscriptions.ts) over the installation's fan-out
 * (live/listen.ts), whose listening session and candidacy for the installation's leader, both the decoder login's,
 * start at the first watch of any layer it serves and end with its scope.
 *
 * A LiveSource config parsed: its connection, and its installation's base, live source and sessions' texts.
 */
interface ParsedLive extends ParsedConnection {
	readonly base: string
	readonly source: Extract<ServedLive, { readonly kind: "source" }>
	readonly session: ServedSession
}

/** The block a LiveSource config's settings sit in, as a refusal names their paths. */
const liveConfig: SettingPath = ["LiveSource"]

const refusedConfig = (fault: SettingFault): OpenError =>
	new OpenError({ reason: new DbConfigRefused(fault) })

const loginRefused: SettingFault = faultAt(liveConfig, "login", { kind: "liveLogin" })

/**
 * The config's served login, read once at the boundary as DbLayer.make's is (pool/served.ts readServedLogin): a
 * served login whose file carries a live source, its base and its texts read off its file.
 */
const liveLogin = <L extends AnyLogin>(
	config: LiveSourceConfigShape<L>
): Result.Result<Pick<ParsedLive, "base" | "source" | "session">, SettingFault> =>
	readHost(loginRefused, () =>
		Result.flatMap(readServedLogin(config.login, loginRefused), (read) => {
			const source = read.file.live
			return source.kind === "source"
				? Result.succeed({ base: read.base, source, session: read.file.session })
				: Result.fail(loginRefused)
		})
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
 * The live source in the layer's scope: the decoder login's connection, its role and its slot the live source's stem
 * under the config's role space; the fan-out's source over it, with the candidacy each process runs; and the registry
 * over the source.
 */
const makeLiveSource = (
	parsed: ParsedLive
): Effect.Effect<LiveSourceSessions, OpenError, Scope.Scope> =>
	Effect.gen(function* () {
		const decoder = yield* Effect.fromResult(
			Result.mapError(connectionRole(parsed, liveConfig, parsed.source.stem), refusedConfig)
		)
		const connection: LoginConnection = {
			driver: parsed.driver,
			transport: parsed.transport,
			database: parsed.database,
			role: decoder,
			password: parsed.password,
			connectTimeoutMs: parsed.connectTimeoutMs
		}
		const source = yield* fanoutSource({
			connection,
			session: parsed.session,
			source: parsed.source,
			candidacy: {
				decoder: connection,
				session: parsed.session,
				source: parsed.source,
				slot: decoder,
				tables: new Map(Rec.toEntries(parsed.source.tables))
			}
		})
		const subscriptions = yield* makeSubscriptions(source)
		return { subscriptions }
	})

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
