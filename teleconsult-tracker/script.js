(function () {
  "use strict";

  /* ---------------- persistence ---------------- */
  var STORAGE_KEY = "teleconsult-tracker-state-v1";

  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function loadStored() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function saveStored(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* no-op */ }
  }

  var stored = loadStored();
  var sameDay = !!(stored && stored.date === todayStr());

  function persist() {
    saveStored({
      date: todayStr(),
      sheetDate: dateInput.value,
      wc: { rostered: wc.rostered, target: wc.target, meds: wc.meds, nomeds: wc.nomeds },
      fhg: { rostered: fhg.rostered, hours: fhg.hours, patients: fhg.patients }
    });
  }

  function fmtMoney(n) {
    var sign = n < 0 ? "-" : "";
    return sign + "$" + Math.round(Math.abs(n)).toLocaleString("en-US");
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmtClock(sec) {
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  /* ---------------- shared date / copy-to-sheet ---------------- */
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var dateInput = document.getElementById("sheetDate");
  var weekdayEl = document.getElementById("sheetWeekday");

  (function initDate() {
    if (sameDay && stored.sheetDate) {
      dateInput.value = stored.sheetDate;
      updateWeekdayFromInput();
      return;
    }
    var now = new Date();
    dateInput.value = now.getDate() + "/" + (now.getMonth() + 1) + "/" + now.getFullYear();
    weekdayEl.textContent = WEEKDAYS[now.getDay()];
  })();

  function updateWeekdayFromInput() {
    var parts = dateInput.value.split("/");
    if (parts.length === 3) {
      var d = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
      if (!isNaN(d.getTime())) { weekdayEl.textContent = WEEKDAYS[d.getDay()]; return; }
    }
    weekdayEl.textContent = "?";
  }
  dateInput.addEventListener("input", function () {
    updateWeekdayFromInput();
    wcRenderStats();
    fhgRenderStats();
    persist();
  });

  // Colors, alignment and the comment-column border read directly off the real
  // Accounts sheet (Aug 2026 tab): Whitecoat rows fill E:I with #f4cccc, Fullerton
  // rows with #9900ff; A-D and J stay white. A/B center, C/D/E/F left, G/H/I right,
  // J left with a black box border (the only column with an explicit border).
  var WHITE = "#ffffff";
  var WC_BG = "#f4cccc";
  var FHG_BG = "#9900ff";
  var COLS = [
    { align: "center" }, { align: "center" }, { align: "left" }, { align: "left" },
    { align: "left" }, { align: "left" }, { align: "right" }, { align: "right" },
    { align: "right" }, { align: "left", border: true }
  ];

  // cells: [Date, Day, Start, End, Company, Venue, Pay/h, Hours, Pay, Comment] -> sheet cols A-J
  function buildRowCells(company, venue, hours, pay, comment, jobBg) {
    var text = [dateInput.value, weekdayEl.textContent, "", "", company, venue, "", String(hours), String(pay), comment];
    var bg = [WHITE, WHITE, WHITE, WHITE, jobBg, jobBg, jobBg, jobBg, jobBg, WHITE];
    return text.map(function (t, i) {
      return { text: t, bg: bg[i], align: COLS[i].align, border: !!COLS[i].border };
    });
  }
  function cellsToTabText(cells) { return cells.map(function (c) { return c.text; }).join("\t"); }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function rowsToHtmlTable(rowsOfCells) {
    var html = '<table style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:12pt;color:#000000;">';
    rowsOfCells.forEach(function (cells) {
      html += "<tr>";
      cells.forEach(function (c) {
        var style = "background-color:" + c.bg + ";text-align:" + c.align + ";padding:1px 4px;";
        style += c.border ? "border:1px solid #000000;" : "border:none;";
        html += '<td style="' + style + '">' + escapeHtml(c.text) + "</td>";
      });
      html += "</tr>";
    });
    html += "</table>";
    return html;
  }

  function copyRows(rowsOfCells, btn, labelEl, defaultLabel) {
    var plainText = rowsOfCells.map(cellsToTabText).join("\n");
    var html = rowsToHtmlTable(rowsOfCells);

    function showCopied() {
      btn.classList.add("copied");
      if (labelEl) labelEl.textContent = "Copied ✓";
      setTimeout(function () {
        btn.classList.remove("copied");
        if (labelEl) labelEl.textContent = defaultLabel;
      }, 1500);
    }

    if (navigator.clipboard && window.ClipboardItem) {
      try {
        var item = new ClipboardItem({
          "text/plain": new Blob([plainText], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" })
        });
        navigator.clipboard.write([item]).then(showCopied, function () { fallbackRichCopy(html); showCopied(); });
        return;
      } catch (e) { /* fall through to fallback below */ }
    }
    fallbackRichCopy(html);
    showCopied();
  }

  // Selects a hidden styled node and uses execCommand('copy') so the background
  // colors/alignment/border still travel with the copy even where the async
  // Clipboard API is unavailable or blocked.
  function fallbackRichCopy(html) {
    var container = document.createElement("div");
    container.setAttribute("contenteditable", "true");
    container.style.position = "fixed";
    container.style.opacity = "0";
    container.style.pointerEvents = "none";
    container.style.top = "0";
    container.style.left = "0";
    container.innerHTML = html;
    document.body.appendChild(container);
    var range = document.createRange();
    range.selectNodeContents(container);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    try { document.execCommand("copy"); } catch (e) { /* no-op */ }
    sel.removeAllRanges();
    document.body.removeChild(container);
  }

  /* ---------------- WC TM ---------------- */
  var wc = {
    rostered: sameDay && stored.wc && typeof stored.wc.rostered === "boolean" ? stored.wc.rostered : true,
    target: stored && stored.wc && typeof stored.wc.target === "number" ? stored.wc.target : 650,
    meds: sameDay && stored.wc ? (stored.wc.meds || 0) : 0,
    nomeds: sameDay && stored.wc ? (stored.wc.nomeds || 0) : 0,
    history: []
  };
  var wcEls = {
    rosteredInput: document.getElementById("wcRostered"),
    rosteredLabel: document.getElementById("wcRosteredLabel"),
    card: document.getElementById("wcCard"),
    target: document.getElementById("wcTarget"),
    medsBtn: document.getElementById("wcMedsBtn"),
    nomedsBtn: document.getElementById("wcNomedsBtn"),
    medsCount: document.getElementById("wcMedsCount"),
    nomedsCount: document.getElementById("wcNomedsCount"),
    patients: document.getElementById("wcPatients"),
    avg: document.getElementById("wcAvg"),
    total: document.getElementById("wcTotal"),
    bar: document.getElementById("wcBar"),
    pct: document.getElementById("wcProgressPct"),
    undo: document.getElementById("wcUndo"),
    reset: document.getElementById("wcReset"),
    copyBtn: document.getElementById("wcCopyBtn"),
    copyBtnText: document.getElementById("wcCopyBtnText"),
    copyPreview: document.getElementById("wcCopyPreview")
  };
  wcEls.target.value = wc.target;
  wcEls.rosteredInput.checked = wc.rostered;
  wcEls.card.dataset.active = String(wc.rostered);
  wcEls.rosteredLabel.textContent = wc.rostered ? "Rostered" : "Not rostered";

  function wcRowCells() {
    var total = wc.meds * 13 + wc.nomeds * 10;
    return buildRowCells("Whitecoat", "TM", 0, Math.round(total), wc.nomeds + "/" + wc.meds, WC_BG);
  }

  // The Accounts sheet's real rows always carry a "Fullerton" reservation row just
  // above the day's Whitecoat row, valued at minus that day's WC TM shift rate
  // (-$650 for a normal 5hr shift, -$250 for a 4hr Inspire-day shift, etc — in
  // practice just -target, since the target IS that day's expected WC TM value).
  // Only makes sense when WC TM is actually rostered.
  function wcReservationRowCells() {
    return buildRowCells("Fullerton", "TM", 0, -wc.target, "", FHG_BG);
  }
  function wcRowsForCopy() {
    return wc.rostered ? [wcReservationRowCells(), wcRowCells()] : [];
  }

  function wcRenderStats() {
    var total = wc.meds * 13 + wc.nomeds * 10;
    var patients = wc.meds + wc.nomeds;
    wcEls.medsCount.textContent = wc.meds;
    wcEls.nomedsCount.textContent = wc.nomeds;
    wcEls.patients.textContent = patients;
    wcEls.avg.textContent = patients ? "$" + (total / patients).toFixed(2) : "—";
    wcEls.total.textContent = fmtMoney(total);
    var pct = wc.target > 0 ? clamp(total / wc.target, 0, 1) : 0;
    wcEls.bar.style.width = (pct * 100) + "%";
    wcEls.bar.classList.toggle("met", total >= wc.target && wc.target > 0);
    wcEls.pct.textContent = Math.round(pct * 100) + "%" + (total >= wc.target && wc.target > 0 ? " — hit!" : "");
    wcEls.copyPreview.textContent = wcRowsForCopy().map(cellsToTabText).join("\n");

    floatEls.wcTotal.textContent = fmtMoney(total);
    floatEls.wcSub.textContent = patients + " patients · " + Math.round(pct * 100) + "% of target";
    floatEls.wcMeds.textContent = "Meds (" + wc.meds + ") +$13";
    floatEls.wcNomeds.textContent = "No meds (" + wc.nomeds + ") +$10";
    floatEls.wcJob.classList.toggle("inactive", !wc.rostered);
    updateCombined();
  }

  function wcSetActive(active) {
    wc.rostered = active;
    wcEls.card.dataset.active = String(active);
    wcEls.rosteredLabel.textContent = active ? "Rostered" : "Not rostered";
    wcRenderStats();
    persist();
  }

  wcEls.rosteredInput.addEventListener("change", function (e) { wcSetActive(e.target.checked); });
  wcEls.target.addEventListener("input", function (e) {
    wc.target = Math.max(0, Number(e.target.value) || 0);
    wcRenderStats();
    persist();
  });
  function wcAddMeds() { wc.meds++; wc.history.push("meds"); wcRenderStats(); persist(); }
  function wcAddNomeds() { wc.nomeds++; wc.history.push("nomeds"); wcRenderStats(); persist(); }
  wcEls.medsBtn.addEventListener("click", wcAddMeds);
  wcEls.nomedsBtn.addEventListener("click", wcAddNomeds);
  wcEls.undo.addEventListener("click", function () {
    var last = wc.history.pop();
    if (last === "meds") wc.meds = Math.max(0, wc.meds - 1);
    if (last === "nomeds") wc.nomeds = Math.max(0, wc.nomeds - 1);
    wcRenderStats();
    persist();
  });
  armReset(wcEls.reset, function () { wc.meds = 0; wc.nomeds = 0; wc.history = []; wcRenderStats(); persist(); });
  wcEls.copyBtn.addEventListener("click", function () {
    copyRows(wcRowsForCopy(), wcEls.copyBtn, wcEls.copyBtnText, "Copy rows for sheet");
  });

  /* ---------------- FHG TM ---------------- */
  var fhg = {
    rostered: sameDay && stored.fhg && typeof stored.fhg.rostered === "boolean" ? stored.fhg.rostered : true,
    hours: stored && stored.fhg && typeof stored.fhg.hours === "number" ? stored.fhg.hours : 5,
    patients: sameDay && stored.fhg ? (stored.fhg.patients || 0) : 0,
    history: [],
    timerRunning: false, elapsedSec: 0, timerHandle: null
  };
  var fhgEls = {
    rosteredInput: document.getElementById("fhgRostered"),
    rosteredLabel: document.getElementById("fhgRosteredLabel"),
    sub: document.getElementById("fhgSub"),
    card: document.getElementById("fhgCard"),
    hours: document.getElementById("fhgHours"),
    derived: document.getElementById("fhgDerived"),
    rosteredOnlyEls: document.querySelectorAll("#fhgCard .rostered-only"),
    patientBtn: document.getElementById("fhgPatientBtn"),
    patientCount: document.getElementById("fhgPatientCount"),
    rateHint: document.getElementById("fhgRateHint"),
    patients: document.getElementById("fhgPatients"),
    baseStat: document.getElementById("fhgBaseStat"),
    base: document.getElementById("fhgBase"),
    total: document.getElementById("fhgTotal"),
    bar: document.getElementById("fhgBar"),
    pct: document.getElementById("fhgProgressPct"),
    progressLabel: document.getElementById("fhgProgressLabel"),
    bonusNote: document.getElementById("fhgBonusNote"),
    pacePill: document.getElementById("fhgPacePill"),
    elapsed: document.getElementById("fhgElapsed"),
    timerBtn: document.getElementById("fhgTimerBtn"),
    undo: document.getElementById("fhgUndo"),
    reset: document.getElementById("fhgReset"),
    copyBtn: document.getElementById("fhgCopyBtn"),
    copyBtnText: document.getElementById("fhgCopyBtnText"),
    copyPreview: document.getElementById("fhgCopyPreview")
  };
  fhgEls.hours.value = fhg.hours;
  fhgEls.rosteredInput.checked = fhg.rostered;
  fhgEls.rosteredOnlyEls.forEach(function (el) { el.style.display = fhg.rostered ? "" : "none"; });
  fhgEls.rosteredLabel.textContent = fhg.rostered ? "Rostered" : "Ad-hoc";
  fhgEls.sub.textContent = fhg.rostered ? "Rostered — hourly + bonus" : "Not rostered — $10/patient, no base";

  function fhgRowCells() {
    if (fhg.rostered) {
      var threshold = fhg.hours * 5;
      var bonusPatients = Math.max(0, fhg.patients - threshold);
      return buildRowCells("Fullerton", "TM", 0, bonusPatients * 10, bonusPatients + " over", FHG_BG);
    }
    return buildRowCells("Fullerton", "TM", 0, fhg.patients * 10, fhg.patients + " adhoc", FHG_BG);
  }

  function fhgRenderStats() {
    var threshold = fhg.hours * 5;
    var base = fhg.hours * 70;
    var bonusPatients = Math.max(0, fhg.patients - threshold);
    var bonus = bonusPatients * 10;
    var total = fhg.rostered ? (base + bonus) : (fhg.patients * 10);

    fhgEls.patientCount.textContent = fhg.patients;
    fhgEls.patients.textContent = fhg.patients;
    fhgEls.total.textContent = fmtMoney(total);

    if (fhg.rostered) {
      fhgEls.baseStat.style.display = "";
      fhgEls.base.textContent = fmtMoney(base);
      fhgEls.derived.innerHTML = "Base pay <b>" + fhg.hours + " × $70 = " + fmtMoney(base) + "</b>. Bonus of <b>$10/patient</b> starts after <b>" + threshold + "</b> patients.";
      fhgEls.rateHint.textContent = "counts toward hourly shift";
      fhgEls.progressLabel.textContent = "Toward " + threshold + " patients";
      var pct = threshold > 0 ? clamp(fhg.patients / threshold, 0, 1) : 0;
      fhgEls.bar.style.width = (pct * 100) + "%";
      fhgEls.bar.classList.toggle("met", fhg.patients >= threshold);
      fhgEls.pct.textContent = Math.round(pct * 100) + "%";
      if (bonusPatients > 0) {
        fhgEls.bonusNote.textContent = "+" + bonusPatients + " beyond threshold → +" + fmtMoney(bonus) + " bonus";
        fhgEls.bonusNote.classList.add("show");
      } else {
        fhgEls.bonusNote.classList.remove("show");
      }
    } else {
      fhgEls.baseStat.style.display = "none";
      fhgEls.rateHint.textContent = "$10 flat, ad-hoc";
      fhgEls.progressLabel.textContent = "Patients seen";
      fhgEls.bar.style.width = clamp(fhg.patients / 10, 0, 1) * 100 + "%";
      fhgEls.bar.classList.remove("met");
      fhgEls.pct.textContent = fhg.patients + " seen";
      fhgEls.bonusNote.classList.remove("show");
    }
    fhgEls.copyPreview.textContent = cellsToTabText(fhgRowCells());

    floatEls.fhgTotal.textContent = fmtMoney(total);
    floatEls.fhgSub.textContent = fhg.rostered
      ? fhg.patients + " / " + threshold + " patients"
      : fhg.patients + " patients (ad-hoc)";
    floatEls.fhgBtn.textContent = "Patient seen (" + fhg.patients + ")";
    updatePace();
    updateCombined();
  }

  function fhgSetActive(rostered) {
    fhg.rostered = rostered;
    fhgEls.rosteredLabel.textContent = rostered ? "Rostered" : "Ad-hoc";
    fhgEls.sub.textContent = rostered ? "Rostered — hourly + bonus" : "Not rostered — $10/patient, no base";
    fhgEls.rosteredOnlyEls.forEach(function (el) { el.style.display = rostered ? "" : "none"; });
    if (!rostered) stopTimer();
    fhgRenderStats();
    persist();
  }

  function updatePace() {
    if (!fhg.rostered) { fhgEls.pacePill.textContent = "—"; fhgEls.pacePill.className = "pill idle"; return; }
    if (!fhg.timerRunning && fhg.elapsedSec === 0) {
      fhgEls.pacePill.textContent = "Timer idle";
      fhgEls.pacePill.className = "pill idle";
      return;
    }
    var elapsedHours = fhg.elapsedSec / 3600;
    var expected = Math.floor(elapsedHours * 5);
    if (fhg.patients >= expected) {
      fhgEls.pacePill.textContent = fhg.patients > expected ? "Ahead of pace" : "On pace";
      fhgEls.pacePill.className = "pill good";
    } else {
      fhgEls.pacePill.textContent = "Behind pace";
      fhgEls.pacePill.className = "pill warn";
    }
  }

  function stopTimer() {
    fhg.timerRunning = false;
    if (fhg.timerHandle) { clearInterval(fhg.timerHandle); fhg.timerHandle = null; }
    fhgEls.timerBtn.textContent = "Start shift timer";
  }

  fhgEls.timerBtn.addEventListener("click", function () {
    if (fhg.timerRunning) {
      stopTimer();
      updatePace();
    } else {
      fhg.timerRunning = true;
      fhgEls.timerBtn.textContent = "Pause timer";
      fhg.timerHandle = setInterval(function () {
        fhg.elapsedSec++;
        fhgEls.elapsed.textContent = fmtClock(fhg.elapsedSec);
        updatePace();
      }, 1000);
    }
  });

  fhgEls.rosteredInput.addEventListener("change", function (e) { fhgSetActive(e.target.checked); });
  fhgEls.hours.addEventListener("input", function (e) {
    fhg.hours = Math.max(1, Number(e.target.value) || 0);
    fhgRenderStats();
    persist();
  });
  function fhgAddPatient() { fhg.patients++; fhg.history.push(1); fhgRenderStats(); persist(); }
  fhgEls.patientBtn.addEventListener("click", fhgAddPatient);
  fhgEls.undo.addEventListener("click", function () {
    if (fhg.history.length) { fhg.history.pop(); fhg.patients = Math.max(0, fhg.patients - 1); fhgRenderStats(); persist(); }
  });
  armReset(fhgEls.reset, function () {
    fhg.patients = 0; fhg.history = []; fhg.elapsedSec = 0;
    stopTimer();
    fhgEls.elapsed.textContent = "00:00";
    fhgRenderStats();
    persist();
  });
  fhgEls.copyBtn.addEventListener("click", function () {
    copyRows([fhgRowCells()], fhgEls.copyBtn, fhgEls.copyBtnText, "Copy row for sheet");
  });

  /* ---------------- shared ---------------- */
  function armReset(btn, doReset) {
    var armed = false;
    var timeout = null;
    var original = btn.textContent;
    btn.addEventListener("click", function () {
      if (!armed) {
        armed = true;
        btn.textContent = "Tap again to confirm";
        btn.classList.add("danger-arm");
        timeout = setTimeout(function () {
          armed = false;
          btn.textContent = original;
          btn.classList.remove("danger-arm");
        }, 3000);
      } else {
        clearTimeout(timeout);
        armed = false;
        btn.textContent = original;
        btn.classList.remove("danger-arm");
        doReset();
      }
    });
  }

  function updateCombined() {
    var wcTotal = wc.rostered ? (wc.meds * 13 + wc.nomeds * 10) : 0;
    var threshold = fhg.hours * 5;
    var fhgTotal = fhg.rostered
      ? (fhg.hours * 70 + Math.max(0, fhg.patients - threshold) * 10)
      : fhg.patients * 10;
    var total = wcTotal + fhgTotal;
    document.getElementById("combinedTotal").textContent = fmtMoney(total);
    floatEls.combinedTotal.textContent = fmtMoney(total);
  }

  var copyBothBtn = document.getElementById("copyBothBtn");
  var copyBothLabel = copyBothBtn.textContent;
  copyBothBtn.addEventListener("click", function () {
    var rows = wcRowsForCopy().concat([fhgRowCells()]);
    copyRows(rows, copyBothBtn, copyBothBtn, copyBothLabel);
  });

  /* ---------------- combined floating tracker ---------------- */
  // One combined panel (not one per job): Chrome only allows a single Document
  // Picture-in-Picture window per page at a time, so both jobs live in it together.
  var floatEls = {
    panel: document.getElementById("floatPanel"),
    head: document.getElementById("floatHead"),
    close: document.getElementById("floatClose"),
    wcJob: document.getElementById("floatWcJob"),
    wcTotal: document.getElementById("floatWcTotal"),
    wcSub: document.getElementById("floatWcSub"),
    wcMeds: document.getElementById("floatWcMeds"),
    wcNomeds: document.getElementById("floatWcNomeds"),
    fhgTotal: document.getElementById("floatFhgTotal"),
    fhgSub: document.getElementById("floatFhgSub"),
    fhgBtn: document.getElementById("floatFhgBtn"),
    combinedTotal: document.getElementById("floatCombinedTotal")
  };
  floatEls.wcMeds.addEventListener("click", wcAddMeds);
  floatEls.wcNomeds.addEventListener("click", wcAddNomeds);
  floatEls.fhgBtn.addEventListener("click", fhgAddPatient);

  var floatBtn = document.getElementById("floatBtn");
  var pipWindow = null;

  var supportsPip = "documentPictureInPicture" in window;

  function copyStylesInto(targetDoc) {
    Array.prototype.forEach.call(document.styleSheets, function (ss) {
      try {
        if (ss.href) {
          var link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = ss.href;
          targetDoc.head.appendChild(link);
        } else if (ss.cssRules) {
          var style = document.createElement("style");
          style.textContent = Array.prototype.map.call(ss.cssRules, function (r) { return r.cssText; }).join("");
          targetDoc.head.appendChild(style);
        }
      } catch (e) { /* cross-origin stylesheet, skip */ }
    });
  }

  function openFloat() {
    if (supportsPip) {
      if (pipWindow) { pipWindow.focus(); return; }
      documentPictureInPicture.requestWindow({ width: 240, height: 340 }).then(function (win) {
        pipWindow = win;
        copyStylesInto(pipWindow.document);
        pipWindow.document.body.style.margin = "0";
        pipWindow.document.body.style.background = "var(--paper)";
        floatEls.panel.classList.add("open", "in-pip");
        pipWindow.document.body.appendChild(floatEls.panel);
        floatBtn.classList.add("active");
        floatBtn.textContent = "Tracker floating ⧉";
        pipWindow.addEventListener("pagehide", function () {
          document.body.appendChild(floatEls.panel);
          floatEls.panel.classList.remove("open", "in-pip");
          floatBtn.classList.remove("active");
          floatBtn.textContent = "Float tracker ⧉";
          pipWindow = null;
        });
      }).catch(function () {
        floatEls.panel.classList.add("open");
        floatBtn.classList.add("active");
      });
    } else {
      floatEls.panel.classList.toggle("open");
      floatBtn.classList.toggle("active");
    }
  }
  function closeFloat() {
    if (pipWindow) { pipWindow.close(); return; }
    floatEls.panel.classList.remove("open");
    floatBtn.classList.remove("active");
  }
  floatBtn.addEventListener("click", function () {
    if (floatEls.panel.classList.contains("open") || pipWindow) { closeFloat(); } else { openFloat(); }
  });
  floatEls.close.addEventListener("click", closeFloat);

  // In-page fallback dragging (only meaningful when not inside a real PiP window,
  // where the browser supplies its own draggable frame).
  (function makeDraggable() {
    var panel = floatEls.panel, handle = floatEls.head;
    var dragging = false, offX = 0, offY = 0;
    handle.addEventListener("pointerdown", function (e) {
      if (panel.classList.contains("in-pip") || e.target.closest(".fp-close")) return;
      dragging = true;
      var rect = panel.getBoundingClientRect();
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var x = clamp(e.clientX - offX, 0, window.innerWidth - panel.offsetWidth);
      var y = clamp(e.clientY - offY, 0, window.innerHeight - panel.offsetHeight);
      panel.style.left = x + "px";
      panel.style.top = y + "px";
      panel.style.right = "auto";
    });
    handle.addEventListener("pointerup", function () { dragging = false; });
  })();

  document.getElementById("pipNote").innerHTML = supportsPip
    ? "<b>&ldquo;Float tracker&rdquo;</b> opens an always-on-top window (Chrome&rsquo;s Document Picture-in-Picture) with both jobs&rsquo; totals and tap buttons &mdash; it stays visible over the Whitecoat/Fullerton tabs and any other app until you close it."
    : "<b>&ldquo;Float tracker&rdquo;</b> needs Chrome&rsquo;s Document Picture-in-Picture support, which this browser doesn&rsquo;t have &mdash; it&rsquo;ll open as a panel pinned to this page instead (drag it by the header), not a true always-on-top window.";

  wcRenderStats();
  fhgRenderStats();
})();
