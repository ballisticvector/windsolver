const geo = require("../geo");
const dem = require("../dem");
const hrrr = require("../hrrr");

// WindSolver ingestion: turning a coordinate into the terrain and atmosphere to
// fetch. No network here — request building is separated from request making
// precisely so this suite can pin the parts that get silently wrong: box
// ordering, which DEM product we settle for, and cycle arithmetic.
//
// The coordinate throughout is the one from the design document, 36.77 -104.49
// in the Sangre de Cristos, where 1 m lidar does exist.

const LAT = 36.77;
const LON = -104.49;

describe("geo — domains", () => {
  test("a box is square in metres, so wider in longitude than latitude", () => {
    const box = geo.boundingBox(LAT, LON, 2);
    expect(geo.widthMiles(box)).toBeCloseTo(4, 1);
    expect(geo.heightMiles(box)).toBeCloseTo(4, 1);
    // 4 miles of longitude at 37 degrees north is more degrees than 4 miles of latitude.
    expect(box.east - box.west).toBeGreaterThan(box.north - box.south);
  });

  test("the point sits inside its own box, and the corners do not", () => {
    const box = geo.boundingBox(LAT, LON, 2);
    expect(geo.containsPoint(box, LAT, LON)).toBe(true);
    expect(geo.containsPoint(box, LAT + 1, LON)).toBe(false);
    expect(geo.containsPoint(box, LAT, LON - 1)).toBe(false);
  });

  test("the simulation domain is much larger than what gets displayed", () => {
    const d = geo.simulationDomain(LAT, LON, 2);
    // A ridge outside the picture still bends the wind inside it.
    expect(geo.widthMiles(d.simulation)).toBeGreaterThan(geo.widthMiles(d.display) * 2);
    expect(geo.containsPoint(d.simulation, d.display.north, d.display.east)).toBe(true);
  });

  test("longitude degrees shrink towards the poles and never reach zero", () => {
    expect(geo.metersPerDegLon(0)).toBeCloseTo(geo.METERS_PER_DEG_LAT, 0);
    expect(geo.metersPerDegLon(60)).toBeLessThan(geo.metersPerDegLon(0) * 0.51);
    // Without a floor, a domain at the pole asks for the whole planet.
    expect(geo.metersPerDegLon(90)).toBeGreaterThan(0);
    expect(isFinite(geo.boundingBox(89.999, 0, 2).east)).toBe(true);
  });

  test("latitude is clamped at the poles rather than wrapping past them", () => {
    const box = geo.boundingBox(89.99, 0, 50);
    expect(box.north).toBeLessThanOrEqual(90);
  });

  test("bad input is refused rather than producing an empty domain", () => {
    expect(() => geo.boundingBox(NaN, LON, 2)).toThrow();
    expect(() => geo.boundingBox(LAT, LON, 0)).toThrow();
    expect(() => geo.boundingBox(LAT, LON, -1)).toThrow();
  });

  test("bboxParam emits west,south,east,north", () => {
    const parts = geo.bboxParam({ west: -104.6, south: 36.7, east: -104.4, north: 36.9 }).split(",").map(Number);
    expect(parts[0]).toBeCloseTo(-104.6, 4);
    expect(parts[1]).toBeCloseTo(36.7, 4);
    expect(parts[2]).toBeCloseTo(-104.4, 4);
    expect(parts[3]).toBeCloseTo(36.9, 4);
    // Transposing this is the classic way to fetch terrain for the wrong place.
    expect(parts[0]).toBeLessThan(parts[2]);
    expect(parts[1]).toBeLessThan(parts[3]);
  });
});

describe("geo — coverage", () => {
  const box = { west: 0, south: 0, east: 1, north: 1 };

  test("no tiles is no coverage", () => {
    expect(geo.coverageFraction(box, [])).toBe(0);
  });

  test("one tile swallowing the box is full coverage", () => {
    expect(geo.coverageFraction(box, [{ west: -1, south: -1, east: 2, north: 2 }])).toBe(1);
  });

  test("a tile over half the box is about half", () => {
    const c = geo.coverageFraction(box, [{ west: 0, south: 0, east: 0.5, north: 1 }]);
    expect(c).toBeGreaterThan(0.45);
    expect(c).toBeLessThan(0.55);
  });

  test("overlapping tiles are not double counted", () => {
    const c = geo.coverageFraction(box, [
      { west: 0, south: 0, east: 0.6, north: 1 },
      { west: 0.4, south: 0, east: 1, north: 1 }
    ]);
    expect(c).toBe(1);
  });
});

describe("dem — request building", () => {
  test("the query carries the dataset tag verbatim and the box in TNM order", () => {
    const box = geo.boundingBox(LAT, LON, 2);
    const url = new URL(dem.productsUrl(dem.datasetById("1m").tag, box));
    expect(url.origin + url.pathname).toBe(dem.TNM_PRODUCTS_URL);
    // Read from the live /datasets endpoint; a near-miss returns an empty list
    // rather than an error, so this string is load bearing.
    expect(url.searchParams.get("datasets")).toBe("Digital Elevation Model (DEM) 1 meter");
    const bbox = url.searchParams.get("bbox").split(",").map(Number);
    expect(bbox[0]).toBeLessThan(bbox[2]);
    expect(bbox[1]).toBeLessThan(bbox[3]);
  });

  test("datasets are ordered finest first", () => {
    const res = dem.DATASETS.map(d => d.resolutionM);
    expect(res).toEqual([...res].sort((a, b) => a - b));
  });
});

describe("dem — parsing a National Map response", () => {
  // Shaped from a real /products response for the design document's coordinate.
  const RESPONSE = {
    total: 2,
    items: [
      {
        title: "USGS 1 Meter 13 x54y407 NM_NRCS_FEMA_Northeast_2017",
        sourceId: "60ddff8cd34e3a6dca28f2be",
        format: "GeoTIFF",
        downloadURL: "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/NM_NRCS_FEMA_Northeast_2017/TIFF/USGS_1M_13_x54y407_NM_NRCS_FEMA_Northeast_2017.tif",
        boundingBox: { minX: -104.552, maxX: -104.44, minY: 36.684, maxY: 36.775 },
        publicationDate: "2021-06-08"
      },
      { title: "no footprint", boundingBox: null }
    ]
  };

  test("items are normalised and unplaceable ones dropped", () => {
    const parsed = dem.parseProducts(RESPONSE);
    expect(parsed.items).toHaveLength(1);
    const it = parsed.items[0];
    expect(it.format).toBe("GeoTIFF");
    expect(it.downloadUrl).toMatch(/^https:\/\/prd-tnm\.s3\.amazonaws\.com\//);
    expect(it.box.west).toBeCloseTo(-104.552, 3);
    expect(it.box.north).toBeCloseTo(36.775, 3);
  });

  test("a tile we cannot place is not counted towards coverage", () => {
    // Dropping it is the point: counting a footprint-less tile would overstate
    // what we have and pick a product that does not cover the domain.
    expect(dem.parseProducts(RESPONSE).items.every(i => i.box)).toBe(true);
  });

  test("an empty response parses rather than throwing", () => {
    expect(dem.parseProducts({ total: 0, items: [] }).items).toHaveLength(0);
    expect(dem.parseProducts({}).items).toHaveLength(0);
    expect(dem.parseProducts(null).items).toHaveLength(0);
  });

  test("re-flown ground keeps only the newest vintage", () => {
    const box = { minX: -105, maxX: -104, minY: 36, maxY: 37 };
    const parsed = dem.parseProducts({
      items: [
        { title: "old", boundingBox: box, publicationDate: "2015-01-01" },
        { title: "new", boundingBox: box, publicationDate: "2021-11-16" },
        { title: "middle", boundingBox: box, publicationDate: "2018-06-01" }
      ]
    });
    const kept = dem.newestPerFootprint(parsed.items);
    expect(kept).toHaveLength(1);
    expect(kept[0].title).toBe("new");
  });
});

describe("dem — choosing a product", () => {
  const box = { west: 0, south: 0, east: 1, north: 1 };
  const full = [{ boundingBox: { minX: -1, maxX: 2, minY: -1, maxY: 2 }, title: "full", publicationDate: "2021-01-01" }];
  const half = [{ boundingBox: { minX: 0, maxX: 0.5, minY: 0, maxY: 1 }, title: "half", publicationDate: "2021-01-01" }];
  const avail = (m) => Object.keys(m).map(k => ({ datasetId: k, items: dem.parseProducts({ items: m[k] }).items }));

  test("the finest product that covers the domain wins", () => {
    const chosen = dem.selectDataset(avail({ "1m": full, "one-third": full }), box);
    expect(chosen.dataset.id).toBe("1m");
    expect(chosen.coverage).toBe(1);
  });

  test("partial 1 m loses to complete 1/3 arc-second", () => {
    // A seam between a lidar tile and whatever fills the gap is a step in the
    // terrain, and a step in the terrain is a wind feature the hill does not have.
    const chosen = dem.selectDataset(avail({ "1m": half, "one-third": full }), box);
    expect(chosen.dataset.id).toBe("one-third");
  });

  test("nothing covering the domain returns no dataset, not a bad one", () => {
    const chosen = dem.selectDataset(avail({ "1m": half, "one-third": half }), box);
    expect(chosen.dataset).toBeNull();
    expect(chosen.tiles).toHaveLength(0);
  });

  test("every dataset considered is reported, so the choice can be explained", () => {
    const chosen = dem.selectDataset(avail({ "1m": half, "one-third": full }), box);
    const oneM = chosen.considered.filter(c => c.datasetId === "1m")[0];
    expect(oneM.coverage).toBeGreaterThan(0);
    expect(oneM.coverage).toBeLessThan(1);
  });

  test("a caller can accept partial coverage deliberately", () => {
    const chosen = dem.selectDataset(avail({ "1m": half, "one-third": full }), box, { minCoverage: 0.4 });
    expect(chosen.dataset.id).toBe("1m");
  });
});

describe("dem — discovery against an injected fetch", () => {
  const box = { west: 0, south: 0, east: 1, north: 1 };
  const covering = { items: [{ boundingBox: { minX: -1, maxX: 2, minY: -1, maxY: 2 }, title: "t", publicationDate: "2021-01-01" }] };

  test("stops at the first dataset that covers, without asking for coarser ones", () => {
    const asked = [];
    const fetchJson = async (url) => {
      asked.push(new URL(url).searchParams.get("datasets"));
      return covering;
    };
    return dem.discover(box, fetchJson).then((res) => {
      expect(res.dataset.id).toBe("1m");
      expect(asked).toHaveLength(1);
    });
  });

  test("falls through to a coarser product when the finer one is absent", () => {
    const fetchJson = async (url) => {
      const tag = new URL(url).searchParams.get("datasets");
      return tag === dem.datasetById("one-third").tag ? covering : { items: [] };
    };
    return dem.discover(box, fetchJson).then((res) => {
      expect(res.dataset.id).toBe("one-third");
    });
  });

  test("one dataset erroring does not fail discovery", () => {
    // Coarse terrain is a usable answer. No terrain is not.
    const fetchJson = async (url) => {
      const tag = new URL(url).searchParams.get("datasets");
      if (tag === dem.datasetById("1m").tag) throw new Error("503 from The National Map");
      return covering;
    };
    return dem.discover(box, fetchJson).then((res) => {
      expect(res.dataset.id).toBe("one-ninth");
    });
  });

  test("no terrain anywhere returns null rather than pretending", () => {
    return dem.discover(box, async () => ({ items: [] })).then((res) => {
      expect(res.dataset).toBeNull();
    });
  });

  test("names the products coarser than one that came back full of holes", () => {
    expect(dem.coarserThan("1m")).toEqual(["one-ninth", "ifsar-5m", "one-third"]);
    expect(dem.coarserThan("one-third")).toEqual([]);
    expect(dem.coarserThan(null)).toEqual(dem.DATASETS.map((d) => d.id));
  });

  test("a missing fetcher is refused, not reported as empty country", async () => {
    // Every dataset failing the same way is caught by the per-dataset guard
    // above and reads as "no 3DEP here", which over CONUS is never true.
    await expect(dem.discover(box, undefined)).rejects.toMatchObject({
      code: "no-fetch"
    });
  });
});

describe("hrrr — cycle arithmetic", () => {
  test("the cycle lags the clock, because the files are not there yet", () => {
    const at = new Date(Date.UTC(2026, 7, 23, 18, 10));
    const c = hrrr.latestAvailableCycle(at, 75);
    expect(c.hour).toBe(16);
    expect(hrrr.cycleDateString(c)).toBe("20260823");
  });

  test("the lag rolls back across midnight UTC without inventing a date", () => {
    const at = new Date(Date.UTC(2026, 7, 23, 0, 30));
    const c = hrrr.latestAvailableCycle(at, 75);
    expect(hrrr.cycleDateString(c)).toBe("20260822");
    expect(c.hour).toBe(23);
  });

  test("00, 06, 12 and 18Z run to 48 hours, the rest stop at 18", () => {
    expect(hrrr.maxForecastHour(0)).toBe(48);
    expect(hrrr.maxForecastHour(18)).toBe(48);
    expect(hrrr.maxForecastHour(15)).toBe(18);
  });
});

describe("hrrr — level names and valid times", () => {
  test("translates a canonical level key into the filter's name for it", () => {
    expect(hrrr.filterLevel("heightAboveGround:10")).toBe("10_m_above_ground");
    expect(hrrr.filterLevel("surface")).toBe("surface");
  });

  test("refuses a level it has no name for, rather than sending a guess", () => {
    // An unrecognised lev_ parameter is not an error at NOMADS: it is a 200
    // with the filter's defaults, which decodes cleanly and is the wrong air.
    expect(() => hrrr.filterLevel("heightAboveGround:37")).toThrow(/no NOMADS level is known/);
    expect(() => hrrr.filterLevel("isobaric:500")).toThrow(/Known: surface, heightAboveGround:2/);
  });

  test("every default level key has a filter name", () => {
    for (const key of hrrr.DEFAULT_LEVEL_KEYS) {
      expect(hrrr.DEFAULT_LEVELS).toContain(hrrr.filterLevel(key));
    }
  });

  test("an instant on the hour names the cycle whose analysis is valid then", () => {
    const cycle = hrrr.analysisCycleFor(new Date("2026-08-26T20:00:00Z"));
    expect(cycle).toEqual({ year: 2026, month: 8, day: 26, hour: 20 });
    expect(hrrr.cycleValidTime(cycle, 0).toISOString()).toBe("2026-08-26T20:00:00.000Z");
    expect(hrrr.cycleValidTime(cycle, 3).toISOString()).toBe("2026-08-26T23:00:00.000Z");
  });

  test("an instant between the hours is refused rather than rounded", () => {
    expect(() => hrrr.analysisCycleFor(new Date("2026-08-26T20:30:00Z")))
      .toThrow(/runs on the hour/);
    expect(() => hrrr.analysisCycleFor("not a time")).toThrow(/Date or an ISO string/);
  });
});

describe("hrrr — filter URLs", () => {
  const box = geo.boundingBox(LAT, LON, 6);
  const cycle = { year: 2026, month: 8, day: 23, hour: 12 };

  test("the URL names the surface file for the right cycle and hour", () => {
    const url = new URL(hrrr.filterUrl({ cycle, forecastHour: 3, box }));
    expect(url.origin + url.pathname).toBe(hrrr.FILTER_URL);
    expect(url.searchParams.get("file")).toBe("hrrr.t12z.wrfsfcf03.grib2");
    expect(url.searchParams.get("dir")).toBe("/hrrr.20260823/conus");
  });

  test("subsetting is on and the corners are the right way round", () => {
    const p = new URL(hrrr.filterUrl({ cycle, forecastHour: 0, box })).searchParams;
    expect(p.has("subregion")).toBe(true);
    expect(Number(p.get("leftlon"))).toBeLessThan(Number(p.get("rightlon")));
    expect(Number(p.get("bottomlat"))).toBeLessThan(Number(p.get("toplat")));
    expect(Number(p.get("leftlon"))).toBeCloseTo(box.west, 4);
    expect(Number(p.get("toplat"))).toBeCloseTo(box.north, 4);
  });

  test("wind is requested at 10 m and at 80 m", () => {
    const p = new URL(hrrr.filterUrl({ cycle, forecastHour: 0, box })).searchParams;
    expect(p.get("var_UGRD")).toBe("on");
    expect(p.get("var_VGRD")).toBe("on");
    expect(p.get("lev_10_m_above_ground")).toBe("on");
    // 80 m sits above the roughness layer, so it is the better estimate of what
    // actually arrives over a ridge.
    expect(p.get("lev_80_m_above_ground")).toBe("on");
  });

  test("a forecast hour the cycle does not produce is refused", () => {
    expect(() => hrrr.filterUrl({ cycle: { ...cycle, hour: 15 }, forecastHour: 30, box })).toThrow(/out of range/);
    expect(() => hrrr.filterUrl({ cycle, forecastHour: 30, box })).not.toThrow();
  });

  test("a domain outside CONUS is refused rather than silently empty", () => {
    // NOMADS answers a bad request with an HTML error page and HTTP 200, so a
    // wrong URL looks downstream like a GRIB file that will not parse.
    const honolulu = geo.boundingBox(21.31, -157.86, 2);
    expect(() => hrrr.filterUrl({ cycle, forecastHour: 0, box: honolulu })).toThrow(/CONUS/);
  });

  test("a transposed box is refused", () => {
    expect(() => hrrr.filterUrl({
      cycle, forecastHour: 0,
      box: { west: -104.4, south: 36.9, east: -104.6, north: 36.7 }
    })).toThrow(/transposed|empty/);
  });

  test("a forecast series is clamped to what the cycle produces", () => {
    const series = hrrr.forecastSeries({ cycle: { ...cycle, hour: 15 }, hours: 24, box });
    expect(series).toHaveLength(19); // 0..18
    expect(series[0].forecastHour).toBe(0);
    expect(series[18].url).toContain("wrfsfcf18");
  });
});
