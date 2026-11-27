import type { Content } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, type Option, type Scope } from "effect"
import type { AmbientSession } from "#test/support/ambient.ts"
import {
	appliedGenerated,
	type Installed,
	templateGenerated
} from "#test/support/install-migrate.ts"
import type { SqlError } from "#test/support/pg.ts"
import {
	installTemplate,
	Substrate,
	type SubstrateCase,
	type SubstrateTemplate
} from "#test/support/substrate/substrate.ts"
import {
	draftedWorld,
	type RacingWorld,
	realizeInstalled,
	type WorldPlan,
	worldPlanOf
} from "#test/support/worlds/execute/index.ts"
import type { RealizeRefused } from "#test/support/worlds/execute/refused.ts"
import type { InstallSpec } from "#test/support/worlds/model/types.ts"

/**
 * What a case over a clone of a world's template binds: the installation as the clone holds it (install-migrate.ts
 * templateInstalled), and the world planned under the template's names (WorldPlan), which every worker plans once.
 */
export interface TemplateWorld {
	readonly installed: Installed
	readonly plan: WorldPlan
}

/**
 * A fixed installation's world as a template (substrate.ts installTemplate), the per-case realization (execute/index.ts
 * realizeWith) split where it touches the database: `plan` builds the installation under the template's names
 * (build.ts buildInstall), drafts its first migration with its logins as `grizzle generate` drafts it
 * (install-migrate.ts generatedDraft) and plans the world under them (worldPlanOf), pure, in the build and once in
 * every worker; `install` applies that migration once per member as installGenerated applies it (appliedGenerated), as
 * the template's owner login under `ambient`, every login and the decoder login of the served files given the
 * password the template derives; and a case binds its clone's installation (templateGenerated) beside the plan, so
 * what it realizes per case is its layers and sessions alone (realizeInstalled). Its identity is the declaring module's
 * import closure, `name` and the ambient session: `install` is a value of that module's closure.
 */
export const worldTemplate = (spec: {
	readonly declaredIn: ImportMeta
	readonly name: string
	readonly install: InstallSpec
	readonly ambient: AmbientSession
	readonly budget: number
}): SubstrateTemplate<TemplateWorld> => {
	const content: Content = {
		worlds: spec.name,
		path: spec.ambient.path.kind,
		settings: Arr.map(spec.ambient.settings, (s) => [s.parameter, s.value])
	}
	return installTemplate({
		declaredIn: spec.declaredIn,
		name: spec.name,
		content,
		budget: spec.budget,
		plan: (names) =>
			Effect.gen(function* () {
				const drafted = yield* draftedWorld(spec.install, names.schema)
				const world = yield* worldPlanOf(spec.install, {
					declared: names.schema,
					plan: drafted.plan,
					snapshot: drafted.snapshot
				})
				return { names, drafted, world }
			}),
		install: ({ names, drafted }) =>
			Effect.asVoid(
				appliedGenerated([drafted], names.schema, spec.ambient, (fresh) =>
					Effect.map(Effect.orDie(draftedWorld(spec.install, fresh)), (again) => again.plan)
				)
			),
		bind: ({ names, drafted, world }, binding) => ({
			installed: templateGenerated(names, [drafted], spec.ambient, binding).installed,
			plan: world
		})
	})
}

/**
 * The world of a case over a clone of a world's template (worldTemplate), in the case's substrate over the clone,
 * every login's pool `poolSize` connections at most, or the cluster pool's.
 */
export const templateWorld = (
	taken: SubstrateCase<TemplateWorld>,
	poolSize: Option.Option<number>
): Effect.Effect<RacingWorld, RealizeRefused | SqlError, Scope.Scope> =>
	Effect.provideService(
		realizeInstalled(taken.value.plan, taken.value.installed, poolSize),
		Substrate,
		taken.substrate
	)
