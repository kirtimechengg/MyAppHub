/*
 * lateral-checklist.js
 * -------------------------------------------------------------------------
 * Data corpus for the Train Lateral Rotordynamics Review tool (lva_tool.html):
 * Motor + Speed-Increaser Gearbox + Barrel (BCL) Centrifugal Compressor.
 *
 * Data only — no DOM, no calculation. Exposed as window.LatData.
 * Item shape matches tva_tool.html's checklist items exactly, so the same
 * rendering, search, PDF and Excel export code works unchanged:
 *   { id, category, label, requirement, insight, checked, status, notes }
 *
 * References: API 617 8th Edition (2014) Part 1; API 684 2nd Edition (2005);
 * API 613 5th Edition (gearboxes); API 546 / API 541 (induction / sync
 * motors). Where a specific clause number is not certain, the requirement
 * is worded by rule instead of a guessed paragraph number.
 * -------------------------------------------------------------------------
 */
window.LatData = (function () {
    "use strict";

    function item(id, category, label, requirement, insight) {
        return { id, category, label, requirement, insight, checked: false, status: "pending", notes: "" };
    }
    function section(id, title, iconKey, items) {
        return { id, title, iconKey, items };
    }

    // ---- Project defaults --------------------------------------------------
    const PROJECT_DEFAULTS = {
        endCustomer: "",
        project: "",
        specifications: "",
        service: "",
        manufacturer: "",
        model: "",
        configuration: "Motor + Speed-Increaser Gearbox + Barrel (BCL) Centrifugal Compressor"
    };

    // ---- Rotors --------------------------------------------------------------
    const ROTORS = [
        { key: "motor", label: "Motor Rotor", template: "motor" },
        { key: "gear_ls", label: "Gearbox — Bull Gear (LS)", template: "gear" },
        { key: "gear_hs", label: "Gearbox — Pinion (HS)", template: "gear" },
        { key: "comp", label: "BCL Compressor Rotor", template: "comp" }
    ];

    // ---- Shared, train-level sections (apply once, not per rotor) ---------
    const SHARED_SECTIONS = {
        basis: section("basis", "1. Analysis Basis & Scope", "FileText", [
            item("sh-b1", "Scope", "Required Analyses Stated", "Level I (undamped map + response) minimum; Level II (stability) per Annex E applicability",
                "Confirm up front which analyses are contractually required for each rotor and whether any Annex E Level I applicability trigger (discharge pressure, gas density, power/stage) mandates a Level II stability analysis on the compressor from the start, not only as a fallback."),
            item("sh-b2", "Software", "Analysis Software & Version", "Named, validated program (API 684 Ch.1)",
                "The report should state the specific program and version used (e.g., a recognized rotordynamics code), and ideally reference validation against a published benchmark rotor per API 684 Chapter 1."),
            item("sh-b3", "Competency", "Analyst Qualification", "Experience commensurate with train complexity",
                "For a geared train with 4 independently-analysed rotors, verify the analyst has demonstrable experience with geared trains specifically — motor and gearbox rotordynamics have failure modes (laminated core stiffness, mesh-load-dependent bearing loads) that a compressor-only specialist can miss."),
            item("sh-b4", "Deviations", "Exception / Deviation List", "Explicit list vs. project spec & API defaults",
                "Any place the vendor's approach differs from the project specification or API 617/684 defaults (e.g., damping assumptions, unbalance distribution, bearing clearance range) should be listed explicitly, not buried in an appendix."),
            item("sh-b5", "Sequence", "Model-Update Sequence", "Predicted model updated after test data (API 684)",
                "API 684 expects the analytical model to be reconciled against measured critical speeds from the mechanical running test. Confirm the review includes a plan to re-check the model once test data is available, not just the pre-test prediction."),
            item("sh-b6", "Interpretation", "API 684 Used as Interpretive Reference", "Modelling method traceable to API 684 Ch.2-4",
                "API 617 sets the acceptance criteria; API 684 explains how the model should be built to get there (station discretization, damping sources, support modelling). The report should show its modelling choices are consistent with API 684, not just quote API 617 pass/fail numbers.")
        ]),
        coupling: section("coupling", "2. Coupling & Interfaces", "Settings", [
            item("sh-c1", "Mass", "Half-Coupling Weight & CG", "Stated per API 671 datasheet, matches model",
                "The overhung coupling half-weight and its center of gravity relative to the shaft end must match the coupling vendor's certified datasheet, not a placeholder/estimated value used before the coupling was selected."),
            item("sh-c2", "Moment", "Overhung Moment Effect", "Impact on 2nd (overhung) critical speed shown",
                "A heavier or more overhung coupling hub lowers the rotor's overhung-mode critical speed. Confirm the report shows this mode explicitly and that it still clears the required separation margin with the as-selected coupling."),
            item("sh-c3", "Fit", "Hub Fit & Shaft-End Geometry", "Matches mechanical (API 671) drawing",
                "The stiffness and mass used for the coupling hub in the lateral model should be consistent with the actual hub geometry and interference fit shown on the certified coupling drawing, not a generic assumption."),
            item("sh-c4", "Solo Run", "Solo-Plate / Moment Simulator", "Included if uncoupled run is planned",
                "If the driver or driven machine is run solo (uncoupled) during test, a weight/moment simulator representing the missing coupling hub should be fitted — otherwise the solo-run rotordynamics (and the test data) will not represent the coupled condition."),
            item("sh-c5", "Growth", "Hot/Cold Alignment & Thermal Growth", "Coupling misalignment capacity checked",
                "Confirm the coupling's rated misalignment capacity (angular + parallel offset, combined) exceeds the worst-case thermal growth and installation tolerance between the two connected machines across the whole train."),
            item("sh-c6", "Windage", "Coupling Guard Windage / Heat", "Guard ventilation adequate at coupling speed",
                "High-speed couplings (gearbox HS side in particular) generate windage heat inside the guard. Confirm this was considered in the coupling guard design and doesn't feed back as an unaccounted heat source near the adjacent bearing.")
        ]),
        foundation: section("foundation", "3. Foundation, Baseplate & Supports", "Shield", [
            item("sh-f1", "Modelling", "Bearing Housing / Pedestal Stiffness", "Modelled explicitly or justified as rigid",
                "API 684 requires the flexibility of the support structure (bearing housing, pedestal) to be included or explicitly justified as negligible. A model that assumes perfectly rigid supports without justification can under-predict response amplitudes."),
            item("sh-f2", "Skid", "Baseplate / Soleplate & Grout", "Structural stiffness consistent with as-built design",
                "For skid-mounted trains, confirm the assumed baseplate/soleplate stiffness reflects the actual structural design (rib pattern, grout type) rather than a generic 'rigid foundation' assumption."),
            item("sh-f3", "Survey", "Structural Resonance Survey", "Structure natural frequencies checked vs. running speeds",
                "A structural (impact) test or FEA survey of the skid/baseplate should confirm no structural natural frequency coincides with 1x or 2x running speed of any of the four rotors, or with gear mesh frequency."),
            item("sh-f4", "Mounting", "Mounting Method Stated", "Skid vs. concrete block, consistent across train", "")
        ]),
        deliverables: section("deliverables", "4. Report Deliverables", "Table", [
            item("sh-d1", "Plots", "Undamped Critical Speed Map", "Bearing stiffness curve superimposed, per rotor",
                "Each rotor's report should include an undamped critical speed map (natural frequency vs. support stiffness) with the actual bearing stiffness range superimposed, so the operating criticals are visually traceable — not just a table of numbers."),
            item("sh-d2", "Plots", "Mode Shapes", "Plotted at operating stiffness, each critical", ""),
            item("sh-d3", "Plots", "Bode & Polar/Nyquist Plots", "At each probe location, min & max clearance cases",
                "Response plots should be shown at each vibration probe location (not just mid-span) and for both the minimum and maximum bearing clearance cases — the critical speed and amplitude can shift meaningfully between the two."),
            item("sh-d4", "Plots", "Log Dec vs. Cross-Coupling", "Compressor rotor only, Level I/II stability",
                "For the compressor rotor, a plot of log decrement vs. applied cross-coupled stiffness is the primary stability deliverable — confirm it's present and legible, with QA and Q0 clearly marked."),
            item("sh-d5", "Tables", "Summary Table — Criticals, AF, SM", "One row per critical speed, per rotor", ""),
            item("sh-d6", "Assumptions", "Assumptions Stated", "Damping source, bearing data source, unbalance basis listed", ""),
            item("sh-d7", "Revision", "Report Revision Status", "Current, matches as-built hardware", "")
        ]),
        testing: section("testing", "5. Test & Field Verification", "CheckCircle", [
            item("sh-t1", "MRT", "Mechanical Running Test Plan", "Vibration acceptance criteria stated per rotor", ""),
            item("sh-t2", "Verification", "Unbalance Response Verification Test", "Trim-weight test vs. predicted response shape",
                "API 617/684 favor a test where a known trim unbalance is added and the measured response shape is compared to the predicted one — a stronger verification than simply confirming vibration stays under the limit."),
            item("sh-t3", "Model Update", "Model Reconciliation After Test", "Analytical model updated if measured critical departs",
                "If a measured critical speed departs materially from the predicted value, the model should be reconciled (and re-run for the field condition) rather than the discrepancy simply being noted and left open."),
            item("sh-t4", "Probes", "Probe Location, Runout & Slow-Roll", "Compensated per API 670", ""),
            item("sh-t5", "Balance", "Trim Balance Limits", "Field balance tolerance per API 617 residual U", ""),
            item("sh-t6", "Acceptance", "Field Acceptance vs. A1", "Unfiltered vibration limit A1 applied at site", "")
        ])
    };

    // ---- Rotor-specific section templates ----------------------------------
    function modelSection(rotorNote) {
        return section("A", "A. Rotor Model & Geometry", "Activity", [
            item("a1", "Discretization", "Station Model Detail", "Sufficient stations to capture bending mode shapes (API 684 Ch.2)",
                "Too coarse a station model under-predicts bending-mode natural frequencies. Confirm the number of stations is adequate for the highest mode of interest, particularly near stiffness/diameter changes."),
            item("a2", "Stiffness/Mass", "Added Mass vs. Added Stiffness", "Non-structural components correctly classified",
                "Items like impellers, gear blanks or laminated cores add both mass and (sometimes) stiffness. Confirm the model applies the correct credit for each — treating a stiffening component as mass-only under-predicts the critical speed."),
            item("a3", "Fits", "Shrink-Fit Stiffening Credit", "Interference fit stiffening included or conservatively excluded",
                "A heavy interference (shrink) fit locally stiffens the shaft. Confirm the report states whether this credit was taken, and that the assumption is consistent (not stiffening-credited in one run and not another)."),
            item("a4", "Hardware", "Sleeves, Collars & Piston", "All mounted hardware represented as mass + inertia", ""),
            item("a5", "Specific", rotorNote.cat, rotorNote.req, rotorNote.insight)
        ]);
    }
    function bearingSection(extraItems) {
        const base = [
            item("b1", "Config", "Bearing Type & Configuration", "Pad count, LOP/LBP orientation stated",
                "Tilting-pad bearing behaviour depends on pad count and orientation (load-on-pad vs. load-between-pad). Confirm this is explicitly stated and matches the certified bearing drawing, not assumed generic."),
            item("b2", "Preload", "Preload & Clearance Ratio", "Both extremes analysed (min & max clearance)",
                "Bearing clearance varies across the manufacturing tolerance band. API practice requires response to be checked at both the minimum and maximum design clearance — a single nominal-clearance run is not sufficient."),
            item("b3", "Oil", "Oil Grade, Inlet Temp & Effective Viscosity", "Consistent with lube system datasheet",
                "The K/C coefficients used in the lateral model depend on oil viscosity at the actual operating inlet temperature. Cross-check this against the lube oil system datasheet, not a generic 40°C reference viscosity."),
            item("b4", "Coefficients", "Speed & Load Dependent K/C", "Full-range coefficients, not a single operating point",
                "Bearing dynamic coefficients change with speed and load. Confirm the model used coefficients appropriate to the speed being analysed at each point on the response curve, not one fixed set for the whole sweep."),
            item("b5", "Stability", "Unloaded-Pad Flutter", "Checked for lightly-loaded pad instability", "")
        ];
        return section("B", "B. Bearings & Dampers", "Beaker", base.concat(extraItems || []));
    }
    function critSpeedSection() {
        return section("C", "C. Undamped Critical Speed Map & Mode Shapes", "Wind", [
            item("c1", "Map", "Bearing Stiffness Superimposed", "Operating range clearly marked on the map", ""),
            item("c2", "Modes", "Rigid-Body vs. Bending Modes", "Each identified and labelled distinctly",
                "A rigid-body (conical/cylindrical) mode near operating speed is treated differently than a bending mode — confirm the report distinguishes them rather than listing an unlabelled list of frequencies."),
            item("c3", "Shape", "Mode Shape at Operating Stiffness", "Not just at K=infinity or K=0 bounds", ""),
            item("c4", "Sensitivity", "Sensitivity to Support Stiffness", "Shown across the credible support-stiffness range", "")
        ]);
    }
    function responseSection(rotorNote) {
        return section("D", "D. Damped Unbalance Response (Level I)", "AlertTriangle", [
            item("d1", "Distribution", "Standard Unbalance Distributions", "Four standard placements per API 617/684 applied",
                "API 684 defines standard unbalance distributions (e.g., first-mode, second-mode, coupling-end, mid-span) intended to excite each mode of concern. Confirm all relevant distributions were run, not only the worst-case one found."),
            item("d2", "Magnitude", "Unbalance Magnitude Traceable to U", "Analysis unbalance = stated multiple of API 617 residual U",
                "The unbalance magnitude used in the response run should be a clearly stated multiple (commonly 2x or more) of the API 617 allowable residual unbalance U for that rotor — use the Criteria Calculator below to check the vendor's U and confirm the multiple used."),
            item("d3", "AF", "Amplification Factor from Half-Power Points", "Correctly extracted from the response curve", ""),
            item("d4", "SM", "Separation Margins Met", "Actual SM ≥ required SM at every critical in range",
                "Use the Criteria Calculator below for each identified critical speed. A single critical falling short of its required separation margin, even by a small amount, is a genuine non-compliance — not a rounding matter."),
            item("d5", "Clearance", "Ao vs. 75% of Minimum Clearance", "Checked at every close-clearance location (seals, bushings)",
                "This must be checked wherever a close radial clearance exists along the rotor — not only at the bearings. A seal or labyrinth location can govern even when the bearing amplitude is comfortably within limits."),
            item("d6", "Probe", "Amplitude at Probe vs. Mid-Span", "Probe reading correlated to the peak (mid-span) amplitude",
                "The vibration probe reads amplitude at the bearing, not at the point of maximum deflection. Confirm the report shows the relationship between the two so the probe reading can be meaningfully compared to the vibration limit."),
            item("d7", "Range", "Full-Range Sweep to Trip Speed", "0% to at least 105-115% of trip speed swept", ""),
            item("d8", "Specific", rotorNote.cat, rotorNote.req, rotorNote.insight)
        ]);
    }

    const ROTOR_TEMPLATES = {
        motor: [
            modelSection({ cat: "Motor Core", req: "Laminated (not solid) effective stiffness used",
                insight: "A laminated motor rotor core is significantly less stiff than a solid steel cylinder of the same envelope dimensions. Confirm the model applies a reduced effective stiffness for the core, and that rotor bar / end-ring mass is represented." }),
            bearingSection([]),
            critSpeedSection(),
            responseSection({ cat: "VFD Sweep", req: "Full VFD operating speed range covered, not just 100%",
                insight: "For a VFD-driven motor, the response analysis must cover the entire commanded speed range end-to-end (including any skip bands), since the rotor spends time at speeds other than rated — not just a single-point check at 100% speed." }),
            section("E", "E. Electrical & VFD Excitation", "Settings", [
                item("me1", "VFD", "VFD Torque Ripple as Lateral Excitation", "Air-gap torque ripple considered where it couples to lateral response", ""),
                item("me2", "Line", "2x Line Frequency Excitation", "50/60 Hz doubled-frequency line pass-through checked (non-VFD case)", ""),
                item("me3", "Slip", "Slip-Frequency Excitation", "Induction motor slip frequency clear of any critical", ""),
                item("me4", "UMP", "Unbalanced Magnetic Pull (UMP)", "Modelled as a negative (destabilizing) stiffness",
                    "Static/dynamic air-gap eccentricity produces an unbalanced magnetic pull that acts as a negative radial stiffness, lowering the effective critical speed. Confirm the report addresses whether this was included or is bounded as negligible." ),
                item("me5", "Limits", "API 541/546 Vibration Limits Cross-Checked", "Consistent with IEC 60034-14 where applicable", ""),
                item("me6", "Grounding", "Insulated Bearing / Shaft Grounding", "Present if required to prevent bearing current damage", "")
            ])
        ],
        gear: [
            modelSection({ cat: "Gear Blank", req: "Gear/pinion blank stiffening & thrust collar location represented",
                insight: "The gear or pinion blank (the toothed body itself) is significantly stiffer than a plain shaft section of the same diameter — confirm the model credits this, and that the thrust collar is placed and sized to match the certified drawing." }),
            bearingSection([
                item("b6", "Load Direction", "Bearing Load Magnitude & Direction vs. Torque", "Analysed across the transmitted torque range, not only at 100%",
                    "Unlike a compressor or motor rotor, gearbox bearing loads change in both magnitude and direction with transmitted torque (tooth mesh forces). Confirm the lateral response was checked across the torque range the unit will see in service, not only at rated load.")
            ]),
            critSpeedSection(),
            responseSection({ cat: "Torque Range", req: "Response checked at min and max transmitted torque",
                insight: "Because bearing load direction shifts with torque, run the unbalance response at both ends of the expected torque range (e.g., turndown and rated) — a critical speed that clears at one torque level is not guaranteed to clear at the other." }),
            section("E", "E. Gear Mesh & API 613 Limits", "Settings", [
                item("ge1", "Limit", "API 613 Vibration Limit Applied", "A1 = 25.4√(12000/N), capped at 1.0 mil — half the API 617 cap",
                    "API 613 caps the unfiltered vibration limit at 1.0 mil (25.4 µm), tighter than API 617's 2.0 mil cap. Use the Criteria Calculator with the gearbox cap selected and confirm the vendor applied the correct (tighter) limit." ),
                item("ge2", "Mesh", "Gear Mesh Frequency Clear of Laterals", "Mesh frequency and its harmonics clear of pinion/gear critical speeds",
                    "Use the Criteria Calculator to compute mesh frequency from operating speed and tooth count, and confirm it (and at least its 2nd harmonic) is clear of both the pinion and gear lateral critical speeds." ),
                item("ge3", "Excitation", "Tooth-Mesh Excitation Considered", "Included as a forcing function where relevant to lateral response", ""),
                item("ge4", "Margin", "API 613 20% Separation Requirement", "Applied in addition to / consistent with API 617 SM logic",
                    "API 613 states its own separation margin expectations for gear equipment; confirm the vendor's stated margins satisfy API 613's requirement, not only the API 617 formula-based SM used for the compressor and motor." ),
                item("ge5", "Ratio", "Gear Ratio Verified Exact", "Actual tooth ratio used, not a rounded value",
                    "The exact tooth ratio (e.g., 87/34, not 2.56) should be used everywhere it feeds into speed or mesh-frequency calculations — a rounded ratio compounds into a real error at high speed." )
            ])
        ],
        comp: [
            modelSection({ cat: "Impeller Stiffening", req: "Impeller/shaft interference stiffening assumption stated",
                insight: "Shrink-fitted impellers add local shaft stiffening; confirm the report states whether this credit was taken (and whether a tie-bolt, if used, was represented) and that the assumption is applied consistently across all response runs." }),
            bearingSection([]),
            critSpeedSection(),
            responseSection({ cat: "Close Clearances", req: "Every seal/labyrinth clearance location checked against 75% limit",
                insight: "A multistage barrel compressor has several close-clearance locations (interstage labyrinths, balance piston, division wall bushing) beyond the bearings themselves — confirm the 75%-of-clearance check was performed at each one, not only at the bearing journals." }),
            section("E", "E. Stability — Level I & Level II (Annex E)", "AlertTriangle", [
                item("ce1", "QA", "Anticipated Cross-Coupled Stiffness (QA)", "Summed per-impeller, applied at rotor mid-span",
                    "Use the Criteria Calculator to independently estimate the per-stage cross-coupled stiffness and compare the order of magnitude to the vendor's stated QA — a large mismatch is worth understanding before accepting the stability conclusion." ),
                item("ce2", "Q0", "Onset Speed of Instability (Q0)", "Log dec = 0 crossing point identified on the stability plot", ""),
                item("ce3", "Margin", "Q0 vs. QA Margin", "Q0 clears QA with adequate margin (commonly ≥ 2x, confirm project basis)", ""),
                item("ce4", "Trigger", "Level I Applicability Criteria Checked", "Discharge pressure, gas density & power/stage checked against Annex E table",
                    "API 617 8th Ed Annex E sets specific applicability criteria (discharge pressure, gas density, power per stage, among others) that determine whether Level I screening alone is sufficient or a Level II analysis is mandated from the outset. Confirm the vendor evaluated this train against the current Annex E table explicitly, rather than defaulting to Level I only." ),
                item("ce5", "Level II Scope", "Level II Content (if triggered)", "Seal dynamic coefficients, swirl brakes/injection, DGS effects included",
                    "When Level II is triggered, the analysis should include labyrinth and balance-piston seal rotordynamic coefficients, any swirl-reduction devices (swirl brakes, shunt/anti-swirl injection), dry gas seal stiffness/damping contributions, and aerodynamic cross-coupling — confirm each is addressed, not just aerodynamic cross-coupling alone." ),
                item("ce6", "Log Dec", "Minimum Log Decrement at MCOS", "δ ≥ 0.1 (or per project spec) at max continuous operating speed", ""),
                item("ce7", "Seals", "Seal/Labyrinth Configuration Matches Drawing", "Rotordynamic input data traceable to the certified seal drawing", "")
            ])
        ]
    };

    return { PROJECT_DEFAULTS, ROTORS, SHARED_SECTIONS, ROTOR_TEMPLATES };
})();
