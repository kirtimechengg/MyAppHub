/**
 * compressor-train.js
 * ---------------------------------------------------------------------------
 * Compressor TRAIN accessory engine: gearbox (API 613 / API 677), driver
 * (electric motor, steam turbine API 612, gas turbine API 616), coupling
 * (API 671), lube oil system (API 614), dry gas seals (API 692), train
 * inertia and coast-down.
 *
 * Pure computation: no DOM access, no Firebase. Same contract as
 * compressor-eos.js — a single `TrainEng` namespace, strict SI internally
 * (W, N·m, rpm where stated, K, Pa, m, kg·m², m³/s). Loaded AFTER
 * compressor-eos.js: it leans on CompEng for real-gas states (settle-out
 * pressure, steam expansion, gas densities) instead of duplicating an EOS.
 *
 * Scope and honesty
 * -----------------
 * Everything here is SCREENING LEVEL — the numbers an engineer wants on day
 * one of a project to size the train, write the requisition and sanity-check
 * vendor bids. It is not a gear rating to AGMA 6011/ISO 6336, not a steam
 * path design, not a seal vendor's leakage curve. Each function documents
 * its anchors and its error bars; the governing API standard editions and
 * the purchaser's specification always take precedence.
 * ---------------------------------------------------------------------------
 */
(function (global) {
    'use strict';

    var E = global.CompEng;
    if (!E) {
        throw new Error('compressor-train.js needs compressor-eos.js loaded first (CompEng namespace missing).');
    }

    var PI = Math.PI;
    var G = 9.80665;                 // m/s2
    var RHO_STEEL = 7850;            // kg/m3

    function rpmToRad(n) { return n * PI / 30; }

    /* ===================================================================== */
    /* 1. Driver catalogue                                                    */
    /* ===================================================================== */
    /* Minimum gear service factors follow API 613 5th ed. practice for a
       centrifugal-compressor driven unit. They are MINIMUMS — a purchaser
       spec can only raise them. The synchronous motor gets more than the
       induction machine because of air-gap torque pulsation at starting;
       the gas turbine more again for its hot-restart torque transients.
       API 677 (general purpose) allows lighter factors; 1.1 is its floor
       and it is applied when the user selects the general-purpose standard.

       MCS / trip follows API 612 (steam turbines: MCS = 105% rated, trip =
       110% of MCS) and the same convention is commonly applied to API 616
       power turbines. A fixed-speed motor has no mechanical overspeed:
       MCS = full-load speed and protection is electrical, so trip is null. */

    var DRIVERS = {
        motor_ind:  { label: 'Induction motor',          fixedSpeed: true,  sf613: 1.4, mcsFactor: 1.00, tripFactor: null, std: 'API 541 / IEC 60034' },
        motor_sync: { label: 'Synchronous motor',        fixedSpeed: true,  sf613: 1.6, mcsFactor: 1.00, tripFactor: null, std: 'API 546' },
        steam:      { label: 'Steam turbine',            fixedSpeed: false, sf613: 1.6, mcsFactor: 1.05, tripFactor: 1.10, std: 'API 612' },
        gasturbine: { label: 'Gas turbine',              fixedSpeed: false, sf613: 1.7, mcsFactor: 1.05, tripFactor: 1.10, std: 'API 616' }
    };
    var SF_API677_FLOOR = 1.1;

    function driverInfo(kind) { return DRIVERS[kind] || DRIVERS.motor_ind; }

    /* ===================================================================== */
    /* 2. Gear data — materials and screening limits                          */
    /* ===================================================================== */
    /* The K-factor (tooth pitting index) used here is the API 613 form
           K = Wt/(d·F) · (R+1)/R      [N/mm2 = MPa]
       with Wt the tangential load at the pitch line, d the pinion pitch
       diameter, F the net face width and R the ratio (>1, increaser).
       The allowable is the material index divided by the service factor.
       Index values are the customary screening numbers for double-helical
       special-purpose gears: through-hardened ~320 HB cut gears carry far
       less than carburised, hardened and ground teeth. */

    var GEAR_MATERIALS = {
        throughHardened: { label: 'Through-hardened (~320 HB)',      index_MPa: 3.0 },
        carburised:      { label: 'Carburised, hardened & ground',   index_MPa: 5.5 }
    };

    var GEAR_LIMITS = {
        plvRoutine: 125,    // m/s  below this: routine special-purpose design
        plvSpecial: 200,    // m/s  125-200: needs careful spray/scavenge design; above: flag
        journalWarn: 85,    // m/s  bearing journal surface velocity — warn
        journalMax: 120,    // m/s  — flag
        faceRatio: 1.0,     // F/d, net of the apex gap, typical double-helical
        maxSingleRatio: 8,  // above this a single-mesh parallel-shaft box gets big — warn
        helixDeg: 30,       // typical double-helical helix angle (thrust cancels)
        meshLossFrac: 0.015,    // per mesh — matches the 2% flat gearbox loss used by
        gearBearingLossFrac: 0.005 // driverRating() when the 0.5% bearing share is added
    };

    /* ===================================================================== */
    /* 3. Inertia correlations                                                */
    /* ===================================================================== */
    /* Rotor polar inertia scales with rated torque far better than with
       power alone (a slow rotor is a big rotor). The motor correlation
           J [kg·m2] = 2.3 · (T_rated [kN·m])^1.4
       is anchored on two typical machines: a 10 MW 2-pole (T = 31.8 kN·m,
       vendor J ≈ 280 kg·m2) and a 1 MW 4-pole (T = 6.4 kN·m, J ≈ 30 kg·m2).
       Turbine rotors carry less iron per newton-metre; the constants below
       reflect that. GAS TURBINE means the free power turbine only — the gas
       generator decouples aerodynamically on trip and contributes nothing
       to coast-down. All of these are ±50% class estimates and the UI lets
       the user override every element with a vendor number.

       The compressor rotor is built from geometry instead: each impeller as
       a steel disc of width 0.05·D2,
           J_stage = ½·m·(D2/2)²  with  m = ρ·(π/4)·D2²·(0.05·D2)
                   = 38.5 · D2^5   [kg·m2, D2 in m]
       plus 15% for the shaft, balance piston and thrust collar. Gear wheels
       are solid discs, J = (π/32)·ρ·F·d^4. A coupling adds ~5% of the shaft
       it hangs on. */

    var INERTIA = {
        motorC: 2.3, motorExp: 1.4,
        steamC: 1.6, steamExp: 1.4,
        gtC: 1.2, gtExp: 1.4,
        impellerC: 38.5,      // J = C · D2^5 per impeller
        shaftAllowance: 1.15, // impeller sum × this
        couplingFrac: 0.05
    };

    function driverInertia(kind, rated_W, N_rpm) {
        var T_kNm = rated_W / rpmToRad(Math.max(N_rpm, 1)) / 1000;
        var c, x;
        if (kind === 'steam') { c = INERTIA.steamC; x = INERTIA.steamExp; }
        else if (kind === 'gasturbine') { c = INERTIA.gtC; x = INERTIA.gtExp; }
        else { c = INERTIA.motorC; x = INERTIA.motorExp; }
        return c * Math.pow(Math.max(T_kNm, 0.01), x);
    }

    function gearWheelInertia(d_m, F_m) {
        return (PI / 32) * RHO_STEEL * F_m * Math.pow(d_m, 4);
    }

    function compressorInertia(train) {
        var j = 0;
        train.sections.forEach(function (sec) {
            sec.stages.forEach(function (st) {
                j += INERTIA.impellerC * Math.pow(st.D2, 5);
            });
        });
        return j * INERTIA.shaftAllowance;
    }

    /* ===================================================================== */
    /* 4. Lube oil constants (API 614 special purpose)                        */
    /* ===================================================================== */
    /* ISO VG 32/46 mineral oil at supply temperature. The reservoir sizing
       follows the API 614 special-purpose custom: retention capacity of
       eight minutes of NORMAL flow between minimum and suction-loss levels,
       a five-minute charge capacity above the maximum operating level, and
       free surface/freeboard on top. The rundown (overhead) tank feeds the
       bearings by gravity during a coast-down after total pump loss; during
       rundown a reduced header pressure (~0.7 barg at the bearing inlet) is
       the accepted practice, which sets the tank elevation. */

    var LUBE = {
        rho: 860,            // kg/m3
        cp: 1950,            // J/(kg.K)
        dT_K: 20,            // default oil temperature rise across a bearing
        retention_min: 8,    // reservoir retention, minutes of normal flow
        charge_min: 5,       // charge capacity, minutes of normal flow
        freeboard: 1.15,     // gross = working volume × this
        pumpMargin: 1.2,     // main pump = 1.2 × normal flow (API 614 custom: 10-20%)
        accBridge_s: 6,      // accumulator bridges the aux pump start, seconds
        accVesselFactor: 2.5,// gas-charged vessel ≈ 2.5 × displaced oil volume
        rundownMargin: 1.2,  // tank volume = bearing flow × coastdown × this
        rundownHeader_Pa: 0.7e5, // accepted reduced header pressure during rundown (gauge)
        lineLoss: 1.2,       // elevation margin for line losses
        filterMicron: 10,
        motorBearingFrac: 0.005,   // driver bearing loss allowance, fraction of rated
        turbineBearingFrac: 0.010  // turbines carry heavier journals + thrust
    };

    /* ===================================================================== */
    /* 5. Coupling factors (API 671)                                          */
    /* ===================================================================== */
    /* API 671 asks the coupling continuous rating to carry the normal
       operating torque with margin; 1.5 is the customary screening factor,
       1.75 for a synchronous motor whose air-gap torque pulsates at
       starting. The REAL sizing case for a big motor drive is the
       short-circuit transient (4-6 × rated air-gap torque) — that is a
       torsional analysis question (API 684) and is flagged, not sized,
       here. Dry flexible-element couplings only: disc packs are the
       default; diaphragms take more misalignment and speed. */

    var COUPLING_SF = {
        motor_ind: 1.5, motor_sync: 1.75, steam: 1.5, gasturbine: 1.5,
        types: {
            disc:      { label: 'Flexible disc pack' },
            diaphragm: { label: 'Flexible diaphragm' }
        }
    };

    /* ===================================================================== */
    /* 6. Steam saturation correlations                                       */
    /* ===================================================================== */
    /* The superheated-vapour states come from CompEng's Peng-Robinson state
       of pure H2O — good to ~1-3% in enthalpy DIFFERENCES for screening.
       Only the saturation line and the fg-differences use the short
       correlations below (checked against steam tables, 0.05-20 bara):
         Tsat: Antoine (Bridgeman form), ±0.3 K over the range
         h_fg ≈ 2501 − 2.36·t [kJ/kg, t in °C]          (±1.5%)
         s_fg = h_fg / Tsat                              (Clausius, exact)
       Mixing references is the classic trap: the EOS enthalpy zero is the
       ideal gas at 298 K, steam tables zero the triple-point liquid. So the
       wet end state is built ENTIRELY in EOS space — saturated vapour from
       the EOS, minus (1−x)·h_fg from the correlation — and no table value
       is ever added to an EOS value. */

    var STEAM_MIX = null;
    function steamMix() {
        if (!STEAM_MIX) STEAM_MIX = E.makeMixture([{ id: 'H2O', molPct: 100 }]);
        return STEAM_MIX;
    }

    function steamTsat(P_Pa) {
        // Antoine for water, mmHg / degC form, the two classic ranges:
        // 1-100 degC (condensing exhausts) and 99-374 degC (back-pressure
        // and inlet saturation). Checked against steam tables: within
        // +/-0.5 K from 0.05 to 100 bara.
        var P_mmHg = P_Pa / 133.322;
        var A, B, C;
        if (P_Pa < 1e5) { A = 8.07131; B = 1730.63; C = 233.426; }
        else            { A = 8.14019; B = 1810.94; C = 244.485; }
        var tC = B / (A - Math.log10(P_mmHg)) - C;
        return tC + 273.15;
    }

    function steamHfg(Tsat_K) {                      // J/kg
        var t = Tsat_K - 273.15;
        return (2501 - 2.36 * t) * 1000;
    }

    /* ===================================================================== */
    /* 7. Gas turbine site derating (API 616 screening)                       */
    /* ===================================================================== */
    /* A gas turbine is a mass-flow machine: anything that thins the inlet
       air takes output with it.
         altitude    exp(−z/8435)  — the barometric formula itself
                     (≈ 3.5% per 300 m near sea level)
         temperature −0.6%/°C above the 15 °C ISO day, small credit below
                     it but capped: cold-day output is flat-rated by the
                     gas generator, not thermodynamics
         humidity    water vapour displaces air; ρ_humid/ρ_dry =
                     1 − 0.378·Pv/Pamb (Pv from the Magnus formula) — a
                     ~1% effect on a hot, saturated day, second order
         duct losses inlet filter + exhaust stack, 2% combined default   */

    function magnusPsat_Pa(T_K) {
        var t = T_K - 273.15;
        return 610.8 * Math.exp(17.27 * t / (t + 237.3));
    }

    /* ===================================================================== */
    /* 8. Dry gas seal screening (API 692)                                    */
    /* ===================================================================== */
    /* Primary seal leakage: a tandem seal's primary faces pass a gas film
       a few microns thick; vendor curves collapse reasonably onto
           q [Nm3/h per seal] ≈ 4e-4 · D_seal[mm] · P_sealing[bara]
       (anchor: a 75 mm seal at 100 bara leaks ~3 Nm3/h). Real leakage
       varies with gas MW, temperature and face design by ±50% — this is a
       flare-load screening number, not a guarantee. The secondary
       (inter-stage) seal sees only the primary vent backpressure and
       passes ~10% of the primary. Seal gas SUPPLY is sized by velocity —
       enough flow to hold ≥5 m/s across the inner process labyrinth so
       process gas can never reach the faces. Separation (N2) gas is a
       small constant per seal. */

    var DGS = {
        leakC: 4e-4,           // Nm3/h per (mm · bara)
        secondaryFrac: 0.10,
        ventDesignFactor: 1.5, // flare line design = 1.5 × computed leakage
        labyVel: 5,            // m/s across the inner labyrinth
        labyClearance: 0.00025,// m radial
        sepGasPerSeal: 3,      // Nm3/h N2, typical 2-5
        sleeveAdd_mm: 20,      // seal size ≈ shaft + sleeve
        faceSpeedWarn: 150,    // m/s
        faceSpeedMax: 180      // beyond typical vendor experience
    };

    /* ===================================================================== */
    /* 9. Gearbox rating and basic double-helical design                      */
    /* ===================================================================== */

    /**
     * Size and check a single-mesh, double-helical, parallel-shaft speed
     * increaser: bull gear on the low-speed (driver) shaft, pinion on the
     * high-speed (compressor) shaft.
     *
     * The pinion pitch diameter comes straight from the allowable K-factor,
     *     d³ = 2·T_p·SF·(R+1) / (K_allow·λ·R)
     * then tooth counts are chosen (z_pinion ≥ 23 against undercut, bull
     * count adjusted to a hunting-tooth combination) and the SELECTED ratio
     * z_bull/z_pinion replaces the required one — which is exactly why the
     * compressor is re-solved at the real output speed afterwards.
     */
    function gearRating(o) {
        var std = o.standard === 'api677' ? 'api677' : 'api613';
        var drv = driverInfo(o.driver);
        var SF = std === 'api677' ? Math.max(SF_API677_FLOOR, 1.1) : drv.sf613;
        var lam = o.faceRatio || GEAR_LIMITS.faceRatio;
        var mat = GEAR_MATERIALS[o.material] ? o.material : 'carburised';
        var Kmat = GEAR_MATERIALS[mat].index_MPa * 1e6;    // material index, Pa
        var Kallow = Kmat / SF;                   // K permitted at RATED torque

        var Nin = o.Nin_rpm, Nout = o.Nout_rpm;
        var Rreq = Nout / Nin;                    // increaser, > 1
        var P = o.powerAtGear_W;

        var Tin = P / rpmToRad(Nin);              // bull torque, N·m
        var Tp0 = P / rpmToRad(Nout);             // pinion torque at required speed

        // Pinion sizing: SF × rated torque against the material index —
        // equivalently, rated torque against Kallow. (One SF only: putting
        // it in both places would oversize the pinion by SF^(1/3).)
        var dp = Math.pow(2 * Tp0 * SF * (Rreq + 1) / (Kmat * lam * Rreq), 1 / 3);
        var F = lam * dp;                         // net face width (sum of helices)

        // Tooth counts: z_p from a 23-tooth undercut floor scaled up for
        // very large pinions (module sanity), bull rounded then nudged to
        // a hunting combination so every tooth meets every tooth.
        var zp = Math.max(23, Math.round(dp / 0.012));  // ~12 mm transverse module target
        var zb;
        if (o.ratioOverride > 0) {
            zb = Math.round(o.ratioOverride * zp);
        } else {
            zb = Math.round(Rreq * zp);
        }
        function gcd(a, b) { return b ? gcd(b, a % b) : a; }
        if (zb > zp && gcd(zp, zb) > 1) zb += 1;
        var Ract = zb / zp;
        var NoutSel = Nin * Ract;

        var Tp = P / rpmToRad(NoutSel);           // pinion torque at selected speed
        var db = Ract * dp;
        var a = 0.5 * (dp + db);
        var mt = dp / zp;                         // transverse module, m
        var mn = mt * Math.cos(GEAR_LIMITS.helixDeg * PI / 180);

        // Closure: K actually carried at rated torque (no SF) vs allowable.
        var K = 2 * Tp * (Ract + 1) / (lam * Math.pow(dp, 3) * Ract);
        var PLV = PI * dp * NoutSel / 60;
        var journalV = PI * (0.5 * dp) * NoutSel / 60;

        var meshLoss = P * GEAR_LIMITS.meshLossFrac;
        var bearingLoss = P * GEAR_LIMITS.gearBearingLossFrac;

        var checks = [];
        function chk(name, value, unit, limit, ok, level, note) {
            checks.push({ name: name, value: value, unit: unit, limit: limit, ok: ok, level: level, note: note || '' });
        }
        chk('Service factor', SF, '-', '>= ' + (std === 'api677' ? SF_API677_FLOOR : drv.sf613),
            true, 'pass', std === 'api677' ? 'API 677 general purpose floor' : 'API 613 minimum for ' + drv.label + ' drive');
        var kUtil = K * SF / (GEAR_MATERIALS[mat].index_MPa * 1e6);
        chk('K-factor at rated × SF', K * SF / 1e6, 'MPa', '<= ' + GEAR_MATERIALS[mat].index_MPa + ' MPa',
            kUtil <= 1.001, kUtil <= 1.001 ? 'pass' : 'fail',
            GEAR_MATERIALS[mat].label + ', utilisation ' + (kUtil * 100).toFixed(0) + '%');
        var plvLevel = PLV <= GEAR_LIMITS.plvRoutine ? 'pass' : (PLV <= GEAR_LIMITS.plvSpecial ? 'warn' : 'fail');
        chk('Pitch line velocity', PLV, 'm/s', '<= ' + GEAR_LIMITS.plvSpecial + ' m/s', plvLevel !== 'fail', plvLevel,
            plvLevel === 'pass' ? 'routine for special-purpose gears'
                : plvLevel === 'warn' ? 'high — oil spray/scavenge and windage need attention'
                : 'beyond usual special-purpose experience');
        var jLevel = journalV <= GEAR_LIMITS.journalWarn ? 'pass' : (journalV <= GEAR_LIMITS.journalMax ? 'warn' : 'fail');
        chk('Journal surface velocity', journalV, 'm/s', '<= ' + GEAR_LIMITS.journalMax + ' m/s', jLevel !== 'fail', jLevel,
            'pinion journal ≈ 0.5 × pitch diameter');
        var rLevel = Ract <= GEAR_LIMITS.maxSingleRatio ? 'pass' : 'warn';
        chk('Gear ratio (single mesh)', Ract, '-', '<= ' + GEAR_LIMITS.maxSingleRatio, true, rLevel,
            rLevel === 'warn' ? 'a ratio this high wants a double-branch or epicyclic box' : '');

        return {
            standard: std, driver: o.driver, material: mat,
            SF: SF, Kallow: Kallow, K: K,
            ratioRequired: Rreq, ratioActual: Ract, ratioOverridden: !!(o.ratioOverride > 0),
            zPinion: zp, zBull: zb,
            NoutSelected: NoutSel,
            Tin: Tin, Tpinion: Tp,
            dPinion: dp, dBull: db, centerDist: a, faceWidth: F,
            moduleTransverse: mt, moduleNormal: mn,
            helixDeg: GEAR_LIMITS.helixDeg,
            PLV: PLV, journalV: journalV,
            meshLoss_W: meshLoss, bearingLoss_W: bearingLoss,
            checks: checks
        };
    }

    /* ===================================================================== */
    /* 10. Train speeds — rated / MCS / trip per shaft                        */
    /* ===================================================================== */

    /**
     * The driver sets the speed hierarchy of the whole train. A turbine's
     * governor holds rated, its MCS is 105% of that (API 612 4.x) and the
     * overspeed trip is set at 110% of MCS; through the gear those numbers
     * arrive at the compressor multiplied by the ratio. Every rotating
     * element and the coupling must be good for the trip speed — which is
     * why the compressor tip speed is re-checked there, not at rated.
     */
    function trainSpeeds(o) {
        var drv = driverInfo(o.driverKind);
        var Nr = o.NratedDriver_rpm;
        var R = o.ratio || 1;

        var mcsD = Nr * drv.mcsFactor;
        var tripD = drv.tripFactor ? mcsD * drv.tripFactor : null;

        var res = {
            driver: { rated: Nr, mcs: mcsD, trip: tripD },
            compressor: { rated: Nr * R, mcs: mcsD * R, trip: tripD ? tripD * R : null },
            fixedSpeed: drv.fixedSpeed,
            note: drv.fixedSpeed
                ? 'A fixed-speed motor has no mechanical overspeed: MCS equals full-load speed and protection is electrical (API 541/546). The compressor still sees short over-frequency excursions only through the grid.'
                : drv.std + ': MCS = 105% of rated speed, overspeed trip = 110% of MCS (' + (drv.mcsFactor * drv.tripFactor * 100).toFixed(1) + '% of rated).',
            checks: []
        };

        if (o.compMaxSpeed_rpm && res.compressor.trip) {
            var ok = res.compressor.trip <= o.compMaxSpeed_rpm * 1.001;
            res.checks.push({
                name: 'Compressor trip speed vs mechanical limit',
                value: res.compressor.trip, unit: 'rpm',
                limit: '<= ' + Math.round(o.compMaxSpeed_rpm) + ' rpm',
                ok: ok, level: ok ? 'pass' : 'fail',
                note: ok ? '' : 'the rotor must be shown good for trip speed — raise the limit or lower the ratio'
            });
        }
        if (o.U2rated && o.u2max && res.compressor.trip) {
            var u2trip = o.U2rated * res.compressor.trip / Math.max(res.compressor.rated, 1);
            // API 617 asks integrity at trip; yield-limited tip speed carries
            // margin above the aero limit, so treat 115% of u2max as the wall.
            var okU = u2trip <= o.u2max * 1.15;
            res.checks.push({
                name: 'Tip speed at trip',
                value: u2trip, unit: 'm/s',
                limit: '<= ' + Math.round(o.u2max * 1.15) + ' m/s (115% of impeller limit)',
                ok: okU, level: okU ? 'pass' : 'warn',
                note: 'overspeed integrity check, not an operating point'
            });
        }
        return res;
    }

    /* ===================================================================== */
    /* 11. Electric motor selection                                           */
    /* ===================================================================== */

    /**
     * Poles, speeds and the standard-size rating for a fixed-speed machine.
     * Direct drive is offered when a synchronous speed lands within 2% of
     * the compressor's wanted speed — otherwise the motor turns 4-pole
     * (the standard geared arrangement: cheaper, quieter, easier rotor)
     * unless the resulting gear ratio would blow past a single mesh, in
     * which case 2-pole halves it.
     */
    function motorSelect(o) {
        var f = o.freqHz === 60 ? 60 : 50;
        var target = o.targetSpeed_rpm;
        var kind = o.kind === 'motor_sync' ? 'motor_sync' : 'motor_ind';
        var slip = kind === 'motor_ind' ? 0.01 : 0;

        var best = null;
        for (var p = 2; p <= 16; p += 2) {
            var ns = 120 * f / p;
            var d = Math.abs(ns - target) / target;
            if (!best || d < best.d) best = { poles: p, sync: ns, d: d };
        }
        var directOk = best.d <= 0.02;

        // Geared arrangement: prefer 4-pole; fall back to 2-pole when the
        // ratio a 4-pole would need exceeds a single mesh.
        var gearedPoles = 4;
        if (target / (120 * f / 4) > GEAR_LIMITS.maxSingleRatio) gearedPoles = 2;
        var gearedSync = 120 * f / gearedPoles;

        var notes = [];
        notes.push(kind === 'motor_sync'
            ? 'Synchronous machine (API 546): zero slip, power-factor control, but pulsating air-gap torque during starting — the torsional analysis (API 684) must cover it.'
            : 'Induction machine (API 541 for special purpose): ~1% slip at full load.');
        if (o.rated_W > 20e6) notes.push('Above ~20 MW a synchronous motor is the usual choice.');
        if (best.poles === 2 && o.rated_W > 15e6) notes.push('2-pole machines above ~15 MW are near the edge of standard practice.');

        return {
            kind: kind, freqHz: f,
            directDrive: {
                ok: directOk, poles: best.poles, syncSpeed: best.sync,
                fullLoadSpeed: best.sync * (1 - slip),
                speedError: best.d
            },
            geared: {
                poles: gearedPoles, syncSpeed: gearedSync,
                fullLoadSpeed: gearedSync * (1 - slip)
            },
            slip: slip,
            notes: notes
        };
    }

    /* ===================================================================== */
    /* 12. Steam turbine (API 612 screening)                                  */
    /* ===================================================================== */

    /**
     * Isentropic expansion of the pure-H2O mixture through CompEng's EOS.
     * If the ideal end state falls inside the dome the wet correction is
     * applied in EOS space (see the section-6 comment). Efficiency is a
     * size correlation — 60% at 1 MW rising to 80% at 30 MW — because at
     * screening level nothing else about the steam path is known.
     */
    function steamTurbine(o) {
        var mix = steamMix();
        var model = 'PR';
        var st1 = E.state(mix, o.Tin_K, o.Pin_Pa, model);
        var Tsat = steamTsat(o.Pexh_Pa);

        var h2s, wet = false, quality = null;
        // Saturated-vapour EOS state taken 3 K above the Antoine line: PR's
        // own water saturation curve sits a few kelvin off the real one, and
        // 3 K of margin guarantees the VAPOUR root while costing only
        // ~cp·3 K ≈ 6 kJ/kg (~1%) on the enthalpy drop. Screening trade.
        var stg = E.state(mix, Tsat + 3, o.Pexh_Pa, model);
        if (st1.sMass <= stg.sMass) {
            // Ends wet: split the entropy defect across the dome.
            wet = true;
            var hfg = steamHfg(Tsat);
            var sfg = hfg / Tsat;
            quality = 1 - (stg.sMass - st1.sMass) / sfg;
            h2s = stg.hMass - (1 - quality) * hfg;
        } else {
            var T2s = E.solveTfromS(mix, o.Pexh_Pa, st1.s, model, o.Tin_K);
            h2s = E.state(mix, T2s, o.Pexh_Pa, model).hMass;
        }

        var dhIsen = st1.hMass - h2s;                       // J/kg
        var P_MW = o.power_W / 1e6;
        var eta = Math.min(0.85, Math.max(0.50, 0.60 + 0.20 * Math.log(Math.max(P_MW, 0.1)) / Math.log(30)));
        var TSR = 3.6e6 / dhIsen;                           // kg/kWh theoretical
        var ASR = TSR / eta;                                // actual
        var mdot = o.power_W / (dhIsen * eta);              // kg/s
        var rated = o.power_W * 1.10;                       // API 612: 110% of max continuous

        var notes = [];
        if (wet && quality < 0.88) {
            notes.push('Isentropic exhaust quality ' + (quality * 100).toFixed(1) + '% — actual exhaust (with losses) will be drier, but last-stage erosion needs review below ~88%.');
        }
        if (Tsat > o.Tin_K) notes.push('Exhaust pressure is above the inlet saturation line — check the inputs.');

        return {
            Pin_Pa: o.Pin_Pa, Tin_K: o.Tin_K, Pexh_Pa: o.Pexh_Pa,
            Tsat_exh_K: Tsat,
            dhIsen: dhIsen, eta: eta,
            TSR_kg_kWh: TSR, ASR_kg_kWh: ASR,
            mdotSteam_kgs: mdot, mdotSteam_tph: mdot * 3.6,
            wetExhaust: wet, exhaustQuality: quality,
            rated_W: rated,
            condensing: o.Pexh_Pa < 0.5e5,
            notes: notes
        };
    }

    /* ===================================================================== */
    /* 13. Gas turbine (API 616 screening)                                    */
    /* ===================================================================== */

    function gasTurbine(o) {
        var fAlt = Math.exp(-(o.altitude_m || 0) / 8435);
        var tC = o.Tamb_K - 273.15;
        var fTemp = tC > 15 ? 1 - 0.006 * (tC - 15) : Math.min(1.05, 1 + 0.003 * (15 - tC));
        fTemp = Math.max(0.7, fTemp);
        var Pv = (Math.max(0, Math.min(100, o.RH_pct || 0)) / 100) * magnusPsat_Pa(o.Tamb_K);
        var Pamb = 101325 * fAlt;
        var fHum = 1 - 0.378 * Pv / Pamb;
        var fLoss = 0.98;
        var site = o.isoRating_W * fAlt * fTemp * fHum * fLoss;
        var margin = o.required_W > 0 ? site / o.required_W - 1 : null;
        return {
            isoRating_W: o.isoRating_W,
            fAlt: fAlt, fTemp: fTemp, fHum: fHum, fLoss: fLoss,
            siteRating_W: site,
            required_W: o.required_W,
            marginPct: margin != null ? margin * 100 : null,
            ok: margin == null || margin >= 0,
            note: 'Site rating = ISO × altitude × temperature × humidity × duct losses. API 616 rates the machine at site conditions with no negative tolerance; the margin shown is against the 110%-rated driver demand.'
        };
    }

    /* ===================================================================== */
    /* 14. Coupling check (API 671)                                           */
    /* ===================================================================== */

    function couplingCheck(o) {
        var T = o.power_W / rpmToRad(o.N_rpm);              // N·m
        var SF = COUPLING_SF[o.driver] || 1.5;
        var Treq = T * SF;
        var notes = [];
        if (o.driver === 'motor_ind' || o.driver === 'motor_sync') {
            notes.push('Short-circuit / starting air-gap transients of 4-6 × rated torque size the coupling and the shaft ends — an API 684 torsional analysis question, outside this screening.');
        }
        return {
            type: COUPLING_SF.types[o.type] ? o.type : 'disc',
            Tnominal: T, SF: SF, TrequiredContinuous: Treq,
            N_rpm: o.N_rpm,
            notes: notes
        };
    }

    /* ===================================================================== */
    /* 15. Train inertia and coast-down                                       */
    /* ===================================================================== */

    /**
     * Build the train's inertia ledger and reflect everything to the DRIVER
     * shaft: a high-speed element's inertia arrives multiplied by the
     * square of the speed ratio, which is why a small compressor rotor
     * behind a 4:1 increaser can outweigh the motor that drives it.
     */
    function inertiaEstimate(o) {
        var R = o.ratio || 1;
        var Jd = (o.J_driver_ovr > 0) ? o.J_driver_ovr : driverInertia(o.driverKind, o.rated_W, o.NratedDriver_rpm);
        var Jc = (o.J_comp_ovr > 0) ? o.J_comp_ovr : compressorInertia(o.train);

        var JgLS = 0, JgHS = 0;
        if (o.gear) {
            JgLS = gearWheelInertia(o.gear.dBull, o.gear.faceWidth);
            JgHS = gearWheelInertia(o.gear.dPinion, o.gear.faceWidth);
        }
        var JcoupLS = INERTIA.couplingFrac * (Jd + JgLS);
        var JcoupHS = o.gear ? INERTIA.couplingFrac * (JgHS + Jc) : 0;

        var JatDriver = Jd + JcoupLS + JgLS + (JgHS + JcoupHS + Jc) * R * R;
        return {
            J_driver: Jd, J_comp: Jc,
            J_gearLS: JgLS, J_gearHS: JgHS,
            J_couplingLS: JcoupLS, J_couplingHS: JcoupHS,
            ratio: R,
            J_atDriver: JatDriver,
            driverOverridden: o.J_driver_ovr > 0,
            compOverridden: o.J_comp_ovr > 0
        };
    }

    /**
     * Coast-down: J·dω/dt = −(T0 + c1·ω + c2·ω²).
     * The retarding torque is anchored so the three parts carry 20% / 50% /
     * 30% of the RATED loss power at rated speed — boundary friction is
     * speed-flat, an oil film drags proportionally to speed, windage with
     * its square. RK2 with a fixed step, decimated for plotting. The clock
     * stops at NminFrac (default 5%) of initial speed — below that the
     * numbers mean little and turning-gear or stand-still is next.
     */
    function coastDown(o) {
        var w0 = rpmToRad(o.N0_rpm);
        var Tl = o.lossAtRated_W / w0;                    // total retarding torque at rated
        var s = o.split || { const_: 0.2, visc: 0.5, quad: 0.3 };
        var T0 = (s.const_ != null ? s.const_ : 0.2) * Tl;
        var c1 = (s.visc != null ? s.visc : 0.5) * Tl / w0;
        var c2 = (s.quad != null ? s.quad : 0.3) * Tl / (w0 * w0);
        var J = o.J;
        var wMin = w0 * (o.NminFrac || 0.05);

        function torque(w) { return T0 + c1 * w + c2 * w * w; }

        var dt = 0.05, tMax = 7200;
        var w = w0, t = 0;
        var pts = [{ t_s: 0, N_rpm: o.N0_rpm }];
        var nextSample = 0, sampleEvery;
        // First integrate silently to estimate the duration for decimation.
        // A single pass with adaptive sampling keeps it simple instead:
        sampleEvery = 1;   // record every ~1 s; trimmed after
        while (w > wMin && t < tMax) {
            var k1 = -torque(w) / J;
            var k2 = -torque(Math.max(w + k1 * dt, 0)) / J;
            w = Math.max(w + 0.5 * (k1 + k2) * dt, 0);
            t += dt;
            if (t >= nextSample) {
                pts.push({ t_s: t, N_rpm: w * 30 / PI });
                nextSample += sampleEvery;
            }
            if (w <= 0) break;
        }
        pts.push({ t_s: t, N_rpm: w * 30 / PI });
        // Decimate to ≤ 240 points for the chart and the PDF.
        if (pts.length > 240) {
            var step = Math.ceil(pts.length / 240), dec = [];
            for (var i = 0; i < pts.length; i += step) dec.push(pts[i]);
            if (dec[dec.length - 1].t_s !== t) dec.push(pts[pts.length - 1]);
            pts = dec;
        }
        return { points: pts, time_s: t, T0: T0, c1: c1, c2: c2, J: J, N0_rpm: o.N0_rpm, NminFrac: o.NminFrac || 0.05 };
    }

    /* ===================================================================== */
    /* 16. Lube oil system (API 614)                                          */
    /* ===================================================================== */

    function lubeSystem(o) {
        var dT = o.dT_K || LUBE.dT_K;
        var elems = [];
        (o.elements || []).forEach(function (el) {
            if (!(el.loss_W > 0)) return;
            elems.push({
                name: el.name,
                loss_W: el.loss_W,
                flow_m3s: el.loss_W / (LUBE.rho * LUBE.cp * dT),
                bearing: el.bearing !== false
            });
        });
        var totalLoss = elems.reduce(function (a, e) { return a + e.loss_W; }, 0);
        var totalFlow = elems.reduce(function (a, e) { return a + e.flow_m3s; }, 0);
        var bearingFlow = elems.filter(function (e) { return e.bearing; })
                               .reduce(function (a, e) { return a + e.flow_m3s; }, 0);

        var retention = (o.retention_min || LUBE.retention_min) * 60;
        var working = totalFlow * retention;
        var charge = totalFlow * LUBE.charge_min * 60;
        var reservoir = (working + charge) * LUBE.freeboard;

        var pumpFlow = totalFlow * LUBE.pumpMargin;
        var accOil = totalFlow * LUBE.accBridge_s;

        var rundown = null;
        if (o.coastdown_s > 0) {
            rundown = {
                V_m3: bearingFlow * o.coastdown_s * LUBE.rundownMargin,
                elevation_m: LUBE.rundownHeader_Pa * LUBE.lineLoss / (LUBE.rho * G),
                basis: 'bearing oil flow × ' + Math.round(o.coastdown_s) + ' s coast-down × ' + LUBE.rundownMargin +
                       '; elevation for ' + (LUBE.rundownHeader_Pa / 1e5).toFixed(1) + ' barg at the bearings + ' +
                       Math.round((LUBE.lineLoss - 1) * 100) + '% line loss'
            };
        }

        return {
            dT_K: dT,
            elements: elems,
            totalLoss_W: totalLoss,
            totalFlow_m3s: totalFlow,
            bearingFlow_m3s: bearingFlow,
            pump: { main_m3s: pumpFlow, aux_m3s: pumpFlow, note: 'main + 100% standby (aux), each ' + Math.round((LUBE.pumpMargin - 1) * 100) + '% over normal flow' },
            reservoir: { working_m3: working, charge_m3: charge, gross_m3: reservoir, retention_min: retention / 60 },
            coolerDuty_W: totalLoss,
            filter: { flow_m3s: pumpFlow, micron: LUBE.filterMicron },
            accumulator: { displaced_m3: accOil, vessel_m3: accOil * LUBE.accVesselFactor, bridge_s: LUBE.accBridge_s },
            rundownTank: rundown
        };
    }

    /* ===================================================================== */
    /* 17. Settle-out pressure                                                */
    /* ===================================================================== */

    /**
     * When the unit trips and block valves close, suction and discharge
     * volumes equalise. The simple volume-weighted answer ignores that the
     * discharge side holds MORE moles per m³ (higher P) but is HOTTER and
     * less ideal; the corrected answer balances moles with Z and T from the
     * EOS and lands a few percent away for real gases. Both are reported —
     * the difference is itself useful information.
     */
    function settleOut(o) {
        var Ps = o.Ps_Pa, Pd = o.Pd_Pa, Vs = o.Vs_m3, Vd = o.Vd_m3;
        var Psimple = (Vs * Ps + Vd * Pd) / (Vs + Vd);

        var ss = E.state(o.mix, o.Ts_K, Ps, o.model);
        var sd = E.state(o.mix, o.Td_K, Pd, o.model);
        var ms = ss.rho * Vs, md = sd.rho * Vd;              // kg
        var Tso = (ms * o.Ts_K + md * o.Td_K) / (ms + md);   // mass-weighted mix temp
        var nTot = ms / o.mix.M + md / o.mix.M;              // mol

        // P = n·Z·R·T/V with Z itself a function of P — two fixed-point
        // passes are plenty at these conditions.
        var P = Psimple;
        for (var i = 0; i < 3; i++) {
            var Z = E.state(o.mix, Tso, P, o.model).Z;
            P = nTot * Z * E.R * Tso / (Vs + Vd);
        }
        return {
            P_simple_Pa: Psimple,
            P_corrected_Pa: P,
            T_settle_K: Tso,
            m_suction_kg: ms, m_discharge_kg: md,
            note: 'Suction/discharge system volumes are user inputs — piping, coolers and vessels between the block valves. The corrected value balances moles with EOS Z and mass-weighted temperature.'
        };
    }

    /* ===================================================================== */
    /* 18. Dry gas seal system (API 692)                                      */
    /* ===================================================================== */

    function dgsSystem(o) {
        var D_mm = Math.min(350, Math.max(60, Math.ceil((o.shaftDia_m * 1000 + DGS.sleeveAdd_mm) / 10) * 10));
        var Pseal_bara = Math.max(o.settleOutP_Pa, o.Ps_Pa) / 1e5;

        // H2S anywhere in the composition pushes the arrangement to a
        // tandem with intermediate labyrinth so the secondary vent stays
        // sweet and the secondary seal sees only nitrogen-buffered gas.
        var sour = (o.mix.comps || []).some(function (c, i) { return c.id === 'H2S' && o.mix.y[i] > 1e-6; });
        var arrangement = sour ? 'Tandem with intermediate labyrinth' : 'Tandem';

        var qPrim = DGS.leakC * D_mm * Pseal_bara;           // Nm3/h per seal
        var qSec = qPrim * DGS.secondaryFrac;
        var nSeals = o.nEnds || 2;

        // Seal gas supply from labyrinth velocity: annulus area × 5 m/s at
        // seal-gas conditions, expressed in normal m³/h through the density
        // ratio (EOS density at supply vs normal conditions).
        var A = PI * (D_mm / 1000) * DGS.labyClearance;      // m2
        var Tsup = o.T_K || 313.15;
        var rhoSup = E.state(o.mix, Tsup, Math.max(o.settleOutP_Pa, o.Ps_Pa), o.model).rho;
        var rhoN = E.state(o.mix, 288.15, 101325, o.model).rho;
        var qSupply = DGS.labyVel * A * 3600 * rhoSup / rhoN; // Nm3/h per seal

        var faceV_mcs = o.mcs_rpm ? PI * (D_mm / 1000) * o.mcs_rpm / 60 : null;
        var faceV_trip = o.trip_rpm ? PI * (D_mm / 1000) * o.trip_rpm / 60 : null;

        var checks = [];
        if (faceV_mcs != null) {
            var lv = faceV_mcs <= DGS.faceSpeedWarn ? 'pass' : (faceV_mcs <= DGS.faceSpeedMax ? 'warn' : 'fail');
            checks.push({
                name: 'Seal face speed at MCS', value: faceV_mcs, unit: 'm/s',
                limit: '<= ' + DGS.faceSpeedMax + ' m/s', ok: lv !== 'fail', level: lv,
                note: lv === 'pass' ? '' : 'approaching / beyond common vendor experience — confirm with the seal OEM'
            });
        }

        // ---- API 692 testing block ------------------------------------
        // Machine-specific FAT criteria and the customary test sequence.
        // The binding acceptance values are the vendor's curve approved
        // against API 692 Part 3 — the numbers below are this tool's
        // screening estimates dropped into that frame.
        var acceptLeak = qPrim * 2;                          // acceptance ceiling ≈ 2× expected
        var testing = {
            criteria: [
                { item: 'Static test pressure', value: Pseal_bara, unit: 'bara', basis: 'maximum static sealing pressure (settle-out or suction, whichever governs)' },
                { item: 'Dynamic test pressure', value: Pseal_bara, unit: 'bara', basis: 'normal/settle-out sealing pressure' },
                { item: 'Dynamic test speed', value: o.mcs_rpm || null, unit: 'rpm', basis: 'maximum continuous speed' },
                { item: 'Overspeed excursion', value: o.trip_rpm || null, unit: 'rpm', basis: 'trip speed (turbine-driven trains only)' },
                { item: 'Expected primary leakage', value: qPrim, unit: 'Nm³/h per seal', basis: 'screening correlation — vendor curve governs' },
                { item: 'Leakage acceptance ceiling', value: acceptLeak, unit: 'Nm³/h per seal', basis: '≈ 2 × expected; the approved vendor curve is the contractual limit' }
            ],
            steps: [
                { step: 1, name: 'Low-pressure static check', detail: 'Pressurise to ~2 barg with test gas; confirm assembly integrity and instrumentation before committing to full pressure.' },
                { step: 2, name: 'Static test at maximum sealing pressure', detail: 'Hold at ' + Pseal_bara.toFixed(1) + ' bara (zero speed); record primary and secondary vent leakage against the static acceptance line.' },
                { step: 3, name: 'Slow-roll dynamic', detail: 'Run at 10–20% of MCS at normal sealing pressure; verify lift-off and stable vent flows.' },
                { step: 4, name: 'Dynamic test at MCS', detail: 'Hold ' + (o.mcs_rpm ? Math.round(o.mcs_rpm) + ' rpm' : 'MCS') + ' at ' + Pseal_bara.toFixed(1) + ' bara for the contractual duration (typically ≥ 4 h); log leakage trend — it must be stable and below the acceptance curve.' },
                { step: 5, name: 'Overspeed excursion', detail: o.trip_rpm ? 'Short excursion to trip speed, ' + Math.round(o.trip_rpm) + ' rpm, hold ~1 min; confirm leakage recovers.' : 'Not applicable — fixed-speed motor drive has no overspeed trip.' },
                { step: 6, name: 'Transient cycling', detail: 'Repeated start/stop and pressurisation/depressurisation cycles (typically 5) between static and dynamic conditions; leakage must return to its baseline after each cycle.' },
                { step: 7, name: 'Post-test static & inspection', detail: 'Repeat step 2, then strip and inspect: face condition, groove wear, O-ring extrusion per API 692 acceptance criteria.' }
            ],
            note: 'Sequence per customary API 692 Part 3 factory acceptance testing. The purchased edition and the seal OEM’s approved procedure define the binding hold times and acceptance values.'
        };

        return {
            sealSize_mm: D_mm,
            arrangement: arrangement, sour: sour,
            sealingPressure_bara: Pseal_bara,
            nSeals: nSeals,
            perSeal: { primaryLeak_Nm3h: qPrim, secondaryLeak_Nm3h: qSec, supply_Nm3h: qSupply, separation_Nm3h: DGS.sepGasPerSeal },
            machine: {
                primaryVentDesign_Nm3h: qPrim * DGS.ventDesignFactor * nSeals,
                supply_Nm3h: qSupply * nSeals,
                separation_Nm3h: DGS.sepGasPerSeal * nSeals
            },
            faceSpeedMCS: faceV_mcs, faceSpeedTrip: faceV_trip,
            checks: checks,
            testing: testing
        };
    }

    /* ===================================================================== */
    /* 19. Orchestrator — the whole accessory train in one call               */
    /* ===================================================================== */

    /**
     * runAccessories({train, input, cfg}) — train is CompEng.runTrain()'s
     * result, input is the opts object it was called with, cfg is the
     * page's train-configuration block. Returns every accessory result
     * plus a rolled-up checks[] list for the report's validation table.
     *
     * The gear's tooth-count-snapped output speed comes back in
     * `speedFeedback`; the page re-solves the compressor at that speed
     * (a second runTrain with speedManual) and calls this again on the
     * final train — a single deterministic second pass, no iteration.
     */
    function runAccessories(o) {
        var train = o.train, inp = o.input, cfg = o.cfg || {};
        var drvKind = DRIVERS[cfg.driver] ? cfg.driver : 'motor_ind';
        var drv = driverInfo(drvKind);
        var igc = !!(train.architecture && train.architecture.geared);
        var Ncomp = train.speedRange.hi;

        // ---- driver power chain (unchanged from the Results tab) --------
        var gearboxWanted = cfg.gearbox || 'auto';
        var needGearAuto = !igc && (train.frame.gearRequired || false);

        // ---- motor pre-selection to settle the driver shaft speed -------
        // An integrally geared machine couples the driver to the BULL GEAR,
        // not to a pinion, so its target shaft speed is the bull speed the
        // user chose and the external-gearbox question never arises.
        var targetShaft = igc ? (inp.bullGearSpeed || 1800) : Ncomp;
        var motor = null, Ndriver, directDrive = false;
        if (drvKind === 'motor_ind' || drvKind === 'motor_sync') {
            motor = motorSelect({ rated_W: train.shaftPower * 1.15, freqHz: cfg.freqHz, kind: drvKind, targetSpeed_rpm: targetShaft });
            if (igc || gearboxWanted === 'none' || (gearboxWanted === 'auto' && motor.directDrive.ok && !needGearAuto)) {
                directDrive = true;
                Ndriver = motor.directDrive.fullLoadSpeed;
            } else {
                Ndriver = motor.geared.fullLoadSpeed;
            }
        } else {
            // Turbines: rated speed is an input; absent that, a variable-
            // speed turbine direct-drives at the compressor's speed.
            if (cfg.driverSpeed_rpm > 0) {
                Ndriver = cfg.driverSpeed_rpm;
                directDrive = igc || gearboxWanted === 'none' ||
                    (gearboxWanted === 'auto' && Math.abs(Ndriver - targetShaft) / targetShaft <= 0.02);
            } else {
                Ndriver = targetShaft;
                directDrive = igc || (gearboxWanted !== 'api613' && gearboxWanted !== 'api677');
            }
        }
        var hasGear = !igc && !directDrive && gearboxWanted !== 'none';

        // ---- gearbox ----------------------------------------------------
        var gear = null, ratio = 1, NcompSelected = Ncomp;
        if (hasGear) {
            gear = gearRating({
                powerAtGear_W: train.shaftPower,
                Nin_rpm: Ndriver, Nout_rpm: Ncomp,
                driver: drvKind,
                standard: (gearboxWanted === 'api677') ? 'api677' : 'api613',
                material: cfg.gearMaterial,
                faceRatio: cfg.faceRatio,
                ratioOverride: cfg.gearRatio > 0 ? cfg.gearRatio : 0
            });
            ratio = gear.ratioActual;
            NcompSelected = gear.NoutSelected;
        } else if (directDrive) {
            NcompSelected = Ndriver;
        }

        // ---- driver rating (loss chain identical to the Results tab) ----
        var rating = E.driverRating(train.shaftPower, {
            gearbox: hasGear,
            pinions: igc && train.pinions ? train.pinions.length : 0,
            margin: cfg.margin
        });

        // ---- driver detail ----------------------------------------------
        var driver = { kind: drvKind, label: drv.label, std: drv.std, rating: rating, motor: motor };
        if (drvKind === 'steam' && cfg.steam) {
            driver.steam = steamTurbine({
                Pin_Pa: cfg.steam.Pin_Pa, Tin_K: cfg.steam.Tin_K, Pexh_Pa: cfg.steam.Pexh_Pa,
                power_W: rating.atDriver
            });
        }
        if (drvKind === 'gasturbine' && cfg.gt) {
            driver.gt = gasTurbine({
                isoRating_W: cfg.gt.iso_W, altitude_m: cfg.gt.altitude_m,
                Tamb_K: cfg.gt.Tamb_K, RH_pct: cfg.gt.RH_pct,
                required_W: rating.rated
            });
        }

        // ---- speeds -------------------------------------------------------
        var firstStage = train.sections[0].stages[0];
        var speeds = trainSpeeds({
            driverKind: drvKind,
            NratedDriver_rpm: igc ? (inp.bullGearSpeed || Ndriver) : Ndriver,
            ratio: igc ? 1 : (hasGear ? ratio : 1),
            compMaxSpeed_rpm: inp.maxSpeed || (inp.limits && inp.limits.maxSpeed),
            U2rated: firstStage.U2,
            u2max: (inp.impeller && inp.impeller.u2max) || null
        });
        if (igc) {
            speeds.note += ' Integrally geared machine: the table shows the bull-gear shaft; each pinion scales by its own ratio (see the Gearbox tab).';
            // Pinion trip speeds inherit the driver's factors through the mesh.
            speeds.compressor = {
                rated: Ncomp,
                mcs: Ncomp * drv.mcsFactor,
                trip: drv.tripFactor ? Ncomp * drv.mcsFactor * drv.tripFactor : null
            };
        }

        // ---- couplings ----------------------------------------------------
        var coupling = {
            ls: couplingCheck({ power_W: rating.atDriver, N_rpm: Ndriver, driver: drvKind, type: cfg.coupling }),
            hs: hasGear ? couplingCheck({ power_W: train.shaftPower, N_rpm: NcompSelected, driver: drvKind, type: cfg.coupling }) : null
        };

        // ---- inertia + coast-down -----------------------------------------
        var inertia = inertiaEstimate({
            train: train, driverKind: drvKind,
            rated_W: rating.rated, NratedDriver_rpm: Ndriver,
            ratio: hasGear ? ratio : 1,
            gear: gear,
            J_driver_ovr: cfg.overrides && cfg.overrides.J_driver,
            J_comp_ovr: cfg.overrides && cfg.overrides.J_comp
        });

        // The retarding loss at rated speed: compressor mechanical loss +
        // gear mesh/bearings + driver bearing allowance. Aerodynamic braking
        // by the process gas is deliberately EXCLUDED — it makes coast-down
        // shorter, so ignoring it is conservative for rundown-tank sizing.
        var compMechLoss = Math.max(train.shaftPower - train.gasPower, 0.005 * train.shaftPower);
        var drvBearingLoss = rating.rated * (drv.fixedSpeed ? LUBE.motorBearingFrac : LUBE.turbineBearingFrac);
        var gearLossW = gear ? (gear.meshLoss_W + gear.bearingLoss_W)
                      : (igc ? train.shaftPower * E.IGC_LIMITS.meshLoss * (train.pinions ? train.pinions.length : 1) : 0);
        var lossAtRated = compMechLoss + drvBearingLoss + gearLossW;

        var coast = coastDown({
            J: inertia.J_atDriver,
            N0_rpm: igc ? (inp.bullGearSpeed || Ndriver) : Ndriver,
            lossAtRated_W: lossAtRated,
            NminFrac: (cfg.overrides && cfg.overrides.coastMinFrac) || 0.05
        });

        // ---- lube oil ------------------------------------------------------
        var lubeElems = [
            { name: 'Compressor bearings (mech loss)', loss_W: compMechLoss, bearing: true },
            { name: drv.label + ' bearings', loss_W: drvBearingLoss, bearing: true }
        ];
        if (gear) {
            lubeElems.push({ name: 'Gear mesh (sprayed)', loss_W: gear.meshLoss_W, bearing: false });
            lubeElems.push({ name: 'Gearbox bearings', loss_W: gear.bearingLoss_W, bearing: true });
        } else if (igc) {
            lubeElems.push({ name: 'Integral gear meshes + bearings', loss_W: gearLossW, bearing: true });
        }
        var lube = lubeSystem({
            elements: lubeElems,
            dT_K: cfg.lube && cfg.lube.dT_K,
            retention_min: cfg.lube && cfg.lube.retention_min,
            coastdown_s: coast.time_s
        });

        // ---- settle-out + seals --------------------------------------------
        var seal = null, settle = null;
        if (cfg.seal !== 'none') {
            var lastSec = train.sections[train.sections.length - 1];
            settle = settleOut({
                mix: inp.mix, model: inp.model,
                Ts_K: inp.T1, Ps_Pa: inp.P1,
                Td_K: lastSec.T2, Pd_Pa: lastSec.P2,
                Vs_m3: (cfg.volumes && cfg.volumes.Vs_m3) || 10,
                Vd_m3: (cfg.volumes && cfg.volumes.Vd_m3) || 5
            });
            var shaftDia = train.rotor ? train.rotor.shaftDia : 0.30 * firstStage.D2;
            seal = dgsSystem({
                mix: inp.mix, model: inp.model,
                settleOutP_Pa: settle.P_corrected_Pa,
                Ps_Pa: inp.P1, T_K: inp.T1,
                shaftDia_m: shaftDia,
                nEnds: igc ? 2 * (train.pinions ? train.pinions.length : 1) : 2,
                mcs_rpm: speeds.compressor.mcs,
                trip_rpm: speeds.compressor.trip
            });
            if (igc) {
                seal.note = 'Integrally geared machine: one seal per shaft end per pinion assumed for the flow roll-up; many IGC frames use simpler carbon-ring or labyrinth seals on low-pressure stages — confirm the arrangement per pinion with the OEM.';
            }
        }

        // ---- rolled-up validation list --------------------------------------
        var checks = [];
        function add(list) { if (list && list.length) checks = checks.concat(list); }
        if (gear) add(gear.checks);
        add(speeds.checks);
        if (seal) add(seal.checks);
        if (driver.gt) {
            checks.push({
                name: 'Gas turbine site rating vs required', value: driver.gt.siteRating_W / 1e3, unit: 'kW',
                limit: '>= ' + (driver.gt.required_W / 1e3).toFixed(0) + ' kW',
                ok: driver.gt.ok, level: driver.gt.ok ? 'pass' : 'fail',
                note: driver.gt.marginPct != null ? 'margin ' + driver.gt.marginPct.toFixed(1) + '%' : ''
            });
        }
        if (driver.steam && driver.steam.wetExhaust && driver.steam.exhaustQuality < 0.88) {
            checks.push({
                name: 'Steam exhaust quality (isentropic)', value: driver.steam.exhaustQuality * 100, unit: '%',
                limit: '>= 88 % (erosion screening)', ok: false, level: 'warn',
                note: 'actual exhaust is drier than isentropic; review last-stage erosion'
            });
        }

        return {
            driver: driver,
            gear: gear,
            igc: igc,
            directDrive: directDrive,
            hasGear: hasGear,
            Ndriver_rpm: Ndriver,
            speeds: speeds,
            coupling: coupling,
            inertia: inertia,
            coastdown: coast,
            lossAtRated_W: lossAtRated,
            lube: lube,
            settleOut: settle,
            seal: seal,
            checks: checks,
            speedFeedback: {
                // The page's second pass drives the compressor at this speed.
                // Never for an IGC machine: there the user's bull-gear speed
                // is already the fixed input and each pinion has its own.
                apply: !igc && (hasGear || (directDrive && drv.fixedSpeed)),
                N_rpm: NcompSelected,
                reason: hasGear
                    ? 'gear tooth counts ' + (gear ? gear.zBull + '/' + gear.zPinion : '') + ' set the output speed'
                    : (directDrive && drv.fixedSpeed ? 'fixed-speed motor direct drive' : '')
            }
        };
    }

    /* ===================================================================== */
    /* 20. Self test                                                          */
    /* ===================================================================== */

    function selfTest() {
        var out = [];
        function check(name, value, expected, tol, note) {
            var pass = isFinite(value) && Math.abs(value - expected) <= tol;
            out.push({ name: name, value: value, expected: expected, tolerance: tol, pass: pass, note: note || '' });
        }

        // Coupling torque: 1000 kW at 1500 rpm -> 6366 N·m.
        var c = couplingCheck({ power_W: 1e6, N_rpm: 1500, driver: 'motor_ind', type: 'disc' });
        check('Coupling nominal torque 1 MW @ 1500 rpm [N·m]', c.Tnominal, 6366, 5);

        // PLV: 0.4 m pinion at 10 000 rpm -> 209.4 m/s.
        check('Pitch line velocity 0.4 m @ 10 krpm [m/s]', PI * 0.4 * 10000 / 60, 209.44, 0.05);

        // Gear sizing closure: sized at K_allow with SF, re-evaluated K×SF
        // must return the material index.
        var g = gearRating({ powerAtGear_W: 8e6, Nin_rpm: 1493, Nout_rpm: 9500, driver: 'motor_ind', standard: 'api613', material: 'carburised' });
        // ratioActual differs from required after the tooth snap, so close
        // the loop at the SELECTED ratio: K·SF/(index) ~ (Rreq/Ract drift only).
        check('Gear K closure: K×SF / material index', g.K * g.SF / (GEAR_MATERIALS.carburised.index_MPa * 1e6), 1.0, 0.03,
            'small drift from tooth-count snap is expected');
        check('Gear ratio snap error [%]', Math.abs(g.ratioActual - g.ratioRequired) / g.ratioRequired * 100, 0, 2.0,
            'z=' + g.zBull + '/' + g.zPinion);
        check('Gear output speed = Nin × Ractual [rpm]', g.NoutSelected, 1493 * g.ratioActual, 0.01);

        // Motor synchronous speeds.
        var m50 = motorSelect({ rated_W: 5e6, freqHz: 50, kind: 'motor_ind', targetSpeed_rpm: 3000 });
        check('Sync speed 50 Hz 2-pole [rpm]', m50.directDrive.syncSpeed, 3000, 0.01);
        var m60 = motorSelect({ rated_W: 2e6, freqHz: 60, kind: 'motor_ind', targetSpeed_rpm: 1800 });
        check('Sync speed 60 Hz 4-pole [rpm]', m60.directDrive.syncSpeed, 1800, 0.01);

        // MCS / trip per API 612.
        var sp = trainSpeeds({ driverKind: 'steam', NratedDriver_rpm: 10000, ratio: 1 });
        check('API 612 MCS at 10 000 rpm rated [rpm]', sp.driver.mcs, 10500, 0.5);
        check('API 612 trip at 10 000 rpm rated [rpm]', sp.driver.trip, 11550, 0.5);

        // Steam: 40 bara / 400 degC -> 3.5 bara. Steam tables: dh_isen ~ 552 kJ/kg.
        var stm = steamTurbine({ Pin_Pa: 40e5, Tin_K: 673.15, Pexh_Pa: 3.5e5, power_W: 10e6 });
        check('Steam dh_isen 40 bara/400C -> 3.5 bara [kJ/kg]', stm.dhIsen / 1000, 552, 28, 'steam tables 552.1; EOS+correlation within 5%');
        check('TSR × dh consistency [kg·kJ/kWh/kg]', stm.TSR_kg_kWh * stm.dhIsen / 1000, 3600, 1);
        check('Tsat(3.5 bara) [K]', steamTsat(3.5e5), 411.9, 1.5, 'steam tables 138.9 C');

        // GT derating at 1500 m / 30 C / 80% RH.
        var gt = gasTurbine({ isoRating_W: 30e6, altitude_m: 1500, Tamb_K: 303.15, RH_pct: 80, required_W: 20e6 });
        check('GT altitude factor at 1500 m', gt.fAlt, Math.exp(-1500 / 8435), 1e-9);
        check('GT temperature factor at 30 C', gt.fTemp, 0.91, 1e-6);
        var humOk = gt.fHum < 1 && gt.fHum > 0.97;
        out.push({ name: 'GT humidity factor small but < 1', value: gt.fHum, expected: 0.99, tolerance: 0.02, pass: humOk, note: '' });

        // Coast-down vs the closed form for a purely viscous brake:
        // J dw/dt = -c w  =>  t(5%) = (J/c) ln 20.
        var J = 500, w0 = rpmToRad(3000), Ploss = 200e3;
        var cvisc = Ploss / (w0 * w0);
        var cd = coastDown({ J: J, N0_rpm: 3000, lossAtRated_W: Ploss, split: { const_: 0, visc: 1, quad: 0 }, NminFrac: 0.05 });
        check('Coast-down viscous vs closed form [s]', cd.time_s, (J / cvisc) * Math.log(20), (J / cvisc) * Math.log(20) * 0.01);

        // Energy balance on the default split: integral of T·w dt = 1/2 J (w0^2 - w_end^2).
        var cd2 = coastDown({ J: J, N0_rpm: 3000, lossAtRated_W: Ploss, NminFrac: 0.05 });
        var eDiss = 0;
        for (var i = 1; i < cd2.points.length; i++) {
            var wA = rpmToRad(cd2.points[i - 1].N_rpm), wB = rpmToRad(cd2.points[i].N_rpm);
            var wM = 0.5 * (wA + wB);
            var Tq = cd2.T0 + cd2.c1 * wM + cd2.c2 * wM * wM;
            eDiss += Tq * wM * (cd2.points[i].t_s - cd2.points[i - 1].t_s);
        }
        var wEnd = rpmToRad(cd2.points[cd2.points.length - 1].N_rpm);
        var eKin = 0.5 * J * (w0 * w0 - wEnd * wEnd);
        check('Coast-down energy balance [ratio]', eDiss / eKin, 1.0, 0.02, 'decimated-trace integral, 2% tolerance');

        // Monotonicity: doubling J lengthens the coast-down.
        var cd3 = coastDown({ J: 2 * J, N0_rpm: 3000, lossAtRated_W: Ploss, NminFrac: 0.05 });
        out.push({ name: 'Coast-down monotonic in J', value: cd3.time_s, expected: cd2.time_s * 2, tolerance: cd2.time_s, pass: cd3.time_s > cd2.time_s * 1.5, note: '2x inertia ~ 2x time' });

        // Oil flow: 100 kW at dT 20 K -> 178.9 L/min.
        var lu = lubeSystem({ elements: [{ name: 'x', loss_W: 100e3, bearing: true }], dT_K: 20, coastdown_s: 300 });
        check('Oil flow 100 kW @ 20 K [L/min]', lu.totalFlow_m3s * 60000, 178.9, 1);
        check('Reservoir working volume = 8 min retention [m3]', lu.reservoir.working_m3, lu.totalFlow_m3s * 480, 1e-9);
        check('Rundown tank = flow x coastdown x 1.2 [m3]', lu.rundownTank.V_m3, lu.bearingFlow_m3s * 300 * 1.2, 1e-9);

        // Settle-out: near-ideal N2, equal volumes, 1 & 3 bara -> ~2 bara.
        var n2 = E.makeMixture([{ id: 'N2', molPct: 100 }]);
        var so = settleOut({ mix: n2, model: 'PR', Ts_K: 300, Ps_Pa: 1e5, Td_K: 300, Pd_Pa: 3e5, Vs_m3: 5, Vd_m3: 5 });
        check('Settle-out simple, equal volumes [bara]', so.P_simple_Pa / 1e5, 2.0, 1e-9);
        check('Settle-out corrected near-ideal [bara]', so.P_corrected_Pa / 1e5, 2.0, 0.02);

        // Inertia anchors for the motor correlation.
        check('Motor inertia anchor 10 MW 2-pole [kg·m2]', driverInertia('motor_ind', 10e6, 3000), 280, 15);
        check('Motor inertia anchor 1 MW 4-pole [kg·m2]', driverInertia('motor_ind', 1e6, 1500), 30, 3);

        // DGS: leakage anchor and testing block wiring.
        var dgs = dgsSystem({
            mix: n2, model: 'PR', settleOutP_Pa: 100e5, Ps_Pa: 20e5, T_K: 313,
            shaftDia_m: 0.055, nEnds: 2, mcs_rpm: 10500, trip_rpm: 11550
        });
        check('DGS primary leakage anchor 80 mm @ 100 bara [Nm3/h]', dgs.perSeal.primaryLeak_Nm3h, 4e-4 * dgs.sealSize_mm * 100, 1e-9);
        out.push({
            name: 'DGS dynamic test speed = MCS', value: dgs.testing.criteria[2].value, expected: 10500, tolerance: 0.5,
            pass: dgs.testing.criteria[2].value === 10500, note: ''
        });
        out.push({
            name: 'DGS static test pressure >= settle-out', value: dgs.sealingPressure_bara, expected: 100, tolerance: 0.5,
            pass: dgs.sealingPressure_bara >= 100 - 1e-9, note: ''
        });

        return out;
    }

    /* ===================================================================== */
    /* Exports                                                                */
    /* ===================================================================== */

    global.TrainEng = {
        DRIVERS: DRIVERS,
        GEAR_MATERIALS: GEAR_MATERIALS,
        GEAR_LIMITS: GEAR_LIMITS,
        INERTIA: INERTIA,
        LUBE: LUBE,
        COUPLING_SF: COUPLING_SF,
        DGS: DGS,

        driverInfo: driverInfo,
        gearRating: gearRating,
        trainSpeeds: trainSpeeds,
        motorSelect: motorSelect,
        steamTurbine: steamTurbine,
        steamTsat: steamTsat,
        gasTurbine: gasTurbine,
        couplingCheck: couplingCheck,
        driverInertia: driverInertia,
        compressorInertia: compressorInertia,
        inertiaEstimate: inertiaEstimate,
        coastDown: coastDown,
        lubeSystem: lubeSystem,
        settleOut: settleOut,
        dgsSystem: dgsSystem,
        runAccessories: runAccessories,

        selfTest: selfTest
    };

})(typeof window !== 'undefined' ? window : globalThis);
