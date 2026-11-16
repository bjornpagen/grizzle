/**
 * The local cluster a name selects (packages/pg/src/local-cluster.ts selectCluster), which every script reads through
 * packages/pg/src/cluster.ts and every test through env.ts, over every name GRIZZLE_PG_CLUSTER can hold in a box:
 *
 * - unset, it selects today's cluster exactly, as pin.env spelled it before clusters were named: port 5433 and the
 *   state directory `$HOME/.local/var/grizzle/pg$PG_PIN_VERSION` with its data, tls, log and socket directories and
 *   the owner's password file;
 * - a port spelled in canonical decimal selects the cluster of that port, whose state directory sits beside the
 *   default's and reads back as that port alone: the read-back is a left inverse, so no two ports share a directory,
 *   and none's lies inside another's, which init.sh --force and destroy remove whole;
 * - a misspelled port, each by name, is refused, never read as some port or as the default.
 *
 * The oracle is the specification: today's pin.env values, and the read-back from a state directory to its port.
 * Features: the variable unset, the default port named, a port beside it, the least and the greatest port, any other
 * port, and each misspelling refused.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { selectCluster } from "#pg/local-cluster.ts"
import { assert } from "#test/support/assert.ts"
import { pgPin } from "#test/support/env.ts"
import {
	environmentOf,
	misspelled,
	misspellings,
	type NameFeature,
	nameGen,
	portFeature,
	portOfState,
	today,
	todaysPort
} from "#test/unit/substrate/cluster.fixtures.ts"

/** Local cluster names select today's cluster unset, the cluster of a canonical port beside it otherwise, its directory reading back as that port alone, and refuse every misspelling. */
export const localClusterNamesSelectTodaysClusterUnsetTheClusterOfACanonicalPortBesideItOtherwiseItsDirectoryReadingBackAsThatPortAloneAndRefuseEveryMisspelling =
	property.exhaust(finite(nameGen), {
		needs: {},
		situations: [
			"unset, today's cluster",
			"today's port named",
			"a port beside today's",
			"the least port",
			"the greatest port",
			"another port",
			...Arr.map(misspellings, (misspelling): NameFeature => `${misspelling} refused`)
		] satisfies ReadonlyArray<Reached<NameFeature>>,
		check: (_, c: Case<NameFeature>) => (name) =>
			Effect.map(Effect.result(selectCluster(environmentOf(name))), (selected) => {
				switch (name.kind) {
					case "unset": {
						assert.ok(Result.isSuccess(selected), "an unset name selects a cluster")
						assert.deepEqual(selected.success, today)
						c.note("unset, today's cluster")
						return
					}
					case "port": {
						assert.ok(Result.isSuccess(selected), `port ${name.port} names a cluster`)
						const cluster = selected.success
						assert.equal(cluster.port, name.port)
						assert.deepEqual(portOfState(cluster.state), Option.some(name.port), cluster.state)
						assert.deepEqual(
							[cluster.data, cluster.tls, cluster.log, cluster.socket, cluster.passwordFile],
							[
								`${cluster.state}/data`,
								`${cluster.state}/tls`,
								`${cluster.state}/log`,
								`${cluster.state}/socket`,
								`${cluster.state}/${pgPin.devRole}.password`
							]
						)
						if (name.port === todaysPort) {
							assert.deepEqual(cluster, today)
						}
						c.note(portFeature(name.port))
						return
					}
					case "misspelled": {
						const spelling = misspelled(name.port, name.misspelling)
						assert.ok(Result.isFailure(selected), `${Formatter.format(spelling)} is refused`)
						c.note(`${name.misspelling} refused`)
						return
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "today's pin.env values, and the read-back from a state directory to its port"
		},
		box: "GRIZZLE_PG_CLUSTER unset, every port from 1 to 65535 in canonical decimal, and each named misspelling of ports 1, 5433 and 65535",
		kept: [],
		kills: [
			{
				file: "packages/pg/src/local-cluster.ts",
				original: `\t\t\t: \`\${pin.GRIZZLE_PG_DEFAULT_STATE}-\${port}\``,
				replacement: `\t\t\t: \`\${pin.GRIZZLE_PG_DEFAULT_STATE}-\${port % 10_000}\``,
				why: "A state directory is suffixed with the port's last four digits, so 5440 and 15440 share one; the property fails."
			},
			{
				file: "packages/pg/src/local-cluster.ts",
				original: `\tconst state =\n\t\tport === pin.GRIZZLE_PG_DEFAULT_CLUSTER\n\t\t\t? pin.GRIZZLE_PG_DEFAULT_STATE\n\t\t\t: \`\${pin.GRIZZLE_PG_DEFAULT_STATE}-\${port}\``,
				replacement: `\tconst state = \`\${pin.GRIZZLE_PG_DEFAULT_STATE}-\${port}\``,
				why: "The default's state directory is suffixed like every other's; the property fails."
			},
			{
				file: "packages/pg/src/local-cluster.ts",
				original: `\t\t\tonSome: ({ port, text }) =>\n\t\t\t\t\`\${port}\` === text\n\t\t\t\t\t? Effect.succeed(clusterAt(port))\n\t\t\t\t\t: Effect.fail(\n\t\t\t\t\t\t\tnew ClusterUnnamed({ reason: \`"\${text}" spells port \${port} otherwise than \${port}\` })\n\t\t\t\t\t\t)`,
				replacement: "\t\t\tonSome: ({ port }) => Effect.succeed(clusterAt(port))",
				why: "A name is read by its port alone, which admits 05440 and 5e3; the property fails."
			}
		]
	})
