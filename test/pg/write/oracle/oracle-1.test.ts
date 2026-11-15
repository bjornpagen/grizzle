/**
 * The three-way write oracle's suite 1 (support.ts), and the counterexample it keeps: FULLSUITE's case 26 at 4f5da399
 * (TEST_SEED=20261115, the rotating stream), whose third case's first stratum inserts a key a stored fact holds, and
 * whose second stratum reads the parameter p0, "é😀cde", into the narrow text, outside its `^.{0,3}$`. The flight's
 * admission, its first statement (write/admission/statement.ts), binds every parameter before any statement that
 * reaches state, so PostgreSQL refuses p0 there, ParamRejected, before the first stratum's key is met, and the model
 * (test/support/oracle/write/expect.ts) expects that refusal.
 *
 * @plant test/plants/pg/write/oracle/write-oracle-admission-after-strata.patch The model judges the parameters after
 * the strata (expect.ts expectUnder), so it expects the first stratum's key law where both realizations refuse p0 at
 * the admission; the kept case fails.
 * @plant test/plants/pg/oracle/optimized/installations-without-params.patch The oracle harness installs a case's schema
 * without the parameter types its query declares (test/support/oracle/write/run.ts openTarget), so a parameter cast to a
 * pattern domain meets UninstalledDomain.
 */
import { writeOracleSuite, writeSuite } from "#test/pg/write/oracle/support.ts"
import type { WriteSuite } from "#test/support/oracle/write/index.ts"

/** FULLSUITE's case 26 (see the header): a parameter outside its field, read after a stratum that breaks a key. */
const parameterAfterRefusedStratum: WriteSuite["kept"][number] = {
	note: "a parameter outside its field read after a stratum that breaks a key",
	sketch: [
		{
			schema: {
				groups: [
					{
						relations: [
							{
								width: 65531,
								kinds: [25703, 9092, 58981, 29918],
								key: [54672, 11796, 65477, 40513],
								candidate: [15632, 28365, 63750, 30488],
								serial: { at: 65040, kind: 8476, count: 27746, second: 65140 },
								target: 30908
							},
							{
								width: 9571,
								kinds: [43040, 64276, 10928, 25880],
								key: [25615, 56918, 28431, 23484],
								candidate: [50637, 52116, 53219, 34584],
								serial: { at: 22702, kind: 49739, count: 24702, second: 2150 },
								target: 0
							},
							{
								width: 31646,
								kinds: [18829, 8071, 11997, 6197],
								key: [48010, 21926, 37687, 16851],
								candidate: [36554, 51299, 65535, 34890],
								serial: { at: 63872, kind: 39719, count: 41919, second: 15120 },
								target: 63307
							}
						]
					},
					{
						relations: [
							{
								width: 26036,
								kinds: [14195, 44065, 1, 1450],
								key: [13542, 25667, 12780, 673],
								candidate: [26492, 31192, 11689, 6649],
								serial: { at: 17025, kind: 64166, count: 4199, second: 55186 },
								target: 57188
							},
							{
								width: 9353,
								kinds: [29448, 61382, 22595, 6414],
								key: [42766, 42760, 15176, 57421],
								candidate: [5439, 41947, 42955, 21434],
								serial: { at: 13923, kind: 63613, count: 6991, second: 23688 },
								target: 31377
							},
							{
								width: 61794,
								kinds: [48314, 11430, 31851, 58094],
								key: [50402, 18181, 509, 17926],
								candidate: [45725, 23836, 52192, 40293],
								serial: { at: 41522, kind: 54934, count: 39, second: 20492 },
								target: 45651
							}
						]
					}
				],
				planted: false,
				swarm: {
					identities: 2,
					mutable: 2,
					references: 3,
					immediateReferences: 1,
					projectedKeys: 1,
					candidateReferences: 3
				}
			},
			statistics: "analyzed",
			ambient: {
				path: { kind: "default" },
				settings: [
					{ parameter: "extra_float_digits", value: "3" },
					{ parameter: "TimeZone", value: "Pacific/Chatham" },
					{ parameter: "DateStyle", value: "German, DMY" }
				]
			},
			cases: [
				{
					group: 42394,
					facts: [
						[
							{ values: [51010, 5496, 41693, 53727], target: 5039 },
							{ values: [22005, 15842, 9556, 28868], target: 13758 }
						],
						[],
						[
							{ values: [35378, 52232, 72, 21609], target: 44470 },
							{ values: [33090, 14504, 9678, 4444], target: 58256 }
						]
					],
					behind: true,
					changes: {
						strata: [
							[
								{
									op: 1,
									relation: 24133,
									source: 1,
									facts: [
										{
											mode: 0,
											pick: 12156,
											row: { values: [27852, 16717, 0, 3363], target: 16136 }
										}
									],
									from: { other: true, relation: 47576 },
									filter: { on: true, column: 7626, value: 20851 },
									head: [
										{ term: 0, value: 17813 },
										{ term: 1, value: 54547 },
										{ term: 3, value: 3264 },
										{ term: 2, value: 21063 }
									]
								},
								{
									op: 0,
									relation: 30396,
									source: 5,
									facts: [
										{
											mode: 6,
											pick: 65534,
											row: { values: [2787, 12382, 28515, 58081], target: 61846 }
										}
									],
									from: { other: false, relation: 14075 },
									filter: { on: false, column: 12990, value: 20301 },
									head: [
										{ term: 0, value: 16752 },
										{ term: 3, value: 23513 },
										{ term: 3, value: 10018 },
										{ term: 3, value: 8118 }
									]
								}
							]
						],
						reads: [],
						swarm: {
							projections: 1,
							paramMembers: 1,
							reread: 1,
							nearMisses: 3,
							strata: 2,
							outsideDomain: 1,
							streams: 3,
							bind: 2,
							compiled: 2
						}
					}
				},
				{
					group: 48578,
					facts: [
						[
							{ values: [64355, 60736, 4087, 43578], target: 54116 },
							{ values: [41754, 13, 63650, 61607], target: 61343 },
							{ values: [31198, 42823, 48256, 9791], target: 8447 },
							{ values: [48744, 540, 36699, 52464], target: 11241 }
						],
						[{ values: [9313, 35873, 53535, 59090], target: 55273 }],
						[
							{ values: [23449, 53422, 8551, 19749], target: 30412 },
							{ values: [30400, 62139, 11311, 27177], target: 57965 },
							{ values: [21554, 6397, 40373, 12636], target: 14091 },
							{ values: [60500, 3166, 1901, 32951], target: 19943 },
							{ values: [24719, 73, 12716, 50004], target: 43726 }
						]
					],
					behind: true,
					changes: {
						strata: [[]],
						reads: [
							{ relation: 62936, source: 1, parent: { on: true, containment: 3, clear: false } },
							{
								relation: 62986,
								source: 0,
								parent: { on: false, containment: 30617, clear: false }
							},
							{ relation: 26602, source: 2, parent: { on: true, containment: 37687, clear: false } }
						],
						swarm: {
							paramMembers: 2,
							reread: 3,
							nearMisses: 2,
							strata: 2,
							reads: 1,
							outsideDomain: 2,
							streams: 3,
							compiled: 2,
							unitAdditions: 3
						}
					}
				},
				{
					group: 50509,
					facts: [
						[
							{ values: [14704, 65170, 50992, 31723], target: 63219 },
							{ values: [43134, 65535, 24870, 29386], target: 3128 },
							{ values: [40812, 57034, 32278, 47521], target: 20439 },
							{ values: [63041, 426, 20, 65523], target: 39538 }
						],
						[
							{ values: [50403, 31228, 42277, 53896], target: 3597 },
							{ values: [28685, 11465, 19543, 31925], target: 7 },
							{ values: [64705, 62703, 26178, 42681], target: 2 },
							{ values: [55667, 42399, 63135, 62350], target: 42642 },
							{ values: [33129, 28532, 9227, 63586], target: 11982 }
						],
						[]
					],
					behind: true,
					changes: {
						strata: [
							[
								{
									op: 1,
									relation: 43758,
									source: 9,
									facts: [],
									from: { other: true, relation: 9068 },
									filter: { on: true, column: 6796, value: 18210 },
									head: [
										{ term: 4, value: 45133 },
										{ term: 3, value: 15100 },
										{ term: 3, value: 3784 },
										{ term: 3, value: 28798 }
									]
								},
								{
									op: 1,
									relation: 59265,
									source: 4,
									facts: [],
									from: { other: false, relation: 27749 },
									filter: { on: false, column: 22354, value: 49096 },
									head: [
										{ term: 0, value: 19548 },
										{ term: 1, value: 1902 },
										{ term: 4, value: 28426 },
										{ term: 1, value: 57988 }
									]
								},
								{
									op: 0,
									relation: 11671,
									source: 9,
									facts: [
										{
											mode: 4,
											pick: 3031,
											row: { values: [1875, 25812, 10797, 59018], target: 38219 }
										}
									],
									from: { other: true, relation: 24798 },
									filter: { on: true, column: 47196, value: 41811 },
									head: [
										{ term: 4, value: 21815 },
										{ term: 4, value: 12168 },
										{ term: 0, value: 15 },
										{ term: 4, value: 3309 }
									]
								}
							],
							[
								{
									op: 0,
									relation: 42144,
									source: 5,
									facts: [
										{
											mode: 3,
											pick: 21430,
											row: { values: [11547, 37412, 8845, 27737], target: 29218 }
										}
									],
									from: { other: false, relation: 36251 },
									filter: { on: false, column: 59665, value: 63329 },
									head: [
										{ term: 2, value: 15255 },
										{ term: 4, value: 22538 },
										{ term: 4, value: 45031 },
										{ term: 4, value: 24706 }
									]
								},
								{
									op: 2,
									relation: 60879,
									source: 2,
									facts: [
										{
											mode: 4,
											pick: 24117,
											row: { values: [55063, 23126, 7909, 64175], target: 4781 }
										},
										{
											mode: 4,
											pick: 11056,
											row: { values: [26, 31652, 11129, 22442], target: 12558 }
										},
										{
											mode: 7,
											pick: 65236,
											row: { values: [25915, 56665, 21463, 6794], target: 44751 }
										}
									],
									from: { other: false, relation: 48934 },
									filter: { on: false, column: 12066, value: 11051 },
									head: [
										{ term: 3, value: 44995 },
										{ term: 4, value: 54243 },
										{ term: 1, value: 65535 },
										{ term: 2, value: 26322 }
									]
								}
							],
							[
								{
									op: 2,
									relation: 57663,
									source: 5,
									facts: [],
									from: { other: true, relation: 21649 },
									filter: { on: true, column: 19808, value: 55844 },
									head: [
										{ term: 4, value: 65535 },
										{ term: 0, value: 5035 },
										{ term: 0, value: 34433 },
										{ term: 0, value: 6282 }
									]
								},
								{
									op: 2,
									relation: 41971,
									source: 5,
									facts: [
										{
											mode: 3,
											pick: 12757,
											row: { values: [3674, 51570, 11044, 20164], target: 34354 }
										}
									],
									from: { other: true, relation: 29450 },
									filter: { on: true, column: 47131, value: 40479 },
									head: [
										{ term: 4, value: 43851 },
										{ term: 0, value: 36591 },
										{ term: 1, value: 19172 },
										{ term: 2, value: 52040 }
									]
								},
								{
									op: 1,
									relation: 6325,
									source: 9,
									facts: [],
									from: { other: true, relation: 65535 },
									filter: { on: false, column: 3184, value: 3681 },
									head: [
										{ term: 0, value: 12412 },
										{ term: 1, value: 59978 },
										{ term: 2, value: 28862 },
										{ term: 4, value: 37776 }
									]
								}
							]
						],
						reads: [
							{
								relation: 51196,
								source: 1,
								parent: { on: false, containment: 7974, clear: false }
							},
							{
								relation: 44384,
								source: 2,
								parent: { on: true, containment: 35241, clear: false }
							},
							{ relation: 6998, source: 2, parent: { on: true, containment: 27421, clear: false } }
						],
						swarm: {
							projections: 3,
							paramMembers: 3,
							strata: 3,
							reads: 3,
							outsideDomain: 1,
							streams: 1,
							bind: 3,
							unitAdditions: 1
						}
					}
				},
				{
					group: 65141,
					facts: [
						[
							{ values: [65448, 12623, 12751, 43521], target: 33353 },
							{ values: [51529, 32064, 23517, 16223], target: 6238 }
						],
						[
							{ values: [1904, 35768, 5851, 3677], target: 38894 },
							{ values: [24633, 39418, 22596, 29890], target: 15154 }
						],
						[
							{ values: [17840, 37554, 19289, 18785], target: 57092 },
							{ values: [14887, 61430, 43946, 9720], target: 44434 },
							{ values: [47461, 24059, 61606, 19693], target: 65534 }
						]
					],
					behind: false,
					changes: { strata: [[]], reads: [], swarm: { projections: 2, reads: 3, streams: 1 } }
				}
			],
			planted: { facts: [[], [], []] }
		},
		{ settings: ["enable_hashjoin = off"], multiplier: 1 },
		{ shift: 2, respell: 2 }
	],
	draws: "2.2.0.0.1.0.0.1.1.2.2.2.2.0.0.2.0.2.0.1.2.2.0.0",
	reaches: ["strata:3", "parameters bound", "outcome refused at bind"]
}

writeSuite(
	writeOracleSuite(1, [parameterAfterRefusedStratum]),
	"the three-way write oracle, suite 1"
)
