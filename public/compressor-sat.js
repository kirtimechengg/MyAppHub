/* =========================================================================
 * compressor-sat.js  -  Site Acceptance Test (SAT) engine
 * =========================================================================
 *
 * Data reduction, uncertainty analysis and acceptance evaluation for a SITE
 * performance test of a centrifugal compressor and its driver.
 *
 * Primary source
 * --------------
 * Kurz, R., Davis, K., Kaiser, R., Brun, K., McBain, M. (2021)
 * "Site Performance Testing of Centrifugal Compressors and Gas Turbine
 *  Drivers", Turbomachinery Laboratory, Texas A&M Engineering Experiment
 *  Station.  Cited below as [SPT] with page and equation numbers.
 *
 * Layered on ASME PTC 10 (similarity limits, Type 1 definition), ASME
 * PTC 19.1 (uncertainty) and ISO 5389 (unsteadiness penalty).
 *
 * What makes a SITE test different from the shop test the PTC-10 Type 2 tool
 * on this hub already covers:
 *
 *   1. The verdict is an UNCERTAINTY ELLIPSE, not a scalar tolerance.  [SPT]
 *      p.26: "Only deviations from expected results that are outside the test
 *      uncertainty range are significant.  If the test point does not meet the
 *      prediction, but a test uncertainty ellipse drawn around it still covers
 *      the prediction, the test results don't contradict the prediction."
 *   2. Power is determined TWICE, independently (compressor gas power and a
 *      driver-side measurement), and reconciled.  In the paper's field case the
 *      two disagreed by 4.4 % until a leaking valve and a wrong flow-meter
 *      calibration coefficient were found ([SPT] p.30).
 *   3. Curve SHAPE carries the diagnosis: a horizontal shift indicts the flow
 *      measurement; scattered points indict gas composition drift ([SPT] p.32).
 *   4. PTC-10 Type 1 deviation limits are a BENCHMARK, not a gate - [SPT] p.4:
 *      "site performance tests often will not fall within the defined limits,
 *      and allowance must be made for that situation."
 *
 * Conventions (identical to compressor-eos.js): strict SI internally.
 *   pressure Pa, temperature K, mass flow kg/s, volume flow m3/s,
 *   head J/kg, power W, length m, speed rpm on the interface / rad/s inside.
 * No DOM, no Firebase, no globals beyond the single SatEng namespace.
 * ========================================================================= */

(function (global) {
    'use strict';

    var E = global.CompEng;
    if (!E) {
        throw new Error('compressor-sat.js requires compressor-eos.js to be loaded first.');
    }
    /* TrainEng is resolved lazily at call time rather than captured here, so
       script order between this file and compressor-train.js cannot break the
       load. Only the driver-power routes need it. */
    function trainEng() { return global.TrainEng || null; }

    var RAD = Math.PI / 30;                 // rpm -> rad/s
    var PI4 = Math.PI / 4;

    /* =====================================================================
     * 1. SAT_REFS - every constant traceable to [SPT], rendered with source
     * ===================================================================== */

    var SAT_REFS = {

        /* Table 2, p.15 - instrument COUNTS for a state-of-the-art site test.
           Note these are quantities, not "at least one": four independent
           instruments at each compressor pressure and temperature station is
           what unlocks the discard-one-of-four rule in averageStations(). */
        counts: {
            compressor: [
                ['Volume flow, process gas', 'Q', 1],
                ['Composition, process gas', '-', 1],
                ['Suction pressure', 'p', 4],
                ['Suction temperature', 'T', 4],
                ['Discharge pressure', 'p', 4],
                ['Discharge temperature', 'T', 4],
                ['Recycle valve position', '%', 1],
                ['Differential pressure, impeller eye', 'dp', 1],
                ['Speed, compressor', 'N', 1]
            ],
            gasturbine: [
                ['Ambient temperature', 'T', 1],
                ['Ambient pressure', 'p', 1],
                ['Ambient relative humidity', '%', 1],
                ['Inlet pressure loss', 'dp', 1],
                ['Inlet temperature', 'T', 1],
                ['Gas generator speed', 'N', 1],
                ['Volume flow, fuel gas', 'Q', 1],
                ['Composition, fuel gas', '-', 1],
                ['Temperature, power turbine', 'T', 17],
                ['Torque, power turbine', 'tau', 1],
                ['Power, power turbine', 'P', 1],
                ['Speed, power turbine', 'N', 1]
            ]
        },

        /* Table 3, p.16 - achievable accuracy for the ENTIRE measurement
           chain, not the end device on its own. */
        accuracy: {
            pressure:    { lo: 0.3, hi: 2.0, unit: '% full scale' },
            temperature: { lo: 0.3, hi: 4.0, unit: 'K (0.5-7.5 deg F)' },
            flow:        { lo: 0.5, hi: 2.0, unit: '% of value' },
            torque:      { lo: 0.5, hi: 1.5, unit: '% of value' },
            gasComp:     { lo: 0.2, hi: 3.0, unit: '% of value' }
        },

        /* p.24 - the paper's own steady-state gate, explicitly tighter than
           other specifications and stated to be achievable in practice. */
        steady: {
            window_s: 600,          // 10-minute interval
            speed_rpm: 5,           // operating speed constant within 5 rpm
            etaPoints: 0.5,         // efficiency within +/-0.5 POINTS of average
            headPct: 0.5,           // head within +/-0.5 % of average
            flowPct: 0.5,           // actual flow within +/-0.5 % of average
            setsPerPoint: 3         // at least three sets of data per test point
        },

        /* p.24 - the recommended test matrix. */
        matrix: {
            speedLines: 3,
            pointsPerLine: 5,
            direction: 'Start at the high-flow side and gradually reduce flow',
            bracket: true           // acceptance point bracketed by two nearby points
        },

        /* Table 4, p.20 - ISO 5389-1992 added uncertainty on absorbed power
           for unsteady conditions. The paper's own caveat follows. */
        unsteady: [[2, 0], [3, 0.5], [4, 1], [5, 2]],
        unsteadyNote: 'ISO 5389 underestimates this. [SPT] p.20: any fluctuation ' +
            'in power above about 0.5 % will add to the uncertainty of the results, ' +
            'especially for tests involving gas compressors.',

        /* p.19 (ref [1]) - systematic uncertainty actually achieved across 86
           ten-second data sets, and the random scatter within them. Random is
           at least an order of magnitude below systematic. */
        typicalSystematic: { isenHead: 2.3, actualFlow: 2.5, absorbedPower: 2.6 },
        typicalRandom:     { isenHead: 0.02, flow: 0.3, power: 0.3 },

        /* p.11 - mechanical efficiency covers bearing, seal and windage loss. */
        mechEff: { lo: 0.98, hi: 0.99 },

        /* p.25 - straight pipe run, in pipe INSIDE diameters. */
        piping: {
            flangeToElbow: 3,        // compressor flange to elbow / reducing transition
            expandingTransition: 6,  // expanding transition upstream of the compressor
            orificeUpstream: 10,     // orifice to upstream elbow / valve
            orificeDownstream: 5
        },

        /* Table 7, p.33 - maximum probe insertion length to keep off the
           Strouhal vortex-shedding resonance (API 14.1 section 6.4.1).
           [OD inches, max length inches] */
        probeLen_in: [[0.25, 2.00], [0.375, 3.25], [0.5, 4.25], [0.75, 6.50]],

        /* p.32 - gas turbine heat soak before a full-load point. */
        gtHeatSoak: { smallBelow_hp: 8000, small_h: 1, large_h: 2 },

        /* p.27 - power recovered by washing the engine air compressor. A
           fouled compressor makes the engine performance test invalid. */
        gtWashRecovery_pct: 3,

        /* p.30 - the worked reconciliation case, quoted in reconcile(). */
        reconcileCase: {
            gap_pct: 4.4,
            causes: ['a leaking valve', 'the calibration coefficient for the flow metering']
        },

        /* pp.13-15 - EOS discipline. */
        eos: {
            etaSpread_pct: 2.0,      // efficiency spread between EOS for one data set
            densitySpread_pct: [0.5, 2.5],
            rule: 'Use for test data reduction the same EOS that was used for the ' +
                  'performance prediction ([SPT] p.13, also required by ISO 5389).'
        },

        /* Table 1, p.14 - published EOS comparison for one measured data set.
           Gas 97.4 % CH4 / 1.49 % C2H6 / 0.08 % C3H8 / 0.95 % N2 / 0.041 % CO2,
           p1 = 748.2 psia, p2 = 1550.05 psia, T1 = 100.4 F, T2 = 215.0 F.
           [EOS, H ft.lbf/lbm, H* ft.lbf/lbm, eta*, Z1, Z2] */
        table1: {
            gas: [
                { id: 'C1', molPct: 97.4 }, { id: 'C2', molPct: 1.49 },
                { id: 'C3', molPct: 0.08 }, { id: 'N2', molPct: 0.95 },
                { id: 'CO2', molPct: 0.041 }
            ],
            p1_psia: 748.2, p2_psia: 1550.05, T1_F: 100.4, T2_F: 215.0,
            rows: [
                ['RK',   43859, 39019, 0.8896, 0.9233, 0.9438],
                ['LKP',  43721, 39284, 0.8985, 0.9277, 0.9469],
                ['BWRS', 43301, 39031, 0.9014, 0.9221, 0.9451],
                ['PR',   43433, 38463, 0.8856, 0.9115, 0.9295]
            ],
            experimentZ1: 0.9259
        },

        /* Tables 5 and 6, pp.21-22 - the worked uncertainty example.
           Table 5 (efficiency) is self-consistent and is used as the module's
           regression case. Table 6 (polytropic work) is NOT: see the note on
           uncertainty() below. */
        table5: {
            p1_psia: 1000, p2_psia: 2000, T1_F: 80, T2_F: 195,
            u: { p1_psi: 5, p2_psi: 10, T1_F: 1, T2_F: 1 },
            etaPolyNominal: 0.8205,
            bx: 0.018001,
            UxPrinted: 0.018249      // reproduced only with coverage factor t = 1
        }
    };

    /* =====================================================================
     * 2. ASME PTC-10 similarity bands
     * ---------------------------------------------------------------------
     * Digitised curves ported verbatim from the PTC-10 Type 2 tool on this hub
     * ("PTC10 Type2 Test validation Tool.html", MM_CURVE / RE_CURVE and the
     * interpolators beside them) so both tools read the same figures. Keeping
     * one copy here means a correction to a digitisation lands in both places.
     * ===================================================================== */

    /* Fig. 3.3 - allowable departure of the TEST machine Mach number from the
       specified value, as (Mt - Md) against Md. */
    var MM_CURVE = {
        up: [[0.0, 0.28462], [0.045, 0.27389], [0.0816, 0.26489], [0.1181, 0.25584], [0.1547, 0.24685], [0.1913, 0.23785], [0.2278, 0.2288], [0.2644, 0.21981], [0.3009, 0.2107], [0.3375, 0.20159], [0.3741, 0.19254], [0.4106, 0.18349], [0.4472, 0.17433], [0.4838, 0.16534], [0.5203, 0.15629], [0.5569, 0.14729], [0.5935, 0.1383], [0.63, 0.12925], [0.6666, 0.12025], [0.7031, 0.11126], [0.7397, 0.10221], [0.7763, 0.09321], [0.8128, 0.08422], [0.8494, 0.07505], [0.886, 0.06997], [1.6, 0.06986]],
        lo: [[0.0, 0.0], [0.0188, -0.02341], [0.0367, -0.04107], [0.05, -0.05397], [0.0649, -0.06841], [0.0799, -0.08301], [0.0932, -0.09607], [0.1065, -0.10866], [0.1198, -0.12172], [0.1331, -0.13448], [0.148, -0.14904], [0.163, -0.16367], [0.1763, -0.17642], [0.1896, -0.18917], [0.2029, -0.20223], [0.2278, -0.21406], [0.2644, -0.20562], [0.3009, -0.19568], [0.3375, -0.18562], [0.3741, -0.17562], [0.4106, -0.16557], [0.4472, -0.15557], [0.4838, -0.14556], [0.5203, -0.13551], [0.5569, -0.12551], [0.5935, -0.1154], [0.63, -0.10545], [0.6666, -0.0954], [0.7031, -0.0854], [0.7397, -0.07545], [0.7763, -0.06534], [0.8128, -0.05523], [0.8494, -0.04534], [0.886, -0.04009], [1.6, -0.04014]]
    };

    /* Fig. 3.5 - allowable ratio Re_test / Re_design, digitised on
       (log10 Re, log10 ratio). */
    var RE_CURVE = {
        up: [[4.92465, 0.60942], [5.07677, 0.63036], [5.19582, 0.65248], [5.31486, 0.67907], [5.43389, 0.71124], [5.55291, 0.75068], [5.67192, 0.80184], [5.79091, 0.86083], [5.90987, 0.93713], [6.02881, 1.02404], [6.14773, 1.12883], [6.26662, 1.24535], [6.38549, 1.37583], [6.50436, 1.51078], [6.6178, 1.6482], [6.72584, 1.78133], [6.83387, 1.92023], [6.94743, 1.99423], [7.0, 2.0], [9.0, 2.0]],
        lo: [[4.91331, -0.52732], [5.07877, -0.58006], [5.19792, -0.61939], [5.31708, -0.66206], [5.43624, -0.70921], [5.55542, -0.76417], [5.6746, -0.82359], [5.79379, -0.88639], [5.91299, -0.95308], [6.0, -1.0], [9.0, -1.0]]
    };

    function interpLin(tab, x) {
        if (x <= tab[0][0]) return tab[0][1];
        for (var i = 1; i < tab.length; i++) {
            if (x <= tab[i][0]) {
                var x0 = tab[i - 1][0], y0 = tab[i - 1][1], x1 = tab[i][0], y1 = tab[i][1];
                var t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
                return y0 + t * (y1 - y0);
            }
        }
        return tab[tab.length - 1][1];
    }

    function interpLog(tab, x) {
        var lx = Math.log10(x);
        if (lx <= tab[0][0]) return Math.pow(10, tab[0][1]);
        for (var i = 1; i < tab.length; i++) {
            if (lx <= tab[i][0]) {
                var x0 = tab[i - 1][0], y0 = tab[i - 1][1], x1 = tab[i][0], y1 = tab[i][1];
                var t = x1 === x0 ? 0 : (lx - x0) / (x1 - x0);
                return Math.pow(10, y0 + t * (y1 - y0));
            }
        }
        return Math.pow(10, tab[tab.length - 1][1]);
    }

    /** Fig. 3.3 band on (Mt - Md). */
    function machLimits(Md) {
        return { up: interpLin(MM_CURVE.up, Md), lo: interpLin(MM_CURVE.lo, Md) };
    }

    /** Fig. 3.5 band on Re_test / Re_design. */
    function reLimits(Red) {
        return { up: interpLog(RE_CURVE.up, Red), lo: interpLog(RE_CURVE.lo, Red) };
    }

    /* PTC-10 Table 3.2 (1997) / 3-2.1-2 (2022) Note (1): minimum allowable
       TEST machine Reynolds number is 90,000. The floor is on the measured
       value, not the specified one. */
    var REM_MIN = 9e4;

    function remCheck(Red, ReT) {
        var lim = reLimits(Red);
        var rat = Red ? ReT / Red : 0;
        var floorOK = ReT >= REM_MIN;
        var bandOK = rat >= lim.lo && rat <= lim.up;
        return {
            lim: lim, rat: rat, floorOK: floorOK, bandOK: bandOK,
            ok: floorOK && bandOK, extrap: Red > 0 && Red < REM_MIN
        };
    }

    /* PTC-10 Table 3.1 - permissible deviation from SPECIFIED operating
       parameters for a Type 1 test. [SPT] p.4 is explicit that this is the
       benchmark a site test aims at but frequently cannot meet, so callers
       treat a miss as a caution carrying extra uncertainty, not a failure. */
    var TABLE_31 = [
        ['Inlet pressure', 'p1', 5],
        ['Inlet temperature', 'T1', 8],
        ['Speed', 'N', 2],
        ['Molecular weight', 'MW', 2],
        ['Capacity', 'Q1', 4]
    ];

    /* PTC-10 Table 3.2 - similarity limits that must hold for the fan-law
       correction to carry. */
    var TABLE_32 = {
        volRatio: { lo: 0.95, up: 1.05, label: 'Specific volume ratio v1/v2' },
        phi:      { lo: 0.96, up: 1.04, label: 'Flow coefficient' }
    };

    /* =====================================================================
     * 3. Small numeric helpers
     * ===================================================================== */

    function mean(a) {
        var n = 0, s = 0;
        for (var i = 0; i < a.length; i++) { if (isFinite(a[i])) { s += a[i]; n++; } }
        return n ? s / n : NaN;
    }

    /** Sample standard deviation (n-1), the form PTC 19.1 uses for scatter. */
    function stdev(a) {
        var v = a.filter(isFinite);
        if (v.length < 2) return 0;
        var m = mean(v), s = 0;
        for (var i = 0; i < v.length; i++) s += (v[i] - m) * (v[i] - m);
        return Math.sqrt(s / (v.length - 1));
    }

    function rss() {
        var s = 0;
        for (var i = 0; i < arguments.length; i++) {
            var v = Number(arguments[i]);
            if (isFinite(v)) s += v * v;
        }
        return Math.sqrt(s);
    }

    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    /**
     * Dynamic viscosity of a hydrocarbon gas mixture, Lee-Gonzalez-Eakin (1966).
     *
     * compressor-eos.js carries no transport-property model, and the machine
     * Reynolds number of [SPT] Eq. 5 needs one. LGE is the standard natural-gas
     * correlation and is used here as the DEFAULT only - reducePoint() accepts
     * an explicit mu override.
     *
     * Worth knowing before worrying about its accuracy: the PTC-10 Fig. 3.5
     * check is on the RATIO Re_test / Re_design. Both sides run through the
     * same correlation with the same geometry, so a systematic bias in mu
     * largely cancels out of the check that actually decides anything.
     *
     * Returns Pa.s.
     */
    function gasViscosity(mix, T, P, model) {
        var rho = E.state(mix, T, P, model).rho;         // kg/m3
        var M = mix.MW;                                   // g/mol == lb/lbmol
        var Tr = T * 1.8;                                 // K -> deg R
        var K = (9.379 + 0.01607 * M) * Math.pow(Tr, 1.5) / (209.2 + 19.26 * M + Tr);
        var X = 3.448 + 986.4 / Tr + 0.01009 * M;
        var Y = 2.447 - 0.2224 * X;
        var rhoG = rho / 1000;                            // kg/m3 -> g/cm3
        var muCp = 1e-4 * K * Math.exp(X * Math.pow(rhoG, Y));
        return muCp * 1e-3;                               // cP -> Pa.s
    }

    /* =====================================================================
     * 4. Station averaging - [SPT] p.25 "Measurement Philosophy"
     * ---------------------------------------------------------------------
     * Verbatim from the paper:
     *
     *   "Where several independent instruments are used to measure a pressure
     *    or temperature value, the value of that pressure or temperature used
     *    for the evaluation will be the arithmetic average of the individual
     *    instrument's readings scanned at the same instant. Where FOUR
     *    independent instruments are used [...] and one recorded observation is
     *    inconsistent due to measurement error, its value will be dismissed and
     *    the value of the measurement are determined from the average of the
     *    other three. Where FEWER THAN FOUR independent measurement devices are
     *    used, all values shall be used and averaged."
     *
     * The discard is therefore licensed at exactly four readings and nowhere
     * else - which is also why Table 2 asks for four at every compressor
     * pressure and temperature station.
     * ===================================================================== */

    function averageStations(readings, o) {
        o = o || {};
        var vals = (readings || []).map(Number).filter(isFinite);
        var n = vals.length;
        if (!n) return { mean: NaN, used: [], discarded: null, spread: NaN, n: 0, notes: ['No readings entered.'] };

        var notes = [];
        var used = vals.slice();
        var discarded = null;

        if (n === 4) {
            /* Identify the most inconsistent reading: the one furthest from the
               median of the other three. Only dismiss it when it is a genuine
               outlier - the paper licenses dismissal for "measurement error",
               not for trimming a spread that is really thermal stratification.
               The trigger is a reading further than `outlierK` sample standard
               deviations from the mean of the remaining three. */
            var k = o.outlierK > 0 ? o.outlierK : 2.5;
            var relFloor = o.relFloor > 0 ? o.relFloor : 0.005;   // 0.5 % of the station mean
            var best = -1, bestDev = 0, bestAbs = 0, bestRest = 0;
            for (var i = 0; i < 4; i++) {
                var rest = vals.filter(function (_, j) { return j !== i; });
                var m = mean(rest), sd = stdev(rest);
                if (sd > 0) {
                    var dev = Math.abs(vals[i] - m) / sd;
                    if (dev > bestDev) {
                        bestDev = dev; best = i; bestAbs = Math.abs(vals[i] - m); bestRest = m;
                    }
                }
            }
            /* Two conditions must BOTH hold before a reading is dismissed. The
               sigma test alone is unusable here: with only three readings left,
               the sample standard deviation is so noisy that on a tight, healthy
               station (say 100.0 / 100.1 / 99.9 / 100.05) one reading always
               looks like a 3-sigma outlier. The relative floor is what separates
               "measurement error", which [SPT] p.25 licenses dismissing, from
               ordinary station non-uniformity, which p.19 says is real and must
               NOT be trimmed away — more probes reduce that bias, discarding
               data only hides it. */
            var farEnough = bestRest !== 0
                ? bestAbs / Math.abs(bestRest) >= relFloor
                : bestAbs > 0;
            if (best >= 0 && bestDev >= k && farEnough) {
                discarded = { index: best, value: vals[best], sigma: bestDev };
                used = vals.filter(function (_, j) { return j !== best; });
                notes.push('Reading ' + (best + 1) + ' dismissed as inconsistent (' +
                    bestDev.toFixed(1) + ' sigma and ' +
                    (bestAbs / Math.abs(bestRest) * 100).toFixed(2) + ' % from the other three); ' +
                    'averaged over the remaining three per [SPT] p.25.');
            } else if (best >= 0 && bestDev >= k) {
                notes.push('The widest reading sits ' + bestDev.toFixed(1) + ' sigma from the ' +
                    'other three but only ' + (bestAbs / Math.abs(bestRest) * 100).toFixed(2) +
                    ' % away — that is station non-uniformity, not measurement error, so all ' +
                    'four readings are kept ([SPT] p.19).');
            }
        } else if (n < 4) {
            notes.push('Fewer than four instruments at this station - [SPT] p.25 requires ' +
                'all ' + n + ' readings to be used and averaged; no reading may be dismissed.');
        } else {
            notes.push(n + ' readings averaged. The dismiss-one rule of [SPT] p.25 is written ' +
                'for exactly four instruments and is not applied here.');
        }

        var m2 = mean(used);
        var spread = used.length > 1 ? Math.max.apply(null, used) - Math.min.apply(null, used) : 0;

        /* A wide spread that survives the outlier test is physical, not an
           instrument fault: [SPT] p.19 notes the pressure distribution across
           the pipe is non-uniform and not known, and discharge volutes leave a
           markedly non-uniform temperature field. Multiple probes improve the
           bias but do not eliminate it. */
        var strat = null;
        if (o.stratLimit > 0 && spread > o.stratLimit) {
            strat = 'Spread across the station is ' + spread.toPrecision(3) +
                ', wider than the ' + o.stratLimit + ' expected. This is bias, not scatter: ' +
                'a volute leaves a non-uniform pressure and temperature field, and more probes ' +
                'reduce but never remove it ([SPT] p.19).';
            notes.push(strat);
        }

        return { mean: m2, used: used, discarded: discarded, spread: spread, n: n, stratification: strat, notes: notes };
    }

    /* =====================================================================
     * 5. Steady state - [SPT] p.24
     * ---------------------------------------------------------------------
     * The paper's gate, which it describes as "significantly lower than the
     * limits in other specifications [...] but it is achievable in practice".
     * Over a 10-minute interval, with at least three data sets per point:
     *   - operating speed constant within 5 rpm
     *   - efficiency within +/- 0.5 POINTS of the average
     *   - head and actual flow each within +/- 0.5 % of the average
     *
     * This matters more than it looks. [SPT] p.4 and p.12: if the process is
     * not steady, storage effects break the conservation equations that the
     * whole reduction rests on - the numbers are not merely noisier, they are
     * answering a different question.
     *
     * samples: [{ t_s, N_rpm, etaP, head, flow, power }]
     * ===================================================================== */

    function steadyState(samples, o) {
        o = o || {};
        var lim = o.limits || SAT_REFS.steady;
        var s = (samples || []).filter(function (r) { return r && isFinite(r.t_s); });
        var checks = [];
        var res = { ok: true, checks: checks, nSets: s.length, notes: [] };

        if (s.length < 2) {
            res.ok = false;
            res.notes.push('At least two samples are needed to judge steadiness.');
            return res;
        }

        var span = Math.max.apply(null, s.map(function (r) { return r.t_s; })) -
                   Math.min.apply(null, s.map(function (r) { return r.t_s; }));

        function band(label, key, tol, kind) {
            var v = s.map(function (r) { return Number(r[key]); }).filter(isFinite);
            if (!v.length) {
                checks.push({ label: label, ok: null, note: 'not recorded' });
                return null;
            }
            var m = mean(v);
            var range = Math.max.apply(null, v) - Math.min.apply(null, v);
            /* [SPT] p.24 words the speed criterion differently from the others:
               "Operating speed constant within five rpm" is a bound on the RANGE,
               while efficiency, head and flow are bounded "from average". Reading
               the speed limit as a deviation from the mean would silently double
               the window it actually allows. */
            var dev = kind === 'range'
                ? range
                : Math.max(Math.abs(Math.max.apply(null, v) - m), Math.abs(m - Math.min.apply(null, v)));
            var devShown = kind === 'pct' ? (m ? dev / Math.abs(m) * 100 : 0)
                         : kind === 'points' ? dev * 100
                         : dev;
            var ok = devShown <= tol + 1e-9;
            if (!ok) res.ok = false;
            checks.push({
                label: label, mean: m, deviation: devShown, tol: tol, ok: ok,
                unit: kind === 'pct' ? '%' : kind === 'points' ? 'points' : '',
                basis: kind === 'range' ? 'full range' : 'from average',
                spread: range
            });
            return { mean: m, dev: devShown };
        }

        band('Operating speed', 'N_rpm', lim.speed_rpm, 'range');
        band('Polytropic efficiency', 'etaP', lim.etaPoints, 'points');
        band('Polytropic head', 'head', lim.headPct, 'pct');
        band('Actual inlet flow', 'flow', lim.flowPct, 'pct');
        var pw = band('Absorbed power', 'power', 100, 'pct');   // reported, not gated here

        /* Interval length and set count are part of the same requirement. */
        var windowOK = span >= lim.window_s - 1;
        checks.push({
            label: 'Sampling interval', mean: span, deviation: span, tol: lim.window_s,
            ok: windowOK, unit: 's', isWindow: true
        });
        if (!windowOK) {
            res.ok = false;
            res.notes.push('Data covers ' + Math.round(span) + ' s; [SPT] p.24 asks for a ' +
                lim.window_s + ' s (10-minute) interval per test point.');
        }
        if (s.length < lim.setsPerPoint) {
            res.ok = false;
            res.notes.push('Only ' + s.length + ' data sets; [SPT] p.24 requires at least ' +
                lim.setsPerPoint + ', all readings scanned at the same instant.');
        }

        /* Power fluctuation drives the ISO 5389 Table 4 penalty. */
        res.powerFluctuation_pct = pw ? pw.dev : 0;
        res.unsteadyPenalty_pct = unsteadyPenalty(res.powerFluctuation_pct);
        return res;
    }

    /**
     * ISO 5389-1992 Table 4 ([SPT] p.20): added uncertainty on absorbed power
     * as a function of the power fluctuation about the mean. Linearly
     * interpolated between the tabulated points, held flat above 5 %.
     *
     * The paper immediately qualifies its own table: "Practical experience
     * shows that deviations due to unsteady operation are underestimated by the
     * data given in [5]. Any fluctuation in power higher than about 0.5 % will
     * add to the uncertainty of the results." The `advisory` flag carries that.
     */
    function unsteadyPenalty(fluctPct) {
        var t = SAT_REFS.unsteady;
        var f = Number(fluctPct) || 0;
        var add;
        if (f <= t[0][0]) add = t[0][1];
        else if (f >= t[t.length - 1][0]) add = t[t.length - 1][1];
        else {
            add = t[t.length - 1][1];
            for (var i = 1; i < t.length; i++) {
                if (f <= t[i][0]) {
                    var x0 = t[i - 1][0], y0 = t[i - 1][1], x1 = t[i][0], y1 = t[i][1];
                    add = y0 + (f - x0) / (x1 - x0) * (y1 - y0);
                    break;
                }
            }
        }
        return add;
    }

    function unsteadyAdvisory(fluctPct) {
        return Number(fluctPct) > 0.5
            ? SAT_REFS.unsteadyNote
            : null;
    }

    /* =====================================================================
     * 6. Data reduction - [SPT] "Data Reduction", pp.9-12, Eqs. 1-14
     * ---------------------------------------------------------------------
     * Everything real-gas, through compressor-eos.js, using the SAME EOS the
     * prediction used ([SPT] p.13 / ISO 5389). The equations, in the paper's
     * numbering:
     *
     *   (7)  rho = p / (Z(p,T) . R . T)
     *   (6)  Q_s = W / rho_s
     *   (8)  H*  = h(p_d, s = s_s) - h(p_s, T_s)            isentropic head
     *   (9)  H   = h(p_d, T_d)     - h(p_s, T_s)            actual head
     *   (10) H_p = eta_p . H
     *   (11) eta_isen = H_isen / H ,  eta_p = H_p / H
     *   (12) P_g = rho_1 . Q_1 . H                          gas power
     *   (14) P   = P_g / eta_m                              brake power
     *
     *   (1)  phi   = Q_1 / (u_tip . D^2 . pi/4)
     *   (2)  psi   = 2 H / u_tip^2         (isentropic or polytropic)
     *   (3)  Q_1/Q_2 maintained  =>  same exit velocity triangle
     *   (4)  Ma_u  = u_tip / sqrt(k Z R T)
     *   (5)  Re_u  = D_tip . N . b_tip / nu       <- TIP WIDTH b, not diameter
     *
     * Two points the paper is emphatic about and this function honours:
     *
     *  - It is the ACTUAL head H (Eq. 9) that determines absorbed power, and H
     *    is indifferent to whether you frame the comparison as polytropic or
     *    isentropic ([SPT] p.11). The isentropic head is unambiguously fixed by
     *    the process data; the polytropic head additionally needs the
     *    efficiency or the discharge temperature. So H* is reported as the
     *    unambiguous quantity and H_p as the derived one.
     *
     *  - eta_p comes from "an iterative process" ([SPT] Eq. 10 and refs
     *    [9-12], Huntington / Sandberg-Colby / Evans-Huble), and different
     *    methods disagree. Two independent routes are therefore computed and
     *    their spread reported rather than one being quietly chosen:
     *      * Schultz, straight from the measured endpoints (no iteration);
     *      * the stepwise integral of v.dP, iterated on eta_p until the path
     *        reproduces the MEASURED discharge temperature.
     *    A wide spread is itself information about how far the gas is from
     *    ideal, exactly as the head-method cross-check on the Results tab.
     * ===================================================================== */

    function reducePoint(o) {
        var mix = o.mix, model = o.model || 'PR';
        var p1 = o.p1, T1 = o.T1, p2 = o.p2, T2 = o.T2;
        var W = o.W, N = o.N;
        var etaMech = o.etaMech > 0 ? o.etaMech : 0.985;

        if (!(p1 > 0) || !(p2 > 0)) throw new Error('Suction and discharge pressure must both be positive absolute values.');
        if (!(p2 > p1)) throw new Error('Discharge pressure must exceed suction pressure — check the station averages and the gauge/absolute basis.');
        if (!(T1 > 0) || !(T2 > 0)) throw new Error('Suction and discharge temperature must be absolute (K) and positive.');
        if (!(W > 0)) throw new Error('Mass flow must be greater than zero.');

        var warn = [];

        /* --- states, Eq. (7) ------------------------------------------- */
        var s1 = E.state(mix, T1, p1, model);
        var s2 = E.state(mix, T2, p2, model);
        var d1 = E.derived(mix, T1, p1, model);

        var rho1 = s1.rho, rho2 = s2.rho;
        var Q1 = W / rho1, Q2 = W / rho2;                        // Eq. (6), m3/s
        var volRatio = Q1 / Q2;                                  // Eq. (3)

        /* --- heads, Eqs. (8) and (9) ----------------------------------- */
        var H = s2.hMass - s1.hMass;                             // Eq. (9) J/kg
        if (!(H > 0)) {
            throw new Error('Measured enthalpy rise is not positive — the discharge state is ' +
                'colder than an isothermal compression would leave it. Check the temperature ' +
                'readings and the EOS selection before going further.');
        }
        var T2s = E.solveTfromS(mix, p2, s1.s, model, T2);
        var s2s = E.state(mix, T2s, p2, model);
        var Hisen = s2s.hMass - s1.hMass;                        // Eq. (8) J/kg
        var etaIsen = Hisen / H;                                 // Eq. (11)

        /* --- polytropic, route 1: Schultz from measured endpoints ------- */
        var sch = E.schultzHead(mix, { inlet: s1, outlet: s2, isenOutlet: s2s });
        var HpSchultz = sch.Hp;
        var etaPSchultz = HpSchultz / H;

        /* --- polytropic, route 2: integral of v.dP, iterated on eta_p so
               that the path lands on the MEASURED discharge temperature ---- */
        var pathRes = solveEtaFromT2(mix, T1, p1, p2, T2, model, o.pathSteps || 40);
        var HpPath = pathRes.Hp;
        var etaPPath = pathRes.etaP;

        var HpSpread = HpSchultz ? Math.abs(HpPath - HpSchultz) / HpSchultz * 100 : NaN;
        if (isFinite(HpSpread) && HpSpread > 1.0) {
            warn.push('Schultz and integrated-path polytropic head differ by ' +
                HpSpread.toFixed(2) + ' %. [SPT] Eq. 10 notes eta_p is method-dependent; ' +
                'agree the method with the other party before the test, not after.');
        }

        /* Eq. (10) is the definitional tie H_p = eta_p . H, satisfied by both
           routes by construction; kept explicit so the report can show it. */
        var Hp = HpSchultz;
        var etaP = etaPSchultz;

        /* --- power, Eqs. (12) and (14) --------------------------------- */
        var Pgas = rho1 * Q1 * H;                                // Eq. (12) W
        var Pshaft = Pgas / etaMech;                             // Eq. (14) W
        if (etaMech < SAT_REFS.mechEff.lo || etaMech > SAT_REFS.mechEff.hi) {
            warn.push('Mechanical efficiency ' + (etaMech * 100).toFixed(1) + ' % is outside the ' +
                (SAT_REFS.mechEff.lo * 100) + '-' + (SAT_REFS.mechEff.hi * 100) +
                ' % range [SPT] p.11 gives for bearing, seal and windage losses.');
        }

        /* --- non-dimensionals, Eqs. (1), (2), (4), (5) ------------------ */
        var D2 = o.D2, uTip = NaN, phi = NaN, psiIsen = NaN, psiPoly = NaN, Mau = NaN, Reu = NaN, mu1 = NaN;
        var psiIsenMachine = NaN, psiPolyMachine = NaN;
        var nStages = Math.max(1, Math.round(o.nStages || 1));
        if (D2 > 0 && N > 0) {
            uTip = Math.PI * D2 * N / 60;                        // m/s
            phi = Q1 / (uTip * D2 * D2 * PI4);                   // Eq. (1)

            /* [SPT] Eq. 2 is written for a stage: psi = 2H/u_tip^2 against the
               tip speed of THAT impeller. Feeding a multistage machine's total
               head into it returns a number several times any real head
               coefficient and puts the point nowhere near the predicted map. So
               the head is divided by the stage count when one is supplied, and
               the machine-level value is kept alongside for the record. */
            psiIsen = 2 * (Hisen / nStages) / (uTip * uTip);     // Eq. (2), per stage
            psiPoly = 2 * (Hp / nStages) / (uTip * uTip);        // Eq. (2), per stage
            psiIsenMachine = 2 * Hisen / (uTip * uTip);
            psiPolyMachine = 2 * Hp / (uTip * uTip);
            Mau = uTip / d1.sonic;                               // Eq. (4)

            /* Eq. (5) needs the impeller TIP WIDTH and a viscosity. b2 defaults
               to 5 % of D2 when not supplied - a representative medium-flow
               value, and one that cancels out of the Fig. 3.5 ratio check as
               long as the same geometry is used on both sides. */
            var b2 = o.b2 > 0 ? o.b2 : 0.05 * D2;
            mu1 = o.mu > 0 ? o.mu : gasViscosity(mix, T1, p1, model);
            Reu = rho1 * uTip * b2 / mu1;
        }

        return {
            /* states */
            inlet: s1, outlet: s2, isenOutlet: s2s, inletDerived: d1,
            rho1: rho1, rho2: rho2, T2s: T2s,
            /* flows */
            W: W, Q1: Q1, Q2: Q2, volRatio: volRatio,
            /* heads and efficiencies */
            H: H, Hisen: Hisen, Hp: Hp,
            HpSchultz: HpSchultz, HpPath: HpPath, HpSpread_pct: HpSpread,
            etaIsen: etaIsen, etaP: etaP,
            etaPSchultz: etaPSchultz, etaPPath: etaPPath,
            schultz: sch,
            /* power */
            Pgas: Pgas, Pshaft: Pshaft, etaMech: etaMech,
            /* non-dimensional */
            N: N, D2: D2, nStages: nStages, uTip: uTip, phi: phi,
            psiIsen: psiIsen, psiPoly: psiPoly,
            psiIsenMachine: psiIsenMachine, psiPolyMachine: psiPolyMachine,
            Mau: Mau, Reu: Reu, mu: mu1,
            /* housekeeping */
            model: model, warnings: warn
        };
    }

    /**
     * Find the polytropic efficiency whose v.dP path from (p1,T1) to p2 lands
     * on the measured discharge temperature. Secant with a bisection fallback -
     * T2(eta_p) is monotone decreasing, so the bracket is safe.
     */
    function solveEtaFromT2(mix, T1, p1, p2, T2meas, model, steps) {
        function T2of(eta) {
            return E.compressPath(mix, T1, p1, p2, eta, model, steps).T2;
        }
        var lo = 0.20, hi = 0.999;
        var fLo = T2of(lo) - T2meas, fHi = T2of(hi) - T2meas;
        var eta;
        if (fLo * fHi > 0) {
            /* Measured T2 outside the achievable band: clamp to the nearer end
               and say so rather than returning a silently wrong number. */
            eta = Math.abs(fLo) < Math.abs(fHi) ? lo : hi;
        } else {
            var a = lo, b = hi;
            for (var i = 0; i < 60; i++) {
                var m = 0.5 * (a + b);
                var fm = T2of(m) - T2meas;
                if (Math.abs(fm) < 1e-4) { a = b = m; break; }
                if ((T2of(a) - T2meas) * fm <= 0) b = m; else a = m;
            }
            eta = 0.5 * (a + b);
        }
        var path = E.compressPath(mix, T1, p1, p2, eta, model, steps);
        return { etaP: eta, Hp: path.Hp, path: path, T2Achieved: path.T2 };
    }

    /* =====================================================================
     * 7. Multi-section and multi-body roll-up - [SPT] p.12, Eq. (15)
     * ---------------------------------------------------------------------
     *   P = (1/eta_m) . SUM(i=1..n) P_G,Section_i
     *
     * "This relationship is valid, as long as all flows in and out of the
     *  system are considered. Internal leakage does not affect it."
     *
     * The trap the paper flags: leakage across the division wall does not touch
     * the TOTAL power, but it does skew the observed SECTION efficiencies -
     * "too high for the first section and too low for the second section, or
     * vice versa". So the roll-up is trustworthy while the per-section split
     * carries a health warning whenever leakage has been estimated rather than
     * measured.
     * ===================================================================== */

    function rollUpSections(sections, o) {
        o = o || {};
        var etaMech = o.etaMech > 0 ? o.etaMech : 0.985;
        var Pg = 0, notes = [];
        (sections || []).forEach(function (s) { Pg += (s.Pgas || 0); });
        var P = Pg / etaMech;                                    // Eq. (15)

        if ((sections || []).length > 1) {
            if (o.leakageMeasured) {
                notes.push('Division-wall leakage measured from three flows (first-section ' +
                    'inlet, first-section discharge, second-section inlet) per [SPT] p.12.');
            } else {
                notes.push('Division-wall leakage ESTIMATED, not measured. Total power is ' +
                    'unaffected ([SPT] Eq. 15), but the per-section efficiency split is ' +
                    'skewed — too high for one section and too low for the other. Treat the ' +
                    'section efficiencies as indicative and the total as the acceptance value.');
            }
            if (o.hasSideStream) {
                notes.push('Side-stream flows must be measured separately ([SPT] p.12).');
            }
        }
        return { Pgas: Pg, Pshaft: P, etaMech: etaMech, nSections: (sections || []).length, notes: notes };
    }

    /**
     * Multi-BODY train: each compressor is instrumented and evaluated on its
     * own design point, then the powers are summed ([SPT] p.12) - site
     * conditions rarely let two or three bodies sit at their respective design
     * points simultaneously, so a train-level "design point" is a fiction.
     */
    function rollUpBodies(bodies, o) {
        var P = 0, allInstrumented = true;
        (bodies || []).forEach(function (b) {
            P += (b.Pshaft || 0);
            if (!b.fullyInstrumented) allInstrumented = false;
        });
        return {
            Pshaft: P, nBodies: (bodies || []).length, allInstrumented: allInstrumented,
            note: allInstrumented
                ? 'All bodies fully instrumented — the train power requirement, and so the ' +
                  'power generated by the driver, is determined ([SPT] p.12).'
                : 'Not every body is fully instrumented, so the train power — and any driver ' +
                  'output inferred from it — cannot be closed ([SPT] p.12).'
        };
    }

    /* =====================================================================
     * 8. Driver-side power - the second, independent determination
     * ---------------------------------------------------------------------
     * [SPT] p.20: "Direct measurement of the output power of mechanical drives
     * is possible if a torque measuring device is used with the coupling,
     * otherwise the test must use a heat balance around the driven equipment to
     * determine the output power."
     *
     * p.32: "For electric motor driven compressors, the motor, gearbox and VFD
     * efficiencies can be used to compare the measured electric power
     * consumption to the absorbed compressor power."
     *
     * Each route returns the same shape so reconcile() can treat them alike:
     *   { P_shaft (W), u_pct, method, ok, notes[] }
     * ===================================================================== */

    function driverPower(o) {
        o = o || {};
        var r = o.reading || {};
        var kind = o.driver || 'motor_ind';

        /* A torque meter on the coupling is the only DIRECT measurement of
           shaft power and takes precedence whenever it is fitted, whatever the
           driver is. Table 3 puts the whole chain at 0.5-1.5 % of value. */
        if (r.torque_Nm > 0 && r.N_rpm > 0) {
            var P = r.torque_Nm * r.N_rpm * RAD;
            return {
                P_shaft: P,
                u_pct: r.torqueAcc_pct > 0 ? r.torqueAcc_pct : SAT_REFS.accuracy.torque.hi,
                method: 'Coupling torque meter, P = tau . omega',
                direct: true, ok: true,
                notes: ['Direct shaft-power measurement — the only route that does not depend ' +
                        'on a heat balance or an assumed efficiency chain ([SPT] p.20). ' +
                        'Table 3 chain accuracy 0.5–1.5 % of value.']
            };
        }

        if (kind === 'motor_ind' || kind === 'motor_sync') return motorPower(r, o);
        if (kind === 'steam') return steamPower(r, o);
        if (kind === 'gasturbine') return gtPower(r, o);

        return { P_shaft: NaN, u_pct: NaN, method: 'unknown driver', ok: false,
                 notes: ['Driver kind "' + kind + '" not recognised.'] };
    }

    /**
     * Electric motor: shaft power from measured electrical input through the
     * efficiency chain [SPT] p.32 names - motor, gearbox and VFD.
     *
     *   P_shaft = P_elec . eta_motor(load) . eta_VFD . eta_gear
     *
     * eta_motor is interpolated across the user's 50/75/100 % load triplet,
     * because motor efficiency is distinctly not flat at part load and a site
     * test point is often well below nameplate.
     */
    function motorPower(r, o) {
        var notes = [];
        var Pelec = r.elecPower_W;

        /* Fall back to the three-phase form when only V, I and PF are logged. */
        if (!(Pelec > 0) && r.volts > 0 && r.amps > 0) {
            var pf = r.powerFactor > 0 ? r.powerFactor : 0.9;
            Pelec = Math.sqrt(3) * r.volts * r.amps * pf;
            notes.push('Electrical input computed as sqrt(3).V.I.PF from ' + r.volts + ' V, ' +
                r.amps + ' A, PF ' + pf.toFixed(3) + '.');
        }
        if (!(Pelec > 0)) {
            return { P_shaft: NaN, u_pct: NaN, method: 'Motor electrical input', ok: false,
                     notes: ['No electrical power reading — enter metered kW, or V, I and power factor.'] };
        }

        var rated = o.ratedPower_W > 0 ? o.ratedPower_W : NaN;
        var loadFrac = isFinite(rated) && rated > 0 ? Pelec / rated : NaN;
        var etaM = motorEtaAtLoad(r, loadFrac, notes);
        var etaVfd = r.vfd ? (r.etaVfd > 0 ? r.etaVfd : 0.97) : 1;
        var etaGear = r.etaGear > 0 ? r.etaGear : 1;

        var P = Pelec * etaM * etaVfd * etaGear;

        if (r.vfd) {
            notes.push('VFD in circuit at eta ' + (etaVfd * 100).toFixed(1) + ' %. If the meter ' +
                'sits on the drive OUTPUT the waveform is non-sinusoidal and a conventional ' +
                'power meter will misread it — meter on the drive INPUT and carry the drive ' +
                'efficiency, or use a true-RMS wideband meter.');
        }
        if (etaGear < 1) notes.push('Gearbox efficiency ' + (etaGear * 100).toFixed(2) + ' % applied ([SPT] p.32).');

        /* The efficiency chain is the dominant uncertainty here, not the
           wattmeter: nameplate efficiencies are typically stated to a tolerance
           far wider than the meter's. */
        var uElec = r.elecAcc_pct > 0 ? r.elecAcc_pct : 1.0;
        var uEta = r.etaAcc_pct > 0 ? r.etaAcc_pct : 1.5;
        notes.push('Uncertainty is dominated by the efficiency chain, not the wattmeter — ' +
            'this route is a cross-check on the gas-power heat balance, not a substitute for it.');

        return {
            P_shaft: P, u_pct: rss(uElec, uEta),
            method: 'Motor electrical input x motor/VFD/gear efficiency',
            direct: false, ok: true,
            Pelec: Pelec, etaMotor: etaM, etaVfd: etaVfd, etaGear: etaGear, loadFrac: loadFrac,
            notes: notes
        };
    }

    /** Motor efficiency at the actual load from a 50/75/100 % triplet. */
    function motorEtaAtLoad(r, loadFrac, notes) {
        var e50 = r.etaMotor50, e75 = r.etaMotor75, e100 = r.etaMotor100;
        var have = [e50, e75, e100].filter(function (v) { return v > 0; }).length;
        if (have === 0) {
            if (r.etaMotor > 0) return r.etaMotor;
            notes.push('No motor efficiency entered — 96 % assumed. Enter the nameplate ' +
                '50/75/100 % load efficiencies to make this route meaningful.');
            return 0.96;
        }
        if (have < 3 || !isFinite(loadFrac)) {
            var single = e100 > 0 ? e100 : (e75 > 0 ? e75 : e50);
            if (!isFinite(loadFrac)) {
                notes.push('Motor rated power unknown, so the load fraction cannot be found — ' +
                    'the full-load efficiency is used unadjusted.');
            }
            return single;
        }
        var f = clamp(loadFrac, 0.5, 1.0);
        var eta = f <= 0.75
            ? e50 + (f - 0.50) / 0.25 * (e75 - e50)
            : e75 + (f - 0.75) / 0.25 * (e100 - e75);
        notes.push('Motor efficiency ' + (eta * 100).toFixed(2) + ' % interpolated at ' +
            (f * 100).toFixed(0) + ' % load from the 50/75/100 % triplet.');
        return eta;
    }

    /**
     * Steam turbine: shaft power from the measured steam mass flow and the
     * actual enthalpy drop across the machine, using the pure-H2O EOS path
     * already in compressor-train.js.
     *
     * The honest limitation, surfaced rather than hidden: once the exhaust is
     * inside the wet dome, pressure and temperature are no longer independent,
     * so h_exhaust cannot be recovered from measured p and T alone. Without a
     * calorimeter or a measured quality the route has to be demoted.
     */
    function steamPower(r, o) {
        var notes = [];
        var T = trainEng();
        if (!T || !T.steamTurbine) {
            return { P_shaft: NaN, u_pct: NaN, method: 'Steam turbine enthalpy drop', ok: false,
                     notes: ['compressor-train.js is not loaded, so the steam path is unavailable.'] };
        }
        if (!(r.steamFlow_kgs > 0)) {
            return { P_shaft: NaN, u_pct: NaN, method: 'Steam turbine enthalpy drop', ok: false,
                     notes: ['No steam mass flow reading.'] };
        }

        var st;
        try {
            st = T.steamTurbine({
                Pin_Pa: r.steamPin_Pa, Tin_K: r.steamTin_K, Pexh_Pa: r.steamPexh_Pa,
                power_W: o.expectedPower_W || 0
            });
        } catch (e) {
            return { P_shaft: NaN, u_pct: NaN, method: 'Steam turbine enthalpy drop', ok: false,
                     notes: ['Steam expansion failed: ' + (e.message || e)] };
        }

        if (st.wetExhaust) {
            notes.push('Exhaust is inside the wet dome (quality ' +
                (st.exhaustQuality != null ? (st.exhaustQuality * 100).toFixed(1) + ' %' : 'unknown') +
                '). Pressure and temperature are not independent there, so the exhaust enthalpy ' +
                'cannot be recovered from p and T alone — this route needs a measured quality or ' +
                'a throttling calorimeter before it can carry any weight.');
        }

        var dh = st.dhIsen * (r.etaTurbine > 0 ? r.etaTurbine : st.eta);
        var P = r.steamFlow_kgs * dh;
        notes.push('Isentropic drop ' + (st.dhIsen / 1000).toFixed(1) + ' kJ/kg at eta ' +
            ((r.etaTurbine > 0 ? r.etaTurbine : st.eta) * 100).toFixed(1) + ' %.');

        return {
            P_shaft: P,
            u_pct: rss(r.steamFlowAcc_pct > 0 ? r.steamFlowAcc_pct : 2.0, 2.5),
            method: 'Steam mass flow x actual enthalpy drop',
            direct: false, ok: !st.wetExhaust,
            steam: st, notes: notes
        };
    }

    /**
     * Gas turbine without a torque meter: the fuel heat balance.
     *
     *   P_shaft = W_fuel . LHV . eta_thermal
     *
     * [SPT] p.20 is blunt about why this is the weaker route: "The airflow of
     * the gas turbine cannot be measured accurately in the field. Therefore,
     * the actual combustion control temperature cannot be determined with
     * accuracy so there is uncertainty whether the gas turbine is operating at
     * the rated turbine inlet temperature."
     *
     * Which is why, for a GT-driven train, the paper inverts the usual
     * hierarchy: the COMPRESSOR is the load cell. "Gas turbine output power can
     * be measured using the driven compressors" ([SPT] p.8).
     */
    function gtPower(r, o) {
        var notes = [];
        if (!(r.fuelFlow_kgs > 0) || !(r.fuelLHV_Jkg > 0)) {
            return { P_shaft: NaN, u_pct: NaN, method: 'Gas turbine fuel heat balance', ok: false,
                     notes: ['Fuel mass flow and lower heating value are both needed for the fuel ' +
                             'heat balance. With neither a torque meter nor fuel metering, the ' +
                             'compressor gas power is the only determination available — which is ' +
                             'exactly how [SPT] p.8 measures GT output.'] };
        }
        var fuelPower = r.fuelFlow_kgs * r.fuelLHV_Jkg;
        var etaTh = r.etaThermal > 0 ? r.etaThermal : NaN;
        if (!isFinite(etaTh)) {
            return { P_shaft: NaN, u_pct: NaN, method: 'Gas turbine fuel heat balance', ok: false,
                     fuelPower_W: fuelPower,
                     notes: ['Fuel energy flow is ' + (fuelPower / 1e6).toFixed(2) + ' MW, but the ' +
                             'engine thermal efficiency at this point is unknown. Take it from the ' +
                             'cycle deck at the test conditions ([SPT] Step 3, p.9) — this is the ' +
                             'heat-rate comparison, not an independent power measurement.'] };
        }
        notes.push('Fuel energy flow ' + (fuelPower / 1e6).toFixed(2) + ' MW at thermal efficiency ' +
            (etaTh * 100).toFixed(1) + ' %.');
        notes.push('Field airflow cannot be measured accurately, so firing temperature — and ' +
            'therefore whether the engine is truly at rated TIT — carries real uncertainty ' +
            '([SPT] p.20). Cross-check against the compressor gas power.');
        return {
            P_shaft: fuelPower * etaTh,
            u_pct: rss(r.fuelAcc_pct > 0 ? r.fuelAcc_pct : 1.0, 2.0),
            method: 'Gas turbine fuel heat balance, P = W_fuel . LHV . eta_th',
            direct: false, ok: true, fuelPower_W: fuelPower, notes: notes
        };
    }

    /* =====================================================================
     * 9. Gas turbine full-load validity - [SPT] pp.15, 26, 32
     * ---------------------------------------------------------------------
     * A full-load GT power number means nothing unless the engine was actually
     * ON its control limit. p.15: "it must be ensured that the gas turbine
     * operates at its maximum load. In other words, the engine has to run at
     * its control limits (usually gas producer speed or firing temperature),
     * and the output is not limited by other reasons such as low fuel gas
     * pressure or because the compressor cannot absorb all power due to its own
     * speed limit."
     * ===================================================================== */

    function gtFullLoadValid(o) {
        o = o || {};
        var checks = [], ok = true;

        function add(label, pass, detail) {
            if (pass === false) ok = false;
            checks.push({ label: label, ok: pass, detail: detail });
        }

        var atLimit = !!(o.atGgSpeedLimit || o.atFiringTempLimit);
        add('Engine on a control limit', atLimit,
            atLimit
                ? (o.atGgSpeedLimit ? 'Gas producer speed limit' : 'Firing temperature limit')
                : 'Neither the gas producer speed nor the firing temperature limit is reached — ' +
                  'the engine is not at full load and this point cannot rate it.');

        add('Not fuel-pressure limited', !o.fuelPressureLimited,
            o.fuelPressureLimited
                ? 'Output is capped by low fuel gas pressure, not by the engine.'
                : 'Fuel gas pressure adequate.');

        add('Not compressor-speed limited', !o.compressorSpeedLimited,
            o.compressorSpeedLimited
                ? 'The compressor has hit its own speed limit and cannot absorb full power — ' +
                  'load the engine with a different operating point.'
                : 'Compressor can absorb the available power.');

        add('Air compressor washed', !!o.airCompressorWashed,
            o.airCompressorWashed
                ? 'Washed immediately prior to the test.'
                : 'Engine performance with a fouled compressor is deemed INVALID ([SPT] p.26). ' +
                  'About ' + SAT_REFS.gtWashRecovery_pct + ' % or more engine power has been ' +
                  'recovered by washing ([SPT] p.27).');

        var need = (o.ratedPower_hp > 0 && o.ratedPower_hp < SAT_REFS.gtHeatSoak.smallBelow_hp)
            ? SAT_REFS.gtHeatSoak.small_h : SAT_REFS.gtHeatSoak.large_h;
        var soaked = o.heatSoak_h >= need;
        add('Heat soaked', soaked,
            'Soaked ' + (o.heatSoak_h || 0) + ' h against ' + need + ' h needed ' +
            '(about 1 h below ' + SAT_REFS.gtHeatSoak.smallBelow_hp + ' hp, 2 h or more above) ' +
            'to avoid drift ([SPT] p.32).');

        return { ok: ok, checks: checks };
    }

    /* =====================================================================
     * 10. Gas turbine correction - [SPT] Fig. 6 and the four steps, pp.8-9
     * ---------------------------------------------------------------------
     * "Gas turbine performance correction follows a different procedure, since
     *  similarity laws that can be applied do not exist." ([SPT] p.8)
     *
     * The whole method rests on one invariant, stated at Fig. 6: the PERCENT
     * DIFFERENCE between the test point and the engine performance curve is the
     * same at test conditions and at reference conditions. So the engine is
     * rated by its position RELATIVE TO ITS OWN CURVE, and that relative
     * position is what transfers between ambient conditions.
     *
     * Fuel consumption at the acceptance point, the four steps:
     *   1. load = P_acceptance / P_fullload(same ambient, same NPT/NPTopt)
     *   2. run the engine at that load at the prevailing test ambient; after
     *      stabilisation, measure the fuel energy flow
     *   3. ratio = fuel energy measured / fuel energy from the cycle deck at
     *      the SAME conditions as step 2
     *   4. run the cycle deck at the acceptance conditions and apply that ratio
     *
     * No cycle deck ships with this tool, so steps 3 and 4 take cycle-deck
     * output as input. Where the user has none, TrainEng.gasTurbine supplies a
     * clearly-labelled correlation fallback for the full-load rating only.
     * ===================================================================== */

    function gtCorrect(o) {
        o = o || {};
        var notes = [], steps = [];

        /* --- Step 1 ------------------------------------------------------ */
        var Pfull_ref = o.fullLoadPower_ref_W;
        var load = (Pfull_ref > 0) ? o.acceptancePower_W / Pfull_ref : NaN;
        steps.push({
            n: 1,
            text: 'Relative load at the acceptance point',
            detail: isFinite(load)
                ? (o.acceptancePower_W / 1e6).toFixed(3) + ' MW / ' + (Pfull_ref / 1e6).toFixed(3) +
                  ' MW = ' + (load * 100).toFixed(1) + ' %, at the same ambient conditions and the ' +
                  'same NPT/NPTopt ratio.'
                : 'Needs the full-load power at the acceptance ambient conditions.'
        });

        /* --- Step 2 ------------------------------------------------------ */
        var fuelMeas = o.fuelEnergyMeasured_W;
        steps.push({
            n: 2,
            text: 'Run at that load at the test ambient; measure fuel energy flow after stabilisation',
            detail: fuelMeas > 0
                ? (fuelMeas / 1e6).toFixed(3) + ' MW measured. Deviations in power turbine speed are allowed.'
                : 'Not yet measured.'
        });

        /* --- Step 3 ------------------------------------------------------ */
        var fuelDeckTest = o.fuelEnergyDeck_test_W;
        var ratio = (fuelMeas > 0 && fuelDeckTest > 0) ? fuelMeas / fuelDeckTest : NaN;
        steps.push({
            n: 3,
            text: 'Cycle deck at the TEST conditions; form the ratio',
            detail: isFinite(ratio)
                ? (fuelMeas / 1e6).toFixed(3) + ' / ' + (fuelDeckTest / 1e6).toFixed(3) + ' = ' +
                  ratio.toFixed(4) + ' — run at the same Tamb, pamb, RH, fuel and PT speed as step 2.'
                : 'Needs the cycle-deck fuel energy flow at the test conditions.'
        });

        /* --- Step 4 ------------------------------------------------------ */
        var fuelDeckRef = o.fuelEnergyDeck_ref_W;
        var fuelAtAcceptance = (isFinite(ratio) && fuelDeckRef > 0) ? ratio * fuelDeckRef : NaN;
        steps.push({
            n: 4,
            text: 'Cycle deck at the ACCEPTANCE conditions; apply the ratio',
            detail: isFinite(fuelAtAcceptance)
                ? ratio.toFixed(4) + ' x ' + (fuelDeckRef / 1e6).toFixed(3) + ' MW = ' +
                  (fuelAtAcceptance / 1e6).toFixed(3) + ' MW — the fuel energy consumption of the ' +
                  'tested engine at the acceptance conditions.'
                : 'Needs the cycle-deck fuel energy flow at the acceptance conditions.'
        });

        /* --- relative power and efficiency, the Fig. 6 invariant ---------- */
        var relPower = (o.testPower_W > 0 && o.fullLoadPower_test_W > 0)
            ? o.testPower_W / o.fullLoadPower_test_W : NaN;
        var relEff = (o.testThermalEff > 0 && o.predictedThermalEff > 0)
            ? o.testThermalEff / o.predictedThermalEff : NaN;

        if (isFinite(relPower)) {
            notes.push('Measured power is ' + (relPower * 100).toFixed(1) + ' % of the engine curve ' +
                'at the test conditions. Per [SPT] Fig. 6 that same percentage carries to the ' +
                'reference conditions — this is the correction.');
        }

        /* [SPT] p.31: the paper's own validation of the method was that points
           taken at 18.9 C and 28.6 C gave almost the same relative power and
           relative efficiency. If they had not, the method would be suspect. */
        if (o.relPowerOther > 0 && isFinite(relPower)) {
            var spread = Math.abs(relPower - o.relPowerOther) / relPower * 100;
            notes.push('Relative power at the two test ambients differs by ' + spread.toFixed(2) +
                ' %. [SPT] p.31 treats close agreement across ambient temperatures as ' +
                'confirmation of the correction methodology; a difference in excess of the test ' +
                'uncertainty would put the method itself in question.');
        }

        var fallback = null;
        if (!(fuelDeckTest > 0) && o.useCorrelationFallback) {
            var T = trainEng();
            if (T && T.gasTurbine) {
                fallback = T.gasTurbine({
                    isoRating_W: o.isoRating_W, altitude_m: o.altitude_m,
                    Tamb_K: o.Tamb_K, RH_pct: o.RH_pct, required_W: o.testPower_W
                });
                notes.push('No cycle-deck data entered. The site rating shown is the ' +
                    'compressor-train.js altitude/ambient/humidity CORRELATION, not a cycle deck — ' +
                    'adequate for a sanity check on available margin, not for a fuel-consumption ' +
                    'guarantee.');
            }
        }

        return {
            steps: steps, load: load, ratio: ratio,
            fuelAtAcceptance_W: fuelAtAcceptance,
            relPower: relPower, relEfficiency: relEff,
            correlationFallback: fallback, notes: notes
        };
    }

    /* =====================================================================
     * 11. Reconciliation - the data-validity gate
     * ---------------------------------------------------------------------
     * [SPT] pp.30, 32. Two independent determinations of the same shaft power
     * must agree within their combined uncertainty. When they do not, the
     * disagreement is not a tolerance question - it is evidence that one of the
     * measurements is wrong, and the paper's worked case says where to look:
     *
     *   "Initial measurement had shown significant discrepancies of 4.4 %
     *    between the two measurements. The differences were traced to a leaking
     *    valve and the calibration coefficient for the flow metering. After the
     *    corrections, the two independent results were nearly identical."
     * ===================================================================== */

    function reconcile(gasSide, driverSide, o) {
        o = o || {};
        var a = gasSide && gasSide.P_shaft > 0 ? gasSide : null;
        var b = driverSide && driverSide.P_shaft > 0 ? driverSide : null;

        if (!a || !b) {
            return {
                available: false,
                note: 'Only one determination of shaft power is available. [SPT] p.32 recommends ' +
                      'two independent measurements — the compressor gas power and either a ' +
                      'coupling torque meter or the driver-side power — precisely so that a ' +
                      'disagreement can expose an instrumentation fault before it is written into ' +
                      'the acceptance record.'
            };
        }

        var delta = b.P_shaft - a.P_shaft;
        var deltaPct = delta / a.P_shaft * 100;
        var uComb = rss(a.u_pct, b.u_pct);
        var ok = Math.abs(deltaPct) <= uComb;

        var causes = [];
        if (!ok) {
            /* Ranked the way a test engineer works the problem: the cheap,
               common faults first. Both of the paper's own findings sit at the
               top of the list. */
            causes = [
                { cause: 'Leaking or partially open valve',
                  detail: 'A recycle, bypass or block valve not fully shut sends flow round the ' +
                          'measurement. This was one of the two faults behind the 4.4 % gap in ' +
                          '[SPT] p.30. Check valve positions and the recycle valve reading.' },
                { cause: 'Flow-meter calibration coefficient',
                  detail: 'The other fault in the same case. Confirm the orifice discharge ' +
                          'coefficient / meter factor and the p, T used to reduce the flow — ' +
                          'the meter runs at its own pressure and temperature, not the ' +
                          'compressor inlet\'s ([SPT] p.9).' },
                { cause: 'Gas composition drift',
                  detail: 'Composition moves density, enthalpy and so both head and power. ' +
                          'Compare the samples taken at the start and end of the test.' },
                { cause: 'Discharge temperature stratification',
                  detail: 'A volute leaves a non-uniform exit temperature field; too few probes ' +
                          'bias the enthalpy rise and therefore the gas power ([SPT] p.15, p.19).' },
                { cause: 'Assumed efficiency chain on the driver side',
                  detail: 'Motor, VFD and gearbox efficiencies are nameplate values, not ' +
                          'measurements. On the GT side, field airflow is unmeasurable so firing ' +
                          'temperature is uncertain ([SPT] p.20).' },
                { cause: 'Mechanical losses',
                  detail: 'Bearing, seal and windage losses are assumed at ' +
                          (SAT_REFS.mechEff.lo * 100) + '-' + (SAT_REFS.mechEff.hi * 100) +
                          ' % ([SPT] p.11), not measured.' }
            ];
        }

        return {
            available: true,
            gasPower_W: a.P_shaft, driverPower_W: b.P_shaft,
            delta_W: delta, delta_pct: deltaPct,
            u_gas_pct: a.u_pct, u_driver_pct: b.u_pct, u_combined_pct: uComb,
            ok: ok,
            verdict: ok
                ? 'The two independent determinations agree within their combined uncertainty of ' +
                  uComb.toFixed(2) + ' %. Confidence in the test result is improved ([SPT] p.5).'
                : 'The two determinations differ by ' + deltaPct.toFixed(2) + ' %, outside the ' +
                  'combined uncertainty of ' + uComb.toFixed(2) + ' %. This is an instrumentation ' +
                  'or process finding, not a machine finding — resolve it before the data is used. ' +
                  'The reference case in [SPT] p.30 opened at ' + SAT_REFS.reconcileCase.gap_pct +
                  ' % and closed to near-identical once the cause was found.',
            causes: causes
        };
    }

    /* =====================================================================
     * 12. Curve-shape diagnosis - [SPT] p.32
     * ---------------------------------------------------------------------
     * "Determine the shape of the head-flow and flow efficiency curves and
     *  compare them with predictions. If the curves are just shifted to the
     *  left or right, the flow measurement is suspect. If some points of the
     *  curve match the predictions and others do not match, variations of the
     *  gas composition during the test could be the cause."
     *
     * Mechanised as a two-parameter fit: the measured curve is matched to the
     * prediction by a horizontal flow scale and a vertical head scale, and the
     * residual left over decides the reading.
     *
     *   measured: [{x, y}]     (flow, head - any consistent units)
     *   predicted: [{x, y}]    (the predicted curve, same units)
     * ===================================================================== */

    function diagnose(measured, predicted, o) {
        o = o || {};
        var m = (measured || []).filter(function (p) { return isFinite(p.x) && isFinite(p.y); });
        if (m.length < 3 || !(predicted || []).length) {
            return { ok: false, finding: 'insufficient-data',
                     text: 'At least three measured points and a predicted curve are needed to ' +
                           'judge curve shape.' };
        }

        function predAt(x) {
            var p = predicted;
            if (x <= p[0].x) return p[0].y;
            for (var i = 1; i < p.length; i++) {
                if (x <= p[i].x) {
                    var t = (x - p[i - 1].x) / (p[i].x - p[i - 1].x);
                    return p[i - 1].y + t * (p[i].y - p[i - 1].y);
                }
            }
            return p[p.length - 1].y;
        }

        function residual(xScale, yScale) {
            var s = 0, n = 0;
            for (var i = 0; i < m.length; i++) {
                var pv = predAt(m[i].x * xScale);
                if (!isFinite(pv) || pv === 0) continue;
                var r = (m[i].y * yScale - pv) / pv;
                s += r * r; n++;
            }
            return n ? Math.sqrt(s / n) : NaN;
        }

        /* Coarse-to-fine search over the flow scale and head scale. */
        var best = { x: 1, y: 1, r: residual(1, 1) };
        var raw = best.r;
        var step = 0.02, lo = 0.80, hi = 1.20;
        for (var pass = 0; pass < 3; pass++) {
            var bx = best.x, by = best.y;
            for (var xs = lo; xs <= hi + 1e-9; xs += step) {
                for (var ys = lo; ys <= hi + 1e-9; ys += step) {
                    var r = residual(xs, ys);
                    if (isFinite(r) && r < best.r) best = { x: xs, y: ys, r: r };
                }
            }
            lo = Math.min(best.x, best.y) - step * 2;
            hi = Math.max(best.x, best.y) + step * 2;
            step /= 5;
            if (best.x === bx && best.y === by && pass > 0) break;
        }

        var shiftPct = (best.x - 1) * 100;
        var scalePct = (best.y - 1) * 100;
        var explained = raw > 0 ? (1 - best.r / raw) : 0;
        var scatterTol = o.scatterTol > 0 ? o.scatterTol : 0.02;   // 2 % residual
        var shiftTol = o.shiftTol > 0 ? o.shiftTol : 1.5;          // 1.5 % flow shift

        var finding, text;

        if (raw <= scatterTol && Math.abs(shiftPct) <= shiftTol) {
            finding = 'agrees';
            text = 'Measured and predicted curves agree in both shape and position ' +
                   '(RMS residual ' + (raw * 100).toFixed(2) + ' %). Nothing to explain.';
        } else if (best.r > scatterTol && explained < 0.5) {
            finding = 'composition';
            text = 'The residual does not collapse under any single flow shift or head scale — ' +
                   'the points scatter individually (RMS ' + (best.r * 100).toFixed(2) + ' % after ' +
                   'the best fit, against ' + (raw * 100).toFixed(2) + ' % before). Per [SPT] p.32, ' +
                   'some points matching the prediction while others do not points at VARIATION OF ' +
                   'THE GAS COMPOSITION during the test. Compare the gas samples point by point.';
        } else if (Math.abs(shiftPct) > shiftTol && Math.abs(shiftPct) > Math.abs(scalePct)) {
            finding = 'flow';
            text = 'The whole curve sits ' + (shiftPct > 0 ? 'right' : 'left') + ' of the prediction ' +
                   'by ' + Math.abs(shiftPct).toFixed(2) + ' % in flow, with its shape preserved ' +
                   '(residual falls from ' + (raw * 100).toFixed(2) + ' % to ' +
                   (best.r * 100).toFixed(2) + ' %). Per [SPT] p.32 this indicts the FLOW ' +
                   'MEASUREMENT, not the machine. Check the meter factor, the orifice coefficient, ' +
                   'and the p and T used to reduce the meter reading.';
        } else if (Math.abs(scalePct) > 1.0) {
            finding = 'head';
            text = 'Shape and flow position match, but the head sits ' +
                   (scalePct > 0 ? 'below' : 'above') + ' prediction by ' +
                   Math.abs(scalePct).toFixed(2) + ' % across the whole curve. A uniform shortfall ' +
                   'with the shape intact points at machine condition — fouling, or clearances — ' +
                   'rather than at instrumentation ([SPT] p.27).';
        } else {
            finding = 'agrees';
            text = 'No single systematic explanation stands out; residual ' +
                   (raw * 100).toFixed(2) + ' %.';
        }

        return {
            ok: true, finding: finding, text: text,
            flowShift_pct: shiftPct, headScale_pct: scalePct,
            residualRaw: raw, residualFitted: best.r, explainedFraction: explained
        };
    }

    /* =====================================================================
     * 13. Fan-law validity - [SPT] Fig. 4 and p.7
     * ---------------------------------------------------------------------
     * "The limitations of the fan law are dictated by Mach number deviations in
     *  combination with the number of stages in the compressor (Figure 4).
     *  Pipeline compressors with usually only one or two impellers per body are
     *  typically less sensitive to deviations from the above parameters.
     *  Multistage machines show more sensitivity."
     *
     * So the gate is NOT the PTC-10 Fig. 3.3 band alone - stage count matters.
     * A one- or two-impeller body tolerates roughly the full code band; a
     * nine-stage machine does not. The scaling below is monotone in stage
     * count, anchored so that 1-2 stages gets the full band and it tightens
     * from there.
     * ===================================================================== */

    function fanLawValid(o) {
        o = o || {};
        var dMa = Number(o.dMa) || 0;
        var n = Math.max(1, Math.round(o.nStages || 1));
        var Md = o.Md > 0 ? o.Md : 0.6;

        var band = machLimits(Md);

        /* Stage-count factor: 1.0 for one or two impellers, falling as stages
           are added, floored so a very long machine still has a usable window.
           [SPT] Fig. 4 is qualitative, so this is an explicit engineering
           interpolation of it rather than a digitised curve - and is labelled
           as such wherever it is shown. */
        var f = n <= 2 ? 1.0 : clamp(1.0 - 0.10 * (n - 2), 0.35, 1.0);

        var up = band.up * f, lo = band.lo * f;
        var ok = dMa >= lo && dMa <= up;

        return {
            ok: ok, dMa: dMa, nStages: n,
            codeBand: band, effectiveBand: { up: up, lo: lo }, stageFactor: f,
            note: n <= 2
                ? 'One or two impellers per body — the full PTC-10 Fig. 3.3 band applies; ' +
                  '[SPT] p.7 notes such machines are the least sensitive to these deviations.'
                : n + ' stages — the usable Mach window is narrowed to ' + (f * 100).toFixed(0) +
                  ' % of the PTC-10 Fig. 3.3 band. [SPT] Fig. 4 makes fan-law validity a function ' +
                  'of Mach deviation AND stage count; multistage machines show more sensitivity. ' +
                  'The narrowing factor is an engineering interpolation of that figure, not a ' +
                  'digitised curve.',
            verdict: ok
                ? 'Fan-law correction is defensible at this Mach departure and stage count.'
                : 'Mach departure of ' + dMa.toFixed(3) + ' is outside the effective window (' +
                  lo.toFixed(3) + ' to ' + up.toFixed(3) + ') for a ' + n + '-stage machine. ' +
                  '[SPT] p.7: when the fan law no longer applies, "easy corrections for Mach ' +
                  'numbers and volume/flow ratios are not available" — have the OEM re-predict ' +
                  'the map for the actual test conditions instead.'
        };
    }

    /* =====================================================================
     * 14. PTC-10 deviation checks
     * ---------------------------------------------------------------------
     * Table 3.1 (Type 1 permissible deviation from specified) and the Table 3.2
     * similarity limits, plus the Fig. 3.3 / Fig. 3.5 bands.
     *
     * Reported as a BENCHMARK, deliberately. [SPT] p.4: "The ASME PTC 10 Type 1
     * definition for acceptable deviations between acceptance and test
     * conditions is a valid benchmark, but site performance tests often will
     * not fall within the defined limits, and allowance must be made for that
     * situation." A miss therefore returns level 'caution', not 'fail', and
     * says what it costs — extra systematic uncertainty, via a correction that
     * introduces its own error which grows with the deviation ([SPT] p.4).
     * ===================================================================== */

    function deviationCheck(o) {
        o = o || {};
        var t = o.test || {}, s = o.spec || {};
        var rows = [];

        function pctRow(label, key, tol, tv, sv) {
            if (!(isFinite(tv) && isFinite(sv) && sv !== 0)) return;
            var dev = (tv - sv) / sv * 100;
            rows.push({
                label: label, key: key, test: tv, spec: sv, dev_pct: dev, tol_pct: tol,
                ok: Math.abs(dev) <= tol, table: 'PTC-10 Table 3.1'
            });
        }

        pctRow('Inlet pressure', 'p1', 5, t.p1, s.p1);
        pctRow('Inlet temperature', 'T1', 8, t.T1, s.T1);
        pctRow('Speed', 'N', 2, t.N, s.N);
        pctRow('Molecular weight', 'MW', 2, t.MW, s.MW);
        pctRow('Capacity', 'Q1', 4, t.Q1, s.Q1);

        /* Table 3.2 similarity - ratios, not percentage deviations. */
        if (isFinite(t.volRatio) && isFinite(s.volRatio) && s.volRatio) {
            var vr = t.volRatio / s.volRatio;
            rows.push({
                label: TABLE_32.volRatio.label, key: 'volRatio', ratio: vr,
                test: t.volRatio, spec: s.volRatio,
                lo: TABLE_32.volRatio.lo, up: TABLE_32.volRatio.up,
                ok: vr >= TABLE_32.volRatio.lo && vr <= TABLE_32.volRatio.up,
                table: 'PTC-10 Table 3.2'
            });
        }
        if (isFinite(t.phi) && isFinite(s.phi) && s.phi) {
            var pr = t.phi / s.phi;
            rows.push({
                label: TABLE_32.phi.label, key: 'phi', ratio: pr,
                test: t.phi, spec: s.phi,
                lo: TABLE_32.phi.lo, up: TABLE_32.phi.up,
                ok: pr >= TABLE_32.phi.lo && pr <= TABLE_32.phi.up,
                table: 'PTC-10 Table 3.2'
            });
        }

        /* Fig. 3.3 - Mach departure. */
        var mach = null;
        if (isFinite(t.Mau) && isFinite(s.Mau)) {
            var dMa = t.Mau - s.Mau, band = machLimits(s.Mau);
            mach = { dMa: dMa, band: band, ok: dMa >= band.lo && dMa <= band.up };
            rows.push({
                label: 'Machine Mach number', key: 'Mau', test: t.Mau, spec: s.Mau,
                delta: dMa, lo: band.lo, up: band.up, ok: mach.ok, table: 'PTC-10 Fig. 3.3'
            });
        }

        /* Fig. 3.5 - Reynolds ratio, with the 90,000 test floor. */
        var re = null;
        if (isFinite(t.Reu) && isFinite(s.Reu) && s.Reu > 0) {
            re = remCheck(s.Reu, t.Reu);
            rows.push({
                label: 'Machine Reynolds number', key: 'Reu', test: t.Reu, spec: s.Reu,
                ratio: re.rat, lo: re.lim.lo, up: re.lim.up, ok: re.ok,
                floorOK: re.floorOK, extrap: re.extrap, table: 'PTC-10 Fig. 3.5'
            });
        }

        var misses = rows.filter(function (r) { return r.ok === false; });
        return {
            rows: rows, mach: mach, reynolds: re,
            allWithin: misses.length === 0, misses: misses,
            /* The framing matters as much as the numbers. */
            level: misses.length === 0 ? 'pass' : 'caution',
            note: misses.length === 0
                ? 'Every deviation sits inside the PTC-10 Type 1 limits — the test conditions are ' +
                  'a valid benchmark match to the acceptance conditions.'
                : misses.length + ' parameter' + (misses.length > 1 ? 's fall' : ' falls') +
                  ' outside the PTC-10 Type 1 limits. This does not invalidate a site test: ' +
                  '[SPT] p.4 says site tests "often will not fall within the defined limits, and ' +
                  'allowance must be made for that situation." What it does mean is that a ' +
                  'correction must carry the point back to the acceptance conditions, and "any ' +
                  'correction method will introduce a systematic error [which] will increase the ' +
                  'larger the difference between the agreed upon and the as tested conditions ' +
                  'becomes" ([SPT] p.4). Budget that error, or redefine the test point — see the ' +
                  'alternate-point route.'
        };
    }

    /* =====================================================================
     * 15. Alternate test point - [SPT] p.25
     * ---------------------------------------------------------------------
     * The paper's PREFERRED escape when the acceptance conditions are simply
     * not available at site, and it is better than correcting:
     *
     *   "If these conditions cannot be achieved, an alternate test point can be
     *    defined, and performance for the point will be recalculated using
     *    appropriate performance software. In this case, NO FURTHER CORRECTIONS
     *    FOR MACH OR REYNOLDS NUMBERS ARE NECESSARY. The alternate test point
     *    shall have the same non-dimensional flow and the same non-dimensional
     *    isentropic head as the original guarantee point."
     *
     * Given phi and psi* of the guarantee point and the speed achievable at
     * site, this returns the flow and isentropic head that define the alternate
     * point at that speed.
     * ===================================================================== */

    function alternatePoint(o) {
        o = o || {};
        var g = o.guarantee || {};
        var D2 = o.D2 > 0 ? o.D2 : g.D2;
        var N = o.N_achievable;

        if (!(D2 > 0) || !(N > 0) || !isFinite(g.phi) || !isFinite(g.psiIsen)) {
            return { ok: false, note: 'Needs the guarantee point phi and psi*, the impeller ' +
                                      'diameter and the speed achievable at site.' };
        }

        var uTip = Math.PI * D2 * N / 60;
        var Q1 = g.phi * uTip * D2 * D2 * PI4;          // invert Eq. (1)
        var Hisen = g.psiIsen * uTip * uTip / 2;        // invert Eq. (2)

        return {
            ok: true, N: N, uTip: uTip, Q1: Q1, Hisen: Hisen,
            phi: g.phi, psiIsen: g.psiIsen,
            speedRatio: g.N > 0 ? N / g.N : NaN,
            note: 'Alternate point at ' + N.toFixed(0) + ' rpm holding the guarantee point\'s ' +
                  'non-dimensional flow (phi = ' + g.phi.toFixed(4) + ') and non-dimensional ' +
                  'isentropic head (psi* = ' + g.psiIsen.toFixed(4) + '). Per [SPT] p.25 the OEM ' +
                  're-predicts performance for this point with its own software, and NO Mach or ' +
                  'Reynolds correction is then applied — which is why this route is preferable to ' +
                  'correcting a badly-matched point: it avoids the correction error entirely.'
        };
    }

    /* =====================================================================
     * 16. Fan-law correction to reference speed
     * ---------------------------------------------------------------------
     * Q ~ N, H ~ N^2, P ~ N^3, applied only when fanLawValid() says so.
     * [SPT] p.7: the test point must sit at the same combination of phi and psi
     * as the design point while maintaining the volume reduction of Eq. (3).
     * ===================================================================== */

    function correctToSpeed(point, Nref, o) {
        o = o || {};
        var gate = fanLawValid({ dMa: o.dMa || 0, nStages: o.nStages || 1, Md: o.Md });
        var f = Nref / point.N;
        var out = {
            applied: gate.ok, speedRatio: f, gate: gate,
            N: Nref,
            Q1: point.Q1 * f,
            H: point.H * f * f,
            Hisen: point.Hisen * f * f,
            Hp: point.Hp * f * f,
            Pgas: point.Pgas * f * f * f,
            Pshaft: point.Pshaft * f * f * f,
            /* Non-dimensionals are invariant under the fan law by construction -
               that is the whole point of using them ([SPT] Eq. 1-2, p.5). */
            phi: point.phi, psiIsen: point.psiIsen, psiPoly: point.psiPoly,
            etaP: point.etaP, etaIsen: point.etaIsen
        };
        if (!gate.ok) {
            out.note = 'Fan-law correction NOT applied — ' + gate.verdict;
        }
        return out;
    }

    /* =====================================================================
     * 17. Uncertainty - ASME PTC 19.1 Taylor Series Method, [SPT] pp.20-23
     * ---------------------------------------------------------------------
     * "The description in this tutorial follows the ASME PTC 19.1 Taylor Series
     *  Method (TSM) for error propagation. Because the PTC 10 code uses an
     *  ITERATIVE method for the calculation of polytropic work and polytropic
     *  efficiency, THE PARTIAL DIFFERENTIALS IN THE TSM MUST BE REPLACED BY
     *  FINITE DIFFERENCES." ([SPT] p.20)
     *
     * So: perturbation analysis. Evaluate the performance parameter at nominal,
     * then re-evaluate with (nominal + systematic uncertainty) on ONE measured
     * variable at a time, holding the rest at nominal.
     *
     *   b_x = sqrt( SUM_i (delta_i)^2 )                          Eq. (19)
     *   U_x = sqrt( b_x^2 + (t . s_x)^2 )                        Eqs. (20-21)
     *
     * -------------------------------------------------------------------
     * A NOTE ON EQS. 20-21, because the printed formulae and the printed
     * results in the paper disagree and a later reader will otherwise "fix"
     * this code in the wrong direction.
     *
     * The paper writes U_x = sqrt(b^2 + (2.s)^2) and then reports, for
     * b = 0.018001 and s = 0.003, the value U_x = 0.018249. But
     *      sqrt(0.018001^2 + 0.006^2) = 0.018975
     *      sqrt(0.018001^2 + 0.003^2) = 0.018249   <- the printed result
     * and the same holds for Eq. 21 (b = 378.1563, s = 40.1, printed 380.2765;
     * sqrt(b^2 + s^2) = 380.28, sqrt(b^2 + (2s)^2) = 386.56). Both worked
     * numbers therefore correspond to a coverage factor of ONE on the random
     * term, not two.
     *
     * This module implements the PTC 19.1 form with the coverage factor `t`
     * selectable, defaulting to 2 (the standard 95 % form the paper's own text
     * asks for). Setting t = 1 reproduces the paper's printed numbers exactly,
     * and selfTest() asserts both.
     *
     * A second defect, for the record: Table 6 (polytropic work, p.22) is
     * internally inconsistent — its T1 perturbation column reads 100 where it
     * must be 79, and its tabulated squared deltas do not reproduce from its own
     * values (36402.4 - 36132.8 = 269.6, giving 72684, not the printed
     * 77673.69; the printed deltas sum to 387.8, not the printed 378.1563).
     * Table 5 (p.21) IS self-consistent and is what the regression test uses.
     * ===================================================================== */

    /**
     * o = {
     *   nominal:   { p1, T1, p2, T2, W, ... }   measured variables, SI
     *   u:         { p1, T1, p2, T2, W, ... }   SYSTEMATIC uncertainty, same units,
     *                                           95 % confidence, whole chain
     *   evaluate:  function (vars) -> { <param>: value, ... }
     *   random:    { <param>: s_x }             random std dev, same units as the param
     *   coverage:  t, default 2
     * }
     */
    function uncertainty(o) {
        o = o || {};
        var nominal = o.nominal || {};
        var u = o.u || {};
        var evaluate = o.evaluate;
        var t = o.coverage > 0 ? o.coverage : 2;
        if (typeof evaluate !== 'function') throw new Error('uncertainty() needs an evaluate(vars) function.');

        var base = evaluate(nominal);
        var params = Object.keys(base);
        var vars = Object.keys(u).filter(function (k) { return isFinite(u[k]) && u[k] !== 0; });

        /* delta_i for every (parameter, variable) pair. */
        var contrib = {};
        params.forEach(function (p) { contrib[p] = {}; });

        vars.forEach(function (v) {
            var perturbed = {};
            Object.keys(nominal).forEach(function (k) { perturbed[k] = nominal[k]; });
            perturbed[v] = nominal[v] + u[v];
            var res;
            try { res = evaluate(perturbed); } catch (e) { res = null; }
            params.forEach(function (p) {
                var d = (res && isFinite(res[p])) ? res[p] - base[p] : NaN;
                contrib[p][v] = d;
            });
        });

        var out = {};
        params.forEach(function (p) {
            var sum = 0, rows = [];
            vars.forEach(function (v) {
                var d = contrib[p][v];
                if (isFinite(d)) {
                    sum += d * d;
                    rows.push({ variable: v, perturbation: u[v], delta: d, deltaSq: d * d });
                }
            });
            var bx = Math.sqrt(sum);                                  // Eq. (19)
            var sx = (o.random && isFinite(o.random[p])) ? o.random[p] : 0;
            var Ux = Math.sqrt(bx * bx + (t * sx) * (t * sx));        // Eqs. (20-21)

            /* Sort the contributions so the report leads with the measurement
               worth improving — the paper's closing recommendation (p.34): the
               pre-test analysis should "identify the sources of measurement
               errors and aim to improve those instruments that have a
               significant impact on the overall uncertainty". */
            rows.sort(function (a, b) { return b.deltaSq - a.deltaSq; });
            rows.forEach(function (r) { r.share_pct = sum > 0 ? r.deltaSq / sum * 100 : 0; });

            out[p] = {
                nominal: base[p], bx: bx, sx: sx, coverage: t, Ux: Ux,
                rel_pct: base[p] ? Math.abs(Ux / base[p]) * 100 : NaN,
                contributions: rows,
                dominant: rows.length ? rows[0].variable : null
            };
        });

        out._base = base;
        out._coverage = t;
        return out;
    }

    /**
     * Uncertainty of the reduced performance of one test point, wired straight
     * to reducePoint(). Perturbs p1, T1, p2, T2 and W and reports the effect on
     * every quantity the acceptance verdict rests on.
     *
     * The trap this makes visible, and which [SPT] Fig. 17 (p.23) is about:
     * there is no single "test uncertainty" for a machine. "The higher head
     * cases have a lower test uncertainty due to a higher temperature and
     * pressure rise. The relative errors from the temperature and pressure
     * measurements are therefore reduced." A low-rise point can sit inside
     * every PTC-10 limit and still be worthless.
     */
    function pointUncertainty(o) {
        o = o || {};
        var p = o.point || {};
        var base = {
            p1: p.p1, T1: p.T1, p2: p.p2, T2: p.T2, W: p.W
        };
        var mix = o.mix, model = o.model, D2 = o.D2, N = o.N, etaMech = o.etaMech, b2 = o.b2;

        var res = uncertainty({
            nominal: base,
            u: o.u || {},
            random: o.random || {},
            coverage: o.coverage,
            evaluate: function (v) {
                var r = reducePoint({
                    mix: mix, model: model, p1: v.p1, T1: v.T1, p2: v.p2, T2: v.T2,
                    W: v.W, N: N, D2: D2, b2: b2, etaMech: etaMech, nStages: o.nStages,
                    pathSteps: 12                       // coarser: this runs 6+ times
                });
                return {
                    etaP: r.etaP, etaIsen: r.etaIsen,
                    Hp: r.Hp, Hisen: r.Hisen,
                    Q1: r.Q1, Pshaft: r.Pshaft,
                    phi: r.phi, psiIsen: r.psiIsen
                };
            }
        });

        /* ISO 5389 Table 4 penalty on absorbed power, added in quadrature. */
        if (o.powerFluctuation_pct > 0 && res.Pshaft) {
            var add = unsteadyPenalty(o.powerFluctuation_pct) / 100 * Math.abs(res.Pshaft.nominal);
            res.Pshaft.unsteadyPenalty = add;
            res.Pshaft.Ux = Math.sqrt(res.Pshaft.Ux * res.Pshaft.Ux + add * add);
            res.Pshaft.rel_pct = res.Pshaft.nominal
                ? Math.abs(res.Pshaft.Ux / res.Pshaft.nominal) * 100 : NaN;
            res.Pshaft.unsteadyNote = unsteadyAdvisory(o.powerFluctuation_pct);
        }

        /* Compare against what a well-run site test actually achieves. */
        res._benchmark = {
            isenHead: SAT_REFS.typicalSystematic.isenHead,
            actualFlow: SAT_REFS.typicalSystematic.actualFlow,
            absorbedPower: SAT_REFS.typicalSystematic.absorbedPower,
            note: '[SPT] p.19: across 86 ten-second data sets the systematic uncertainty averaged ' +
                  '2.3 % on isentropic head, 2.5 % on actual flow and 2.6 % on absorbed power, ' +
                  'while the random scatter within each set stayed below 0.02 % on head and 0.3 % ' +
                  'on flow and power. For a well-conducted site test, random uncertainty is at ' +
                  'least an order of magnitude below systematic — which is where the effort belongs.'
        };
        return res;
    }

    /* =====================================================================
     * 18. The acceptance verdict - [SPT] p.26, Fig. 16
     * ---------------------------------------------------------------------
     * "A key consideration is the level of test uncertainty achieved in the
     *  test. ONLY DEVIATIONS FROM EXPECTED RESULTS THAT ARE OUTSIDE THE TEST
     *  UNCERTAINTY RANGE ARE SIGNIFICANT. If the test point does not meet the
     *  prediction, but a test uncertainty ellipse drawn around it still covers
     *  the prediction, the test results don't contradict the prediction."
     *
     * The ellipse lives in the non-dimensional (phi, psi) plane, because that
     * is the plane in which the prediction is a single curve independent of
     * speed ([SPT] Eq. 1-2, Fig. 2). A point passes when the prediction falls
     * within its ellipse, i.e. the normalised radius is <= 1.
     * ===================================================================== */

    function acceptanceEllipse(o) {
        o = o || {};
        var phi = o.phi, psi = o.psi;
        var uPhi = o.uPhi, uPsi = o.uPsi;
        var pPhi = o.predictedPhi, pPsi = o.predictedPsi;

        if (![phi, psi, uPhi, uPsi, pPhi, pPsi].every(isFinite) || uPhi <= 0 || uPsi <= 0) {
            return { ok: false, note: 'Needs the measured phi and psi with their uncertainties, ' +
                                      'and the predicted phi and psi.' };
        }

        var dPhi = (pPhi - phi) / uPhi;
        var dPsi = (pPsi - psi) / uPsi;
        var r = Math.sqrt(dPhi * dPhi + dPsi * dPsi);
        var covers = r <= 1;

        return {
            ok: true, covers: covers, radius: r,
            phi: phi, psi: psi, uPhi: uPhi, uPsi: uPsi,
            predictedPhi: pPhi, predictedPsi: pPsi,
            devPhi_pct: phi ? (phi - pPhi) / pPhi * 100 : NaN,
            devPsi_pct: psi ? (psi - pPsi) / pPsi * 100 : NaN,
            verdict: covers
                ? 'The uncertainty ellipse around the test point covers the prediction — the test ' +
                  'result DOES NOT CONTRADICT the prediction ([SPT] p.26). Note the wording: this ' +
                  'is the strongest statement a test of this uncertainty can support.'
                : 'The prediction lies ' + r.toFixed(2) + ' ellipse radii from the test point — ' +
                  'outside the test uncertainty range, so the deviation IS significant ([SPT] ' +
                  'p.26). Before treating it as a machine shortfall, rule out the test itself: ' +
                  'check the curve-shape diagnosis and the power reconciliation.'
        };
    }

    /**
     * Contract tolerances, evaluated alongside the ellipse rather than instead
     * of it. Defaults follow API 617 (power not more than 104 % of quoted).
     * These are commercial limits; the ellipse is the technical finding.
     */
    function contractCheck(o) {
        o = o || {};
        var tol = o.tolerances || {};
        var rows = [];

        function row(label, meas, spec, loPct, upPct) {
            if (!(isFinite(meas) && isFinite(spec) && spec !== 0)) return;
            var dev = (meas - spec) / spec * 100;
            rows.push({
                label: label, measured: meas, specified: spec, dev_pct: dev,
                lo_pct: loPct, up_pct: upPct,
                ok: dev >= loPct - 1e-9 && dev <= upPct + 1e-9
            });
        }

        row('Absorbed power', o.power, o.powerSpec,
            tol.powerLo != null ? tol.powerLo : -100,
            tol.powerUp != null ? tol.powerUp : 4);          // API 617: <= 104 %
        row('Polytropic head', o.head, o.headSpec,
            tol.headLo != null ? tol.headLo : -2,
            tol.headUp != null ? tol.headUp : 2);
        row('Capacity', o.capacity, o.capacitySpec,
            tol.capLo != null ? tol.capLo : -0,
            tol.capUp != null ? tol.capUp : 100);
        row('Polytropic efficiency', o.eta, o.etaSpec,
            tol.etaLo != null ? tol.etaLo : -2,
            tol.etaUp != null ? tol.etaUp : 100);

        var fails = rows.filter(function (r) { return !r.ok; });
        return { rows: rows, ok: fails.length === 0, fails: fails };
    }

    /* =====================================================================
     * 19. Speed lines, surge and choke
     * ---------------------------------------------------------------------
     * [SPT] p.24 asks for three complete speed lines, five or more points per
     * line worked from high flow downward, with the acceptance point bracketed.
     * p.11 warns that surge is by definition non-steady: "Even close to surge,
     * most readings start to fluctuate. The determination of flow at surge is,
     * thus, much more inaccurate than measurements further away from surge."
     * ===================================================================== */

    function curveFit(points, o) {
        o = o || {};
        var pts = (points || []).filter(function (p) { return isFinite(p.Q1) && isFinite(p.H); });
        if (pts.length < 3) {
            return { ok: false, note: 'At least three points are needed to characterise a speed line.' };
        }
        var sorted = pts.slice().sort(function (a, b) { return a.Q1 - b.Q1; });
        var lowFlow = sorted[0], highFlow = sorted[sorted.length - 1];

        /* Rise to surge: how much more head the machine makes at the lowest
           stable flow than at the design point. */
        var design = o.designQ1 > 0
            ? sorted.reduce(function (best, p) {
                  return Math.abs(p.Q1 - o.designQ1) < Math.abs(best.Q1 - o.designQ1) ? p : best;
              }, sorted[0])
            : sorted[Math.floor(sorted.length / 2)];

        var riseToSurge = design.H ? (lowFlow.H - design.H) / design.H * 100 : NaN;
        var turndown = design.Q1 ? (1 - lowFlow.Q1 / design.Q1) * 100 : NaN;

        var notes = [];
        if (pts.length < SAT_REFS.matrix.pointsPerLine) {
            notes.push('Only ' + pts.length + ' points on this speed line; [SPT] p.24 asks for ' +
                SAT_REFS.matrix.pointsPerLine + ' or more, ranging from choke to as close to surge ' +
                'as conditions allow.');
        }
        notes.push('Flow at the lowest-flow point carries markedly more uncertainty than the rest ' +
            'of the line: surge is a non-steady condition by definition and readings begin ' +
            'fluctuating well before it ([SPT] p.11).');

        return {
            ok: true, n: pts.length,
            lowestFlow: lowFlow, highestFlow: highFlow, designPoint: design,
            riseToSurge_pct: riseToSurge, turndown_pct: turndown,
            notes: notes
        };
    }

    /**
     * Does the test matrix meet [SPT] p.24? Speed lines, points per line,
     * direction of working, and bracketing of the acceptance point.
     */
    function matrixCheck(points, o) {
        o = o || {};
        var pts = (points || []).filter(function (p) { return isFinite(p.N); });
        var lines = {};
        pts.forEach(function (p) {
            var key = Math.round(p.N / (o.speedBin || 50)) * (o.speedBin || 50);
            (lines[key] = lines[key] || []).push(p);
        });
        var keys = Object.keys(lines);
        var checks = [];

        checks.push({
            label: 'Complete speed lines',
            value: keys.length, target: SAT_REFS.matrix.speedLines,
            ok: keys.length >= SAT_REFS.matrix.speedLines,
            note: keys.length >= SAT_REFS.matrix.speedLines
                ? null
                : 'Three complete speed lines are recommended to fully validate the compressor. ' +
                  'Where process conditions do not permit it, [SPT] p.24 says the test should ' +
                  'concentrate on the design point.'
        });

        var thin = keys.filter(function (k) { return lines[k].length < SAT_REFS.matrix.pointsPerLine; });
        checks.push({
            label: 'Points per speed line',
            value: keys.length ? Math.min.apply(null, keys.map(function (k) { return lines[k].length; })) : 0,
            target: SAT_REFS.matrix.pointsPerLine,
            ok: thin.length === 0,
            note: thin.length ? thin.length + ' speed line(s) carry fewer than five points.' : null
        });

        /* Acceptance point bracketed by two nearby points on its own line. */
        var acc = pts.filter(function (p) { return p.isAcceptance; })[0];
        var bracketed = null;
        if (acc) {
            var key2 = Math.round(acc.N / (o.speedBin || 50)) * (o.speedBin || 50);
            var line = lines[key2] || [];
            var below = line.filter(function (p) { return p !== acc && p.Q1 < acc.Q1; }).length;
            var above = line.filter(function (p) { return p !== acc && p.Q1 > acc.Q1; }).length;
            bracketed = below > 0 && above > 0;
            checks.push({
                label: 'Acceptance point bracketed',
                value: below + ' below / ' + above + ' above', ok: bracketed,
                note: bracketed ? null
                    : 'The acceptance point must be bracketed by two nearby test points on the ' +
                      'same speed line ([SPT] p.25), so it is interpolated rather than extrapolated.'
            });
        }

        return { lines: lines, nLines: keys.length, checks: checks, ok: checks.every(function (c) { return c.ok !== false; }) };
    }

    /* =====================================================================
     * 20. Measurement plan - [SPT] Tables 2, 3, 7 and pp.25-26
     * ===================================================================== */

    function measurementPlan(o) {
        o = o || {};
        var driver = o.driver || 'motor_ind';
        var channels = SAT_REFS.counts.compressor.map(function (r) {
            return { group: 'Compressor', param: r[0], symbol: r[1], qty: r[2] };
        });

        if (driver === 'gasturbine') {
            channels = SAT_REFS.counts.gasturbine.map(function (r) {
                return { group: 'Gas turbine', param: r[0], symbol: r[1], qty: r[2] };
            }).concat(channels);
        } else if (driver === 'steam') {
            channels = [
                { group: 'Steam turbine', param: 'Inlet steam pressure', symbol: 'p', qty: 1 },
                { group: 'Steam turbine', param: 'Inlet steam temperature', symbol: 'T', qty: 1 },
                { group: 'Steam turbine', param: 'Exhaust pressure', symbol: 'p', qty: 1 },
                { group: 'Steam turbine', param: 'Exhaust temperature', symbol: 'T', qty: 1 },
                { group: 'Steam turbine', param: 'Steam mass flow', symbol: 'W', qty: 1 },
                { group: 'Steam turbine', param: 'Torque (if fitted)', symbol: 'tau', qty: 1 },
                { group: 'Steam turbine', param: 'Speed', symbol: 'N', qty: 1 }
            ].concat(channels);
        } else {
            channels = [
                { group: 'Electric motor', param: 'Electrical input power', symbol: 'P', qty: 1 },
                { group: 'Electric motor', param: 'Voltage / current / power factor', symbol: 'V,I,PF', qty: 1 },
                { group: 'Electric motor', param: 'Motor efficiency at 50/75/100 % load', symbol: 'eta', qty: 1 },
                { group: 'Electric motor', param: 'VFD efficiency (if fitted)', symbol: 'eta', qty: 1 },
                { group: 'Electric motor', param: 'Torque (if fitted)', symbol: 'tau', qty: 1 },
                { group: 'Electric motor', param: 'Speed', symbol: 'N', qty: 1 }
            ].concat(channels);
        }

        var notes = [];
        if (o.nBodies > 1) {
            notes.push('Train of ' + o.nBodies + ' bodies: each compressor is instrumented and ' +
                'evaluated against its OWN design point, and the powers are combined afterwards. ' +
                'Site conditions rarely let two or three bodies sit at their design points at the ' +
                'same time ([SPT] p.12).');
        }
        if (o.nSections > 1) {
            notes.push('Compressor with ' + o.nSections + ' sections: to separate the section ' +
                'powers, either measure three flows (first-section inlet, first-section discharge, ' +
                'second-section inlet) or estimate the division-wall leakage from theory or factory ' +
                'test data. Overall power is unaffected by internal leakage; the per-section ' +
                'efficiency split is not ([SPT] p.12).');
        }
        if (o.hasSideStream) {
            notes.push('Side-stream flows must be measured separately ([SPT] p.12).');
        }
        notes.push('It is often better to place the pressure taps near the flanges rather than at ' +
            'the thermowells, so that pressure loss between the two does not influence the ' +
            'result ([SPT] p.15).');

        return {
            driver: driver,
            channels: channels,
            accuracy: SAT_REFS.accuracy,
            piping: SAT_REFS.piping,
            probeLen_in: SAT_REFS.probeLen_in,
            notes: notes,
            accuracyNote: 'Table 3 accuracies are for the ENTIRE measurement chain — end device, ' +
                'location, tubing, transmitter, data conversion — not the instrument alone ' +
                '([SPT] p.16, footnote 4). A site that cannot install this instrumentation can ' +
                'still be tested; the resulting uncertainties simply have to be carried into the ' +
                'interpretation ([SPT] p.15).'
        };
    }

    /** Straight-run and probe-length checks against what is actually installed. */
    function installationCheck(o) {
        o = o || {};
        var rows = [];
        var P = SAT_REFS.piping;

        function run(label, actualD, needD) {
            if (!isFinite(actualD)) return;
            rows.push({ label: label, actual_D: actualD, required_D: needD, ok: actualD >= needD });
        }
        run('Compressor flange to elbow / reducing transition', o.flangeToElbow_D, P.flangeToElbow);
        run('Expanding transition upstream of the compressor', o.expandingTransition_D, P.expandingTransition);
        run('Orifice to upstream elbow or valve', o.orificeUpstream_D, P.orificeUpstream);
        run('Orifice downstream straight run', o.orificeDownstream_D, P.orificeDownstream);

        /* Table 7 probe length. */
        var probe = null;
        if (o.probeOD_in > 0 && o.probeLength_in > 0) {
            var tab = SAT_REFS.probeLen_in;
            var maxLen = null;
            for (var i = 0; i < tab.length; i++) {
                if (Math.abs(tab[i][0] - o.probeOD_in) < 1e-6) { maxLen = tab[i][1]; break; }
            }
            if (maxLen == null) {
                /* Between tabulated sizes: interpolate, and say so. */
                maxLen = interpLin(tab, o.probeOD_in);
            }
            probe = {
                od_in: o.probeOD_in, length_in: o.probeLength_in, max_in: maxLen,
                ok: o.probeLength_in <= maxLen,
                note: 'Maximum insertion length keeps the probe off a Strouhal vortex-shedding ' +
                      'resonance at high pipeline velocity — a real risk for discharge temperature ' +
                      'probes and dry gas seal sample probes when flows run above design ' +
                      '([SPT] p.33, Table 7, per API 14.1 section 6.4.1).'
            };
            rows.push({
                label: 'Probe insertion length (' + o.probeOD_in + ' in OD)',
                actual_D: o.probeLength_in, required_D: maxLen, ok: probe.ok, isProbe: true,
                inverse: true
            });
        }

        return { rows: rows, probe: probe, ok: rows.every(function (r) { return r.ok; }) };
    }

    /* =====================================================================
     * 21. Pre-test checkout and commissioning readiness
     * ---------------------------------------------------------------------
     * [SPT] pp.25-26 (pre-test checkout) and pp.32-33 (commissioning phase).
     * Returned as data so the UI can render them as checkboxes and score them.
     * ===================================================================== */

    var PRE_TEST = [
        ['Unit proven suitable for continuous operation', 'The test engineer verifies this before anything else.', 'p.25'],
        ['Start-up strainer clean, or removed', 'Verify by differential pressure gauge, direct inspection or borescope. Removal before the performance test is preferable.', 'p.25'],
        ['Gas turbine air compressor washed', 'Approved detergent wash immediately prior to the test. Engine performance with a fouled compressor shall be deemed INVALID; 3 % or more power has been recovered by washing.', 'p.26, p.27'],
        ['Sufficient gas available', 'For proper operation of the gas compressor across the intended operating points.', 'p.26'],
        ['All instrumentation calibrated in its operating range', 'At site or by an approved facility, with calibration certificates available for every test instrument.', 'p.26, p.25'],
        ['RTDs in spring-loaded fittings, or thermowells filled', 'Oil or another approved heat transfer material where spring loading is not possible.', 'p.26'],
        ['Exposed thermowell sections insulated', 'Where a large portion of the thermowell is exposed to atmosphere, insulate it so ambient air does not pull the reading.', 'p.26'],
        ['Pressure tap tubing leak-checked', 'Every tubing run. Where the piping vibrates from flow disturbances, connect transmitters with flex hose.', 'p.26'],
        ['Sufficient trained personnel', 'Enough capable people to record all the data in a reasonable time.', 'p.26'],
        ['Gas sampling schedule agreed', 'As a minimum at the beginning and end of the test; per test point where composition fluctuates. An on-line gas chromatograph lets composition changes be seen while the test runs.', 'p.25'],
        ['EOS agreed in writing before the test', 'Use the EOS that was used for the performance prediction. Different EOS give efficiency differences up to 2 % and density differences of 0.5-2.5 % on the same measured data.', 'p.13'],
        ['Test procedure and acceptance conditions agreed', 'A meeting between the test engineer and the requesting organisation, with P&ID, site layout and mechanical installation drawings, plus any earlier factory or site test results, available in advance.', 'p.24'],
        ['Capability to move the operating point confirmed', 'Suction or discharge throttling, cooled recycle, or loading and unloading other units on the station — otherwise a speed line cannot be walked out.', 'p.25'],
        ['Guaranteed design point and predicted maps in the test agenda', 'If the inlet conditions cannot be met, the acceptance point and the maps must be re-predicted on the new test conditions.', 'p.25']
    ];

    var COMMISSIONING = [
        ['Pipeline dried out after hydrotest', 'Residual water, entrained oil and valve grease from commissioning coat the impellers and depress efficiency. The first pipeline flows carry the most liquid.', 'p.32'],
        ['Filters monitored', 'Differential pressure and inspection ports on the primary coalescing filters, fuel filters and dry gas seal system filters, throughout commissioning.', 'p.32'],
        ['Station within its design window', 'Other stations or parallel units still commissioning can leave pressures low or flows badly off design, pushing both the instrumentation and the compressor off-design and raising uncertainty.', 'p.33'],
        ['RTD and thermowell insertion lengths verified', 'High velocities from higher-than-design flows can excite a Strouhal vortex-shedding resonance — see the Table 7 limits.', 'p.33'],
        ['Full-sized cooled recycle valve downstream of the gas cooler', 'Lets the whole compressor design window be reached on recycle alone, so the unit can be commissioned and mapped independently of the pipeline construction schedule.', 'p.33'],
        ['Full-sized station back-up generator', 'Keeps the unit running through utility power blips; controls may need power-outage windows extended to 60-120 s so the generators can pick up without tripping the train.', 'p.33']
    ];

    /* =====================================================================
     * 22. Self-test
     * ===================================================================== */

    function selfTest() {
        var out = [];
        function check(name, value, expected, tol, note) {
            var pass = isFinite(value) && Math.abs(value - expected) <= tol;
            out.push({ name: name, value: value, expected: expected, tolerance: tol, pass: pass, note: note || '' });
        }
        function checkBool(name, value, note) {
            out.push({ name: name, value: value ? 1 : 0, expected: 1, tolerance: 0, pass: !!value, note: note || '' });
        }

        var psi = 6894.757, F2K = function (f) { return (f - 32) / 1.8 + 273.15; };

        /* ---- [SPT] Table 5, p.21: the worked uncertainty example ---------
           100 % methane, p1 1000 psia, p2 2000 psia, T1 80 F, T2 195 F, with
           systematic uncertainties of 5 psi, 10 psi, 1 F and 1 F. The paper
           reports eta_p = 0.8205 and b_x = 0.018001.

           The paper does not state which EOS produced 0.8205, and [SPT] p.14
           shows EOS choice moving efficiency by up to 2 % on one data set, so
           the tolerance here is set to accommodate that rather than pretending
           to a precision the source does not support. What IS tested tightly is
           the uncertainty machinery: b_x from Eq. 19 and U_x from Eqs. 20-21. */
        var t5 = SAT_REFS.table5;
        var mixC1 = E.makeMixture([{ id: 'C1', molPct: 100 }]);
        var nominal = {
            p1: t5.p1_psia * psi, p2: t5.p2_psia * psi,
            T1: F2K(t5.T1_F), T2: F2K(t5.T2_F)
        };
        var uSet = {
            p1: t5.u.p1_psi * psi, p2: t5.u.p2_psi * psi,
            T1: t5.u.T1_F / 1.8, T2: t5.u.T2_F / 1.8
        };

        var ev = function (v) {
            var r = reducePoint({
                mix: mixC1, model: 'PR', p1: v.p1, T1: v.T1, p2: v.p2, T2: v.T2,
                W: 10, N: 10000, D2: 0.4, etaMech: 0.99, pathSteps: 12
            });
            return { etaP: r.etaP };
        };
        var uRes = uncertainty({ nominal: nominal, u: uSet, evaluate: ev, coverage: 2 });

        check('[SPT] Table 5 — polytropic efficiency (EOS-dependent, see note)',
            uRes.etaP.nominal, t5.etaPolyNominal, 0.025,
            'Paper reports 0.8205 without naming the EOS; [SPT] p.14 shows up to 2 % spread ' +
            'between EOS on one data set, so the tolerance reflects that.');

        check('[SPT] Eq. 19 — systematic uncertainty b_x on eta_p',
            uRes.etaP.bx, t5.bx, 0.004,
            'Root-sum-square of the four finite-difference perturbations, Table 5.');

        /* Eq. 19 arithmetic, isolated from the EOS: feed the paper's own
           tabulated perturbed efficiencies straight in. */
        var t5vals = { base: 0.8205, p1: 0.8287, p2: 0.8285, T1: 0.8101, T2: 0.8113 };
        var pureRes = uncertainty({
            nominal: { p1: 0, p2: 0, T1: 0, T2: 0 },
            u: { p1: 1, p2: 1, T1: 1, T2: 1 },
            evaluate: function (v) {
                if (v.p1) return { e: t5vals.p1 };
                if (v.p2) return { e: t5vals.p2 };
                if (v.T1) return { e: t5vals.T1 };
                if (v.T2) return { e: t5vals.T2 };
                return { e: t5vals.base };
            },
            coverage: 2
        });
        check('[SPT] Eq. 19 — b_x from the paper\'s own tabulated perturbations',
            pureRes.e.bx, 0.018001, 1e-5,
            'Table 5 values fed directly: deltas 0.0082, 0.0080, -0.0104, -0.0092 give ' +
            'sqrt(3.2408e-4) = 0.018002 against the printed 0.018001.');

        /* Eqs. 20-21 with both coverage factors. See the long note above
           uncertainty(): the paper's printed results correspond to t = 1. */
        var b = 0.018001, sx = 0.003;
        check('[SPT] Eq. 20 at coverage t = 1 (reproduces the printed 0.018249)',
            Math.sqrt(b * b + (1 * sx) * (1 * sx)), 0.018249, 1e-6,
            'The paper writes sqrt(b^2 + (2s)^2) but prints the t = 1 result.');
        check('[SPT] Eq. 20 at coverage t = 2 (the PTC 19.1 95 % form, this module\'s default)',
            Math.sqrt(b * b + (2 * sx) * (2 * sx)), 0.018975, 1e-6,
            'What the printed formula actually evaluates to.');
        check('[SPT] Eq. 21 at coverage t = 1 (reproduces the printed 380.2765)',
            Math.sqrt(378.1563 * 378.1563 + 40.1 * 40.1), 380.2765, 1e-3,
            'Polytropic work, same coverage-factor discrepancy.');

        /* ---- Eqs. 8-14: the reduction chain must close ------------------- */
        var mixNG = E.makeMixture([
            { id: 'C1', molPct: 92 }, { id: 'C2', molPct: 5 },
            { id: 'C3', molPct: 2 }, { id: 'N2', molPct: 1 }
        ]);
        var pt = reducePoint({
            mix: mixNG, model: 'PR',
            p1: 30e5, T1: 303.15, p2: 60e5, T2: 393.15,
            W: 20, N: 11000, D2: 0.45, etaMech: 0.985
        });
        check('[SPT] Eq. 12 vs Eq. 13 — gas power closes on W.(h2-h1)',
            pt.Pgas, pt.W * pt.H, Math.abs(pt.Pgas) * 1e-9,
            'rho1.Q1.H must equal W.(h2 - h1) identically, since Q1 = W/rho1.');
        check('[SPT] Eq. 14 — brake power is gas power over eta_m',
            pt.Pshaft * pt.etaMech, pt.Pgas, Math.abs(pt.Pgas) * 1e-9);
        check('[SPT] Eq. 11 — eta* = H*/H',
            pt.etaIsen, pt.Hisen / pt.H, 1e-12);
        check('[SPT] Eq. 10 — H_p = eta_p . H',
            pt.Hp, pt.etaP * pt.H, Math.abs(pt.Hp) * 1e-9);
        checkBool('Polytropic efficiency lands in a physical range',
            pt.etaP > 0.5 && pt.etaP < 1.0, 'eta_p = ' + pt.etaP.toFixed(4));
        checkBool('Schultz and integrated-path heads agree within 2 %',
            isFinite(pt.HpSpread_pct) && pt.HpSpread_pct < 2.0,
            'spread = ' + (isFinite(pt.HpSpread_pct) ? pt.HpSpread_pct.toFixed(3) + ' %' : 'n/a'));
        check('[SPT] Eq. 2 — psi* = 2H*/u_tip^2 (single stage)',
            pt.psiIsen, 2 * pt.Hisen / (pt.uTip * pt.uTip), 1e-12);

        var pt4 = reducePoint({
            mix: mixNG, model: 'PR', p1: 30e5, T1: 303.15, p2: 60e5, T2: 393.15,
            W: 20, N: 11000, D2: 0.45, etaMech: 0.985, nStages: 4
        });
        check('[SPT] Eq. 2 — head coefficient is per stage on a 4-stage machine',
            pt4.psiIsen, pt.psiIsen / 4, 1e-12,
            'Total head divided by the stage count; the machine-level value is kept as ' +
            'psiIsenMachine. Feeding total head into Eq. 2 puts the point nowhere near the map.');
        check('[SPT] Eq. 2 — machine-level head coefficient is retained',
            pt4.psiIsenMachine, pt.psiIsen, 1e-12);
        check('[SPT] Eq. 1 — flow coefficient is unaffected by stage count',
            pt4.phi, pt.phi, 1e-12);
        check('[SPT] Eq. 1 — phi = Q1/(u_tip.D^2.pi/4)',
            pt.phi, pt.Q1 / (pt.uTip * pt.D2 * pt.D2 * Math.PI / 4), 1e-12);
        checkBool('Machine Reynolds number is in the turbulent regime',
            pt.Reu > 1e5, 'Re_u = ' + pt.Reu.toExponential(3) +
            ' (Lee-Gonzalez-Eakin viscosity; the Fig. 3.5 check is on the ratio, which is ' +
            'insensitive to a systematic bias in mu)');

        /* ---- averageStations, [SPT] p.25 --------------------------------- */
        var four = averageStations([100.0, 100.1, 99.9, 120.0]);
        checkBool('Four readings — the inconsistent one is dismissed',
            four.discarded !== null && Math.abs(four.mean - 100) < 0.2,
            'mean of the remaining three = ' + four.mean.toFixed(3));
        var three = averageStations([100.0, 100.1, 120.0]);
        checkBool('Three readings — no dismissal permitted, all are averaged',
            three.discarded === null && three.n === 3,
            'mean = ' + three.mean.toFixed(3) + ' — [SPT] p.25 licenses the discard only at four.');
        var tight = averageStations([100.0, 100.1, 99.9, 100.05]);
        checkBool('Four consistent readings — nothing is dismissed',
            tight.discarded === null, 'mean = ' + tight.mean.toFixed(4));

        /* ---- steadyState, [SPT] p.24 ------------------------------------- */
        function samples(dN) {
            var a = [];
            for (var i = 0; i < 6; i++) {
                a.push({ t_s: i * 120, N_rpm: 10000 + dN * (i / 5), etaP: 0.80, head: 50000, flow: 5, power: 3e6 });
            }
            return a;
        }
        checkBool('Steady state — 3 rpm drift over 10 min passes',
            steadyState(samples(3)).ok === true);
        checkBool('Steady state — 8 rpm drift over 10 min fails the 5 rpm gate',
            steadyState(samples(8)).ok === false);

        /* ---- ISO 5389 Table 4, [SPT] p.20 -------------------------------- */
        check('ISO 5389 Table 4 — 3 % power fluctuation adds 0.5 %', unsteadyPenalty(3), 0.5, 1e-9);
        check('ISO 5389 Table 4 — 4 % power fluctuation adds 1 %', unsteadyPenalty(4), 1.0, 1e-9);
        check('ISO 5389 Table 4 — 2 % power fluctuation adds nothing', unsteadyPenalty(2), 0, 1e-9);
        check('ISO 5389 Table 4 — interpolates between tabulated points', unsteadyPenalty(3.5), 0.75, 1e-9);

        /* ---- PTC-10 bands: guards on the port from the Type 2 tool -------- */
        check('PTC-10 Fig. 3.3 — upper Mach band at Md = 0', machLimits(0).up, 0.28462, 1e-5);
        check('PTC-10 Fig. 3.3 — upper Mach band at Md = 0.886', machLimits(0.886).up, 0.06997, 1e-5);
        check('PTC-10 Fig. 3.3 — lower Mach band at Md = 0.2029', machLimits(0.2029).lo, -0.20223, 1e-5);
        /* The stored curve is log10(ratio), so the plateau at log10 = 2.0 is a
           RATIO of 100, not 2.0 — PTC-10 Fig. 3.5 is deliberately permissive at
           high design Reynolds number, where Reynolds effects are weak. Verified
           identical to the Type 2 tool at 2177 sampled points. */
        check('PTC-10 Fig. 3.5 — upper Reynolds ratio plateaus at 100 above Re = 1e7',
            reLimits(1e7).up, 100, 1e-6);
        check('PTC-10 Fig. 3.5 — lower Reynolds ratio plateaus at 0.1',
            reLimits(1e7).lo, 0.1, 1e-9);
        check('PTC-10 Fig. 3.5 — upper band at Re = 84,000 is much tighter',
            reLimits(84000).up, 4.0684, 1e-3);
        checkBool('PTC-10 Table 3.2 Note (1) — test Re below 90,000 fails',
            remCheck(1e6, 5e4).floorOK === false);
        checkBool('PTC-10 Table 3.2 Note (1) — test Re at design passes the band',
            remCheck(1e6, 1e6).ok === true);

        /* ---- fan law, [SPT] Fig. 4 --------------------------------------- */
        var two = fanLawValid({ dMa: 0.10, nStages: 2, Md: 0.6 });
        var nine = fanLawValid({ dMa: 0.10, nStages: 9, Md: 0.6 });
        checkBool('Fan law — 2-impeller body accepts a 0.10 Mach departure', two.ok === true);
        checkBool('Fan law — 9-stage machine rejects the same departure', nine.ok === false,
            '[SPT] Fig. 4: validity depends on Mach deviation AND stage count.');

        /* ---- fan-law correction round trip -------------------------------- */
        var base = { N: 10000, Q1: 5, H: 50000, Hisen: 45000, Hp: 46000, Pgas: 1e6, Pshaft: 1.02e6,
                     phi: 0.08, psiIsen: 0.6, psiPoly: 0.62, etaP: 0.8, etaIsen: 0.78 };
        var up = correctToSpeed(base, 11000, { dMa: 0, nStages: 2 });
        var back = correctToSpeed(up, 10000, { dMa: 0, nStages: 2 });
        check('Fan law — flow round trip returns the original', back.Q1, base.Q1, 1e-9);
        check('Fan law — head round trip returns the original', back.H, base.H, 1e-6);
        check('Fan law — power scales with the cube of speed',
            up.Pshaft / base.Pshaft, Math.pow(1.1, 3), 1e-9);
        check('Fan law — flow coefficient is invariant', up.phi, base.phi, 1e-12);

        /* ---- curve diagnosis, [SPT] p.32 ---------------------------------- */
        var pred = [];
        for (var q = 0.6; q <= 1.3001; q += 0.05) pred.push({ x: q, y: 1.15 - 0.35 * q * q });
        var shifted = pred.filter(function (_, i) { return i % 2 === 0; })
            .map(function (p) { return { x: p.x / 1.06, y: p.y }; });
        var dShift = diagnose(shifted, pred);
        checkBool('Diagnosis — a uniform flow shift indicts the flow measurement',
            dShift.finding === 'flow', 'finding = ' + dShift.finding + ', shift = ' +
            dShift.flowShift_pct.toFixed(2) + ' %');

        var scatterSeed = [0.03, -0.04, 0.05, -0.03, 0.04, -0.05, 0.03, -0.04];
        var scattered = pred.filter(function (_, i) { return i % 2 === 0; })
            .map(function (p, i) { return { x: p.x, y: p.y * (1 + scatterSeed[i % scatterSeed.length]) }; });
        var dScat = diagnose(scattered, pred);
        checkBool('Diagnosis — point-by-point scatter indicts gas composition drift',
            dScat.finding === 'composition', 'finding = ' + dScat.finding);

        var clean = pred.filter(function (_, i) { return i % 2 === 0; });
        checkBool('Diagnosis — a matching curve reports agreement',
            diagnose(clean, pred).finding === 'agrees');

        /* ---- acceptance ellipse, [SPT] p.26 ------------------------------- */
        var inside = acceptanceEllipse({ phi: 0.080, psi: 0.600, uPhi: 0.004, uPsi: 0.030,
                                         predictedPhi: 0.082, predictedPsi: 0.612 });
        checkBool('Ellipse — prediction inside the uncertainty ellipse does not contradict the test',
            inside.covers === true, 'radius = ' + inside.radius.toFixed(3));
        var outside = acceptanceEllipse({ phi: 0.080, psi: 0.600, uPhi: 0.001, uPsi: 0.005,
                                          predictedPhi: 0.090, predictedPsi: 0.660 });
        checkBool('Ellipse — prediction outside the ellipse is a significant deviation',
            outside.covers === false, 'radius = ' + outside.radius.toFixed(2));

        /* ---- reconciliation, [SPT] p.30 ----------------------------------- */
        var rec = reconcile({ P_shaft: 3.00e6, u_pct: 2.6 }, { P_shaft: 3.132e6, u_pct: 1.5 });
        checkBool('Reconciliation — a 4.4 % gap is flagged as an instrumentation finding',
            rec.available && rec.ok === false && Math.abs(rec.delta_pct - 4.4) < 0.01,
            'the paper\'s own case: ' + rec.delta_pct.toFixed(2) + ' % against a combined ' +
            rec.u_combined_pct.toFixed(2) + ' %');
        checkBool('Reconciliation — leaking valve and flow calibration lead the cause list',
            rec.causes.length > 0 && /valve/i.test(rec.causes[0].cause) &&
            /calibration/i.test(rec.causes[1].cause));
        checkBool('Reconciliation — agreement inside combined uncertainty passes',
            reconcile({ P_shaft: 3.00e6, u_pct: 2.6 }, { P_shaft: 3.03e6, u_pct: 1.5 }).ok === true);

        /* ---- driver power routes ------------------------------------------ */
        var tq = driverPower({ driver: 'gasturbine', reading: { torque_Nm: 30000, N_rpm: 9000 } });
        check('Driver — torque meter gives P = tau.omega',
            tq.P_shaft, 30000 * 9000 * Math.PI / 30, 1);
        checkBool('Driver — torque meter is flagged as the direct measurement', tq.direct === true);

        var mot = driverPower({
            driver: 'motor_ind', ratedPower_W: 4e6,
            reading: { elecPower_W: 3.2e6, etaMotor50: 0.955, etaMotor75: 0.965, etaMotor100: 0.968, vfd: true, etaVfd: 0.975 }
        });
        checkBool('Driver — motor route applies the motor and VFD efficiency chain',
            mot.ok && mot.P_shaft > 0 && mot.P_shaft < 3.2e6,
            'P_shaft = ' + (mot.P_shaft / 1e6).toFixed(3) + ' MW from 3.200 MW electrical');
        checkBool('Driver — motor efficiency is interpolated at part load',
            mot.etaMotor > 0.955 && mot.etaMotor < 0.968,
            'eta = ' + mot.etaMotor.toFixed(4) + ' at ' + (mot.loadFrac * 100).toFixed(0) + ' % load');
        checkBool('Driver — VFD metering caveat is raised',
            mot.notes.some(function (n) { return /waveform|non-sinusoidal/i.test(n); }));

        var gt = driverPower({ driver: 'gasturbine',
            reading: { fuelFlow_kgs: 0.25, fuelLHV_Jkg: 47e6, etaThermal: 0.34 } });
        check('Driver — GT fuel heat balance gives W.LHV.eta', gt.P_shaft, 0.25 * 47e6 * 0.34, 1);

        var gtNoEta = driverPower({ driver: 'gasturbine',
            reading: { fuelFlow_kgs: 0.25, fuelLHV_Jkg: 47e6 } });
        checkBool('Driver — GT without a thermal efficiency declines to invent one',
            gtNoEta.ok === false);

        /* ---- GT full-load validity, [SPT] p.15 ---------------------------- */
        checkBool('GT full load — not at a control limit is rejected',
            gtFullLoadValid({ atGgSpeedLimit: false, atFiringTempLimit: false,
                              airCompressorWashed: true, heatSoak_h: 3 }).ok === false);
        checkBool('GT full load — a fouled air compressor invalidates the point',
            gtFullLoadValid({ atGgSpeedLimit: true, airCompressorWashed: false, heatSoak_h: 3 }).ok === false);
        checkBool('GT full load — compressor speed limit invalidates the point',
            gtFullLoadValid({ atGgSpeedLimit: true, airCompressorWashed: true,
                              compressorSpeedLimited: true, heatSoak_h: 3 }).ok === false);
        checkBool('GT full load — all conditions met passes',
            gtFullLoadValid({ atGgSpeedLimit: true, airCompressorWashed: true,
                              heatSoak_h: 3, ratedPower_hp: 20000 }).ok === true);
        checkBool('GT full load — 1 h soak is short for a large engine',
            gtFullLoadValid({ atGgSpeedLimit: true, airCompressorWashed: true,
                              heatSoak_h: 1, ratedPower_hp: 20000 }).ok === false);

        /* ---- GT correction, [SPT] pp.8-9 ---------------------------------- */
        var gtc = gtCorrect({
            acceptancePower_W: 8e6, fullLoadPower_ref_W: 10e6,
            fuelEnergyMeasured_W: 25e6, fuelEnergyDeck_test_W: 24.5e6, fuelEnergyDeck_ref_W: 26e6
        });
        check('GT correction — step 1 relative load', gtc.load, 0.8, 1e-9);
        check('GT correction — step 3 fuel ratio', gtc.ratio, 25 / 24.5, 1e-9);
        check('GT correction — step 4 fuel at acceptance conditions',
            gtc.fuelAtAcceptance_W, (25 / 24.5) * 26e6, 1);

        /* ---- alternate test point, [SPT] p.25 ----------------------------- */
        var alt = alternatePoint({
            guarantee: { phi: 0.08, psiIsen: 0.60, N: 10000, D2: 0.45 }, N_achievable: 9200
        });
        checkBool('Alternate point — holds phi and psi* at the achievable speed',
            alt.ok && Math.abs(alt.phi - 0.08) < 1e-12 && Math.abs(alt.psiIsen - 0.60) < 1e-12);
        var altUTip = Math.PI * 0.45 * 9200 / 60;
        check('Alternate point — flow follows from inverting Eq. 1',
            alt.Q1, 0.08 * altUTip * 0.45 * 0.45 * Math.PI / 4, 1e-9);

        /* ---- section roll-up, [SPT] Eq. 15 -------------------------------- */
        var roll = rollUpSections([{ Pgas: 1e6 }, { Pgas: 2e6 }], { etaMech: 0.98 });
        check('[SPT] Eq. 15 — sections sum then divide by eta_m', roll.Pshaft, 3e6 / 0.98, 1e-6);
        checkBool('[SPT] Eq. 15 — estimated leakage carries a warning on the section split',
            roll.notes.some(function (n) { return /skewed/i.test(n); }));

        /* ---- deviation checks --------------------------------------------- */
        var dev = deviationCheck({
            spec: { p1: 30e5, T1: 303, N: 10000, MW: 18, Q1: 5, Mau: 0.6, phi: 0.08, volRatio: 1.6 },
            test: { p1: 30e5, T1: 303, N: 10300, MW: 18, Q1: 5, Mau: 0.6, phi: 0.08, volRatio: 1.6 }
        });
        checkBool('PTC-10 Table 3.1 — a 3 % speed deviation exceeds the 2 % limit',
            dev.misses.some(function (r) { return r.key === 'N'; }));
        checkBool('PTC-10 deviations are reported as caution, not failure',
            dev.level === 'caution',
            '[SPT] p.4: site tests often will not fall within the limits, and allowance must be made.');

        /* ---- installation checks ------------------------------------------ */
        var inst = installationCheck({ flangeToElbow_D: 2, orificeUpstream_D: 12,
                                       probeOD_in: 0.75, probeLength_in: 8 });
        checkBool('Installation — 2D flange-to-elbow fails the 3D requirement',
            inst.rows.some(function (r) { return /flange/i.test(r.label) && !r.ok; }));
        checkBool('Installation — an 8 in probe at 0.75 in OD exceeds the 6.5 in Table 7 limit',
            inst.probe && inst.probe.ok === false);

        /* ---- test matrix, [SPT] p.24 -------------------------------------- */
        var mtx = matrixCheck([
            { N: 10000, Q1: 4.0 }, { N: 10000, Q1: 4.5 },
            { N: 10000, Q1: 5.0, isAcceptance: true },
            { N: 10000, Q1: 5.5 }, { N: 10000, Q1: 6.0 }
        ]);
        checkBool('Test matrix — one speed line falls short of the three recommended',
            mtx.checks[0].ok === false);
        checkBool('Test matrix — the acceptance point is correctly seen as bracketed',
            mtx.checks.some(function (c) { return /bracketed/i.test(c.label) && c.ok === true; }));

        /* ---- the export surface itself -----------------------------------
           `diagnose` shipped once without being listed in the export block
           below, so every call from the page threw. The functions the UI binds
           to are cheap to assert, so they are asserted. */
        ['reducePoint', 'driverPower', 'reconcile', 'diagnose', 'steadyState',
         'averageStations', 'pointUncertainty', 'acceptanceEllipse', 'contractCheck',
         'deviationCheck', 'fanLawValid', 'alternatePoint', 'measurementPlan',
         'installationCheck', 'curveFit', 'matrixCheck', 'machLimits', 'reLimits',
         'gasViscosity', 'unsteadyPenalty', 'correctToSpeed', 'gtCorrect',
         'gtFullLoadValid', 'rollUpSections'].forEach(function (fn) {
            checkBool('Export surface — SatEng.' + fn + ' is exported',
                global.SatEng && typeof global.SatEng[fn] === 'function');
        });

        return out;
    }

    /* =====================================================================
     * 23. Export
     * ===================================================================== */

    global.SatEng = {
        SAT_REFS: SAT_REFS,
        TABLE_31: TABLE_31,
        TABLE_32: TABLE_32,
        PRE_TEST: PRE_TEST,
        COMMISSIONING: COMMISSIONING,

        /* PTC-10 similarity bands (ported from the Type 2 tool) */
        MM_CURVE: MM_CURVE,
        RE_CURVE: RE_CURVE,
        REM_MIN: REM_MIN,
        machLimits: machLimits,
        reLimits: reLimits,
        remCheck: remCheck,
        interpLin: interpLin,
        interpLog: interpLog,

        /* gas properties */
        gasViscosity: gasViscosity,

        /* measurement */
        measurementPlan: measurementPlan,
        installationCheck: installationCheck,
        averageStations: averageStations,
        steadyState: steadyState,
        unsteadyPenalty: unsteadyPenalty,
        unsteadyAdvisory: unsteadyAdvisory,

        /* reduction */
        reducePoint: reducePoint,
        solveEtaFromT2: solveEtaFromT2,
        rollUpSections: rollUpSections,
        rollUpBodies: rollUpBodies,

        /* driver */
        driverPower: driverPower,
        gtFullLoadValid: gtFullLoadValid,
        gtCorrect: gtCorrect,
        reconcile: reconcile,

        /* correction and similarity */
        fanLawValid: fanLawValid,
        correctToSpeed: correctToSpeed,
        alternatePoint: alternatePoint,
        deviationCheck: deviationCheck,

        /* uncertainty and verdict */
        uncertainty: uncertainty,
        pointUncertainty: pointUncertainty,
        acceptanceEllipse: acceptanceEllipse,
        contractCheck: contractCheck,

        /* curves */
        diagnose: diagnose,
        curveFit: curveFit,
        matrixCheck: matrixCheck,

        selfTest: selfTest
    };

})(typeof window !== 'undefined' ? window : globalThis);
