import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { regex } from "arkregex"
import {
	Array as Arr,
	Config,
	Context,
	Data,
	Effect,
	FileSystem,
	Layer,
	Option,
	Redacted,
	String as Str
} from "effect"
import { currentWorker, FamilyUnrecorded, memberOf, readFamily } from "#pg/family.ts"
import { type LocalCluster, localCluster } from "#pg/local-cluster.ts"
import { pgPin } from "#test/support/env.ts"

/**
 * A file scripts/pg/init.sh writes into a member's state directory cannot be read: the member is not initialised.
 */
class ClusterNotInitialized extends Data.TaggedError("ClusterNotInitialized")<{
	readonly file: string
	readonly cause: unknown
}> {
	override get message(): string {
		return `the PostgreSQL ${pgPin.version} cluster is not initialised: ${this.file} cannot be read; run pnpm pg:init`
	}
}

/**
 * What exists of one member of the local cluster family only once scripts/pg/init.sh has initialised it, read from its
 * state directory: where it listens, the owner role's password, and the certificates of the local CA, which signed the
 * server's, and of a CA that did not. Every connection test support opens reaches the member through these, its port
 * and its socket among them, so a process reaches one member alone.
 */
export interface InitializedClusterShape {
	/** The member's port on localhost, its name. */
	readonly port: number
	/** The directory of the member's Unix socket, where the bootstrap superuser connects by peer authentication. */
	readonly socket: string
	/** The password init.sh gave the owner role, grizzle_dev, the migration identity. */
	readonly devPassword: Redacted.Redacted
	/** The local CA's PEM file, for a client that reads one: psql, and a connection URL's sslrootcert. */
	readonly caFile: string
	/** The local CA's PEM text, which every verify-full connection chains the server's certificate to. */
	readonly caPem: string
	/** The PEM text of a CA that signed nothing the server presents, for the refusal checks. */
	readonly wrongCaPem: string
}

/** The one read of `member`'s files: each once, or ClusterNotInitialized for the first that cannot be read. */
export const readCluster = (
	member: LocalCluster
): Effect.Effect<InitializedClusterShape, ClusterNotInitialized, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const read = (file: string): Effect.Effect<string, ClusterNotInitialized> =>
			Effect.mapError(
				fs.readFileString(file),
				(cause) => new ClusterNotInitialized({ file, cause })
			)
		const caFile = `${member.tls}/ca.crt`
		const [devPassword, caPem, wrongCaPem] = yield* Effect.all([
			read(member.passwordFile),
			read(caFile),
			read(`${member.tls}/wrong-ca.crt`)
		])
		return {
			port: member.port,
			socket: member.socket,
			devPassword: Redacted.make(Str.trim(devPassword)),
			caFile,
			caPem,
			wrongCaPem
		}
	})

/**
 * The variable a case's child process is lent its parent's place on the cluster by (shared.ts lend):
 * `<port>:<width>:<database>`, the member the case runs on, the permits of the case's budget it set aside for the child,
 * which the child draws from instead of taking a lease of its own (a runner worker holds its member's lease slot for its
 * life, so a child that leased would wait on its own parent), and the case's database, which the child works in.
 */
export const lentVariable = "GRIZZLE_PG_LENT"

/** A place on the cluster a parent lent this process (lentVariable): the member's port, its permits, its database. */
export interface Lent {
	readonly port: number
	readonly width: number
	readonly database: string
}

const lentText = regex("^([1-9][0-9]{0,4}):([1-9][0-9]*):([a-z_][a-z0-9_]*)$")

/**
 * The place this process's parent lent it (lentVariable), read through Config once: none for a process that leases
 * its own (a Vitest file, a runner worker, a bench), and a defect for a variable that names no place, which only a
 * broken parent writes.
 */
export const lentPlace: Effect.Effect<Option.Option<Lent>> = Effect.map(
	Effect.orDie(Config.option(Config.String(lentVariable))),
	Option.map((text) => {
		const parsed = lentText.exec(text)
		if (parsed === null) {
			throw new Error(
				`${lentVariable}=${text} names no place: <port>:<width>:<database> it must be`
			)
		}
		return { port: Number(parsed[1]), width: Number(parsed[2]), database: parsed[3] }
	})
)

/**
 * The member of the family GRIZZLE_PG_CLUSTER names that this process reaches, read once: the family as its family file
 * records it (packages/pg/src/family.ts readFamily), and that member's files. A child its parent lent a place to
 * reaches the parent's member (lentPlace); any other process its Vitest worker's (memberOf, worker w on member (w − 1)
 * mod K; a process outside a worker on the first). A lent port the family does not list is FamilyUnrecorded.
 */
const selectedCluster: Effect.Effect<
	InitializedClusterShape,
	ClusterNotInitialized | FamilyUnrecorded,
	FileSystem.FileSystem
> = Effect.gen(function* () {
	const family = yield* readFamily(localCluster)
	const lent = yield* lentPlace
	const member = yield* Option.match(lent, {
		onNone: () => Effect.map(currentWorker, (worker) => memberOf(family, worker)),
		onSome: (place) =>
			Effect.mapError(
				Effect.fromOption(Arr.findFirst(family.members, (m) => m.port === place.port)),
				() =>
					new FamilyUnrecorded({
						file: localCluster.state,
						reason: `the lent member ${place.port} is none of the family's`
					})
			)
	})
	return yield* readCluster(member)
})

/**
 * The initialised member of the local cluster family this process reaches, parsed once from its family file and state
 * directory when the layer is built. Nothing reads the cluster when a module loads: code that reaches the cluster's
 * facts needs this service, or the substrate built from it (substrate/substrate.ts), so a test that provides neither
 * cannot reach them, and an unrecorded family or an uninitialised member is the typed failure of the layer's build. The
 * database tier provides it: Substrate's layers build it, a bench's sweep, and a CLI child's configuration
 * (cli/config.child.ts); the network run's global setup and teardown build one for each member (`member`).
 */
export class InitializedCluster extends Context.Service<
	InitializedCluster,
	InitializedClusterShape
>()("grizzle-workspace/test/support/cluster/InitializedCluster") {
	static readonly layer = Layer.effect(InitializedCluster, selectedCluster).pipe(
		Layer.provide(NodeFileSystem.layer)
	)
	/** The member `member` of the family, which the global setup and teardown reach one after another. */
	static readonly member = (member: LocalCluster) =>
		Layer.effect(InitializedCluster, readCluster(member)).pipe(Layer.provide(NodeFileSystem.layer))
}
