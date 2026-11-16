/**
 * The cluster family's three facts every reader of it relies on (packages/pg/src/family.ts), each over drawn cases:
 *
 * - the worker map: in a family of K members serving W workers, every worker reaches exactly one member (memberOf),
 *   the global setup clones that worker's shared database on that member alone (workersOf), and no member serves more
 *   workers than its share, ceil(W / K), which init.sh sizes it for (size.ts over memberShare); a process outside a
 *   worker reaches the first;
 * - the family file: a family's text reads back as that family (familyText, parseFamily), and a text that is no family
 *   of its first member is refused, each corruption by name: a port listed twice, a first that is not the family's
 *   name, a port misspelled, a member too many or too few;
 * - member ports: each further member's port, found as init.sh finds it (ports.ts freePort, given the ports the family
 *   already has), is new to the family and free on every address localhost names when found, so its postmaster can
 *   listen there, whatever holds the ports beside the family's name: the case holds some of them first with
 *   listeners of its own, foreign postmasters as far as the family can tell.
 *
 * The oracles are the specification: the map (w − 1) mod K, the share ceil(W / K), the file's line format, and a port's
 * freedom as a listener of the test's own finds it.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { familyText, memberOf, parseFamily, workersOf } from "#pg/family.ts"
import { clusterAt } from "#pg/local-cluster.ts"
import { freePort } from "#pg/ports.ts"
import { assert } from "#test/support/assert.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	corruptions,
	familyAt,
	type FileFeature,
	fileGen,
	fileText,
	greatestPort,
	hold,
	listenable,
	localhostAddresses,
	type MapFeature,
	mapGen,
	type PortFeature,
	portGen,
	systemPort
} from "#test/unit/substrate/family.fixtures.ts"

/**
 * The cluster family maps every worker to exactly the member that clones its database, none past its share, and the
 * first outside a worker.
 *
 * Budget: its suite's count before the conversion (unit/substrate/family-map: 48 independent cases and 12 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theClusterFamilyMapsEveryWorkerToExactlyTheMemberThatClonesItsDatabaseNonePastItsShareAndTheFirstOutsideAWorker =
	property.explore(mapGen, {
		needs: {},
		situations: [
			"one member",
			"several members",
			"workers spread evenly",
			"a member serving one worker fewer",
			"a member for every worker"
		] satisfies ReadonlyArray<Reached<MapFeature>>,
		check: (_, c: Case<MapFeature>) => (x) =>
			Effect.sync(() => {
				const family = familyAt(30_000, x.members)
				const share = Math.ceil(x.workers / x.members)
				const loads = upTo(x.members, (i) => workersOf(x.members, i, x.workers))
				for (let w = 1; w <= x.workers; w++) {
					const reached = memberOf(family, Option.some(w))
					const index = family.members.indexOf(reached)
					assert.ok(index >= 0, `worker ${w} reaches a member of the family`)
					const cloning = Arr.filter(
						upTo(x.members, (i) => i),
						(i) => (loads[i] ?? []).includes(w)
					)
					assert.deepEqual(
						cloning,
						[index],
						`worker ${w}'s database is cloned on the member it reaches, and on no other`
					)
				}
				for (const [i, load] of loads.entries()) {
					assert.ok(
						load.length >= 1 && load.length <= share,
						`member ${i} serves ${load.length} workers of ${x.workers}, its share ${share}`
					)
				}
				assert.equal(
					memberOf(family, Option.none()),
					family.members[0],
					"a process outside a worker reaches the first member"
				)
				c.note(x.members === 1 ? "one member" : "several members")
				c.note(
					x.workers % x.members === 0
						? "workers spread evenly"
						: "a member serving one worker fewer"
				)
				if (x.members === x.workers) {
					c.note("a member for every worker")
				}
			}),
		oracle: {
			kind: "specification",
			name: "worker w on member (w − 1) mod K, none serving past ceil(W / K)"
		},
		budget: { runs: 48, steered: 12 },
		kept: [],
		kills: [
			{
				file: "packages/pg/src/family.ts",
				original:
					"\t\tonSome: (w) => Arr.getUnsafe(family.members, memberIndexOf(family.members.length, w))",
				replacement: "\t\tonSome: () => Arr.headNonEmpty(family.members)",
				why: "Every worker is mapped to the first member; the map property fails."
			}
		]
	})

/**
 * The cluster family reads a family file back as its family, and refuses every text that is no family of its first
 * member.
 *
 * Budget: its suite's count before the conversion (unit/substrate/family-file: 48 independent cases and 24 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theClusterFamilyReadsAFamilyFileBackAsItsFamilyAndRefusesEveryTextThatIsNoFamilyOfItsFirstMember =
	property.explore(fileGen, {
		needs: {},
		situations: [
			"a family of one member read back",
			"a family of several read back",
			...Arr.map(Arr.drop(corruptions, 1), (corruption): FileFeature => `${corruption} refused`)
		] satisfies ReadonlyArray<Reached<FileFeature>>,
		check: (_, c: Case<FileFeature>) => (x) =>
			Effect.sync(() => {
				const first = clusterAt(x.first)
				const text = fileText(x)
				const read = parseFamily(first, x.members, text)
				if (x.corruption === "none") {
					assert.ok(
						Result.isSuccess(read),
						`${Formatter.format(text)} reads back: ${Formatter.format(read)}`
					)
					if (Result.isSuccess(read)) {
						assert.equal(
							familyText(read.success),
							text,
							"the family's text is the text it was read from"
						)
						const readPorts: ReadonlyArray<number> = Arr.map(
							read.success.members,
							(member) => member.port
						)
						assert.deepEqual(
							readPorts,
							upTo(x.members, (i) => x.first + i)
						)
					}
					c.note(
						x.members === 1 ? "a family of one member read back" : "a family of several read back"
					)
					return
				}
				assert.ok(
					Result.isFailure(read),
					`${Formatter.format(text)} is refused: ${Formatter.format(read)}`
				)
				c.note(`${x.corruption} refused`)
			}),
		oracle: {
			kind: "specification",
			name: "one port a line in canonical decimal, none twice, the family's name first, as many as its members"
		},
		budget: { runs: 48, steered: 24 },
		kept: [],
		kills: [
			{
				file: "packages/pg/src/family.ts",
				original: "\tif (new Set(ports).size !== ports.length) {",
				replacement: "\tif (new Set(ports).size === ports.length) {",
				why: "Operator mutant (comparison) at packages/pg/src/family.ts:86 in parseFamily: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * The cluster family finds each further member a port new to the family and free on every localhost address, whatever
 * holds the ports beside its name.
 *
 * Budget: its suite's count before the conversion (unit/substrate/family-ports: 24 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theClusterFamilyFindsEachFurtherMemberAPortNewToTheFamilyAndFreeOnEveryLocalhostAddressWhateverHoldsThePortsBesideItsName =
	property.explore(portGen, {
		needs: {},
		situations: [
			"the port after the family's name held",
			"every port after the family's name held",
			"several members found"
		] satisfies ReadonlyArray<Reached<PortFeature>>,
		check: (_, c: Case<PortFeature>) => (x) =>
			Effect.scoped(
				Effect.gen(function* () {
					const addresses = yield* localhostAddresses
					const name = yield* systemPort(addresses)
					for (const offset of upTo(x.held, (i) => i + 1)) {
						if (name + offset <= greatestPort) {
							yield* Effect.forEach(addresses, (address) => hold(address, name + offset), {
								discard: true
							})
						}
					}
					let members: ReadonlyArray<number> = [name]
					for (let n = 0; n < x.further; n++) {
						const port = yield* Effect.orDie(freePort(members))
						assert.ok(
							!members.includes(port),
							`port ${port} is new to the family ${Arr.join(
								Arr.map(members, (m) => `${m}`),
								", "
							)}`
						)
						const free = yield* Effect.forEach(addresses, (address) => listenable(address, port))
						assert.ok(
							Arr.every(free, (f) => f),
							`port ${port}, found for a member of ${Arr.join(
								Arr.map(members, (m) => `${m}`),
								", "
							)} with ${x.held} port(s) after ${name} held, is free at every address`
						)
						members = Arr.append(members, port)
					}
					if (x.held >= 1) {
						c.note("the port after the family's name held")
					}
					if (x.held === x.further) {
						c.note("every port after the family's name held")
					}
					if (x.further > 1) {
						c.note("several members found")
					}
				})
			),
		oracle: {
			kind: "specification",
			name: "a port is free where a listener of the test's own can listen on it at every address localhost names"
		},
		budget: { runs: 24, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/pg/src/ports.ts",
				original:
					'\tEffect.flatMap(localhostAddresses, (addresses) => {\n\t\tconst [first] = addresses\n\t\tconst attempt: Effect.Effect<number, LocalhostUnresolved> = Effect.flatMap(\n\t\t\tEffect.orDie(listened(first, 0)),\n\t\t\t(port) =>\n\t\t\t\ttaken.includes(port)\n\t\t\t\t\t? attempt\n\t\t\t\t\t: Effect.matchEffect(portFree(port), {\n\t\t\t\t\t\t\tonFailure: (error) =>\n\t\t\t\t\t\t\t\terror._tag === "LocalhostUnresolved" ? Effect.fail(error) : attempt,\n\t\t\t\t\t\t\tonSuccess: () => Effect.succeed(port)\n\t\t\t\t\t\t})\n\t\t)\n\t\treturn attempt\n\t})',
				replacement: "\tEffect.succeed(Math.max(0, ...taken) + 1)",
				why: "A member's port is the one after the family's last, derived by arithmetic, not found free; the port property fails."
			}
		]
	})
