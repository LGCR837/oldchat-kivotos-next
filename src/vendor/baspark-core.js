/***********************************************************************
 *                         BASpark-Core v2
 * 本项目为 BASpark 的分支项目，用于在 Web 中快速调用点击效果
 * 原项目地址:https://github.com/DoomVoss/BASpark
 * 此项目地址:https://github.com/LGCR837/BASpark-Core
 * 
 * 一键引用
 * <script src="baspark-core.js"></script>
 * 
 * 一键带参数引用 (参数详见下面参数表)
 * <script src="baspark-core.js" data-baspark='{"color":"255,100,100","scale":1.2}'></script>
 *
 * 运行时参数修改 (可包含多个参数)
 * BASpark.updateSettings({ color: '100,200,255' });
 * 
 * 参数表
 *   color       颜色，默认值 '45,175,255'
 *   scale       缩放比例，默认值 1.2
 *   opacity     整体透明度 (0~1)，默认值 0.8
 *   trailEnabled 拖尾效果开关，默认值 true
 *   trailSpeed  拖尾速度系数，默认值 1.0
 *   clickSpeed  点击速度系数，默认值 1.0
 *   speed       整体速度系数（trailSpeed/clickSpeed的备用值），默认值 1.0
 *   maxTrail    最大拖尾点数，默认值 16
 *
 *                         Powered by LGCR837 
 ***********************************************************************/

(function (global) {
  'use strict';

  // ========== 动画常量 ==========
  const FILLED_CIRCLE_CFG = { rAddRate: 26, maxLife: 16 };
  const RINGS_ANIM_CFG = {
    rsList: [0, 0.08, 0.1],
    rRoundRateList: [0, 1, 1.5, 2],
    len: 1.1 * Math.PI,
    maxLife: 23,
    segNum: 10,
    minW: 0.4,
    maxW: 3.3,
    lenStopAddPoint: 0.1,
    lenStartDimPoint: 0.4,
  };
  const CREATE_CLICK_CFG = {
    rings: {
      rsList: [0, 0.03, 0.06],
      rRoundRateList: [0, 1, 1.5, 2],
      len: 1.1 * Math.PI,
    },
    sparksCount: 4,
  };

  function ringsEndColorFromRgb(rgbString) {
    return rgbString.split(',').map(Number).map(function (n) { return (n + 255 * 2) / 3; });
  }

  function injectStyles() {
    var styleId = 'baspark-core-styles';
    if (document.getElementById(styleId)) return;
    var style = document.createElement('style');
    style.id = styleId;
    style.textContent =
      '#baspark-canvas {' +
      '  position: fixed;' +
      '  left: 0;' +
      '  top: 0;' +
      '  width: 100%;' +
      '  height: 100%;' +
      '  pointer-events: none;' +
      '  z-index: 999999;' +
      '}';
    (document.head || document.documentElement).appendChild(style);
  }

  // ========== 核心类 ==========
  function MouseSpark(opts) {
    opts = opts || {};
    this.color = opts.color || '45,175,255';
    this.scale = opts.scale || 1.2;
    this.opacity = opts.opacity != null ? opts.opacity : 0.8;
    this.trailEnabled = opts.trailEnabled !== false;
    this.trailSpeed = opts.trailSpeed != null ? opts.trailSpeed : (opts.speed || 1.0);
    this.clickSpeed = opts.clickSpeed != null ? opts.clickSpeed : (opts.speed || 1.0);
    this.maxTrail = opts.maxTrail || 16;

    this.sparksPool = [];
    this.wavesPool = [];

    this.waves = [];
    this.sparks = [];
    this.trail = [];
    this.isDown = false;
    this.lastPos = null;
    this.baseFrameMs = 1000 / 60;
    this.maxDeltaMs = 100;
    this.lastFrameTime = performance.now();
    this.dpr = 1;
    this.cssWidth = 1;
    this.cssHeight = 1;
    this.previousDirtyRects = [];
    this.forceFullRedraw = true;

    this.ringsStartColor = [250, 252, 252];
    this.ringsEndColor = ringsEndColorFromRgb(this.color);

    this.initCanvas();
    this.bindEvents();
    var self = this;
    requestAnimationFrame(function (now) { self.animationLoops(now); });
  }

  MouseSpark.prototype.bindEvents = function () {
    var self = this;
    var getPos = function (e) { return { x: e.clientX, y: e.clientY }; };
    var dist = function (a, b) { return Math.hypot(a.x - b.x, a.y - b.y); };

    window.addEventListener('mousedown', function (e) {
      self.isDown = true;
      self.lastPos = getPos(e);
      self.createEffects(self.lastPos.x, self.lastPos.y);
    });

    window.addEventListener('mousemove', function (e) {
      if (!self.isDown) return;
      var p = getPos(e);
      var prev = self.lastPos;
      if (!prev) {
        self.lastPos = p;
        return;
      }
      if (dist(p, prev) > 2) {
        if (self.trailEnabled) {
          self.trail.push({ x: p.x, y: p.y, life: 1 });
          if (self.trail.length > self.maxTrail) self.trail.shift();
        }

        if (Math.random() < 0.3) {
          var a = Math.random() * Math.PI * 2;
          var speedAdjust = self.scale / 1.5;
          self.sparks.push({
            x: p.x + Math.cos(a) * 10 * self.scale,
            y: p.y + Math.sin(a) * 10 * self.scale,
            vx: Math.cos(a) * 1.3 * speedAdjust,
            vy: Math.sin(a) * 1.3 * speedAdjust,
            rot: Math.random() * Math.PI * 2,
            rs: 0.16,
            s: 9 * self.scale,
            a: 0.7,
            f: 0.95,
            fromClick: false,
          });
        }
      }
      self.lastPos = p;
    });

    window.addEventListener('mouseup', function () {
      self.isDown = false;
    });
  };

  MouseSpark.prototype.initCanvas = function () {
    injectStyles();
    var canvas = document.getElementById('baspark-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'baspark-canvas';
      document.body.appendChild(canvas);
    }
    this.mainCanvas = canvas;
    this.mainCtx = this.mainCanvas.getContext('2d');

    this.bufferCanvas = document.createElement('canvas');
    this.bufferCtx = this.bufferCanvas.getContext('2d');

    this.resize();

    var self = this;
    this._onResize = function () { self.resize(); };
    window.addEventListener('resize', this._onResize);
  };

  MouseSpark.prototype.alpha = function (value) {
    return Math.max(0, Math.min(1, value * this.opacity));
  };

  MouseSpark.prototype.resize = function () {
    var dpr = window.devicePixelRatio || 1;
    var cssWidth = Math.max(1, window.innerWidth);
    var cssHeight = Math.max(1, window.innerHeight);
    var w = Math.max(1, Math.floor(cssWidth * dpr));
    var h = Math.max(1, Math.floor(cssHeight * dpr));

    this.dpr = dpr;
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.mainCanvas.width = w;
    this.mainCanvas.height = h;
    this.bufferCanvas.width = w;
    this.bufferCanvas.height = h;
    this.previousDirtyRects = [];
    this.forceFullRedraw = true;

    this.bufferCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  MouseSpark.prototype.createEffects = function (x, y) {
    var rc = CREATE_CLICK_CFG.rings;
    var sparksCount = CREATE_CLICK_CFG.sparksCount;

    var wave;
    if (this.wavesPool.length > 0) {
      wave = this.wavesPool.pop();
    } else {
      wave = {};
    }
    if (!wave.ring) wave.ring = { segs: [] };

    wave.x = x;
    wave.y = y;
    wave.r = 0;
    wave.life = 0;
    wave.ring.ang = Math.random() * Math.PI * 2;
    wave.ring.rs = rc.rsList[Math.floor(Math.random() * rc.rsList.length)];
    wave.ring.segs[0] = {
      off: 0,
      len: rc.len,
      rRoundRate: rc.rRoundRateList[Math.floor(Math.random() * rc.rRoundRateList.length)],
    };
    wave.ring.segs[1] = {
      off: (Math.random() * 3 - 1.5) * Math.PI,
      len: rc.len,
      rRoundRate: rc.rRoundRateList[Math.floor(Math.random() * rc.rRoundRateList.length)],
    };

    this.waves.push(wave);

    var speedAdjust = this.scale / 1.5;
    for (var i = 0; i < sparksCount; i++) {
      var a = Math.random() * Math.PI * 2;
      var speed = (4.8 + Math.random() * 2) * speedAdjust;

      var spark;
      if (this.sparksPool.length > 0) {
        spark = this.sparksPool.pop();
      } else {
        spark = {};
      }

      spark.x = x;
      spark.y = y;
      spark.vx = Math.cos(a) * speed;
      spark.vy = Math.sin(a) * speed;
      spark.rot = Math.random() * Math.PI * 2;
      spark.rs = (Math.random() - 0.5) * 0.28;
      spark.s = (4 + Math.random() * 3) * this.scale;
      spark.a = 1;
      spark.f = 0.9;
      spark.fromClick = true;
      this.sparks.push(spark);
    }
  };

  MouseSpark.prototype._clearBuffer = function (rect) {
    var ctx = this.bufferCtx;
    if (rect) {
      ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
    } else {
      ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    }
  };

  MouseSpark.prototype._clearBufferRects = function (rects) {
    if (!rects || rects.length === 0) return;
    for (var i = 0; i < rects.length; i++) {
      this._clearBuffer(rects[i]);
    }
  };

  MouseSpark.prototype._updateTrail = function (frameScale) {
    var ctx = this.bufferCtx;
    var n = this.trail.length;
    var baseDecay = (this.isDown ? 0.085 : 0.18) * frameScale;
    var maxStep = 0.42;
    for (var i = n - 1; i >= 0; i--) {
      var t = this.trail[i];
      var span = Math.max(1, n - 1);
      var along = n > 1 ? i / span : 1;
      var towardCursorBias = 1.25 - 0.55 * along;
      var step = baseDecay * towardCursorBias;
      if (step > maxStep) step = maxStep;
      t.life -= step;
      if (t.life <= 0) this.trail.splice(i, 1);
    }

    var head = this.lastPos;
    var pts =
      head && this.trail.length > 0
        ? this.trail.concat([{ x: head.x, y: head.y, life: 1 }])
        : this.trail.slice();

    if (pts.length < 2) return;

    var gap = Math.hypot(
      pts[pts.length - 1].x - pts[pts.length - 2].x,
      pts[pts.length - 1].y - pts[pts.length - 2].y
    );
    if (gap < 0.75 && this.trail.length === 1) {
      var fade = Math.max(0, this.trail[0].life);
      ctx.shadowColor = 'transparent';
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, 2.5 + 2 * fade, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + this.color + ', ' + (fade * 0.85) + ')';
      ctx.fill();
      return;
    }

    ctx.lineWidth = 5.0;
    ctx.shadowColor = 'rgba(' + this.color + ', 0.6)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    var lastIdx = pts.length - 1;
    for (var i2 = 0; i2 < lastIdx; i2++) {
      var alphaStart = i2 / lastIdx;
      var alphaEnd = (i2 + 1) / lastIdx;
      var a0 = pts[i2];
      var a1 = pts[i2 + 1];

      var segGrad = ctx.createLinearGradient(a0.x, a0.y, a1.x, a1.y);
      segGrad.addColorStop(0, 'rgba(' + this.color + ', ' + alphaStart + ')');
      segGrad.addColorStop(1, 'rgba(' + this.color + ', ' + alphaEnd + ')');

      ctx.beginPath();
      ctx.moveTo(a0.x, a0.y);
      ctx.lineTo(a1.x, a1.y);
      ctx.strokeStyle = segGrad;
      ctx.stroke();
    }

    ctx.shadowColor = 'transparent';
  };

  MouseSpark.prototype._strokeRingSegment = function (wx, wy, radius, a0, a1, lineWidth, strokeStyle) {
    var ctx = this.bufferCtx;
    ctx.beginPath();
    ctx.arc(wx, wy, radius, a0, a1);
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = strokeStyle;
    ctx.stroke();
  };

  MouseSpark.prototype._updateWaves = function (clickFrameScale) {
    var filled = FILLED_CIRCLE_CFG;
    var rings = RINGS_ANIM_CFG;
    var ctx = this.bufferCtx;

    var self = this;
    var updateFilledCircle = function (w, waveProg) {
      w.life += clickFrameScale;
      var ease = 1 - Math.pow(1 - waveProg, 3);
      w.r = filled.rAddRate * self.scale * ease;
      var alpha = Math.max(0, 1 - waveProg);
      if (alpha > 0) {
        ctx.beginPath();
        ctx.arc(w.x, w.y, w.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + self.color + ',' + self.alpha(alpha) + ')';
        ctx.fill();
      }
    };

    var updateRings = function (w, ringProg) {
      var getWeightProp = function (t) { return Math.min(2 - Math.abs(4 * (t - 0.5)), 1); };
      var ringRgbAt = function (rProg) {
        var t = Math.min(1.2 * rProg, 1);
        var r = self.ringsStartColor[0] * (1 - t) + self.ringsEndColor[0] * t;
        var g = self.ringsStartColor[1] * (1 - t) + self.ringsEndColor[1] * t;
        var b = self.ringsStartColor[2] * (1 - t) + self.ringsEndColor[2] * t;
        return [Math.round(r), Math.round(g), Math.round(b)];
      };
      var getAlpha = function (rProg) { return Math.min(1.1 - 0.3 * rProg, 1); };

      var r = w.ring;
      r.ang -= r.rs * clickFrameScale;

      var start, end, len, seg;

      for (var i = 0; i < 2; i++) {
        seg = r.segs[i];
        var base = r.ang + seg.off;

        if (ringProg <= rings.lenStopAddPoint) {
          len = seg.len * (ringProg / rings.lenStopAddPoint);
          end = base + seg.len;
          start = end - len;
        } else if (ringProg > rings.lenStartDimPoint) {
          len = seg.len * (1 - (ringProg - rings.lenStartDimPoint) / (1 - rings.lenStartDimPoint));
          start = base;
          end = start + len;
        } else {
          len = seg.len;
          start = base;
          end = start + len;
        }

        var lineWidthMul = Math.min(-0.8 * (ringProg - 0.8) + 1, 1);
        var rgb = ringRgbAt(ringProg);
        var alphaRing = getAlpha(ringProg);

        for (var k = 0; k < rings.segNum; k++) {
          var t0 = k / rings.segNum;
          var t1 = (k + 1) / rings.segNum;
          var a0 = start + (end - start) * t0;
          var a1 = start + (end - start) * t1;

          if (Math.abs(a1 - a0) < 0.01) continue;

          var wT = getWeightProp(t0);
          var lw = (rings.minW * (1 - wT) + rings.maxW * wT) * lineWidthMul;
          var strokeStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alphaRing + ')';
          var radius = w.r + seg.rRoundRate * self.scale;
          self._strokeRingSegment(w.x, w.y, radius, a0, a1, lw, strokeStyle);
        }
      }
    };

    for (var i = this.waves.length - 1; i >= 0; i--) {
      var w = this.waves[i];
      var waveProg = Math.min(w.life / filled.maxLife, 1);
      var ringProg = Math.min(w.life / rings.maxLife, 1);

      updateFilledCircle(w, waveProg);
      updateRings(w, ringProg);

      if (ringProg >= 1 && waveProg >= 1) {
        this.wavesPool.push(this.waves[i]);
        this.waves.splice(i, 1);
      }
    }
  };

  MouseSpark.prototype._updateSparks = function (clickFrameScale, trailFrameScale) {
    var ctx = this.bufferCtx;
    for (var i = this.sparks.length - 1; i >= 0; i--) {
      var s = this.sparks[i];
      var fs = s.fromClick ? clickFrameScale : trailFrameScale;
      s.x += s.vx * fs;
      s.y += s.vy * fs;
      s.vx *= Math.pow(s.f, fs);
      s.vy *= Math.pow(s.f, fs);
      s.rot += s.rs * fs;
      s.a -= 0.032 * fs;
      if (s.a <= 0) {
        this.sparksPool.push(this.sparks[i]);
        this.sparks.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.beginPath();
      ctx.moveTo(0, -s.s);
      ctx.lineTo(s.s * 0.6, s.s * 0.6);
      ctx.lineTo(-s.s * 0.6, s.s * 0.6);
      ctx.fillStyle = 'rgba(255,255,255,' + this.alpha(s.a) + ')';
      ctx.fill();
      ctx.restore();
    }
  };

  MouseSpark.prototype._canvasRect = function () {
    return { x: 0, y: 0, w: this.cssWidth, h: this.cssHeight };
  };

  MouseSpark.prototype._clipRect = function (rect) {
    if (!rect) return null;
    var x0 = Math.max(0, Math.floor(rect.x));
    var y0 = Math.max(0, Math.floor(rect.y));
    var x1 = Math.min(this.cssWidth, Math.ceil(rect.x + rect.w));
    var y1 = Math.min(this.cssHeight, Math.ceil(rect.y + rect.h));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  MouseSpark.prototype._pointRect = function (x, y, padding) {
    return { x: x - padding, y: y - padding, w: padding * 2, h: padding * 2 };
  };

  MouseSpark.prototype._segmentRect = function (a, b, padding) {
    var x0 = Math.min(a.x, b.x) - padding;
    var y0 = Math.min(a.y, b.y) - padding;
    var x1 = Math.max(a.x, b.x) + padding;
    var y1 = Math.max(a.y, b.y) + padding;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  MouseSpark.prototype._intersects = function (a, b) {
    return (
      a.x <= b.x + b.w &&
      a.x + a.w >= b.x &&
      a.y <= b.y + b.h &&
      a.y + a.h >= b.y
    );
  };

  MouseSpark.prototype._unionRect = function (a, b) {
    var x0 = Math.min(a.x, b.x);
    var y0 = Math.min(a.y, b.y);
    var x1 = Math.max(a.x + a.w, b.x + b.w);
    var y1 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  MouseSpark.prototype._mergeRects = function (rects) {
    var merged = [];
    for (var i = 0; i < rects.length; i++) {
      var raw = rects[i];
      var rect = this._clipRect(raw);
      if (!rect) continue;

      for (var j = 0; j < merged.length; j++) {
        if (this._intersects(merged[j], rect)) {
          rect = this._unionRect(merged[j], rect);
          merged.splice(j, 1);
          j = -1;
        }
      }

      merged.push(rect);
    }
    return merged;
  };

  MouseSpark.prototype._getEffectRects = function () {
    var rects = [];
    var trailPad = 18 * this.scale + 12;
    var trailPoints =
      this.lastPos && this.trail.length > 0
        ? this.trail.concat([{ x: this.lastPos.x, y: this.lastPos.y }])
        : this.trail;

    if (trailPoints.length === 1) {
      rects.push(this._pointRect(trailPoints[0].x, trailPoints[0].y, trailPad));
    } else {
      for (var i = 0; i < trailPoints.length - 1; i++) {
        rects.push(this._segmentRect(trailPoints[i], trailPoints[i + 1], trailPad));
      }
    }

    var wavePad = 34 * this.scale + RINGS_ANIM_CFG.maxW + 16;
    for (var j = 0; j < this.waves.length; j++) {
      var wave = this.waves[j];
      var radius = Math.max(wave.r || 0, FILLED_CIRCLE_CFG.rAddRate * this.scale) + wavePad;
      rects.push(this._pointRect(wave.x, wave.y, radius));
    }

    var maxFrameScale = this.maxDeltaMs / this.baseFrameMs;
    for (var k = 0; k < this.sparks.length; k++) {
      var spark = this.sparks[k];
      var speed = Math.hypot(spark.vx || 0, spark.vy || 0);
      var speedScale = spark.fromClick ? this.clickSpeed : this.trailSpeed;
      var motionPad = speed * maxFrameScale * speedScale;
      var sparkPad = Math.max(spark.s || 0, 9 * this.scale) * 2 + motionPad + 12;
      rects.push(this._pointRect(spark.x, spark.y, sparkPad));
    }

    return this._mergeRects(rects);
  };

  MouseSpark.prototype._getRenderRects = function () {
    if (this.forceFullRedraw) {
      return [this._canvasRect()];
    }
    return this._mergeRects(this.previousDirtyRects.concat(this._getEffectRects()));
  };

  MouseSpark.prototype._clipToRects = function (ctx, rects) {
    ctx.beginPath();
    for (var i = 0; i < rects.length; i++) {
      var rect = rects[i];
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
    }
    ctx.clip();
  };

  MouseSpark.prototype._renderToMain = function (rects) {
    var mainCtx = this.mainCtx;
    var mainCanvas = this.mainCanvas;
    var bufferCanvas = this.bufferCanvas;
    if (!rects || rects.length === 0) {
      mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
      mainCtx.drawImage(bufferCanvas, 0, 0);
      return;
    }

    var dpr = this.dpr || 1;
    for (var i = 0; i < rects.length; i++) {
      var rect = rects[i];
      var sx = Math.max(0, Math.floor(rect.x * dpr));
      var sy = Math.max(0, Math.floor(rect.y * dpr));
      var sw = Math.min(mainCanvas.width - sx, Math.ceil(rect.w * dpr));
      var sh = Math.min(mainCanvas.height - sy, Math.ceil(rect.h * dpr));
      if (sw <= 0 || sh <= 0) continue;

      mainCtx.clearRect(sx, sy, sw, sh);
      mainCtx.drawImage(bufferCanvas, sx, sy, sw, sh, sx, sy, sw, sh);
    }
  };

  MouseSpark.prototype.animationLoops = function (now) {
    var hasWork =
      this.waves.length > 0 ||
      this.sparks.length > 0 ||
      this.trail.length > 0;

    if (!hasWork) {
      this.lastFrameTime = now;
      if (this.previousDirtyRects.length > 0) {
        this._clearBufferRects(this.previousDirtyRects);
        this._renderToMain(this.previousDirtyRects);
        this.previousDirtyRects = [];
      }
      var self = this;
      requestAnimationFrame(function (nextNow) { self.animationLoops(nextNow); });
      return;
    }

    var deltaMs = Math.min(now - this.lastFrameTime, this.maxDeltaMs);
    this.lastFrameTime = now;
    var baseScale = deltaMs / this.baseFrameMs;
    var trailFrameScale = baseScale * this.trailSpeed;
    var clickFrameScale = baseScale * this.clickSpeed;

    var bctx = this.bufferCtx;
    var renderRects = this._getRenderRects();
    bctx.save();
    this._clipToRects(bctx, renderRects);
    bctx.globalCompositeOperation = 'lighter';

    this._clearBufferRects(renderRects);
    this._updateTrail(trailFrameScale);
    this._updateWaves(clickFrameScale);
    this._updateSparks(clickFrameScale, trailFrameScale);

    bctx.globalCompositeOperation = 'source-over';
    bctx.restore();

    this._renderToMain(renderRects);
    this.previousDirtyRects = this._getEffectRects();
    this.forceFullRedraw = false;

    var self2 = this;
    requestAnimationFrame(function (nextNow) { self2.animationLoops(nextNow); });
  };

  // ========== 公开 API ==========
  var BASpark = {};
  var instance = null;

  BASpark.init = function (opts) {
    if (instance) {
      BASpark.destroy();
    }
    opts = opts || {};
    instance = new MouseSpark(opts);
    return instance;
  };

  BASpark.updateSettings = function (settings) {
    if (!instance) return;
    settings = settings || {};
    if (settings.color != null) {
      instance.color = String(settings.color);
      instance.ringsEndColor = ringsEndColorFromRgb(instance.color);
    }
    if (settings.scale != null) {
      instance.scale = Math.max(0.5, Math.min(3, Number(settings.scale)));
    }
    if (settings.opacity != null) {
      instance.opacity = Math.max(0.1, Math.min(1, Number(settings.opacity)));
    }
    if (settings.trailEnabled != null) {
      instance.trailEnabled = Boolean(settings.trailEnabled);
      if (!instance.trailEnabled) {
        instance.trail.length = 0;
      }
    }
    if (settings.maxTrail != null) {
      instance.maxTrail = Math.max(1, Math.min(100, Number(settings.maxTrail)));
    }
    if (settings.trailSpeed != null) {
      instance.trailSpeed = Math.max(0.2, Math.min(3, Number(settings.trailSpeed)));
    }
    if (settings.clickSpeed != null) {
      instance.clickSpeed = Math.max(0.2, Math.min(3, Number(settings.clickSpeed)));
    }
  };

  BASpark.destroy = function () {
    if (!instance) return;
    if (instance._onResize) {
      window.removeEventListener('resize', instance._onResize);
      instance._onResize = null;
    }
    var canvas = document.getElementById('baspark-canvas');
    if (canvas && canvas.parentNode) {
      canvas.parentNode.removeChild(canvas);
    }
    instance = null;
  };

  BASpark.getInstance = function () {
    return instance;
  };

  // ========== 自动初始化 ==========
  function autoInit() {
    // 手动初始化模式：被宿主（如 Kivotos Next）接管时，由外部显式调用 BASpark.init/destroy，
    // 避免脚本一加载就默认开启点击效果（与完整版点击特效互斥场景需要默认关闭）
    if (global.__BASPARK_MANUAL_INIT__) return;
    var scripts = document.querySelectorAll('script[data-baspark]');
    var currentScript = document.currentScript || null;
    var targetScript = null;

    if (currentScript && currentScript.hasAttribute('data-baspark')) {
      targetScript = currentScript;
    } else if (scripts.length > 0) {
      targetScript = scripts[scripts.length - 1];
    }

    var opts = {};
    if (targetScript) {
      var raw = targetScript.getAttribute('data-baspark');
      if (raw) {
        try {
          opts = JSON.parse(raw);
        } catch (e) {
          if (typeof console !== 'undefined') {
            console.warn('[BASpark-Core] data-baspark JSON parse error:', e);
          }
        }
      }
    }

    BASpark.init(opts);
  }

  function domReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  domReady(autoInit);

  // 支持 AMD / CommonJS / 全局
  if (typeof define === 'function' && define.amd) {
    define([], function () { return BASpark; });
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = BASpark;
  } else {
    global.BASpark = BASpark;
  }

})(typeof window !== 'undefined' ? window : global);