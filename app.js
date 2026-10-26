/* Screen Recorder — getDisplayMedia + MediaRecorder, mic mixed in with WebAudio. Nothing leaves the tab. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;

  var FORMATS = [
    { label: "WebM · VP9", mime: "video/webm;codecs=vp9,opus", ext: "webm" },
    { label: "WebM · VP8", mime: "video/webm;codecs=vp8,opus", ext: "webm" },
    { label: "WebM", mime: "video/webm", ext: "webm" },
    { label: "MP4 · H.264", mime: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", ext: "mp4" },
    { label: "MP4", mime: "video/mp4", ext: "mp4" }
  ];
  var BPP = { standard: 0.05, high: 0.1, max: 0.2 }; // bits per pixel per frame

  // ---------- pure helpers (tested in S3_SELFTEST) ----------
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  }
  function supportedFormats(isSupported) { return FORMATS.filter(function (f) { return isSupported(f.mime); }); }
  function bitrateFor(w, h, fps, quality) {
    var b = w * h * fps * (BPP[quality] || BPP.high);
    return Math.round(Math.min(40e6, Math.max(1e6, b)));
  }
  function displayConstraints(res, fps, audio) {
    var v = { frameRate: { ideal: fps, max: fps } };
    if (res !== "native") { var hgt = +res; v.height = { ideal: hgt, max: hgt }; v.width = { ideal: Math.round(hgt * 16 / 9), max: Math.round(hgt * 16 / 9) }; }
    return { video: v, audio: !!audio };
  }
  function fileName(d, ext) {
    function p(n) { return String(n).padStart(2, "0"); }
    return "screen-" + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "_" + p(d.getHours()) + "-" + p(d.getMinutes()) + "-" + p(d.getSeconds()) + "." + ext;
  }
  // Mix any number of audio sources into one destination, each with its own gain.
  function mixInto(ctx, inputs, dest) {
    return inputs.map(function (inp) {
      var g = ctx.createGain(); g.gain.value = inp.gain;
      inp.node.connect(g); g.connect(dest);
      return g;
    });
  }

  // ---------- state ----------
  var canDisplay = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  var canRecord = typeof window.MediaRecorder === "function";
  var formats = canRecord ? supportedFormats(function (m) { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } }) : [];
  var settings = Object.assign({ res: "native", fps: "30", quality: "high", format: "", sysAudio: true, mic: false, micVol: 100, countdown: "3" }, S3.store("screenrec") || {});
  var rec = null; // {recorder, streams, ctx, chunks, bytes, started, pausedAt, pausedTotal, timer, fmt}
  var takes = [], current = null;

  // ---------- UI setup ----------
  var fmtSel = $("#format");
  formats.forEach(function (f) { fmtSel.appendChild(S3.h("option", { value: f.mime, text: f.label })); });
  if (!formats.length) fmtSel.appendChild(S3.h("option", { value: "", text: "Not available" }));
  ["res", "fps", "quality"].forEach(function (k) { $("#" + k).value = settings[k]; });
  if (formats.some(function (f) { return f.mime === settings.format; })) fmtSel.value = settings.format;
  $("#sysAudio").checked = settings.sysAudio; $("#mic").checked = settings.mic; $("#micVol").value = settings.micVol;
  $$("#countdown button").forEach(function (b) {
    b.setAttribute("aria-pressed", String(b.dataset.v === settings.countdown));
    b.addEventListener("click", function () {
      $$("#countdown button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      settings.countdown = b.dataset.v; save();
    });
  });
  function save() {
    settings.res = $("#res").value; settings.fps = $("#fps").value; settings.quality = $("#quality").value; settings.format = fmtSel.value;
    settings.sysAudio = $("#sysAudio").checked; settings.mic = $("#mic").checked; settings.micVol = +$("#micVol").value;
    $("#micVolWrap").hidden = !settings.mic;
    S3.store("screenrec", settings);
  }
  ["#res", "#fps", "#quality", "#format", "#sysAudio", "#mic", "#micVol"].forEach(function (s) { $(s).addEventListener("change", save); });
  $("#micVol").addEventListener("input", function () { if (rec && rec.micGain) rec.micGain.gain.value = this.value / 100; });
  $("#micVolWrap").hidden = !settings.mic;

  if (!canDisplay || !canRecord) {
    $("#unsupported").hidden = false;
    if (canDisplay && !canRecord) $("#unsupportedWhy").textContent = "This browser can share the screen but can't record video (no MediaRecorder). Try the latest Chrome, Edge, Firefox or Safari.";
    $("#start").disabled = true;
  }

  function setStatus(text, kind) { var s = $("#status"); s.textContent = text; s.className = "chip" + (kind ? " " + kind : ""); }
  function show(which) {
    $("#live").hidden = which !== "live"; $("#result").hidden = which !== "result"; $("#stageEmpty").hidden = which !== "empty";
  }

  // ---------- recording ----------
  function errorText(e) {
    var n = e && e.name;
    if (n === "NotAllowedError") return "Screen sharing was cancelled or blocked. Press Start and pick a screen, window or tab.";
    if (n === "NotFoundError") return "No screen source was found to share.";
    if (n === "NotReadableError") return "The screen couldn't be read. Another app may be blocking capture.";
    if (n === "NotSupportedError" || n === "TypeError") return "This browser doesn't support these capture settings.";
    return "Couldn't start: " + (e && e.message || e);
  }

  async function onStart() {
    save();
    var fmt = formats.filter(function (f) { return f.mime === fmtSel.value; })[0] || formats[0];
    if (!fmt) return S3.toast("This browser can't record video.", "error");
    var display, mic = null, ctx = null;
    $("#start").disabled = true;
    try {
      display = await navigator.mediaDevices.getDisplayMedia(displayConstraints(settings.res, +settings.fps, settings.sysAudio));
    } catch (e) { $("#start").disabled = false; setStatus("Not started"); return S3.toast(errorText(e), "error"); }
    if (settings.mic) {
      try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch (e) { S3.toast("Microphone blocked, recording without it.", "error"); }
    }
    var streams = [display].concat(mic ? [mic] : []);
    var vTrack = display.getVideoTracks()[0];
    var tracks = [vTrack], micGain = null;
    var dAudio = display.getAudioTracks();
    if (settings.sysAudio && !dAudio.length) S3.toast("No system audio: tick \"Share audio\" in the picker (Chrome/Edge, tabs or whole screen).");
    if (mic && dAudio.length) {
      ctx = new AudioContext(); await ctx.resume();
      var dest = ctx.createMediaStreamDestination();
      var gains = mixInto(ctx, [
        { node: ctx.createMediaStreamSource(new MediaStream(dAudio)), gain: 1 },
        { node: ctx.createMediaStreamSource(mic), gain: settings.micVol / 100 }
      ], dest);
      micGain = gains[1];
      tracks = tracks.concat(dest.stream.getAudioTracks());
    } else if (mic) {
      ctx = new AudioContext(); await ctx.resume();
      var d2 = ctx.createMediaStreamDestination();
      micGain = mixInto(ctx, [{ node: ctx.createMediaStreamSource(mic), gain: settings.micVol / 100 }], d2)[0];
      tracks = tracks.concat(d2.stream.getAudioTracks());
    } else tracks = tracks.concat(dAudio);

    var live = $("#live"); live.srcObject = display; show("live"); live.play().catch(function () {});
    var cd = +settings.countdown;
    for (var i = cd; i > 0; i--) {
      $("#count").hidden = false; $("#count").textContent = i; setStatus("Starting in " + i, "warn");
      await new Promise(function (r) { setTimeout(r, 1000); });
      if (vTrack.readyState === "ended") break;
    }
    $("#count").hidden = true;
    if (vTrack.readyState === "ended") { cleanup(streams, ctx); show("empty"); $("#start").disabled = false; setStatus("Cancelled"); return; }
    begin(new MediaStream(tracks), streams, ctx, fmt, micGain);
  }

  function begin(stream, streams, ctx, fmt, micGain) {
    var s = stream.getVideoTracks()[0].getSettings ? stream.getVideoTracks()[0].getSettings() : {};
    var w = s.width || 1280, hgt = s.height || 720, fps = s.frameRate || +settings.fps;
    var recorder = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: bitrateFor(w, hgt, Math.min(fps, 60), settings.quality) });
    rec = { recorder: recorder, streams: streams, ctx: ctx, chunks: [], bytes: 0, started: performance.now(), pausedAt: 0, pausedTotal: 0, fmt: fmt, micGain: micGain, w: w, h: hgt };
    $("#dims").textContent = w + "×" + hgt;
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) { rec.chunks.push(e.data); rec.bytes += e.data.size; $("#size").textContent = S3.fmtBytes(rec.bytes); } };
    recorder.onstop = finish;
    stream.getVideoTracks()[0].addEventListener("ended", function () { if (rec && rec.recorder.state !== "inactive") rec.recorder.stop(); });
    recorder.start(1000);
    rec.timer = setInterval(tick, 250);
    $("#start").hidden = true; $("#pause").hidden = false; $("#stop").hidden = false; $("#resultActions").hidden = true;
    $("#stageTitle").textContent = "Recording"; setStatus("● Recording", "bad");
    $("#pause").innerHTML = '<svg class="i"><use href="#i-pause"/></svg>Pause';
    return rec;
  }
  function elapsed() {
    if (!rec) return 0;
    var now = rec.pausedAt || performance.now();
    return (now - rec.started - rec.pausedTotal) / 1000;
  }
  function tick() { $("#timer").textContent = fmtTime(elapsed()); }
  function togglePause() {
    if (!rec) return;
    var r = rec.recorder;
    if (r.state === "recording") { r.pause(); rec.pausedAt = performance.now(); setStatus("Paused", "warn"); $("#pause").innerHTML = '<svg class="i"><use href="#i-play"/></svg>Resume'; }
    else if (r.state === "paused") { r.resume(); rec.pausedTotal += performance.now() - rec.pausedAt; rec.pausedAt = 0; setStatus("● Recording", "bad"); $("#pause").innerHTML = '<svg class="i"><use href="#i-pause"/></svg>Pause'; }
  }
  function cleanup(streams, ctx) {
    streams.forEach(function (st) { st.getTracks().forEach(function (t) { t.stop(); }); });
    if (ctx) ctx.close().catch(function () {});
  }
  function finish() {
    var r = rec; rec = null;
    clearInterval(r.timer);
    var dur = (performance.now() - r.started - r.pausedTotal - (r.pausedAt ? performance.now() - r.pausedAt : 0)) / 1000;
    cleanup(r.streams, r.ctx);
    $("#live").srcObject = null;
    var blob = new Blob(r.chunks, { type: r.fmt.mime.split(";")[0] });
    var take = { blob: blob, url: URL.createObjectURL(blob), name: fileName(new Date(), r.fmt.ext), dur: dur, dims: r.w + "×" + r.h };
    takes.unshift(take);
    showTake(take);
    renderTakes();
    $("#start").hidden = false; $("#start").disabled = !canDisplay; $("#pause").hidden = true; $("#stop").hidden = true;
    S3.done();
    if (r.onDone) r.onDone(take);
  }
  function showTake(t) {
    current = t;
    var v = $("#result"); v.src = t.url; show("result");
    $("#stageTitle").textContent = "Your recording"; setStatus("Saved in this tab", "ok");
    $("#timer").textContent = fmtTime(t.dur); $("#size").textContent = S3.fmtBytes(t.blob.size); $("#dims").textContent = t.dims;
    $("#resultActions").hidden = false;
  }
  function renderTakes() {
    var box = $("#takes"); box.innerHTML = "";
    $("#takesCard").hidden = !takes.length;
    takes.forEach(function (t) {
      box.appendChild(S3.h("div", { "class": "take" + (t === current ? " on" : "") }, [
        S3.h("button", { "class": "take-name", title: "Show in preview", onclick: function () { showTake(t); renderTakes(); } }, [t.name]),
        S3.h("span", { "class": "faint", text: fmtTime(t.dur) + " · " + S3.fmtBytes(t.blob.size) + " · " + t.dims }),
        S3.h("span", { "class": "grow" }),
        S3.h("button", { "class": "btn small", html: S3.icon("download") + "Download", onclick: function () { S3.download(t.blob, t.name); } }),
        S3.h("button", { "class": "btn small ghost icon", "aria-label": "Remove " + t.name, html: S3.icon("trash"), onclick: function () {
          takes.splice(takes.indexOf(t), 1); URL.revokeObjectURL(t.url);
          if (current === t) { current = null; $("#result").removeAttribute("src"); show("empty"); $("#resultActions").hidden = true; setStatus("Ready"); }
          renderTakes();
        } })
      ]));
    });
  }

  $("#start").addEventListener("click", onStart);
  $("#pause").addEventListener("click", togglePause);
  $("#stop").addEventListener("click", function () { if (rec && rec.recorder.state !== "inactive") rec.recorder.stop(); });
  $("#dl").addEventListener("click", function () { if (current) { S3.download(current.blob, current.name); S3.done(); } });
  $("#again").addEventListener("click", function () { current = null; show("empty"); $("#resultActions").hidden = true; setStatus("Ready"); renderTakes(); $("#start").focus(); });
  window.addEventListener("beforeunload", function (e) { if (rec || takes.length) { e.preventDefault(); e.returnValue = ""; } });

  // ---------- demo: records an animated canvas through the same pipeline ----------
  window.S3_DEMO = function () {
    if (!canRecord || !formats.length) return;
    var c = document.createElement("canvas"); c.width = 1280; c.height = 720;
    var g = c.getContext("2d"), t0 = performance.now(), raf;
    function draw() {
      var t = (performance.now() - t0) / 1000;
      var grad = g.createLinearGradient(0, 0, 1280, 720); grad.addColorStop(0, "#0f2a33"); grad.addColorStop(1, "#1c1340");
      g.fillStyle = grad; g.fillRect(0, 0, 1280, 720);
      g.fillStyle = "rgba(255,255,255,.06)"; g.fillRect(80, 70, 1120, 580);
      g.fillStyle = "rgba(255,255,255,.12)"; g.fillRect(80, 70, 1120, 44);
      ["#ff6b6b", "#f5c26b", "#6ee7a8"].forEach(function (col, i) { g.fillStyle = col; g.beginPath(); g.arc(108 + i * 24, 92, 7, 0, 7); g.fill(); });
      for (var i = 0; i < 7; i++) { g.fillStyle = i % 3 ? "rgba(255,255,255,.18)" : "rgba(61,214,208,.55)"; g.fillRect(130, 160 + i * 52, 420 + 260 * Math.sin(i + t), 22); }
      g.fillStyle = "#3dd6d0"; g.beginPath(); g.arc(900 + 120 * Math.cos(t * 2), 380 + 90 * Math.sin(t * 2), 46, 0, 7); g.fill();
      raf = requestAnimationFrame(draw);
    }
    draw();
    var stream = c.captureStream(30);
    return new Promise(function (res) {
      var r = begin(stream, [stream], null, formats[0], null);
      r.w = 1280; r.h = 720; $("#dims").textContent = "1280×720";
      r.onDone = function () { cancelAnimationFrame(raf); var v = $("#result"); v.addEventListener("loadeddata", function () { res(); }, { once: true }); setTimeout(res, 2500); };
      setTimeout(function () { r.recorder.stop(); }, 1400);
    });
  };

  // ---------- self-test ----------
  window.S3_SELFTEST = async function () {
    var ok = fmtTime(0) === "0:00" && fmtTime(59.9) === "0:59" && fmtTime(61) === "1:01" && fmtTime(3725.4) === "1:02:05";
    ok = ok && bitrateFor(1920, 1080, 30, "high") === 6220800 && bitrateFor(320, 240, 15, "standard") === 1e6 && bitrateFor(3840, 2160, 60, "max") === 40e6;
    var fs = supportedFormats(function (m) { return m.indexOf("mp4") > 0 || m === "video/webm"; });
    ok = ok && fs.length === 3 && fs[0].mime === "video/webm" && fs[1].ext === "mp4";
    var c = displayConstraints("720", 30, true);
    ok = ok && c.video.height.max === 720 && c.video.width.max === 1280 && c.video.frameRate.max === 30 && c.audio === true;
    ok = ok && !displayConstraints("native", 60, false).video.width && displayConstraints("native", 60, false).audio === false;
    ok = ok && fileName(new Date(2026, 0, 5, 9, 7, 3), "webm") === "screen-2026-01-05_09-07-03.webm";
    // mixer: 0.25 at gain 1 + 0.5 at gain 0.5 must sum to 0.5
    var off = new OfflineAudioContext(1, 256, 8000);
    var a = off.createConstantSource(), b = off.createConstantSource();
    a.offset.value = 0.25; b.offset.value = 0.5;
    mixInto(off, [{ node: a, gain: 1 }, { node: b, gain: 0.5 }], off.destination);
    a.start(); b.start();
    var out = (await off.startRendering()).getChannelData(0);
    ok = ok && Math.abs(out[100] - 0.5) < 1e-6;
    return ok;
  };
})();
