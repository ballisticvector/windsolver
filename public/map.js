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
 *
 * **The relief goes under the wind, and is placed on the bounds the service
 * reports.** The hillshade is the same 3DEP ground the downscaling is computed
 * from, drawn so the terrain the wind is bending around is visible rather than
 * asserted. It is a separate request because it is a separate cost: the ground
 * does not change between cycles and the wind does.
 *
 * **The stations go over the wind, and are drawn as a different kind of mark.**
 * They are the only thing on this map that was measured. A disc with a ring and
 * a heavy arrow against a flat wash with thin ones, above the wash rather than
 * under it, so which is which survives a glance — and a station that reported
 * nothing keeps a hollow marker rather than disappearing or reading as calm.
 *
 * **The disagreement is a mode, not a third layer.** Ticking "colour them by
 * how far the model is out" recolours the same markers on a diverging ramp and
 * refetches with `model=true`, because the model beside each station is a
 * second, opt-in half of the station answer and costs an HRRR subset over the
 * view. Nothing else about the marker changes, and a station whose comparison
 * is refused gets no colour at all rather than a middling one.
 */

/* global L, WindMapLib */

(function () {
  "use strict";

  const lib = WindMapLib;
  const $ = function (id) { return document.getElementById(id); };

  const START = { lat: 40.0150, lon: -105.2705, zoom: 13 };

  // Leaflet comes from a CDN, and a page whose map silently fails to draw reads
  // as a broken service rather than as a blocked script. There is no local copy
  // to fall back to, so the least this can do is say which one it is.
  if (typeof L === "undefined") {
    const status = $("status");
    if (status) {
      status.className = "error";
      status.textContent = "The map library did not load — unpkg.com is unreachable from " +
        "this browser. The service itself is unaffected: /v1/field still answers.";
    }
    const solve = $("solve");
    if (solve) solve.disabled = true;
    return;
  }

  const map = L.map("map", { zoomControl: true, attributionControl: true })
    .setView([START.lat, START.lon], START.zoom);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors | wind: WindSolver (HRRR + 3DEP, modelled)"
  }).addTo(map);

  // Below the wind wash and above the basemap. Leaflet's own overlay pane holds
  // both, so the order is set by pane rather than by the order they are added:
  // a relief drawn over the arrows hides the answer.
  map.createPane("relief");
  map.getPane("relief").style.zIndex = 350;
  map.getPane("relief").style.pointerEvents = "none";

  // Above the wind wash, which is in the overlay pane at 400: a measurement
  // hidden under a model output is the wrong way round on this map.
  map.createPane("stations");
  map.getPane("stations").style.zIndex = 620;

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

  /**
   * The shaded relief: one PNG from `/v1/hillshade`, placed on the bounds the
   * service reports rather than on the box that was asked for.
   *
   * Fetched as a blob rather than set as an `<img src>` so the headers can be
   * read — the placement is in them, and an image element throws them away.
   */
  const relief = {
    layer: null,
    url: null,
    request: null,
    placement: null
  };

  function clearRelief() {
    if (relief.request) relief.request.abort();
    relief.request = null;
    if (relief.layer) {
      // The `src` goes before the URL does. Removing the layer detaches the
      // element but Leaflet re-renders the overlay when the map recentres, and
      // an element still holding a revoked `blob:` asks for it again — a
      // console error on an ordinary path, measured by editing the latitude
      // field, where moving the pin by clicking the map never showed it.
      const img = relief.layer.getElement();
      if (img) img.removeAttribute("src");
      map.removeLayer(relief.layer);
      relief.layer = null;
    }
    if (relief.url) {
      URL.revokeObjectURL(relief.url);
      relief.url = null;
    }
    relief.placement = null;
    setReliefNote("");
  }

  function setReliefNote(text) {
    const el = $("reliefNote");
    if (el) el.textContent = text || "";
  }

  async function loadRelief(lat, lon, radiusMiles) {
    clearRelief();
    if (!$("relief").checked) return;

    const controller = new AbortController();
    relief.request = controller;
    setReliefNote("Reading the ground…");

    let response;
    let blob;
    try {
      response = await fetch(lib.hillshadeQuery({
        lat: lat, lon: lon, radiusMiles: radiusMiles, width: 768
      }), { signal: controller.signal });
      if (!response.ok) {
        const body = await response.json().catch(function () { return null; });
        relief.request = null;
        // A relief that will not load is a missing picture, never a failed
        // solve: the wind is the answer and it does not depend on this.
        return setReliefNote("No relief here — " + lib.explain(body, response.status).text);
      }
      blob = await response.blob();
    } catch (err) {
      relief.request = null;
      if (err && err.name === "AbortError") return;
      return setReliefNote("No relief here — " + (err && err.message));
    }
    relief.request = null;

    const placement = lib.hillshadePlacement(response.headers);
    if (!placement) {
      return setReliefNote("No relief here — the service did not say where the " +
        "picture goes, so it has not been placed.");
    }

    relief.placement = placement;
    relief.url = URL.createObjectURL(blob);
    relief.layer = L.imageOverlay(relief.url, [
      [placement.south, placement.west],
      [placement.north, placement.east]
    ], { opacity: 0.85, pane: "relief", interactive: false }).addTo(map);
    setReliefNote(lib.hillshadeCaption(placement));
  }

  /**
   * The anemometers, drawn over everything else.
   *
   * Deliberately not the same shape as the modelled wind. The field is a flat
   * canvas wash with thin arrows and no outline; a station is a hard-edged disc
   * with a white ring and a heavier arrow, sitting above both the relief and
   * the wash. Someone glancing at the screen has to be able to say which marks
   * were measured and which were computed without reading a legend — that is
   * the entire reason both are on one map.
   *
   * A station that reported nothing keeps its marker and loses its arrow: a
   * hollow ring is "an anemometer is here and it said nothing", which is a fact
   * about the network. Removing it would make the map look healthier than the
   * data.
   */
  const stationLayer = L.layerGroup([], { pane: "stations" }).addTo(map);
  let stationRequest = null;
  let stationTimer = null;

  function setStationNote(text) {
    const el = $("stationNote");
    if (el) el.textContent = text || "";
  }

  /**
   * The marker, in whichever of the two things it can be coloured by.
   *
   * By default the disc is the measured speed, on the same ramp as the wash, so
   * a station reads as "the wind here is this fast". In compare mode it is the
   * ratio to the model on a diverging ramp instead, so the map answers a
   * different question — "where is the model wrong, and by how much" — without
   * anything else about the marker changing: the ring, the arrow, the hollow
   * for a station that reported nothing, all mean what they meant before.
   *
   * A station with no ratio in compare mode is **not** given a colour. It goes
   * grey with a dotted ring, which is the same mark as "no observation" for the
   * same reason: there is nothing to say, and an uncoloured mark is the only
   * way to say that.
   */
  function stationIcon(view, comparison) {
    const size = 30;
    const compare = comparison !== undefined && comparison !== null;
    const ratioFill = compare ? lib.ratioColor(comparison.ratio) : null;
    const ring = view.stale ? "rgba(255,255,255,0.45)" : "#ffffff";
    const fill = compare
      ? (ratioFill || "transparent")
      : (view.reporting ? (view.color || "#8b95a5") : "transparent");
    const dash = (compare ? !ratioFill : !view.reporting)
      ? " stroke-dasharray=\"3 2\""
      : "";
    const parts = [
      "<svg width=\"" + size + "\" height=\"" + size + "\" viewBox=\"0 0 30 30\">",
      "<circle cx=\"15\" cy=\"15\" r=\"6.5\" fill=\"" + fill + "\" stroke=\"" + ring +
        "\" stroke-width=\"2\"" + dash + "/>"
    ];
    // An arrow only when there is a direction to draw. Calm has no direction,
    // and a marker with no observation has no wind at all.
    if (view.reporting && !view.calm && Number.isFinite(view.towardDeg)) {
      parts.push("<g transform=\"rotate(" + view.towardDeg.toFixed(1) + " 15 15)\">" +
        "<path d=\"M15 2 L15 9\" stroke=\"" + ring + "\" stroke-width=\"2.4\" " +
        "stroke-linecap=\"round\" transform=\"rotate(180 15 15)\"/>" +
        "<path d=\"M15 26 L11.6 20.5 L18.4 20.5 Z\" fill=\"" + ring + "\"/></g>");
    }
    parts.push("</svg>");
    return L.divIcon({
      html: parts.join(""),
      className: "station-marker",
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2]
    });
  }

  /**
   * Built when the popup opens, not when the marker is drawn.
   *
   * The comparison needs a solved field, and the stations usually arrive
   * first: content fixed at draw time would say "nothing has been solved here
   * yet" for the rest of the session, on a page where the answer is one click
   * away.
   */
  function stationPopup(view, modelComparison) {
    const lines = view.lines.slice();
    if (modelComparison) {
      if (modelComparison.modelSpeedMph === null) {
        lines.push("No model wind here: " + modelComparison.reason + ".");
      } else {
        lines.push("HRRR at this station: " +
          modelComparison.modelSpeedMph.toFixed(1) + " mph" +
          (modelComparison.modelFromDeg === null
            ? ""
            : " from " + Math.round(modelComparison.modelFromDeg) + "\u00b0") +
          (modelComparison.comparable && modelComparison.ratio !== null
            ? " — " + modelComparison.ratio.toFixed(2) + "x measured"
            : "") +
          (modelComparison.comparable && modelComparison.directionDeltaDeg !== null
            ? ", " + Math.abs(Math.round(modelComparison.directionDeltaDeg)) + "\u00b0 " +
              (modelComparison.directionDeltaDeg >= 0 ? "clockwise" : "anticlockwise")
            : ""));
        // The calm case, which has no ratio and is not a small disagreement.
        if (modelComparison.measuredCalm) {
          lines.push("Measured calm, so there is no ratio — the model is not " +
            "a multiple of nothing.");
        }
        if (!modelComparison.comparable && modelComparison.reason) {
          lines.push("Not compared: " + modelComparison.reason + ".");
        }
        lines.push(modelComparison.heightNote);
      }
    }
    const comparison = lib.compareStationToField(view, lastField);
    if (comparison.comparable) {
      const modelled = comparison.modelSpeedMph.toFixed(1) + " mph";
      lines.push("Modelled here: " + modelled +
        (comparison.ratio === null ? "" : " — " + comparison.ratio.toFixed(2) + "x measured") +
        (comparison.directionDeltaDeg === null
          ? ""
          : ", " + Math.abs(Math.round(comparison.directionDeltaDeg)) + "\u00b0 " +
            (comparison.directionDeltaDeg >= 0 ? "clockwise" : "anticlockwise")));
      lines.push(comparison.heightNote);
    } else if (comparison.reason) {
      lines.push("Not compared with the model: " + comparison.reason + ".");
    }
    const escape = function (text) {
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML;
    };
    return "<strong>" + escape(view.name) + "</strong><br>" +
      lines.map(escape).join("<br>");
  }

  /**
   * Draws the markers and returns the comparisons it drew them from.
   *
   * Returned rather than recomputed for the caption: the caption's median and
   * the colours on the map have to come from one pass, or the day they disagree
   * is the day a reader believes the wrong one.
   */
  function drawStations(body, compare) {
    stationLayer.clearLayers();
    if (!body || !body.ok) return [];
    const comparisons = [];
    for (const station of body.stations) {
      const view = lib.stationView(station);
      const comparison = compare
        ? lib.compareStationToModel(view, station, body)
        : null;
      if (comparison) comparisons.push(comparison);
      const marker = L.marker([view.lat, view.lon], {
        icon: stationIcon(view, comparison),
        pane: "stations",
        title: view.title,
        // Keyboard-reachable, and above the pin only when hovered: a station is
        // information, the pin is the control.
        riseOnHover: true
      });
      marker.bindPopup(function () { return stationPopup(view, comparison); });
      stationLayer.addLayer(marker);
    }
    return comparisons;
  }

  function clearStations() {
    if (stationRequest) stationRequest.abort();
    stationRequest = null;
    stationLayer.clearLayers();
    setStationNote("");
  }

  /** The ratio ramp, shown only while the markers are actually using it. */
  function renderCompareKey(on) {
    const box = $("compareKey");
    if (!box) return;
    box.hidden = !on;
    if (!on || box.dataset.drawn === "1") return;
    const bar = $("ratioLegend");
    const scale = $("ratioScale");
    for (const stop of lib.RATIO_STOPS) {
      const span = document.createElement("span");
      span.style.background = stop.color;
      span.title = stop.label;
      bar.appendChild(span);
      const tick = document.createElement("span");
      tick.textContent = stop.label;
      scale.appendChild(tick);
    }
    box.dataset.drawn = "1";
  }

  async function loadStations() {
    const compare = $("stations").checked && $("compare").checked;
    renderCompareKey(compare);
    if (!$("stations").checked) return clearStations();
    if (stationRequest) stationRequest.abort();

    const bounds = map.getBounds();
    const spec = lib.viewSpec({
      north: bounds.getNorth(), south: bounds.getSouth(),
      east: bounds.getEast(), west: bounds.getWest()
    });

    const controller = new AbortController();
    stationRequest = controller;
    setStationNote(compare
      ? "Reading the anemometers, and the model over them…"
      : "Reading the anemometers…");

    let body;
    try {
      const response = await fetch(lib.stationsQuery({
        lat: spec.lat, lon: spec.lon, radiusMiles: spec.radiusMiles, limit: 60,
        model: compare
      }), { signal: controller.signal });
      body = await response.json().catch(function () { return null; });
      if (!response.ok || !body || !body.ok) {
        stationRequest = null;
        stationLayer.clearLayers();
        // A station outage is not a failed solve, exactly as a missing relief
        // is not: the modelled wind does not depend on this request.
        return setStationNote("No stations — " + lib.explain(body, response.status).text);
      }
    } catch (err) {
      stationRequest = null;
      if (err && err.name === "AbortError") return;
      stationLayer.clearLayers();
      return setStationNote("No stations — " + (err && err.message));
    }
    stationRequest = null;

    const comparisons = drawStations(body, compare);
    setStationNote(lib.stationsCaption(body, lib.modelSummary(comparisons)) +
      (spec.capped ? " · zoom in: only the nearest are shown" : ""));
  }

  /** Panning re-asks, once the map has stopped: one request per view, not per pixel. */
  function scheduleStations() {
    if (stationTimer) clearTimeout(stationTimer);
    stationTimer = setTimeout(loadStations, 400);
  }

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
    lastField = body;

    clearDomain();
    domainOutline = L.rectangle(
      [[body.domain.south, body.domain.west], [body.domain.north, body.domain.east]],
      { color: "#58a6ff", weight: 1, fill: false, dashArray: "4 4", interactive: false }
    ).addTo(map);
  }

  let inFlight = null;
  // The last successful field, kept only so a station popup can say what the
  // model made of the same place. Cleared with the wind it belongs to.
  let lastField = null;

  function clearDomain() {
    if (!domainOutline) return;
    map.removeLayer(domainOutline);
    domainOutline = null;
  }

  /**
   * Everything drawn for one answer, taken off the map together — including
   * the answer still on its way.
   *
   * A solve that lands after the pin has moved paints a field for the box it
   * was asked about, under a heading that says "At the pin", and the pin is
   * somewhere else. Clearing the canvas cannot help with that: the request has
   * to be abandoned, not just the pixels.
   */
  function clearField() {
    clearWind();
    clearRelief();
  }

  /**
   * The wind alone. A refused solve is not a reason to abandon the ground: the
   * box has not moved, the relief is a separate request over separate data, and
   * aborting it mid-flight silences its own refusal — at Paris the wind said
   * "no terrain" in full and the relief line said nothing at all.
   */
  function clearWind() {
    if (inFlight) inFlight.abort();
    fieldLayer.clear();
    lastField = null;
    clearDomain();
    $("result").hidden = true;
  }

  async function solve() {
    const lat = Number($("lat").value);
    const lon = Number($("lon").value);
    const radiusMiles = Number($("radius").value);
    const cols = Number($("cols").value);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return setStatus("Latitude and longitude have to be numbers.", "error");
    }

    renderApiExample(lat, lon, radiusMiles);
    // Alongside the solve rather than after it: the ground is cached
    // separately and costs no weather, so the relief usually arrives while the
    // wind is still being fetched.
    loadRelief(lat, lon, radiusMiles);

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
      clearWind();
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
    clearField();
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

  $("relief").addEventListener("change", function () {
    if (!$("relief").checked) return clearRelief();
    loadRelief(Number($("lat").value), Number($("lon").value), Number($("radius").value));
  });

  $("stations").addEventListener("change", function () {
    $("compareRow").classList.toggle("off", !$("stations").checked);
    $("compare").disabled = !$("stations").checked;
    if (!$("stations").checked) {
      renderCompareKey(false);
      return clearStations();
    }
    loadStations();
  });

  // A refetch rather than a recolour: the model is a second, opt-in half of the
  // station answer, and the markers already on screen were fetched without it.
  $("compare").addEventListener("change", loadStations);

  // The stations belong to the view rather than to the pin: they are what is on
  // screen, not what was solved. Debounced, so a drag is one request.
  map.on("moveend zoomend", scheduleStations);

  for (const id of ["lat", "lon"]) {
    $(id).addEventListener("change", function () {
      const lat = Number($("lat").value);
      const lon = Number($("lon").value);
      if (Number.isFinite(lat) && Number.isFinite(lon)) moveTo(lat, lon, { pan: true });
    });
  }

  for (const id of ["radius", "cols"]) {
    $(id).addEventListener("change", function () {
      clearField();
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
  loadStations();
  setStatus("Drag the pin or click the map, then solve.", "");
})();
