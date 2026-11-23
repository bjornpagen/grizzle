import { Effect } from "effect"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { templateNeedBudget } from "#test/support/budgets.ts"
import { installationSql } from "#test/support/compile.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { SubstrateWorld } from "#test/support/substrate/session.ts"
import {
	installTemplate,
	Substrate,
	type SubstrateTemplate
} from "#test/support/substrate/substrate.ts"
import { oracleWorld, templateOracleWorld } from "#test/support/worlds.ts"

/**
 * An installation the fresh-install compiler compiled under a schema name, its script run as the owner (compile.ts
 * installationSql), and the one world of its oracle login (worlds.ts oracleWorld): what a case over a clone of a
 * script template reads (scriptTemplate).
 */
export interface ScriptInstall {
	readonly schema: string
	readonly installation: Installation
	readonly world: SubstrateWorld
}

/** A script template's spec: what tells it from its module's other templates, and its installation's compile. */
interface ScriptSpec {
	readonly declaredIn: ImportMeta
	readonly name: string
	readonly label: string
	/** The installation under the template's schema name `schema`: pure, planned once per worker. */
	readonly compile: (schema: string) => Installation
}

/**
 * An installation's script as a template (substrate.ts installTemplate): compiled under the template's schema name by
 * every worker as it plans (`compile`), its script run as the owner once per member in one transaction and its oracle
 * login given its password, where a suite ran it in every case; each case's ScriptInstall the installation in its
 * clone, its world logging in with the password the template derived (worlds.ts templateOracleWorld).
 */
export const scriptTemplate = (spec: ScriptSpec): SubstrateTemplate<ScriptInstall> =>
	installTemplate({
		budget: templateNeedBudget,
		declaredIn: spec.declaredIn,
		name: spec.name,
		content: { label: spec.label },
		plan: (names) =>
			Effect.sync(() => ({
				schema: names.schema,
				installation: spec.compile(names.schema)
			})),
		install: ({ installation }) =>
			Effect.gen(function* () {
				const s = yield* Substrate
				yield* transaction(s.admin, installationSql(installation, s.database))
				yield* oracleWorld(installation)
			}),
		bind: ({ schema, installation }, binding) => ({
			schema,
			installation,
			world: templateOracleWorld(installation, binding)
		})
	})
