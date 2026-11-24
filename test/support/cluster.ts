import {
	checkoutHere,
	type CheckoutFamily,
	type ClusterFailed,
	familyAsSettled,
	familyOf,
	homesHere,
	type MemberTls,
	memberAtPort,
	memberRead,
	type PgMember,
	type Platform
} from "@bjornpagen/testing/pg"
import { testWorkers } from "@bjornpagen/testing/workers"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { regex } from "arkregex"
import { Config, Context, Data, Effect, Layer, Option } from "effect"
import { pgCluster } from "#test/support/env.ts"

/**
 * How a client verifies a member over TLS: the CA its server's certificate chains to, as its PEM text and its file, and
 * the PEM text of a CA that signed nothing the server presents, for the checks that must refuse a server they cannot
 * verify.
 */
export type MemberCa = Extract<MemberTls, { readonly kind: "tls" }>

/**
 * A member as grizzle reaches it: over verify-full TLS at localhost, its CA stated (MemberCa). grizzle refuses a
 * connection without verify-full TLS and refuses a socket path (packages/grizzle/src/adapter/types/layer.ts), so a
 * member of no TLS is no member its tests can reach.
 */
export type TlsMember = PgMember & Readonly<{ tls: MemberCa }>

/** A member whose cluster states no TLS (its network a socket alone), which no grizzle client reaches. */
class SocketOnlyMember extends Data.TaggedError("SocketOnlyMember")<{
	readonly member: string
}> {
	override get message(): string {
		return `member ${this.member} is reached over its socket alone: grizzle connects over verify-full TLS only, so its cluster's network must be tls (pg.config.ts)`
	}
}

/** `member` as grizzle reaches it (TlsMember), or SocketOnlyMember when it states no TLS. */
export const overTls = (member: PgMember): Effect.Effect<TlsMember, SocketOnlyMember> =>
	member.tls.kind === "tls"
		? Effect.succeed({ ...member, tls: member.tls })
		: Effect.fail(new SocketOnlyMember({ member: member.name }))

/**
 * This checkout's family of grizzle's local cluster (pg.config.ts) as a process of a run reaches it: at the run's width
 * (@bjornpagen/testing/pg familyOf, of the checkout and homes checkoutHere and homesHere read, and the run's
 * testWorkers, which a case's child inherits from its run with the run's CPU allowance), whose members the run's
 * workers brought up at that width.
 */
const runFamily: Effect.Effect<CheckoutFamily, ClusterFailed, Platform> = Effect.map(
	Effect.all([checkoutHere, homesHere]),
	([checkout, homes]) => familyOf(pgCluster, checkout, homes, testWorkers)
)

/**
 * This checkout's family of grizzle's local cluster as a process no run started reaches it (a bench, a script): at the
 * width its state was last settled for (@bjornpagen/testing/pg familyAsSettled), since such a process runs no workers
 * and has no width of its own to settle the family at.
 */
const settledFamily: Effect.Effect<CheckoutFamily, ClusterFailed, Platform> = Effect.flatMap(
	Effect.all([checkoutHere, homesHere]),
	([checkout, homes]) => familyAsSettled(pgCluster, checkout, homes)
)

/**
 * The first member of this checkout's family, which `toolchain-pg settle` brings up, as a process no run lent a place
 * to reaches it (TlsMember: its port, socket, owner's password and CA), at the width the family was last settled for
 * (settledFamily), read writing nothing (memberRead), a member not as its spec states refused, naming `toolchain-pg
 * settle`, which gives it them.
 */
const firstMember: Effect.Effect<TlsMember, ClusterFailed | SocketOnlyMember, Platform> =
	Effect.flatMap(
		Effect.flatMap(settledFamily, (family) => memberRead(family, 0)),
		overTls
	)

/**
 * The member of this checkout's family at `port`, its family's claim, as a process of a run reaches it (runFamily: a
 * case's runner worker or a child its case started) and a client reaches it (TlsMember), read alone,
 * writing nothing and reading no other member (memberAtPort), so a process reaches the one member its parent's case runs
 * on at the cost of that member's read: a command line child reads one member a command, where it read every member of
 * the family (commandLineWorkflow's steered case 12 at cbafe522 spent its process tree's 60 s CPU budget on those
 * reads). A port no member is at fails, naming the members' ports.
 */
export const memberAt = (
	port: number
): Effect.Effect<TlsMember, ClusterFailed | SocketOnlyMember, Platform> =>
	Effect.flatMap(
		Effect.flatMap(runFamily, (family) => memberAtPort(family, port)),
		overTls
	)

/**
 * The variable a case's child process is lent its parent's place on the cluster by (shared.ts lend):
 * `<port>:<width>:<database>`, the member the case runs on, the permits of the case's budget it set aside for the child,
 * which the child draws from instead of a budget of its own (so the worker and its children hold no more than the
 * worker's budget, connections.ts connectionsPerWorker), and the case's database, which the child works in.
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
 * The place this process's parent lent it (lentVariable), read through Config once: none for a process that holds a
 * budget of its own (a Vitest file, a runner worker, a bench), and a defect for a variable that names no place, which
 * only a broken parent writes.
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
 * The member of grizzle's local cluster this process reaches, read once: a child its parent lent a place to reaches the
 * parent's member (lentPlace, memberAt); any other process, a bench's or a CLI child's, the first.
 */
const selectedMember: Effect.Effect<TlsMember, ClusterFailed | SocketOnlyMember, Platform> =
	Effect.flatMap(lentPlace, (lent) =>
		Option.match(lent, {
			onNone: () => firstMember,
			onSome: (place) => memberAt(place.port)
		})
	)

/**
 * The member of grizzle's local cluster this process reaches, read once when the layer is built. Nothing reads the
 * cluster when a module loads: code that reaches a member's facts needs this service, or the substrate built from it
 * (substrate/substrate.ts), so a test that provides neither cannot reach them, and a cluster that is not settled is the
 * typed failure of the layer's build. The database tier provides it: Substrate's layers build it, a
 * bench's sweep, and a CLI child's configuration (cli/config.child.ts).
 */
export class InitializedCluster extends Context.Service<InitializedCluster, TlsMember>()(
	"grizzle-workspace/test/support/cluster/InitializedCluster"
) {
	static readonly layer = Layer.effect(InitializedCluster, selectedMember).pipe(
		Layer.provide(NodeServices.layer)
	)
}
