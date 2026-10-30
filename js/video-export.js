/* Browser-only video recorder for the public historical alert map.
 * Produces a real, locally encoded video of the full selected time window.
 * No upload, remote conversion service, or external JS dependency is used.
 */
(function () {
  "use strict";

  const FPS = 30;
  const WIDTH = 1920;
  const HEIGHT = 1080;

  function chooseMimeType() {
    if (!window.MediaRecorder) throw new Error("当前浏览器不支持 MediaRecorder，请使用新版 Chrome 或 Edge。");
    const candidates = [
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || "";
  }

  function waitForMapFrame(map, timeoutMs = 450) {
    return new Promise(resolve => {
      let settled = false;
      let timer;
      const finished = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        map.off("render", onRender);
        resolve();
      };
      const onRender = () => finished();
      map.on("render", onRender);
      timer = setTimeout(finished, timeoutMs);
      map.triggerRepaint();
    });
  }

  const BRAND_TITLE = "Deep Strike Activity Map";
  const BRAND_PINK = "#ff7ece"; // Match the Fire Point reference and .brand-title CSS.

  function loadBrandLogo(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("无法加载网站标志图片；请刷新页面后重试。"));
      image.src = src;
      if (image.complete && image.naturalWidth > 0) resolve(image);
    });
  }

  function paintBrandLogo(ctx, logo, x, y, width, opacity = 1) {
    if (!logo?.naturalWidth || !logo.naturalHeight) return;
    const height = width * logo.naturalHeight / logo.naturalWidth;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.drawImage(logo, x, y, width, height);
    ctx.restore();
  }

  function drawVideoFrame(ctx, mapCanvas, ms, start, end, formatKyiv, formatBeijing, logo) {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    ctx.fillStyle = "#050a0f";
    ctx.fillRect(0, 0, w, h);

    // Fit the selected map framing without distortion; branding is drawn
    // on the recording canvas because DOM overlays are not captured by WebGL.
    const scale = Math.min(w / mapCanvas.width, h / mapCanvas.height);
    const sw = mapCanvas.width * scale, sh = mapCanvas.height * scale;
    ctx.drawImage(mapCanvas, (w - sw) / 2, (h - sh) / 2, sw, sh);

    // Identical image asset and approximately the same proportional watermark
    // size/opacity as CLEAN VIEW. It must remain far below map label contrast.
    const waterWidth = Math.min(w * .36, 560);
    const waterHeight = waterWidth * logo.naturalHeight / logo.naturalWidth;
    paintBrandLogo(ctx, logo, (w - waterWidth) / 2, h * .52 - waterHeight / 2,
      waterWidth, .065);

    // Upper-right official channel logo, kept away from the title and clocks.
    paintBrandLogo(ctx, logo, w - 36 - 158, 30, 158);

    // Editorial title, matching the full-screen pink monospace title ribbon.
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = '800 39px "Courier New", monospace';
    const ribbonWidth = Math.ceil(ctx.measureText(BRAND_TITLE).width) + 38;
    ctx.shadowColor = "rgba(0, 0, 0, .27)";
    ctx.shadowBlur = 15;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = BRAND_PINK;
    ctx.fillRect(36, 36, ribbonWidth, 63);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = "#161019";
    ctx.fillText(BRAND_TITLE, 55, 69);

    // Render the exact historical playback instant in both time zones.
    // This deliberately does not use the viewer's current wall-clock time.
    ctx.font = '700 27px "Courier New", monospace';
    ctx.fillStyle = "#f5f8ff";
    ctx.shadowColor = "rgba(0,0,0,.92)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;
    ctx.fillText("Kyiv time: " + formatKyiv(ms), 38, 149);
    ctx.fillText("Beijing time: " + formatBeijing(ms), 38, 190);
    ctx.restore();

    // Small provenance footer, no opaque bar concealing the map.
    ctx.save();
    ctx.font = '15px "Courier New", monospace';
    ctx.fillStyle = "#e0eef6";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 6;
    ctx.textBaseline = "middle";
    ctx.fillText("Public-source historical alerts · Illustrative visualization", 28, h - 31);
    ctx.textAlign = "right";
    ctx.fillText("Map © OpenStreetMap contributors · OpenFreeMap", w - 28, h - 31);
    ctx.restore();

    const progress = Math.min(1, Math.max(0, (ms - start) / (end - start)));
    ctx.fillStyle = "#143140";
    ctx.fillRect(0, h - 5, w, 5);
    ctx.fillStyle = "#39d8ff";
    ctx.fillRect(0, h - 5, w * progress, 5);
  }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  async function record(options) {
    const { map, start, end, durationSeconds, renderAt, onProgress, isCancelled,
      formatKyiv, formatBeijing, brandLogoSrc = "assets/kalyna-osint-logo.avif" } = options;
    if (!(end > start)) throw new Error("所选时间段必须大于零。");
    if (!map?.getCanvas || typeof HTMLCanvasElement.prototype.captureStream !== "function") {
      throw new Error("当前浏览器无法录制 Canvas 视频，请使用新版 Chrome 或 Edge。");
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("时间范围或播放速度无效。");
    if (typeof formatKyiv !== "function" || typeof formatBeijing !== "function") {
      throw new Error("视频时间格式化组件未就绪。");
    }
    const logo = await loadBrandLogo(brandLogoSrc);
    const mimeType = chooseMimeType();
    const output = document.createElement("canvas");
    output.width = WIDTH;
    output.height = HEIGHT;
    const ctx = output.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("无法创建视频画布。");
    const stream = output.captureStream(FPS);
    let recorder = null;
    try {
      const settings = { videoBitsPerSecond: 8000000 };
      if (mimeType) settings.mimeType = mimeType;
      recorder = new MediaRecorder(stream, settings);
      const chunks = [];
      let recordingError = null;
      const stopped = new Promise(resolve => {
        recorder.addEventListener("dataavailable", event => {
          if (event.data?.size) chunks.push(event.data);
        });
        recorder.addEventListener("error", event => {
          recordingError = event.error || new Error("浏览器视频编码失败。");
        });
        recorder.addEventListener("stop", resolve, { once: true });
      });

      renderAt(start);
      await waitForMapFrame(map);
      const source = map.getCanvas();
      if (!source.width || !source.height) throw new Error("地图尚未绘制完成。");
      drawVideoFrame(ctx, source, start, start, end, formatKyiv, formatBeijing, logo);
      recorder.start(1000);
      const startedAt = performance.now();

      while (true) {
        if (isCancelled()) break;
        const frameStarted = performance.now();
        const progress = Math.min(1, (frameStarted - startedAt) / (durationSeconds * 1000));
        const ms = start + (end - start) * progress;
        renderAt(ms);
        await waitForMapFrame(map);
        drawVideoFrame(ctx, map.getCanvas(), ms, start, end, formatKyiv, formatBeijing, logo);
        onProgress(progress);
        if (progress >= 1) break;
        await sleep(Math.max(0, 1000 / FPS - (performance.now() - frameStarted)));
      }

      // Give the recorder a final chance to sample the end frame before stop.
      if (!isCancelled()) await sleep(180);
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      if (isCancelled()) throw new Error("视频导出已取消。");
      if (recordingError) throw recordingError;
      const actualType = recorder.mimeType || mimeType || "video/webm";
      const blob = new Blob(chunks, { type: actualType });
      if (!blob.size) throw new Error("视频编码器没有生成有效数据。");
      return { blob, extension: actualType.includes("mp4") ? "mp4" : "webm" };
    } finally {
      if (recorder?.state !== "inactive") {
        try { recorder.stop(); } catch (_) {}
      }
      stream.getTracks().forEach(track => track.stop());
    }
  }

  window.DeepstrikeVideoExporter = { record };
})();