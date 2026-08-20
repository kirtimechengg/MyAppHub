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
        // 2-Methylpentane is a branched isomer of n-Hexane (id nC6, same
        // formula/MW). Its ideal-gas Cp(T) is governed by degrees of
        // freedom, not connectivity, so it's essentially identical to
        // n-Hexane's - the cp array below is reused from nC6 rather than
        // independently sourced.
        { id: 'iC6',   name: '2-Methylpentane',  formula: 'C6H14',  MW: 86.177,  Tc: 497.50, Pc: 30.40,  omega: 0.2797, Tb: 333.41, cp: [-4.413,  5.820e-1, -3.119e-4,  6.494e-8], group: 'Hydrocarbon' },
        // Quadratic (no cubic term), same style already used for He/Ar above.
        { id: 'cC6',   name: 'Cyclohexane',      formula: 'C6H12',  MW: 84.161,  Tc: 553.60, Pc: 40.75,  omega: 0.2096, Tb: 353.87, cp: [-32.220, 5.047e-1, -1.643e-4,  0       ], group: 'Hydrocarbon' },

        { id: 'C2=',   name: 'Ethylene',         formula: 'C2H4',   MW: 28.054,  Tc: 282.34, Pc: 50.41,  omega: 0.087,  Tb: 169.42, cp: [ 3.806,  1.566e-1, -8.348e-5,  1.755e-8], group: 'Olefin / Aromatic' },
        { id: 'C3=',   name: 'Propylene',        formula: 'C3H6',   MW: 42.081,  Tc: 364.90, Pc: 46.00,  omega: 0.142,  Tb: 225.46, cp: [ 3.710,  2.345e-1, -1.160e-4,  2.205e-8], group: 'Olefin / Aromatic' },
        { id: 'C4=',   name: '1-Butene',         formula: 'C4H8',   MW: 56.107,  Tc: 419.50, Pc: 40.20,  omega: 0.194,  Tb: 266.90, cp: [-2.994,  3.532e-1, -1.990e-4,  4.463e-8], group: 'Olefin / Aromatic' },
        { id: 'BZ',    name: 'Benzene',          formula: 'C6H6',   MW: 78.114,  Tc: 562.05, Pc: 48.95,  omega: 0.210,  Tb: 353.24, cp: [-33.917, 4.743e-1, -3.017e-4,  7.130e-8], group: 'Olefin / Aromatic' },
        { id: 'TOL',   name: 'Toluene',          formula: 'C7H8',   MW: 92.141,  Tc: 591.75, Pc: 41.08,  omega: 0.264,  Tb: 383.79, cp: [-24.355, 5.125e-1, -2.765e-4,  4.911e-8], group: 'Olefin / Aromatic' },
        // Both xylene isomers share this cp array: like the paraffins above,
        // isomers' ideal-gas Cp(T) is essentially identical, and this one is
        // itself Toluene's cp plus one CH2-equivalent increment (the same
        // increment the nC6->nC7 step already carries), not an independently
        // sourced fit.
        { id: 'oXYL',  name: 'o-Xylene',         formula: 'C8H10',  MW: 106.165, Tc: 630.30, Pc: 37.30,  omega: 0.312,  Tb: 417.58, cp: [-25.088, 6.067e-1, -3.297e-4,  6.075e-8], group: 'Olefin / Aromatic' },
        { id: 'pXYL',  name: 'p-Xylene',         formula: 'C8H10',  MW: 106.165, Tc: 616.20, Pc: 35.10,  omega: 0.324,  Tb: 411.51, cp: [-25.088, 6.067e-1, -3.297e-4,  6.075e-8], group: 'Olefin / Aromatic' },

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
        { id: 'MeOH',  name: 'Methanol',         formula: 'CH4O',   MW: 32.042,  Tc: 512.64, Pc: 80.97,  omega: 0.565,  Tb: 337.69, cp: [21.152,  7.092e-2,  2.587e-5, -2.852e-8], group: 'Polar / Other' },

        // Hypothetical 901/902/903: not real chemicals - performance-test-
        // code placeholder components defined only by molecular weight.
        // Every property below is a straight MW-weighted linear interpolation
        // between this database's own bracketing n-paraffin entries above
        // (e.g. 901 at MW 96.00 sits 70% of the way from nC6 to nC7, so every
        // property is that same 70/30 blend of those two rows) - an
        // engineering estimate, not literature data. Treated as paraffin-like
        // because that is the standard assumption for an undefined heavy-end
        // hydrocarbon test component.
        { id: 'HYP901', name: 'Hypothetical 901', formula: '-', MW: 96.00,  Tc: 530.43, Pc: 28.25, omega: 0.3350, Tb: 362.67, cp: [-4.926, 6.480e-1, -3.492e-4, 7.309e-8], group: 'Hypothetical (MW-estimated)' },
        { id: 'HYP902', name: 'Hypothetical 902', formula: '-', MW: 106.9,  Tc: 553.80, Pc: 26.21, omega: 0.3734, Tb: 384.58, cp: [-5.599, 7.216e-1, -3.911e-4, 8.229e-8], group: 'Hypothetical (MW-estimated)' },
        { id: 'HYP903', name: 'Hypothetical 903', formula: '-', MW: 120.1,  Tc: 579.54, Pc: 24.06, omega: 0.4183, Tb: 409.34, cp: [-7.049, 8.138e-1, -4.458e-4, 9.464e-8], group: 'Hypothetical (MW-estimated)' }
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

    /* Aungier polytropic efficiency characteristic, digitised from the
       published figure rather than reproduced algebraically - the curve is
       read off the chart at the points below and linearly interpolated
       between them, so treat it as good to roughly +/-0.01, not as an exact
       restatement of Aungier's own equations. Efficiency here is a function
       of flow coefficient alone; unlike the built-in correlation it carries
       no explicit machine-size term, which is why very small phi drops away
       so steeply. Vaned diffusers run slightly higher than vaneless over
       most of the range and fall off less sharply at low phi. */
    var AUNGIER_ETA = {
        phi:      [0.0025, 0.005, 0.010, 0.015, 0.020, 0.030, 0.040, 0.050, 0.060, 0.070,
                   0.080, 0.090, 0.100, 0.110, 0.120, 0.140, 0.160, 0.180, 0.200],
        vaned:    [0.400, 0.550, 0.655, 0.710, 0.745, 0.790, 0.815, 0.831, 0.843, 0.850,
                   0.855, 0.858, 0.860, 0.859, 0.855, 0.842, 0.828, 0.816, 0.805],
        vaneless: [0.255, 0.450, 0.600, 0.665, 0.705, 0.762, 0.792, 0.810, 0.822, 0.832,
                   0.839, 0.843, 0.845, 0.845, 0.843, 0.835, 0.822, 0.808, 0.795]
    };

    /* diffuser: 'vaned' | 'vaneless'. Held flat outside the digitised range
       rather than extrapolated - the curve's shape past either end isn't
       something the figure supports claiming. */
    function aungierEtaP(phi, diffuser) {
        var ys = AUNGIER_ETA[diffuser === 'vaned' ? 'vaned' : 'vaneless'];
        var xs = AUNGIER_ETA.phi;
        if (!isFinite(phi)) return ys[0];
        if (phi <= xs[0]) return ys[0];
        if (phi >= xs[xs.length - 1]) return ys[ys.length - 1];
        for (var i = 1; i < xs.length; i++) {
            if (phi <= xs[i]) {
                var t = (phi - xs[i - 1]) / (xs[i] - xs[i - 1]);
                return ys[i - 1] + t * (ys[i] - ys[i - 1]);
            }
        }
        return ys[ys.length - 1];
    }

    /* Aungier impeller axial length: L/D2 = 0.014 + 0.023*(D2/D1) + 1.58*phi.
       The published figure draws this as a single straight line because it
       fixes the eye ratio; here D1/D2 comes from the stage that was actually
       solved, so the line moves with the geometry instead of assuming it.
       At the figure's implied D1/D2 = 0.35 this reproduces its 0.08 intercept
       and 0.333 value at phi = 0.16. */
    function aungierAxialLengthRatio(phi, eyeRatio) {
        var r = (isFinite(eyeRatio) && eyeRatio > 0) ? eyeRatio : 0.35;
        return 0.014 + 0.023 / r + 1.58 * (isFinite(phi) && phi > 0 ? phi : 0);
    }

    /* etaModel: undefined/'builtin' keeps the flow-based correlation above;
       'aungier-vaned' / 'aungier-vaneless' switch to the digitised curves.
       Aungier depends only on phi, so the first pass - before any stage
       geometry exists - still falls back to the flow-only estimate to give
       the solve loop somewhere to start; it converges on the Aungier value
       once a flow coefficient is known. */
    function predictEtaP(Q1_m3h, phi, etaModel) {
        if (etaModel === 'aungier-vaned' || etaModel === 'aungier-vaneless') {
            if (isFinite(phi) && phi > 0) {
                return aungierEtaP(phi, etaModel === 'aungier-vaned' ? 'vaned' : 'vaneless');
            }
            return baseEtaP(Q1_m3h);
        }
        var eta = baseEtaP(Q1_m3h);
        if (isFinite(phi) && phi > 0) eta *= phiEfficiencyFactor(phi);
        return clamp(eta, 0.68, 0.87);
    }

    /* ===================================================================== */
    /* 11. Impeller material / tip-speed limits                               */
    /* ===================================================================== */

    /* mu2Max is the peripheral Mach number the blading is designed around, and
       it is a property of the impeller, not of the gas. A closed 2D stage on a
       beam-type rotor is laid out for about 1.05; an open, backswept 3D
       impeller of the kind an integrally geared machine uses is built for
       transonic duty and runs comfortably to 1.3. Using one figure for both
       makes every integrally geared stage look illegal. */
    var IMPELLER_TYPES = [
        { id: 'cast',    label: 'Cast / high-MW / erosive duty',        u2max: 260, psiMax: 0.62, mu2Max: 1.00, open: false },
        { id: 'std',     label: 'Closed steel, standard (17-4PH, 4340)', u2max: 320, psiMax: 0.62, mu2Max: 1.05, open: false },
        { id: 'hs',      label: 'Closed steel, high strength',           u2max: 375, psiMax: 0.62, mu2Max: 1.10, open: false },
        { id: 'open',    label: 'Open / semi-open (integrally geared)',  u2max: 500, psiMax: 0.75, mu2Max: 1.30, open: true  },
        { id: 'ti',      label: 'Titanium',                              u2max: 600, psiMax: 0.75, mu2Max: 1.35, open: true  }
    ];

    function impellerType(id) {
        for (var i = 0; i < IMPELLER_TYPES.length; i++) {
            if (IMPELLER_TYPES[i].id === id) return IMPELLER_TYPES[i];
        }
        return IMPELLER_TYPES[1];
    }

    /* ===================================================================== */
    /* 11b. Machine architecture                                              */
    /* ===================================================================== */
    /**
     * The architecture is chosen by the engineer rather than inferred, because
     * it decides how the machine is built before any aerodynamics happen:
     *
     *  beam     - impellers in series on one shaft between two bearings. One
     *             speed per body. Sections are separate bodies.
     *  igc      - integrally geared. A bull gear at driver speed drives two to
     *             four pinions, each carrying one or two overhung impellers,
     *             with an intercooler after every stage. Each pinion runs at its
     *             own speed, which is what lets every stage sit near its own
     *             best flow coefficient.
     *  overhung - a single impeller overhung on one shaft end.
     *
     * stagesPerSection pins how many impellers a section may hold (null = free).
     */
    var ARCHITECTURES = {
        beam: {
            id: 'beam', label: 'Beam-type (between bearings)', impeller: 'std',
            maxSpeed: 20000, minD2: 0.180, stagesPerSection: null,
            intercooled: false, geared: false,
            note: 'Impellers in series on one shaft. One speed for the whole body, so the flow coefficient falls stage by stage as the gas densifies.'
        },
        igc: {
            id: 'igc', label: 'Integrally geared (multi-shaft)', impeller: 'open',
            maxSpeed: 60000, minD2: 0.100, stagesPerSection: 1,
            intercooled: true, geared: true,
            note: 'A bull gear driving two to four pinions, one or two overhung impellers each, intercooled after every stage. Each pinion picks its own speed, so every stage can sit near its best flow coefficient — the reason this arrangement beats a beam-type machine on power for air, nitrogen and CO₂ duty.'
        },
        overhung: {
            id: 'overhung', label: 'Single-stage overhung', impeller: 'std',
            maxSpeed: 20000, minD2: 0.180, stagesPerSection: 1,
            intercooled: false, geared: false,
            note: 'One impeller overhung on a shaft end. The cheapest arrangement where a single stage carries the whole duty.'
        }
    };

    function architecture(id) {
        return ARCHITECTURES[id] || ARCHITECTURES.beam;
    }

    /* Practical gear-train limits for an integrally geared machine. A single
       mesh between a low-speed bull gear (driver speed, often 1500-3600 rpm)
       and a high-speed pinion (up to tens of thousands of rpm) commonly runs
       15-20:1 in real machines; a ratio above that is the point a second,
       intermediate gear stage is usually needed. */
    var IGC_LIMITS = {
        maxPinions: 4,
        maxStagesPerPinion: 2,
        maxGearRatio: 20,
        meshLoss: 0.015          // per pinion mesh, screening figure
    };

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
     * Given a fixed diameter D2 and target psi, the resulting speed and phi.
     * The mirror of stageAtSpeed: psi still sets the tip speed, but here it is
     * the diameter that is known and the shaft speed that falls out.
     */
    function stageAtDiameter(HpStage, Q1, psi, D2) {
        var U2 = Math.sqrt(HpStage / psi);
        var N = 60 * U2 / (Math.PI * D2);
        var phi = Q1 / (Math.PI / 4 * D2 * D2 * U2);
        return { U2: U2, N: N, phi: phi };
    }

    /**
     * Both diameter and speed known - an actual supplier offering rather than a
     * sizing exercise. Nothing is solved: the tip speed follows from the
     * geometry, and psi and phi are then *results* to be checked rather than
     * targets to be met. This is the evaluation case in Sandberg's methodology.
     */
    function stageAtBoth(HpStage, Q1, D2, N) {
        var U2 = Math.PI * D2 * N / 60;
        var psi = HpStage / (U2 * U2);
        var phi = Q1 / (Math.PI / 4 * D2 * D2 * U2);
        return { U2: U2, psi: psi, phi: phi };
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

    /* ===================================================================== */
    /* 13b. Empirical fleet bands - screening advisories, not solver limits    */
    /* ===================================================================== */
    /* Sanity checks against real fleet experience, layered on top of a
       finished solution - unlike DEFAULTS above, nothing here feeds the
       solve; a result outside a band is flagged for review, never clamped
       or altered. `unit` names the engine unit category (see UNITS) so the
       UI can display each band in whatever system it's currently showing.
       Add a sibling entry here for each new dataset; nothing else in this
       file needs to change to support one. */
    var EMPIRICAL_BANDS = {
        headPerStage: {
            label: 'Average head per stage',
            unit: 'head',             // base J/kg
            lo: 19429,                //  6,500 ft.lbf/lbm
            hi: 41847,                // 14,000 ft.lbf/lbm
            appliesTo: 'closed',      // survey covers closed impellers only; open designs run above hi
            source: 'Survey of 60+ actual compressor sections, multiple equipment suppliers'
        },
        tipSpeed: {
            label: 'Impeller tip speed',
            unit: 'velocity',         // base m/s
            lo: 198.12,               // 650 ft/sec
            hi: 274.32,               // 900 ft/sec
            appliesTo: 'closed',      // same survey population as headPerStage
            source: 'Survey of 60+ actual compressor sections, multiple equipment suppliers'
        }
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
        var etaP = opts.etaPManual || predictEtaP(Q1total * 3600, null, opts.etaModel);
        var path = compressPath(mix, T1, P1, P2, etaP, model, opts.pathSteps || 40);

        // Allowable tip speed is the tighter of the mechanical stress limit
        // and the peripheral Mach limit at the section inlet.
        var u2Mach = lim.mu2Max * d1.sonic;
        var u2Allow = Math.min(imp.u2max, u2Mach);
        var basis = opts.basis === 'sandberg' ? 'sandberg' : 'app';
        // A section may carry its own head coefficient; otherwise the machine-wide
        // target applies. Only the app basis reads it at all - see below.
        var psi = Math.min(opts.psiManual || opts.psiTarget || lim.psiTarget, imp.psiMax);

        // On the sandberg basis psi is an *output* of the Fig 15 / Fig 16 chain,
        // so it cannot be used to seed the stage count. Sandberg's own case
        // studies size the minimum impeller count off the head-per-stage ceiling
        // instead - which is the closed-impeller fleet band already carried here
        // (14,000 ft.lbf/lbm). Open impellers run above that band by design, so
        // they keep the mechanical/Mach ceiling.
        var headPerStageMax = (basis === 'sandberg' && !imp.open)
            ? EMPIRICAL_BANDS.headPerStage.hi
            : psi * u2Allow * u2Allow;

        // Math.max(1, NaN) is NaN, so guard the ratio explicitly - a NaN stage
        // count would silently produce an empty stage list.
        var stageRatio = path.Hp / headPerStageMax;
        if (!isFinite(stageRatio) || stageRatio <= 0) {
            throw new Error('Could not work out a stage count for this duty — check the suction conditions, ' +
                            'the pressure ratio and the gas composition.');
        }
        // An architecture may pin the impeller count - an integrally geared
        // stage or an overhung machine is one impeller by construction.
        var arch = architecture(opts.architecture);
        var pinned = arch.stagesPerSection;

        var stagesManual = null;
        if (pinned) stagesManual = pinned;
        else if (opts.stagesMode === 'manual' && opts.stagesManual > 0) {
            stagesManual = Math.max(1, Math.round(opts.stagesManual));
        }

        var nStages = stagesManual || Math.max(1, Math.ceil(stageRatio));
        var result = null;

        for (var iter = 0; iter < 15; iter++) {
            result = marchStages(mix, model, T1, P1, P2, mdot, nStages, psi, etaP, lim, imp, opts);

            // Re-estimate efficiency from the first stage flow coefficient and
            // re-run the path if it moved appreciably.
            if (!opts.etaPManual) {
                var newEta = predictEtaP(Q1total * 3600, result.stages[0].phi, opts.etaModel);
                if (Math.abs(newEta - etaP) > 0.002) {
                    etaP = newEta;
                    path = compressPath(mix, T1, P1, P2, etaP, model, opts.pathSteps || 40);
                    continue;
                }
            }

            // A fixed stage count is the engineer's decision: the limits are
            // still reported per stage, but the count is not grown to satisfy
            // them. Growing it would silently discard what was asked for.
            if (stagesManual) break;

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
            psiUsed: result.psiUsed,
            psiTargetUsed: psi,
            etaSource: opts.etaPManual ? 'manual' : 'correlation',
            speedLimited: result.speedLimited,
            sizeLimited: result.sizeLimited,
            overSpeed: result.overSpeed,
            underSize: result.underSize,
            freeSpeed: result.freeSpeed,
            speedSource: result.speedSource,
            sizeSource: result.sizeSource,
            stagesSource: stagesManual ? (pinned ? 'architecture' : 'manual') : 'auto',
            fixMode: result.fixMode,
            basis: result.basis,
            D2: result.D2,
            D2list: result.D2list,
            trimmed: result.trimmed,
            nsSpec: result.nsSpec,
            dsSpec: result.dsSpec,
            maxSpeed: result.maxSpeed,
            minD2: result.minD2
        };
    }

    /**
     * Solve a section, and when an override is in play solve it a second time
     * with the overrides stripped so the UI can show what the automatic
     * selection would have picked. The reference solve is only paid for when
     * something is actually overridden.
     */
    function runSectionWithReference(opts) {
        var actual = runSection(opts);
        var fixed = resolveFixMode(opts) !== 'auto';
        var overridden = (opts.stagesMode === 'manual' && opts.stagesManual > 0) ||
                         fixed || opts.basis === 'sandberg' || opts.psiManual > 0;
        if (!overridden) {
            actual.auto = null;
            return actual;
        }
        // The reference is "what an unconstrained selection on this app's own
        // correlations would have given", so every pin and the basis itself are
        // stripped - otherwise the comparison is against a machine that was
        // already half-decided.
        var bare = Object.assign({}, opts);
        delete bare.stagesMode; delete bare.stagesManual;
        delete bare.speedMode; delete bare.speedManual;
        delete bare.fixMode; delete bare.D2Manual;
        delete bare.basis; delete bare.psiManual;
        try {
            var ref = runSection(bare);
            actual.auto = {
                nStages: ref.nStages,
                speed: ref.speed,
                D2: ref.stages[0].D2,
                etaPoly: ref.etaPoly,
                T2: ref.T2,
                gasPower: ref.gasPower,
                phiLo: Math.min.apply(null, ref.stages.map(function (s) { return s.phi; })),
                phiHi: Math.max.apply(null, ref.stages.map(function (s) { return s.phi; })),
                mu2Max: Math.max.apply(null, ref.stages.map(function (s) { return s.Mu2; }))
            };
        } catch (e) {
            // The automatic solve can fail on a duty the manual one handles;
            // that is not a reason to lose the answer the engineer asked for.
            actual.auto = null;
            actual.autoError = e.message;
        }
        return actual;
    }

    /**
     * Split the total head into nStages equal parts and evaluate each stage at
     * its own inlet conditions. All stages share one shaft speed, which is set
     * by the first stage; the diameter is held constant through the section
     * (normal for a single body), so the flow coefficient falls stage by stage
     * as the gas densifies.
     */
    /**
     * Which of the two geometry variables the user has pinned. `speedManual`
     * with no explicit mode is how every case saved before this existed says
     * "fixed speed", so it still means that.
     */
    function resolveFixMode(opts) {
        var m = opts.fixMode;
        if (m === 'speed' || m === 'diameter' || m === 'both' || m === 'auto') return m;
        return opts.speedManual > 0 ? 'speed' : 'auto';
    }

    /**
     * Impeller diameters as an array of length nStages, in metres. A scalar
     * describes a section of equal impellers; a short list is padded with its
     * own last entry, which is what happens when the stage count grows past
     * the diameters actually quoted.
     */
    function normaliseD2(v, nStages) {
        if (v == null) return null;
        var list = (Array.isArray(v) ? v : [v]).filter(function (x) {
            return isFinite(x) && x > 0;
        });
        if (!list.length) return null;
        list = list.slice(0, nStages);
        while (list.length < nStages) list.push(list[list.length - 1]);
        return list;
    }

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
        var phiTarget = clamp(opts.phiTarget || lim.phiTarget, lim.phiMin, lim.phiMax);
        var maxSpeed = opts.maxSpeed || (imp.open ? lim.maxSpeedOpen : lim.maxSpeedClosed);
        var minD2 = opts.minD2 || (imp.open ? lim.minD2Open : lim.minD2Closed);

        var fixMode = resolveFixMode(opts);
        var basis = opts.basis === 'sandberg' ? 'sandberg' : 'app';
        var src = opts.selectionSource || 'tabulated';

        // What the aerodynamics alone would pick, kept in every mode so the UI
        // can always say what an unconstrained selection would have given.
        var geo = stageGeometry(HpStage, Q1, psi, phiTarget);
        var freeSpeed = geo.N;

        var D2list = null, D2 = null, N = null;
        var psiUsed = psi;                  // an output on the sandberg basis
        var speedLimited = false, sizeLimited = false;
        var ns = null, ds = null;

        if (fixMode === 'both' || fixMode === 'diameter') {
            D2list = normaliseD2(opts.D2Manual, nStages);
            if (!D2list) {
                throw new Error('This section fixes the impeller diameter but none was given — ' +
                                'enter a diameter, or set the section back to automatic sizing.');
            }
            D2 = weightedAvgDiameter(D2list);          // Eqn 9
        }

        if (fixMode === 'both') {
            // Nothing to solve: the machine is fully described, so psi and phi
            // become results to be checked rather than targets to be met.
            N = opts.speedManual;
            psiUsed = stageAtBoth(HpStage, Q1, D2, N).psi;
        } else if (fixMode === 'diameter') {
            if (basis === 'sandberg') {
                ds = specificDiameter(HpStage, Q1, D2);
                ns = nsFromDs(ds, src);
                N = ns * Math.pow(HpStage, 0.75) / (OMEGA_PER_RPM * Math.sqrt(Q1));
                psiUsed = 4 / (ns * ds * ns * ds);      // Eqn 14
            } else {
                N = stageAtDiameter(HpStage, Q1, psi, D2).N;
            }
        } else if (fixMode === 'speed') {
            N = opts.speedManual;
            if (basis === 'sandberg') {
                ns = specificSpeed(HpStage, Q1, N);
                ds = dsFromNs(ns, src);
                D2 = ds * Math.sqrt(Q1) / Math.pow(HpStage, 0.25);
                psiUsed = 4 / (ns * ds * ns * ds);
            } else {
                D2 = stageAtSpeed(HpStage, Q1, psi, N).D2;
            }
        } else {
            if (basis === 'sandberg') {
                // Sandberg's flow coefficient method: phi is the assumption and
                // both diameter and speed fall out of the Fig 15 / Fig 16 chain.
                ds = dsFromPhi(phiTarget, src);
                ns = nsFromDs(ds, src);
                D2 = ds * Math.sqrt(Q1) / Math.pow(HpStage, 0.25);
                N = ns * Math.pow(HpStage, 0.75) / (OMEGA_PER_RPM * Math.sqrt(Q1));
                psiUsed = 4 / (ns * ds * ns * ds);
            } else {
                N = geo.N;
                D2 = geo.D2;
            }
            // Only the fully free case is squeezed by the caps. Every pinned
            // mode is honoured exactly and flagged below instead - clamping a
            // value the engineer typed in would hide the conflict.
            if (N > maxSpeed) {
                N = maxSpeed;
                D2 = stageAtSpeed(HpStage, Q1, psiUsed, N).D2;
                speedLimited = true;
            }
            if (D2 < minD2) {
                // Clamping the diameter pushes the speed back up, which can put
                // it above the cap again. Both constraints then genuinely apply,
                // so neither flag is cleared - the old code cleared speedLimited
                // here and hid the conflict.
                D2 = minD2;
                N = 60 * Math.sqrt(HpStage / psiUsed) / (Math.PI * D2);
                sizeLimited = true;
            }
        }

        // Every mode ends with one diameter per impeller; a derived diameter is
        // uniform across the section, as a single body normally is.
        if (!D2list) D2list = normaliseD2(D2, nStages);

        // Diagnostics are evaluated unconditionally, in every mode. A manual
        // speed used to bypass these entirely and could return an impossible
        // machine with nothing raised.
        var overSpeed = N > maxSpeed * 1.0001;
        var underSize = Math.min.apply(null, D2list) < minD2 * 0.9999;

        var stages = [];
        var T = T1, P = P1, h = st1.h;

        for (var i = 0; i < nStages; i++) {
            var sIn = state(mix, T, P, model);
            var dIn = derived(mix, T, P, model);
            var Qs = mdot / sIn.rho;                            // m3/s at stage inlet
            // Each impeller carries its own diameter: a supplier's section may
            // have trimmed impellers, and with the head split equally the
            // smaller ones then run at a higher psi. That spread is real and is
            // reported per stage rather than averaged away.
            var D2i = D2list[i];
            var U2 = Math.PI * D2i * N / 60;
            var stagePsi = HpStage / (U2 * U2);
            var phi = Qs / (Math.PI / 4 * D2i * D2i * U2);
            var Mu2 = U2 / dIn.sonic;
            var eye = inletRelativeMach(Qs, U2, D2i, dIn.sonic);

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
                U2: U2, D2: D2i, N: N,
                psi: stagePsi, phi: phi,
                nsSpec: specificSpeed(HpStage, Qs, N),
                dsSpec: specificDiameter(HpStage, Qs, D2i),
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
            overSpeed: overSpeed,
            underSize: underSize,
            freeSpeed: freeSpeed,
            maxSpeed: maxSpeed,
            minD2: minD2,
            D2: D2,                     // weighted average, Eqn 9
            D2list: D2list,
            trimmed: Math.max.apply(null, D2list) - Math.min.apply(null, D2list) > 1e-6,
            fixMode: fixMode,
            basis: basis,
            psiUsed: psiUsed,
            nsSpec: ns,
            dsSpec: ds,
            speedSource: (fixMode === 'speed' || fixMode === 'both') ? 'manual'
                       : fixMode === 'diameter' ? 'derived'
                       : (speedLimited || sizeLimited ? 'limited' : 'auto'),
            sizeSource: (fixMode === 'diameter' || fixMode === 'both') ? 'manual'
                      : fixMode === 'speed' ? 'derived'
                      : (sizeLimited ? 'limited' : 'auto')
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
        // A per-section manual speed always wins over the shared one.
        var sharedSpeed = opts.speedManual || null;

        for (var i = 0; i < opts.sections.length; i++) {
            var sec = opts.sections[i];
            var secFix = resolveFixMode(sec);
            var secSpeed = (secFix === 'speed' || secFix === 'both') && sec.speedManual > 0
                ? sec.speedManual
                : sharedSpeed;
            // Inheriting a common-shaft speed makes a section speed-fixed too,
            // unless it already pins its own diameter as well.
            var fixMode = secFix;
            if (fixMode === 'auto' && secSpeed) fixMode = 'speed';
            else if (fixMode === 'diameter' && secSpeed) fixMode = 'both';
            var res = runSectionWithReference({
                mix: mix, model: model,
                T1: T, P1: P, P2: sec.P2,
                mdot: mdot,
                limits: lim, impeller: imp,
                architecture: opts.architecture,
                psiTarget: opts.psiTarget,
                psiManual: sec.psiManual,
                phiTarget: opts.phiTarget,
                etaPManual: opts.etaPManual,
                etaModel: opts.etaModel,
                etaMech: opts.etaMech,
                fixMode: fixMode,
                basis: sec.basis || opts.basis,
                selectionSource: opts.selectionSource,
                D2Manual: sec.D2Manual,
                speedMode: secSpeed ? 'manual' : 'auto',
                speedManual: secSpeed,
                stagesMode: sec.stagesMode,
                stagesManual: sec.stagesManual,
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

        var arch = architecture(opts.architecture);

        // An integrally geared machine has a gear train: group the stages onto
        // pinions, give each pinion one speed, and resize its impellers to it.
        var pinions = null;
        if (arch.geared) {
            pinions = assignPinions(out, opts, lim, imp);
            // Regrouping changes each stage's speed and diameter, so the power
            // roll-up has to be taken again from the resized sections.
            totalGasPower = 0; totalShaftPower = 0;
            for (var k = 0; k < out.length; k++) {
                totalGasPower += out[k].gasPower;
                totalShaftPower += out[k].shaftPower;
            }
        }

        // Speed is a range once sections differ - reporting section 1's speed
        // for the whole train was wrong for a two-body train and meaningless
        // for an integrally geared one, where every pinion differs by design.
        var speeds = out.map(function (s) { return s.speed; });
        var speedRange = { lo: Math.min.apply(null, speeds), hi: Math.max.apply(null, speeds), list: speeds };

        var frame = selectFrame({
            mix: mix,
            architecture: arch,
            Q1: out[0].Q1,
            Psuc: out[0].inlet.P,
            Pdis: out[out.length - 1].P2,
            totalStages: totalStages,
            speedRange: speedRange,
            nSections: opts.sections.length,
            impeller: imp,
            pinions: pinions,
            shaftPower: totalShaftPower
        });

        // The beam-rotor screening model - bearing span from stage count, a
        // flexibility ratio - describes a shaft between two bearings. An
        // integrally geared pinion is short, stiff and overhung, so that model
        // says nothing useful about it and is not run.
        var rotor = arch.geared ? null : rotordynamicScreen({
            totalStages: totalStages,
            speed: speedRange.hi,
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
            pinions: pinions,
            architecture: arch,
            speedRange: speedRange,
            inletDew: inletDew,
            model: model,
            modelName: MODELS[model]
        };
    }

    /* ===================================================================== */
    /* 14b. Integrally geared machines - pinions and the gear train           */
    /* ===================================================================== */
    /**
     * Group the sections (one impeller each on an integrally geared machine)
     * onto pinions, settle a common speed for each pinion, and resize the
     * impellers it carries to that speed.
     *
     * Two impellers on one pinion must turn at the same speed, so at most one
     * of them can sit at its own aerodynamic optimum. That is the real cost of
     * pairing, and it shows up here as a flow coefficient pushed off target -
     * which is exactly what the results table should reveal rather than hide.
     *
     * layout: 'auto' (pairs, the usual arrangement) | 'single' (one impeller
     * per pinion) | 'custom' (explicit groups of 1-based section indices).
     */
    function assignPinions(sections, opts, lim, imp) {
        var layout = opts.pinionLayout || 'auto';
        var bullSpeed = opts.bullGearSpeed || 1800;      // rpm at the driver
        var n = sections.length;
        var groups;

        if (layout === 'custom' && Array.isArray(opts.pinionGroups) && opts.pinionGroups.length) {
            groups = normalisePinionGroups(opts.pinionGroups, n);
        } else if (layout === 'single') {
            groups = sections.map(function (s, i) { return [i]; });
        } else {
            groups = autoPairPinions(sections);
        }

        var maxSpeed = opts.maxSpeed || lim.maxSpeedOpen;
        var minD2 = opts.minD2 || lim.minD2Open;
        var out = [];

        groups.forEach(function (idxs, gi) {
            // Common speed: the geometric mean of the members' free optimum
            // speeds, which splits the compromise evenly in log space rather
            // than favouring the faster stage.
            var prod = 1;
            idxs.forEach(function (i) { prod *= Math.max(sections[i].freeSpeed || sections[i].speed, 1); });
            var N = Math.pow(prod, 1 / idxs.length);

            if (N > maxSpeed) N = maxSpeed;

            // Respect the minimum impeller diameter across every member.
            idxs.forEach(function (i) {
                var st = sections[i].stages[0];
                var d = stageAtSpeed(st.Hp, st.Q1, st.psi, N).D2;
                if (d < minD2) N = Math.min(N, 60 * Math.sqrt(st.Hp / st.psi) / (Math.PI * minD2));
            });

            var members = idxs.map(function (i) {
                return resizeSectionToSpeed(sections[i], N, opts, lim, imp);
            });

            var ratio = N / bullSpeed;
            out.push({
                id: String.fromCharCode(65 + gi),           // A, B, C, ...
                stages: idxs.map(function (i) { return i + 1; }),
                speed: N,
                ratio: ratio,
                bullGearSpeed: bullSpeed,
                U2max: Math.max.apply(null, members.map(function (m) { return m.U2; })),
                phiLo: Math.min.apply(null, members.map(function (m) { return m.phi; })),
                phiHi: Math.max.apply(null, members.map(function (m) { return m.phi; })),
                mu2Max: Math.max.apply(null, members.map(function (m) { return m.Mu2; })),
                power: idxs.reduce(function (a, i) { return a + sections[i].gasPower; }, 0),
                ratioHigh: ratio > IGC_LIMITS.maxGearRatio,
                overSpeed: N > maxSpeed * 1.0001,
                members: members
            });
        });

        return out;
    }

    /**
     * Pair consecutive stages onto pinions. With an odd stage count one pinion
     * carries a single impeller; it goes to the stage whose free optimum speed
     * is furthest from its neighbour's, since that is the pairing that would
     * have cost the most aerodynamically.
     */
    function autoPairPinions(sections) {
        var n = sections.length;
        if (n <= 1) return [[0]];

        var speeds = sections.map(function (s) { return s.freeSpeed || s.speed; });
        var solo = -1;
        if (n % 2 === 1) {
            var worst = -Infinity;
            for (var i = 0; i < n; i++) {
                var d = Infinity;
                if (i > 0) d = Math.min(d, Math.abs(Math.log(speeds[i] / speeds[i - 1])));
                if (i < n - 1) d = Math.min(d, Math.abs(Math.log(speeds[i] / speeds[i + 1])));
                if (d > worst) { worst = d; solo = i; }
            }
        }

        var groups = [], j = 0;
        while (j < n) {
            if (j === solo) { groups.push([j]); j += 1; }
            else if (j + 1 < n && j + 1 !== solo) { groups.push([j, j + 1]); j += 2; }
            else { groups.push([j]); j += 1; }
        }
        return groups;
    }

    /** Validate and clean explicit pinion groups: consecutive, complete, <= 2 each. */
    function normalisePinionGroups(groups, n) {
        var seen = {}, out = [];
        groups.forEach(function (g) {
            var idxs = (g || []).map(function (v) { return Number(v) - 1; })
                                .filter(function (v) { return v >= 0 && v < n && !seen[v]; });
            idxs.sort(function (a, b) { return a - b; });
            idxs = idxs.slice(0, IGC_LIMITS.maxStagesPerPinion);
            idxs.forEach(function (v) { seen[v] = true; });
            if (idxs.length) out.push(idxs);
        });
        // Anything the caller left out gets its own pinion, so no stage is lost.
        for (var i = 0; i < n; i++) if (!seen[i]) out.push([i]);
        out.sort(function (a, b) { return a[0] - b[0]; });
        return out;
    }

    /**
     * Re-evaluate a one-impeller section at an imposed speed. The head and the
     * inlet state are unchanged, so only the geometry and the Mach numbers move.
     */
    function resizeSectionToSpeed(sec, N, opts, lim, imp) {
        var st = sec.stages[0];
        var g = stageAtSpeed(st.Hp, st.Q1, st.psi, N);
        var eye = inletRelativeMach(st.Q1, g.U2, g.D2, st.sonic);

        st.N = N;
        st.U2 = g.U2;
        st.D2 = g.D2;
        st.phi = g.phi;
        st.nsSpec = specificSpeed(st.Hp, st.Q1, N);
        st.dsSpec = specificDiameter(st.Hp, st.Q1, g.D2);
        st.Mu2 = g.U2 / st.sonic;
        st.Mrel = eye.Mrel;
        st.eyeRatio = eye.eyeRatio;
        st.D1 = eye.D1;
        st.blading = g.phi < 0.05 ? '2D' : '3D';
        st.ok = st.Mu2 <= lim.mu2Max && st.Mrel <= lim.mrelMax &&
                g.phi >= lim.phiMin && g.phi <= lim.phiMax && g.U2 <= imp.u2max;

        sec.speed = N;
        sec.D2 = g.D2;
        // One impeller per pinion, so the section's diameter list is that one
        // value - keep it in step or downstream readers see a stale geometry.
        sec.D2list = [g.D2];
        sec.trimmed = false;
        return st;
    }

    /* ===================================================================== */
    /* 14c. Stage-count trade-off sweep                                       */
    /* ===================================================================== */
    /**
     * Re-solve one section at a range of impeller counts so the consequence of
     * adding or removing a stage is visible before committing to it. No new
     * physics - it just calls the same march at each forced count.
     */
    function stageSweep(opts, lo, hi) {
        var rows = [];
        for (var n = Math.max(1, lo); n <= hi; n++) {
            try {
                var res = runSection(Object.assign({}, opts, {
                    stagesMode: 'manual', stagesManual: n
                }));
                var phis = res.stages.map(function (s) { return s.phi; });
                var mu2s = res.stages.map(function (s) { return s.Mu2; });
                var mrels = res.stages.map(function (s) { return s.Mrel; });
                var limits = [];
                if (res.overSpeed) limits.push('over max speed');
                if (res.underSize) limits.push('under min diameter');
                if (Math.max.apply(null, mu2s) > (opts.limits || DEFAULTS).mu2Max) limits.push('Mu₂');
                if (Math.max.apply(null, mrels) > (opts.limits || DEFAULTS).mrelMax) limits.push('M rel');
                if (Math.min.apply(null, phis) < (opts.limits || DEFAULTS).phiMin) limits.push('φ low');
                if (Math.max.apply(null, phis) > (opts.limits || DEFAULTS).phiMax) limits.push('φ high');
                if (res.t2Exceeded) limits.push('T₂');
                rows.push({
                    nStages: n,
                    speed: res.speed,
                    D2: res.stages[0].D2,
                    phiLo: Math.min.apply(null, phis),
                    phiHi: Math.max.apply(null, phis),
                    mu2Max: Math.max.apply(null, mu2s),
                    mrelMax: Math.max.apply(null, mrels),
                    etaPoly: res.etaPoly,
                    T2: res.T2,
                    gasPower: res.gasPower,
                    HpTotal: res.HpTotal,
                    limits: limits,
                    ok: limits.length === 0
                });
            } catch (e) {
                rows.push({ nStages: n, error: e.message, ok: false, limits: ['no solution'] });
            }
        }
        return rows;
    }

    /* ===================================================================== */
    /* 14d. Sandberg preliminary selection methodology                        */
    /* ===================================================================== */
    /*
     * Sandberg (2022), "Centrifugal Compressor Configuration, Selection and
     * Arrangement: A User's Perspective", Turbomachinery Laboratory, Texas
     * A&M. Three procedures that size a machine from process data alone, so a
     * purchaser can build a selection independently of the supplier or check
     * one that has been proposed. The paper validates them against six real
     * supplier selections and lands within 2-14% on diameter, 3-20% on speed.
     *
     * The paper carries unit-conversion constants C5-C11 for its mixed units
     * (m3/hr, mm, rpm). In consistent SI base they all collapse, so none of
     * them appear here:
     *
     *   phi = Q / (pi/4 * D^2 * U2)      Eqn 6   - already stageGeometry's phi
     *   mu_p = Hp_stage / U2^2           Eqn 7   - already the engine's psi
     *   ns  = omega * sqrt(Q) / Hp_stage^0.75    Eqn 12, omega = 2*pi*N/60
     *   ds  = D * Hp_stage^0.25 / sqrt(Q)        Eqn 13
     *   mu_p = 4 / (ns*ds)^2             Eqn 14
     *   tau = mu_p / eta_p               Eqn 10  - work input coefficient
     *
     * So the app's existing flow and head coefficients ARE the paper's phi and
     * mu_p; only ns, ds and tau are new. Everything below is SI base:
     * Hp in J/kg, Q in m3/s, D in m, N in rpm.
     *
     * Naming: `ns` here is specific speed. Do not confuse it with
     * schultz.ns, which is the polytropic exponent.
     */

    var OMEGA_PER_RPM = 2 * Math.PI / 60;

    /** Eqn 12. Dimensionless specific speed. */
    function specificSpeed(HpStage, Q, N) {
        return OMEGA_PER_RPM * N * Math.sqrt(Q) / Math.pow(HpStage, 0.75);
    }

    /** Eqn 13. Dimensionless specific diameter. */
    function specificDiameter(HpStage, Q, D) {
        return D * Math.pow(HpStage, 0.25) / Math.sqrt(Q);
    }

    /** Eqn 6, written in terms of D and N rather than D and U2. */
    function flowCoefficient(Q, D, N) {
        return 240 * Q / (Math.PI * Math.PI * D * D * D * N);
    }

    /**
     * Eqn 9. Weighted average impeller diameter for a section whose stages are
     * not all the same size - the paper's Davg, the diameter that reproduces
     * the section head coefficient of Eqn 8 when applied to every stage.
     */
    function weightedAvgDiameter(diameters) {
        if (!diameters || !diameters.length) return NaN;
        var s = 0;
        for (var i = 0; i < diameters.length; i++) s += diameters[i] * diameters[i];
        return Math.sqrt(s / diameters.length);
    }

    /*
     * The paper's tabulated basis.
     *
     * Figures 15, 16 and 17 are published as charts, but the six case-study
     * tables in the appendix print the same (phi, ns, ds, eta) quartet - and
     * print it identically in every case, which is what shows it to be a
     * correlation rather than per-case output. That gives an exact 13-point
     * trace of the curve the paper's own worked examples ran on, to 4 decimal
     * places and with no chart reading involved. It is the default basis here
     * and the reference the self-tests check against.
     *
     * mu_p and tau are deliberately NOT stored: deriving them (Eqns 14 and 10)
     * keeps one source of truth and makes those identities hold exactly.
     *
     * Range is phi 0.005-0.19, wider than DEFAULTS.phiMin/phiMax, because the
     * paper's own case studies need it - Cases 3 and 5 go below the optimum
     * band to reach a supplier's minimum frame size, Case 4 goes above it to
     * reach a 3600 rpm motor. Selections outside 0.05-0.11 are flagged, never
     * clamped.
     */
    var SELECTION_TABLE = {
        phi: [0.0050, 0.0100, 0.0200, 0.0300, 0.0400, 0.0600, 0.0800,
              0.1000, 0.1200, 0.1300, 0.1500, 0.1700, 0.1900],
        ns:  [0.2206, 0.2992, 0.4115, 0.4960, 0.5686, 0.6895, 0.7968,
              0.8991, 1.0179, 1.0714, 1.1544, 1.2512, 1.4297],
        ds:  [13.2605, 9.4765, 6.7622, 5.5557, 4.8215, 3.9486, 3.4186,
              3.0487, 2.7615, 2.6410, 2.4379, 2.2664, 2.0991],
        // Aungier vaned/vaneless average, Figure 17. The paper factors this by
        // 0.95 as its second variant to bracket the supplier scatter.
        eta: [0.4757, 0.6290, 0.7321, 0.7749, 0.8025, 0.8351, 0.8473,
              0.8537, 0.8524, 0.8487, 0.8375, 0.8232, 0.8071]
    };

    var PHI_BEST_LO = 0.05, PHI_BEST_HI = 0.11;   // paper's optimum band

    /*
     * Figures 15 and 16, digitised per source curve.
     *
     * Honesty about what these are: over roughly phi 0.02-0.14 (ns 0.35-1.5)
     * all four published curves collapse into a single band, which is the
     * paper's own point - correlations derived from Ns-Ds data (Cordier,
     * Casey) and from phi-mu_p relations (Aungier) agree closely. In that
     * band the spread between them is finer than a figure can be read to, so
     * these arrays are anchored on SELECTION_TABLE there and should be treated
     * as one curve with four labels, good to roughly +/-0.1 in ds.
     *
     * Where they genuinely separate, and where reading them is therefore worth
     * something, is at the ends: the high-phi tail of Figure 15 (at phi = 0.20
     * Cordier falls to about 1.5 while Aungier vaned holds near 2.0) and the
     * low-ns head of Figure 16, where each curve also stops at a different
     * place. Those differing extents are carried per source rather than padded
     * to a common grid, so a lookup outside a curve's published range is
     * reported instead of silently extrapolated.
     *
     * Use these for drawing and for exploring source sensitivity. For numbers,
     * 'tabulated' is exact and is the default.
     */
    var FIG15 = {          // ds against phi
        tabulated:       { x: SELECTION_TABLE.phi, y: SELECTION_TABLE.ds },
        cordier:         { x: [0.002, 0.005, 0.010, 0.020, 0.030, 0.040, 0.060, 0.080, 0.100, 0.120, 0.140, 0.160, 0.180, 0.200],
                           y: [17.80, 13.10,  9.40,  6.72,  5.52,  4.79,  3.92,  3.39,  3.01,  2.71,  2.45,  2.22,  1.90,  1.52] },
        casey:           { x: [0.002, 0.005, 0.010, 0.020, 0.030, 0.040, 0.060, 0.080, 0.100, 0.120, 0.140, 0.160, 0.180, 0.200],
                           y: [22.00, 13.90,  9.70,  6.85,  5.60,  4.85,  3.97,  3.43,  3.06,  2.76,  2.52,  2.32,  2.02,  1.74] },
        aungierVaned:    { x: [0.002, 0.005, 0.010, 0.020, 0.030, 0.040, 0.060, 0.080, 0.100, 0.120, 0.140, 0.160, 0.180, 0.200],
                           y: [17.20, 13.20,  9.50,  6.80,  5.58,  4.84,  3.97,  3.44,  3.08,  2.80,  2.58,  2.40,  2.18,  2.00] },
        aungierVaneless: { x: [0.002, 0.005, 0.010, 0.020, 0.030, 0.040, 0.060, 0.080, 0.100, 0.120, 0.140, 0.160, 0.180, 0.200],
                           y: [16.50, 12.80,  9.30,  6.70,  5.50,  4.78,  3.92,  3.40,  3.04,  2.76,  2.54,  2.36,  2.14,  1.96] }
    };

    var FIG16 = {          // ds against ns - the Cordier characteristic
        tabulated:       { x: SELECTION_TABLE.ns, y: SELECTION_TABLE.ds },
        // Casey spans the whole plotted range; Cordier starts near ns 0.19;
        // both Aungier curves stop short of ns 1.6.
        casey:           { x: [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00, 1.10, 1.30, 1.50, 1.70, 1.90, 2.10],
                           y: [24.50, 16.80, 12.90, 10.60, 9.55, 6.95, 5.55, 4.62, 3.95, 3.45, 3.08, 2.82, 2.63, 2.31, 2.14, 2.04, 1.97, 1.93] },
        cordier:         { x: [0.19, 0.25, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00, 1.10, 1.30, 1.50, 1.70, 1.90, 2.10],
                           y: [17.80, 10.90, 9.40, 6.85, 5.48, 4.56, 3.90, 3.41, 3.04, 2.79, 2.60, 2.28, 2.11, 2.01, 1.95, 1.92] },
        aungierVaned:    { x: [0.25, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00, 1.10, 1.30, 1.50, 1.55],
                           y: [16.50, 9.60, 6.90, 5.52, 4.60, 3.93, 3.43, 3.06, 2.81, 2.63, 2.33, 2.15, 2.10] },
        aungierVaneless: { x: [0.27, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00, 1.10, 1.30, 1.50],
                           y: [14.50, 9.45, 6.80, 5.45, 4.54, 3.88, 3.39, 3.02, 2.77, 2.59, 2.30, 2.20] }
    };

    var SELECTION_SOURCES = ['tabulated', 'cordier', 'casey', 'aungierVaned', 'aungierVaneless'];

    function figCurve(fig, source) {
        return fig[source] || fig.tabulated;
    }

    /**
     * Log-log interpolation. Both figures are power-law-ish over their range,
     * so straight-line interpolation in log space tracks them much better than
     * in linear space: checked against the paper's own fixed-diameter column,
     * linear gives ns 0.9410 where the paper prints 0.9373, log-log gives
     * 0.9380. Held flat outside the data rather than extrapolated, matching
     * aungierEtaP - the shape past either end isn't something the source
     * supports claiming.
     */
    function interpLogLog(xs, ys, x) {
        if (!isFinite(x) || x <= 0) return NaN;
        if (x <= xs[0]) return ys[0];
        var n = xs.length;
        if (x >= xs[n - 1]) return ys[n - 1];
        for (var i = 1; i < n; i++) {
            if (x <= xs[i]) {
                var t = (Math.log(x) - Math.log(xs[i - 1])) / (Math.log(xs[i]) - Math.log(xs[i - 1]));
                return Math.exp(Math.log(ys[i - 1]) + t * (Math.log(ys[i]) - Math.log(ys[i - 1])));
            }
        }
        return ys[n - 1];
    }

    /** As above, but solving for x given y on a monotonically decreasing y. */
    function interpLogLogInverse(xs, ys, y) {
        if (!isFinite(y) || y <= 0) return NaN;
        var n = ys.length;
        if (y >= ys[0]) return xs[0];
        if (y <= ys[n - 1]) return xs[n - 1];
        for (var i = 1; i < n; i++) {
            if (y >= ys[i]) {
                var t = (Math.log(y) - Math.log(ys[i - 1])) / (Math.log(ys[i]) - Math.log(ys[i - 1]));
                return Math.exp(Math.log(xs[i - 1]) + t * (Math.log(xs[i]) - Math.log(xs[i - 1])));
            }
        }
        return xs[n - 1];
    }

    /** Figure 15 forward: flow coefficient to specific diameter. */
    function dsFromPhi(phi, source) {
        var c = figCurve(FIG15, source);
        return interpLogLog(c.x, c.y, phi);
    }

    /** Figure 16 forward: specific diameter to specific speed. */
    function nsFromDs(ds, source) {
        var c = figCurve(FIG16, source);
        return interpLogLogInverse(c.x, c.y, ds);
    }

    /** Figure 16 inverse: specific speed to specific diameter. */
    function dsFromNs(ns, source) {
        var c = figCurve(FIG16, source);
        return interpLogLog(c.x, c.y, ns);
    }

    /** Figure 17: the Aungier vaned/vaneless average used by the paper. */
    function etaFromPhi(phi) {
        return interpLogLog(SELECTION_TABLE.phi, SELECTION_TABLE.eta, phi);
    }

    /** True when x sits outside the published extent of a source's curve. */
    function outsideCurve(fig, source, x) {
        var c = figCurve(fig, source);
        return x < c.x[0] || x > c.x[c.x.length - 1];
    }

    /** True when y (a ds value) sits outside the published extent of the curve's range. */
    function outsideCurveRange(fig, source, y) {
        var c = figCurve(fig, source);
        var yMax = c.y[0], yMin = c.y[c.y.length - 1];   // ds falls monotonically
        return y < yMin || y > yMax;
    }

    /**
     * One preliminary selection, by any of the paper's three methods.
     *
     *   method  'phi'      - assume a flow coefficient (paper p.28)
     *           'diameter' - fix the average impeller diameter (p.29)
     *           'speed'    - fix the rotational speed (p.30)
     *
     *   opts    { HpTotal, Q1, nStages, value, etaFactor, source }
     *           HpTotal J/kg for the section, Q1 m3/s at section inlet,
     *           value is phi / D in m / N in rpm to match the method,
     *           etaFactor is the paper's 1.00 or 0.95 Aungier variant.
     *
     * Each method walks the paper's numbered steps in order; the difference
     * between them is only which of phi, D and N is the independent one.
     */
    function selectSection(method, opts) {
        var nStages = Math.max(1, Math.round(opts.nStages || 1));
        var HpStage = opts.HpTotal / nStages;
        var Q = opts.Q1;
        var source = opts.source || 'tabulated';
        var etaFactor = isFinite(opts.etaFactor) && opts.etaFactor > 0 ? opts.etaFactor : 1;
        var v = opts.value;
        var phi, ns, ds, D, N, offCurve = false;

        if (!isFinite(HpStage) || HpStage <= 0 || !isFinite(Q) || Q <= 0 || !isFinite(v) || v <= 0) {
            return { method: method, value: v, viable: false, error: 'Head, inlet flow and the method value must all be positive.' };
        }

        if (method === 'diameter') {
            // D -> ds [Eqn 13] -> ns [Fig 16] -> N [Eqn 12] -> phi [Eqn 6]
            D = v;
            ds = specificDiameter(HpStage, Q, D);
            offCurve = outsideCurveRange(FIG16, source, ds);
            ns = nsFromDs(ds, source);
            N = ns * Math.pow(HpStage, 0.75) / (OMEGA_PER_RPM * Math.sqrt(Q));
            phi = flowCoefficient(Q, D, N);
        } else if (method === 'speed') {
            // N -> ns [Eqn 12] -> ds [Fig 16 inverse] -> D [Eqn 13] -> phi [Eqn 6]
            N = v;
            ns = specificSpeed(HpStage, Q, N);
            offCurve = outsideCurve(FIG16, source, ns);
            ds = dsFromNs(ns, source);
            D = ds * Math.sqrt(Q) / Math.pow(HpStage, 0.25);
            phi = flowCoefficient(Q, D, N);
        } else {
            // phi -> ds [Fig 15] -> ns [Fig 16] -> D [Eqn 13], N [Eqn 12]
            method = 'phi';
            phi = v;
            offCurve = outsideCurve(FIG15, source, phi);
            ds = dsFromPhi(phi, source);
            ns = nsFromDs(ds, source);
            D = ds * Math.sqrt(Q) / Math.pow(HpStage, 0.25);
            N = ns * Math.pow(HpStage, 0.75) / (OMEGA_PER_RPM * Math.sqrt(Q));
        }

        var nsds = ns * ds;
        var mu_p = 4 / (nsds * nsds);                  // Eqn 14
        var etaP = etaFromPhi(phi) * etaFactor;        // Figure 17
        var tau = mu_p / etaP;                         // Eqn 10
        var U = Math.PI * D * N / 60;

        return {
            method: method,
            value: v,
            nStages: nStages,
            HpTotal: opts.HpTotal,
            HpStage: HpStage,
            Q1: Q,
            source: source,
            etaFactor: etaFactor,
            phi: phi,
            nsSpec: ns,
            dsSpec: ds,
            nsds: nsds,
            mu_p: mu_p,
            etaP: etaP,
            tau: tau,
            D: D,
            N: N,
            Utip: U,
            // phi recovered from ns and ds alone (8/(pi*ns*ds^3) is an exact
            // identity of the defining formulas, independent of any curve).
            // For the 'diameter' and 'speed' methods this always equals phi
            // above, since D (or N) is carried through unchanged rather than
            // re-derived from a curve. For the 'phi' method it is a
            // diagnostic: phi -> ds and ds -> ns are two separate
            // interpolations (Fig 15, then Fig 16), so a gap from the input
            // phi shows how much those two curves disagree with each other
            // at this point - zero at a shared table node, small between
            // nodes on 'tabulated', and largest when mixing independently
            // digitised source curves.
            phiClosure: 8 / (Math.PI * ns * ds * ds * ds),
            // The paper flags tau > 1 in Cases 3 and 5: it would demand a
            // greater enthalpy rise than the stage has available, so the
            // selection is arithmetically fine but physically not a machine.
            viable: tau <= 1,
            tauExceeded: tau > 1,
            outsideOptimum: phi < PHI_BEST_LO || phi > PHI_BEST_HI,
            outsideCurve: offCurve
        };
    }

    /** The paper's tables: one selection per swept value of the independent variable. */
    function selectionSweep(method, opts, values) {
        return (values || []).map(function (v) {
            return selectSection(method, Object.assign({}, opts, { value: v }));
        });
    }

    /**
     * Step 7/8 of every procedure: "iterate on these steps with resulting
     * efficiencies until efficiency value convergence".
     *
     * Polytropic head depends on efficiency through the discharge state, so
     * the caller supplies hpFn(eta) -> { HpTotal, Q1 } to re-integrate the
     * path at a trial efficiency. Same tolerance and cap as the section solve
     * in runSection so the two agree on what "converged" means.
     */
    function selectSectionIterated(method, opts, hpFn) {
        var eta = isFinite(opts.etaStart) && opts.etaStart > 0 ? opts.etaStart : 0.80;
        var res = null, iterations = 0;
        for (var i = 0; i < 10; i++) {
            iterations = i + 1;
            var duty = hpFn ? hpFn(eta) : { HpTotal: opts.HpTotal, Q1: opts.Q1 };
            res = selectSection(method, Object.assign({}, opts, {
                HpTotal: duty.HpTotal, Q1: duty.Q1
            }));
            if (!isFinite(res.etaP)) break;
            if (Math.abs(res.etaP - eta) < 0.002) { eta = res.etaP; break; }
            eta = res.etaP;
            if (!hpFn) break;             // nothing to re-integrate; one pass is the answer
        }
        if (res) res.iterations = iterations;
        return res;
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

        // The architecture is now the engineer's choice rather than something
        // inferred from the impeller type and section count. What is still
        // derived is the casing that architecture needs, and whether the duty
        // actually suits the architecture that was picked.
        var arch = o.architecture || ARCHITECTURES.beam;
        var speedHi = o.speedRange ? o.speedRange.hi : 0;
        var speedLo = o.speedRange ? o.speedRange.lo : 0;
        var suitability = [];

        if (arch.id === 'igc') {
            type = 'Integrally geared (multi-shaft)';
            casing = (o.pinions ? o.pinions.length : 1) +
                     ' pinion casing(s) on a common bull gear';
            reasons.push('Overhung impellers on gear-driven pinions with an intercooler after every stage.');
            reasons.push('Each pinion runs at its own speed, so a stage can sit near its best flow coefficient instead of inheriting one shaft speed.');
            if (o.pinions) {
                var ratios = o.pinions.map(function (p) { return p.ratio; });
                reasons.push('Gear ratios ' + Math.min.apply(null, ratios).toFixed(2) + '–' +
                             Math.max.apply(null, ratios).toFixed(2) + ':1 off a ' +
                             Math.round(o.pinions[0].bullGearSpeed).toLocaleString() + ' rpm bull gear.');
            }
            // Where an integrally geared machine is the wrong answer.
            if (pH2_bar >= 14) {
                suitability.push('Hydrogen partial pressure at discharge is ' + pH2_bar.toFixed(1) +
                    ' bar. API 617 wants a vertically split barrel above ~14 bar (200 psi), which an integrally geared machine cannot give — a beam-type barrel is the safer choice.');
            }
            if (Pdis_bar >= 60) {
                suitability.push('Discharge pressure ' + Pdis_bar.toFixed(1) +
                    ' bara is high for an integrally geared machine; the overhung casings and shaft-end seals become the limit. A beam-type barrel is the usual answer above ~60 bara.');
            }
            if (MW < 12) {
                suitability.push('Light gas (MW ' + MW.toFixed(1) +
                    ') means very high head per stage and a lot of shaft-end seal leakage area — check sealing carefully, or consider a beam-type machine.');
            }
            if (o.pinions && o.pinions.length > IGC_LIMITS.maxPinions) {
                suitability.push(o.pinions.length + ' pinions is beyond the ~' + IGC_LIMITS.maxPinions +
                    ' a single bull gear normally carries — split the duty across two machines.');
            }
        } else if (arch.id === 'overhung') {
            type = 'Single-stage overhung';
            casing = 'Overhung, radially split';
            reasons.push('One impeller overhung on a shaft end — the cheapest arrangement when a single stage carries the duty.');
            if (o.totalStages > 1) {
                suitability.push('This duty needs ' + o.totalStages +
                    ' impellers, which an overhung machine cannot carry. Switch to a beam-type or integrally geared architecture.');
            }
            if (Pdis_bar >= 20) {
                suitability.push('Discharge pressure ' + Pdis_bar.toFixed(1) +
                    ' bara is high for an overhung machine — the overhung moment and the single dry-gas seal become the limit.');
            }
        } else {
            type = 'Beam-type (between-bearings) multistage';
            if (pH2_bar >= 14) {
                casing = 'Vertically split barrel';
                reasons.push('Hydrogen partial pressure at discharge is ' + pH2_bar.toFixed(1) +
                             ' bar, at or above the ~14 bar (200 psi) API 617 threshold for a barrel casing.');
            } else if (Pdis_bar >= 60) {
                casing = 'Vertically split barrel';
                reasons.push('Discharge pressure ' + Pdis_bar.toFixed(1) + ' bara is above the ~60 bara point where barrel casings take over.');
            } else if (Pdis_bar >= 40 && MW < 12) {
                casing = 'Vertically split barrel';
                reasons.push('Light gas (MW ' + MW.toFixed(1) + ') at ' + Pdis_bar.toFixed(1) +
                             ' bara - sealing a horizontally split joint gets difficult.');
            } else {
                casing = 'Horizontally split';
                reasons.push('Discharge pressure ' + Pdis_bar.toFixed(1) + ' bara and MW ' + MW.toFixed(1) +
                             ' are comfortably inside the horizontally split range.');
            }
            if (o.nSections > 1) {
                reasons.push(o.nSections + ' sections with intercooling — normally separate bodies, or one body with an external cooling loop.');
            }
        }

        if (o.Q1 * 3600 > 200000 && o.totalStages <= 2) {
            reasons.push('Inlet volume flow above 200,000 m³/h with very little head - an axial machine may suit this duty better than a centrifugal.');
        }
        if (arch.id === 'beam' && o.totalStages > DEFAULTS.maxStagesPerBody) {
            reasons.push('At ' + o.totalStages + ' stages the machine exceeds the ~' + DEFAULTS.maxStagesPerBody +
                         ' impellers normally put in one body - expect a tandem or two-body train.');
        }

        var speedTxt = (speedLo === speedHi)
            ? Math.round(speedHi).toLocaleString() + ' rpm'
            : Math.round(speedLo).toLocaleString() + '–' + Math.round(speedHi).toLocaleString() + ' rpm';
        if (arch.id !== 'igc' && speedHi > arch.maxSpeed) {
            reasons.push('Predicted speed ' + speedTxt + ' is above the usual ' +
                         Math.round(arch.maxSpeed).toLocaleString() + ' rpm ceiling for this architecture - a geared or integrally geared machine is implied.');
        } else if (speedHi > 0 && speedHi < 3000) {
            reasons.push('Predicted speed ' + speedTxt + ' is low for a centrifugal - check the head split, or consider a direct 2-pole/4-pole motor drive.');
        }

        return {
            type: type,
            casing: casing,
            reasons: reasons,
            suitability: suitability,
            architecture: arch.id,
            speedText: speedTxt,
            h2PartialPressure_bar: pH2_bar,
            // An integrally geared machine has its gear built in, so no separate
            // gearbox is charged for it in the power train.
            gearRequired: arch.id !== 'igc' && speedHi > 3600
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
        // An integrally geared machine pays a mesh loss per pinion rather than
        // one flat gearbox loss, since every pinion is its own gear mesh.
        var gearLoss = o.pinions > 0
            ? IGC_LIMITS.meshLoss * o.pinions
            : (o.gearbox ? 0.02 : 0);
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
        },
        volume: {                               // base m3 (train accessories:
            base: 'm3',                         // settle-out system volumes,
            SI: 'm³', US: 'ft³',                // lube reservoir, rundown tank)
            list: [
                Object.assign({ code: 'm3', label: 'm³' }, lin(1)),
                Object.assign({ code: 'L', label: 'L' }, lin(1e-3)),
                Object.assign({ code: 'ft3', label: 'ft³' }, lin(0.028316846592)),
                Object.assign({ code: 'usgal', label: 'US gal' }, lin(0.003785411784))
            ]
        },
        torque: {                               // base N·m (gear and coupling
            base: 'N·m',                        // ratings on the train tabs)
            SI: 'kN·m', US: 'lbf·ft',
            list: [
                Object.assign({ code: 'kNm', label: 'kN·m' }, lin(1e3)),
                Object.assign({ code: 'Nm', label: 'N·m' }, lin(1)),
                Object.assign({ code: 'lbfft', label: 'lbf·ft' }, lin(1.3558179483314004))
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

        // 14. Manual stage count is honoured exactly, and the heads still sum.
        var manualStages = runSection({
            mix: ng, model: 'PR', T1: 313.15, P1: 30e5, P2: 90e5, mdot: 20000 / 3600,
            stagesMode: 'manual', stagesManual: 6
        });
        check('Manual stage count is honoured', manualStages.nStages, 6, 0, '');
        var manualHeadSum = manualStages.stages.reduce(function (a, st) { return a + st.Hp; }, 0);
        check('Manual stage count: heads still sum to section head',
              manualHeadSum, manualStages.HpTotal, manualStages.HpTotal * 1e-6, 'J/kg');

        // 15. Manual speed is honoured exactly, and D2 = 60U2/(piN) still closes.
        var manualSpeed = runSection({
            mix: ng, model: 'PR', T1: 313.15, P1: 30e5, P2: 90e5, mdot: 20000 / 3600,
            speedMode: 'manual', speedManual: 15000
        });
        check('Manual speed is honoured', manualSpeed.speed, 15000, 1e-6, 'rpm');
        var st0 = manualSpeed.stages[0];
        check('Manual speed: D₂ closes with U₂ = πDN/60',
              Math.PI * st0.D2 * manualSpeed.speed / 60, st0.U2, 1e-6, 'm/s');

        // 16. A duty whose free optimum exceeds maxSpeed is capped and flagged;
        //     a duty within it is untouched. Uses a deliberately low maxSpeed so
        //     the free solve is known to exceed it.
        var speedCapped = runSection({
            mix: ng, model: 'PR', T1: 313.15, P1: 30e5, P2: 90e5, mdot: 20000 / 3600,
            maxSpeed: 8000
        });
        check('Speed cap: speedLimited set and speed pinned at the cap',
              speedCapped.speedLimited ? speedCapped.speed : -1, 8000, 1e-6, '');
        check('Speed cap: overSpeed is false once capped', speedCapped.overSpeed ? 1 : 0, 0, 0, '');

        // 17. A manual speed ABOVE the cap must raise overSpeed - the case that
        //     silently passed through with no flag before this change.
        var overSpeedCase = runSection({
            mix: ng, model: 'PR', T1: 313.15, P1: 30e5, P2: 90e5, mdot: 20000 / 3600,
            maxSpeed: 8000, speedMode: 'manual', speedManual: 30000
        });
        check('Manual speed above the cap sets overSpeed', overSpeedCase.overSpeed ? 1 : 0, 1, 0,
              'This case used to pass through with no flag at all.');

        // 18. A duty clamped by minD2 sets sizeLimited and returns exactly minD2.
        var sizeCapped = runSection({
            mix: ng, model: 'PR', T1: 313.15, P1: 30e5, P2: 90e5, mdot: 20000 / 3600,
            minD2: 0.60
        });
        check('Size cap: sizeLimited set and D₂ pinned at the minimum',
              sizeCapped.sizeLimited ? sizeCapped.stages[0].D2 : -1, 0.60, 1e-6, 'm');

        // 19. IGC pinion pairing: paired stages share exactly one speed, the
        //     ratio is N_pinion / N_bullGear, and an odd stage count yields the
        //     expected pinion count under auto pairing.
        var igcAir = makeMixture(PRESETS['Air']);
        var igcTrain = runTrain({
            mix: igcAir, model: 'PR', T1: 293.15, P1: 1e5, mdot: 50000 / 3600,
            architecture: 'igc', impeller: impellerType('open'),
            limits: Object.assign({}, DEFAULTS, { mu2Max: impellerType('open').mu2Max }),
            bullGearSpeed: 1800, pinionLayout: 'auto',
            sections: [
                { P2: 2.11e5, Tcool_K: 313.15, dPcool_Pa: 0.15e5 },
                { P2: 4.47e5, Tcool_K: 313.15, dPcool_Pa: 0.15e5 },
                { P2: 9.46e5, Tcool_K: 313.15, dPcool_Pa: 0.15e5 },
                { P2: 20e5 }
            ]
        });
        check('IGC: 4 stages auto-pair into 2 pinions', igcTrain.pinions.length, 2, 0, '');
        var pinionA = igcTrain.pinions[0];
        var speedsInPinionA = pinionA.stages.map(function (idx) { return igcTrain.sections[idx - 1].speed; });
        check('IGC: paired stages share exactly one speed',
              Math.max.apply(null, speedsInPinionA) - Math.min.apply(null, speedsInPinionA), 0, 1e-6, 'rpm');
        check('IGC: gear ratio = N_pinion / N_bullGear',
              pinionA.ratio, pinionA.speed / pinionA.bullGearSpeed, 1e-9, '');

        var igc5 = runTrain({
            mix: igcAir, model: 'PR', T1: 293.15, P1: 1e5, mdot: 50000 / 3600,
            architecture: 'igc', impeller: impellerType('open'),
            limits: Object.assign({}, DEFAULTS, { mu2Max: impellerType('open').mu2Max }),
            bullGearSpeed: 1800,
            sections: [
                { P2: 1.7e5, Tcool_K: 313.15, dPcool_Pa: 0.1e5 },
                { P2: 2.9e5, Tcool_K: 313.15, dPcool_Pa: 0.1e5 },
                { P2: 4.9e5, Tcool_K: 313.15, dPcool_Pa: 0.1e5 },
                { P2: 8.4e5, Tcool_K: 313.15, dPcool_Pa: 0.1e5 },
                { P2: 20e5 }
            ]
        });
        check('IGC: 5 stages auto-pair into 3 pinions', igc5.pinions.length, 3, 0, 'ceil(5/2)');

        // 20. stageSweep is monotonic: more stages -> smaller D2 at the same
        //     head-per-stage target -> lower Mu2, since U2 falls with head/stage.
        var sweep = stageSweep({
            mix: ng, model: 'PR', T1: 313.15, P1: 30e5, mdot: 20000 / 3600,
            limits: DEFAULTS, impeller: impellerType('std')
        }, 3, 7);
        var sweepOk = sweep.filter(function (r) { return r.ok !== false || isFinite(r.mu2Max); })
                            .filter(function (r) { return isFinite(r.mu2Max); });
        var sweepMonotonic = sweepOk.every(function (r, i) {
            return i === 0 || r.mu2Max <= sweepOk[i - 1].mu2Max + 1e-9;
        });
        check('Stage sweep: Mu₂ falls monotonically as stage count rises',
              sweepMonotonic ? 1 : 0, 1, 0,
              sweep.map(function (r) { return r.nStages + ':' + (isFinite(r.mu2Max) ? r.mu2Max.toFixed(3) : r.error || '?'); }).join(', '));

        // 21. Sandberg (2022) selection methodology, checked against the
        //     paper's own six worked case studies (Appendix, Tables A1-A6).
        //     Hp and Qa below are taken straight from those tables and run
        //     through toBase so the check exercises the same unit path a
        //     user's US-unit input would. Tight (~1%) tolerance mid-table
        //     where the case studies sit inside the optimum band; loosened
        //     at the one case (A4.5) that lands in the sparse, steeply-bent
        //     tail beyond ns ~ 1.25 - see note there.
        (function () {
            var ftlbflbm = function (v) { return toBase('head', 'ft.lbf/lbm', v); };
            var acfm = function (v) { return toBase('volFlow', 'ACFM', v); };
            var inches = function (v) { return toBase('length', 'in', v); };

            // Table A1.2, phi = 0.08 column, 4 stages.
            var a12 = selectSection('phi', {
                HpTotal: ftlbflbm(52960.8), Q1: acfm(6928), nStages: 4, value: 0.08, etaFactor: 1
            });
            check('Selection A1.2 (phi=0.08): impeller diameter', a12.D, inches(17.2554), inches(17.2554) * 0.01, 'in');
            check('Selection A1.2 (phi=0.08): speed', a12.N, 11806.7, 11806.7 * 0.01, 'rpm');
            check('Selection A1.2 (phi=0.08): head coefficient μp', a12.mu_p, 0.5391, 0.01, '');
            check('Selection A1.2 (phi=0.08): polytropic efficiency', a12.etaP, 0.8473, 0.01, '');

            // Table A1.5, Equal Impeller Diameter column.
            var a15d = selectSection('diameter', {
                HpTotal: ftlbflbm(52937.6), Q1: acfm(6928), nStages: 4, value: inches(14.8790), etaFactor: 1
            });
            check('Selection A1.5 (fixed D): specific speed ns', a15d.nsSpec, 0.9373, 0.02, '');
            check('Selection A1.5 (fixed D): speed', a15d.N, 13884, 13884 * 0.02, 'rpm');
            check('Selection A1.5 (fixed D): flow coefficient', a15d.phi, 0.1061, 0.003, '');

            // Table A1.5, Equal Rotational Speed column.
            var a15n = selectSection('speed', {
                HpTotal: ftlbflbm(52937.6), Q1: acfm(6928), nStages: 4, value: 13485, etaFactor: 1
            });
            check('Selection A1.5 (fixed N): specific diameter ds', a15n.dsSpec, 3.0122, 0.02, '');
            check('Selection A1.5 (fixed N): impeller diameter', a15n.D, inches(15.2055), inches(15.2055) * 0.02, 'in');

            // Table A2.2, phi = 0.08 column, 7 stages - same duty at a
            // different flow scale, to catch an accidental size dependence.
            var a22 = selectSection('phi', {
                HpTotal: ftlbflbm(87256.7), Q1: acfm(17316), nStages: 7, value: 0.08, etaFactor: 1
            });
            check('Selection A2.2 (phi=0.08): impeller diameter', a22.D, inches(27.6945), inches(27.6945) * 0.01, 'in');
            check('Selection A2.2 (phi=0.08): speed', a22.N, 7137.8, 7137.8 * 0.01, 'rpm');

            // Table A3.4, phi = 0.005 at 95% efficiency: the paper's own
            // example of a selection that is arithmetically solvable but not
            // physically viable (tau > 1, more enthalpy rise than available).
            var a34 = selectSection('phi', {
                HpTotal: ftlbflbm(17056.4), Q1: acfm(257.7), nStages: 3, value: 0.005, etaFactor: 0.95
            });
            check('Selection A3.4 (phi=0.005, 95% η): work input coefficient τ > 1', a34.tau, 1.0343, 0.01, '');
            check('Selection A3.4 (phi=0.005, 95% η): flagged not viable', a34.viable ? 1 : 0, 0, 0, '');

            // Table A4.5, Equal Rotational Speed column: fixed 3600 rpm motor,
            // single stage. This ns (~1.32) falls between SELECTION_TABLE's
            // last two nodes (1.2512 at phi=0.17, 1.4297 at phi=0.19), the
            // most sparsely sampled, most sharply bent part of the curve -
            // log-log interpolation there recovers ds to ~2%, and since
            // phi = flowCoefficient(Q,D,N) with N fixed goes as 1/D^3, that
            // becomes ~6-8% on phi. Kept as a test (not deleted) because it
            // is a real, bounded, understood limitation worth catching a
            // regression on, not a hidden gap.
            var a45 = selectSection('speed', {
                HpTotal: ftlbflbm(9089.4), Q1: acfm(116753.4), nStages: 1, value: 3600, etaFactor: 1
            });
            check('Selection A4.5 (fixed N=3600, tail region): impeller diameter', a45.D, inches(51.036), inches(51.036) * 0.03, 'in');

            // Round-trip consistency: any two methods, run on the geometry
            // that the third one produced, must land back on the same
            // machine. This is the property the whole methodology depends
            // on and it is independent of how well any curve is digitised.
            var base = selectSection('phi', {
                HpTotal: ftlbflbm(52960.8), Q1: acfm(6928), nStages: 4, value: 0.08, etaFactor: 1
            });
            var viaD = selectSection('diameter', {
                HpTotal: ftlbflbm(52960.8), Q1: acfm(6928), nStages: 4, value: base.D, etaFactor: 1
            });
            var viaN = selectSection('speed', {
                HpTotal: ftlbflbm(52960.8), Q1: acfm(6928), nStages: 4, value: base.N, etaFactor: 1
            });
            check('Selection: fixed-diameter method closes on the phi method\'s N',
                  viaD.N, base.N, base.N * 0.01, 'rpm');
            check('Selection: fixed-speed method closes on the phi method\'s D',
                  viaN.D, base.D, base.D * 0.01, 'm');
        })();

        // 21b. The four stage-sizing primitives must be mutually consistent.
        //      Each solves for a different pair, so round-tripping one through
        //      the others is what proves they describe the same machine.
        (function () {
            var g = stageGeometry(30000, 5.0, 0.52, 0.075);
            var atD = stageAtDiameter(30000, 5.0, 0.52, g.D2);
            check('stageAtDiameter recovers the speed stageGeometry picked',
                  atD.N, g.N, g.N * 1e-9, 'rpm');
            check('stageAtDiameter recovers the flow coefficient', atD.phi, 0.075, 1e-9, '');

            var both = stageAtBoth(30000, 5.0, g.D2, g.N);
            check('stageAtBoth recovers ψ from the geometry alone', both.psi, 0.52, 1e-9, '');
            check('stageAtBoth recovers φ from the geometry alone', both.phi, 0.075, 1e-9, '');

            // Halving the diameter at fixed speed quarters the tip speed and so
            // quadruples psi - the 1/D^2 behaviour a trimmed impeller shows.
            var trim = stageAtBoth(30000, 5.0, g.D2 / 2, g.N);
            check('stageAtBoth: ψ scales as 1/D²', trim.psi, 0.52 * 4, 0.52 * 4 * 1e-9, '');
        })();

        // 21c. Supplier-offering evaluation: with both diameter and speed given
        //      the machine is fully described, so φ and μp are outputs. These
        //      are the "Supplier Selection" columns of the paper's own tables,
        //      which is the case the fixed-D-and-N mode exists to serve.
        (function () {
            var ftlbflbm = function (v) { return toBase('head', 'ft.lbf/lbm', v); };
            var acfm = function (v) { return toBase('volFlow', 'ACFM', v); };
            var inches = function (v) { return toBase('length', 'in', v); };

            // Table A1.5, Supplier Selection column: 4 impellers, 14.8790 in,
            // 13,485 rpm on 52,808 ft.lbf/lbm and 6,928 ACFM.
            var s1 = stageAtBoth(ftlbflbm(52808.0) / 4, acfm(6928), inches(14.8790), 13485.0);
            check('Supplier eval A1.5: flow coefficient φ', s1.phi, 0.1092, 0.002, '');
            check('Supplier eval A1.5: head coefficient μp', s1.psi, 0.5542, 0.01, '');

            // Table A6.5, Supplier Selection column: 7 impellers, 48.9960 in,
            // 4,486 rpm on 112,224 ft.lbf/lbm and 52,329 ACFM (hydrogen recycle).
            var s6 = stageAtBoth(ftlbflbm(112224.0) / 7, acfm(52329), inches(48.9960), 4486.0);
            check('Supplier eval A6.5: flow coefficient φ', s6.phi, 0.0695, 0.002, '');
            check('Supplier eval A6.5: head coefficient μp', s6.psi, 0.5608, 0.01, '');
        })();

        // 21d. Per-stage diameters. A uniform list must be indistinguishable
        //      from the single-diameter case - that is the guard on the change
        //      from one section diameter to one per impeller.
        (function () {
            var uniform = runSection({
                mix: ng, model: 'PR', T1: 313.15, P1: 30e5, P2: 90e5, mdot: 20000 / 3600,
                stagesMode: 'manual', stagesManual: 4,
                fixMode: 'both', speedManual: 12000, D2Manual: 0.42
            });
            var listed = runSection({
                mix: ng, model: 'PR', T1: 313.15, P1: 30e5, P2: 90e5, mdot: 20000 / 3600,
                stagesMode: 'manual', stagesManual: 4,
                fixMode: 'both', speedManual: 12000, D2Manual: [0.42, 0.42, 0.42, 0.42]
            });
            check('Per-stage diameters: uniform list matches a single value',
                  listed.stages[3].psi, uniform.stages[3].psi, uniform.stages[3].psi * 1e-9, '');
            check('Per-stage diameters: a uniform section is not flagged as trimmed',
                  listed.trimmed ? 1 : 0, 0, 0, '');

            // A trimmed section: the last impeller is 10% smaller, so its tip
            // speed is 10% lower and it must carry the head at a higher psi.
            var trimmed = runSection({
                mix: ng, model: 'PR', T1: 313.15, P1: 30e5, P2: 90e5, mdot: 20000 / 3600,
                stagesMode: 'manual', stagesManual: 4,
                fixMode: 'both', speedManual: 12000, D2Manual: [0.42, 0.42, 0.42, 0.378]
            });
            check('Trimmed section is flagged', trimmed.trimmed ? 1 : 0, 1, 0, '');
            check('Trimmed impeller runs at ψ scaled by 1/D²',
                  trimmed.stages[3].psi, trimmed.stages[0].psi / (0.9 * 0.9),
                  trimmed.stages[0].psi * 1e-6, 'The head split is equal, so a smaller impeller works harder.');
            check('Weighted average diameter is Eqn 9, not the arithmetic mean',
                  trimmed.D2, Math.sqrt((3 * 0.42 * 0.42 + 0.378 * 0.378) / 4), 1e-9, 'm');
        })();

        // 21e. Basis equivalence - the assertion that "size this section by the
        //      paper's method" and "the paper's table says" are the same number.
        //      Without this the sandberg basis could drift from the Selection
        //      tab it is supposed to mirror and nothing would notice.
        (function () {
            var common = {
                mix: ng, model: 'PR', T1: 313.15, P1: 30e5, P2: 90e5, mdot: 20000 / 3600,
                stagesMode: 'manual', stagesManual: 5, basis: 'sandberg', phiTarget: 0.09,
                maxSpeed: 1e9, minD2: 1e-9        // let the correlation stand unclamped
            };
            var solved = runSection(common);
            var predicted = selectSection('phi', {
                HpTotal: solved.HpTotal, Q1: solved.Q1, nStages: 5, value: 0.09, etaFactor: 1
            });
            check('Basis equivalence (auto): solver speed matches the phi method',
                  solved.speed, predicted.N, predicted.N * 0.01, 'rpm');
            check('Basis equivalence (auto): solver diameter matches the phi method',
                  solved.D2, predicted.D, predicted.D * 0.01, 'm');
            check('Basis equivalence (auto): ψ is derived, not the 0.52 target',
                  solved.psiUsed, predicted.mu_p, 0.01, 'On the sandberg basis ψ is an output.');

            // Fixed speed on the sandberg basis must reproduce the fixed-speed
            // method at that same speed.
            var atN = runSection(Object.assign({}, common, {
                fixMode: 'speed', speedManual: 9000
            }));
            var predN = selectSection('speed', {
                HpTotal: atN.HpTotal, Q1: atN.Q1, nStages: 5, value: 9000, etaFactor: 1
            });
            check('Basis equivalence (fixed N): diameter matches the fixed-speed method',
                  atN.D2, predN.D, predN.D * 0.01, 'm');

            // And fixed diameter must reproduce the fixed-diameter method.
            var atD = runSection(Object.assign({}, common, {
                fixMode: 'diameter', D2Manual: 0.45
            }));
            var predD = selectSection('diameter', {
                HpTotal: atD.HpTotal, Q1: atD.Q1, nStages: 5, value: 0.45, etaFactor: 1
            });
            check('Basis equivalence (fixed D): speed matches the fixed-diameter method',
                  atD.speed, predD.N, predD.N * 0.01, 'rpm');
        })();

        // 21f. A pinned geometry is honoured exactly, and the app basis is
        //      untouched by any of the above.
        (function () {
            var pinned = runSection({
                mix: ng, model: 'PR', T1: 313.15, P1: 30e5, P2: 90e5, mdot: 20000 / 3600,
                fixMode: 'both', speedManual: 11000, D2Manual: 0.40, stagesMode: 'manual', stagesManual: 4
            });
            check('Fixed D and N: speed honoured exactly', pinned.speed, 11000, 1e-9, 'rpm');
            check('Fixed D and N: diameter honoured exactly', pinned.stages[0].D2, 0.40, 1e-9, 'm');
            check('Fixed D and N: ψ is reported as an output',
                  pinned.psiUsed, pinned.stages[0].psi, pinned.stages[0].psi * 1e-9, '');
            check('Fixed D and N: sizeSource is manual',
                  pinned.sizeSource === 'manual' ? 1 : 0, 1, 0, '');
        })();

        // 22. Digitisation cross-checks. A misread chart is the likeliest
        //     failure mode for FIG15/FIG16/SELECTION_TABLE.eta, so these
        //     compare independently-sourced curves against each other rather
        //     than against a single external number.
        (function () {
            // SELECTION_TABLE.eta (from the case-study tables) should track
            // the existing AUNGIER_ETA vaned/vaneless average (from Figure 11,
            // added independently in an earlier pass) closely - two
            // digitisations of the same underlying relationship.
            var maxGap = 0, worstPhi = null;
            SELECTION_TABLE.phi.forEach(function (phi, i) {
                if (phi < 0.01 || phi > 0.19) return;
                var avg = (aungierEtaP(phi, 'vaned') + aungierEtaP(phi, 'vaneless')) / 2;
                var gap = Math.abs(SELECTION_TABLE.eta[i] - avg);
                if (gap > maxGap) { maxGap = gap; worstPhi = phi; }
            });
            check('SELECTION_TABLE.eta tracks AUNGIER_ETA (Fig 17 vs Fig 11)',
                  maxGap, 0, 0.025, 'Largest gap ' + maxGap.toFixed(4) + ' at φ=' + worstPhi + '.');

            // Every FIG15/FIG16 source curve should reproduce the tabulated
            // ds/ns over the optimum band (phi 0.05-0.11) within a loose
            // digitisation tolerance - the paper's own point is that these
            // curves agree closely there, so a wide spread means a misread
            // axis or a log/linear mix-up, not a real disagreement.
            ['cordier', 'casey', 'aungierVaned', 'aungierVaneless'].forEach(function (src) {
                var worst = 0;
                SELECTION_TABLE.phi.forEach(function (phi, i) {
                    if (phi < 0.05 || phi > 0.11) return;
                    var ds = dsFromPhi(phi, src);
                    var rel = Math.abs(ds - SELECTION_TABLE.ds[i]) / SELECTION_TABLE.ds[i];
                    if (rel > worst) worst = rel;
                });
                check('Fig 15 (' + src + ') tracks tabulated ds over optimum band', worst, 0, 0.03,
                      'Worst relative gap ' + (worst * 100).toFixed(1) + '%.');
            });
        })();

        /* ---- 12. Unit catalogue round trips (volume & torque, added for the
                   train accessory tabs) ---------------------------------- */
        check('Volume: 1000 L = 1 m3', convert('volume', 'L', 'm3', 1000), 1, 1e-12);
        check('Volume: 1 ft3 in US gal', convert('volume', 'ft3', 'usgal', 1), 7.48052, 1e-4);
        check('Torque: 1 kN·m in lbf·ft', convert('torque', 'kNm', 'lbfft', 1), 737.562, 0.01);
        check('systemUnits covers every category', Object.keys(systemUnits('SI')).length, Object.keys(UNITS).length, 0);

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
        EMPIRICAL_BANDS: EMPIRICAL_BANDS,
        IMPELLER_TYPES: IMPELLER_TYPES,
        ARCHITECTURES: ARCHITECTURES,
        IGC_LIMITS: IGC_LIMITS,
        UNITS: UNITS,

        makeMixture: makeMixture,
        getKij: getKij,
        kijKey: kijKey,
        impellerType: impellerType,
        architecture: architecture,

        state: state,
        derived: derived,
        cpIdealMolar: cpIdealMolar,
        solveTfromH: solveTfromH,
        solveTfromS: solveTfromS,

        compressPath: compressPath,
        schultzHead: schultzHead,
        simplePolytropicHead: simplePolytropicHead,

        baseEtaP: baseEtaP,
        phiEfficiencyFactor: phiEfficiencyFactor,
        aungierEtaP: aungierEtaP,
        aungierAxialLengthRatio: aungierAxialLengthRatio,
        AUNGIER_ETA: AUNGIER_ETA,
        predictEtaP: predictEtaP,

        // Exported so the Help tab can show the EOS internals (A, B, am, bm,
        // the Z roots) with live numbers instead of the UI re-deriving them
        // and drifting from what the engine actually solved.
        cubicMixParams: cubicMixParams,
        cubicZ: cubicZ,

        stageGeometry: stageGeometry,
        stageAtSpeed: stageAtSpeed,
        stageAtDiameter: stageAtDiameter,
        stageAtBoth: stageAtBoth,
        inletRelativeMach: inletRelativeMach,

        // Sandberg (2022) preliminary selection methodology
        specificSpeed: specificSpeed,
        specificDiameter: specificDiameter,
        flowCoefficient: flowCoefficient,
        weightedAvgDiameter: weightedAvgDiameter,
        SELECTION_TABLE: SELECTION_TABLE,
        SELECTION_SOURCES: SELECTION_SOURCES,
        PHI_BEST_LO: PHI_BEST_LO,
        PHI_BEST_HI: PHI_BEST_HI,
        FIG15: FIG15,
        FIG16: FIG16,
        dsFromPhi: dsFromPhi,
        nsFromDs: nsFromDs,
        dsFromNs: dsFromNs,
        etaFromPhi: etaFromPhi,
        selectSection: selectSection,
        selectionSweep: selectionSweep,
        selectSectionIterated: selectSectionIterated,

        runSection: runSection,
        runSectionWithReference: runSectionWithReference,
        runTrain: runTrain,
        assignPinions: assignPinions,
        autoPairPinions: autoPairPinions,
        stageSweep: stageSweep,
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
