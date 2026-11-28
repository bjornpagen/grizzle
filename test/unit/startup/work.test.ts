/**
 * Startup work, counted and never timed, so no verdict depends on the machine: the calls a schema's build and every
 * command and layer over it make to the schema's encoding and to its compilation, read off V8's call counts
 * (test/support/kernel/calls.ts).
 *
 * - A schema value's content is read once, when schema(...) builds it (schema/levels.ts levelContent, its relations'
 *   descriptions by name, compared by structure); roles, workloads and the login over it, and every level check they
 *   and every command and layer make, read it again never from a description (contentOfDesc).
 * - Each statement's canonical text is read once, where the statement is built (schema/statements.ts), and carried in
 *   the level's content: schema(...) reads none. A schema value is owned once per process, its Owned held by the value
 *   from its first read (schema/schema.ts builtContent): `grizzle generate` owns it, reading the texts its content
 *   carries (schema/own.ts ownBuilt), none again, and hashes each level's fingerprint (core/fingerprint.ts
 *   schemaFingerprint), the snapshot's encoding of it; `grizzle check` after it in the same process owns and hashes
 *   nothing more. No level check or program they compile reads a description's text (descText). generate and check
 *   compile the installation's basis once (its law model and closed
 *   constants, physical/install/plan.ts installBasis), packing every closed relation's cells once
 *   (physical/ddl/constants.ts planClosed), plan the installation three times over it (commandPlans), and build the
 *   draft's DDL once; then they compile each login's programs once, into its served file (adapter/served/compile.ts
 *   compileServed), over the installation's artifacts they already built, with no law model, plan basis or plan of the
 *   login's own, and its roles' programs from the change compile and the read compile the workload's plan holds
 *   (adapter/served/login.ts plannedLoginRoles), building no DDL: each read program is compiled once on each role it
 *   runs on (program/template.ts templateFor), its plans and its served form read off that one compile.
 * - DbLayer.make over the login's served file, the one generate wrote, loads it and owns, hashes, compiles and plans
 *   nothing (adapter/pool/served.ts): every count of the layer is zero.
 * - `grizzle migrate` and `grizzle drift` compile nothing before they connect: they reach the connection
 *   (openMigrationSession) without owning the schema, compiling its basis or a login's programs.
 * - No closed cell is held to its field's base type again where the schema compiles: closed.relation() admitted each
 *   once (ir/desc.ts AdmittedClosedRelation), so the compile's calls of the base check (ir/expr.ts literalProblem) are
 *   as many at twice the closed rows as at the rows.
 * - Every count grows at most linearly in each dimension of the schema and its worlds: relations, closed rows, roles and
 *   workload programs (test/support/growth.ts incrementsDoNotGrow, at 2, 4 and 6), where a count that grows faster
 *   than linearly adds more at every step. No count changes shape above some size of a dimension: every relation,
 *   closed row, role and program of a size is one more of the same.
 *
 * The oracle is the specification: the counts above, each stated by the module it names, and the linear law. The box
 * is exhausted: every dimension at 2, 4 and 6, every other at its least. Features: every dimension.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect } from "effect"
import { incrementsDoNotGrow } from "#test/support/growth.ts"
import {
	type Dimension,
	dimensions,
	exactly,
	pointGen,
	readCompilesAt,
	siteNames,
	sizeOf,
	stepNames,
	type Steps,
	stepsAt
} from "#test/unit/startup/work.fixtures.ts"

/** Startup work reads a schema's content once, compiles it once per command, nothing for migrate, drift or the served layer, and grows linearly. */
export const startupWorkReadsASchemasContentOnceCompilesItOncePerCommandNothingForMigrateDriftOrTheServedLayerAndGrowsLinearly =
	property.exhaust(finite(pointGen), {
		needs: { dir: Scratch.dir },
		situations: dimensions satisfies ReadonlyArray<Reached<Dimension>>,
		check: (resources, c: Case<Dimension>) => (point) =>
			Effect.gen(function* () {
				const dir = yield* resources.dir
				c.note(point.dimension)
				const sizes = [2 * point.half, 4 * point.half, 6 * point.half] as const
				const measured = yield* Effect.forEach(sizes, (n) =>
					stepsAt(dir)(sizeOf(point.dimension, n))
				)
				const bySize = new Map(
					Arr.map(measured, (steps, i) => [2 * point.half * (i + 1), steps] as const)
				)
				const stepsOf = (n: number): Steps => defined(bySize.get(n), `the steps at ${n}`)
				const [first] = measured
				const at = `${point.dimension} at ${Arr.join(Arr.map(sizes, String), ", ")}`
				for (const [n, steps] of Arr.zip(sizes, measured)) {
					const reads = readCompilesAt(sizeOf(point.dimension, n))
					for (const step of stepNames) {
						assert.equal(
							steps[step].readCompile,
							reads[step],
							`${at}: ${step} compiles each read program once on its role`
						)
					}
				}
				for (const step of stepNames) {
					for (const site of siteNames) {
						const want = exactly[step][site]
						for (const steps of measured) {
							if (want !== undefined) {
								assert.equal(steps[step][site], want, `${at}: ${step} calls ${site}`)
							}
						}
						incrementsDoNotGrow(
							(n) => stepsOf(n)[step][site],
							point.half,
							`${at}: ${step}'s calls of ${site}`
						)
					}
				}
				if (point.dimension === "closed rows") {
					for (const step of ["generate", "check", "layer"] as const) {
						for (const steps of measured) {
							assert.equal(
								steps[step].literalProblem,
								first[step].literalProblem,
								`${at}: ${step} holds no closed cell to its base type again`
							)
						}
					}
				}
				for (const steps of measured) {
					for (const step of ["generate", "check", "layer"] as const) {
						assert.equal(
							steps[step].descText,
							steps.schema.descText,
							`${at}: ${step} reads no statement's text its statements carry from their build, as schema(...) reads none, and no description's text beside`
						)
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "each step's counts as its modules state them, and no count whose second step adds more than its first"
		},
		box: "every dimension of the schema and its worlds at 2, 4 and 6, every other at its least",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/install/plan.ts",
				original:
					'\tResult.flatMap(levelLaws(owned, served, { kind: "planned" }, { kind: "analyzed" }), (model) =>\n',
				replacement:
					'\tResult.flatMap(\n\t\tResult.flatMap(levelLaws(owned, served, { kind: "planned" }, { kind: "analyzed" }), () =>\n\t\t\tlevelLaws(owned, served, { kind: "planned" }, { kind: "analyzed" })\n\t\t),\n\t\t(model) =>\n',
				why: "The installation basis compiles its law model twice."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: "\t\tfingerprint: unwrap(schemaFingerprint(descIdentities, level))\n",
				replacement:
					"\t\tfingerprint: unwrap(\n\t\t\tResult.flatMap(schemaFingerprint(descIdentities, level), () => schemaFingerprint(descIdentities, level))\n\t\t)\n",
				why: "generate and check hash each level's fingerprint twice; the count of fingerprints fails."
			},
			{
				file: "packages/engine/src/schema/schema.ts",
				original:
					"\t\towned: once(() => ownBuilt({ desc: admitted.desc, content: admitted.content })),\n",
				replacement:
					"\t\towned: () => ownBuilt({ desc: admitted.desc, content: admitted.content }),\n",
				why: "A schema value holds no Owned, so check owns it again after generate; check's count of owns fails."
			},
			{
				file: "packages/grizzle/src/adapter/served/compile.ts",
				original:
					"\t\tplannedLoginRoles(login.login, changes, reads, artifacts, lawsAbove(served), clock, resolve),\n",
				replacement:
					"\t\tEffect.flatMap(loginReadsOver(login.login, changes, clock), (again) =>\n\t\t\tplannedLoginRoles(login.login, changes, again, artifacts, lawsAbove(served), clock, resolve)\n\t\t),\n",
				why: "Each login's served file compiles its reads again where the workload plan compiled them (a09f5f8376's served compile); generate's and check's counts of read compiles fail."
			},
			{
				file: "packages/grizzle/src/cli/generate.ts",
				original: "\t\t\treturn Effect.succeed(servedArtifacts)",
				replacement:
					'\t\t\treturn Effect.mapError(fromEngine(artifactsOver(basis, params)), refusedAt("workload"))',
				why: "generate plans each login's served artifacts again over the basis at the configured level, where it reuses the installation's (cli/generate.ts plannedLogins); the count of plans fails."
			}
		]
	})
