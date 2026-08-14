/**
 * compressor-eos.js
 * ---------------------------------------------------------------------------
 * Real-gas thermodynamics and centrifugal compressor selection engine.
 *
 * Pure computation: no DOM access, no Firebase, no globals other than the
 * single `CompEng` namespace. Loaded by compressor_selector.html before the
 * page logic script.
 *
 * Units used internally are strict molar SI:
 *   T  [K]      P  [Pa]      v  [m3/mol]      h, s  [J/mol, J/mol.K]
 *   M  [kg/mol] (component MW is stored in g/mol and divided by 1000)
 * Mass-specific quantities (head, enthalpy) are J/kg. Power is W.
 *
 * Property data are taken from Poling, Prausnitz & O'Connell, "The Properties
 * of Gases and Liquids", 5th ed. Ideal-gas heat capacity is the 4-term
 * polynomial Cp = a + b*T + c*T^2 + d*T^3 in J/(mol.K) with T in K.
 * ---------------------------------------------------------------------------
 */
(function (global) {
    'use strict';

    /* ===================================================================== */
    /* Constants                                                              */
    /* ===================================================================== */

    var R = 8.314462618;        // J/(mol.K)
    var T_REF = 298.15;         // K   reference state for the ideal-gas integrals
    var P_REF = 101325;         // Pa

    /* ===================================================================== */
    /* 1. Pure component database                                             */
    /* ===================================================================== */
    /* id, name, formula, MW [g/mol], Tc [K], Pc [bar], omega, Tb [K],
       cp: [a, b, c, d] for Cp = a + bT + cT^2 + dT^3  in J/(mol.K)         */

    var COMPONENTS = [
        { id: 'C1',    name: 'Methane',          formula: 'CH4',    MW: 16.043,  Tc: 190.56, Pc: 45.99,  omega: 0.011,  Tb: 111.66, cp: [19.251,  5.213e-2,  1.197e-5, -1.132e-8], group: 'Hydrocarbon' },
        { id: 'C2',    name: 'Ethane',           formula: 'C2H6',   MW: 30.070,  Tc: 305.32, Pc: 48.72,  omega: 0.099,  Tb: 184.55, cp: [ 5.409,  1.781e-1, -6.938e-5,  8.713e-9], group: 'Hydrocarbon' },
        { id: 'C3',    name: 'Propane',          formula: 'C3H8',   MW: 44.096,  Tc: 369.83, Pc: 42.48,  omega: 0.152,  Tb: 231.02, cp: [-4.224,  3.063e-1, -1.586e-4,  3.215e-8], group: 'Hydrocarbon' },
        { id: 'iC4',   name: 'i-Butane',         formula: 'C4H10',  MW: 58.123,  Tc: 407.80, Pc: 36.40,  omega: 0.186,  Tb: 261.43, cp: [-1.390,  3.847e-1, -1.846e-4,  2.895e-8], group: 'Hydrocarbon' },
        { id: 'nC4',   name: 'n-Butane',         formula: 'C4H10',  MW: 58.123,  Tc: 425.12, Pc: 37.96,  omega: 0.200,  Tb: 272.65, cp: [ 9.487,  3.313e-1, -1.108e-4, -2.822e-9], group: 'Hydrocarbon' },
        { id: 'iC5',   name: 'i-Pentane',        formula: 'C5H12',  MW: 72.150,  Tc: 460.40, Pc: 33.81,  omega: 0.229,  Tb: 300.99, cp: [-9.525,  5.066e-1, -2.729e-4,  5.723e-8], group: 'Hydrocarbon' },
        { id: 'nC5',   name: 'n-Pentane',        formula: 'C5H12',  MW: 72.150,  Tc: 469.70, Pc: 33.70,  omega: 0.252,  Tb: 309.22, cp: [-3.626,  4.873e-1, -2.580e-4,  5.305e-8], group: 'Hydrocarbon' },
        { id: 'nC6',   name: 'n-Hexane',         formula: 'C6H14',  MW: 86.177,  Tc: 507.60, Pc: 30.25,  omega: 0.300,  Tb: 341.88, cp: [-4.413,  5.820e-1, -3.119e-4,  6.494e-8], group: 'Hydrocarbon' },
        { id: 'nC7',   name: 'n-Heptane',        formula: 'C7H16',  MW: 100.204, Tc: 540.20, Pc: 27.40,  omega: 0.350,  Tb: 371.57, cp: [-5.146,  6.762e-1, -3.651e-4,  7.658e-8], group: 'Hydrocarbon' },
        { id: 'nC8',   name: 'n-Octane',         formula: 'C8H18',  MW: 114.231, Tc: 568.70, Pc: 24.90,  omega: 0.399,  Tb: 398.82, cp: [-6.096,  7.712e-1, -4.195e-4,  8.855e-8], group: 'Hydrocarbon' },
        { id: 'nC9',   name: 'n-Nonane',         formula: 'C9H20',  MW: 128.258, Tc: 594.60, Pc: 22.90,  omega: 0.445,  Tb: 423.97, cp: [-8.374,  8.729e-1, -4.823e-4,  1.031e-7], group: 'Hydrocarbon' },
        { id: 'nC10',  name: 'n-Decane',         formula: 'C10H22', MW: 142.285, Tc: 617.70, Pc: 21.10,  omega: 0.489,  Tb: 447.30, cp: [-7.913,  9.609e-1, -5.288e-4,  1.131e-7], group: 'Hydrocarbon' },

        { id: 'C2=',   name: 'Ethylene',         formula: 'C2H4',   MW: 28.054,  Tc: 282.34, Pc: 50.41,  omega: 0.087,  Tb: 169.42, cp: [ 3.806,  1.566e-1, -8.348e-5,  1.755e-8], group: 'Olefin / Aromatic' },
        { id: 'C3=',   name: 'Propylene',        formula: 'C3H6',   MW: 42.081,  Tc: 364.90, Pc: 46.00,  omega: 0.142,  Tb: 225.46, cp: [ 3.710,  2.345e-1, -1.160e-4,  2.205e-8], group: 'Olefin / Aromatic' },
        { id: 'C4=',   name: '1-Butene',         formula: 'C4H8',   MW: 56.107,  Tc: 419.50, Pc: 40.20,  omega: 0.194,  Tb: 266.90, cp: [-2.994,  3.532e-1, -1.990e-4,  4.463e-8], group: 'Olefin / Aromatic' },
        { id: 'BZ',    name: 'Benzene',          formula: 'C6H6',   MW: 78.114,  Tc: 562.05, Pc: 48.95,  omega: 0.210,  Tb: 353.24, cp: [-33.917, 4.743e-1, -3.017e-4,  7.130e-8], group: 'Olefin / Aromatic' },
        { id: 'TOL',   name: 'Toluene',          formula: 'C7H8',   MW: 92.141,  Tc: 591.75, Pc: 41.08,  omega: 0.264,  Tb: 383.79, cp: [-24.355, 5.125e-1, -2.765e-4,  4.911e-8], group: 'Olefin / Aromatic' },

        { id: 'N2',    name: 'Nitrogen',         formula: 'N2',     MW: 28.014,  Tc: 126.20, Pc: 33.98,  omega: 0.037,  Tb: 77.35,  cp: [31.150, -1.357e-2,  2.680e-5, -1.168e-8], group: 'Inert / Acid gas' },
        { id: 'CO2',   name: 'Carbon dioxide',   formula: 'CO2',    MW: 44.010,  Tc: 304.12, Pc: 73.74,  omega: 0.225,  Tb: 194.70, cp: [19.795,  7.343e-2, -5.602e-5,  1.715e-8], group: 'Inert / Acid gas' },
        { id: 'H2S',   name: 'Hydrogen sulfide', formula: 'H2S',    MW: 34.082,  Tc: 373.53, Pc: 89.63,  omega: 0.094,  Tb: 212.80, cp: [31.941,  1.436e-3,  2.432e-5, -1.176e-8], group: 'Inert / Acid gas' },
        { id: 'H2',    name: 'Hydrogen',         formula: 'H2',     MW: 2.016,   Tc: 32.98,  Pc: 12.93,  omega: -0.217, Tb: 20.39,  cp: [27.143,  9.274e-3, -1.381e-5,  7.645e-9], group: 'Inert / Acid gas' },
        { id: 'H2O',   name: 'Water',            formula: 'H2O',    MW: 18.015,  Tc: 647.14, Pc: 220.64, omega: 0.344,  Tb: 373.15, cp: [32.244,  1.924e-3,  1.055e-5, -3.596e-9], group: 'Inert / Acid gas' },
        { id: 'O2',    name: 'Oxygen',           formula: 'O2',     MW: 31.999,  Tc: 154.58, Pc: 50.43,  omega: 0.022,  Tb: 90.17,  cp: [28.106, -3.680e-6,  1.746e-5, -1.065e-8], group: 'Inert / Acid gas' },
        { id: 'CO',    name: 'Carbon monoxide',  formula: 'CO',     MW: 28.010,  Tc: 132.85, Pc: 34.94,  omega: 0.045,  Tb: 81.66,  cp: [30.869, -1.285e-2,  2.789e-5, -1.272e-8], group: 'Inert / Acid gas' },
        { id: 'He',    name: 'Helium',           formula: 'He',     MW: 4.003,   Tc: 5.19,   Pc: 2.27,   omega: -0.390, Tb: 4.30,   cp: [20.786,  0,         0,         0       ], group: 'Inert / Acid gas' },
        { id: 'Ar',    name: 'Argon',            formula: 'Ar',     MW: 39.948,  Tc: 150.86, Pc: 48.98,  omega: -0.002, Tb: 87.30,  cp: [20.786,  0,         0,         0       ], group: 'Inert / Acid gas' },
        { id: 'NH3',   name: 'Ammonia',          formula: 'NH3',    MW: 17.031,  Tc: 405.50, Pc: 113.53, omega: 0.253,  Tb: 239.82, cp: [27.315,  2.383e-2,  1.707e-5, -1.185e-8], group: 'Polar / Other' },
        { id: 'SO2',   name: 'Sulfur dioxide',   formula: 'SO2',    MW: 64.065,  Tc: 430.80, Pc: 78.84,  omega: 0.245,  Tb: 263.13, cp: [23.852,  6.699e-2, -4.961e-5,  1.328e-8], group: 'Polar / Other' },
        { id: 'MeOH',  name: 'Methanol',         formula: 'CH4O',   MW: 32.042,  Tc: 512.64, Pc: 80.97,  omega: 0.565,  Tb: 337.69, cp: [21.152,  7.092e-2,  2.587e-5, -2.852e-8], group: 'Polar / Other' }
    ];

    var BY_ID = {};
    COMPONENTS.forEach(function (c) { BY_ID[c.id] = c; });

    /* ===================================================================== */
    /* 2. Binary interaction parameters                                       */
    /* ===================================================================== */
    /* Sparse; anything not listed defaults to zero. Values are the commonly
       tabulated Peng-Robinson kij and are used unchanged for SRK, which is
       normal practice for screening work. Key order is normalised by sorting
       the two component ids.                                                */

    var KIJ_DEFAULT = {
        // Nitrogen with hydrocarbons and acid gas
        'C1|N2': 0.031,  'C2|N2': 0.042,  'C3|N2': 0.091,  'N2|iC4': 0.095,
        'N2|nC4': 0.080, 'N2|iC5': 0.100, 'N2|nC5': 0.100, 'N2|nC6': 0.149,
        'CO2|N2': -0.017, 'H2S|N2': 0.130,
        // Carbon dioxide with hydrocarbons
        'C1|CO2': 0.093, 'C2|CO2': 0.128, 'C3|CO2': 0.135, 'CO2|iC4': 0.130,
        'CO2|nC4': 0.130, 'CO2|iC5': 0.125, 'CO2|nC5': 0.125, 'CO2|nC6': 0.125,
        'CO2|H2S': 0.097, 'CO2|H2O': 0.120,
        // Hydrogen sulfide with hydrocarbons
        'C1|H2S': 0.083, 'C2|H2S': 0.084, 'C3|H2S': 0.075, 'H2S|iC4': 0.050,
        'H2S|nC4': 0.060, 'H2S|iC5': 0.065, 'H2S|nC5': 0.065,
        // Hydrogen
        'C1|H2': 0.202,  'C2|H2': 0.224,  'C3|H2': 0.240,  'H2|N2': 0.103,
        'CO|H2': 0.092,
        // Water with light hydrocarbons (large, and only a screening value)
        'C1|H2O': 0.485, 'C2|H2O': 0.490, 'C3|H2O': 0.480
    };

    function kijKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

    function getKij(table, a, b) {
        if (a === b) return 0;
        var k = table[kijKey(a, b)];
        return (typeof k === 'number' && isFinite(k)) ? k : 0;
    }

    /* ===================================================================== */
    /* 3. Mixture definition                                                  */
    /* ===================================================================== */
    /**
     * Build a mixture object from [{id, molPct}, ...].
     * Mole fractions are normalised; components with zero fraction are dropped.
     */
    function makeMixture(spec, kijTable) {
        var kt = kijTable || KIJ_DEFAULT;
        var items = (spec || []).filter(function (s) {
            return BY_ID[s.id] && Number(s.molPct) > 0;
        });
        if (!items.length) throw new Error('Gas composition is empty - add at least one component.');

        var total = items.reduce(function (a, s) { return a + Number(s.molPct); }, 0);
        var comps = items.map(function (s) { return BY_ID[s.id]; });
        var y = items.map(function (s) { return Number(s.molPct) / total; });

        var MW = 0, TcKay = 0, PcKay = 0, omegaKay = 0;
        for (var i = 0; i < comps.length; i++) {
            MW += y[i] * comps[i].MW;
            TcKay += y[i] * comps[i].Tc;
            PcKay += y[i] * comps[i].Pc;
            omegaKay += y[i] * comps[i].omega;
        }

        // Pre-compute the kij sub-matrix actually needed.
        var kij = [];
        for (i = 0; i < comps.length; i++) {
            kij[i] = [];
            for (var j = 0; j < comps.length; j++) {
                kij[i][j] = getKij(kt, comps[i].id, comps[j].id);
            }
        }

        return {
            comps: comps,
            y: y,
            kij: kij,
            rawTotal: total,
            MW: MW,                 // g/mol
            M: MW / 1000,           // kg/mol
            Rsp: R / (MW / 1000),   // J/(kg.K) specific gas constant
            TcKay: TcKay,
            PcKay: PcKay,
            omegaKay: omegaKay
        };
    }

    /* ===================================================================== */
    /* 4. Ideal-gas reference properties                                      */
    /* ===================================================================== */

    function cpIdealMolar(mix, T) {
        var s = 0;
        for (var i = 0; i < mix.comps.length; i++) {
            var c = mix.comps[i].cp;
            s += mix.y[i] * (c[0] + c[1] * T + c[2] * T * T + c[3] * T * T * T);
        }
        return s;                                   // J/(mol.K)
    }

    /** Integral of Cp dT from T_REF to T. */
    function hIdealMolar(mix, T) {
        var s = 0;
        for (var i = 0; i < mix.comps.length; i++) {
            var c = mix.comps[i].cp;
            s += mix.y[i] * (
                c[0] * (T - T_REF) +
                c[1] / 2 * (T * T - T_REF * T_REF) +
                c[2] / 3 * (T * T * T - T_REF * T_REF * T_REF) +
                c[3] / 4 * (Math.pow(T, 4) - Math.pow(T_REF, 4))
            );
        }
        return s;                                   // J/mol
    }

    /** Integral of Cp/T dT from T_REF to T, less the pressure term. */
    function sIdealMolar(mix, T, P) {
        var s = 0;
        for (var i = 0; i < mix.comps.length; i++) {
            var c = mix.comps[i].cp;
            s += mix.y[i] * (
                c[0] * Math.log(T / T_REF) +
                c[1] * (T - T_REF) +
                c[2] / 2 * (T * T - T_REF * T_REF) +
                c[3] / 3 * (T * T * T - T_REF * T_REF * T_REF)
            );
        }
        return s - R * Math.log(P / P_REF);         // J/(mol.K)
    }

    /* ===================================================================== */
    /* 5. Cubic equation of state (Peng-Robinson and SRK)                     */
    /* ===================================================================== */

    var EOS_PARAM = {
        PR:  { Oa: 0.45724, Ob: 0.07780, d1: 1 + Math.SQRT2, d2: 1 - Math.SQRT2 },
        SRK: { Oa: 0.42748, Ob: 0.08664, d1: 1,              d2: 0              }
    };

    function mFactor(model, omega) {
        if (model === 'SRK') {
            return 0.480 + 1.574 * omega - 0.176 * omega * omega;
        }
        // Peng-Robinson. The 1978 heavy-fluid form is used above omega = 0.49.
        if (omega > 0.49) {
            return 0.379642 + 1.48503 * omega - 0.164423 * omega * omega +
                   0.016666 * omega * omega * omega;
        }
        return 0.37464 + 1.54226 * omega - 0.26992 * omega * omega;
    }

    /**
     * Mixture a and b, plus da/dT, at temperature T.
     * Returns { am, bm, damdT } with am in Pa.m6/mol2 and bm in m3/mol.
     */
    function cubicMixParams(mix, T, model) {
        var p = EOS_PARAM[model];
        var n = mix.comps.length;
        var ac = new Array(n), alpha = new Array(n), dalpha = new Array(n), b = new Array(n);

        for (var i = 0; i < n; i++) {
            var c = mix.comps[i];
            var Pc = c.Pc * 1e5;                       // bar -> Pa
            ac[i] = p.Oa * R * R * c.Tc * c.Tc / Pc;
            b[i]  = p.Ob * R * c.Tc / Pc;
            var m = mFactor(model, c.omega);
            var sqTr = Math.sqrt(T / c.Tc);
            var root = 1 + m * (1 - sqTr);
            alpha[i] = root * root;
            // dalpha/dT = -m * sqrt(alpha) / sqrt(T * Tc)
            dalpha[i] = -m * root / Math.sqrt(T * c.Tc);
        }

        var am = 0, damdT = 0, bm = 0;
        for (i = 0; i < n; i++) {
            bm += mix.y[i] * b[i];
            for (var j = 0; j < n; j++) {
                var kf = 1 - mix.kij[i][j];
                var rootAcAc = Math.sqrt(ac[i] * ac[j]);
                var yy = mix.y[i] * mix.y[j];
                am += yy * kf * rootAcAc * Math.sqrt(alpha[i] * alpha[j]);
                // d/dT of sqrt(alpha_i * alpha_j)
                var dsq = 0.5 * (
                    Math.sqrt(alpha[j] / alpha[i]) * dalpha[i] +
                    Math.sqrt(alpha[i] / alpha[j]) * dalpha[j]
                );
                damdT += yy * kf * rootAcAc * dsq;
            }
        }
        return { am: am, bm: bm, damdT: damdT };
    }

    /**
     * Real roots of z^3 + p2 z^2 + p1 z + p0 = 0 via the trigonometric /
     * Cardano method. No initial guess needed and it cannot diverge.
     */
    function cubicRealRoots(p2, p1, p0) {
        var q = (3 * p1 - p2 * p2) / 9;
        var r = (9 * p2 * p1 - 27 * p0 - 2 * p2 * p2 * p2) / 54;
        var disc = q * q * q + r * r;
        var shift = -p2 / 3;

        if (disc > 0) {
            var sd = Math.sqrt(disc);
            var s = Math.cbrt(r + sd);
            var t = Math.cbrt(r - sd);
            return [shift + s + t];
        }
        if (Math.abs(disc) < 1e-30) {
            var r13 = Math.cbrt(r);
            return [shift + 2 * r13, shift - r13];
        }
        var theta = Math.acos(r / Math.sqrt(-q * q * q));
        var mq = 2 * Math.sqrt(-q);
        return [
            shift + mq * Math.cos(theta / 3),
            shift + mq * Math.cos((theta + 2 * Math.PI) / 3),
            shift + mq * Math.cos((theta + 4 * Math.PI) / 3)
        ];
    }

    /** Compressibility factor of the vapour root for a cubic EOS. */
    function cubicZ(mix, T, P, model) {
        var mp = cubicMixParams(mix, T, model);
        var A = mp.am * P / (R * R * T * T);
        var B = mp.bm * P / (R * T);
        var roots;
        if (model === 'SRK') {
            roots = cubicRealRoots(-1, A - B - B * B, -A * B);
        } else {
            roots = cubicRealRoots(-(1 - B), A - 3 * B * B - 2 * B, -(A * B - B * B - B * B * B));
        }
        // Vapour is the largest real root that is physically admissible (Z > B).
        var best = -Infinity;
        for (var i = 0; i < roots.length; i++) {
            if (isFinite(roots[i]) && roots[i] > B && roots[i] > best) best = roots[i];
        }
        if (!isFinite(best)) {
            throw new Error('No valid vapour root at ' + (T - 273.15).toFixed(1) +
                            ' °C / ' + (P / 1e5).toFixed(2) + ' bara. ' +
                            'The gas may be liquid or supercritical-dense at this condition.');
        }
        return { Z: best, A: A, B: B, am: mp.am, bm: mp.bm, damdT: mp.damdT };
    }

    /**
     * Enthalpy and entropy departure for a cubic EOS, J/mol and J/(mol.K).
     *
     * Both models use the one general form, so the delta1/delta2 pair in
     * EOS_PARAM is the only thing that distinguishes them:
     *
     *   H - H^ig = RT(Z-1) + (T da/dT - a)/(b(d1-d2)) * ln[(Z+d1*B)/(Z+d2*B)]
     *   S - S^ig = R ln(Z-B) +     (da/dT)/(b(d1-d2)) * ln[(Z+d1*B)/(Z+d2*B)]
     *
     * For PR that reduces to the familiar 2*sqrt(2) form; for SRK, d1=1 and
     * d2=0 give ln((Z+B)/Z). Writing that log the other way up silently flips
     * the sign of the whole departure - selfTest() checks the identity
     * d(H-H^ig)/dP|T = v - T (dv/dT)|P for every model to catch exactly that.
     */
    function cubicDeparture(mix, T, P, model) {
        var st = cubicZ(mix, T, P, model);
        var prm = EOS_PARAM[model];
        var Z = st.Z, B = st.B;
        var L = Math.log((Z + prm.d1 * B) / (Z + prm.d2 * B));
        var denom = st.bm * (prm.d1 - prm.d2);
        var hDep = R * T * (Z - 1) + (T * st.damdT - st.am) / denom * L;
        var sDep = R * Math.log(Z - B) + st.damdT / denom * L;
        return { Z: Z, hDep: hDep, sDep: sDep };
    }

    /* ===================================================================== */
    /* 6. Lee-Kesler                                                          */
    /* ===================================================================== */
    /* Three-parameter corresponding states with Kay's rule pseudo-criticals.
       Used as a departure-function overlay: it supplies Z, and the enthalpy
       and entropy departures, but not a full mixture EOS. This is the
       classical route for non-polar mixtures and is offered because many
       engineers still specify Lee-Kesler enthalpy departures for compressor
       duty. It degrades on mixtures of widely differing molecular size and on
       anything polar - the UI says so.                                      */

    var LK_SIMPLE = {
        b1: 0.1181193, b2: 0.265728, b3: 0.154790, b4: 0.030323,
        c1: 0.0236744, c2: 0.0186984, c3: 0.0, c4: 0.042724,
        d1: 0.155488e-4, d2: 0.623689e-4, beta: 0.65392, gamma: 0.060167
    };
    var LK_REF = {
        b1: 0.2026579, b2: 0.331511, b3: 0.027655, b4: 0.203488,
        c1: 0.0313385, c2: 0.0503618, c3: 0.016901, c4: 0.041577,
        d1: 0.48736e-4, d2: 0.0740336e-4, beta: 1.226, gamma: 0.03754
    };
    var LK_OMEGA_REF = 0.3978;

    function lkZofVr(k, Tr, Vr) {
        var B = k.b1 - k.b2 / Tr - k.b3 / (Tr * Tr) - k.b4 / (Tr * Tr * Tr);
        var C = k.c1 - k.c2 / Tr + k.c3 / (Tr * Tr * Tr);
        var D = k.d1 + k.d2 / Tr;
        var e = Math.exp(-k.gamma / (Vr * Vr));
        return 1 + B / Vr + C / (Vr * Vr) + D / Math.pow(Vr, 5) +
               k.c4 / (Tr * Tr * Tr * Vr * Vr) * (k.beta + k.gamma / (Vr * Vr)) * e;
    }

    /** Solve the reduced volume Vr such that Pr*Vr/Tr = Z(Vr). */
    function lkSolveVr(k, Tr, Pr) {
        var Vr = Tr / Pr;                       // ideal-gas start
        for (var it = 0; it < 100; it++) {
            var f = lkZofVr(k, Tr, Vr) - Pr * Vr / Tr;
            var dV = Math.max(Vr * 1e-6, 1e-9);
            var f2 = lkZofVr(k, Tr, Vr + dV) - Pr * (Vr + dV) / Tr;
            var slope = (f2 - f) / dV;
            if (!isFinite(slope) || Math.abs(slope) < 1e-30) break;
            var step = f / slope;
            // Damp so the iteration cannot jump to a negative volume.
            if (step > 0.5 * Vr) step = 0.5 * Vr;
            if (step < -2 * Vr) step = -2 * Vr;
            var next = Vr - step;
            if (next <= 0) next = Vr / 2;
            if (Math.abs(next - Vr) < 1e-12 * Math.max(1, Vr)) { Vr = next; break; }
            Vr = next;
        }
        if (!isFinite(Vr) || Vr <= 0) throw new Error('Lee-Kesler failed to converge - try Peng-Robinson for this gas.');
        return Vr;
    }

    /** Departures of one LK fluid, returned already divided by RTc and R. */
    function lkFluid(k, Tr, Pr) {
        var Vr = lkSolveVr(k, Tr, Pr);
        var Z = Pr * Vr / Tr;
        var e = Math.exp(-k.gamma / (Vr * Vr));
        var E = k.c4 / (2 * Tr * Tr * Tr * k.gamma) *
                (k.beta + 1 - (k.beta + 1 + k.gamma / (Vr * Vr)) * e);

        var hDepRed = Tr * (
            Z - 1
            - (k.b2 + 2 * k.b3 / Tr + 3 * k.b4 / (Tr * Tr)) / (Tr * Vr)
            - (k.c2 - 3 * k.c3 / (Tr * Tr)) / (2 * Tr * Vr * Vr)
            + k.d2 / (5 * Tr * Math.pow(Vr, 5))
            + 3 * E
        );

        var sDepRed = Math.log(Z)
            - (k.b1 + k.b3 / (Tr * Tr) + 2 * k.b4 / (Tr * Tr * Tr)) / Vr
            - (k.c1 - 2 * k.c3 / (Tr * Tr * Tr)) / (2 * Vr * Vr)
            - k.d1 / (5 * Math.pow(Vr, 5))
            + 2 * E;

        return { Z: Z, hDepRed: hDepRed, sDepRed: sDepRed };
    }

    function lkDeparture(mix, T, P) {
        var Tc = mix.TcKay, Pc = mix.PcKay * 1e5, omega = mix.omegaKay;
        var Tr = T / Tc, Pr = P / Pc;
        var s0 = lkFluid(LK_SIMPLE, Tr, Pr);
        var sr = lkFluid(LK_REF, Tr, Pr);
        var w = omega / LK_OMEGA_REF;
        var Z = s0.Z + w * (sr.Z - s0.Z);
        var hDep = R * Tc * (s0.hDepRed + w * (sr.hDepRed - s0.hDepRed));
        var sDep = R * (s0.sDepRed + w * (sr.sDepRed - s0.sDepRed));
        return { Z: Z, hDep: hDep, sDep: sDep };
    }

    /* ===================================================================== */
    /* 7. Unified state evaluation                                            */
    /* ===================================================================== */

    var MODELS = {
        PR:  'Peng-Robinson',
        SRK: 'Soave-Redlich-Kwong',
        LK:  'Lee-Kesler (Kay’s rule pseudo-criticals)'
    };

    /**
     * Full thermodynamic state at (T, P).
     * Derivatives are taken numerically from v(T, P), which keeps the three
     * models on exactly the same footing - Lee-Kesler gives Z(T,P) rather than
     * P(v,T), so an analytic dP/dv is not available for it anyway.
     */
    function state(mix, T, P, model) {
        var dep = (model === 'LK') ? lkDeparture(mix, T, P) : cubicDeparture(mix, T, P, model);
        var Z = dep.Z;
        var v = Z * R * T / P;                                  // m3/mol
        var h = hIdealMolar(mix, T) + dep.hDep;                 // J/mol
        var s = sIdealMolar(mix, T, P) + dep.sDep;              // J/(mol.K)

        return {
            T: T, P: P, Z: Z,
            v: v,                                               // m3/mol
            vMass: v / mix.M,                                   // m3/kg
            rho: mix.M / v,                                     // kg/m3
            h: h,                                               // J/mol
            s: s,                                               // J/(mol.K)
            hMass: h / mix.M,                                   // J/kg
            sMass: s / mix.M                                    // J/(kg.K)
        };
    }

    function molarVolume(mix, T, P, model) {
        var dep = (model === 'LK') ? lkDeparture(mix, T, P) : cubicDeparture(mix, T, P, model);
        return dep.Z * R * T / P;
    }

    /**
     * Real-gas Cp, Cp/Cv, isentropic volume exponent and acoustic velocity.
     * Cp is a central difference of H(T,P); the volumetric derivatives come
     * from v(T,P) and the triple product relation:
     *      Cp - Cv = -T (dv/dT)_P^2 / (dv/dP)_T
     *      kv      = (Cp/Cv) * (-v/P) / (dv/dP)_T
     */
    function derived(mix, T, P, model) {
        var dT = Math.max(0.02, T * 1e-5);
        var dP = Math.max(50, P * 1e-5);

        var hHi = state(mix, T + dT, P, model).h;
        var hLo = state(mix, T - dT, P, model).h;
        var cp = (hHi - hLo) / (2 * dT);                        // J/(mol.K)

        var vHi = molarVolume(mix, T + dT, P, model);
        var vLo = molarVolume(mix, T - dT, P, model);
        var dvdT = (vHi - vLo) / (2 * dT);

        var vPHi = molarVolume(mix, T, P + dP, model);
        var vPLo = molarVolume(mix, T, P - dP, model);
        var dvdP = (vPHi - vPLo) / (2 * dP);                    // negative

        var st = state(mix, T, P, model);
        var cpMinusCv = -T * dvdT * dvdT / dvdP;
        var cv = cp - cpMinusCv;
        var gamma = cp / cv;
        var kv = gamma * (-st.v / P) / dvdP;                    // isentropic volume exponent
        var a = Math.sqrt(kv * P * st.v / mix.M);               // m/s

        // A condition inside the two-phase envelope, or deep in the liquid
        // region, produces a root whose derivatives are meaningless: negative
        // heat capacity, a negative isentropic exponent, an imaginary speed of
        // sound. Catch it here with a message an engineer can act on rather
        // than letting NaN propagate into the stage solve.
        if (!isFinite(cp) || cp <= 0 || !isFinite(kv) || kv <= 0 || !isFinite(a) || a <= 0) {
            throw new Error(
                'At ' + (T - 273.15).toFixed(1) + ' °C and ' + (P / 1e5).toFixed(2) +
                ' bara this mixture is not behaving as a gas — the equation of state returns a ' +
                'liquid or two-phase root. Check the suction conditions against the gas: a ' +
                'centrifugal compressor needs dry vapour at inlet.'
            );
        }

        return {
            cpMolar: cp,
            cpMass: cp / mix.M,                                 // J/(kg.K)
            cvMass: cv / mix.M,
            gamma: gamma,                                       // Cp/Cv
            kv: kv,
            sonic: a,
            cpIdealMolar: cpIdealMolar(mix, T)
        };
    }

    /* ===================================================================== */
    /* 8. Inverse solves                                                      */
    /* ===================================================================== */

    /** Temperature at which the mixture has molar enthalpy hTarget at P. */
    function solveTfromH(mix, P, hTarget, model, Tguess) {
        var T = Tguess || 320;
        for (var it = 0; it < 60; it++) {
            var h = state(mix, T, P, model).h;
            var err = h - hTarget;
            var cp = derived(mix, T, P, model).cpMolar;
            if (!isFinite(cp) || cp <= 0) cp = 30;
            var step = err / cp;
            if (step > 60) step = 60;
            if (step < -60) step = -60;
            T -= step;
            if (T < 40) T = 40;
            if (Math.abs(step) < 1e-6) break;
        }
        return T;
    }

    /** Temperature at which the mixture has molar entropy sTarget at P. */
    function solveTfromS(mix, P, sTarget, model, Tguess) {
        var T = Tguess || 320;
        for (var it = 0; it < 60; it++) {
            var s = state(mix, T, P, model).s;
            var err = s - sTarget;
            var cp = derived(mix, T, P, model).cpMolar;
            if (!isFinite(cp) || cp <= 0) cp = 30;
            var step = err * T / cp;
            if (step > 60) step = 60;
            if (step < -60) step = -60;
            T -= step;
            if (T < 40) T = 40;
            if (Math.abs(step) < 1e-6) break;
        }
        return T;
    }

    /* ===================================================================== */
    /* 9. Compression path                                                    */
    /* ===================================================================== */
    /**
     * Stepwise integration of the real polytropic path.
     *
     *   dHp = v dP                (polytropic head increment, J/kg)
     *   dh  = v dP / etaP         (small-stage definition of polytropic eff.)
     *
     * The discharge temperature falls straight out of the enthalpy balance,
     * so no ideal-gas exponent shortcut is involved. A predictor-corrector
     * (trapezoidal in v) is used on each sub-step.
     *
     * Returns head [J/kg], discharge state, and the isentropic comparison.
     */
    function compressPath(mix, T1, P1, P2, etaP, model, nSteps) {
        if (!(P2 > P1)) throw new Error('Discharge pressure must be greater than suction pressure.');
        var steps = nSteps || 40;
        var ratioStep = Math.pow(P2 / P1, 1 / steps);

        var st1 = state(mix, T1, P1, model);
        var h = st1.h;
        var P = P1;
        var T = T1;
        var Hp = 0;                                             // J/kg

        for (var i = 0; i < steps; i++) {
            var Pnext = (i === steps - 1) ? P2 : P * ratioStep;
            var dP = Pnext - P;
            var vA = state(mix, T, P, model).v;                 // m3/mol

            // Predictor with the inlet volume.
            var dhPred = vA * dP / etaP;
            var Tpred = solveTfromH(mix, Pnext, h + dhPred, model, T);
            var vB = state(mix, Tpred, Pnext, model).v;

            // Corrector with the trapezoidal mean volume.
            var vMean = 0.5 * (vA + vB);
            var dHpMolar = vMean * dP;                          // J/mol
            var dh = dHpMolar / etaP;
            h += dh;
            P = Pnext;
            T = solveTfromH(mix, P, h, model, Tpred);
            Hp += dHpMolar / mix.M;                             // J/kg
        }

        var st2 = state(mix, T, P2, model);

        // Isentropic endpoint for the efficiency cross-check and Schultz f.
        var T2s = solveTfromS(mix, P2, st1.s, model, T);
        var st2s = state(mix, T2s, P2, model);
        var dhs = (st2s.h - st1.h) / mix.M;                     // J/kg isentropic work
        var dhActual = (st2.h - st1.h) / mix.M;                 // J/kg actual work
        var etaIsen = dhs / dhActual;

        return {
            Hp: Hp,                                             // J/kg polytropic head
            work: dhActual,                                     // J/kg actual enthalpy rise
            etaPoly: Hp / dhActual,
            etaIsen: etaIsen,
            Hs: dhs,                                            // J/kg isentropic head
            inlet: st1,
            outlet: st2,
            isenOutlet: st2s,
            T2: T,
            T2s: T2s
        };
    }

    /**
     * Schultz polytropic head, reported as a cross-check against the
     * integrated path. f is the Schultz correction from the isentropic
     * endpoint; n is the polytropic volume exponent of the real path.
     */
    function schultzHead(mix, path) {
        var st1 = path.inlet, st2 = path.outlet, st2s = path.isenOutlet;
        var v1 = st1.v / mix.M, v2 = st2.v / mix.M, v2s = st2s.v / mix.M;
        var ns = Math.log(st2.P / st1.P) / Math.log(v1 / v2s);
        var f = (st2s.h - st1.h) / mix.M / ((ns / (ns - 1)) * (st2.P * v2s - st1.P * v1));
        var n = Math.log(st2.P / st1.P) / Math.log(v1 / v2);
        var Hp = f * (n / (n - 1)) * (st2.P * v2 - st1.P * v1);
        return { f: f, n: n, ns: ns, Hp: Hp };
    }

    /**
     * The classical single-step polytropic head, kept as a third cross-check.
     * Divergence between the three methods is itself the signal that the gas is
     * far from ideal.
     *
     *   n  = 1 / (1 - (k-1)/(k*etaP))
     *   Hp = n/(n-1) * Z1 * Rsp * T1 * (rp^((n-1)/n) - 1)
     *
     * Note that n/(n-1) is 1/exp with exp = (n-1)/n - not n/exp. The older
     * CompressorCalc_9.html on this hub uses n/exp at line 639, which overstates
     * the head by a factor of n.
     */
    function simplePolytropicHead(mix, T1, P1, P2, Z1, k, etaP) {
        var n = 1 / (1 - ((k - 1) / (k * etaP)));
        var expn = (n - 1) / n;
        return (1 / expn) * Z1 * mix.Rsp * T1 * (Math.pow(P2 / P1, expn) - 1);
    }

    /* ===================================================================== */
    /* 10. Efficiency prediction                                              */
    /* ===================================================================== */

    function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

    /**
     * Base polytropic efficiency from inlet volumetric flow. This is the
     * correlation already in use in CompressorCalc_9.html (autoEtaP), kept
     * identical so the two tools agree on the same duty.
     *   Q1 in m3/h.
     */
    function baseEtaP(Q1_m3h) {
        var Qcfm = 0.5885 * Q1_m3h;
        var eta = 0.61 + 0.03 * Math.log(Math.max(Qcfm, 1)) / Math.LN10;
        return clamp(eta, 0.70, 0.85);
    }

    /**
     * Flow-coefficient penalty. Stage efficiency peaks around phi = 0.06-0.09;
     * narrow stages lose to friction and leakage, very wide stages need 3D
     * blading and lose at the inducer. Parabolic derate about the optimum.
     */
    function phiEfficiencyFactor(phi) {
        var phiOpt = 0.075;
        var d = (phi - phiOpt) / phiOpt;
        var f = 1 - 0.16 * d * d;
        return clamp(f, 0.80, 1.0);
    }

    function predictEtaP(Q1_m3h, phi) {
        var eta = baseEtaP(Q1_m3h);
        if (isFinite(phi) && phi > 0) eta *= phiEfficiencyFactor(phi);
        return clamp(eta, 0.68, 0.87);
    }

    /* ===================================================================== */
    /* 11. Impeller material / tip-speed limits                               */
    /* ===================================================================== */

    var IMPELLER_TYPES = [
        { id: 'cast',    label: 'Cast / high-MW / erosive duty',        u2max: 260, psiMax: 0.62, open: false },
        { id: 'std',     label: 'Closed steel, standard (17-4PH, 4340)', u2max: 320, psiMax: 0.62, open: false },
        { id: 'hs',      label: 'Closed steel, high strength',           u2max: 375, psiMax: 0.62, open: false },
        { id: 'open',    label: 'Open / semi-open (integrally geared)',  u2max: 500, psiMax: 0.75, open: true  },
        { id: 'ti',      label: 'Titanium',                              u2max: 600, psiMax: 0.75, open: true  }
    ];

    function impellerType(id) {
        for (var i = 0; i < IMPELLER_TYPES.length; i++) {
            if (IMPELLER_TYPES[i].id === id) return IMPELLER_TYPES[i];
        }
        return IMPELLER_TYPES[1];
    }

    /* ===================================================================== */
    /* 12. Stage aerodynamics                                                 */
    /* ===================================================================== */
    /**
     * Non-dimensional coefficients, all consistent SI:
     *   psi = Hp_stage / U2^2                    head (work) coefficient
     *   phi = Q1 / (pi/4 * D2^2 * U2)            flow coefficient
     *   U2  = pi * D2 * N / 60                   tip speed, N in rpm
     *   Mu2 = U2 / a1                            peripheral Mach number
     *
     * Sizing solve for a target psi:
     *   U2 = sqrt(Hp_stage / psi)
     *   D2 = sqrt(4 Q1 / (pi phi U2))
     *   N  = 60 U2 / (pi D2)
     */
    function stageGeometry(HpStage, Q1, psi, phi) {
        var U2 = Math.sqrt(HpStage / psi);
        var D2 = Math.sqrt(4 * Q1 / (Math.PI * phi * U2));
        var N = 60 * U2 / (Math.PI * D2);
        return { U2: U2, D2: D2, N: N };
    }

    /** Given a fixed speed N and target psi, the resulting diameter and phi. */
    function stageAtSpeed(HpStage, Q1, psi, N) {
        var U2 = Math.sqrt(HpStage / psi);
        var D2 = 60 * U2 / (Math.PI * N);
        var phi = Q1 / (Math.PI / 4 * D2 * D2 * U2);
        return { U2: U2, D2: D2, phi: phi };
    }

    /**
     * Inlet relative Mach number at the impeller eye.
     *
     * This needs an eye geometry that is really the vendor's to choose, so a
     * correlation is used: the eye-to-tip diameter ratio grows with the flow
     * coefficient, and a fixed hub ratio of 0.3 is assumed. It is the single
     * largest simplification in the aerodynamic model and the UI says so.
     */
    function inletRelativeMach(Q1, U2, D2, a1) {
        var phi = Q1 / (Math.PI / 4 * D2 * D2 * U2);
        var eyeRatio = clamp(0.40 + 1.9 * Math.pow(clamp(phi, 0.005, 0.20), 0.55), 0.35, 0.72);
        var D1 = eyeRatio * D2;
        var hubRatio = 0.30;
        var Aeye = Math.PI / 4 * D1 * D1 * (1 - hubRatio * hubRatio);
        var Cx1 = Q1 / Aeye;                        // axial velocity at the eye
        var U1 = U2 * eyeRatio;                     // blade speed at the eye tip
        var W1 = Math.sqrt(Cx1 * Cx1 + U1 * U1);
        return { Mrel: W1 / a1, D1: D1, Cx1: Cx1, U1: U1, eyeRatio: eyeRatio };
    }

    /* ===================================================================== */
    /* 13. Section march - stages, speed, diameters                           */
    /* ===================================================================== */

    var DEFAULTS = {
        psiTarget: 0.52,
        psiMin: 0.42,
        psiMax: 0.65,
        phiMin: 0.010,
        phiMax: 0.150,
        phiBestLo: 0.055,
        phiBestHi: 0.095,
        phiTarget: 0.075,
        mu2Max: 1.05,
        mrelMax: 0.85,
        t2MaxC: 150,
        maxStagesPerBody: 9,
        etaMech: 0.985,
        // Speed and size are what stop the aerodynamic solve running away.
        // A low-flow duty wants a physically tiny, impossibly fast impeller if
        // the flow coefficient is held at its optimum, so the speed is capped
        // and the impeller has a minimum practical diameter; the flow
        // coefficient is then whatever falls out, which is how a real
        // selection behaves.
        maxSpeedClosed: 20000,      // rpm, beam-type with closed impellers
        maxSpeedOpen: 60000,        // rpm, integrally geared pinion
        minD2Closed: 0.180,         // m, room for shaft, seals and bearings
        minD2Open: 0.100            // m
    };

    /**
     * March one uncooled section: integrate the path, work out how many
     * stages are needed to respect the head-per-stage, Mach and temperature
     * limits, then split the head equally and evaluate each stage with the
     * properties at its own inlet.
     */
    function runSection(opts) {
        var mix = opts.mix, model = opts.model;
        var T1 = opts.T1, P1 = opts.P1, P2 = opts.P2;
        var mdot = opts.mdot;                       // kg/s
        var lim = opts.limits || DEFAULTS;
        var imp = opts.impeller || impellerType('std');

        var st1 = state(mix, T1, P1, model);
        var Q1total = mdot / st1.rho;               // m3/s at section inlet
        var d1 = derived(mix, T1, P1, model);

        // First pass with a flow-only efficiency estimate, then refine once
        // the flow coefficient is known.
        var etaP = opts.etaPManual || predictEtaP(Q1total * 3600, null);
        var path = compressPath(mix, T1, P1, P2, etaP, model, opts.pathSteps || 40);

        // Allowable tip speed is the tighter of the mechanical stress limit
        // and the peripheral Mach limit at the section inlet.
        var u2Mach = lim.mu2Max * d1.sonic;
        var u2Allow = Math.min(imp.u2max, u2Mach);
        var psi = Math.min(opts.psiTarget || lim.psiTarget, imp.psiMax);
        var headPerStageMax = psi * u2Allow * u2Allow;

        // Math.max(1, NaN) is NaN, so guard the ratio explicitly - a NaN stage
        // count would silently produce an empty stage list.
        var stageRatio = path.Hp / headPerStageMax;
        if (!isFinite(stageRatio) || stageRatio <= 0) {
            throw new Error('Could not work out a stage count for this duty — check the suction conditions, ' +
                            'the pressure ratio and the gas composition.');
        }
        var nStages = Math.max(1, Math.ceil(stageRatio));
        var result = null;

        for (var iter = 0; iter < 15; iter++) {
            result = marchStages(mix, model, T1, P1, P2, mdot, nStages, psi, etaP, lim, imp, opts);

            // Re-estimate efficiency from the first stage flow coefficient and
            // re-run the path if it moved appreciably.
            if (!opts.etaPManual) {
                var newEta = predictEtaP(Q1total * 3600, result.stages[0].phi);
                if (Math.abs(newEta - etaP) > 0.002) {
                    etaP = newEta;
                    path = compressPath(mix, T1, P1, P2, etaP, model, opts.pathSteps || 40);
                    continue;
                }
            }

            var violates = result.stages.some(function (s) {
                return s.Mu2 > lim.mu2Max * 1.0001 ||
                       s.Mrel > lim.mrelMax * 1.0001 ||
                       s.U2 > imp.u2max * 1.0001 ||
                       s.phi > lim.phiMax;
            });
            if (!violates) break;
            if (nStages >= 20) break;
            nStages++;
        }

        var t2Exceeded = (result.T2 - 273.15) > lim.t2MaxC;

        // Power train
        var gasPower = mdot * result.HpTotal / result.etaPoly;   // W
        var mechEta = opts.etaMech || lim.etaMech;
        var shaftPower = gasPower / mechEta;

        return {
            inlet: st1,
            inletDerived: d1,
            Q1: Q1total,
            path: path,
            schultz: schultzHead(mix, path),
            etaPoly: result.etaPoly,
            etaIsen: path.etaIsen,
            HpTotal: result.HpTotal,
            stages: result.stages,
            nStages: result.stages.length,
            speed: result.speed,
            T2: result.T2,
            P2: P2,
            outlet: result.outlet,
            gasPower: gasPower,
            shaftPower: shaftPower,
            headPerStageMax: headPerStageMax,
            u2Allow: u2Allow,
            u2Mach: u2Mach,
            t2Exceeded: t2Exceeded,
            psiUsed: psi,
            etaSource: opts.etaPManual ? 'manual' : 'correlation',
            speedLimited: result.speedLimited,
            sizeLimited: result.sizeLimited,
            maxSpeed: result.maxSpeed,
            minD2: result.minD2
        };
    }

    /**
     * Split the total head into nStages equal parts and evaluate each stage at
     * its own inlet conditions. All stages share one shaft speed, which is set
     * by the first stage; the diameter is held constant through the section
     * (normal for a single body), so the flow coefficient falls stage by stage
     * as the gas densifies.
     */
    function marchStages(mix, model, T1, P1, P2, mdot, nStages, psi, etaP, lim, imp, opts) {
        // Total head from a full-section path at this efficiency.
        var full = compressPath(mix, T1, P1, P2, etaP, model, opts.pathSteps || 40);
        var HpTotal = full.Hp;
        var HpStage = HpTotal / nStages;

        var st1 = state(mix, T1, P1, model);
        var d1 = derived(mix, T1, P1, model);
        var Q1 = mdot / st1.rho;

        // Speed and diameter are set by the first stage. The target flow
        // coefficient is the starting point, but the answer is then squeezed
        // between the maximum shaft speed and the minimum practical impeller
        // diameter - whichever binds, the flow coefficient gives way.
        var U2first = Math.sqrt(HpStage / psi);
        var phiTarget = clamp(opts.phiTarget || lim.phiTarget, lim.phiMin, lim.phiMax);
        var maxSpeed = opts.maxSpeed || (imp.open ? lim.maxSpeedOpen : lim.maxSpeedClosed);
        var minD2 = opts.minD2 || (imp.open ? lim.minD2Open : lim.minD2Closed);

        var geo = stageGeometry(HpStage, Q1, psi, phiTarget);
        var N = geo.N;
        var D2 = geo.D2;
        var speedLimited = false, sizeLimited = false;

        if (opts.speedManual) {
            N = opts.speedManual;
            D2 = 60 * U2first / (Math.PI * N);
        } else {
            if (N > maxSpeed) {
                N = maxSpeed;
                D2 = 60 * U2first / (Math.PI * N);
                speedLimited = true;
            }
            if (D2 < minD2) {
                D2 = minD2;
                N = 60 * U2first / (Math.PI * D2);
                sizeLimited = true;
                speedLimited = false;
            }
        }

        var stages = [];
        var T = T1, P = P1, h = st1.h;

        for (var i = 0; i < nStages; i++) {
            var sIn = state(mix, T, P, model);
            var dIn = derived(mix, T, P, model);
            var Qs = mdot / sIn.rho;                            // m3/s at stage inlet
            var U2 = Math.PI * D2 * N / 60;
            var stagePsi = HpStage / (U2 * U2);
            var phi = Qs / (Math.PI / 4 * D2 * D2 * U2);
            var Mu2 = U2 / dIn.sonic;
            var eye = inletRelativeMach(Qs, U2, D2, dIn.sonic);

            // Step the stage: known head, so integrate up in pressure until the
            // accumulated polytropic head matches HpStage.
            // Bounded by the section discharge - no stage can go past it.
            var out = stepStageByHead(mix, model, T, P, HpStage, etaP, opts.pathSteps || 20, P2);

            stages.push({
                index: i + 1,
                Pin: P / 1e5, Pout: out.P / 1e5,                // bara
                Tin: T - 273.15, Tout: out.T - 273.15,          // degC
                Zin: sIn.Z, rhoIn: sIn.rho,
                Q1: Qs,                                          // m3/s
                Hp: HpStage,
                U2: U2, D2: D2, N: N,
                psi: stagePsi, phi: phi,
                Mu2: Mu2, Mrel: eye.Mrel,
                eyeRatio: eye.eyeRatio, D1: eye.D1,
                sonic: dIn.sonic,
                blading: phi < 0.05 ? '2D' : '3D',
                ok: Mu2 <= lim.mu2Max && eye.Mrel <= lim.mrelMax &&
                    phi >= lim.phiMin && phi <= lim.phiMax && U2 <= imp.u2max
            });

            T = out.T; P = out.P; h = out.h;
        }

        if (!stages.length) {
            throw new Error('The stage solve produced no impellers — check the duty and the machine limits.');
        }

        var outlet = state(mix, T, P, model);
        return {
            HpTotal: HpTotal,
            etaPoly: etaP,
            stages: stages,
            speed: N,
            T2: T,
            outlet: outlet,
            speedLimited: speedLimited,
            sizeLimited: sizeLimited,
            maxSpeed: maxSpeed,
            minD2: minD2
        };
    }

    /**
     * Integrate up in pressure from (T, P) until the accumulated polytropic
     * head reaches HpStage. Bisection on the stage discharge pressure.
     *
     * The upper bound is the section discharge pressure where one is known: a
     * stage can never discharge above it, and probing far beyond can land the
     * search in a dense or two-phase region that has no vapour root, which
     * would abort a calculation whose real answer was perfectly well behaved.
     * A probe that does fail is simply treated as "too high".
     */
    function stepStageByHead(mix, model, T, P, HpStage, etaP, steps, pMax) {
        var lo = P * 1.0001;
        var hi = pMax && pMax > lo ? Math.min(pMax, P * 12) : P * 12;
        var best = null;
        for (var it = 0; it < 50; it++) {
            var mid = Math.sqrt(lo * hi);
            var p;
            try {
                p = compressPath(mix, T, P, mid, etaP, model, Math.max(6, Math.round(steps / 3)));
            } catch (err) {
                hi = mid;                       // unreachable condition: search lower
                continue;
            }
            best = { P: mid, T: p.T2, h: p.outlet.h, Hp: p.Hp };
            if (Math.abs(p.Hp - HpStage) < 1e-4 * Math.max(1, HpStage)) break;
            if (p.Hp < HpStage) lo = mid; else hi = mid;
        }
        if (!best) {
            throw new Error('Could not find a stage discharge pressure for this duty — the gas may be ' +
                            'entering a dense or two-phase region inside the machine.');
        }
        return best;
    }

    /* ===================================================================== */
    /* 14. Multi-section train with intercooling                              */
    /* ===================================================================== */

    /**
     * sections: [{ P2_bara, Tcool_C (outlet of the cooler AFTER this section,
     *              null for the last), dPcool_bar }]
     */
    function runTrain(opts) {
        var mix = opts.mix, model = opts.model;
        var mdot = opts.mdot;
        var lim = Object.assign({}, DEFAULTS, opts.limits || {});
        var imp = opts.impeller || impellerType('std');

        var T = opts.T1, P = opts.P1;
        var out = [];
        var totalStages = 0, totalGasPower = 0, totalShaftPower = 0;

        // A cubic EOS will happily hand back a liquid root without complaint, so
        // check the phase before sizing anything. The Wilson estimate is crude,
        // so only a clear-cut result stops the calculation: dewSum a little over
        // 1 is a warning the UI raises, well over 1 means liquid.
        var inletDew = dewPointWarning(mix, T, P);
        if (inletDew.dewSum > 1.5) {
            throw new Error(
                'At ' + (T - 273.15).toFixed(1) + ' °C and ' + (P / 1e5).toFixed(2) +
                ' bara this mixture is a liquid, not a gas (' + inletDew.heaviest +
                ' is well below its dew point). A centrifugal compressor needs dry vapour at inlet — ' +
                'raise the suction temperature, lower the suction pressure, or check the composition.'
            );
        }

        // On a common shaft every section runs at the same speed, so the first
        // section sets it and the rest inherit. Separate bodies or the pinions
        // of an integrally geared machine are each free to find their own.
        var sharedSpeed = opts.speedManual || null;

        for (var i = 0; i < opts.sections.length; i++) {
            var sec = opts.sections[i];
            var res = runSection({
                mix: mix, model: model,
                T1: T, P1: P, P2: sec.P2,
                mdot: mdot,
                limits: lim, impeller: imp,
                psiTarget: opts.psiTarget,
                phiTarget: opts.phiTarget,
                etaPManual: opts.etaPManual,
                etaMech: opts.etaMech,
                speedManual: sharedSpeed,
                maxSpeed: opts.maxSpeed,
                minD2: opts.minD2,
                pathSteps: opts.pathSteps
            });
            if (opts.commonShaft && !sharedSpeed) sharedSpeed = res.speed;
            res.section = i + 1;
            totalStages += res.nStages;
            totalGasPower += res.gasPower;
            totalShaftPower += res.shaftPower;

            // Intercooler between this section and the next.
            T = res.T2;
            P = sec.P2;
            if (i < opts.sections.length - 1) {
                var Tcool = (sec.Tcool_K != null) ? sec.Tcool_K : T;
                var dPc = sec.dPcool_Pa || 0;
                res.cooler = {
                    Tin: T, Tout: Tcool,
                    Pin: P, Pout: P - dPc,
                    duty: mdot * (state(mix, T, P, model).hMass - state(mix, Tcool, P - dPc, model).hMass),
                    dewWarning: dewPointWarning(mix, Tcool, P - dPc)
                };
                T = Tcool;
                P = P - dPc;
            }
            out.push(res);
        }

        var frame = selectFrame({
            mix: mix,
            Q1: out[0].Q1,
            Pdis: out[out.length - 1].P2,
            totalStages: totalStages,
            speed: out[0].speed,
            nSections: opts.sections.length,
            impeller: imp,
            shaftPower: totalShaftPower
        });

        var rotor = rotordynamicScreen({
            totalStages: totalStages,
            speed: out[0].speed,
            D2: out[0].stages[0].D2,
            shaftPower: totalShaftPower,
            rhoDis: out[out.length - 1].outlet.rho,
            rhoSuc: out[0].inlet.rho
        });

        return {
            sections: out,
            totalStages: totalStages,
            gasPower: totalGasPower,
            shaftPower: totalShaftPower,
            frame: frame,
            rotor: rotor,
            inletDew: inletDew,
            model: model,
            modelName: MODELS[model]
        };
    }

    /* ===================================================================== */
    /* 15. Condensation screening                                             */
    /* ===================================================================== */
    /**
     * Wilson K-value dew-point flag. This is a warning only - no flash is
     * performed and the composition is not changed across a knockout drum.
     */
    function dewPointWarning(mix, T, P) {
        var sum = 0, worst = null, worstK = Infinity;
        for (var i = 0; i < mix.comps.length; i++) {
            var c = mix.comps[i];
            var K = (c.Pc * 1e5 / P) * Math.exp(5.373 * (1 + c.omega) * (1 - c.Tc / T));
            sum += mix.y[i] / K;
            if (mix.y[i] > 1e-4 && K < worstK) { worstK = K; worst = c; }
        }
        return {
            dewSum: sum,                        // > 1 indicates the dew point is crossed
            condensing: sum > 1.0,
            heaviest: worst ? worst.name : null,
            heaviestK: worstK
        };
    }

    /* ===================================================================== */
    /* 16. Frame / compressor type selection                                  */
    /* ===================================================================== */

    function selectFrame(o) {
        var Pdis_bar = o.Pdis / 1e5;
        var MW = o.mix.MW;
        var reasons = [];
        var type, casing;

        // Hydrogen partial pressure - API 617 calls for a vertically split
        // (barrel) casing above about 1.4 MPa (200 psi) H2 partial pressure.
        var yH2 = 0;
        for (var i = 0; i < o.mix.comps.length; i++) {
            if (o.mix.comps[i].id === 'H2') yH2 = o.mix.y[i];
        }
        var pH2_bar = yH2 * Pdis_bar;

        if (o.impeller.open && o.nSections >= 2) {
            type = 'Integrally geared multi-shaft';
            casing = 'Individual stage casings on a common bull gear';
            reasons.push('Open impellers with intercooling between stages - the classic integrally geared arrangement.');
            reasons.push('Pinion speeds are set per stage, so each stage can sit at its own best flow coefficient.');
        } else if (o.totalStages === 1 && Pdis_bar < 20) {
            type = 'Single-stage overhung';
            casing = 'Overhung, radially split';
            reasons.push('One stage at modest discharge pressure - an overhung machine is the cheapest arrangement.');
        } else if (pH2_bar >= 14) {
            type = 'Beam-type (between-bearings) multistage';
            casing = 'Vertically split barrel';
            reasons.push('Hydrogen partial pressure at discharge is ' + pH2_bar.toFixed(1) +
                         ' bar, at or above the ~14 bar (200 psi) API 617 threshold for a barrel casing.');
        } else if (Pdis_bar >= 60) {
            type = 'Beam-type (between-bearings) multistage';
            casing = 'Vertically split barrel';
            reasons.push('Discharge pressure ' + Pdis_bar.toFixed(1) + ' bara is above the ~60 bara point where barrel casings take over.');
        } else if (Pdis_bar >= 40 && MW < 12) {
            type = 'Beam-type (between-bearings) multistage';
            casing = 'Vertically split barrel';
            reasons.push('Light gas (MW ' + MW.toFixed(1) + ') at ' + Pdis_bar.toFixed(1) +
                         ' bara - sealing a horizontally split joint gets difficult.');
        } else {
            type = 'Beam-type (between-bearings) multistage';
            casing = 'Horizontally split';
            reasons.push('Discharge pressure ' + Pdis_bar.toFixed(1) + ' bara and MW ' + MW.toFixed(1) +
                         ' are comfortably inside the horizontally split range.');
        }

        if (o.Q1 * 3600 > 200000 && o.totalStages <= 2) {
            reasons.push('Inlet volume flow above 200,000 m³/h with very little head - an axial machine may suit this duty better than a centrifugal.');
        }
        if (o.totalStages > DEFAULTS.maxStagesPerBody) {
            reasons.push('At ' + o.totalStages + ' stages the machine exceeds the ~' + DEFAULTS.maxStagesPerBody +
                         ' impellers normally put in one body - expect a tandem or two-body train.');
        }

        var speedNote = null;
        if (o.speed > 20000 && !o.impeller.open) {
            speedNote = 'Predicted speed ' + Math.round(o.speed) + ' rpm is above the usual beam-type ceiling (~20,000 rpm) - a geared or integrally geared machine is implied.';
        } else if (o.speed < 3000) {
            speedNote = 'Predicted speed ' + Math.round(o.speed) + ' rpm is low for a centrifugal - check the head split, or consider a direct 2-pole/4-pole motor drive.';
        }
        if (speedNote) reasons.push(speedNote);

        return {
            type: type,
            casing: casing,
            reasons: reasons,
            h2PartialPressure_bar: pH2_bar,
            gearRequired: o.speed > 3600
        };
    }

    /* ===================================================================== */
    /* 17. Rotordynamic screening (indicative only)                           */
    /* ===================================================================== */

    function rotordynamicScreen(o) {
        // Impeller pitch is roughly 0.30-0.35 of the tip diameter; add the
        // balance piston, seals and bearing spans at each end.
        var pitch = 0.33 * o.D2;
        var span = pitch * o.totalStages + 1.6 * o.D2;
        var shaftDia = 0.30 * o.D2;
        var LD = span / Math.max(shaftDia, 1e-6);

        // First critical of a bare simply supported steel shaft:
        //   omega = (pi^2/L^2) * sqrt(EI/(rho*A)),  I/A = d^2/16
        //   sqrt(E/rho) = 5135 m/s for steel, which reduces to
        //   N [rpm] ~ 121000 * d / L^2
        // The impeller and thrust-collar mass pulls that down substantially, so
        // a 0.55 loading knockdown is applied. Order of magnitude only.
        var nc1 = 121000 * 0.55 * shaftDia / (span * span);   // rpm
        var flexRatio = o.speed / Math.max(nc1, 1);

        // API 617 Level-I style aerodynamic cross-coupling indicator.
        var qa = (o.shaftPower / 1000) * o.totalStages / Math.max(o.speed, 1) * (o.rhoDis / Math.max(o.rhoSuc, 1e-6));

        var flags = [];
        if (LD > 12) flags.push('Bearing-span-to-shaft-diameter ratio of ' + LD.toFixed(1) + ' is high - a flexible rotor, expect to cross the first critical.');
        if (flexRatio > 2.5) flags.push('Operating speed is well above the estimated first critical - stability needs a proper Level II analysis.');
        if (qa > 8) flags.push('High power, high stage count and a large density rise - aerodynamic cross-coupling is a real concern, consider a shunt-injected or hole-pattern seal.');
        if (!flags.length) flags.push('No obvious rotordynamic red flags at this level of screening.');

        return {
            bearingSpan: span,
            shaftDia: shaftDia,
            LD: LD,
            firstCriticalEst: nc1,
            flexRatio: flexRatio,
            crossCouplingIndex: qa,
            flags: flags,
            disclaimer: 'Indicative screening only - not a substitute for an API 617 lateral and stability analysis.'
        };
    }

    /* ===================================================================== */
    /* 18. Driver rating                                                      */
    /* ===================================================================== */

    var IEC_KW = [7.5, 11, 15, 18.5, 22, 30, 37, 45, 55, 75, 90, 110, 132, 160, 200, 250,
                  315, 355, 400, 450, 500, 560, 630, 710, 800, 900, 1000, 1120, 1250, 1400,
                  1600, 1800, 2000, 2240, 2500, 2800, 3150, 3550, 4000, 4500, 5000, 5600,
                  6300, 7100, 8000, 9000, 10000, 11200, 12500, 14000, 16000, 18000, 20000];

    var NEMA_HP = [10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 350,
                   400, 450, 500, 600, 700, 800, 900, 1000, 1250, 1500, 1750, 2000, 2250,
                   2500, 3000, 3500, 4000, 4500, 5000, 6000, 7000, 8000, 9000, 10000,
                   12000, 15000, 20000, 25000];

    function nextSize(list, value) {
        for (var i = 0; i < list.length; i++) if (list[i] >= value) return list[i];
        return list[list.length - 1];
    }

    /**
     * Train power and driver rating. The gear and coupling loss chain is the
     * same one used by CompressorCalc_9.html so the two tools agree.
     */
    function driverRating(shaftPower_W, opts) {
        var o = opts || {};
        var p = shaftPower_W;
        var gearLoss = o.gearbox ? 0.02 : 0;
        var couplingLoss = 0.005;
        var atDriver = p * (1 + gearLoss) * (1 + couplingLoss);
        // API 617 asks the driver to be rated for 110% of the maximum power.
        var margin = (o.margin != null) ? o.margin : 0.10;
        var rated = atDriver * (1 + margin);
        return {
            gasSide: p,
            atDriver: atDriver,
            rated: rated,
            iec_kW: nextSize(IEC_KW, rated / 1000),
            nema_hp: nextSize(NEMA_HP, rated / 745.6998715822702),
            gearLoss: gearLoss,
            couplingLoss: couplingLoss,
            margin: margin
        };
    }

    /* ===================================================================== */
    /* 19. Gas presets                                                        */
    /* ===================================================================== */

    var PRESETS = {
        'Lean natural gas': [
            { id: 'C1', molPct: 92.0 }, { id: 'C2', molPct: 4.0 }, { id: 'C3', molPct: 1.2 },
            { id: 'nC4', molPct: 0.4 }, { id: 'N2', molPct: 1.4 }, { id: 'CO2', molPct: 1.0 }
        ],
        'Rich natural gas': [
            { id: 'C1', molPct: 78.0 }, { id: 'C2', molPct: 9.0 }, { id: 'C3', molPct: 5.5 },
            { id: 'iC4', molPct: 1.2 }, { id: 'nC4', molPct: 1.8 }, { id: 'iC5', molPct: 0.6 },
            { id: 'nC5', molPct: 0.5 }, { id: 'nC6', molPct: 0.4 }, { id: 'N2', molPct: 1.0 },
            { id: 'CO2', molPct: 2.0 }
        ],
        'CO2-rich / EOR': [
            { id: 'CO2', molPct: 95.0 }, { id: 'C1', molPct: 2.5 }, { id: 'N2', molPct: 2.0 },
            { id: 'H2S', molPct: 0.5 }
        ],
        'Refinery H2 makeup': [
            { id: 'H2', molPct: 88.0 }, { id: 'C1', molPct: 7.0 }, { id: 'C2', molPct: 3.0 },
            { id: 'C3', molPct: 1.5 }, { id: 'N2', molPct: 0.5 }
        ],
        'Sour gas': [
            { id: 'C1', molPct: 70.0 }, { id: 'C2', molPct: 5.0 }, { id: 'C3', molPct: 2.0 },
            { id: 'CO2', molPct: 8.0 }, { id: 'H2S', molPct: 14.0 }, { id: 'N2', molPct: 1.0 }
        ],
        'Air': [
            { id: 'N2', molPct: 78.08 }, { id: 'O2', molPct: 20.95 }, { id: 'Ar', molPct: 0.93 },
            { id: 'CO2', molPct: 0.04 }
        ],
        'Nitrogen': [{ id: 'N2', molPct: 100 }],
        'Ethylene': [{ id: 'C2=', molPct: 99.5 }, { id: 'C2', molPct: 0.5 }],
        'Propane refrigerant': [{ id: 'C3', molPct: 99.0 }, { id: 'C2', molPct: 0.6 }, { id: 'iC4', molPct: 0.4 }],
        'Flare / wet gas': [
            { id: 'C1', molPct: 55.0 }, { id: 'C2', molPct: 12.0 }, { id: 'C3', molPct: 10.0 },
            { id: 'nC4', molPct: 6.0 }, { id: 'nC5', molPct: 4.0 }, { id: 'nC6', molPct: 3.0 },
            { id: 'N2', molPct: 5.0 }, { id: 'CO2', molPct: 4.0 }, { id: 'H2O', molPct: 1.0 }
        ]
    };

    /* ===================================================================== */
    /* 20. Unit conversion                                                    */
    /* ===================================================================== */
    /* Every catalogue entry converts to and from the engine's SI base unit,
       following the {code, label, toBase, fromBase} shape already used by the
       UOM calculator on the hub.                                            */

    function lin(f) { return { toBase: function (v) { return v * f; }, fromBase: function (v) { return v / f; } }; }

    var UNITS = {
        pressure: {                             // base Pa
            base: 'Pa',
            SI: 'bara', US: 'psia',
            list: [
                Object.assign({ code: 'bara', label: 'bara' }, lin(1e5)),
                Object.assign({ code: 'kPaa', label: 'kPa a' }, lin(1e3)),
                Object.assign({ code: 'MPaa', label: 'MPa a' }, lin(1e6)),
                Object.assign({ code: 'psia', label: 'psia' }, lin(6894.757293168361)),
                Object.assign({ code: 'kgcm2a', label: 'kg/cm² a' }, lin(98066.5))
            ]
        },
        temperature: {                          // base K
            base: 'K',
            SI: 'C', US: 'F',
            list: [
                { code: 'C', label: '°C', toBase: function (v) { return v + 273.15; }, fromBase: function (v) { return v - 273.15; } },
                { code: 'F', label: '°F', toBase: function (v) { return (v + 459.67) * 5 / 9; }, fromBase: function (v) { return v * 9 / 5 - 459.67; } },
                { code: 'K', label: 'K', toBase: function (v) { return v; }, fromBase: function (v) { return v; } }
            ]
        },
        massFlow: {                             // base kg/s
            base: 'kg/s',
            SI: 'kg/h', US: 'lb/h',
            list: [
                Object.assign({ code: 'kg/h', label: 'kg/h' }, lin(1 / 3600)),
                Object.assign({ code: 'kg/s', label: 'kg/s' }, lin(1)),
                Object.assign({ code: 't/h', label: 't/h' }, lin(1000 / 3600)),
                Object.assign({ code: 'lb/h', label: 'lb/h' }, lin(0.45359237 / 3600)),
                Object.assign({ code: 'MMSCFD', label: 'MMSCFD', mw: true }, lin(1))
            ]
        },
        volFlow: {                              // base m3/s
            base: 'm3/s',
            SI: 'm³/h', US: 'ACFM',
            list: [
                Object.assign({ code: 'm3/h', label: 'm³/h' }, lin(1 / 3600)),
                Object.assign({ code: 'm3/s', label: 'm³/s' }, lin(1)),
                Object.assign({ code: 'ACFM', label: 'ACFM' }, lin(0.0283168466 / 60)),
                Object.assign({ code: 'ACFH', label: 'ACFH' }, lin(0.0283168466 / 3600))
            ]
        },
        power: {                                // base W
            base: 'W',
            SI: 'kW', US: 'hp',
            list: [
                Object.assign({ code: 'kW', label: 'kW' }, lin(1000)),
                Object.assign({ code: 'MW', label: 'MW' }, lin(1e6)),
                Object.assign({ code: 'hp', label: 'hp' }, lin(745.6998715822702))
            ]
        },
        length: {                               // base m
            base: 'm',
            SI: 'mm', US: 'in',
            list: [
                Object.assign({ code: 'mm', label: 'mm' }, lin(1e-3)),
                Object.assign({ code: 'm', label: 'm' }, lin(1)),
                Object.assign({ code: 'in', label: 'in' }, lin(0.0254))
            ]
        },
        head: {                                 // base J/kg
            base: 'J/kg',
            SI: 'kJ/kg', US: 'ft.lbf/lbm',
            list: [
                Object.assign({ code: 'kJ/kg', label: 'kJ/kg' }, lin(1000)),
                Object.assign({ code: 'J/kg', label: 'J/kg' }, lin(1)),
                Object.assign({ code: 'm', label: 'm (head)' }, lin(9.80665)),
                Object.assign({ code: 'ft.lbf/lbm', label: 'ft·lbf/lbm' }, lin(2.9890669))
            ]
        },
        density: {                              // base kg/m3
            base: 'kg/m3',
            SI: 'kg/m³', US: 'lb/ft³',
            list: [
                Object.assign({ code: 'kg/m3', label: 'kg/m³' }, lin(1)),
                Object.assign({ code: 'lb/ft3', label: 'lb/ft³' }, lin(16.0184634))
            ]
        },
        velocity: {                             // base m/s
            base: 'm/s',
            SI: 'm/s', US: 'ft/s',
            list: [
                Object.assign({ code: 'm/s', label: 'm/s' }, lin(1)),
                Object.assign({ code: 'ft/s', label: 'ft/s' }, lin(0.3048))
            ]
        }
    };

    function unitDef(category, code) {
        var cat = UNITS[category];
        if (!cat) return null;
        for (var i = 0; i < cat.list.length; i++) if (cat.list[i].code === code) return cat.list[i];
        return null;
    }

    function toBase(category, code, value) {
        var u = unitDef(category, code);
        return u ? u.toBase(Number(value)) : Number(value);
    }

    function fromBase(category, code, value) {
        var u = unitDef(category, code);
        return u ? u.fromBase(Number(value)) : Number(value);
    }

    function convert(category, from, to, value) {
        return fromBase(category, to, toBase(category, from, value));
    }

    /* Default unit code per category for each of the two systems. */
    function systemUnits(system) {
        var out = {};
        Object.keys(UNITS).forEach(function (cat) {
            var c = UNITS[cat];
            var wanted = (system === 'US') ? c.US : c.SI;
            // The SI/US fields hold labels for display; map them back to codes.
            var match = c.list.filter(function (u) { return u.label === wanted || u.code === wanted; })[0];
            out[cat] = match ? match.code : c.list[0].code;
        });
        return out;
    }

    /* ===================================================================== */
    /* 21. Self test                                                          */
    /* ===================================================================== */
    /**
     * Repeatable numerical checks. Returns an array of
     * { name, value, expected, tolerance, pass, note }.
     * Called from the UI by appending ?selftest=1 to the page URL.
     */
    function selfTest() {
        var out = [];
        function check(name, value, expected, tol, note) {
            var pass = isFinite(value) && Math.abs(value - expected) <= tol;
            out.push({ name: name, value: value, expected: expected, tolerance: tol, pass: pass, note: note || '' });
        }

        // 1. Ideal-gas limit: air at 1 bara, 20 degC must give Z ~ 1.
        var air = makeMixture(PRESETS['Air']);
        var zAir = state(air, 293.15, 1e5, 'PR').Z;
        check('Air Z at 1 bara / 20 °C (PR)', zAir, 1.0, 0.002, 'Catches sign errors in the departure functions.');

        // 2. Air MW.
        check('Air molecular weight', air.MW, 28.96, 0.05, 'Composition and mixing arithmetic.');

        // 3. Pure CO2 at 20 bara, 40 degC. The virial estimate puts Z near
        //    0.92; PR sits a couple of percent low this close to the critical
        //    point, which is expected. A value near 1.0, or a liquid-like root
        //    around 0.1, would mean the cubic root selection is wrong.
        var co2 = makeMixture([{ id: 'CO2', molPct: 100 }]);
        var zCO2 = state(co2, 313.15, 20e5, 'PR').Z;
        check('CO₂ Z at 20 bara / 40 °C (PR)', zCO2, 0.91, 0.03, 'Wrong root selection shows up here as ~1.0 or ~0.1.');

        // 4. Methane at 50 bara, 20 degC against NIST (Z = 0.8964). PR is
        //    accurate for light hydrocarbons well away from the critical point,
        //    so this one is a genuine accuracy check rather than a smoke test.
        var c1 = makeMixture([{ id: 'C1', molPct: 100 }]);
        var zC1 = state(c1, 293.15, 50e5, 'PR').Z;
        check('CH₄ Z at 50 bara / 20 °C vs NIST (PR)', zC1, 0.8964, 0.01, 'Reference value from NIST REFPROP.');

        // 5. PR and SRK must agree closely on a light hydrocarbon mixture.
        var ng = makeMixture(PRESETS['Lean natural gas']);
        var zPR = state(ng, 313.15, 30e5, 'PR').Z;
        var zSRK = state(ng, 313.15, 30e5, 'SRK').Z;
        check('PR vs SRK Z spread, lean gas at 30 bara', Math.abs(zPR - zSRK), 0, 0.02, 'A large gap means a constant is transcribed wrong.');

        // 6. Lee-Kesler agrees with PR to within a few percent on the same gas.
        var zLK = state(ng, 313.15, 30e5, 'LK').Z;
        check('PR vs Lee-Kesler Z spread, lean gas at 30 bara', Math.abs(zPR - zLK), 0, 0.03, '');

        // 6b. Thermodynamic consistency of the departure functions, for every
        //     model. The Maxwell relation d(H-H^ig)/dP|T = v - T(dv/dT)|P must
        //     hold exactly; it is the check that catches an inverted log term
        //     or a wrong sign, which a plain Z comparison sails straight past.
        var etTest = makeMixture([{ id: 'C2=', molPct: 100 }]);
        ['PR', 'SRK', 'LK'].forEach(function (mdl) {
            var T = 313.15, P = 30e5, dP = P * 1e-5, dT = 0.02;
            var lhs = (state(etTest, T, P + dP, mdl).h - state(etTest, T, P - dP, mdl).h) / (2 * dP);
            var dvdT = (molarVolume(etTest, T + dT, P, mdl) - molarVolume(etTest, T - dT, P, mdl)) / (2 * dT);
            var rhs = molarVolume(etTest, T, P, mdl) - T * dvdT;
            check('Departure consistency d(H−Hig)/dP = v − T(dv/dT), ' + mdl,
                  Math.abs(lhs - rhs) / Math.abs(rhs), 0, 0.01, 'Relative error in the Maxwell relation.');
        });

        // 6c. Real Cp must exceed the ideal-gas Cp for these gases at pressure.
        ['PR', 'SRK', 'LK'].forEach(function (mdl) {
            var cpReal = derived(etTest, 313.15, 30e5, mdl).cpMolar;
            var cpIdeal = cpIdealMolar(etTest, 313.15);
            check('Real Cp above ideal-gas Cp, ethylene 30 bara, ' + mdl,
                  cpReal > cpIdeal ? 1 : 0, 1, 0.5,
                  'Cp real ' + cpReal.toFixed(2) + ' vs ideal ' + cpIdeal.toFixed(2) + ' J/(mol·K).');
        });

        // 7. Ideal-gas Cp of air near ambient is about 29.1 J/mol.K.
        check('Air ideal-gas Cp at 25 °C', cpIdealMolar(air, 298.15), 29.1, 0.6, 'J/(mol·K)');

        // 8. Air acoustic velocity at 20 degC, 1 bara is about 343 m/s.
        check('Air acoustic velocity at 20 °C', derived(air, 293.15, 1e5, 'PR').sonic, 343, 6, 'm/s');

        // 9. Low-pressure air compression must match the ideal polytropic
        //    relation closely, since Z is essentially 1 at both ends.
        var pth = compressPath(air, 293.15, 1e5, 2e5, 0.75, 'PR', 40);
        var d = derived(air, 293.15, 1e5, 'PR');
        var kk = d.gamma;
        var nn = 1 / (1 - ((kk - 1) / (kk * 0.75)));
        var t2Ideal = 293.15 * Math.pow(2, (nn - 1) / nn);
        check('Air 1→2 bara: T₂ vs ideal polytropic', pth.T2, t2Ideal, 1.5, 'K - the near-ideal case must agree.');

        // 10. Aerodynamic closure: rebuilding Hp and Q1 from the reported
        //     coefficients must return the inputs exactly.
        var geo = stageGeometry(30000, 5.0, 0.52, 0.075);
        var HpBack = 0.52 * geo.U2 * geo.U2;
        var QBack = 0.075 * (Math.PI / 4 * geo.D2 * geo.D2) * geo.U2;
        check('Aero closure: head from ψU₂²', HpBack, 30000, 1, 'J/kg');
        check('Aero closure: flow from φ·A·U₂', QBack, 5.0, 1e-6, 'm³/s');
        check('Aero closure: U₂ from πDN/60', Math.PI * geo.D2 * geo.N / 60, geo.U2, 1e-6, 'm/s');

        // 11. Head consistency: the integrated path, Schultz and the simple
        //     polytropic form must agree on a near-ideal duty.
        var ngPath = compressPath(ng, 313.15, 5e5, 15e5, 0.78, 'PR', 40);
        var sch = schultzHead(ng, ngPath);
        check('Integrated vs Schultz head, lean gas 5→15 bara',
              Math.abs(sch.Hp - ngPath.Hp) / ngPath.Hp, 0, 0.02,
              'Relative difference; the two must agree closely on a near-ideal duty.');

        // 12. Polytropic efficiency recovered from the integrated path must be
        //     the value that was fed in.
        check('Polytropic efficiency round-trip', ngPath.etaPoly, 0.78, 0.005, '');

        // 12b. The single-step polytropic form must also land close on a
        //      near-ideal duty. A result high by a factor of n means the head
        //      coefficient has been written as n/exp instead of 1/exp.
        var dNg = derived(ng, 313.15, 5e5, 'PR');
        var simpleNg = simplePolytropicHead(ng, 313.15, 5e5, 15e5, ngPath.inlet.Z, dNg.kv, 0.78);
        check('Integrated vs single-step polytropic head',
              Math.abs(simpleNg - ngPath.Hp) / ngPath.Hp, 0, 0.05,
              'Relative difference; a value near 0.5 means the classic n/exp slip.');

        // 13. A full train must close on stage count, head and power.
        var mix = makeMixture(PRESETS['Lean natural gas']);
        var train = runTrain({
            mix: mix, model: 'PR', T1: 313.15, P1: 30e5, mdot: 20000 / 3600,
            sections: [{ P2: 90e5 }]
        });
        var s0 = train.sections[0];
        var headSum = s0.stages.reduce(function (a, st) { return a + st.Hp; }, 0);
        check('Train: stage heads sum to section head', headSum, s0.HpTotal, s0.HpTotal * 1e-6, 'J/kg');
        check('Train: gas power = ṁ·Hp/ηp',
              s0.gasPower, (20000 / 3600) * s0.HpTotal / s0.etaPoly, 1, 'W');

        return out;
    }

    /* ===================================================================== */
    /* Exports                                                                */
    /* ===================================================================== */

    global.CompEng = {
        R: R,
        COMPONENTS: COMPONENTS,
        BY_ID: BY_ID,
        KIJ_DEFAULT: KIJ_DEFAULT,
        PRESETS: PRESETS,
        MODELS: MODELS,
        DEFAULTS: DEFAULTS,
        IMPELLER_TYPES: IMPELLER_TYPES,
        UNITS: UNITS,

        makeMixture: makeMixture,
        getKij: getKij,
        kijKey: kijKey,
        impellerType: impellerType,

        state: state,
        derived: derived,
        cpIdealMolar: cpIdealMolar,
        solveTfromH: solveTfromH,
        solveTfromS: solveTfromS,

        compressPath: compressPath,
        schultzHead: schultzHead,
        simplePolytropicHead: simplePolytropicHead,

        baseEtaP: baseEtaP,
        predictEtaP: predictEtaP,
        stageGeometry: stageGeometry,
        stageAtSpeed: stageAtSpeed,
        inletRelativeMach: inletRelativeMach,

        runSection: runSection,
        runTrain: runTrain,
        dewPointWarning: dewPointWarning,
        selectFrame: selectFrame,
        rotordynamicScreen: rotordynamicScreen,
        driverRating: driverRating,

        unitDef: unitDef,
        toBase: toBase,
        fromBase: fromBase,
        convert: convert,
        systemUnits: systemUnits,

        selfTest: selfTest,
        clamp: clamp
    };

})(typeof window !== 'undefined' ? window : globalThis);
