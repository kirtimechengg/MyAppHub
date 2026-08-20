/*
 * lateral-criteria.js
 * -------------------------------------------------------------------------
 * Pure calculation engine for the Train Lateral Rotordynamics Review tool
 * (lva_tool.html). No DOM access, no Firebase — every function is a plain
 * number-in / result-object-out helper so it can be unit-tested by hand in
 * a console and reused by any future tool.
 *
 * Internal math is SI throughout (mm, kg, N, rpm, kW, um, g.mm). Each
 * public function also returns the US customary equivalent so a reviewer
 * can cross-check a vendor report written in either system.
 *
 * References: API 617 8th Edition (2014), Part 1; API 684 2nd Edition
 * (2005); API 613 5th Edition. Where a specific clause number is genuinely
 * uncertain, the basis string says so instead of inventing one — verify
 * against the current edition text before using a result in a real report.
 * -------------------------------------------------------------------------
 */
window.LatEng = (function () {
    "use strict";

    // ---- unit conversion constants ----------------------------------------
    const UM_PER_MIL = 25.4;                 // 1 mil = 25.4 um
    const GMM_PER_OZIN = 25.4 * 28.349523125; // 1 oz.in = 25.4mm * 28.3495g = 719.878 g.mm
    const KG_PER_LB = 0.45359237;
    const NMM_PER_LBFIN = 0.1751268;          // 1 lbf/in = 0.1751268 N/mm

    const umToMils = (um) => um / UM_PER_MIL;
    const gmmToOzin = (gmm) => gmm / GMM_PER_OZIN;
    const kgToLb = (kg) => kg / KG_PER_LB;
    const lbToKg = (lb) => lb * KG_PER_LB;
    const NmmToLbfin = (v) => v / NMM_PER_LBFIN;

    // ---- small helper to keep every function's return shape consistent ----
    function mk({ value, unit, us, usUnit, pass = null, basis, extra = {} }) {
        return { value, unit, us, usUnit, pass, basis, ...extra };
    }

    /**
     * Amplification Factor (AF) from the half-power-point method.
     * Nc = peak (critical) response speed; N1, N2 = speeds bracketing the
     * peak where response amplitude falls to 1/sqrt(2) of the peak value
     * (N1 < Nc < N2).
     * API 617 8th Ed 6.8.2.4.
     */
    function amplificationFactor(Nc, N1, N2) {
        if (!(N2 > N1) || !(Nc > 0)) return null;
        const AF = Nc / (N2 - N1);
        return mk({
            value: AF, unit: "-", us: AF, usUnit: "-",
            basis: "AF = Nc / (N2 - N1), half-power points (API 617 8th Ed 6.8.2.4)"
        });
    }

    /**
     * Required separation margin (%) for a given amplification factor and
     * the position of the critical speed relative to the operating range.
     * position: 'below' (critical speed below minimum operating speed) or
     *           'above' (critical speed above trip speed).
     * API 617 8th Ed 6.8.2.5.
     */
    function requiredSM(AF, position) {
        if (AF == null || !(AF > 0)) return null;
        if (AF < 2.5) {
            return mk({
                value: 0, unit: "%", us: 0, usUnit: "%",
                basis: "AF < 2.5: response is not sharply resonant (critically damped); " +
                    "no separation margin is required (API 617 8th Ed 6.8.2.5)"
            });
        }
        const raw = 17 * (1 - 1 / (AF - 1.5));
        if (position === "above") {
            const val = Math.min(10 + raw, 26);
            return mk({
                value: val, unit: "%", us: val, usUnit: "%",
                basis: "SM = 10 + 17[1 - 1/(AF-1.5)], capped at 26% " +
                    "— critical speed above trip speed (API 617 8th Ed 6.8.2.5)"
            });
        }
        const val = Math.min(raw, 16);
        return mk({
            value: val, unit: "%", us: val, usUnit: "%",
            basis: "SM = 17[1 - 1/(AF-1.5)], capped at 16% " +
                "— critical speed below minimum operating speed (API 617 8th Ed 6.8.2.5)"
        });
    }

    /**
     * Actual separation margin (%) achieved between a critical speed Nc and
     * the relevant reference speed (minimum continuous speed for 'below',
     * trip speed for 'above').
     */
    function actualSM(Nc, Nref, position) {
        if (!(Nc > 0) || !(Nref > 0)) return null;
        const val = position === "above"
            ? (Nc - Nref) / Nref * 100
            : (Nref - Nc) / Nref * 100;
        return mk({
            value: val, unit: "%", us: val, usUnit: "%",
            basis: position === "above"
                ? "SM_actual = (Nc - N_trip) / N_trip x 100"
                : "SM_actual = (N_min - Nc) / N_min x 100"
        });
    }

    /**
     * Combined separation-margin check: computes AF, the required SM and the
     * actual SM achieved, and the pass/fail verdict.
     * inputs: { Nc, N1, N2, Nref, position }
     */
    function separationMarginCheck({ Nc, N1, N2, Nref, position }) {
        const af = amplificationFactor(Nc, N1, N2);
        if (!af) return null;
        const req = requiredSM(af.value, position);
        const act = actualSM(Nc, Nref, position);
        if (!req || !act) return null;
        const pass = act.value >= req.value;
        return {
            AF: af.value,
            required: req.value,
            actual: act.value,
            pass,
            basis: req.basis
        };
    }

    /**
     * Maximum allowable residual unbalance per correction plane, U.
     * W = journal static load carried by that bearing (NOT total rotor
     * mass), N = maximum continuous speed.
     * SI:  U [g.mm] = 6350 * W[kg] / N[rpm]
     * US:  U [oz.in] = 4 * W[lb] / N[rpm]
     * API 617 8th Ed 6.9.
     */
    function residualUnbalance(W_kg, N_rpm) {
        if (!(W_kg > 0) || !(N_rpm > 0)) return null;
        const U_gmm = 6350 * W_kg / N_rpm;
        return mk({
            value: U_gmm, unit: "g·mm", us: gmmToOzin(U_gmm), usUnit: "oz·in",
            basis: "U = 6350W/N (SI, W = journal static load in kg, N = Nmc in rpm) " +
                "— API 617 8th Ed 6.9 (US: U = 4W/N, oz·in, lb)"
        });
    }

    /**
     * Unbalance to be used in the damped response (Level I) analysis —
     * a stated multiple of the allowable residual unbalance U. API 617
     * commonly requires this multiplier to be at least 2 for the response
     * study; confirm the multiplier the vendor used against the applicable
     * project specification.
     */
    function analysisUnbalance(U_gmm, multiplier = 2) {
        if (!(U_gmm > 0) || !(multiplier > 0)) return null;
        const val = U_gmm * multiplier;
        return mk({
            value: val, unit: "g·mm", us: gmmToOzin(val), usUnit: "oz·in",
            basis: `Analysis unbalance = ${multiplier}× U (multiplier confirmed against project spec / API 617)`
        });
    }

    /**
     * Mechanical running test vibration limit (unfiltered, peak-to-peak),
     * at maximum continuous speed N.
     *   A1 = 25.4 * sqrt(12000 / N)  [um], capped.
     * API 617 8th Ed cap: 50.8 um (2.0 mil). API 613 (gearboxes) cap: 25.4
     * um (1.0 mil) — pass cap explicitly for gearbox rotors.
     */
    function vibrationLimit(N_rpm, opts = {}) {
        const cap = opts.cap != null ? opts.cap : 50.8;
        const capLabel = opts.capLabel || (cap === 25.4 ? "1.0 mil (API 613)" : "2.0 mil (API 617)");
        if (!(N_rpm > 0)) return null;
        const raw = 25.4 * Math.sqrt(12000 / N_rpm);
        const val = Math.min(raw, cap);
        return mk({
            value: val, unit: "µm", us: umToMils(val), usUnit: "mil",
            basis: `A1 = 25.4√(12000/N), capped at ${cap} µm (${capLabel})`,
            extra: { raw, capped: raw > cap }
        });
    }

    /**
     * Predicted major-axis vibration amplitude (Ao) at a close-clearance
     * location vs. the minimum design diametral running clearance at that
     * location. Ao must not exceed 75% of the minimum diametral clearance.
     * API 617 8th Ed 6.8.2.6.
     */
    function clearanceCheck(Ao_um, minDiametralClearance_um) {
        if (!(Ao_um >= 0) || !(minDiametralClearance_um > 0)) return null;
        const limit = 0.75 * minDiametralClearance_um;
        const pass = Ao_um <= limit;
        return mk({
            value: Ao_um, unit: "µm", us: umToMils(Ao_um), usUnit: "mil", pass,
            basis: "Ao ≤ 75% of minimum diametral running clearance (API 617 8th Ed 6.8.2.6)",
            extra: { limit_um: limit, limit_mil: umToMils(limit) }
        });
    }

    /**
     * Gear mesh frequency and its first few harmonics, for checking
     * clearance from pinion/gear lateral critical speeds (API 613).
     */
    function meshFrequency(N_rpm, teeth) {
        if (!(N_rpm > 0) || !(teeth > 0)) return null;
        const fm = N_rpm / 60 * teeth;
        return mk({
            value: fm, unit: "Hz", us: fm * 60, usUnit: "cpm",
            basis: "fmesh = (N/60) × teeth — verify clear of pinion/gear lateral criticals (API 613)"
        });
    }

    /**
     * Anticipated aerodynamic cross-coupled stiffness contributed by one
     * impeller stage (modified Alford's equation), expressed via the shaft
     * torque delivered at that stage:
     *   T [N.m]   = 9550 * P[kW] / N[rpm]
     *   Q [N/mm]  = B * T[N.m] * 1000 / (D[mm] * H[mm])
     * where B is an empirical cross-coupling factor (commonly taken in the
     * 1-4 range for centrifugal compressors; the applicable value and the
     * exact Annex E constant should be confirmed against the current API
     * 617 8th Ed Annex E text — this implementation is a transparent,
     * dimensionally-consistent engineering estimate, not a literal
     * transcription of the Annex E formula).
     * P = gas power absorbed by the stage [kW], D = impeller tip diameter
     * [mm], H = restrictive seal/diffuser clearance or width [mm].
     */
    function crossCoupledStiffness({ P_kW, D_mm, H_mm, N_rpm, B = 3 }) {
        if (!(P_kW > 0) || !(D_mm > 0) || !(H_mm > 0) || !(N_rpm > 0)) return null;
        const T_Nm = 9550 * P_kW / N_rpm;
        const Q_Nmm = B * T_Nm * 1000 / (D_mm * H_mm);
        return mk({
            value: Q_Nmm, unit: "N/mm", us: NmmToLbfin(Q_Nmm), usUnit: "lbf/in",
            basis: "Q = B·T·1000/(D·H), T = 9550P/N — engineering estimate of the modified " +
                "Alford cross-coupling per stage; confirm B and the Annex E constant against " +
                "API 617 8th Ed Annex E before use in a report (not a verbatim clause transcription)"
        });
    }

    /**
     * Sum the per-stage cross-coupled stiffness contributions to get the
     * anticipated cross-coupling QA applied at the rotor mid-span for the
     * Level I stability screen.
     */
    function anticipatedQA(stages) {
        if (!Array.isArray(stages) || stages.length === 0) return null;
        let total = 0;
        const perStage = [];
        for (const s of stages) {
            const q = crossCoupledStiffness(s);
            if (!q) return null;
            total += q.value;
            perStage.push(q.value);
        }
        return mk({
            value: total, unit: "N/mm", us: NmmToLbfin(total), usUnit: "lbf/in",
            basis: "QA = Σ Q_stage, applied at rotor mid-span (API 617 8th Ed Annex E, Level I)",
            extra: { perStage }
        });
    }

    /**
     * Level I stability screening indicators (API 617 8th Ed Annex E).
     * This does NOT return a hard pass/fail the way the other checks do —
     * the Annex E acceptance chart and applicability table have specific
     * numeric thresholds (discharge pressure, gas density, power/stage,
     * etc.) that should be read from the current edition rather than
     * hard-coded here. Instead this returns the computed ratios plus a
     * list of qualitative flags for the reviewer to weigh, each labelled
     * with what to go check.
     * inputs: { Nmc, Nc1, Q0, QA, logDecAtQA }
     */
    function stabilityScreen({ Nmc, Nc1, Q0, QA, logDecAtQA }) {
        const reasons = [];
        let CSR = null, qRatio = null;

        if (Nmc > 0 && Nc1 > 0) {
            CSR = Nmc / Nc1;
            if (CSR > 0.9) {
                reasons.push("CSR (Nmc/Nc1) is above 0.9 — first critical is close to Nmc; " +
                    "confirm separation margin is still met and re-check against the Annex E chart.");
            }
        }
        if (Q0 > 0 && QA > 0) {
            qRatio = Q0 / QA;
            if (qRatio < 2) {
                reasons.push("Onset speed of instability cross-coupling (Q0) is less than 2× the " +
                    "anticipated cross-coupling (QA) — a commonly used trigger for a Level II analysis. " +
                    "Confirm against the applicable project specification and Annex E.");
            }
        }
        if (logDecAtQA != null) {
            if (logDecAtQA <= 0) {
                reasons.push("Predicted log decrement at QA is ≤ 0 — the rotor is predicted unstable " +
                    "at the anticipated cross-coupling. Level II analysis is required.");
            } else if (logDecAtQA < 0.1) {
                reasons.push("Predicted log decrement at QA is below the commonly used 0.1 minimum " +
                    "— treat as marginal and confirm the requirement in the project specification.");
            }
        }

        return {
            CSR, qRatio, logDecAtQA: logDecAtQA != null ? logDecAtQA : null,
            levelIIFlagged: reasons.length > 0,
            reasons,
            basis: "Level I screening indicators (API 617 8th Ed Annex E) — for reviewer judgement, " +
                "not an automatic pass/fail; check the Annex E applicability table and acceptance chart directly."
        };
    }

    return {
        umToMils, gmmToOzin, kgToLb, lbToKg, NmmToLbfin,
        amplificationFactor, requiredSM, actualSM, separationMarginCheck,
        residualUnbalance, analysisUnbalance,
        vibrationLimit, clearanceCheck, meshFrequency,
        crossCoupledStiffness, anticipatedQA, stabilityScreen
    };
})();
