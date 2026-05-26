/* Swivl ROI Calculator — scan pre-fill bridge.

   When the calculator is opened with a scan payload in
   localStorage["m2_scan_for_roi"], this script maps scan fields onto
   the calculator's inputs and triggers a recompute. When no payload is
   present the calculator stays at its default values (standalone mode
   — unchanged behavior).

   Why localStorage (not sessionStorage): sessionStorage is per-tab.
   When the dashboard does window.open() to /roi/ in a new tab, the
   new tab gets an empty sessionStorage even on the same origin
   (especially when `noopener` is used). localStorage is shared across
   tabs on the same origin, so the dashboard can write the scan, open
   the new tab, and the calculator can read it. We attach a timestamp
   and ignore entries older than 60s so a stale localStorage entry
   from a previous scan doesn't accidentally fill in this scan.

   Mapping (each scan field → calculator input):
     scan.district_name + state          → #in-district-name
     scan.nces_profile.schools + locale  → cohort tier splits (heuristic)
     scan.nces_profile.teachers_fte      → teachers/grade per tier
     scan.nces_profile.aides_fte
       + counselors_fte
       + student_support_staff_fte       → staff/bldg per tier
     scan.pd_consultant_replacements[]
       w/ estimated_annual_spend         → #in-known-budget (× contract term)
     fallback: scan.spend_profile
       .instructional_staff_support_2200 → #in-known-budget (with caveat note)
     funding_fit + funding_paths         → fundability footer text

   URL query handling:
     ?view=brief — after pre-fill, auto-invoke window.generateBrief()
                   so a single click from the dashboard takes the rep to
                   the printable Swivl brand 1-pager.
*/

(function () {
  "use strict";

  var STORAGE_KEY = "m2_scan_for_roi";
  var STORAGE_TS_KEY = "m2_scan_for_roi_ts";
  var MAX_AGE_MS = 60 * 1000;  // ignore entries older than 60s

  // ── Cohort heuristic ──────────────────────────────────────────────────────
  // Rough US public-school distribution. The rep can override every field —
  // we set sensible defaults rather than guess to two decimal places.
  var TIER_SHARE_BY_LOCALE = {
    // locale_label substring → [elem%, middle%, high%]
    "city":    [0.55, 0.20, 0.25],
    "suburb":  [0.60, 0.20, 0.20],
    "town":    [0.60, 0.20, 0.20],
    "rural":   [0.65, 0.15, 0.20]
  };
  var DEFAULT_TIER_SHARE = [0.60, 0.20, 0.20];

  // Standard grade-band lengths (K-5, 6-8, 9-12).
  var GRADES_PER_BLDG = { elem: 6, mid: 3, high: 4 };

  function readScan() {
    // Prefer localStorage (shared across tabs). Fall back to sessionStorage
    // for backward compatibility with the older dashboard build. Discard
    // entries older than MAX_AGE_MS so a stale payload from a previous
    // scan does not silently leak into the current calculator session.
    try {
      var ts = Number(window.localStorage.getItem(STORAGE_TS_KEY) || 0);
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw && ts && (Date.now() - ts) < MAX_AGE_MS) {
        // Consume the entry — once read, clear it so a stale localStorage
        // value cannot trigger pre-fill on a future standalone visit.
        try {
          window.localStorage.removeItem(STORAGE_KEY);
          window.localStorage.removeItem(STORAGE_TS_KEY);
        } catch (e) { /* quota-disabled storage — ignore */ }
        return JSON.parse(raw);
      }
    } catch (e) {
      console.warn("[ROI prefill] localStorage read failed:", e);
    }
    // sessionStorage fallback (older dashboard build that wrote there).
    try {
      var raw2 = window.sessionStorage.getItem(STORAGE_KEY);
      if (raw2) {
        try { window.sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
        return JSON.parse(raw2);
      }
    } catch (e) {
      console.warn("[ROI prefill] sessionStorage read failed:", e);
    }
    return null;
  }

  function pickTierShare(localeLabel) {
    var l = String(localeLabel || "").toLowerCase();
    for (var key in TIER_SHARE_BY_LOCALE) {
      if (l.indexOf(key) >= 0) return TIER_SHARE_BY_LOCALE[key];
    }
    return DEFAULT_TIER_SHARE;
  }

  // Split total schools into elem/mid/high using the locale-share heuristic.
  // Round so the three counts sum to the total (largest-remainders).
  function splitSchools(total, localeLabel) {
    if (!total || total < 1) return { eB: 0, mB: 0, hB: 0 };
    var share = pickTierShare(localeLabel);
    var raw = share.map(function (s) { return total * s; });
    var floored = raw.map(Math.floor);
    var remainders = raw.map(function (r, i) { return { i: i, r: r - floored[i] }; });
    var deficit = total - floored.reduce(function (a, b) { return a + b; }, 0);
    remainders.sort(function (a, b) { return b.r - a.r; });
    for (var k = 0; k < deficit; k++) floored[remainders[k % 3].i] += 1;
    // Guarantee at least 1 elementary if total >= 1.
    if (total >= 1 && floored[0] === 0) {
      var donorIdx = floored[2] > floored[1] ? 2 : 1;
      if (floored[donorIdx] > 0) { floored[donorIdx] -= 1; floored[0] += 1; }
    }
    return { eB: floored[0], mB: floored[1], hB: floored[2] };
  }

  // Distribute total teacher FTE evenly across all grade-slots so the
  // calculator's formula (Σ bldgs × grades × teachers) reproduces the
  // scan's reported teacher count.
  function teachersPerGrade(totalTeachersFTE, eB, mB, hB) {
    var slots = (eB * GRADES_PER_BLDG.elem)
              + (mB * GRADES_PER_BLDG.mid)
              + (hB * GRADES_PER_BLDG.high);
    if (!totalTeachersFTE || slots === 0) return null;
    return Math.max(1, Math.round(totalTeachersFTE / slots));
  }

  // Per-building support staff = (aides + counselors + support) / total bldgs.
  function staffPerBldg(p, totalBldgs) {
    if (!p || totalBldgs === 0) return null;
    var total = (Number(p.aides_fte) || 0)
              + (Number(p.counselors_fte) || 0)
              + (Number(p.student_support_staff_fte) || 0);
    if (!total) return null;
    return Math.max(1, Math.round(total / totalBldgs));
  }

  // Legacy PD: use ONLY the sum of sourced PD-consultant annual spend
  // (specifically named firms with payment/board evidence). Returns
  // { annual, source } or null when nothing defensible is available.
  //
  // We intentionally DO NOT fall back to F-33 function 2200. That figure
  // is the broader "instructional staff support" total — includes
  // in-house PD coordinators, conference travel, library services, etc.
  // It is roughly 50x–500x the typical district's external PD vendor
  // contract. Using it as "Legacy PD Contract Total" produces nonsense
  // savings numbers in the calculator and a broken exec brief.
  //
  // When there are no sourced PD consultant dollars, we leave the
  // calculator's default ($202,800) in place. The pre-fill banner
  // tells the rep to type in the actual contract number from the call.
  function pickLegacyPDAnnual(scan) {
    var consultants = (scan.pd_consultant_replacements || [])
      .filter(function (r) { return Number(r.estimated_annual_spend) > 0; });
    if (consultants.length) {
      var total = consultants.reduce(function (sum, r) {
        return sum + Number(r.estimated_annual_spend);
      }, 0);
      var firms = consultants.map(function (r) { return r.canonical_name; });
      return {
        annual: Math.round(total),
        source: "Sum of detected PD firms with sourced annual spend: "
          + firms.join(", ")
      };
    }
    return null;
  }

  function setField(id, value) {
    var el = document.getElementById(id);
    if (!el || value === null || value === undefined) return false;
    el.value = String(value);
    // The calculator wires "input" event listeners on every field that
    // call calculate(). Dispatching the event triggers a recompute.
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  function showBanner(scan, legacyPD, cohortSource) {
    var existing = document.getElementById("m2-prefill-banner");
    if (existing) existing.remove();
    var div = document.createElement("div");
    div.id = "m2-prefill-banner";
    div.style.cssText = [
      "background: #f5efff",
      "border: 1px solid #8E47FF",
      "border-radius: 8px",
      "padding: 12px 16px",
      "margin: 16px 0",
      "font-family: 'Inter', sans-serif",
      "font-size: 0.9rem",
      "color: #4a2a8c"
    ].join(";");
    var lines = [];
    lines.push(
      '<strong>Pre-filled from M2 District Coherence Scan</strong>' +
      ' &middot; <span style="color: #555">' +
      escapeHTML(scan.district_name || "Unknown district") +
      (scan.state ? ", " + escapeHTML(scan.state) : "") +
      ' &middot; LEAID ' + escapeHTML(scan.leaid || "n/a") +
      '</span>'
    );
    if (cohortSource) {
      var isReal = cohortSource.indexOf("NCES CCD") === 0;
      lines.push(
        '<div style="margin-top: 6px; font-size: 0.82rem; color: '
        + (isReal ? '#2e7d32' : '#b85c00') + ';">'
        + '<strong>Cohort source:</strong> '
        + escapeHTML(cohortSource)
        + '</div>'
      );
    }
    if (legacyPD && legacyPD.source) {
      lines.push(
        '<div style="margin-top: 6px; font-size: 0.82rem; color: #666;">' +
        '<strong>Legacy PD Contract Total source:</strong> ' +
        escapeHTML(legacyPD.source) +
        '</div>'
      );
    } else {
      lines.push(
        '<div style="margin-top: 6px; font-size: 0.82rem; color: #b85c00;">' +
        '<strong>Legacy PD Contract Total not pre-filled:</strong> ' +
        'no named PD vendor with sourced annual spend was detected. ' +
        'Enter the actual contract amount from the district before generating the brief.' +
        '</div>'
      );
    }
    // Tail note only when cohort source is heuristic — when it's real
    // NCES per-tier data, the cohort-source line above already speaks
    // for itself in green.
    if (cohortSource && cohortSource.indexOf("NCES CCD") !== 0) {
      lines.push(
        '<div style="margin-top: 6px; font-size: 0.82rem; color: #666;">' +
        'Teacher/staff per-building counts are arithmetic averages from district-level FTE — adjust before generating the brief if your district structure varies (e.g. large flagship high school).' +
        '</div>'
      );
    } else {
      lines.push(
        '<div style="margin-top: 6px; font-size: 0.82rem; color: #666;">' +
        'Teacher/staff per-building counts are arithmetic averages from district-level FTE — verify against the actual flagship high school size if needed.' +
        '</div>'
      );
    }
    div.innerHTML = lines.join("");
    var container = document.querySelector(".app-container");
    if (container && container.firstChild) {
      container.insertBefore(div, container.firstChild);
    }
  }

  function escapeHTML(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  // Read a numeric field from the scan, trying multiple paths in order.
  // Some scans return nces_profile/spend_profile with all-None values
  // (the collectors ran but the structured profile didn't populate);
  // in that case the same numbers live under scan.data_confidence as
  // {value, confidence, source, note} dicts. This helper falls back so
  // pre-fill works either way.
  function readScanNumber(scan, paths) {
    for (var i = 0; i < paths.length; i++) {
      var parts = paths[i].split(".");
      var cur = scan;
      var ok = true;
      for (var j = 0; j < parts.length; j++) {
        if (cur == null || typeof cur !== "object") { ok = false; break; }
        cur = cur[parts[j]];
      }
      if (ok && cur != null && cur !== "") {
        var n = Number(cur);
        if (isFinite(n) && n !== 0) return n;
      }
    }
    return null;
  }

  function readScanString(scan, paths) {
    for (var i = 0; i < paths.length; i++) {
      var parts = paths[i].split(".");
      var cur = scan;
      var ok = true;
      for (var j = 0; j < parts.length; j++) {
        if (cur == null || typeof cur !== "object") { ok = false; break; }
        cur = cur[parts[j]];
      }
      if (ok && typeof cur === "string" && cur.length) return cur;
    }
    return null;
  }

  function applyPrefill() {
    var scan = readScan();
    if (!scan) return;  // standalone mode — calculator stays at defaults

    var p = scan.nces_profile || {};
    var districtLabel = (scan.district_name || "") + (scan.state ? ", " + scan.state : "");
    setField("in-district-name", districtLabel);

    // PREFERRED: real per-tier school counts from CCD school_profile.
    // When all three are present we use them verbatim and skip the
    // heuristic split entirely. Falls back to the locale-share heuristic
    // only when per-tier data is unavailable (which should be rare —
    // every district in the CCD cache has a school_profile breakdown).
    var realElem = readScanNumber(scan, [
      "nces_profile.elementary_schools",
      "data_confidence.elementary_schools.value",
    ]);
    var realMid = readScanNumber(scan, [
      "nces_profile.middle_schools",
      "data_confidence.middle_schools.value",
    ]);
    var realHigh = readScanNumber(scan, [
      "nces_profile.high_schools",
      "data_confidence.high_schools.value",
    ]);
    var totalBldgs = readScanNumber(scan, [
      "nces_profile.schools",
      "data_confidence.schools.value",
    ]) || 0;
    var localeLabel = readScanString(scan, [
      "nces_profile.locale_label",
      "data_confidence.locale_label.value",
    ]);
    var split;
    if (realElem != null && realMid != null && realHigh != null
        && (realElem + realMid + realHigh) > 0) {
      // Real per-tier data from NCES — use verbatim. K-12 cohort math
      // ignores "other" buildings (PreK, ungraded, alt) by design.
      split = { eB: realElem | 0, mB: realMid | 0, hB: realHigh | 0 };
    } else {
      // Heuristic fallback for districts whose school_profile data
      // didn't load. Banner will tell the rep these are estimates.
      split = splitSchools(totalBldgs, localeLabel);
    }
    setField("elem-bldgs", split.eB);
    setField("mid-bldgs", split.mB);
    setField("high-bldgs", split.hB);

    var enrollment = readScanNumber(scan, [
      "nces_profile.enrollment",
      "data_confidence.enrollment.value",
    ]);
    var teachersFte = readScanNumber(scan, [
      "nces_profile.teachers_fte",
      "data_confidence.teachers_fte.value",
    ]);

    // Standard grade-band lengths — only normalize when we have some
    // form of size signal (otherwise leave the rep's defaults intact).
    if (totalBldgs || enrollment || teachersFte) {
      setField("elem-grades", GRADES_PER_BLDG.elem);
      setField("mid-grades", GRADES_PER_BLDG.mid);
      setField("high-grades", GRADES_PER_BLDG.high);
    }

    // Teachers-per-grade: back-solve from FTE. When teachers_fte is
    // unavailable, estimate from enrollment using a 16:1 student/teacher
    // ratio (US public-school average ≈ 15.4) — this avoids leaving the
    // calculator with default values that produce undersized cohorts.
    if (!teachersFte && enrollment) {
      teachersFte = Math.round(enrollment / 16);
    }
    var tchrs = teachersPerGrade(teachersFte || 0, split.eB, split.mB, split.hB);
    if (tchrs) {
      setField("elem-tchrs", tchrs);
      setField("mid-tchrs", tchrs);
      setField("high-tchrs", tchrs);
    }

    // Staff-per-bldg: prefer the structured profile when present (it has
    // the three FTE fields). Fall back to a fraction of teacher FTE when
    // only data_confidence is populated.
    var staff = staffPerBldg(p, split.eB + split.mB + split.hB);
    if (!staff && teachersFte && (split.eB + split.mB + split.hB) > 0) {
      // Rough heuristic: support staff (aides + counselors + other) is
      // typically ~20% of teacher FTE.
      var inferredSupportFte = Math.round(teachersFte * 0.20);
      staff = Math.max(1, Math.round(inferredSupportFte / (split.eB + split.mB + split.hB)));
    }
    if (staff) {
      setField("elem-staff", staff);
      setField("mid-staff", staff);
      setField("high-staff", staff);
    }

    var legacyPD = pickLegacyPDAnnual(scan);
    if (legacyPD) {
      // Calculator divides "Legacy PD Contract Total" by Contract Term to
      // get the annual figure. We default term=3 and write the total as
      // annual × 3 so the per-year math lines up with the scan source.
      setField("in-contract-term", 3);
      setField("in-known-budget", legacyPD.annual * 3);
    }

    var cohortSource = (realElem != null && realMid != null && realHigh != null
        && (realElem + realMid + realHigh) > 0)
      ? "NCES CCD school_profile (verified per-tier counts)"
      : "Locale heuristic (verify against district org chart before generating brief)";
    showBanner(scan, legacyPD, cohortSource);

    // Deep-link: ?view=brief auto-invokes the print/brief flow once the
    // prefill is in place — but ONLY when the auto-filled numbers
    // produce a positive 4-year savings figure. When the detected
    // Legacy PD spend is small relative to the M2 deployment cost
    // (common when only one or two named PD vendors were detected on a
    // large district), the auto-generated brief would show negative
    // savings — wrong artifact to send a CFO. In that case we skip
    // the auto-print and surface a clearer warning so the rep enters
    // the real contract number before generating.
    try {
      var params = new URLSearchParams(window.location.search);
      if (params.get("view") === "brief" && typeof window.generateBrief === "function") {
        setTimeout(function () {
          try {
            var savingsEl = document.getElementById("out-savings");
            var savingsText = (savingsEl && savingsEl.innerText) || "";
            var negative = savingsText.indexOf("-") >= 0
              || /\bnegative\b/i.test(savingsText);
            if (negative) {
              showNegativeSavingsWarning(legacyPD);
              return;
            }
            window.generateBrief();
          } catch (e) {
            console.warn("[ROI prefill] generateBrief failed:", e);
          }
        }, 60);
      }
    } catch (e) {
      // URLSearchParams not available — silently skip the deep-link branch.
    }
  }

  function showNegativeSavingsWarning(legacyPD) {
    var existing = document.getElementById("m2-prefill-warning");
    if (existing) existing.remove();
    var legacyDescription = legacyPD
      ? ('Detected legacy PD ($' +
         Number(legacyPD.annual).toLocaleString("en-US") +
         '/yr) is smaller than typical for a district this size.')
      : 'No legacy PD vendor was detected on this district.';
    var div = document.createElement("div");
    div.id = "m2-prefill-warning";
    div.style.cssText = [
      "background: #fff3cd",
      "border: 1px solid #c8a200",
      "border-radius: 8px",
      "padding: 14px 18px",
      "margin: 16px 0",
      "font-family: 'Inter', sans-serif",
      "font-size: 0.92rem",
      "color: #6a4a00"
    ].join(";");
    div.innerHTML =
      '<strong>Cannot auto-generate exec brief — the math is not favorable yet.</strong>' +
      '<div style="margin-top: 8px;">' +
      escapeHTML(legacyDescription) +
      ' With the auto-filled numbers the calculator shows M2 as a net cost over four years rather than a savings.' +
      '</div>' +
      '<div style="margin-top: 8px;">' +
      '<strong>Next step:</strong> enter the actual <em>Legacy PD Contract Total</em> from the district (across the chosen contract term), watch the 4-Year District Savings turn positive, then click <em>Generate Executive Brief</em> manually.' +
      '</div>';
    var container = document.querySelector(".app-container");
    if (container && container.firstChild) {
      container.insertBefore(div, container.firstChild);
    }
  }

  // The calculator's own DOMContentLoaded handler runs calculate() with
  // default values. We register AFTER it (later in the file), so our
  // handler fires next and the input dispatches reflow on prefill.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyPrefill);
  } else {
    applyPrefill();
  }
})();
