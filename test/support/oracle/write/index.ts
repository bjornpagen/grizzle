import {
	type Case,
	drawn,
	type Explored,
	explore,
	type Kept,
	type Run,
	type SearchFailure
} from "@grizzle/testing/explore"
import { failureText } from "@grizzle/testing/failure"
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
	return error instanceof CaseFailed ? error.report : failureText(cause)
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
	),
	keptRun(
		"a put whose head passes a parameter wider than its field's three code points, beside a deletion listing two facts at one value of a candidate key: the bind refuses the parameter (EncodingFailure refinedValue) before it judges the deletions' key, so the oracle expects the refusal at bind, where it once expected the key's",
		"2.1.17vn.13ex.cm5.1d2l.z9r.kr4.p6k.wbj.ah3.o1v.d8g.1lk.b5a.gt2.rsm.1bdv.mgw.177.1.w30.185u.18k.efo.6be.1dtp.1ctj.u6l.12cg.ggz.6n1.xlh.1a30.1t5.12yu.6zc.588.fd7.0.7.0.8.h.4.7.f.b.a.1.3.0.1.5.1.2.0.0.0.9.bj.3.16lw.31y.ixy.2cp.1daw.7z9.1eke.zsh.ist.194y.17dc.hu7.1dsn.4.7xg.4.25l.i18.1ek2.huc.ysr.16na.1c16.1ji.5e9.phv.ppn.gzk.uhp.1946.ihb.6gj.srf.1ejc.15ka.s67.4.x36.146.1di6.ff2.1a25.ciy.z1s.ym1.8k2.c75.1487.48i.1eka.xzy.fc9.19us.fnw.hfk.15u8.2o.0.3.2.3.2.mh3.0.2.1.11l5.1b9k.1217.18da.1e4n.5k9.13rf.1eka.br5.pp2.7.af4.u9a.1d98.ydh.1c5l.637.1ci1.16pd.1b6s.0.1.qx9.1.jnq.19sm.1.1egi.1ao4.4.1ekd.1y.2.ncf.vv2.2.5b4.56b.1.nk0.1.3.2.vk4.9uf.epr.cpx.1ekd.89l.15jg.14b2.j61.jtu.5.1avn.1xa.tgy.6.12q4.3g2.1akx.1b95.a9m.epr.2.1azb.pz3.j59.14s0.n30.s5v.b.mur.fim.32g.1.esq.0.ch4.wvn.2.rcf.3y5.3.qh0.1752.2.k1s.k9e.4.16cz.viq.2.zuh.1.3.3.5mc.hhd.uik.e61.owx.aon.sq.gtg.1e0y.19mn.0.1.5s9.154.tyc.slr.fc.19w7.171r.yge.r5x.7.17x5.4gn.9wf.9k.1axt.16ow.oqd.odb.1dhv.1aug.0.gf1.0.5c8.lzc.2.17q7.10d5.4.3ad.16ev.3.10j7.1.0.543.mgb.0.3.smm.1.1.11gl.1.lhw.0.1.lqj.1.3zn.2.1.1mi.1.8.1.1.a.d.d.5.1.1.g.0.5.0.3.14lk.1.dcj.wn9.148n.1cdr.1vr.0.4.2wo.1efx.1ek3.b62.20c.175x.s3f.ywe.m7o.wnz.6yd.1dbo.115a.ijh.0.1a4.10ei.mh1.12bn.9uq.0.3.2.0.0.2.bnk.0.1.hxn.0.sas.2.0.8ed.1.8.2.h.9.1.c.6.4.7.d.1.0.6.b.qpx.1.143b.18d4.k71.11nv.12nr.0.4.y8v.18f3.1d8m.8rw.rcv.10gb.1ekf.5c5.qmv.70x.19e4.10gs.103o.ce2.fko.92u.jth.g0.1762.s8h.1.3.3.2.0.rkh.0.1.7.eei.18ik.n0c.10sz.z5g.15yh.65.1ow.mtk.i5u.1.x3m.0.v4y.85.3.bhj.t0d.3.7aq.iul.1.c77.qf8.3.5.6zs.1.p2z.8.0.0.z8f.0.y8a.k7j.1.uaz.1eit.4.5r7.46.4.k4r.fbx.1.pfw.nw1.2.0.266.8.3.1.18de.1a6i.14og.bzi.p6j.1c4i.oh0.1dv5.f7l.uug.3.0.1axz.1b82.1bgt.3i.fdh.12ko.vdr.nkg.5i7.6.1499.o82.1aho.1eap.8op.1e3p.n9h.qxb.law.1e15.1.q3c.1.60q.8q7.3.x8d.2ey.0.1qb.b3y.2.iia.120h.1.jyf.om6.1.173u.8.1.4.1eke.7jy.4gj.ph8.m3d.1e8s.4h.5hg.l4h.20h.1.49e.1.gtx.18xz.0.orq.2ad.3.1891.8w9.1.1416.wy1.4.1dz8.2.1.2.eyi.7.1.2.mtf.12qf.3nu.bue.1534.di9.m0j.11nl.n6w.pgj.0.15gp.1.ew0.lf3.3.yda.1cpf.0.9rn.7n.1.u5e.18bm.0.138j.9ub.1.1e7u.1.1.10ld.0.8.2.7.5.e.1.2.0.7.9.2.b.d.5.19gg.3.ukq.jjw.ftb.1470.h62.1d5m.11bu.196v.pgm.1cqa.5xw.53f.yug.moz.1azn.0.3.wdt.igo.15hr.17lx.fjc.ety.un7.hoe.6et.gon.et8.19r8.10ak.qw9.pts.0.1.2.2.1dwx.3.1.3.1487.m3z.yfm.8wj.1ejr.t52.10ok.1ek3.10u1.l6q.0.1d1f.1.1d1u.1c6c.4.1.2j.0.d9w.obl.2.13yj.1e3j.0.4s6.kth.1.19xl.9.2.7.df0.f4t.okn.6fs.fn1.zru.exc.5sl.vto.tam.1.112c.164h.ky0.p4f.15wh.uts.qe5.140y.1l3.3am.1.15v8.1.ya3.1e2i.4.ki5.c.3.smc.egr.2.g51.vnc.4.a6.18ss.0.b.0.h.1.d.e.a.8.e.1.d.f.b.2.1ekf.1.za3.tu.v6h.1ekb.lx8.4.c87.y2k.1416.1edc.ox2.42y.uuj.5bx.627.0.tg4.1ek4.873.148i.12lx.1boz.35r.19ol.wxx.f1j.4.15mj.4hy.2zy.oj1.1ebd.43.19sl.ywt.2db.63a.1ek2.g26.5e2.qq5.t8u.19z.1eir.8y5.fpd.17xl.0.4.3.1.1.b5x.7.3.7.16r.byn.lhj.t6a.1ehf.xbx.389.e79.19cs.14hl.7.zbj.gqa.mzm.16lb.c7k.1cem.6vf.x0m.qpz.1525.2.m9k.ngm.k3n.rch.5od.9ci.1232.1cvd.syd.mh2.1.wr8.0.hsm.dvn.1.10yw.zxl.1.7tg.15ci.2.176e.tv6.4.1bku.1efw.2.0.tbp.7.2.0.dpk.1xg.6.rx5.7.13m9.13aj.1edf.4fo.10jy.1.1oj.80m.17nm.eyr.dtz.18co.ecx.8df.c64.c04.1.81.0.ysp.aon.2.ml6.bq.1.1sc.psa.4.a8u.imk.4.nkg.lxo.1.l1w.6.0.0.1dnp.0.q3.oa.0.gie.133y.2.18hw.u29.3.2td.m9b.1.1ek8.1bok.3.0.mcu.4.1.1.1nd.osw.umz.rje.wj9.p4v.5c1.k7w.1bau.13zo.0.1dkh.0.3s6.q1z.3.199n.i18.0.je.139f.2.16f8.1eip.2.1e7l.1ag3.2.40x.3.2.1.v52.p85.exj.1cwk.1rv.fzb.dsc.n1v.1bgi.tp1.1.oop.zh9.18sx.xon.64.192d.6fg.24e.wpy.xby.0.vpu.1.16zy.1bfd.0.g0w.vw2.3.nvj.lr4.3.y5o.jpx.1.15dx.v7h.0.m3a.5.1.0.8ia.1bj.18b4.1hd.1bbm.tfl.abr.zl6.v6g.20z.1.17t2.1.13a4.15ju.1.15dl.11a1.2.1eaw.tl.4.sdj.qvl.1.st0.gv7.3.3nv.1.0.2ty.1.13wv.0.0.m84.1.8.1.1.1i.1.6.0.d.2.e.a.1.4.1.f.2.h.6.1.elu.5.ud5.gvg.3cz.wdi.4qn.1by1.qko.zst.z31.11w6.8e.1ekf.zh7.11ut.t9s.158b.100q.dd0.y0g.zr.1cyi.1h9.66w.h9.8tx.5.2gw.1agm.uzk.1cx1.kzp.hc0.50h.79x.qxn.15xg.17kj.163p.bzg.lkj.o1m.vtm.elf.tcj.zy5.b8k.14xc.wsu.ik6.1bsf.18al.0.0.2.0.2.o5.1.1.ro6.1.t8a.1.0.18cs.0.1.1.f.1.b.f.8.9.0.e.6.6.g.g.yok.4.16zl.b3a.1ek3.v8.iz2.1cpq.1157.ayi.d3g.prk.znr.l1.1eh5.1dzk.17au.r0n.mmw.du.5oy.1b81.3.tkp.1bif.vf9.fzt.9vm.1ef2.2nh.1eke.lpx.ma3.y6e.1a3q.xoz.gb0.ba2.0.1.1.1.1.amt.8.0.0.8st.0.b32.nto.2.gv3.8im.3.pq8.11uo.3.928.sa4.4.mp9.qmf.0.6.0.f.5.0.9.5.1.2.d.0.f.1.e.gdx.0.5.5q.103o.1dug.cry.wbb.3nx.2p7.slk.1anf.le7.5wx.xop.1edz.ltx.1a79.15pv.48g.end.mu9.ibi.zue.slq.1cnl.ht5.13p.3.10tu.bb3.4cn.ve2.14it.ooc.1b60.1azu.utg.g9p.1ax2.q20.3.gc4.chg.1.3.3.2.1.1atn.9.0.0.lps.1.0.z4q.3.yq3.1bhi.0.gtx.on7.2.3yi.12p1.0.aph.10fz.2.glo.6.0.0.912.0.yc8.sob.2.29.1ek7.2.1755.1dx4.2.s3f.3.0.15ye.5w9.0.3.1.16wa.9.2.6.uir.15nj.19z6.pq9.c8r.ipc.1327.x.b08.s4t.6.ocv.65h.mj2.5wd.7s4.ja2.aqk.3h5.1b0s.hhj.0.7ob.1.1biw.fmb.3.ptd.17hs.0.17po.1e7e.3.1aqj.1ekf.2.smc.4rw.0.15mv.1.1.4.1ej9.3la.w7c.4rw.kuv.p0c.ioe.10yt.14u2.x.1.14w8.0.1cdr.17m4.1.1bo5.1eib.2.qz4.12r4.3.18s.17p6.0.174a.nk.2.1ek5.9.0.1.axa.1.4g4.1e7h.0.sz.8sa.3.z17.uoj.2.hil.63.3.hx0.yew.0.7.2.6.g.d.3.1.c.3.2.6.2.g.7.pcw.0.3.ofv.e5s.31d.1ar.7kb.tws.174z.2l2.7eg.1ekf.lz7.9qs.4rw.xgr.1ee1.0.1.3.2.1.1.1cpm.3.2.3.1bt7.1blh.an2.dzg.uld.72y.uxr.c1v.s.2u8.1.zbx.18ri.pxp.yt6.13jq.c.13x3.18aa.1470.7av.0.din.0.pf0.1eke.1.uht.oi.1.gqf.woh.4.4jx.4iy.4.fo4.1c11.0.0.5.0.2.1.b.h.c.2.4.8.e.8.a.7.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0",
		[
			"statistics analyzed",
			"grizzle-first path",
			"strata:1",
			"put project",
			"delete array",
			"two members of one relation in one stratum",
			"parameters passed",
			"through apply",
			"outcome refused at bind"
		]
	),
	keptRun(
		"a stratum that inserts into a pure set, puts a relation referencing it immediately at every field and deletes the pure set's facts: its deletion was held before its insertion, so with the put between them by the reference no order was left, and the ChangeSet was refused as UnorderableStratum where its pure set's facts meet nowhere and its deletion may follow",
		"3.3.1e4q.1d9h.bgw.1e1n.3dz.vsh.k4e.dn.1dtr.awf.u2o.45.1eio.8x4.168l.18jd.m8t.3qr.1261.184z.1aui.1efx.ea3.2ez.1ek3.1c2q.huz.cxb.tsb.ba0.10xk.gnh.59h.18jj.rf2.6zy.5sv.1a38.mxl.4.dm9.1dfi.cyj.vwc.13qm.12v3.s4g.ry.13cq.wvj.1qo.lac.1c2a.1biy.2.tqs.4x.1bh8.o28.10xd.15zu.696.13pi.rtr.sa6.13ii.15rb.1bjc.11bw.nq7.1drr.qlg.13dl.2aq.142y.2pp.btf.h3.lvs.t40.18.r92.13lk.16w5.wui.bq3.5e1.l1p.sc3.se2.2e.2.90w.qw8.11xa.147t.1858.hsm.jce.0.1ekd.1ejv.s2t.yzz.tl5.789.163e.14jj.n4v.eal.187w.15ym.14el.1b79.2m3.9u5.10kd.ty7.pnp.4ld.1b2s.lmv.pcv.11kd.wuf.17b.n31.1513.0.7.2.a.h.7.5.8.c.9.2.3.1.0.1.2.0.3.0.0.a.4jw.1.rzo.3ba.mo1.dyb.j17.0.3.bqz.mh2.1040.1eka.13ms.2e9.84v.1bo6.134d.1aud.d22.r8b.kk5.112m.6m2.1.3.3.0.1.0.jro.6.0.0.h8e.0.5af.oi3.1.1eke.182s.4.1eke.zq9.0.3.1ekf.4.pf4.twd.1.1.e2q.6.3.0.qa1.1dtg.trf.ywv.1eb0.198l.x20.vfm.tt7.4z.4.1aaj.itl.rhk.r3g.rwo.czv.1.1cds.3z9.18zl.4.1ek9.1bcq.11n5.vxs.18eu.jhr.f1y.vxb.1bvq.sy2.0.10fh.0.7p8.16if.2.j29.4np.0.wo6.1ejk.4.nbu.b7c.1.18wk.lk.0.2.2.e.9.1.f.c.b.2.3.1.e.8.c.oqy.0.3.pwg.1eg2.1ee7.g1o.fg0.1cw3.lx4.qe2.1b0p.1c31.1arl.9o3.z83.s0f.11gp.3.f6p.1.f1z.16i0.1dmu.k54.qoh.q9c.9.1aar.i0l.rss.17xj.i5c.w1y.0.2.0.0.7.2.7.5.9.2.c.0.b.2.8.e.2.c.vdc.1.roz.1bpo.k9d.5v9.sso.5.59y.8j2.1dgp.fy.bi.le.1bud.1e1.7l3.1e21.7l.pak.che.10y2.1v1.z52.a9.1d8.5vr.15u5.17nl.1c1p.175p.v6u.308.3.dwh.9rz.u28.1aq3.x6.gm3.18uj.ikm.b7d.vrj.l10.88h.kul.d8s.ju1.0.1.1.1.zfg.5.3.5.17dw.2hw.rft.gwy.t7j.1dyd.xtb.1bt1.18km.viy.2.loa.hcp.173o.1bon.jj6.7bi.nvh.b8q.6ju.1bvu.5.14uu.bs6.k1a.jl6.9pp.5jr.10sn.1d7v.7uv.q8e.1.xei.1.29g.mc4.1.1ekd.99t.0.jxf.9tq.0.gww.au.3.kv.9w4.1.1.0.0.g0o.1.0.1.2.9.6.g.4.1.c.f.e.f.b.b.18vo.2.sk0.uoi.wyp.1r2.111y.ivl.1df3.ni9.bn1.1dzt.4.187.1a5x.42i.k5f.1eke.lhg.4bz.n9s.s0g.11o1.1dhc.6p7.qmb.1ek9.d7u.9t4.b30.34v.3w5.8b0.2.bc0.4fi.1col.114l.ftj.rzs.14w.4c0.rvt.4wj.0.3.2.2.1.d5e.4.2.5.129m.136r.14wb.1bn2.1chb.1ais.gh4.c48.izl.t1x.2.q2n.ptc.1ek5.1bgz.4ns.10v5.192i.10a1.17aa.z0h.0.k71.0.5ch.760.2.17yz.m8v.3.blt.11hg.1.10oc.16fu.3.xu7.1e38.0.19p8.9.0.0.qsf.0.1lo.15kw.2.m01.11yp.3.g8k.hci.3.pvo.c93.1.ycv.1ekf.3.1.1ej4.4.1.7.1g.kyj.vzv.jte.wwu.1caz.6gu.127x.1cj.1eig.0.un8.0.1205.1ej2.3.1ecw.1bh7.2.eup.2t4.2.c5y.1asy.0.15n9.gz6.2.g52.8.0.0.bh4.1.gey.7p7.0.j94.ykn.1.8ug.yfz.0.5ug.c8u.4.16u2.w9g.0.19p0.1.3.7.13zq.ogf.1ee7.0.1ek9.17ta.14bn.1ek7.u1z.16f6.5.1ox.2.ri1.obf.3b1.1ekf.tzm.1d31.12tt.708.7.lm5.oiw.tz2.14n9.7r1.18yf.6am.g8i.mg6.z0v.1.stm.1.161r.2j8.3.14is.1d45.3.983.mf3.1.1ejk.2s6.3.9ua.1ekf.0.0.0.0.g.4.a.9.0.4.0.8.7.4.d.vdq.4.17v8.boy.14cx.hap.fle.14tz.p6.n5x.19u4.14y5.5sc.hkg.1b8f.imp.1eke.m8p.2z7.1d4e.17g6.0.1.13xr.lv7.aej.1h2.dnf.0.0.0.2.0.1cu2.9.0.1.1cq3.0.1dpf.yuw.4.2h2.gbj.3.1bzp.lvz.1.11lz.kvt.3.pj3.fwi.0.16az.0.2.6.yww.om8.wsq.18t8.8vn.20h.o76.113e.8jg.ie4.0.m.uus.hel.bgy.gnw.elf.qyj.a3o.195v.46.0.pj2.1.69r.1b3t.4.19fy.cl7.1.9io.c20.1.1c9m.tvg.3.18qp.1ekc.0.a.2.b.g.9.g.g.g.0.d.f.4.2.8.6.3.17tf.dfh.16nt.13uw.1d05.1ee1.v7l.35h.g3s.pjt.13v5.1921.5hg.slh.rb2.3.1az4.vx7.h3n.ar3.z8r.pq0.tjk.1ee5.mnv.71q.cxl.1egd.7.xxh.awo.0.0.2.3.0.k9w.3.1.2.1c1d.r62.gjl.yt3.8xf.13pw.snt.1ej8.17fn.shh.0.n8q.1.18xm.1c61.0.1bly.elg.0.ytt.10f2.1.ubl.hfm.4.5i6.2qr.1.7fs.6.1.2.un.14i6.6b2.ezo.2.1ebm.13ne.wqk.fz4.16n5.0.5a4.0.x.zhr.1.mh3.y49.2.z2p.11mx.4.mre.ypn.2.11v6.8gf.1.1ekf.9.1.4.eo4.o8m.1e3o.bxt.10gd.14yv.18tt.2gj.1dgl.d7p.1.12lt.0.br2.10b8.1.9lv.sgv.0.g0t.966.0.oxu.okp.0.16nw.hy4.3.ofj.0.1.ojp.1.14n4.0.1.fik.0.53r.0.0.7l9.1.0.2.2.8.f.9.h.7.b.9.h.a.e.1.0.0.2.udp.r55.c6o.jvl.12mc.19z8.135l.dq6.te8.mse.4.fju.16fz.12yf.nj9.1bat.ewl.14g7.2i.gz2.7sw.wxh.146f.ctl.9.1eim.j0s.0.173t.f0.19sg.1.3.3.2.0.1ae8.2.1.5.1w1.vv1.a2h.uee.14gh.xe4.16z7.1dx9.x8b.7qs.0.ycs.0.v07.xry.2.wjd.tmn.3.mf9.1b8u.1.18u.195q.3.1.pia.1.wn7.8.0.1.fl9.0.3a.lfa.4.3f.hu8.1.145h.ipe.3.auf.lf1.0.1fj.15lz.1.1.2ya.9.3.1.qgu.wlo.8j3.sdd.1327.10aq.e5l.b80.0.15q.7.fdg.4hg.1800.lv4.156u.8tw.1eke.0.8we.nc8.7.11q.7bc.1412.oo5.bkp.jpg.1e6a.1a2l.c0c.upt.1.18p.0.gdq.1jq.2.zua.bvm.2.gcf.1ea5.0.105u.fkc.1.e2b.qhg.3.0.5wf.0.3.1.39d.1eh1.1ejq.j0h.17el.thf.2y.agy.zb5.jjb.1.cmp.sfd.196l.2d2.en3.17kp.aib.oik.v31.cp.1.y7d.phb.18b0.364.0.1cb5.j2.ar7.13qv.lqt.1.195c.0.9cm.1eip.2.1edy.8py.0.1ekf.2ip.3.7ds.9cz.3.1bnz.lcq.2.7nv.9.2.1.15cl.s9v.68s.wgl.ppl.ryk.mut.jp6.190r.yvd.5.g9h.7.by.1cag.18ee.15ui.1asu.ctz.1yt.ha5.0.gxc.0.16ya.199v.3.k1.qvm.3.vl4.101j.0.wew.24u.3.jd9.pfr.0.g51.0.1.2.14mt.163w.rf8.s5x.jug.j0g.18fx.o5j.fqx.4pp.0.1wq.0.ckk.tm0.4.14q9.f38.3.yy5.4g.2.wcw.urs.1.19wn.13ad.3.16ov.0.1.nvq.1.juh.1.1.1du5.1.ev7.2.0.16d1.0.9.1.f.b.5.8.5.b.5.4.4.2.7.3.50c.5.ot.jh9.oqf.3ii.16.1cs5.ont.1eke.luu.w7i.15d9.b2z.1mc.d69.e9r.1b76.oyf.h3g.1bg9.vka.cwl.mjd.15y.19v6.194b.2.13t4.10w6.1e05.oht.mrb.u2i.z90.180l.11so.mtc.5.14na.g3q.1aal.6vy.9ig.fmz.vir.1h8.mgd.7gr.3ig.1clv.pkh.17sj.17gi.eh5.g.hxv.1h.164w.twb.1dl8.ijt.fi2.gwi.0.1.2.0.pv3.9.1.2.vlv.h49.iyv.648.q0l.wwq.pmu.pc6.1e0g.16nn.0.7e.0.12rc.dng.1.gzz.25s.0.15p7.1eke.2.10po.8u9.2.1eke.ndt.2.uts.4.0.1.1cpt.1.7n.erj.0.4dp.vzq.0.13q6.w5u.4.18ah.1a77.2.h6s.byz.3.1a9k.2.0.ag2.1.qoc.1.1.1867.0.1bsq.1.0.llc.1.3.0.9.f.b.2.8.e.0.f.9.g.5.1.3a7.0.3.12fr.yyj.o1b.1v1.196u.6ad.15ki.j47.bef.3jy.6vy.x39.r56.128b.1b5d.2.sv7.wi8.m2t.t4s.1e7g.v5b.120r.16ja.l8l.15u9.0.0.3.2.rme.0.3.0.x0b.11qv.170q.p7h.14d2.fm5.eki.g2c.1eik.1ekf.0.1bhp.19h.41d.zgd.1dzd.11dh.9y3.tyz.l8v.1ax2.4.1521.msc.111i.dku.ndx.ar.10eb.5.e5n.fza.0.mpj.0.1ej0.b77.2.why.u56.4.bbm.w8h.1.8iv.14j0.4.w0k.2.1.5z.0.2.5.122u.17h2.11rw.c7t.11k9.g6s.17q7.4yb.12hv.3sb.6.13ve.18a4.32j.1ej4.7vd.19hd.sno.qpj.kmk.lwm.1.19xz.1.115d.wqj.2.t42.1asl.1.cfq.128o.2.xrr.1eke.4.e4i.z4a.1.84p.1.2.6.tkb.wqn.cw0.lny.e10.x1a.ngj.k9g.1b1k.s7.4.kh1.mnh.12by.dve.yh3.om3.62.n12.ths.lzy.1.b0u.0.f9s.ugm.2.108y.dki.3.u45.hzu.1.1cn4.kb0.0.9h3.k1i.2.m1j.2.0.193c.1.o2h.1.0.yic.0.2.1.3.f.1.1.2.4.d.d.9.h.9.9.ld9.3.5s7.e8j.2u.d3i.tff.1die.s48.fw9.1ecr.pd3.uld.h5r.1da5.5ne.1e96.3.4.kt7.moz.1ant.16fv.1ejv.d4m.18l0.g2g.17zw.w4o.10hv.eqd.jpe.ges.1.4ck.wgu.1h.2.1ekc.0.4.3.3.1.elo.2.1.3.w3w.15ws.xbx.vcg.87h.wd6.ub7.1ejp.1.6uh.0.n5e.1.es1.v2y.0.1aua.14o.2.1dvn.19n6.1.73x.15bt.3.14bc.v1n.2.pxw.5.1.2.0.18ae.x76.12yf.2ro.lfe.14fq.140b.cf1.13d9.0.wgf.1.mcc.1f7.3.15no.cew.1.1987.9cu.1.16hk.n4w.0.1117.5ih.2.gne.7.3.5.pex.18mk.1c7x.it1.12d6.fq5.l2h.19.acv.wk0.7.q4o.j8d.gyj.15v8.18f.nfi.mly.ro7.6x2.w2g.2.j30.13tm.wq9.a9y.6.1n1.10r6.fix.wi.1463.0.jq4.1.h2y.1bat.1.ke2.y10.0.0.o7l.3.1b4o.160i.3.15ye.lzj.3.2.8hn.4.0.0.q4h.1.xxw.18qt.4.16zn.6hq.4.1r.j.0.2gv.qud.2.z8c.5lz.0.l74.5.2.5.zb0.tj4.mqr.keq.4iy.1x0.q1k.9t1.fho.8jx.1.160t.16s1.4h.nz3.1ekc.18q0.182c.nad.15te.zmi.0.ec6.0.4pp.yt0.0.rrs.d0a.0.c.91p.3.1c2c.1d7u.2.1ara.igp.1.199l.0.0.1.16y8.1.8no.18az.2.bfy.10gz.2.vu8.7qu.3.1687.muj.1.q84.118e.1.0.1dlm.1.2.7.18k6.44q.13sf.tel.418.2fa.1ec4.10zn.11i9.4de.2.1d2j.1e77.12k.tva.1ekb.0.12f8.188o.17q2.9r2.0.r4g.0.rnl.xs5.0.l1k.9te.2.lb.gvg.0.0.123u.3.a1g.r8g.0.5.1.f.2.1.c.8.0.3.h.d.3.6.g.0.0.0.0.1.0.1.0.1.1.0.1m.fz.0.0.0.0.1.1.2.2.0.0.2.2.0.1.0.2.1.2.0.0.0.1.0.0.1.0.0.2.0.0.1.2.2.0.0.2.2.1.0.1.1.0.1.2.0.1.1.0.0.0.1.2.1.0",
		[
			"mutable relation",
			"immediate containment",
			"deferred containment",
			"stream member",
			"delete scoped",
			"refused by an immediate foreign key"
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
