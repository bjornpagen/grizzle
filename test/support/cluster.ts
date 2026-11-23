import {
	checkoutHere,
	type ClusterFailed,
	familyOf,
	homesHere,
	type MemberTls,
	membersRead,
	type PgMember,
	type Platform
} from "@bjornpagen/testing/pg"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { regex } from "arkregex"
import { Array as Arr, Config, Context, Data, Effect, Layer, Option } from "effect"
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
 * The members of this checkout's family of grizzle's local cluster (pg.config.ts; @bjornpagen/testing/pg familyOf, of
 * the checkout and homes checkoutHere and homesHere read), in member order, each as a client reaches it (TlsMember: its
 * port, socket, owner's password and CA): read as a run reads them, writing nothing (membersRead), a member not as its
 * spec states refused, naming `toolchain-pg settle`, which gives it them. Every connection test support opens reaches a
 * member through these.
 */
export const clusterMembers: Effect.Effect<
	Arr.NonEmptyReadonlyArray<TlsMember>,
	ClusterFailed | SocketOnlyMember,
	Platform
> = Effect.flatMap(
	Effect.flatMap(Effect.all([checkoutHere, homesHere]), ([checkout, homes]) =>
		membersRead(familyOf(pgCluster, checkout, homes))
	),
	(members) =>
		Effect.map(
			Effect.all([
				overTls(Arr.headNonEmpty(members)),
				Effect.forEach(Arr.tailNonEmpty(members), overTls)
			]),
			([head, tail]) => Arr.prepend(tail, head)
		)
)

/** A port a process was told to reach that is none of the cluster's members. */
class MemberUnknown extends Data.TaggedError("MemberUnknown")<{
	readonly port: number
	readonly why: string
}> {
	override get message(): string {
		return `port ${this.port} is no member of grizzle's local cluster (pg.config.ts): ${this.why}`
	}
}

/** The member of `members` at `port`, or MemberUnknown saying who named it (`why`). */
export const memberAt = (
	members: Arr.NonEmptyReadonlyArray<TlsMember>,
	port: number,
	why: string
): Effect.Effect<TlsMember, MemberUnknown> =>
	Effect.mapError(
		Effect.fromOption(Arr.findFirst(members, (member) => member.port === port)),
		() => new MemberUnknown({ port, why })
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
 * parent's member (lentPlace); any other process, a bench's or a CLI child's, the first. A lent port that is no member
 * is MemberUnknown.
 */
const selectedMember: Effect.Effect<
	TlsMember,
	ClusterFailed | SocketOnlyMember | MemberUnknown,
	Platform
> = Effect.gen(function* () {
	const members = yield* clusterMembers
	const lent = yield* lentPlace
	return yield* Option.match(lent, {
		onNone: () => Effect.succeed(Arr.headNonEmpty(members)),
		onSome: (place) => memberAt(members, place.port, `the place ${lentVariable} lent`)
	})
})

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
