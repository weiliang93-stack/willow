const RECENTS_KEY = 'taxiCompare.recents';
const MAX_RECENTS = 6;
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

const STORE_LINKS = {
  grab: {
    ios: 'https://apps.apple.com/app/id647268330',
    android: 'https://play.google.com/store/apps/details?id=com.grabtaxi.passenger',
  },
  gojek: {
    ios: 'https://apps.apple.com/us/app/gojek/id944875099',
    android: 'https://play.google.com/store/apps/details?id=com.gojek.app',
  },
  zig: {
    ios: 'https://apps.apple.com/sg/app/cdg-zig-taxis-cars/id954951647',
    android: 'https://play.google.com/store/apps/details?id=com.codigo.comfort',
  },
};

const els = {
  pickupStatus: document.getElementById('pickupStatus'),
  pickupRefresh: document.getElementById('pickupRefresh'),
  destInput: document.getElementById('destInput'),
  suggestions: document.getElementById('suggestions'),
  recentWrap: document.getElementById('recentWrap'),
  recentList: document.getElementById('recentList'),
  selectedDest: document.getElementById('selectedDest'),
  btnGrab: document.getElementById('btnGrab'),
  btnGojek: document.getElementById('btnGojek'),
  btnZig: document.getElementById('btnZig'),
  toast: document.getElementById('toast'),
};

const state = {
  pickup: null, // { lat, lon }
  destination: null, // { label, lat, lon }
  searchTimer: null,
  toastTimer: null,
};

function platform() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    els.toast.classList.remove('visible');
  }, 2200);
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch (e) {
    // clipboard unavailable, nothing more we can do
  }
  document.body.removeChild(ta);
}

// ---- Pickup location ----

function locatePickup() {
  if (!navigator.geolocation) {
    els.pickupStatus.textContent = 'Location unavailable — apps will use their own default';
    return;
  }
  els.pickupStatus.textContent = 'Locating you…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.pickup = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      els.pickupStatus.textContent = 'Pickup: current location';
      updateButtons();
    },
    () => {
      state.pickup = null;
      els.pickupStatus.textContent = 'Location denied — apps will use their own default';
      updateButtons();
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

els.pickupRefresh.addEventListener('click', locatePickup);
locatePickup();

// ---- Destination search ----

els.destInput.addEventListener('input', () => {
  const query = els.destInput.value.trim();
  clearTimeout(state.searchTimer);
  if (query.length < 3) {
    hideSuggestions();
    return;
  }
  state.searchTimer = setTimeout(() => searchDestination(query), 350);
});

async function searchDestination(query) {
  const url = `${NOMINATIM_URL}?format=json&limit=5&addressdetails=0&countrycodes=sg&viewbox=103.55,1.15,104.15,1.50&bounded=1&q=${encodeURIComponent(query)}`;
  let results = [];
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      results = await res.json();
    }
  } catch (e) {
    // network/geocoding failure — show empty state below
  }
  renderSuggestions(results);
}

function renderSuggestions(results) {
  els.suggestions.innerHTML = '';
  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'suggestion-empty';
    empty.textContent = 'No matches — keep typing or try a fuller address';
    els.suggestions.appendChild(empty);
    els.suggestions.classList.add('open');
    return;
  }
  results.forEach((r) => {
    const item = document.createElement('div');
    item.className = 'suggestion-item';
    item.textContent = r.display_name;
    item.addEventListener('click', () => selectDestination({
      label: r.display_name,
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
    }));
    els.suggestions.appendChild(item);
  });
  els.suggestions.classList.add('open');
}

function hideSuggestions() {
  els.suggestions.classList.remove('open');
  els.suggestions.innerHTML = '';
}

function selectDestination(dest) {
  state.destination = dest;
  els.destInput.value = dest.label;
  hideSuggestions();
  renderSelectedDest();
  addRecent(dest);
  updateButtons();
}

function renderSelectedDest() {
  if (!state.destination) {
    els.selectedDest.classList.remove('visible');
    return;
  }
  els.selectedDest.innerHTML = '<span class="label">Destination</span>' + state.destination.label;
  els.selectedDest.classList.add('visible');
}

// ---- Recents ----

function loadRecents() {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveRecents(list) {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
}

function addRecent(dest) {
  let recents = loadRecents().filter((r) => r.label !== dest.label);
  recents.unshift(dest);
  recents = recents.slice(0, MAX_RECENTS);
  saveRecents(recents);
  renderRecents();
}

function renderRecents() {
  const recents = loadRecents();
  els.recentList.innerHTML = '';
  if (!recents.length) {
    els.recentWrap.classList.remove('visible');
    return;
  }
  recents.forEach((r) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'recent-chip';
    chip.textContent = r.label.split(',')[0];
    chip.addEventListener('click', () => selectDestination(r));
    els.recentList.appendChild(chip);
  });
  els.recentWrap.classList.add('visible');
}

renderRecents();

// ---- Deep links ----

function buildGrabLink() {
  const params = new URLSearchParams();
  params.set('screenType', 'BOOKING');
  if (state.pickup) {
    params.set('pickupLatitude', state.pickup.lat);
    params.set('pickupLongitude', state.pickup.lon);
  }
  params.set('dropOffLatitude', state.destination.lat);
  params.set('dropOffLongitude', state.destination.lon);
  params.set('dropOffAddress', state.destination.label);
  return `grab://open?${params.toString()}`;
}

function buildGojekLink() {
  const params = new URLSearchParams();
  params.set('bookingType', 'now');
  params.set('destination', `${state.destination.lon},${state.destination.lat}`);
  return `gojek://transport?${params.toString()}`;
}

// ComfortDelGro's own smart link: opens the Zig app if it's installed,
// otherwise sends the user to the right app/play store listing. There's
// no known way to prefill a destination through it.
function buildZigLink() {
  return 'https://comfortdelgro.onelink.me/1fTR/4b218de6';
}

const SERVICES = {
  grab: { build: buildGrabLink, copyNote: null, useStoreFallback: true },
  gojek: { build: buildGojekLink, copyNote: 'Destination copied — paste it if Gojek didn’t carry it over', useStoreFallback: true },
  zig: { build: buildZigLink, copyNote: 'Destination copied — paste it into Zig', useStoreFallback: false },
};

function openService(service) {
  if (!state.destination) return;

  copyToClipboard(state.destination.label);
  const note = SERVICES[service].copyNote;
  if (note) showToast(note);

  const deepLink = SERVICES[service].build();

  if (SERVICES[service].useStoreFallback) {
    const storeUrl = STORE_LINKS[service][platform()] || STORE_LINKS[service].android;
    const fallbackTimer = setTimeout(() => {
      if (!document.hidden) {
        window.location.href = storeUrl;
      }
    }, 1500);

    document.addEventListener('visibilitychange', function onHide() {
      if (document.hidden) {
        clearTimeout(fallbackTimer);
        document.removeEventListener('visibilitychange', onHide);
      }
    });
  }

  window.location.href = deepLink;
}

function updateButtons() {
  const ready = Boolean(state.destination);
  [els.btnGrab, els.btnGojek, els.btnZig].forEach((btn) => {
    btn.disabled = !ready;
  });
}

els.btnGrab.addEventListener('click', () => openService('grab'));
els.btnGojek.addEventListener('click', () => openService('gojek'));
els.btnZig.addEventListener('click', () => openService('zig'));

document.addEventListener('click', (e) => {
  if (!els.suggestions.contains(e.target) && e.target !== els.destInput) {
    hideSuggestions();
  }
});
