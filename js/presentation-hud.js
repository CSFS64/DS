/* One shared HUD for fullscreen playback and video export. The recording
 * composites this very same transparent canvas over the uncropped basemap.
 * Scale distances are computed from the current MapLibre viewport at the
 * actual bar position; they are never guessed from a constant zoom number.
 */
(function (root) {
  "use strict";
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const logoUrl = "assets/kalyna-osint-logo.avif";
  const METER = 6371008.8;
  const TITLE = "Deep Strike Activity Map";
  const PINK = "#ff7ece";
  let logo = null;
  let logoPromise = null;

  function preloadLogo() {
    if (logo?.naturalWidth) return Promise.resolve(logo);
    if (logoPromise) return logoPromise;
    if (typeof Image === "undefined") return Promise.resolve(null);
    logoPromise = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => { logo = image; resolve(image); };
      image.onerror = () => {
        logoPromise = null;
        reject(new Error("无法加载地图 Logo，请刷新页面再试。"));
      };
      image.src = logoUrl;
      if (image.complete && image.naturalWidth) { logo = image; resolve(image); }
    });
    return logoPromise;
  }

  function haversineKm(a, b) {
    const rad = Math.PI / 180;
    const lat1 = a.lat * rad, lat2 = b.lat * rad;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lng - a.lng) * rad;
    const k = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * METER / 1000 * Math.atan2(Math.sqrt(k), Math.sqrt(Math.max(0, 1 - k)));
  }

  function scaleAt(map, width, height) {
    if (!map || !width || !height || typeof map.unproject !== "function") return null;
    const compact = width < 740;
    const factor = Math.min(width / 1920, height / 1080);
    const x = compact ? 16 : Math.max(width * .02, 20);
    const y = height - Math.max(36, 58 * factor);
    const maxWidth = clamp(width * (compact ? .22 : .105), 78, 195);
    const left = map.unproject([x, y]);
    const right = map.unproject([x + maxWidth, y]);
    if (!left || !right) return null;
    const maxKm = haversineKm(left, right);
    if (!Number.isFinite(maxKm) || maxKm <= 0) return null;
    // Use standard cartographic 1-2-5 intervals; a label always describes the
    // ACTUAL ground distance between the drawn endpoints at this latitude.
    const base = 10 ** Math.floor(Math.log10(maxKm));
    const nice = [5, 2, 1].map(n => n * base).find(n => n <= maxKm) ||
      base / 10 * 5;
    return {
      x, y, px: maxWidth * nice / maxKm,
      km: nice,
      label: nice < 1 ? Math.round(nice * 1000) + " m" :
        (nice >= 10 ? Math.round(nice) : +nice.toFixed(2)) + " km"
    };
  }

  function drawHud(ctx, width, height, config) {
    const { map, ms, start, end, formatKyiv, formatBeijing } = config;
    const compact = width < 740;
    const factor = Math.min(width / 1920, height / 1080);
    const left = compact ? 14 : Math.max(width * .02, 18);
    const top = compact ? 18 : Math.max(height * .031, 22);
    const right = compact ? 12 : Math.max(width * .019, 16);
    const titleFont = compact ? clamp(width * .03, 12, 19) :
      clamp(width * .0205, 16, 39);
    const clockFont = compact ? clamp(width * .023, 10, 15) :
      clamp(width * .0135, 13, 27);
    const logoWidth = compact ? clamp(width * .15, 70, 100) :
      clamp(width * .082, 78, 158);

    // Central watermark and right-side logo are derived from one asset.
    if (logo?.naturalWidth) {
      const watermarkWidth = Math.min(width * (compact ? .54 : .36), compact ? 340 : 560);
      const watermarkHeight = watermarkWidth * logo.naturalHeight / logo.naturalWidth;
      ctx.save();
      ctx.globalAlpha = .065;
      ctx.drawImage(logo,(width-watermarkWidth)/2,height*.52-watermarkHeight/2,
        watermarkWidth,watermarkHeight);
      ctx.restore();
      const logoHeight = logoWidth * logo.naturalHeight / logo.naturalWidth;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,.72)";
      ctx.shadowBlur = 7 * Math.max(.65, factor);
      ctx.shadowOffsetY = 2 * Math.max(.65, factor);
      const logoTop = compact ? 16 : Math.max(height*.028,18);
      ctx.drawImage(logo, width-right-logoWidth, logoTop, logoWidth,logoHeight);
      ctx.restore();

      // Keep map-tile credit discreet but legible. No bottom credits bar.
      ctx.save();
      ctx.font = '11px "Courier New", monospace';
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#dce8f0";
      ctx.shadowColor = "#000";
      ctx.shadowBlur = 6;
      ctx.fillText("© OpenStreetMap contributors · OpenFreeMap",
        width-right, logoTop+logoHeight+12);
      ctx.restore();
    }

    // Match the existing Fire Point pink title and the two historical clocks.
    ctx.save();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = '800 ' + titleFont + 'px "Courier New", monospace';
    const titleWidth = Math.ceil(ctx.measureText(TITLE).width + titleFont * 1.1);
    const titleHeight = titleFont * 1.65;
    ctx.fillStyle = PINK;
    ctx.shadowColor = "rgba(0,0,0,.27)";
    ctx.shadowBlur = 15 * Math.max(.7,factor);
    ctx.shadowOffsetY = 4 * Math.max(.7,factor);
    ctx.fillRect(left, top, titleWidth, titleHeight);
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.fillStyle = "#161019";
    ctx.fillText(TITLE, left + titleFont*.55, top + titleHeight/2);

    const firstY = top + titleHeight + clockFont*.92;
    ctx.font = '700 ' + clockFont + 'px "Courier New", monospace';
    ctx.fillStyle = "#f5f8ff";
    ctx.shadowColor = "rgba(0,0,0,.92)";
    ctx.shadowBlur = 10 * Math.max(.7,factor);
    ctx.shadowOffsetY = 2 * Math.max(.7,factor);
    ctx.fillText("Kyiv time: " + (formatKyiv?.(ms) || "—"), left + 2, firstY);
    ctx.fillText("Beijing time: " + (formatBeijing?.(ms) || "—"),
      left + 2, firstY + clockFont*1.52);
    ctx.restore();

    const scale = config.preparedScale || scaleAt(map, width, height);
    if (scale) {
      ctx.save();
      const lineW = Math.max(1.7, 2.5 * factor);
      const tickH = Math.max(5, 8 * factor);
      ctx.strokeStyle = "#ecf6ff";
      ctx.fillStyle = "#ecf6ff";
      ctx.lineWidth = lineW;
      ctx.lineCap = "square";
      ctx.shadowColor = "#000";
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 1;
      ctx.font = '700 ' + clamp(width*.012, 11, 19) + 'px "Courier New", monospace';
      ctx.textBaseline = "bottom";
      ctx.textAlign = "left";
      ctx.fillText(scale.label, scale.x, scale.y - tickH - 5*factor);
      ctx.beginPath();
      ctx.moveTo(scale.x, scale.y - tickH);
      ctx.lineTo(scale.x, scale.y);
      ctx.lineTo(scale.x + scale.px, scale.y);
      ctx.lineTo(scale.x + scale.px, scale.y - tickH);
      ctx.stroke();
      ctx.restore();
    }

    // No opaque footer or "Public-source historical alerts" band. The
    // only element at the bottom edge is the blue playback progress strip,
    // which is composed separately in fullscreen and exported videos.
    return scale;
  }

  // Render once into the *canonical* 1920×1080 frame. Fullscreen scales
  // this canvas uniformly inside a 16:9 map panel, while export composites
  // the same pixels without drawing a second, divergent layout.
  const FRAME_W = 1920, FRAME_H = 1080;
  function paint(canvas, config) {
    if (!canvas || !config?.map) return null;
    const cssWidth = canvas.clientWidth, cssHeight = canvas.clientHeight;
    if (!cssWidth || !cssHeight) return null;
    if (canvas.width !== FRAME_W || canvas.height !== FRAME_H) {
      canvas.width = FRAME_W;
      canvas.height = FRAME_H;
    }
    const rawScale = scaleAt(config.map, cssWidth, cssHeight);
    const ratioX = FRAME_W / cssWidth, ratioY = FRAME_H / cssHeight;
    const preparedScale = rawScale ? {
      ...rawScale,
      x: rawScale.x * ratioX,
      y: rawScale.y * ratioY,
      px: rawScale.px * ratioX,
    } : null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, FRAME_W, FRAME_H);
    return drawHud(ctx, FRAME_W, FRAME_H, {...config, preparedScale});
  }

  function progress(ms, start, end) {
    if (!(end > start)) return 0;
    return clamp((ms - start) / (end - start), 0, 1);
  }

  const api = { preloadLogo, paint, drawHud, scaleAt, haversineKm, progress, FRAME_W, FRAME_H };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.DeepstrikePresentation = api;
})(typeof window !== "undefined" ? window : null);
