/**
 * The roster and closed objects an installation holds (physical/ddl/constants.ts), over generated worlds: rosters with
 * holes and growth drawn by construction (test/support/closed/generate.ts), a relation typed by every roster's closed
 * id and by a set over some of them, a closed relation keyed by a roster, and roles that read or write it.
 *
 * - **A roster's domain admits exactly its live codes:** one CREATE DOMAIN over smallint per roster, whose CHECKs,
 *   evaluated on the host by an interpreter written here, admit exactly the live codes among -1 to one past every code
 *   minted, and never 400, the mixed-radix alias a former encoding admitted.
 * - **A set's domain admits exactly sets of live codes:** a bits domain exactly where a set is typed over the roster,
 *   over bit(n), n every code minted rounded up to whole hex digits, whose CHECKs, evaluated likewise, admit the empty
 *   set, each live code alone, every live code together, and no set holding a hole's or a padding position.
 * - **The names constant is the codes:** a names constant of the installation, which a view's decoded column reads, its `'{…}'::name[]`
 *   literal read back by an array-literal reader written here (PostgreSQL's array_in rules: double-quoted elements,
 *   backslash escapes), is the roster's names in code order, a hole the empty name, every awkward handle (`NULL`, a
 *   comma, a quote, a backslash, braces, spaces, 63 bytes) intact.
 * - **Names are content (metamorphic):** two installations whose codes are equal name every constant alike whatever
 *   else differs; a roster that loses a handle to a hole reads other names, from a constant named anew.
 * - **The EXECUTE rule, as a checker over the installed AST:** every role is granted EXECUTE on every function a
 *   statement it runs calls, through function bodies: the CHECK of each domain a field it holds is typed by, stated
 *   from the world's facts, the CREATE TABLE of each table it writes, each of its views, and each closed relation's
 *   constants, which its queries read; and on no other function of the installation's constants. (test/unit/physical/executes.test.ts states the rule over worlds
 *   of contracts and laws, which hold no closed relation; this file's closed relation keeps that clause judged.)
 * - **Decoded columns:** every closed-id column of every role view is followed by exactly one `<field>_name`
 *   column; a set has none.
 *
 * Oracles: the codes model's codec (codebookFor) for the names and live codes; a host interpreter of the domains'
 * CHECKs and an array-literal reader, sharing no code with the installer; the EXECUTE rule restated over the
 * statements, sharing no code with the installer's call tracking.
 *
 * Features: a roster with a hole, one a set is typed over, one with an awkward handle; a closed relation with an open
 * payload and one with a closed payload.
 */

import { assert, deepEquals, defined } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { setText, setWidth } from "#test/support/closed/bit-text.ts"
import { codebookOfStates, codecFor } from "#test/support/closed/generate.ts"
import { owning } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	admits,
	closedConstants,
	codeField,
	constantsOf,
	type CreateDomainStatement,
	features,
	grantsOf,
	installationOf,
	noteWorld,
	requiredExecutes,
	rosterObjects,
	schemaOf,
	setField,
	states,
	withHole,
	worldGen
} from "#test/unit/physical/constants.fixtures.ts"

/** Roster and closed constants domains that admit exactly the live codes, names that are content, EXECUTE by rule, decoded view columns. Its budget is its suite's before it was a property (test/unit/physical/constants.test.ts at 4ca3036a): 120 runs and 120 steered cases. */
export const rosterAndClosedConstantsDomainsThatAdmitExactlyTheLiveCodesNamesThatAreContentEXECUTEByRuleDecodedViewColumns =
	property.explore(worldGen, {
		needs: {},
		budget: { runs: 120, steered: 120 },
		situations: features,
		check: (_2, c) => (w) =>
			Effect.sync(() => {
				noteWorld(w, c)
				const owned = owning(schemaOf(w))
				const codes = codebookOfStates(states(w))
				const i = installationOf(owned, codes)
				const schema = i.names.schema
				const constants = constantsOf(i)

				for (const [at, s] of states(w).entries()) {
					const { names, live: liveRead, admitted } = rosterObjects(i, s)
					const live = Arr.flatMap(s.slots, (slot, code) => (slot.kind === "live" ? [code] : []))
					assert.deepEqual(
						admitted,
						live,
						`roster ${s.closed}'s domain admits exactly its live codes`
					)
					assert.equal(
						liveRead.size,
						1,
						`roster ${s.closed}'s domain reads one live-codes constant`
					)
					assert.ok(
						Arr.every([...liveRead.values()], (bits) => bits === setText(s.slots.length, live)),
						`roster ${s.closed}'s domain reads its live codes`
					)
					assert.ok(
						Arr.some([...names.values()], (read) => deepEquals(read, codecFor(s).names)),
						`a names constant holds roster ${s.closed}'s names in code order`
					)
					const bitsName = i.names.bitsDomain(s.closed).name
					const bits = Arr.filter(
						i.statements,
						(st): st is CreateDomainStatement =>
							st.kind === "createDomain" && st.name.name === bitsName
					)
					assert.equal(
						bits.length,
						w.sets[at] === true || at === 0 ? 1 : 0,
						"a bits domain exactly where a set is typed: Tags' over the first roster, Item's where drawn"
					)
					const width = setWidth(s.slots.length)
					for (const d of bits) {
						assert.ok(
							d.base.kind === "builtin" && d.base.name === "bit" && d.base.length === width,
							"bit(n), n every code minted rounded up to whole bytes"
						)
						const probes = [[], ...upTo(width, (code) => [code]), live, upTo(width, (i) => i)]
						for (const members of probes) {
							assert.equal(
								admits(
									d,
									{ kind: "bits", value: setText(s.slots.length, members) },
									constants,
									schema
								),
								Arr.every(members, (code) => Arr.contains(live, code)),
								`roster ${s.closed}'s bits domain admits exactly sets of its live codes: ${Formatter.format(members)}`
							)
						}
					}
				}

				const closedNames = closedConstants(i)
				for (const g of grantsOf(i)) {
					const need = requiredExecutes(i, w, g)
					for (const name of need) {
						assert.ok(g.execute.has(name), `${g.role} holds EXECUTE on ${name}, which it calls`)
					}
					for (const name of closedNames) {
						assert.ok(g.execute.has(name), `${g.role} holds EXECUTE on the closed constant ${name}`)
					}
					for (const name of g.execute) {
						assert.ok(
							!constants.has(name) || need.has(name) || closedNames.has(name),
							`${g.role}'s EXECUTE on ${name} has a reason`
						)
					}
				}

				const itemColumns = new Map<string, string>(
					Arr.map(states(w), (s, at) => [i.names.column("Item", codeField(at)), s.closed] as const)
				)
				for (const view of i.statements) {
					if (view.kind !== "createView" || view.name.schema === schema) {
						continue
					}
					for (const [at, column] of view.columns.entries()) {
						const roster = itemColumns.get(column)
						if (roster === undefined) {
							continue
						}
						const decoded = `${column}_name`
						assert.equal(view.columns[at + 1], decoded, `${column} is followed by its decoded name`)
						assert.equal(
							Arr.filter(view.columns, (c) => c === decoded).length,
							1,
							`one decoded column for ${column}`
						)
					}
					for (const set of Arr.filter(states(w), (_, at) => w.sets[at] === true)) {
						const column = i.names.column("Item", setField(states(w).indexOf(set)))
						assert.ok(!Arr.contains(view.columns, `${column}_name`), "a set has no decoded column")
					}
				}

				const again = installationOf(owning(schemaOf(w)), codes)
				assert.deepEqual(
					Arr.sort([...constantsOf(again).keys()], Order.String),
					Arr.sort([...constants.keys()], Order.String),
					"equal codes and content name every constant alike"
				)
				const holed = withHole(w)
				if (holed !== undefined) {
					const changed = installationOf(owning(holed.schema), holed.codes)
					const before = defined(states(w)[0])
					const was = rosterObjects(i, before).live
					const now = rosterObjects(changed, before).live
					assert.ok(
						Arr.every([...now.values()], (bits) =>
							Arr.every([...was.values()], (prior) => bits !== prior)
						),
						"a hole changes the live codes the domain's constant holds"
					)
					assert.ok(
						Arr.every([...now.keys()], (fn) => !was.has(fn)),
						"a hole names the live-codes constant anew"
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the codes model's codec, a host interpreter of the domains' CHECKs, and the EXECUTE rule"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/constants.ts",
				original: "\t\t\t\t\t\t\t\t\twhen: and([ge(value, int(0)), lt(value, int(codec.width))]),",
				replacement:
					"\t\t\t\t\t\t\t\t\twhen: and([ge(value, int(-1)), lt(value, int(codec.width))]),",
				why: "A roster's domain reads a bit below its live-codes constant: get_bit refuses code -1 with an error where the domain's CHECK refuses it."
			},
			{
				file: "packages/engine/src/physical/ddl/constants.ts",
				original: "\t\t\t\t\t\t\t\t\t\tint(1)\n",
				replacement: "\t\t\t\t\t\t\t\t\t\tint(0)\n",
				why: "A roster's domain admits a code whose live bit is 0: every hole and padding code is admitted and every live code refused."
			},
			{
				file: "packages/engine/src/ir/codes.ts",
				original: "\t\t}\n\t}",
				replacement:
					"\t\t}\n\t}\n\tfor (let code = codec.names.length; code < codec.width; code++) {\n\t\tsetBit(digits, code)\n\t}",
				why: "A roster's live constant sets its padding bits."
			}
		]
	})
