import type { Content } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, type Option, Record as Rec, type Scope } from "effect"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import type { AmbientSession } from "#test/support/ambient.ts"
import {
	appliedHistory,
	draftedHistory,
	type Installed,
	noPlaceholders,
	noVersionWorkload,
	templateInstalled
} from "#test/support/install-migrate.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { SqlError } from "#test/support/pg.ts"
import {
	installTemplate,
	Substrate,
	type SubstrateCase,
	type SubstrateTemplate
} from "#test/support/substrate/substrate.ts"
import { baseBuild } from "#test/support/worlds/execute/build.ts"
import {
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
 * realizeWith) split where it touches the database: `plan` drafts the installation's first migration under the
 * template's names (install-migrate.ts draftedHistory) and plans the world under them (worldPlanOf), pure, in the
 * build and once in every worker; `install` applies that migration once per member as installMigrated applies it, as
 * the template's owner login under `ambient`, every login and the decoder login of the served files given the
 * password the template derives; and a case binds its clone's installation (templateInstalled) beside the plan, so
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
	const options = {
		label: "worlds",
		extensions: [],
		ambient: spec.ambient,
		compile: compileInstallation,
		review: noPlaceholders
	}
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
				const declared = yield* baseBuild(spec.install)
				const history = yield* draftedHistory(
					[
						{
							version: {
								schema: declared.base,
								logins: Rec.values(declared.logins),
								declarations: noDeclarations
							},
							workload: noVersionWorkload
						}
					],
					options,
					names.schema
				)
				const last = Arr.lastNonEmpty(history)
				const world = yield* worldPlanOf(spec.install, {
					declared: names.schema,
					plan: last.plan,
					snapshot: last.snapshot
				})
				return { names, history, world }
			}),
		install: ({ names, history, world }) =>
			Effect.asVoid(appliedHistory(history, names.schema, options, world.first.files)),
		bind: ({ names, history, world }, binding) => ({
			installed: templateInstalled(names, history, spec.ambient, world.first.files, binding),
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
