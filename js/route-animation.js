/* Route-wave display for historical playback. No route inference is done here:
 * geometry comes unchanged from the existing STATIC route builder. Record
 * timestamps anchor movement; the unobserved portions are visual interpolation,
 * NOT a measured flight path or actual aircraft speed.
 */
(function (root) {
  "use strict";
  const HOUR = 3600000;
  const EMPTY = { type: "FeatureCollection", features: [] };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const km = (a, b) => {
    const p = Math.PI / 180;
    const dlat = (b[1] - a[1]) * p, dlon = (b[0] - a[0]) * p;
    const lat1 = a[1] * p, lat2 = b[1] * p;
    const h = Math.sin(dlat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
    return 12742 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  };
  function distanceIndex(coords) {
    const lengths = [0];
    for (let i = 1; i < coords.length; i++) {
      lengths.push(lengths[i - 1] + km(coords[i - 1], coords[i]));
    }
    return { lengths, total: lengths[lengths.length - 1] };
  }
  function nearestProgress(coords, index, node) {
    const point = [node.lon, node.lat];
    const lat = point[1] * Math.PI / 180;
    const sx = 111.32 * Math.cos(lat), sy = 110.57;
    let best = Infinity, distance = 0;
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i];
      const vx = (b[0] - a[0]) * sx, vy = (b[1] - a[1]) * sy;
      const ux = (point[0] - a[0]) * sx, uy = (point[1] - a[1]) * sy;
      const denom = vx * vx + vy * vy;
      const t = denom ? clamp((ux * vx + uy * vy) / denom, 0, 1) : 0;
      const dx = ux - vx * t, dy = uy - vy * t;
      const sq = dx * dx + dy * dy;
      if (sq < best) {
        best = sq;
        distance = index.lengths[i - 1] +
          (index.lengths[i] - index.lengths[i - 1]) * t;
      }
    }
    return index.total ? clamp(distance / index.total, 0, 1) : 0;
  }
  function prepareRoute(feature, observations) {
    const coords = feature.geometry?.coordinates || [];
    if (coords.length < 2) return null;
    const distance = distanceIndex(coords);
    if (!(distance.total > 0.01)) return null;
    const arrival = Date.parse(feature.properties?.latest_at);
    if (!Number.isFinite(arrival)) return null;
    const anchors = (observations || [])
      .filter(o => Number.isFinite(o.at) && Number.isFinite(o.lon) && Number.isFinite(o.lat))
      .map(o => ({ at: o.at, progress: nearestProgress(coords, distance, o) }))
      .filter(o => o.progress > 0 && o.progress <= 1)
      .sort((a, b) => a.progress - b.progress || a.at - b.at);
    // Infer an initial time only for the unknown border->first observation
    // segment, using a nominal visualization pace. The later anchor instants
    // remain the original publication times, never replaced by frame times.
    const first = anchors[0];
    // Do not animate fast missile events with the UAV's nominal 210 km/h
    // baseline. Both are illustrative when location timestamps are absent.
    const missile = feature.properties?.threat === "missile";
    const baselineDuration = missile
      ? Math.max(6 * 60000, distance.total / 950 * HOUR)
      : Math.max(25 * 60000, distance.total / 210 * HOUR);
    let start = first
      ? first.at - baselineDuration * first.progress
      : arrival - baselineDuration;
    if (start >= arrival - 60000) start = arrival - baselineDuration;
    const checkpoints = [{ at: start, progress: 0 }];
    let lastAt = start, lastProgress = 0;
    for (const anchor of anchors) {
      if (anchor.progress <= lastProgress + 0.001 ||
          anchor.at <= lastAt || anchor.at >= arrival || anchor.progress >= .999) continue;
      checkpoints.push(anchor);
      lastAt = anchor.at;
      lastProgress = anchor.progress;
    }
    checkpoints.push({ at: arrival, progress: 1 });
    // Delay the tail. At arrival the leading tip stops, but the trailing
    // tip continues to the target; once they meet, the entire line disappears.
    const duration = arrival - start;
    const lag = missile
      ? clamp(duration * .33, 3 * 60000, 20 * 60000)
      : clamp(duration * .33, 12 * 60000, 90 * 60000);
    return { feature, coords, distance, start, arrival, end: arrival + lag, lag, checkpoints };
  }
  function headAt(route, ms) {
    if (ms <= route.start) return 0;
    if (ms >= route.arrival) return 1;
    const pts = route.checkpoints;
    for (let i = 1; i < pts.length; i++) {
      if (ms > pts[i].at) continue;
      const before = pts[i - 1], after = pts[i];
      const t = clamp((ms - before.at) / (after.at - before.at), 0, 1);
      // Smooth motion between timestamp anchors: no instantaneous growth.
      const ease = t * t * (3 - 2 * t);
      return before.progress + (after.progress - before.progress) * ease;
    }
    return 1;
  }
  function waveAt(route, ms) {
    if (ms <= route.start || ms >= route.end) return null;
    const head = headAt(route, ms);
    const tail = headAt(route, ms - route.lag);
    return head > tail + 0.00001 ? { head, tail } : null;
  }
  function pointAt(route, ratio) {
    const { coords, distance } = route;
    const target = clamp(ratio, 0, 1) * distance.total;
    let low = 1, high = distance.lengths.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (distance.lengths[mid] < target) low = mid + 1;
      else high = mid;
    }
    const a = coords[low - 1], b = coords[low];
    const d = distance.lengths[low] - distance.lengths[low - 1];
    const t = d > 0 ? clamp((target - distance.lengths[low - 1]) / d, 0, 1) : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  function clipWave(route, wave) {
    const a = wave.tail * route.distance.total;
    const b = wave.head * route.distance.total;
    if (b <= a) return null;
    const points = [pointAt(route, wave.tail)];
    const lengths = route.distance.lengths;
    for (let i = 1; i < lengths.length - 1; i++) {
      if (lengths[i] > a && lengths[i] < b) points.push(route.coords[i]);
    }
    points.push(pointAt(route, wave.head));
    return {
      type: "Feature",
      properties: route.feature.properties,
      geometry: { type: "LineString", coordinates: points },
    };
  }
  function bearing(a, b) {
    const rad = Math.PI / 180;
    const lat1 = a[1] * rad, lat2 = b[1] * rad, dlon = (b[0] - a[0]) * rad;
    const y = Math.sin(dlon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dlon);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }
  function prepare(data) {
    const index = new Map();
    let count = 0;
    for (const feature of data?.lines?.features || []) {
      const nodes = data.animationAnchors?.get(feature.properties.route_id) || [];
      const route = prepareRoute(feature, nodes);
      if (!route) continue;
      count++;
      for (let hour = Math.floor(route.start / HOUR);
           hour <= Math.floor(route.end / HOUR); hour++) {
        let bucket = index.get(hour);
        if (!bucket) { bucket = []; index.set(hour, bucket); }
        bucket.push(route);
      }
    }
    return { index, count };
  }
  function renderAt(prepared, ms) {
    if (!prepared || !Number.isFinite(ms)) return { lines: EMPTY, arrows: EMPTY, count: 0 };
    const routes = prepared.index.get(Math.floor(ms / HOUR)) || [];
    const lines = [], arrows = [];
    for (const route of routes) {
      const wave = waveAt(route, ms);
      if (!wave) continue;
      const line = clipWave(route, wave);
      if (!line) continue;
      lines.push(line);
      // The pointer only marks the moving leading tip. Once the head has
      // reached its destination it disappears, even while the tail contracts.
      if (wave.head >= 0.99999) continue;
      const coords = line.geometry.coordinates;
      const a = coords[coords.length - 2], b = coords[coords.length - 1];
      arrows.push({
        type: "Feature",
        properties: { ...line.properties, bearing: bearing(a, b) },
        geometry: { type: "Point", coordinates: b },
      });
    }
    return {
      lines: { type: "FeatureCollection", features: lines },
      arrows: { type: "FeatureCollection", features: arrows },
      count: lines.length,
    };
  }
  const api = { prepare, prepareRoute, headAt, waveAt, clipWave, renderAt };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.DeepstrikeRouteAnimation = api;
})(typeof window !== "undefined" ? window : null);
