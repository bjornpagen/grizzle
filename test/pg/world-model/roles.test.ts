import { assert, defined } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import {
	concerns,
	empty,
	entryName,
	entryOfShape,
	install,
	openOf,
	pairBase,
	pairWorld,
	roleOf,
	shapes,
	situations,
	verdictFeatures
} from "#test/pg/world-model/roles.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { checkStart, runStep } from "#test/support/worlds/drive/index.ts"
import { unnoted } from "#test/support/worlds/drive/suite.ts"
import { templateWorld } from "#test/support/worlds/execute/template.ts"
import { defaultScope, enumerateKind } from "#test/support/worlds/generate/enumerate.ts"
import { classifyEntry } from "#test/support/worlds/model/host.ts"
import { initialState } from "#test/support/worlds/model/step.ts"
import {
	expectedPrivileges,
	installedPrivileges,
	privilegeDiff
} from "#test/support/worlds/privileges.ts"

/**
 * The worlds model: roles every entry of the small space holds the privileges its classification gives it, and a Db of its role opens.
 */
export const theWorldsModelRolesEveryEntryOfTheSmallSpaceHoldsThePrivilegesItsClassificationGivesItAndADbOfItsRoleOpens =
	property.exhaust(finite(shapes), {
		needs: { pairs: Substrate.seat(pairWorld) },
		situations: situations,
		check:
			({ pairs }, c) =>
			(s) =>
				Effect.flatMap(pairs, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const opened = new Set<string>()
							return yield* Effect.gen(function* () {
								const world = yield* templateWorld(taken, Option.none())
								const names = world.names
								const expected = expectedPrivileges(install, names)
								const installed = yield* installedPrivileges(names)
								const diff = privilegeDiff(expected, installed)
								const differing = Arr.flatMap([...diff.missing, ...diff.extra], (key) =>
									Option.toArray(
										Option.orElse(Option.fromUndefinedOr(expected.get(key)), () =>
											Option.fromUndefinedOr(installed.get(key))
										)
									)
								)

								const name = entryName(s)
								const role = defined(roleOf.get(name), `the role of ${name}`)
								const table = defined(names.tables[s.target], `the table of ${s.target}`).name
								const classified = classifyEntry(pairBase, entryOfShape(s))
								assert.deepEqual(
									Arr.filter(differing, (f) => concerns(f, role, table)),
									[],
									`the privileges of ${role}, which holds ${name}, are its classification's`
								)
								if (!opened.has(role)) {
									yield* world.reset(empty)
									const start = yield* checkStart(world, initialState(install, names, empty))
									const open = openOf(enumerateKind(start, "open-db", defaultScope), role)
									const stepped = yield* runStep(world, start, open, 0, unnoted)
									assert.equal(stepped.observation.kind, "opened", `Db.open of ${role}`)
									opened.add(role)
								}
								c.noteAll(verdictFeatures(s, classified))
							}).pipe(Effect.scoped)
						}),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "the writable-entry rule's classification, README's least privilege over it, and the worlds model's Db.open"
		},
		box: "every entry over P and Q, of one arm or two, whose head holds a field: each target, each use of its two fields, each head extra and each further member of one arm, the two arms' heads adding nothing",
		kept: [],
		kills: []
	})
