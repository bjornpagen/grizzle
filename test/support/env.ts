import { homedir } from "node:os"
import { Array as Arr, Config, ConfigProvider, Effect, String as Str } from "effect"
import { fileText, repoRoot } from "#test/support/files.ts"

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
 * The assignments of pin.env the tests read, parsed once: a pin without one, or with a port that is no port, fails
 * the load.
 */
const pinFile = Config.all({
	PG_PIN_VERSION: Config.String("PG_PIN_VERSION"),
	PGVECTOR_PIN_VERSION: Config.String("PGVECTOR_PIN_VERSION"),
	GRIZZLE_PG_PREFIX: Config.String("GRIZZLE_PG_PREFIX"),
	PG_PORT: Config.Port("PG_PORT"),
	GRIZZLE_PG_STATE: Config.String("GRIZZLE_PG_STATE"),
	PG_COVERAGE_PORT: Config.Port("PG_COVERAGE_PORT"),
	GRIZZLE_PG_COVERAGE_STATE: Config.String("GRIZZLE_PG_COVERAGE_STATE"),
	PG_DEV_ROLE: Config.String("PG_DEV_ROLE"),
	PG_TEMPLATE_DB: Config.String("PG_TEMPLATE_DB")
})

const pin = await Effect.runPromise(
	Effect.flatMap(fileText(`${repoRoot}scripts/pg/pin.env`), (text) =>
		Effect.orDie(pinFile.parse(ConfigProvider.fromEnvRecord(assignments(text))))
	)
)

/**
 * The cluster a run's database tests use, from GRIZZLE_PG_CLUSTER: `main`, the default, or `coverage`, the cluster
 * that preloads plpgsql_check. Any other value is refused when the module loads.
 */
export type PgCluster = "main" | "coverage"

const cluster: PgCluster = Effect.runSync(
	Config.withDefault(Config.Literals(["main", "coverage"], "GRIZZLE_PG_CLUSTER"), "main")
)

/** Where a cluster lives: its port and its state directory, which holds tls/, socket/ and the owner's password. */
const clusterPlace = (which: PgCluster): { readonly port: number; readonly state: string } => {
	switch (which) {
		case "main":
			return { port: pin.PG_PORT, state: pin.GRIZZLE_PG_STATE }
		case "coverage":
			return { port: pin.PG_COVERAGE_PORT, state: pin.GRIZZLE_PG_COVERAGE_STATE }
	}
}

const place = clusterPlace(cluster)

/**
 * The repository's PostgreSQL pin (scripts/pg/pin.env) and the cluster GRIZZLE_PG_CLUSTER selects: configuration from a
 * repository file and the environment, which any module reads, with no cluster present. What exists only once
 * `pnpm pg:init` has initialised the cluster, its owner's password and its CA certificates, is the InitializedCluster
 * service's (test/support/cluster.ts).
 */
export const pgPin = {
	version: pin.PG_PIN_VERSION,
	vectorVersion: pin.PGVECTOR_PIN_VERSION,
	prefix: pin.GRIZZLE_PG_PREFIX,
	host: "localhost",
	cluster,
	state: place.state,
	port: place.port,
	devRole: pin.PG_DEV_ROLE,
	templateDatabase: pin.PG_TEMPLATE_DB
} as const

/** The bootstrap superuser's URL to `database` over the coverage cluster's socket, which reads plpgsql_check's profiles. */
export const coverageAdminUrl = (database: string): string =>
	`postgresql://postgres@localhost:${pgPin.port}/${encodeURIComponent(database)}?host=${encodeURIComponent(`${pgPin.state}/socket`)}`
