import { NodeFileSystem } from "@effect/platform-node"
import { Context, Data, Effect, FileSystem, Layer, Redacted, String as Str } from "effect"
import { type PgCluster, pgPin } from "#test/support/env.ts"

/** The command that initialises each cluster (scripts/pg/init.sh). */
const initCommand: { readonly [C in PgCluster]: string } = {
	main: "pnpm pg:init",
	coverage: "pnpm pg:init --coverage"
}

/**
 * A file scripts/pg/init.sh writes into the cluster's state directory cannot be read: the cluster is not initialised.
 */
class ClusterNotInitialized extends Data.TaggedError("ClusterNotInitialized")<{
	readonly file: string
	readonly cause: unknown
}> {
	override get message(): string {
		return `the ${pgPin.cluster} PostgreSQL ${pgPin.version} cluster is not initialised: ${this.file} cannot be read; run ${initCommand[pgPin.cluster]}`
	}
}

/**
 * What exists of the local cluster only once scripts/pg/init.sh has initialised it, read from its state directory: the
 * owner role's password, and the certificates of the local CA, which signed the server's, and of a CA that did not.
 */
export interface InitializedClusterShape {
	/** The password init.sh gave the owner role, grizzle_dev, the migration identity. */
	readonly devPassword: Redacted.Redacted
	/** The local CA's PEM file, for a client that reads one: psql, and a connection URL's sslrootcert. */
	readonly caFile: string
	/** The local CA's PEM text, which every verify-full connection chains the server's certificate to. */
	readonly caPem: string
	/** The PEM text of a CA that signed nothing the server presents, for the refusal checks. */
	readonly wrongCaPem: string
}

/** The one read of the cluster's files: each once, or ClusterNotInitialized for the first that cannot be read. */
export const readCluster: Effect.Effect<
	InitializedClusterShape,
	ClusterNotInitialized,
	FileSystem.FileSystem
> = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const read = (file: string): Effect.Effect<string, ClusterNotInitialized> =>
		Effect.mapError(fs.readFileString(file), (cause) => new ClusterNotInitialized({ file, cause }))
	const tls = `${pgPin.state}/tls`
	const caFile = `${tls}/ca.crt`
	const [devPassword, caPem, wrongCaPem] = yield* Effect.all([
		read(`${pgPin.state}/${pgPin.devRole}.password`),
		read(caFile),
		read(`${tls}/wrong-ca.crt`)
	])
	return { devPassword: Redacted.make(Str.trim(devPassword)), caFile, caPem, wrongCaPem }
})

/**
 * The initialised cluster, parsed once from its state directory when the layer is built. Nothing reads the cluster when
 * a module loads: code that reaches the cluster's facts needs this service, or the substrate built from it
 * (substrate/substrate.ts), so a test that provides neither cannot reach them, and an uninitialised cluster is the
 * typed ClusterNotInitialized of the layer's build. The database tier provides it: Substrate's layers build it, and
 * so do the network run's global setup and teardown (pg-global-setup.ts), a bench's sweep, and a CLI child's
 * configuration (cli/config.child.ts).
 */
export class InitializedCluster extends Context.Service<
	InitializedCluster,
	InitializedClusterShape
>()("grizzle-workspace/test/support/cluster/InitializedCluster") {
	static readonly layer = Layer.effect(InitializedCluster, readCluster).pipe(
		Layer.provide(NodeFileSystem.layer)
	)
}
