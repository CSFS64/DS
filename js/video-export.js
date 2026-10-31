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

  // Full bleed, fixed 1920×1080. The LIVE map is itself constrained to 16:9
  // before recording, so no letterboxing, black footer or image cropping.
  // The full-screen presentation HUD is composited pixel-for-pixel, giving
  // identical logo, title, clocks and geodesic scale bar in the video.
  function drawVideoFrame(ctx, mapCanvas, ms, start, end, formatKyiv, formatBeijing,
      logo, routeOverlay, presentationOverlay) {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    const ratio = mapCanvas.width / mapCanvas.height;
    if (!Number.isFinite(ratio) || Math.abs(ratio - 16 / 9) > .01) {
      throw new Error("地图画面尚未调整到16:9，无法无损导出，请退出并重新进入全屏后重试。");
    }
    ctx.drawImage(mapCanvas, 0, 0, w, h);

    // Draw the moving tail/head lines from exactly the same canvas used
    // in fullscreen. Static cumulative routes remain inside the basemap.
    if (routeOverlay && !routeOverlay.hidden &&
        routeOverlay.width > 0 && routeOverlay.height > 0) {
      ctx.drawImage(routeOverlay, 0, 0, w, h);
    }
    if (!presentationOverlay || presentationOverlay.hidden ||
        !presentationOverlay.width || !presentationOverlay.height) {
      throw new Error("全屏标题与比例尺未准备完成，请刷新页面后重试。");
    }
    ctx.drawImage(presentationOverlay, 0, 0, w, h);

    // This 5px blue strip is the ONLY element fixed to the bottom edge.
    // Its palette is identical to the fullscreen CSS presentation-progress.
    const p = end > start ? Math.min(1, Math.max(0, (ms - start) / (end - start))) : 0;
    ctx.fillStyle = "#143140";
    ctx.fillRect(0, h - 5, w, 5);
    ctx.fillStyle = "#39d8ff";
    ctx.fillRect(0, h - 5, w * p, 5);
  }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  async function record(options) {
    const { map, start, end, durationSeconds, renderAt, onProgress, isCancelled,
      formatKyiv, formatBeijing, routeOverlay, presentationOverlay } = options;
    if (!(end > start)) throw new Error("所选时间段必须大于零。");
    if (!map?.getCanvas || typeof HTMLCanvasElement.prototype.captureStream !== "function") {
      throw new Error("当前浏览器无法录制 Canvas 视频，请使用新版 Chrome 或 Edge。");
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("时间范围或播放速度无效。");
    if (typeof formatKyiv !== "function" || typeof formatBeijing !== "function") {
      throw new Error("视频时间格式化组件未就绪。");
    }
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
      drawVideoFrame(ctx, source, start, start, end, formatKyiv, formatBeijing, null, routeOverlay, presentationOverlay);
      recorder.start(1000);
      const startedAt = performance.now();

      while (true) {
        if (isCancelled()) break;
        const frameStarted = performance.now();
        const progress = Math.min(1, (frameStarted - startedAt) / (durationSeconds * 1000));
        const ms = start + (end - start) * progress;
        renderAt(ms);
        await waitForMapFrame(map);
        drawVideoFrame(ctx, map.getCanvas(), ms, start, end, formatKyiv, formatBeijing, null, routeOverlay, presentationOverlay);
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