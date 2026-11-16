/**
 * The three-way write oracle's suite 1 (support.ts), and the counterexample it keeps: FULLSUITE's case 26 at 4f5da399
 * (TEST_SEED=20261115, the rotating stream), whose third case's first stratum inserts a key a stored fact holds, and
 * whose second stratum reads the parameter p0, "é😀cde", into the narrow text, outside its `^.{0,3}$`. The flight's
 * admission, its first statement (write/admission/statement.ts), binds every parameter before any statement that
 * reaches state, so PostgreSQL refuses p0 there, ParamRejected, before the first stratum's key is met, and the model
 * (test/support/oracle/write/expect.ts) expects that refusal.
 *
 * And lane TYPEWRITE's case 26 (TEST_SEED=1377187137, the rotating stream), replayed and shrunk at 41abe3e9 by lane
 * ORACLEDRAW, whose third case puts every field of a mutable relation G0R0(a bigserial, b bigserial) on an identity
 * sequence lagging at 1, behind the stored { a: 1, b: 1 } and { a: 2, b: 3 }, under contained(G0R1(a), G0R0(a)), a
 * deferred containment. One stratum adds a generated unit fact to G0R0, described and enumerated, deletes every G0R0
 * and G0R1 fact, and adds G0R1 { a: 2, b: 1.5 } back. The realization draws after the stratum's deletions (write/frontend
 * schedule.ts phaseOf), takes a = 1, b = 1 and re-creates the deleted fact, so G0R1 { a: 2 } names no G0R0 fact and
 * COMMIT refuses the change; the calculator's own draws pass the deleted fact, take a = 2 and would accept. The
 * sequences record those draws after the rollback, and each side is judged under them (harness.ts expectedOf,
 * addwins.ts Draws `realized`).
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

/**
 * TYPEWRITE's case 26 (see the header): a refused side whose lagging draw re-created a fact its stratum deletes, judged
 * under the draws its sequences record.
 */
const refusedUnderItsDraws: WriteSuite["kept"][number] = {
	note: "a refused side whose lagging draw re-created a fact its stratum deletes",
	sketch: [
		{
			schema: {
				groups: [
					{
						relations: [
							{
								width: 6428,
								kinds: [52721, 12599, 12883, 20746],
								key: [28917, 23465, 38434, 61295],
								candidate: [24691, 64805, 32060, 26055],
								serial: { at: 54603, kind: 30395, count: 54717, second: 15634 },
								target: 37563
							},
							{
								width: 18059,
								kinds: [42628, 40389, 14766, 51288],
								key: [29394, 7192, 25549, 59730],
								candidate: [26595, 12383, 58513, 6121],
								serial: { at: 32953, kind: 35977, count: 19432, second: 35186 },
								target: 24522
							}
						]
					},
					{
						relations: [
							{
								width: 6724,
								kinds: [34133, 18372, 47381, 3649],
								key: [49, 35569, 20111, 36622],
								candidate: [65449, 57514, 3920, 40561],
								serial: { at: 48429, kind: 44900, count: 58179, second: 36146 },
								target: 1479
							},
							{
								width: 57670,
								kinds: [63765, 10381, 12093, 26924],
								key: [8689, 56956, 50844, 176],
								candidate: [53715, 36268, 49813, 44169],
								serial: { at: 49727, kind: 46246, count: 26907, second: 18 },
								target: 11666
							}
						]
					}
				],
				planted: true,
				swarm: { allIdentities: 1, mutable: 2, references: 1 }
			},
			statistics: "none",
			ambient: {
				path: { kind: "grizzleFirst" },
				settings: [
					{ parameter: "DateStyle", value: "SQL, DMY" },
					{ parameter: "IntervalStyle", value: "iso_8601" },
					{ parameter: "bytea_output", value: "hex" }
				]
			},
			cases: [
				{
					group: 58403,
					facts: [
						[],
						[
							{ values: [23024, 18264, 11724, 14602], target: 0 },
							{ values: [32183, 64610, 36418, 29654], target: 65392 },
							{ values: [30678, 31603, 1577, 60203], target: 15870 },
							{ values: [28398, 33056, 7907, 19499], target: 8946 }
						],
						[]
					],
					behind: false,
					changes: {
						strata: [
							[
								{
									op: 1,
									relation: 33015,
									source: 2,
									facts: [],
									from: { other: false, relation: 64717 },
									filter: { on: false, column: 64281, value: 6667 },
									head: [
										{ term: 1, value: 5480 },
										{ term: 3, value: 3 },
										{ term: 2, value: 60288 },
										{ term: 1, value: 62797 }
									]
								},
								{
									op: 2,
									relation: 3,
									source: 8,
									facts: [],
									from: { other: false, relation: 39425 },
									filter: { on: false, column: 23317, value: 33843 },
									head: [
										{ term: 2, value: 12448 },
										{ term: 3, value: 46 },
										{ term: 1, value: 47677 },
										{ term: 2, value: 53167 }
									]
								}
							],
							[
								{
									op: 2,
									relation: 51692,
									source: 3,
									facts: [],
									from: { other: true, relation: 47746 },
									filter: { on: false, column: 40305, value: 2628 },
									head: [
										{ term: 4, value: 40228 },
										{ term: 0, value: 7822 },
										{ term: 4, value: 6766 },
										{ term: 2, value: 61583 }
									]
								}
							],
							[
								{
									op: 2,
									relation: 25400,
									source: 8,
									facts: [
										{
											mode: 6,
											pick: 3501,
											row: { values: [63534, 50439, 32893, 65535], target: 30850 }
										}
									],
									from: { other: false, relation: 1744 },
									filter: { on: false, column: 5233, value: 65390 },
									head: [
										{ term: 1, value: 34789 },
										{ term: 4, value: 5965 },
										{ term: 4, value: 52270 },
										{ term: 0, value: 28110 }
									]
								},
								{
									op: 0,
									relation: 39736,
									source: 7,
									facts: [
										{
											mode: 1,
											pick: 45326,
											row: { values: [1258, 32464, 22914, 64840], target: 22747 }
										},
										{
											mode: 4,
											pick: 61702,
											row: { values: [27810, 65534, 61184, 54817], target: 56434 }
										}
									],
									from: { other: true, relation: 794 },
									filter: { on: true, column: 27723, value: 63493 },
									head: [
										{ term: 0, value: 38438 },
										{ term: 2, value: 63347 },
										{ term: 3, value: 65535 },
										{ term: 0, value: 45188 }
									]
								},
								{
									op: 0,
									relation: 4751,
									source: 5,
									facts: [
										{
											mode: 7,
											pick: 1506,
											row: { values: [60679, 31824, 13089, 13166], target: 6174 }
										}
									],
									from: { other: true, relation: 6214 },
									filter: { on: true, column: 16740, value: 4 },
									head: [
										{ term: 0, value: 52405 },
										{ term: 2, value: 48707 },
										{ term: 2, value: 53901 },
										{ term: 4, value: 39688 }
									]
								}
							]
						],
						reads: [],
						swarm: { paramMembers: 1, outsideDomain: 1, compiled: 2 }
					}
				},
				{
					group: 53364,
					facts: [
						[
							{ values: [61241, 51721, 39512, 30043], target: 25907 },
							{ values: [41399, 42985, 58844, 1], target: 52451 },
							{ values: [65528, 4555, 36374, 34082], target: 64623 },
							{ values: [62184, 62, 42333, 24399], target: 58939 },
							{ values: [13029, 16674, 36274, 45768], target: 21481 }
						],
						[
							{ values: [17110, 40775, 30592, 47792], target: 20381 },
							{ values: [36599, 14772, 55159, 16520], target: 39765 },
							{ values: [54902, 56667, 55086, 59105], target: 49443 }
						],
						[]
					],
					behind: false,
					changes: {
						strata: [
							[
								{
									op: 1,
									relation: 19424,
									source: 9,
									facts: [
										{
											mode: 1,
											pick: 59068,
											row: { values: [32331, 46526, 47262, 35748], target: 21846 }
										},
										{
											mode: 7,
											pick: 46807,
											row: { values: [65532, 51298, 4586, 65533], target: 37955 }
										},
										{
											mode: 6,
											pick: 62007,
											row: { values: [29174, 46268, 26476, 15906], target: 23585 }
										}
									],
									from: { other: false, relation: 19780 },
									filter: { on: true, column: 18882, value: 50475 },
									head: [
										{ term: 3, value: 35 },
										{ term: 4, value: 23 },
										{ term: 0, value: 63687 },
										{ term: 3, value: 34069 }
									]
								},
								{
									op: 0,
									relation: 60782,
									source: 3,
									facts: [],
									from: { other: false, relation: 27285 },
									filter: { on: false, column: 62932, value: 34816 },
									head: [
										{ term: 2, value: 10190 },
										{ term: 4, value: 65533 },
										{ term: 0, value: 29 },
										{ term: 3, value: 14420 }
									]
								}
							],
							[]
						],
						reads: [
							{ relation: 21365, source: 0, parent: { on: true, containment: 65039, clear: true } },
							{
								relation: 47923,
								source: 1,
								parent: { on: false, containment: 31445, clear: false }
							}
						],
						swarm: {
							projections: 2,
							paramMembers: 1,
							reread: 2,
							nearMisses: 3,
							strata: 2,
							reads: 2,
							outsideDomain: 2,
							streams: 3,
							bind: 3,
							compiled: 3,
							unitAdditions: 3,
							equalities: 3
						}
					}
				},
				{
					group: 3006,
					facts: [
						[
							{ values: [5517, 15304, 35070, 13320], target: 56920 },
							{ values: [27433, 33153, 63513, 13597], target: 48907 },
							{ values: [17, 12554, 20864, 45270], target: 52995 },
							{ values: [17436, 33215, 61805, 14946], target: 9 },
							{ values: [26009, 58502, 63887, 18033], target: 8279 }
						],
						[
							{ values: [65506, 18765, 50345, 13174], target: 34965 },
							{ values: [34328, 36887, 53069, 46191], target: 58808 },
							{ values: [22257, 1774, 17103, 17947], target: 11286 },
							{ values: [48552, 247, 12825, 40667], target: 18724 },
							{ values: [16852, 56025, 23895, 20559], target: 265 }
						],
						[{ values: [53216, 7093, 0, 61188], target: 42929 }]
					],
					behind: true,
					changes: {
						strata: [
							[
								{
									op: 0,
									relation: 26323,
									source: 6,
									facts: [
										{
											mode: 2,
											pick: 22069,
											row: { values: [27521, 31053, 31826, 14809], target: 56512 }
										}
									],
									from: { other: true, relation: 44343 },
									filter: { on: false, column: 15299, value: 186 },
									head: [
										{ term: 3, value: 49746 },
										{ term: 0, value: 25814 },
										{ term: 4, value: 47144 },
										{ term: 4, value: 13460 }
									]
								},
								{
									op: 1,
									relation: 60420,
									source: 7,
									facts: [],
									from: { other: true, relation: 22289 },
									filter: { on: true, column: 59293, value: 6174 },
									head: [
										{ term: 1, value: 29143 },
										{ term: 3, value: 26283 },
										{ term: 3, value: 5480 },
										{ term: 3, value: 40430 }
									]
								},
								{
									op: 0,
									relation: 62772,
									source: 7,
									facts: [
										{
											mode: 4,
											pick: 14929,
											row: { values: [58934, 17527, 43950, 65454], target: 36158 }
										}
									],
									from: { other: false, relation: 5291 },
									filter: { on: true, column: 17069, value: 48935 },
									head: [
										{ term: 0, value: 63742 },
										{ term: 0, value: 54527 },
										{ term: 3, value: 41227 },
										{ term: 3, value: 2027 }
									]
								}
							]
						],
						reads: [
							{ relation: 36540, source: 2, parent: { on: true, containment: 65521, clear: true } }
						],
						swarm: {
							projections: 2,
							paramMembers: 1,
							reread: 1,
							nearMisses: 2,
							strata: 3,
							reads: 3,
							outsideDomain: 3,
							streams: 2,
							bind: 1,
							unitAdditions: 1,
							equalities: 1
						}
					}
				},
				{
					group: 33392,
					facts: [
						[
							{ values: [7006, 3, 65284, 0], target: 60085 },
							{ values: [65528, 29896, 62657, 0], target: 5666 },
							{ values: [25147, 64106, 38312, 15630], target: 12513 }
						],
						[{ values: [1, 56978, 61468, 27861], target: 56629 }],
						[
							{ values: [20839, 14947, 2105, 59999], target: 49822 },
							{ values: [23131, 62940, 35297, 41394], target: 15089 },
							{ values: [65531, 19387, 41115, 34584], target: 20878 },
							{ values: [36651, 12558, 2639, 12759], target: 2752 }
						]
					],
					behind: false,
					changes: {
						strata: [[]],
						reads: [],
						swarm: {
							projections: 2,
							paramMembers: 1,
							reread: 3,
							nearMisses: 3,
							strata: 3,
							reads: 3,
							outsideDomain: 1,
							streams: 1,
							bind: 3,
							compiled: 1,
							unitAdditions: 3,
							equalities: 1
						}
					}
				}
			],
			planted: { facts: [[], [], []] }
		},
		{
			settings: [
				"enable_hashjoin = off",
				"enable_mergejoin = off",
				"plan_cache_mode = force_generic_plan",
				"parallel_tuple_cost = 0",
				"min_parallel_table_scan_size = 0"
			],
			multiplier: 2
		},
		{ shift: 45, respell: 55 }
	],
	draws: "1.2.2.0.0.1.0.1.1.0.1.0.2.1.2.1.1.0",
	reaches: [
		"every field an identity column",
		"two identity columns",
		"deferred containment",
		"a unit addition described and enumerated",
		"delete project",
		"a verdict under the realization's draws"
	]
}

writeSuite(
	writeOracleSuite(1, [parameterAfterRefusedStratum, refusedUnderItsDraws]),
	"the three-way write oracle, suite 1"
)
