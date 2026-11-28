/**
 * A session over the member's Unix socket (types/layer.ts UnixSocketTransport), against PostgreSQL 19: over both connect
 * paths, an owner's session (wire/session.ts connectSession) and a lease of a login's pool (wire/pool.ts makePool), a
 * login of the case's own signs in over the socket with no password, the server reporting a local client (no client
 * address) and no TLS; and the session's CancelRequest, over a second connection to the same socket, stops a statement
 * of it blocked on an advisory lock, which the server refuses with 57014.
 *
 * The member's pg_hba.conf admits every role over its socket by its `local` line, with no secret, which asks the
 * client for nothing, as `peer` does: what this tests of the client is the same either way. Features: each path.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	runOverSocket,
	type SocketPath,
	socketPaths
} from "#test/pg/adapter/unix-socket.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * Over the member's Unix socket a login signs in with no password and no TLS, and its CancelRequest stops its
 * statement.
 */
export const overTheMembersUnixSocketALoginSignsInWithNoPasswordAndNoTlsAndItsCancelRequestStopsItsStatement =
	property.exhaust(finite(socketPaths), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["an owner's session", "a login's lease"] satisfies ReadonlyArray<
			Reached<SocketPath>
		>,
		check:
			({ substrate }, c) =>
			(path) =>
				Effect.provideServiceEffect(
					Effect.scoped(runOverSocket(path, c)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "PostgreSQL gives a Unix socket's connection no client address and no TLS, and a CancelRequest on a connection of its own stops the backend's statement with 57014"
		},
		box: "both connect paths over the member's Unix socket",
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/wire/session.ts",
				original: "\t\tsocket.connect(socketFile(transport))",
				replacement: '\t\tsocket.connect("/nowhere/.s.PGSQL.5432")',
				why: "A socket session's CancelRequest goes to a socket file no server listens at: it is unreached, and the blocked statement runs on."
			}
		]
	})
