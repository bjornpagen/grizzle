/**
 * The module the family-width law (family-width.test.ts) runs in a child Node process of its own for each
 * TOOLCHAIN_TEST_WORKERS setting, since every width it reads is a module constant fixed once at import. It prints one
 * JSON line: the cores this process may use (availableParallelism()), the two widths packages/pg/src/workers.ts reads
 * (machineWorkers, networkWorkers), and the family packages/pg/src/family.ts sizes from them (familyMembers,
 * memberShare).
 */
import { availableParallelism } from "node:os"
import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { familyMembers, memberShare } from "#pg/family.ts"
import { machineWorkers, networkWorkers } from "#pg/workers.ts"

/** What the child prints: the cores, the widest run and this run's width, and the family. */
export type FamilyWidths = Readonly<{
	cores: number
	machineWorkers: number
	networkWorkers: number
	familyMembers: number
	memberShare: number
}>

const main = Effect.flatMap(
	Effect.sync((): FamilyWidths => ({
		cores: availableParallelism(),
		machineWorkers,
		networkWorkers,
		familyMembers,
		memberShare
	})),
	(widths) => Console.log(jsonText(widths))
)

NodeRuntime.runMain(main)
