/**
 * The map page: a pin on real ground, and the wind WindSolver reads over it.
 *
 * The arithmetic is in `wind-map.js` and is tested; this file is the parts a
 * test cannot see — Leaflet, a canvas, and the DOM. Keep it that way: anything
 * here that could be wrong without being visible belongs next door.
 *
 * Three decisions worth keeping.
 *
 * **An uncovered cell is drawn as nothing.** Not as calm, not as an
 * interpolation of its neighbours. `/v1/field` returns `null` where no terrain
 * was read, and the basemap showing through is the only honest way to draw
 * that.
 *
 * **The first solve over new ground is slow and the page says so before it is
 * asked to.** A cold request reads 3DEP and pulls an HRRR cycle, and USGS has
 * been measured refusing requests entirely. A spinner with no explanation reads
 * as a broken site; the service's own refusal, quoted, does not.
 *
 * **The provenance panel is rendered from the answer, every time.** There is no
 * path through this file that draws a wind without also drawing where it came
 * from and that it is modelled.
 */

/* global L, WindMapLib */

(function () {
  "use strict";

  const lib = WindMapLib;
  const $ = function (id) { return document.getElementById(id); };

  const START = { lat: 40.0150, lon: -105.2705, zoom: 13 };

  const map = L.map("map", { zoomControl: true, attributionControl: true })
    .setView([START.lat, START.lon], START.zoom);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors | wind: WindSolver (HRRR + 3DEP, modelled)"
  }).addTo(map);

  const pin = L.marker([START.lat, START.lon], { draggable: true }).addTo(map);
  let domainOutline = null;

  /**
   * The field, drawn on a canvas pinned to the map.
   *
   * A canvas rather than one Leaflet object per cell: a 48 x 48 field is 2,304
   * cells, and 2,304 layers is a page that stutters when it pans.
   */
  const FieldLayer = L.Layer.extend({
    onAdd: function (m) {
      this._map = m;
      this._canvas = L.DomUtil.create("canvas", "leaflet-zoom-animated");
      this._canvas.style.pointerEvents = "none";
      m.getPanes().overlayPane.appendChild(this._canvas);
      m.on("moveend zoomend resize", this._reset, this);
      this._reset();
    },
    onRemove: function (m) {
      m.off("moveend zoomend resize", this._reset, this);
      L.DomUtil.remove(this._canvas);
    },
    setField: function (body) {
      this._body = body;
      this._reset();
    },
    clear: function () {
      this._body = null;
      this._reset();
    },
    _reset: function () {
      if (!this._map) return;
      const size = this._map.getSize();
      const corner = this._map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, corner);
      this._canvas.width = size.x;
      this._canvas.height = size.y;
      this._canvas.style.width = size.x + "px";
      this._canvas.style.height = size.y + "px";
      this._draw();
    },
    _draw: function () {
      const ctx = this._canvas.getContext("2d");
      ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      const body = this._body;
      if (!body) return;

      const grid = body.grid;
      const m = this._map;
      const point = function (lat, lon) { return m.latLngToContainerPoint([lat, lon]); };

      // Cell size on screen, from two neighbouring grid lines rather than from
      // the zoom: the grid is regular in degrees and the screen is not.
      const a = point(grid.lats[0], grid.lons[0]);
      const b = point(grid.lats[Math.min(1, grid.rows - 1)], grid.lons[Math.min(1, grid.cols - 1)]);
      const cellW = Math.max(1, Math.abs(b.x - a.x));
      const cellH = Math.max(1, Math.abs(b.y - a.y));

      // The speed wash. Uncovered cells are skipped, so the basemap shows
      // through wherever no terrain was read.
      ctx.globalAlpha = 0.45;
      for (const cell of lib.cellsOf(grid)) {
        if (!cell.covered) continue;
        const p = point(cell.lat, cell.lon);
        ctx.fillStyle = lib.speedColor(cell.speedMps);
        ctx.fillRect(p.x - cellW / 2, p.y - cellH / 2, cellW + 1, cellH + 1);
      }

      // The arrows, thinned to a count the eye can read.
      ctx.globalAlpha = 0.95;
      const stride = lib.strideFor(grid, 320);
      const length = Math.min(26, Math.max(9, Math.min(cellW, cellH) * stride * 0.8));
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = "rgba(12,16,22,0.85)";
      for (const cell of lib.cellsOf(grid, { stride: stride })) {
        if (!cell.covered) continue;
        this._arrow(ctx, point(cell.lat, cell.lon), cell, length);
      }
      ctx.globalAlpha = 1;
    },
    /** One arrow, pointing the way the air is going, not the way it is from. */
    _arrow: function (ctx, p, cell, length) {
      const towardDeg = (cell.fromDeg + 180) % 360;
      const rad = (towardDeg * Math.PI) / 180;
      // Screen axes: x east, y south. A bearing is clockwise from north.
      const dx = Math.sin(rad) * length;
      const dy = -Math.cos(rad) * length;
      const x0 = p.x - dx / 2;
      const y0 = p.y - dy / 2;
      const x1 = p.x + dx / 2;
      const y1 = p.y + dy / 2;

      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();

      const head = Math.max(3, length * 0.32);
      const spread = 0.42;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - head * Math.sin(rad - spread), y1 + head * Math.cos(rad - spread));
      ctx.lineTo(x1 - head * Math.sin(rad + spread), y1 + head * Math.cos(rad + spread));
      ctx.closePath();
      ctx.fillStyle = "rgba(12,16,22,0.85)";
      ctx.fill();
    }
  });

  const fieldLayer = new FieldLayer();
  fieldLayer.addTo(map);

  function setStatus(text, kind) {
    const el = $("status");
    el.textContent = text || "";
    el.className = kind || "";
  }

  function renderLegend() {
    const bar = $("legend");
    const scale = $("legendScale");
    bar.innerHTML = "";
    scale.innerHTML = "";
    for (const stop of lib.SPEED_STOPS) {
      const span = document.createElement("span");
      span.style.background = stop.color;
      span.title = stop.label + " mph and up";
      bar.appendChild(span);
      const tick = document.createElement("span");
      tick.textContent = stop.label;
      scale.appendChild(tick);
    }
  }

  function renderApiExample(lat, lon, radiusMiles) {
    $("apiExample").textContent = location.origin + lib.fieldQuery({
      lat: lat, lon: lon, radiusMiles: radiusMiles
    });
  }

  function render(body) {
    const centre = lib.centreWind(body.grid);
    const summary = lib.summarise(body);

    $("result").hidden = false;
    if (centre) {
      $("speed").textContent = centre.speedMph.toFixed(1);
      $("dir").textContent = Math.round(centre.fromDeg) + "\u00b0 " + lib.compassOf(centre.fromDeg);
      $("ground").textContent = centre.elevationM === null
        ? "not read"
        : Math.round(centre.elevationM) + " m";
    } else {
      $("speed").textContent = "—";
      $("dir").textContent = "no terrain";
      $("ground").textContent = "not read";
    }

    const speeds = lib.cellsOf(body.grid)
      .filter(function (c) { return c.covered; })
      .map(function (c) { return c.speedMph; });
    $("spread").textContent = speeds.length
      ? Math.min.apply(null, speeds).toFixed(1) + " to " + Math.max.apply(null, speeds).toFixed(1) + " mph"
      : "nothing covered";
    $("agl").textContent = body.heightAglM === null ? "—" : body.heightAglM + " m";

    const prov = $("prov");
    prov.innerHTML = "";
    for (const line of summary.lines) {
      const div = document.createElement("div");
      div.textContent = line;
      prov.appendChild(div);
    }
    $("notice").textContent = summary.notice || "";

    fieldLayer.setField(body);

    if (domainOutline) map.removeLayer(domainOutline);
    domainOutline = L.rectangle(
      [[body.domain.south, body.domain.west], [body.domain.north, body.domain.east]],
      { color: "#58a6ff", weight: 1, fill: false, dashArray: "4 4", interactive: false }
    ).addTo(map);
  }

  let inFlight = null;

  async function solve() {
    const lat = Number($("lat").value);
    const lon = Number($("lon").value);
    const radiusMiles = Number($("radius").value);
    const cols = Number($("cols").value);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return setStatus("Latitude and longitude have to be numbers.", "error");
    }

    renderApiExample(lat, lon, radiusMiles);

    if (inFlight) inFlight.abort();
    const controller = new AbortController();
    inFlight = controller;

    $("solve").disabled = true;
    setStatus("Solving. A first look at new ground reads real terrain and pulls a " +
      "live weather cycle, which takes a few seconds — sometimes longer if USGS is slow.",
    "working");

    const started = Date.now();
    let response;
    let body = null;
    try {
      response = await fetch(lib.fieldQuery({
        lat: lat, lon: lon, radiusMiles: radiusMiles, cols: cols
      }), { signal: controller.signal });
      body = await response.json().catch(function () { return null; });
    } catch (err) {
      $("solve").disabled = false;
      inFlight = null;
      if (err && err.name === "AbortError") return;
      return setStatus("WindSolver could not be reached: " + (err && err.message), "error");
    }

    $("solve").disabled = false;
    inFlight = null;

    if (!response.ok || !body || !body.ok) {
      // The service's own words, kept. A refusal it took the trouble to name is
      // more useful to whoever is looking at this than anything invented here.
      const explained = lib.explain(body, response.status);
      fieldLayer.clear();
      $("result").hidden = true;
      return setStatus(explained.text, "error");
    }

    render(body);
    setStatus("Solved in " + ((Date.now() - started) / 1000).toFixed(1) + " s.", "");
  }

  function moveTo(lat, lon, opts) {
    $("lat").value = lat.toFixed(4);
    $("lon").value = lon.toFixed(4);
    pin.setLatLng([lat, lon]);
    if (opts && opts.pan) map.panTo([lat, lon]);
    // The old field belongs to the old pin. Leaving it on screen under a moved
    // marker is a wind attributed to ground it was never solved over.
    fieldLayer.clear();
    $("result").hidden = true;
    renderApiExample(lat, lon, Number($("radius").value));
    setStatus("Pin moved. Solve to read the wind here.", "");
  }

  pin.on("dragend", function () {
    const p = pin.getLatLng();
    moveTo(p.lat, p.lng);
  });

  map.on("click", function (e) {
    moveTo(e.latlng.lat, e.latlng.lng);
  });

  $("solve").addEventListener("click", solve);

  for (const id of ["lat", "lon"]) {
    $(id).addEventListener("change", function () {
      const lat = Number($("lat").value);
      const lon = Number($("lon").value);
      if (Number.isFinite(lat) && Number.isFinite(lon)) moveTo(lat, lon, { pan: true });
    });
  }

  for (const id of ["radius", "cols"]) {
    $(id).addEventListener("change", function () {
      fieldLayer.clear();
      $("result").hidden = true;
      renderApiExample(Number($("lat").value), Number($("lon").value), Number($("radius").value));
      setStatus("Box changed. Solve to read it.", "");
    });
  }

  $("locate").addEventListener("click", function () {
    if (!navigator.geolocation) {
      return setStatus("This browser will not say where it is.", "error");
    }
    setStatus("Asking the browser where you are…", "working");
    navigator.geolocation.getCurrentPosition(function (pos) {
      moveTo(pos.coords.latitude, pos.coords.longitude, { pan: true });
      map.setZoom(13);
      solve();
    }, function (err) {
      setStatus("The browser would not say where you are: " + err.message, "error");
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
  });

  renderLegend();
  renderApiExample(START.lat, START.lon, 1);
  setStatus("Drag the pin or click the map, then solve.", "");
})();
