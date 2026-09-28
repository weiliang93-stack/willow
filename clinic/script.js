// Clinic shell: tab navigation between templates-app (embedded unmodified
// as an iframe, exactly the money/ pattern) and teleconsult-tracker's own
// markup (vendored directly into index.html and running in this top-level
// document, not an iframe -- Document Picture-in-Picture refuses to open
// from inside one, see CLAUDE.md). Everything below is just tab-switching
// plus this shell's own sign-in gate; neither embedded app's own code
// changed, and each keeps handling its own auth/state exactly as it does
// standalone -- teleconsult-tracker/script.js still calls its own
// SupaSync.mountAuthGate against the vendored #authGate/#app, independent
// of this shell's gate (harmless and redundant once signed in once, since
// the session is shared via localStorage).

const TAB_STORAGE_KEY = "clinic.activeTab";

function setActiveTab(tab) {
  document.querySelectorAll(".clinic-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.getElementById("panelTemplates").classList.toggle("hidden", tab !== "templates");
  document.getElementById("panelTeleconsult").classList.toggle("hidden", tab !== "teleconsult");
  localStorage.setItem(TAB_STORAGE_KEY, tab);
}

document.getElementById("clinicTabbar").addEventListener("click", function (event) {
  var btn = event.target.closest(".clinic-tab");
  if (!btn) return;
  setActiveTab(btn.dataset.tab);
});

SupaSync.mountAuthGate(document.getElementById("clinicAuthGate"), function () {
  document.getElementById("clinicApp").style.display = "";
  setActiveTab(localStorage.getItem(TAB_STORAGE_KEY) || "templates");
});
