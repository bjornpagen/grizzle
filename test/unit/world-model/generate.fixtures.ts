/** What the properties of generate.test.ts read: its spaces, models and helpers. */

import { type Gen, int } from "@bjornpagen/testing/gen"
import type { Need } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, Record } from "effect"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { valueText } from "#test/support/laws/model.ts"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import { knownNonEmpty, pool } from "#test/support/worlds/generate/domain.ts"
import {
	defaultScope,
	enumerateRealities,
	stateValues
} from "#test/support/worlds/generate/enumerate.ts"
import { docsBase, docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import { initialState } from "#test/support/worlds/model/step.ts"
import {
	type Action,
	type BaseSpec,
	type HostState,
	type InstalledNames,
	installSpec,
	type ModelState
} from "#test/support/worlds/model/types.ts"

/**
 * The names the compiler gives a base's relations and laws: those of an installation of the base whose one role holds
 * its first relation whole, all the host law model reads of a model state's names.
 */
const baseNames = (base: BaseSpec): InstalledNames => {
	const [first] = base.relations
	return installedNames(
		installSpec({
			base,
			roles: [
				{
					name: "alpha",
					entries: { [first.name]: { kind: "whole", relation: first.name } },
					write: []
				}
			],
			logins: [{ name: "web", roles: ["alpha"] }]
		})
	)
}

/** Every uuid and text value of the pools: the values a renaming may move. */
const symmetricValues = (base: BaseSpec): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(
			[
				...Arr.flatMap(base.relations, (r) => r.fields),
				...Arr.flatMap(base.contexts, (x) => x.fields)
			],
			(f) =>
				f.domain.kind === "uuid" || f.domain.kind === "text"
					? Arr.map(pool(f.domain), valueText)
					: []
		)
	)

/** Every value a state holds, as text: what the box's symmetry keeps apart (enumerate.ts stateValues). */
const heldValues = (state: ModelState): ReadonlySet<string> =>
	new Set(Arr.map(stateValues(state), valueText))

/** A text as an atom: its length, a colon, the text. */
const atom = (text: string): string => `${text.length}:${text}`

const byKey = Order.mapInput(Order.String, (entry: readonly [string, unknown]) => entry[0])

/**
 * An action's canonical form with every uuid or text value the state does not hold renamed to one placeholder: equal
 * forms are one action up to renaming. Every value is a tag and a length-framed atom, a record's fields sorted by name
 * and an array's members kept in order, so the form is injective over an action's plain data, bigints included (a
 * migration's capacity bound).
 */
export const canonicalAction = (state: ModelState, action: Action): string => {
	const movable = symmetricValues(state.install.base)
	const held = heldValues(state)
	const form = (v: unknown): string => {
		switch (typeof v) {
			case "string":
				return movable.has(v) && !held.has(v) ? "u" : `s${atom(v)}`
			case "number":
				return `n${atom(String(v))}`
			case "bigint":
				return `i${atom(String(v))}`
			case "boolean":
				return v ? "t" : "f"
			case "undefined":
				return "z"
			case "object":
				if (v === null) {
					return "0"
				}
				return Arr.isArray(v)
					? `a${atom(Arr.join(Arr.map(v, form), ""))}`
					: `o${atom(
							Arr.join(
								Arr.map(Arr.sort(Record.toEntries(v), byKey), ([k, x]) => `${atom(k)}${form(x)}`),
								""
							)
						)}`
			case "symbol":
			case "function":
				throw new Error(`an action holds a ${typeof v}, which is no plain data`)
		}
	}
	return form(action)
}

/**
 * The box the generators are tried over: the docs installation's names, as its base's compilation gives them, and every
 * reality of the box over its host schema.
 */
type Box = Readonly<{
	names: InstalledNames
	realities: Arr.NonEmptyReadonlyArray<HostState>
}>

/**
 * The box, built once per worker, when the worker readies the property (the need's open, outside every case's
 * deadline), never when the module loads: enumerating the box's realities takes seconds (4.8 s on cassowary, against
 * 0.4 s for the docs installation's names), and the runner's parent imports every test module and runs none of its
 * cases. A case draws its reality from them, the first draw of its check, after the steps its space drew.
 */
export const box: Need<Box> = {
	key: "test/unit/world-model/generate.fixtures.ts box",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.sync(() => {
		const docs = initialState(docsInstall, baseNames(docsBase), new Map())
		return Effect.succeed({
			names: docs.names,
			realities: knownNonEmpty(
				enumerateRealities(docsBase, docs.host, defaultScope),
				"the box's realities"
			)
		})
	})
}

/** How many steps a case takes from the reality it draws. */
export const stepsGen: Gen<number> = int(0, 3)
