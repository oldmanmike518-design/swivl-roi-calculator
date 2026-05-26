/* Swivl ROI Calculator — scan pre-fill bridge.

   When the calculator is opened with a scan payload in
   sessionStorage["m2_scan_for_roi"], this script maps scan fields onto
   the calculator's inputs and triggers a recompute. When no payload is
   present the calculator stays at its default values (standalone mode
   — unchanged behavior).

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

  var SESSION_KEY = "m2_scan_for_roi";

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
    try {
      var raw = window.sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      console.warn("[ROI prefill] could not read scan from sessionStorage:", e);
      return null;
    }
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

  // Legacy PD: prefer sum of sourced PD-consultant annual spend
  // (defensible — specifically named firms with payment/board evidence).
  // Fall back to F-33 function 2200 (broader, less specific). Returns
  // { annual, source } or null.
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
        source: "Detected PD firms with sourced annual spend: " + firms.join(", ")
      };
    }
    var sp = scan.spend_profile
      || (scan.data_confidence && scan.data_confidence.pd_coaching_spend)
      || null;
    var f33 = sp && (sp.instructional_staff_support_2200 || sp.value);
    if (f33 && f33 > 0) {
      return {
        annual: Math.round(f33),
        source: "F-33 function 2200 (instructional staff support — broader than PD vendor contracts; verify with district CFO)"
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

  function showBanner(scan, legacyPD) {
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
    if (legacyPD && legacyPD.source) {
      lines.push(
        '<div style="margin-top: 6px; font-size: 0.82rem; color: #666;">' +
        '<strong>Legacy PD Contract Total source:</strong> ' +
        escapeHTML(legacyPD.source) +
        '</div>'
      );
    }
    lines.push(
      '<div style="margin-top: 6px; font-size: 0.82rem; color: #666;">' +
      'Cohort splits + staff counts are heuristics derived from NCES — adjust any field before generating the brief.' +
      '</div>'
    );
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

  function applyPrefill() {
    var scan = readScan();
    if (!scan) return;  // standalone mode — calculator stays at defaults

    var p = scan.nces_profile || {};
    var districtLabel = (scan.district_name || "") + (scan.state ? ", " + scan.state : "");
    setField("in-district-name", districtLabel);

    var totalBldgs = Number(p.schools) || 0;
    var split = splitSchools(totalBldgs, p.locale_label);
    setField("elem-bldgs", split.eB);
    setField("mid-bldgs", split.mB);
    setField("high-bldgs", split.hB);

    // Standard grade-band lengths — leave the rep's values intact when the
    // scan has no NCES profile, otherwise normalize.
    if (p && (p.enrollment || p.teachers_fte)) {
      setField("elem-grades", GRADES_PER_BLDG.elem);
      setField("mid-grades", GRADES_PER_BLDG.mid);
      setField("high-grades", GRADES_PER_BLDG.high);
    }

    var tchrs = teachersPerGrade(Number(p.teachers_fte) || 0, split.eB, split.mB, split.hB);
    if (tchrs) {
      setField("elem-tchrs", tchrs);
      setField("mid-tchrs", tchrs);
      setField("high-tchrs", tchrs);
    }

    var staff = staffPerBldg(p, split.eB + split.mB + split.hB);
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

    showBanner(scan, legacyPD);

    // Deep-link: ?view=brief auto-invokes the print/brief flow once the
    // prefill is in place.
    try {
      var params = new URLSearchParams(window.location.search);
      if (params.get("view") === "brief" && typeof window.generateBrief === "function") {
        // Slight defer so the synchronous calculate() reruns finish first.
        setTimeout(function () {
          try { window.generateBrief(); } catch (e) {
            console.warn("[ROI prefill] generateBrief failed:", e);
          }
        }, 60);
      }
    } catch (e) {
      // URLSearchParams not available — silently skip the deep-link branch.
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
