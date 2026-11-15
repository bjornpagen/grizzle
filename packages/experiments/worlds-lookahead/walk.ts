/**
 * The worlds look-ahead walk (README.md): over `walks` walks drawn from one fixed stream, each from a drawn installation
 * of the documents bases (a fixed one or a generated one), a lawful reality and swarm weights, it writes one line per
 * state for each box (enumerateActions under the box's scope and the aim scope) and one per action the aim scope offers,
 * its features over every branch the model allows it in their order (features.ts reachOf), each line its kind, its
 * place and the SHA-256 of what it read.
 */
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { element, int } from "@bjornpagen/testing/gen"
import { floorSeed } from "@bjornpagen/testing/random"
import { sample, type Source } from "@bjornpagen/testing/source"
import { Formatter } from "effect"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import { reachOf } from "#test/support/worlds/features.ts"
import { actionGen } from "#test/support/worlds/generate/action.ts"
import { defaultScope, enumerateActions } from "#test/support/worlds/generate/enumerate.ts"
import { installGen } from "#test/support/worlds/generate/install.ts"
import { realityGen } from "#test/support/worlds/generate/reality.ts"
import { weightsGen } from "#test/support/worlds/generate/weights.ts"
import {
	docsBases,
	docsEditorInstall,
	docsInstall,
	docsLevelInstall,
	docsOneShareInstall,
	docsProfileInstall
} from "#test/support/worlds/model/bases/docs.ts"
import { hostSchemaOf } from "#test/support/worlds/model/host.ts"
import { initialState, settle, step } from "#test/support/worlds/model/step.ts"
import type { InstallSpec, SmallScope } from "#test/support/worlds/model/types.ts"

const [out = "/dev/stdout", walksText = "150"] = process.argv.slice(2)

/** The aim scope the worlds suites aim through (drive/suite.ts aimScope): the box's, with two contexts. */
const aimScope: SmallScope = { ...defaultScope, contexts: 2 }

const fixed: readonly [InstallSpec, ...ReadonlyArray<InstallSpec>] = [
	docsInstall,
	docsOneShareInstall,
	docsLevelInstall,
	docsEditorInstall,
	docsProfileInstall
]

const digest = (text: string): string => createHash("sha256").update(text).digest("hex")

/** One walk's lines: up to six steps, each state's two boxes and every aimed action's reached features. */
const walk = (source: Source): ReadonlyArray<string> => {
	const generated = source.draw(int(0, 1)) === 1
	const install = generated
		? source.draw(installGen(source.draw(element(docsBases))))
		: source.draw(element(fixed))
	const names = installedNames(install)
	const reality = source.draw(realityGen(install.base, hostSchemaOf(install.base, names)))
	const weights = source.draw(weightsGen)
	const steps = source.draw(int(0, 6))
	const lines: Array<string> = []
	let state = initialState(install, names, reality)
	for (let at = 0; at <= steps; at++) {
		lines.push(`box ${at} ${digest(Formatter.format(enumerateActions(state, defaultScope)))}`)
		const aimed = enumerateActions(state, aimScope)
		lines.push(`aim-box ${at} ${aimed.length} ${digest(Formatter.format(aimed))}`)
		for (const action of aimed) {
			lines.push(
				`reach ${at} ${action.kind} ${digest(`${Formatter.format(action)} -> ${reachOf(state, action).join(" | ")}`)}`
			)
		}
		if (at < steps) {
			const action = source.draw(actionGen(state, weights))
			state = settle(source.draw(element(step(state, action))), installedNames).next
		}
	}
	return lines
}

const started = performance.now()
const walks = sample(walk, floorSeed("worlds-lookahead"), Number(walksText))
const written = walks.flatMap((read, w) => read.map((line) => `${w} ${line}`))
writeFileSync(out, `${written.join("\n")}\n`)
process.stderr.write(
	`${walks.length} walks, ${written.filter((l) => l.includes(" box ")).length} states, ${written.filter((l) => l.includes(" reach ")).length} aimed actions read in ${((performance.now() - started) / 1000).toFixed(1)} s\n`
)
