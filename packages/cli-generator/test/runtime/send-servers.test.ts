/**
 * Each operation of a generated CLI sends by the servers table of its own level (design 6.4): the generator emits an
 * operation's own servers when they are not the root's (its own, else its path item's), with the bound origin set of
 * that level's accepted servers, and the runtime sends to the level's chosen server with the credential, refuses a
 * `--server` entry whose origin the level does not bind, and on a redirect sends the credential only to an origin the
 * level binds, so no document-wide set lets a credential follow an override to the root's host or another override's.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	expectedOf,
	observedOf,
	type SendFeature,
	sendFeatures,
	sends,
	sentOf,
	serversFixture
} from "#test/runtime/send-servers.fixtures.ts"

/**
 * Each send shows its level's emitted table, goes where the level's table says, and carries the credential only to an
 * origin that table binds. It replaces seven example cases over three of its operations; the exhaustion proves it over
 * every operation, server choice and redirect of its document.
 */
export const boundSends = property.exhaust(sends, {
	box: "every operation of the document (servers of its own, of its path item, its own over its path item's, the root's, and its own with none accepted), with no --server or each server of its level, answered by a 200 or by a 302 to each origin the document names and to one it does not",
	needs: { fixture: serversFixture },
	situations: [
		"an operation's own servers",
		"a path item's servers",
		"the root's servers",
		"its own servers over its path item's",
		"a level that accepts no server",
		"the accepted default",
		"no accepted default",
		"a --server entry the level binds",
		"a --server entry only another level binds",
		"a --server entry no level binds",
		"a redirect within the bound set",
		"a redirect to an origin only another level binds",
		"a redirect to an origin no level binds"
	] satisfies ReadonlyArray<Reached<SendFeature>>,
	check:
		({ fixture }, c: Case<SendFeature>) =>
		(sendCase) =>
			Effect.gen(function* () {
				c.noteAll(sendFeatures(sendCase))
				const emitted = yield* fixture
				const sent = yield* sentOf(sendCase, emitted)
				const expected = expectedOf(sendCase)
				assert.deepEqual<typeof expected>(observedOf(sendCase, emitted, sent), expected)
			}),
	oracle: {
		kind: "specification",
		name: "design 6.4: each level's table binds the origins of its accepted servers, a --server entry outside it is a usage error, and a hop carries the credential only to an origin it binds"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/generate.ts",
			original: "boundOrigins: (servers) => boundOrigins(servers, serversContext).origins,",
			replacement: "boundOrigins: () => bound.origins,",
			why: "Every table the generator emits binds the root's origins, a document-wide set, so an override's table binds none of its own servers' origins and the credential follows a redirect to the root's host; the property fails."
		},
		{
			file: "packages/cli-generator/src/emit/api.ts",
			original: 'if (Arr.some(operation.servers, (server) => server.level !== "root")) {',
			replacement: 'if (Arr.some(operation.servers, (server) => server.level === "operation")) {',
			why: "An operation whose servers are its path item's emits no table of its own, so it sends to the root's server by the root's set; the property fails."
		},
		{
			file: "packages/cli-generator/src/emit/api.ts",
			original: 'onSome: (accepted) => [["defaultServer", num(accepted)] as const]',
			replacement:
				'onSome: (accepted) => (accepted > 0 ? [["defaultServer", num(accepted)] as const] : [])',
			why: "A table whose first server is accepted emits no default, so a run with no --server is refused where it sends to that server; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "const servers = meta.servers ?? rootServers",
			replacement: "const servers = rootServers",
			why: "Every send goes by the root's table, so an override's operation sends to the root's server and its --server entries are the root's; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "boundOrigins: servers.boundOrigins,",
			replacement: "boundOrigins: rootServers.boundOrigins,",
			why: "The credential goes by the root's bound set whatever the operation's level, so an override's own host gets none and a redirect from it to the root's host carries it; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/base-url.ts",
			original:
				"if (!Arr.some(table.boundOrigins, (bound) => normalizeOrigin(bound) === origin)) {",
			replacement: "if (Arr.isReadonlyArrayEmpty(table.boundOrigins)) {",
			why: "A --server entry outside a level's bound set is sent unless the level binds nothing, so a-get's entry that only the root binds is sent, not refused as a usage error; the property fails."
		},
		{
			file: "packages/cli-generator/src/normalize/servers.ts",
			original: "\tif (declares(levels.operation)) {",
			replacement: "\tif (declares(levels.operation) && !declares(levels.pathItem)) {",
			why: "An operation that declares servers over its path item's takes the path item's, so d-get sends to b's host and binds it; the property fails."
		}
	]
})
