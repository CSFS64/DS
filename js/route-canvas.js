/* Lightweight 2D presentation of the existing inferred route waves.
 * MapLibre's GeoJSON worker and symbol-placement pipeline are intentionally
 * not used for moving lines/arrows. All geometry/timing comes unchanged from
 * DeepstrikeRouteAnimation.renderAt(), and no additional routes are inferred.
 */
(function (root) {
  "use strict";
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const interpolate = (zoom, low, mid, high) => {
    if (zoom < 7) return low + (mid - low) * clamp((zoom - 3) / 4, 0, 1);
    return mid + (high - mid) * clamp((zoom - 7) / 4, 0, 1);
  };

  function drawFrame(ctx, frame, project, zoom = 5) {
    const features = frame?.lines?.features || [];
    if (!features.length) return 0;
    const glowWidth = interpolate(zoom, 7.5, 10, 13);
    const casingWidth = interpolate(zoom, 3.5, 4.5, 5.6);
    const coreWidth = interpolate(zoom, 1.35, 1.85, 2.45);
    const arrowSize = interpolate(zoom, 7, 9, 11);
    const linesByRoute = new Map();
    for (const feature of features) {
      const coords = feature.geometry?.coordinates || [];
      if (coords.length < 2) continue;
      const points = coords.map(p => project(p));
      if (points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) continue;
      linesByRoute.set(feature.properties?.route_id, {
        points, confidence: Number(feature.properties?.confidence ?? .8),
        weight: Number(feature.properties?.route_weight ?? 1),
        threat: feature.properties?.threat === "missile" ? "missile" : "uav",
      });
    }
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    function strokePath(points) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
    }
    for (const {points, confidence, weight, threat} of linesByRoute.values()) {
      const missile = threat === "missile";
      const c = clamp(confidence, 0.25, 1);
      const wt = clamp(weight, 1, 1.55);
      ctx.globalAlpha = 0.20 * c;
      ctx.strokeStyle = missile ? "#ff355d" : "#ff8b1f";
      ctx.lineWidth = glowWidth * wt;
      strokePath(points);
      ctx.globalAlpha = 0.76 * c;
      ctx.strokeStyle = missile ? "#581b39" : "#6f2c08";
      ctx.lineWidth = casingWidth * wt;
      strokePath(points);
      ctx.globalAlpha = .97 * c;
      ctx.strokeStyle = missile ? "#ff4a73" : "#ff8b1f";
      ctx.lineWidth = coreWidth * wt;
      strokePath(points);
      ctx.globalAlpha = .48 * c;
      ctx.strokeStyle = missile ? "#ffb3c9" : "#ffc263";
      ctx.lineWidth = Math.max(.5, coreWidth * .28) * wt;
      strokePath(points);
    }

    // Triangles are drawn synchronously at the *current* wave head in this
    // same frame. There is no independent MapLibre symbol refresh to stutter.
    for (const feature of frame?.arrows?.features || []) {
      const route = linesByRoute.get(feature.properties?.route_id);
      const points = route?.points;
      if (!points || points.length < 2) continue;
      const tip = points[points.length - 1];
      let prev = points[points.length - 2];
      let dist = Math.hypot(tip.x - prev.x, tip.y - prev.y);
      for (let i = points.length - 3; dist < 1 && i >= 0; i--) {
        prev = points[i];
        dist = Math.hypot(tip.x - prev.x, tip.y - prev.y);
      }
      if (!(dist > 0.01)) continue;
      const dx = (tip.x - prev.x) / dist, dy = (tip.y - prev.y) / dist;
      const size = arrowSize, nx = -dy, ny = dx;
      const bx = tip.x - dx * size, by = tip.y - dy * size;
      ctx.globalAlpha = .96;
      ctx.beginPath();
      ctx.moveTo(tip.x + dx * size * .30, tip.y + dy * size * .30);
      ctx.lineTo(bx + nx * size * .50, by + ny * size * .50);
      ctx.lineTo(bx - nx * size * .50, by - ny * size * .50);
      ctx.closePath();
      ctx.fillStyle = route.threat === "missile" ? "#ff537c" : "#ff9a2f";
      ctx.strokeStyle = route.threat === "missile" ? "#541a32" : "#5e2608";
      ctx.lineWidth = 1.2;
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    return linesByRoute.size;
  }

  // Uses CSS-sized map.project() coordinates and a separately scaled backing
  // buffer; it remains sharp under devicePixelRatio and responsive resizing.
  function paint(canvas, map, frame) {
    if (!canvas || !map) return 0;
    if (!frame?.count) {
      canvas.hidden = true;
      return 0;
    }
    // Unhide *before* querying layout dimensions; a display:none canvas
    // reports zero clientWidth and would otherwise never become visible.
    canvas.hidden = false;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) { canvas.hidden = true; return 0; }
    const dpr = Math.min(2, Math.max(1, root?.devicePixelRatio || 1));
    const pw = Math.round(width * dpr), ph = Math.round(height * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) { canvas.hidden = true; return 0; }
    canvas.hidden = false;
    ctx.setTransform(pw / width, 0, 0, ph / height, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return drawFrame(ctx, frame,
      coords => map.project({ lng: coords[0], lat: coords[1] }),
      map.getZoom());
  }

  function clear(canvas) {
    if (canvas) canvas.hidden = true;
  }

  const api = { paint, clear, drawFrame };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.DeepstrikeRouteCanvas = api;
})(typeof window !== "undefined" ? window : null);
