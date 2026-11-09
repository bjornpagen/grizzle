import {
	type Case,
	drawn,
	type Explored,
	explore,
	type Kept,
	type Run,
	type SearchFailure
} from "@grizzle/testing/explore"
import type { Coverage } from "@grizzle/testing/features"
import { array, element, type Gen } from "@grizzle/testing/gen"
import { boundedShrink } from "@grizzle/testing/shrink"
import { forcedChooser, generate } from "@grizzle/testing/source"
import { tokenOf, valuesFromToken } from "@grizzle/testing/tape"
import { Array as Arr, Cause, Effect, Formatter, Option, type Scope } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { type AmbientSession, ambientFeatures, ambientSessionGen } from "#test/support/ambient.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	CurrentRestorage,
	type Restorage,
	restorageGen
} from "#test/support/oracle/gen/restorage.ts"
import {
	CurrentPerturbation,
	isPerturbed,
	type Perturbation,
	perturbationGen,
	printPerturbation
} from "#test/support/oracle/perturb.ts"
import { plantedArms, type WChangeSet } from "#test/support/oracle/write/changeset.ts"
import {
	CaseFailed,
	drawnCase,
	type PlantedCases,
	plantedCase,
	plantedCasesGen,
	type ResolvedCase,
	runCase,
	type WriteCase,
	type WriteOracleFeature,
	writeCaseGen
} from "#test/support/oracle/write/harness.ts"
import { openTarget, privilegeProblems, type Statistics } from "#test/support/oracle/write/run.ts"
import {
	printSchema,
	relationIn,
	resolveSchema,
	type SchemaSketch,
	schemaSketchGen,
	type WGroup,
	type WSchema
} from "#test/support/oracle/write/schema.ts"
import type { Substrate } from "#test/support/substrate/substrate.ts"

export interface WriteRun {
	readonly schema: SchemaSketch
	readonly statistics: Statistics
	/** The defaults the run's installation's owner sessions start under (test/support/ambient.ts). */
	readonly ambient: AmbientSession
	readonly cases: ReadonlyArray<WriteCase>
	readonly planted: PlantedCases
}

const maxCasesPerRun = 12

export const writeRunGen: Gen<WriteRun> = (source) => ({
	schema: source.draw(schemaSketchGen),
	statistics: source.draw(element<Statistics>(["analyzed", "none"])),
	ambient: source.draw(ambientSessionGen),
	cases: source.draw(array(writeCaseGen, { min: 1, max: maxCasesPerRun })),
	planted: source.draw(plantedCasesGen)
})

/**
 * A write run, the plan perturbation it runs under and how its second readings store their facts, drawn together so
 * they shrink together.
 */
const perturbedRunGen: Gen<readonly [WriteRun, Perturbation, Restorage]> = (source) =>
	[source.draw(writeRunGen), source.draw(perturbationGen), source.draw(restorageGen)] as const

/**
 * What a run's resolution draws: its schema and its drawn cases, each thinned by its swarm as the resolution meets each
 * place, so the property draws them once, from the case's own tape, and they replay and shrink with it.
 */
interface ResolvedRun {
	readonly schema: WSchema
	readonly drawn: ReadonlyArray<ResolvedCase>
}

const resolveRun =
	(run: WriteRun): Gen<ResolvedRun> =>
	(source) => {
		const schema = source.draw(resolveSchema(run.schema))
		return { schema, drawn: Arr.map(run.cases, (wc) => source.draw(drawnCase(schema, wc))) }
	}

/**
 * The features every write suite's population must reach: each member kind under every op, one to three strata, each
 * read-back source, every put target, refusals by every kind of law, each schema shape, the value spellings that test
 * identity after coercion, TOAST-sized payloads, numeric casts between typmods, generated additions that collide with
 * stored serial values, a run that reads back, on one Db, relations sharing field names with other types, references
 * into candidate keys, Stream members, bound parameters, db.compile, a described member reading a wider text
 * into a narrower field (a deletion among them) refused by the domain, a put on an immutable relation, a generated
 * addition drawing the key of a fact its stratum deletes, read back through both deltas, identical and differing, one
 * whose lagging draw repeats a fact the stratum keeps, refused at its key, draws of the realization's other than the
 * calculator's that change the counts, a put realized as UPDATE ... FROM advancing a lagging sequence past its keys,
 * and second readings over facts stored in another order and with a value respelled.
 */
export const writeSituations = [
	"strata:1",
	"strata:2",
	"strata:3",
	"insert array",
	"delete array",
	"put array",
	"insert project",
	"delete project",
	"put project",
	"insert param",
	"delete param",
	"put param",
	"delete scoped",
	"read added",
	"read removed",
	"read state",
	"put target deleteThenInsert",
	"put target onConflictDoUpdate",
	"put target updateFrom",
	"put target merge",
	"outcome accepted",
	"outcome no-change",
	"outcome invariant-rejected",
	"refused by a primary key",
	"refused by a candidate key",
	"refused by a deferred foreign key",
	"refused by an immediate foreign key",
	"refused by a projected key",
	"mutable relation",
	"identity column",
	"every field an identity column",
	"two identity columns",
	"insert generated",
	"a unit addition described and enumerated",
	"generated accepted",
	"generated after a collision",
	"deferred containment",
	"immediate containment",
	"projected key",
	"numeric coerced",
	"numeric coerced no-change",
	"numeric cast between typmods",
	"toast-sized input",
	"toast-sized no-change",
	"toast-sized accepted",
	"two members of one relation in one stratum",
	"a member reads a relation its stratum writes",
	"flight logged",
	"statistics analyzed",
	"statistics none",
	"delta read-backs of one heading's field names over other types",
	"reference into a candidate key",
	"stream member",
	"parameters bound",
	"parameters bound as streams",
	"through compile",
	"described member wider than its field",
	"a deletion described wider than its field",
	"outcome outside a domain",
	"outcome refused at bind",
	"put on an immutable relation",
	"a stated-one read-back with its parent present",
	"a stated-one read-back with its parent absent",
	"a stated-one read-back over a deferred containment that the write violates",
	"lagging identical netted",
	"lagging differing",
	"a generated repeat of a kept fact refused",
	"counts under the realization's draws",
	"an UPDATE ... FROM put advancing its sequence",
	"anchored deletion",
	"single-statement stratum",
	"a single statement refused by a law",
	"sequential stratum of several writes",
	"take sent in its LATERAL form",
	"facts reordered on a second reading",
	"a fact respelled on a second reading"
] as const satisfies ReadonlyArray<WriteOracleFeature>

/**
 * Whether two relations of a run, both read back through a delta, have the same field names in order and other types:
 * one read-back statement text over carriers of different column types, which a session's server statement must not
 * meet as a stale result type.
 */
const sharesHeadingNames = (
	reads: ReadonlyArray<{ readonly group: WGroup; readonly relation: string }>
): boolean =>
	Arr.some(reads, (a, i) =>
		Arr.some(reads.slice(i + 1), (b) => {
			const x = relationIn(a.group, a.relation).columns
			const y = relationIn(b.group, b.relation).columns
			return (
				x.length === y.length &&
				Arr.every(x, (c, j) => c.name === y[j]?.name) &&
				Arr.some(x, (c, j) => c.kind !== y[j]?.kind)
			)
		})
	)

/** The delta read-backs of a case, by group and relation. */
const deltaReads = (group: WGroup, c: WChangeSet) =>
	Arr.map(
		Arr.filter(c.reads, (r) => r.source !== "state"),
		(r) => ({ group, relation: r.relation })
	)

const failureReport = (cause: Cause.Cause<unknown>): string => {
	const error = Cause.squash(cause)
	return error instanceof CaseFailed ? error.report : Cause.pretty(cause)
}

/**
 * One run: its schema and drawn cases resolved from the case's own draws, the schema installed and opened, its
 * privileges checked, its cases in order (see the header).
 */
export const runWrite = (
	run: WriteRun,
	c: Case<WriteOracleFeature>
): Effect.Effect<void, CaseFailed, Substrate | Scope.Scope> =>
	Effect.suspend(() => {
		const resolved = c.draw(resolveRun(run))
		return runResolved(run, resolved, c.note).pipe(
			Effect.catchCause((cause) => {
				const error = Cause.squash(cause)
				return error instanceof CaseFailed
					? Effect.fail(error)
					: Effect.fail(
							new CaseFailed({
								report: `${printSchema(resolved.schema)}\n${failureReport(cause)}`
							})
						)
			})
		)
	})

/** A resolved run's schema installed and opened, its privileges checked, its cases in order. */
const runResolved = (
	run: WriteRun,
	resolved: ResolvedRun,
	note: Case<WriteOracleFeature>["note"]
) =>
	Effect.gen(function* () {
		const schema = resolved.schema
		note(`statistics ${run.statistics}`)
		for (const feature of ambientFeatures(run.ambient)) {
			note(feature)
		}
		const t = yield* openTarget(schema, run.statistics, run.ambient)
		const privileges = yield* privilegeProblems(t)
		if (privileges.length > 0) {
			return yield* new CaseFailed({
				report: `${printSchema(schema)}\n${Arr.join(privileges, "\n")}`
			})
		}
		const reads: Array<{ readonly group: WGroup; readonly relation: string }> = []
		const planted = Arr.findFirst(schema.groups, (g) => g.role === "planted")
		const cases = [
			...resolved.drawn,
			...Option.match(planted, {
				onNone: () => [],
				onSome: (group) => Arr.map(plantedArms, (arm) => plantedCase(group, arm, run.planted.facts))
			})
		]
		for (const [i, rc] of cases.entries()) {
			const ran = yield* runCase(t, rc, note).pipe(
				Effect.mapError((e) =>
					e instanceof CaseFailed
						? new CaseFailed({ report: `case ${i + 1} of ${cases.length}:\n${e.report}` })
						: e
				)
			)
			appendAll(reads, deltaReads(ran.group, ran.changes))
		}
		if (sharesHeadingNames(reads)) {
			note("delta read-backs of one heading's field names over other types")
		}
	})

/** The most shrink candidates a failing write run tries (see exploreWrite). */
const shrinkCandidates = 300

export interface WriteSuite {
	/** The suite's label in reports and the residual line; the library derives its floor stream from it. */
	readonly suite: string
	/** The runs of the rotating stream. */
	readonly runs: number
	/**
	 * The features the suite's population must reach, judged on its floor stream and its steered phase, which grows the
	 * floor's finds toward what it missed.
	 */
	readonly coverage: Coverage<WriteOracleFeature>
}

/**
 * A run kept by its tape, the decisions after the last colon of its failing case's replay token: the run
 * perturbedRunGen draws from the tape's first decisions is its sketch and the rest are the property's draws, so a change
 * of the generator draws it anew, and the kept case fails loudly where it no longer reaches what it names.
 */
const keptRun = (
	note: string,
	tape: string,
	reaches: Arr.NonEmptyReadonlyArray<WriteOracleFeature>
): Kept<readonly [WriteRun, Perturbation, Restorage], WriteOracleFeature> => {
	const values = valuesFromToken(tape)
	const run = generate(perturbedRunGen, forcedChooser(values, values.length))
	return {
		note,
		sketch: run.value,
		draws: tokenOf(values.subarray(run.tape.length), values.length - run.tape.length),
		reaches
	}
}

/** The runs a search found failing, kept and replayed by value in every suite. */
const keptRuns: ReadonlyArray<
	Kept<readonly [WriteRun, Perturbation, Restorage], WriteOracleFeature>
> = [
	keptRun(
		"a ChangeSet whose first stratum holds no member, so its second runs at position 0, and a key refuses one of its statements: the refusal is judged against the slot groups at that position, which once sat at the stratum's index among the ChangeSet's strata, where the witness found none",
		"3.2.j4.10t5.14fq.9w1.1my.3io.1c75.gfw.12x.1ekf.125f.b72.3wz.1e8t.1156.jjo.bit.1aeh.10kt.dkk.i12.us6.r2l.13st.13q.oas.17ik.muz.145v.hn3.3rg.uhl.1deb.7mm.7p6.i1z.3.43t.j25.phg.mvi.5kk.d5e.hd.1.1bjx.14o8.1a87.182o.164l.19sq.13.mzw.1bud.1c7g.bj6.1ek1.mtu.2iv.1ekf.1alt.152e.e5l.6ix.ryq.dwh.1vl.fbf.6tp.gn7.tff.12hk.k7q.1ek6.eu7.wir.d20.1al1.4pt.7qs.14ma.d92.mfv.k7e.z8e.15mo.lud.1dmg.1alu.1du3.1dog.3.sd1.q5.6de.j4p.980.1f3.1c25.18i8.yh6.4xc.5vv.dko.58e.174n.l5f.d.12d4.amv.v6c.eon.1.iap.xdi.azc.eph.1cd0.jq8.xit.b4.13wm.1ar3.tqr.1diw.acd.13xf.uwg.r5s.1cb4.1cqw.12lf.bb1.1dl8.czt.17ik.1d5r.92c.stv.b47.iyo.1ejw.t58.mla.178w.1cvf.3.6.0.a.c.6.b.9.g.2.8.3.1.0.0.0.1.5.0.3.9.1dvz.1.7pm.glp.13v8.8u4.yvr.3.1ekc.bgx.kgg.10sg.4kw.15cj.bfe.ijn.92z.1cgw.122s.zto.1972.tk2.0.1.3d1.7ss.1eke.y3m.1go.0.1.1.2.zb9.3.1.3.uj6.aqf.8zs.197p.eja.du0.42u.y83.15tm.u7a.1.20y.1.1bj7.rcg.3.u9d.15z0.4.15mx.c0n.2.fvk.0.3.5.hja.1.l8w.2.0.j3s.0.7.2.2.8.6.3.a.2.e.2.h.6.d.b.1ej2.3.8sl.1ekf.15hx.18vc.8lq.ian.1ej6.jyi.y2f.bvm.2.1ekb.q8z.16s9.3hh.3.57q.1ejn.cov.17vs.tg2.wac.429.cm.1e6i.bwl.1apb.1am.ceb.1bbp.9w2.5.1aj1.2kd.am7.9dw.lec.14ds.10s1.4ok.tnx.2jp.lwk.vza.11t4.d1y.360.9y6.588.o0e.17dy.1cu4.fqv.11wn.1uz.sl9.17h8.1.0.1.1.n5h.3.2.6.15ks.0.t0m.eqj.kx6.7gn.3u.fns.185.ghj.6.i10.19aa.16t0.ut0.vzo.5t3.1e5e.jrk.lld.gij.1.1854.1.xhr.wws.1.18uw.g53.0.3kk.1a2s.0.7kz.lls.0.e67.gpk.1.xi1.1.1.188s.0.3.1.0.f.1.2.f.0.3.2.9.9.5.g.tmh.4.b.f92.123g.586.161d.6yk.19pp.soc.4jj.s3b.16a1.scv.qrk.6by.7.s2w.2ak.19yo.1ekd.1dtl.2.5lw.10g2.z2g.3ar.s7m.13ae.wpf.19cy.1ehg.4u6.3.142.1yg.4r7.x4f.1kn.1chv.1bd1.129.f08.1c9o.14ll.1eh4.e2x.r.1pc.1.0.2.2.w91.3.1.2.s8k.301.11sw.rtr.33l.1yg.13r5.my.6xb.p9c.0.10pa.1.1ei9.1cj6.4.lxt.b.1.pz6.din.1.1bhi.1ek5.1.ize.k7d.0.tmr.0.3.2.19je.se3.s08.7q9.1a8o.i1b.8wd.16n6.1ekf.1ej1.6.y5d.o5r.ah2.vea.35c.xl1.13lt.x01.pxr.wux.1.1359.13pr.8yr.vcc.ejl.mct.kvw.e10.w0.140g.1.157e.0.11lv.4.4.80v.117q.3.4xs.sqi.0.75f.13ub.0.x25.e8j.0.0.1.0.6.2.5.0.0.5.b.a.6.c.4.fkk.5.j6y.n60.1bwt.53r.14de.t5l.imu.h7b.pph.gqp.1asn.d4b.60j.905.16pj.3q2.1dkg.1egn.yjl.1d2p.1on.2a9.u.zay.u9p.1.1824.n3c.ne9.15wv.svj.1.1aqe.rx0.1.43o.1ega.1.0.0.0.5.1.1.g.0.6.8.2.9.7.1.1.h.7.1dkq.2.auk.2g6.1a6d.aym.cjy.1ek7.7bb.8g.ak8.1cqy.5.1efj.1dz4.xr8.1c80.di4.wna.1ej3.11sy.1318.3hz.zkf.n98.zpj.1b4a.vvk.b31.drh.17w3.1ckk.15rm.gm3.3p6.12ho.7k4.tk8.5.aje.ql3.1995.hq6.1c6p.1ek5.5k1.wry.d9g.ko8.9g.7yb.5w3.13hk.uvt.o66.4y6.11n5.h2m.50c.160b.vqu.9oi.19hb.j0h.0.0.3.2.12jz.1.0.1.171b.1.1ekc.1e9.3.pk1.1abm.4.13ht.rgy.3.41a.154b.0.948.18ia.0.umy.6.2.0.eiq.2zb.2t.vw7.c3t.5qc.s4r.1uu.rol.jwk.0.zqp.dd2.rgx.m8g.bke.ip6.zmo.eji.44u.16.0.mj8.0.43.p95.0.12eq.q4p.1.sdk.18pi.2.1dmq.4so.0.a51.9ui.0.tp1.9.2.6.1c3v.ma.53q.95f.b7a.i2c.12vb.g4p.jgi.qf8.6.tlx.1di5.1b5n.1cnh.aie.9nk.uqt.jsl.1cvk.15bd.1.bay.1.z0x.0.3.340.14bz.1.mhp.7xl.3.kka.vs4.1.1c9h.hid.2.tnx.1.0.14wn.0.65e.1.1.r40.0.3.2.9.c.5.1.g.3.7.2.c.0.5.3.30t.0.4.6a.14v3.p8h.5sf.12a6.19xa.yzu.l54.x40.tws.e7y.18r.53o.sq.lgu.41t.mqm.ew2.jo.bhk.4.1ehs.10bc.lua.1buy.pf.mu5.t4e.26.dq9.6qe.qzr.14ff.5f5.gp5.1ejv.1ekf.13sw.fpq.xe6.0.0.3.2.0.1.0.wq0.3.2.0.6ze.131d.6w6.12jf.1ekf.m0n.98n.188y.b9f.s52.2.6ap.ko7.ebz.1eke.l2l.r0f.1vm.3xn.136t.48h.1.y9w.1.epr.f.1.4we.mwp.1.11xc.t41.1.1efq.9zh.1.0.wfw.1.1eic.0.0.eog.1.1.0.f.1.6.9.f.4.f.b.h.g.5.5.ypv.5.oe2.xy8.1cya.7xy.t67.8tx.ced.u7x.g1.h0e.o9a.fgk.1dtj.1b47.1atn.seu.f.cj4.zyp.1azd.18x0.ebo.3.4wz.3tj.4.34p.np0.zqq.udf.p3w.tfp.1al0.0.1783.15zz.19d6.ws0.nne.1ig.dfx.1ekc.18zy.3mq.glz.uux.4.jby.5ex.das.iqk.vxz.sft.15zg.j28.1ek7.12rk.1b7b.rh5.9os.1dwx.1eh2.g46.pxp.e1a.eme.18gx.1.1.0.3.cja.0.1.1dyf.1.83y.2.0.1boz.0.bmx.0.1.vt6.1.8.2.a.e.3.8.2.3.f.7.1.e.e.0.15g.3.zen.14rp.cek.cp5.10hl.xqs.1c86.qmj.nli.3t.1bl6.19vi.16w0.v82.14tq.5.cal.1ayg.133b.a7p.rf5.cfn.rb8.awh.uxx.1e39.1dfu.x9z.9ly.1d96.lvo.1csq.1eka.12gg.1451.1eka.3f.c03.d4f.19ar.196b.2.sj0.1cv5.1.1802.9p5.1agy.hj.1yb.yf9.p9e.0.2.3.0.ifq.8.0.1.u7e.0.jkq.wo.2.bvt.6n5.1.1v2.1re.4.txb.2nv.2.1bdr.1c9z.1.11zu.4.3.3.4ue.ch0.155a.a4c.oyy.1dlq.jvw.pen.96x.ipw.2.1ek8.v7a.1vi.153d.m6o.1ejl.owf.15cz.u8i.a8e.3.z2f.bv5.c2.1cc7.mg4.4jw.1ekc.izh.14cg.13c7.1.1a3g.0.10k2.1aff.4.5c5.1abt.3.8wo.17l9.2.42u.k8o.0.4mw.3ho.2.h9y.6.1.2.jna.1cpo.90u.1crz.1ads.4hv.j1i.wym.fyy.oj7.1.e2g.1.1750.6ch.3.qfi.r7w.3.4vv.1ek5.2.m2q.k1y.4.67e.p6p.1.pqp.1.1.67a.1.0.0.1.a.b.f.3.5.4.1.3.f.f.d.6dt.2.19fd.gmp.0.1804.m7.qck.1b0x.43x.969.hh7.0.0.0.1.0.0.6.2.f.f.5.b.d.h.2.b.d.b.g.5.0.0.0.1.1.0.0.1.1.0.1.0.se.2.1.1.1.2.2.0.0.2.0.1.2.1.1.2.1.1.2.2.0.2.2.0.2.1.0",
		[
			"statistics none",
			"ambient setting",
			"strata:1",
			"put array",
			"put on an immutable relation",
			"deferred containment",
			"stream member",
			"parameters bound as streams",
			"through compile",
			"sequential stratum of several writes",
			"flight logged",
			"facts reordered on a second reading",
			"a fact respelled on a second reading",
			"put target deleteThenInsert",
			"outcome no-change",
			"numeric coerced",
			"numeric coerced no-change",
			"delete array",
			"parameters passed",
			"through apply",
			"insert array",
			"two members of one relation in one stratum",
			"immediate containment",
			"insert project",
			"a member reads a relation its stratum writes",
			"read removed",
			"outcome invariant-rejected",
			"refused by a primary key",
			"strata:2"
		]
	)
]

/**
 * The write oracle: generated write schemas, facts and ChangeSets, the brute-force expectation, the database side, and
 * the three-way harness, explored by write runs.
 *
 * A write run is one case of the exploration: a generated schema (schema.ts), whether its tables carry planner
 * statistics, a plan perturbation (../perturb.ts), how each case's second reading stores its facts
 * (../gen/restorage.ts), one to twelve write cases and, where the schema holds the planted group, the planted cases
 * after them (harness.ts). The run's sketch is the case's generated value, and the swarm
 * decisions its schema and ChangeSets thin by are the property's own draws, so they replay and shrink with it. The run
 * installs its schema once, opens it as one Db, checks the installation's privileges, and runs its cases in order on
 * that Db, so the Db's server statements outlive each program: two programs that read back relations sharing field
 * names with other types meet their statement text again on one session. A failing run shrinks its schema and drops
 * its cases down to the one that fails. A suite is a label, its runs and the coverage its population must reach; the
 * library derives its floor and steered streams from the label, and nothing is written into the tree.
 *
 * Explores a write suite (see the header), every run under its perturbation, each case noting its features through its
 * own Case; the suite must reach its required features, and a failure fails. Runs go one at a time, since every run
 * installs a schema on the file's database. Shrinking stops after shrinkCandidates candidates, about twenty minutes at
 * four seconds a candidate alone: each candidate is a whole write run on PostgreSQL, a schema installed and up to
 * twelve cases applied two ways.
 */
export const exploreWrite = (
	s: WriteSuite
): Effect.Effect<Explored, SearchFailure, Run | Substrate> =>
	explore(
		{
			oracle: { kind: "unstated" },
			suite: s.suite,
			draw: drawn(perturbedRunGen),
			literal: Formatter.format,
			coverage: s.coverage,
			kept: keptRuns,
			runs: s.runs,
			shrink: boundedShrink(shrinkCandidates),
			concurrency: 1,
			steerEvery: 16,
			caseHang
		},
		([w, perturbation, restorage], c) =>
			Effect.scoped(
				runWrite(w, c).pipe(
					Effect.provideService(CurrentPerturbation, perturbation),
					Effect.provideService(CurrentRestorage, restorage)
				)
			).pipe(
				Effect.mapError((e) =>
					isPerturbed(perturbation)
						? new CaseFailed({ report: `${e.report}\n${printPerturbation(perturbation)}` })
						: e
				)
			)
	)
