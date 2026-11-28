/**
 * Every world the executor plans installs every login of its installation, the stranger's among them (model/types.ts
 * installSpec), and an open of each role beside its own login meets the layers of the others, none of which serves a
 * role of that login: Db.open refuses it at `role`, as the worlds model's open of a role no layer of its login serves
 * says (model/session/open.ts openBranches).
 *
 * The box: the fixed installations the worlds suites realize, the roster worlds of one login first
 * (docsHeldRosterInstall), whose stranger's layer is the one layer beside its login's, and the generated installations
 * of the documents bases (drive/suite.ts generatedDocsInstalls), of one login or two. Each is drafted as `grizzle
 * generate` drafts it (execute/index.ts draftedWorld) and planned as the executor plans it (worldPlanOf), offline: each
 * login's served file compiled from the drafted snapshot. Every login's layer is built offline over its served file
 * (live-layer.ts offlineDecoders), and each role is opened with no token under the merged layers of every login but its
 * own (execute/index.ts loginsBesides), which Db.open meets without contacting anything.
 *
 * Kept: the roster worlds, whose `counter` and `keeper` opened beside their login `ops` meet the stranger's layer alone,
 * which the executor's plan died at (UninstalledRole, executorStranger) while the stranger was a layer of a login no
 * installation installed (REDS7's census at main 29a4d30c, sixteen suites). Kills: the stranger left out of the drafted
 * installation, so the plan is refused at its served file; an open beside a role's own login handed that login's layer
 * too, so Db.open opens it.
 *
 * Oracle: the worlds model's open, against Db.open over the planned world's served files.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { aimed, constant, element, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	Record as Rec,
	Result
} from "effect"
import { openServed } from "#adapter/db/served.ts"
import type { DbLayerOf } from "#adapter/types/layer.ts"
import { educationInstall } from "#test/support/fixtures/education/index.ts"
import { offlineDecoders, servedSourcedLayer } from "#test/support/live-layer.ts"
import { clusterPool } from "#test/support/pg.ts"
import { offlineConnection } from "#test/support/pg/cli/support.ts"
import { generatedDocsInstalls } from "#test/support/worlds/drive/suite.ts"
import type { BuiltLogin } from "#test/support/worlds/execute/build.ts"
import { draftedWorld, loginsBesides, worldPlanOf } from "#test/support/worlds/execute/index.ts"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import { openRefused } from "#test/support/worlds/execute/observe.ts"
import { worldVerify } from "#test/support/worlds/execute/token.ts"
import {
	docsEditorInstall,
	docsHeldRosterInstall,
	docsInstall
} from "#test/support/worlds/model/bases/docs.ts"
import { roomsInstall } from "#test/support/worlds/model/bases/rooms.ts"
import { openBranches } from "#test/support/worlds/model/session/open.ts"
import { loginHolding, loginVerifies } from "#test/support/worlds/model/session/state.ts"
import { initialState } from "#test/support/worlds/model/step.ts"
import { type Observation, stranger } from "#test/support/worlds/model/types.ts"

type PlanFeature =
	| "a role beside the stranger's layer alone"
	| "a role beside another login's layer"
	| "the stranger's role beside every other login"

/** The schema every case's installation is drafted under: the plan reads its names from the draft alone. */
const declared = "worlds_plan"

/**
 * The worlds the executor plans: the fixed installations, the roster worlds of one login first, and the generated
 * installations of the documents bases; a case aimed at a role beside the stranger's layer alone, the roster worlds.
 */
const installs = aimed(
	oneOf([
		element([
			docsHeldRosterInstall,
			docsInstall,
			docsEditorInstall,
			roomsInstall,
			educationInstall
		]),
		generatedDocsInstalls
	]),
	[["a role beside the stranger's layer alone", constant(docsHeldRosterInstall)]]
)

/**
 * The verify of a login's layer whose roles read a context, given as the executor gives it (docs/access.md
 * "Permissions"): an open beside a role's own login is refused before any token is read, so a call is a defect.
 */
const unreached = worldVerify(
	() => Option.none(),
	() => undefined
)

/** What Db.open's exit shows: an open refused at its stage, or a Db opened. */
const shownBy = (
	exit: Exit.Exit<unknown, Parameters<typeof openRefused>[0]>
): Effect.Effect<Observation["kind"] | `open-refused:${string}`> =>
	Exit.match(exit, {
		onSuccess: () => Effect.succeed("opened" as const),
		onFailure: (cause) =>
			Result.match(Cause.findError(cause), {
				onFailure: (rest) => Effect.failCause(rest),
				onSuccess: (error) =>
					Effect.map(openRefused(error, 0), (observation) =>
						observation.kind === "open-refused"
							? (`open-refused:${observation.stage}` as const)
							: observation.kind
					)
			})
	})

/**
 * Every world the executor plans installs its stranger, and an open of each role beside its own login is refused at
 * `role`, as the worlds model says.
 */
export const everyWorldTheExecutorPlansInstallsItsStrangerAndAnOpenBesideARolesOwnLoginIsRefusedAsTheModelSays =
	property.explore(installs, {
		needs: {},
		situations: [
			"a role beside the stranger's layer alone",
			"a role beside another login's layer",
			"the stranger's role beside every other login"
		] satisfies ReadonlyArray<Reached<PlanFeature>>,
		check: (_, c: Case<PlanFeature>) => (install) =>
			Effect.scoped(
				Effect.gen(function* () {
					const drafted = yield* Effect.orDie(draftedWorld(install, declared))
					assert.ok(
						Rec.has(drafted.plan.logins, stranger.login),
						"the drafted installation installs the stranger's login"
					)
					const plan = yield* Effect.orDie(
						worldPlanOf(install, {
							declared,
							plan: drafted.plan,
							snapshot: drafted.snapshot
						})
					)
					const layers = new Map<string, Context.Context<DbLayerOf<BuiltLogin>>>()
					for (const l of install.logins) {
						const file = defined(plan.first.served[l.name], `the served file of ${l.name}`)
						const layer = yield* Layer.build(
							servedSourcedLayer(offlineDecoders, {
								...offlineConnection,
								pool: clusterPool,
								login: file,
								...(loginVerifies(install, l.name) ? { verify: unreached } : {})
							})
						)
						layers.set(l.name, layer)
					}
					const state = initialState(install, installedNames(install), new Map())
					for (const role of install.roles) {
						const own = defined(loginHolding(install, role.name), `the login of ${role.name}`)
						const file = defined(plan.first.served[own.name], `the served file of ${own.name}`)
						const served = defined(file.roles[role.name], `the served role ${role.name}`)
						const [first, ...rest] = Arr.map(
							loginsBesides(install.logins, Option.some(own.name)),
							(l) => defined(layers.get(l.name), `the layer of ${l.name}`)
						)
						const besides = Arr.reduce(rest, first, (ctx, layer) => Context.merge(ctx, layer))
						const exit = yield* Effect.exit(Effect.provideContext(openServed(served, {}), besides))
						const shown = yield* shownBy(exit)
						const allowed = Arr.map(
							openBranches(
								state,
								{ kind: "other-login", role: role.name },
								{ kind: "none" },
								"current"
							),
							(b) =>
								b.observation.kind === "open-refused"
									? `open-refused:${b.observation.stage}`
									: b.observation.kind
						)
						assert.ok(
							allowed.includes(shown),
							`${role.name} opened beside its login ${own.name}: Db.open shows ${shown}, the model allows ${Arr.join(allowed, ", ")}`
						)
						c.note(
							role.name === stranger.role
								? "the stranger's role beside every other login"
								: rest.length === 0
									? "a role beside the stranger's layer alone"
									: "a role beside another login's layer"
						)
					}
				})
			),
		oracle: {
			kind: "second-implementation",
			name: "the worlds model's open of a role beside its own login, against Db.open over the planned world's served files"
		},
		budget: { runs: 24, steered: 0 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/world-model/plan.test.ts#everyWorldTheExecutorPlansInstallsItsStrangerAndAnOpenBesideARolesOwnLoginIsRefusedAsTheModelSays:-:0.0"
				),
				reason:
					"the roster worlds of one login, ops (docsHeldRosterInstall): counter and keeper opened beside ops meet the stranger's layer alone, where the executor's plan died at UninstalledRole while the stranger was a login no installation listed (REDS7's census at main 29a4d30c)",
				since: "2026-11-28"
			}
		],
		kills: [
			{
				file: "test/support/worlds/execute/index.ts",
				original:
					"\t\t\t{ schema: declared.base, logins: Rec.values(declared.logins), declarations: noDeclarations },\n",
				replacement:
					'\t\t\t{ schema: declared.base, logins: Arr.filter(Rec.values(declared.logins), (l) => l.name !== "outsider"), declarations: noDeclarations },\n',
				why: "The stranger is left out of the drafted installation, as it was while the executor made it beside every installation: its served file compiled from the drafted snapshot is refused at its role (UninstalledRole, stranger), so the plan dies, as sixteen worlds suites did at REDS7's census."
			},
			{
				file: "test/support/worlds/execute/index.ts",
				original:
					"\treturn kept(first)\n\t\t? [first, ...Arr.filter([second, ...rest], kept)]\n\t\t: [second, ...Arr.filter(rest, kept)]\n",
				replacement: "\treturn [first, second, ...rest]\n",
				why: "An open beside a role's own login is handed that login's layer too, so Db.open opens a Db of the role where the model refuses it at role."
			}
		]
	})
