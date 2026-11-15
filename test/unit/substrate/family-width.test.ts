/**
 * The cluster family is the machine's (packages/pg/src/family.ts, workers.ts): how many members it has
 * (familyMembers) and how many workers each serves (memberShare), and through them every setting scripts/pg/init.sh
 * writes and scripts/pg/doctor.sh requires (size.ts), are functions of the cores this process may use
 * (availableParallelism(), machineWorkers) alone, and never of TOOLCHAIN_TEST_WORKERS. That variable caps one run's
 * width (networkWorkers, the testing library's testWorkers: Vitest's maxWorkers and the shared databases the global
 * setup clones), and a machine's owner sets it machine-wide, as cassowary's shell sets a quarter of its cores. A family
 * sized from it would differ from the family init.sh recorded, which parseFamily then refuses, and a family made under
 * a cap would be too small for a run without one.
 *
 * Each width is a module constant read once at import, so each case runs in a child Node process of its own
 * (family-width.child.ts), started with TOOLCHAIN_TEST_WORKERS unset or set as the case says and the rest of its
 * environment this process's. The box: unset, and every power of two from 1 to four times the cores, rounded up to a
 * power of two (1 to 256 at cassowary's 64 cores): a cap of one, caps below the cores (16 among them), and caps past
 * them.
 *
 * The oracle is the family a child sizes with TOOLCHAIN_TEST_WORKERS unset, where both widths are the cores (the
 * testing library's own default is availableParallelism()), so what the cores alone give: every case's familyMembers
 * and memberShare equal it, and its machineWorkers is its cores. The control: every case's networkWorkers is its cap,
 * the cores when unset, so the setting reaches the child and the law is not held vacuously.
 *
 * @plant test/plants/unit/substrate/family-sized-by-run.patch familyMembers and memberShare read networkWorkers, one
 * run's width, so the family follows TOOLCHAIN_TEST_WORKERS; the property fails at the cap of one.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { constant, int, map, oneOf } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect, Formatter, Option, String as Str } from "effect"
import { trustedJson } from "#compiler/core/trusted.ts"
import { assert } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { caseHang } from "#test/support/limits.ts"
import { hardenedNode, run, runOptions } from "#test/support/process.ts"
import type { FamilyWidths } from "#test/unit/substrate/family-width.child.ts"

/** The machine owner's cap on a run's width, which the testing library's testWorkers follows. */
const capVariable = "TOOLCHAIN_TEST_WORKERS"

/** Where a case's cap stands against the cores. */
type WidthFeature =
	| "unset"
	| "a cap of one"
	| "a cap below the cores"
	| "a cap of the cores"
	| "a cap past the cores"

const featureOf = (cap: Option.Option<number>, cores: number): WidthFeature =>
	Option.match(cap, {
		onNone: () => "unset",
		onSome: (n) =>
			n === 1
				? "a cap of one"
				: n < cores
					? "a cap below the cores"
					: n === cores
						? "a cap of the cores"
						: "a cap past the cores"
	})

/**
 * What a child Node process of its own prints (family-width.child.ts), started with TOOLCHAIN_TEST_WORKERS set to `cap`
 * or unset for none, its environment otherwise this process's.
 */
const familyWidths = (cap: Option.Option<number>) =>
	Effect.gen(function* () {
		const setting = Option.match(cap, {
			onNone: (): ReadonlyArray<string> => [],
			onSome: (n) => [`${capVariable}=${n}`]
		})
		const ran = yield* run(
			"env",
			[
				"-u",
				capVariable,
				...setting,
				process.execPath,
				...hardenedNode,
				`${repoRoot}test/unit/substrate/family-width.child.ts`
			],
			runOptions
		)
		assert.equal(
			ran.status,
			0,
			`the child under ${Formatter.format(setting)} failed:\n${ran.stderr}`
		)
		return trustedJson<FamilyWidths>(Str.trim(ran.stdout))
	})

layer(NodeServices.layer, { excludeTestServices: true })("the cluster family's width", (it) => {
	it.effect(
		"sizes the family from the cores alone, the same members and share under every TOOLCHAIN_TEST_WORKERS, while each run's width follows it",
		(ctx) =>
			Effect.gen(function* () {
				const alone = yield* familyWidths(Option.none())
				assert.deepEqual(
					{ machineWorkers: alone.machineWorkers, networkWorkers: alone.networkWorkers },
					{ machineWorkers: alone.cores, networkWorkers: alone.cores },
					"unset, a run is as wide as the machine allows, so this family is the cores' alone"
				)
				const top = Math.ceil(Math.log2(alone.cores)) + 2
				return yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/substrate/family-width",
							generator: oneOf([
								constant(Option.none()),
								map(int(0, top), (exponent) => Option.some(2 ** exponent))
							]),
							literal: Formatter.format,
							box: `${capVariable} unset, and every power of two from 1 to ${2 ** top}, four times the ${alone.cores} cores rounded up to a power of two`,
							oracle: {
								kind: "specification",
								name: `the family a child sizes with ${capVariable} unset, where both widths are the cores`
							},
							coverage: requiredInSpace<WidthFeature>([
								"unset",
								"a cap of one",
								"a cap below the cores",
								"a cap past the cores"
							]),
							caseHang,
							concurrency: 1
						},
						(cap, c) =>
							Effect.gen(function* () {
								const widths = yield* familyWidths(cap)
								assert.equal(
									widths.networkWorkers,
									Option.getOrElse(cap, () => widths.cores),
									"the run's width is its cap, the cores unset"
								)
								assert.equal(
									widths.machineWorkers,
									widths.cores,
									"the widest run is a file per core"
								)
								assert.deepEqual(
									{
										cores: widths.cores,
										familyMembers: widths.familyMembers,
										memberShare: widths.memberShare
									},
									{
										cores: alone.cores,
										familyMembers: alone.familyMembers,
										memberShare: alone.memberShare
									},
									`the family under ${capVariable} ${Option.match(cap, {
										onNone: () => "unset",
										onSome: (n) => `${n}`
									})} is the cores' alone`
								)
								c.note(featureOf(cap, widths.cores))
							})
					)
				)
			})
	)
})
