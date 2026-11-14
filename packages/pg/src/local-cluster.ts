import { homedir } from "node:os"
import { NodeFileSystem } from "@effect/platform-node"
import {
	Array as Arr,
	Config,
	ConfigProvider,
	Data,
	Effect,
	FileSystem,
	Option,
	String as Str
} from "effect"

import { regex } from "arkregex"
/** A `$NAME` reference to an earlier value of pin.env. */
const reference = regex("^\\$[A-Z0-9_]+$")

/** `raw` with each `$NAME` replaced by the value `values` gives NAME, or by nothing. */
const expanded = (raw: string, values: Readonly<Record<string, string>>): string =>
	Arr.join(
		Arr.map(Str.split(raw, regex("(\\$[A-Z0-9_]+)")), (part) =>
			reference.test(part) ? (values[Str.slice(1)(part)] ?? "") : part
		),
		""
	)

/** pin.env's assignments, each `$NAME` expanded as the shell sources the file, HOME the user's home directory. */
const assignments = (text: string): Readonly<Record<string, string>> => {
	const values: Record<string, string> = { HOME: homedir() }
	for (const line of Str.split(text, "\n")) {
		const match = regex("^([A-Z0-9_]+)=(.*)$").exec(Str.trim(line))
		if (match === null) {
			continue
		}
		const [, key, raw] = match
		values[key] = expanded(raw, values)
	}
	return values
}

/**
 * The assignments of pin.env the scripts and tests read, parsed once: a pin without one, or with a default cluster
 * that is no port, fails the load.
 */
const pinFile = Config.all({
	PG_PIN_VERSION: Config.String("PG_PIN_VERSION"),
	PGVECTOR_PIN_VERSION: Config.String("PGVECTOR_PIN_VERSION"),
	GRIZZLE_PG_PREFIX: Config.String("GRIZZLE_PG_PREFIX"),
	GRIZZLE_PG_DEFAULT_CLUSTER: Config.Port("GRIZZLE_PG_DEFAULT_CLUSTER"),
	GRIZZLE_PG_DEFAULT_STATE: Config.String("GRIZZLE_PG_DEFAULT_STATE"),
	PG_DEV_ROLE: Config.String("PG_DEV_ROLE"),
	PG_TEMPLATE_DB: Config.String("PG_TEMPLATE_DB")
})

/** scripts/pg/pin.env's assignments (pinFile), read once from the checkout this package lies in. */
export const pin = await Effect.runPromise(
	Effect.flatMap(
		Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
			fs.readFileString(`${import.meta.dirname}/../../../scripts/pg/pin.env`)
		),
		(text) => pinFile.parse(ConfigProvider.fromEnvRecord(assignments(text)))
	).pipe(Effect.orDie, Effect.provide(NodeFileSystem.layer))
)

/**
 * The environment variable that names the local cluster every script and test reaches: scripts/pg/lib.sh reads it
 * through packages/pg/src/cluster.ts, the tests and benchmarks through this module, and every child either starts inherits
 * it.
 */
export const clusterVariable = "GRIZZLE_PG_CLUSTER"

/**
 * The name GRIZZLE_PG_CLUSTER holds, when it holds one: the port Config.Port reads from it, and the text it reads it
 * from. A name that is no port, the empty one among them, fails.
 */
const clusterName = Config.option(
	Config.all({ port: Config.Port(clusterVariable), text: Config.String(clusterVariable) })
)

/**
 * GRIZZLE_PG_CLUSTER holds no cluster's name: no port, or a port spelled otherwise than in canonical decimal (a sign, a
 * leading zero, a fraction, an exponent), so one cluster has one name, the port it listens on.
 */
class ClusterUnnamed extends Data.TaggedError("ClusterUnnamed")<{ readonly reason: string }> {
	override get message(): string {
		return `${clusterVariable} names no local cluster: ${this.reason}`
	}
}

/**
 * A local cluster of the pinned build: its name, which is the port it listens on, and the state directory
 * scripts/pg/init.sh fills, which holds everything else of it.
 */
export interface LocalCluster {
	readonly port: number
	/** The directory init.sh creates and `pnpm pg destroy` removes, which holds the rest. */
	readonly state: string
	readonly data: string
	/** The local CA, the server's certificate it signed, and an unrelated CA for the refusal checks. */
	readonly tls: string
	readonly log: string
	/** The directory of the cluster's Unix socket, where the bootstrap superuser connects by peer authentication. */
	readonly socket: string
	/** The password init.sh gives the owner role. */
	readonly passwordFile: string
}

/**
 * The cluster named `port`. The default cluster (pin.env's GRIZZLE_PG_DEFAULT_CLUSTER) keeps the state directory
 * pin.env names; every other's sits beside it, that directory's name suffixed with `-<port>`, so no two clusters share
 * a directory and none's lies inside another's, which init.sh --force and destroy remove whole.
 */
const clusterNamed = (port: number): LocalCluster => {
	const state =
		port === pin.GRIZZLE_PG_DEFAULT_CLUSTER
			? pin.GRIZZLE_PG_DEFAULT_STATE
			: `${pin.GRIZZLE_PG_DEFAULT_STATE}-${port}`
	return {
		port,
		state,
		data: `${state}/data`,
		tls: `${state}/tls`,
		log: `${state}/log`,
		socket: `${state}/socket`,
		passwordFile: `${state}/${pin.PG_DEV_ROLE}.password`
	}
}

/**
 * The local cluster an environment selects: the one its GRIZZLE_PG_CLUSTER names, or the default when it has none. An
 * empty or malformed name fails, and never falls back to the default: a run whose name went missing reaches no cluster
 * rather than the shared one.
 */
export const selectCluster = (
	env: Readonly<Record<string, string | undefined>>
): Effect.Effect<LocalCluster, ClusterUnnamed> =>
	Effect.flatMap(
		Effect.mapError(
			clusterName.parse(ConfigProvider.fromEnvRecord(env, { preserveEmptyStrings: true })),
			(error) => new ClusterUnnamed({ reason: error.message })
		),
		Option.match({
			onNone: () => Effect.succeed(clusterNamed(pin.GRIZZLE_PG_DEFAULT_CLUSTER)),
			onSome: ({ port, text }) =>
				`${port}` === text
					? Effect.succeed(clusterNamed(port))
					: Effect.fail(
							new ClusterUnnamed({ reason: `"${text}" spells port ${port} otherwise than ${port}` })
						)
		})
	)

/**
 * The local cluster this process reaches, selected once from its environment (selectCluster): a name that is no
 * cluster fails the load.
 */
export const localCluster: LocalCluster = await Effect.runPromise(
	Effect.orDie(selectCluster(process.env))
)
