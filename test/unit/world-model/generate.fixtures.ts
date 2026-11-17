/** What the properties of generate.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record } from "effect"
import { educationInstall } from "#test/support/fixtures/education/index.ts"
import { valueText } from "#test/support/laws/model.ts"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import { knownNonEmpty, pool } from "#test/support/worlds/generate/domain.ts"
import {
	defaultScope,
	enumerateRealities,
	stateValues
} from "#test/support/worlds/generate/enumerate.ts"
import {
	docsBase,
	docsInstall,
	docsOneShareInstall
} from "#test/support/worlds/model/bases/docs.ts"
import { initialState } from "#test/support/worlds/model/step.ts"
import type {
	Action,
	BaseSpec,
	FieldDomain,
	HostState,
	InstallSpec,
	InstalledNames,
	ModelState
} from "#test/support/worlds/model/types.ts"

/** A reading's units: an int4 contract of 0 to 100, so a fact or a claim can hold a value its DOMAIN refuses. */
const units: FieldDomain = { kind: "contract", name: "Units", bits: 32, min: 0, max: 100 }

/**
 * A base whose session reads integers: a clock's `now` (an int8, from the payload's top level) and a quota's `units`
 * (an int4 contract, from the claim object `q`), so tokens can carry integer claims, unsafe or not digits, and facts a
 * contract's bounds refuse. Its role `alpha` writes readings stamped with the clock's time, and ticks, two identity
 * numbers and the clock's time, through an entry whose every carried field is serial, its time filled from the clock;
 * `beta` writes ticks through an entry that carries the time and filters on `seq`, a serial field its filter reads,
 * since a role writes a relation through one entry at most.
 */
const meterBase: BaseSpec = {
	name: "Meter",
	closed: [],
	relations: [
		{
			name: "Reading",
			fields: [
				{ name: "id", domain: { kind: "uuid" } },
				{ name: "at", domain: { kind: "integer", bits: 64 } },
				{ name: "units", domain: units }
			],
			key: ["id"],
			mutability: "immutable"
		},
		{
			name: "Tick",
			fields: [
				{ name: "no", domain: { kind: "serial", bits: 64 } },
				{ name: "seq", domain: { kind: "serial", bits: 32 } },
				{ name: "at", domain: { kind: "integer", bits: 64 } }
			],
			key: ["no"],
			mutability: "immutable"
		}
	],
	laws: [],
	contexts: [
		{
			name: "Clock",
			claim: { kind: "top-level" },
			fields: [{ name: "now", domain: { kind: "integer", bits: 64 } }]
		},
		{
			name: "Quota",
			claim: { kind: "object", key: "q" },
			fields: [{ name: "units", domain: units }]
		}
	],
	derived: []
}

const meterInstall: InstallSpec = {
	base: meterBase,
	roles: [
		{
			name: "alpha",
			entries: {
				Reading: {
					kind: "query",
					rules: [
						{
							matches: [
								{
									source: { kind: "ordinary", name: "Reading" },
									fields: {
										id: { kind: "var", name: "id" },
										at: { kind: "context", context: "Clock", field: "now" },
										units: { kind: "var", name: "units" }
									}
								},
								{
									source: { kind: "context", name: "Quota" },
									fields: { units: { kind: "var", name: "units" } }
								}
							],
							negations: [],
							comparisons: [],
							head: { id: { kind: "var", name: "id" }, units: { kind: "var", name: "units" } }
						}
					]
				},
				Tick: {
					kind: "query",
					rules: [
						{
							matches: [
								{
									source: { kind: "ordinary", name: "Tick" },
									fields: {
										no: { kind: "var", name: "no" },
										seq: { kind: "var", name: "seq" },
										at: { kind: "context", context: "Clock", field: "now" }
									}
								}
							],
							negations: [],
							comparisons: [],
							head: { no: { kind: "var", name: "no" }, seq: { kind: "var", name: "seq" } }
						}
					]
				}
			},
			write: ["Reading", "Tick"],
			refresh: []
		},
		{
			name: "beta",
			entries: {
				LateTick: {
					kind: "query",
					rules: [
						{
							matches: [
								{
									source: { kind: "ordinary", name: "Tick" },
									fields: {
										no: { kind: "var", name: "no" },
										seq: { kind: "var", name: "seq" },
										at: { kind: "var", name: "at" }
									}
								}
							],
							negations: [],
							comparisons: [
								{
									left: { kind: "var", name: "seq" },
									op: ">=",
									right: { kind: "literal", value: 1 }
								}
							],
							head: {
								no: { kind: "var", name: "no" },
								seq: { kind: "var", name: "seq" },
								at: { kind: "var", name: "at" }
							}
						}
					]
				}
			},
			write: ["LateTick"],
			refresh: []
		}
	],
	logins: [{ name: "web", roles: ["alpha", "beta"] }]
}

/**
 * The names the compiler gives a base's relations and laws: those of an installation of the base whose one role holds
 * its first relation whole, all the host law model reads of a model state's names.
 */
const baseNames = (base: BaseSpec): InstalledNames => {
	const [first] = base.relations
	return installedNames({
		base,
		roles: [
			{
				name: "alpha",
				entries: { [first.name]: { kind: "whole", relation: first.name } },
				write: [],
				refresh: []
			}
		],
		logins: [{ name: "web", roles: ["alpha"] }]
	})
}

/** The installations the generators are tried over, with the names their base's compilation gives them. */
const fixtures: Arr.NonEmptyReadonlyArray<{
	readonly install: InstallSpec
	readonly state: ModelState
}> = knownNonEmpty(
	Arr.map([docsInstall, docsOneShareInstall, educationInstall, meterInstall], (install) => ({
		install,
		state: initialState(install, baseNames(install.base), new Map())
	})),
	"the fixtures"
)

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

export const docs = Arr.headNonEmpty(fixtures)

const realities: Arr.NonEmptyReadonlyArray<HostState> = knownNonEmpty(
	enumerateRealities(docsBase, docs.state.host, defaultScope),
	"the box's realities"
)

/** A reality of the box, and how many steps to take from it. */
export const boxGen: Gen<{ readonly reality: HostState; readonly steps: number }> = (source) => ({
	reality: source.draw(element(realities)),
	steps: source.draw(int(0, 3))
})
