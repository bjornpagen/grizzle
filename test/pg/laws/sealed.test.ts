/**
 * A sealed unit's seal (physical/ddl/seal.ts): every row of every relation under the unit at its key is inserted by one
 * transaction, the one that inserts the first of them there and so founds the unit at the key, whatever order it
 * inserts in, inside and after a savepoint, after SET CONSTRAINTS ALL IMMEDIATE, at READ COMMITTED as at SERIALIZABLE.
 * Over the sealed unit Sheet (sealed.fixtures.ts) over Sheet and Cover, each keyed by the unit's key alone, and Cell and
 * Note, wider, every one closed, and its unsealed twin, each installed as `grizzle generate` drafts it with a login whose
 * writer certification runs READ COMMITTED, so no table takes the SERIALIZABLE guard: a case runs up to four
 * transactions in turn on both, each of up to five steps at two sheets, a row of one of the four inserted, a savepoint
 * around such inserts released or rolled back, and SET CONSTRAINTS ALL IMMEDIATE; or a founding transaction aimed at
 * each situation and a later transaction's row at its sheet.
 *
 * Oracle: specification, the seal's meaning turned into a model (sealed.fixtures.ts modelOf): a row at a sheet a
 * committed transaction founded is refused at its statement, the first row at a sheet no transaction founded founds it,
 * a rolled-back savepoint takes its rows and their foundings, and a relation keyed by the unit's key alone refuses a
 * second row at a sheet by its key. PostgreSQL commits exactly where the model does and refuses at its statement, a
 * seal's refusal under 23503 naming the refused row's table and a constraint the installation's constraint map maps to
 * Sheet's seal law, and the unsealed twin commits every row its keys admit.
 *
 * Features: a founding transaction's rows committed, two rows keyed by the unit's key alone among them, after a
 * savepoint that founded the unit, after one that rolled its founding back, and after SET CONSTRAINTS ALL IMMEDIATE; a
 * later transaction's row refused, one keyed by the unit's key alone among them; each at READ COMMITTED; and a row the
 * seal refused committed by the unsealed twin.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	openTemplate,
	runSealed,
	type SealedFeature,
	sealedTemplate,
	space
} from "#test/pg/laws/sealed.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A sealed unit's rows at a key are inserted by the transaction that founded the unit there and by no other, which its
 * seal refuses under the unit's seal law, where the unsealed twin admits them.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aSealedUnitsRowsAtAKeyAreInsertedOnlyByTheTransactionThatFoundedItThere =
	property.explore(space, {
		needs: { sealed: Substrate.fresh(sealedTemplate), open: Substrate.fresh(openTemplate) },
		situations: [
			"a founding transaction's rows committed",
			"two rows keyed by the unit's key alone committed by their founding transaction",
			"a row after a savepoint that founded its unit committed",
			"a row after a savepoint that rolled its founding back committed",
			"a row after SET CONSTRAINTS ALL IMMEDIATE committed",
			"a row of a unit an earlier transaction founded refused",
			"a row keyed by the unit's key alone refused in a later transaction",
			"committed at READ COMMITTED",
			"refused at READ COMMITTED",
			"the unsealed twin committed a row the seal refused"
		] satisfies ReadonlyArray<Reached<SealedFeature>>,
		check:
			({ sealed, open }, c) =>
			(schedule) =>
				Effect.gen(function* () {
					const s = yield* sealed
					const o = yield* open
					const sealedSession = yield* s.substrate.session({ ...ownerSession(), label: "sealed" })
					const openSession = yield* o.substrate.session({ ...ownerSession(), label: "open" })
					yield* runSealed(
						s.value.installed,
						sealedSession,
						o.value.installed,
						openSession,
						schedule,
						c
					)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "specification",
			name: "the seal's meaning: a row at a key committed exactly where no other transaction founded the unit there, refused at its statement otherwise under 23503 and the unit's seal law, a rolled-back savepoint taking its foundings; the unsealed twin committing what its keys admit"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/seal.ts",
				original: "\t\t\t\t\tcondition: foreign,",
				replacement: "\t\t\t\t\tcondition: lit.bool(false),",
				why: "The seal guard's check is dropped, so it always passes: a later transaction's row at a unit an earlier one founded commits, as the unsealed twin's does."
			}
		]
	})
