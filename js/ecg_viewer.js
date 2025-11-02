/**
 * ecg_viewer.js — просмотрщик ЭКГ на canvas (минутная страница).
 * Ожидает:
 *   drupalSettings.ecgAnalysis = {
 *     fs: number,         // частота дискретизации (Гц)
 *     waveHead: number[], // предпросмотр сигнала
 *     rpeaks: number[]    // индексы R-пиков (необязательно)
 *   }
 * В шаблоне — <canvas id="ecg-canvas"> (может быть один или несколько).
 */
(function (Drupal) {
  'use strict';

  // ===== Минутная страница: 6 панелей × 10 с =====
  const MINUTE_PAGE_MODE = true;
  const PANELS = 6;
  const PANEL_SECONDS = 10;

  // Геометрия панелей
  const PANEL_HEIGHT = 120;        // высота панели в CSS-px
  const PANEL_GAP = 12;            // отступ между панелями в CSS-px
	const VERTICAL_PADDING = 0.03;  // 6% сверху и снизу

  // Ширина: канвас тянется до ширины контейнера, но не шире этого предела
  const MAX_CANVAS_WIDTH_PX = 1250; // при fs=125 и 10с → 1250 px = 1 px/сэмпл

  // ===== Утилиты =====
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function ensureCssSize(canvas) {
    // Канвас заполняет контейнер, но не шире MAX_CANVAS_WIDTH_PX.
    // Это поведение безопаснее фиксированной ширины.
    if (!canvas.style.width)    canvas.style.width = '100%';
    if (!canvas.style.maxWidth) canvas.style.maxWidth = MAX_CANVAS_WIDTH_PX + 'px';

    // Высота ровно под 6 панелей.
    const hCss = PANELS * PANEL_HEIGHT + (PANELS - 1) * PANEL_GAP;
    if (!canvas.style.height)   canvas.style.height = hCss + 'px';
  }

  function resizeCanvasToDisplaySize(canvas, ctx) {
    // Берём фактическую видимую ширину (ограничена max-width)
    const cssW = Math.min(canvas.clientWidth || MAX_CANVAS_WIDTH_PX, MAX_CANVAS_WIDTH_PX);
    const hCss = PANELS * PANEL_HEIGHT + (PANELS - 1) * PANEL_GAP;
    const cssH = canvas.clientHeight || hCss;

    const dpr = window.devicePixelRatio || 1;
    const displayW = Math.max(1, Math.floor(cssW * dpr));
    const displayH = Math.max(1, Math.floor(cssH * dpr));

    if (canvas.width !== displayW || canvas.height !== displayH) {
      canvas.width = displayW;
      canvas.height = displayH;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // retina-friendly
    }
    return { width: cssW, height: cssH };
  }

  // Глобальная статистика по минуте (для единого масштаба)
  function computeGlobalStats(data, fromIndex, length) {
    const start = Math.max(0, fromIndex|0);
    const end = Math.min(data.length, (start + length)|0);
    if (end - start < 2) return { ymin: 0, ymax: 1, mean: 0, amp: 1 };

    let ymin = +Infinity, ymax = -Infinity, sum = 0, cnt = 0;
    for (let i = start; i < end; i++) {
      const v = data[i];
      if (v < ymin) ymin = v;
      if (v > ymax) ymax = v;
      sum += v; cnt++;
    }
    const mean = cnt ? (sum / cnt) : 0;
    let amp = Math.max(1, ymax - ymin);
    if (!isFinite(amp) || amp <= 0) amp = 1;
    return { ymin, ymax, mean, amp };
  }

  // Сетка: секунды по X + 5 горизонтальных линий
  function drawGrid(ctx, w, h, fs, viewStart, viewLen) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.1)';

    // Вертикальные линии на каждую секунду
    const sps = fs;
    const tStart = Math.floor(viewStart / sps);
    const tEnd   = Math.ceil((viewStart + viewLen) / sps);
    ctx.beginPath();
    for (let s = tStart; s <= tEnd; s++) {
      const sx = (s * sps - viewStart) / viewLen * w;
      if (sx >= -1 && sx <= w + 1) {
        const xi = Math.round(sx) + 0.5;
        ctx.moveTo(xi, 0);
        ctx.lineTo(xi, h);
      }
    }
    ctx.stroke();

    // Горизонтальные деления (5 рядов)
    ctx.beginPath();
    const rows = 5;
    for (let i = 1; i < rows; i++) {
      const y = Math.round((i / rows) * h) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    ctx.restore();
  }

  // Сигнал: можно передать глобальные stats, чтобы масштаб был общий
	function drawSignal(ctx, w, h, data, fs, viewStart, viewLen, stats) {
		const start = Math.max(0, Math.floor(viewStart));
		const end   = Math.min(data.length, Math.ceil(viewStart + viewLen));

		// Пустая панель — горизонтальная линия по центру
		if (end - start < 2) {
			ctx.save();
			ctx.strokeStyle = 'rgba(0,0,0,0.25)';
			ctx.lineWidth = 1;
			const y = Math.floor(h / 2) + 0.5;
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(w, y);
			ctx.stroke();
			ctx.restore();
			return null;
		}

		// --- ЕДИНЫЙ "tight fit" масштаб по минуте ---
		// Берём общий минимум/максимум за минуту, добавляем небольшие отступы.
		let lo = (stats && Number.isFinite(stats.ymin)) ? stats.ymin : 0;
		let hi = (stats && Number.isFinite(stats.ymax)) ? stats.ymax : 1;
		if (!(hi > lo)) { hi = lo + 1; }  // защита от hi==lo

		const padTop = VERTICAL_PADDING * h;
		const padBot = VERTICAL_PADDING * h;
		const innerH = Math.max(1, h - padTop - padBot);

		const toX = (i) => ((i - viewStart) / viewLen) * w;
		const toY = (v) => {
			// frac=0 → v=lo → внизу; frac=1 → v=hi → вверху
			const frac = (v - lo) / (hi - lo);
			const yInner = (1 - frac) * innerH;      // 0..innerH
			return Math.round(padTop + yInner) + 0.5; // в координатах панели
		};

		ctx.save();
		ctx.lineWidth = 1.25;
		ctx.strokeStyle = 'rgba(0,0,0,0.9)';
		ctx.beginPath();

		let first = true;
		for (let i = start; i < end; i++) {
			const x = toX(i);
			if (x < -2 || x > w + 2) continue;
			const y = toY(data[i]);
			if (first) { ctx.moveTo(x, y); first = false; }
			else { ctx.lineTo(x, y); }
		}
		ctx.stroke();
		ctx.restore();

		return true;
	}

  // Маркеры R-пиков
  function drawRPeaks(ctx, w, h, rpeaks, fs, viewStart, viewLen) {
    if (!rpeaks || !rpeaks.length) return;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(220, 0, 0, 0.85)';
    for (let k = 0; k < rpeaks.length; k++) {
      const s = rpeaks[k];
      if (s < viewStart || s > viewStart + viewLen) continue;
      const x = ((s - viewStart) / viewLen) * w;
      const xi = Math.round(x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(xi, 0);
      ctx.lineTo(xi, h);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Рамка панели и более тёмный разделитель снизу
  function drawPanelFrame(ctx, w, h) {
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.moveTo(0, h - 0.5);
    ctx.lineTo(w, h - 0.5);
    ctx.stroke();
    ctx.restore();
  }

  Drupal.behaviors.ecgViewer = {
    attach: function (context, settings) {
      const cfg = (settings && settings.ecgAnalysis) || {};
      const data   = (cfg.waveHead || []).map(Number);
      const fs     = Number(cfg.fs || 125);
      const rpeaks = Array.isArray(cfg.rpeaks) ? cfg.rpeaks : [];

      // Может вызываться на разных контекстах (BigPipe/AJAX),
      // ищем все canvas и инициализируем каждый ровно один раз.
      const canvases = (context.querySelectorAll ? context.querySelectorAll('#ecg-canvas') : []) || [];
      canvases.forEach((canvas) => {
        if (!canvas) return;
        if (canvas.dataset && canvas.dataset.ecgInit === '1') return;
        if (canvas.dataset) canvas.dataset.ecgInit = '1';

        const ctx = canvas.getContext('2d');
        ensureCssSize(canvas);

        // Старый режим (если когда-нибудь выключите минутный)
        let viewStart = 0;
        let viewLen   = Math.max(1, Math.floor(fs * 5));
        viewLen = Math.min(viewLen, Math.max(1, data.length));

        // Логи диагностики
        console.log('[ECG] fs=', fs, 'samples=', data.length, 'seconds=', (data.length / fs).toFixed(2));

        // Подготовка глобальной статистики по минуте для единого масштаба
        const samplesPerPanel = Math.max(1, Math.floor(fs * PANEL_SECONDS)); // 10с → fs*10
        const minuteSamples   = Math.max(1, samplesPerPanel * PANELS);       // 60с
        const available       = Math.min(data.length, minuteSamples);
        const globalStats     = computeGlobalStats(data, 0, available);

        function renderPanel(y0, hRow, segStart, segLen, w) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, y0, w, hRow);
          ctx.clip();
          ctx.translate(0, y0);

          const _prevVS = viewStart, _prevVL = viewLen;
          viewStart = segStart; viewLen = segLen;

          drawGrid(ctx, w, hRow, fs, viewStart, viewLen);
          // единый вертикальный масштаб: передаём globalStats
          drawSignal(ctx, w, hRow, data, fs, viewStart, viewLen, globalStats);
          drawRPeaks(ctx, w, hRow, rpeaks, fs, viewStart, viewLen);

          ctx.fillStyle = 'rgba(0,0,0,.65)';
          ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
          const t0 = Math.floor(viewStart / fs);
          const t1 = Math.floor((viewStart + viewLen) / fs);
          ctx.fillText(`${t0}–${t1} c`, 8, 14);

          viewStart = _prevVS; viewLen = _prevVL;

          ctx.restore();
          ctx.save();
          ctx.translate(0, y0);
          drawPanelFrame(ctx, w, hRow);
          ctx.restore();
        }

        function render() {
          const dims = resizeCanvasToDisplaySize(canvas, ctx);
          const w = dims.width;
          const h = dims.height;

          // Очистка и фон
          ctx.clearRect(0, 0, w, h);
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);

          if (MINUTE_PAGE_MODE) {
            const hRow = PANEL_HEIGHT;
            const gap  = PANEL_GAP;

            for (let r = 0; r < PANELS; r++) {
              const segStart = r * samplesPerPanel; // 0–10, 10–20, …
              const y0 = r * (hRow + gap);
              renderPanel(y0, hRow, segStart, samplesPerPanel, w);
            }
            return;
          }

          // --- Старый режим (одна панель, зум/пан) ---
          drawGrid(ctx, w, h, fs, viewStart, viewLen);
          drawSignal(ctx, w, h, data, fs, viewStart, viewLen, null);
          drawRPeaks(ctx, w, h, rpeaks, fs, viewStart, viewLen);
        }

        // Зум/пан отключены в минутном режиме: обработчики просто ничего не делают
        function onWheel(e) { if (MINUTE_PAGE_MODE) return; e.preventDefault(); /* старый код — опущен */ }
        function onDown(e)  { if (MINUTE_PAGE_MODE) return; e.preventDefault(); /* старый код — опущен */ }
        function onMove(e)  { if (MINUTE_PAGE_MODE) return; /* ... */ }
        function onUp()     { if (MINUTE_PAGE_MODE) return; /* ... */ }

        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('mousedown', onDown, { passive: false });
        canvas.addEventListener('mousemove', onMove, { passive: false });
        window.addEventListener('mouseup', onUp, { passive: true });
        canvas.addEventListener('touchstart', onDown, { passive: false });
        canvas.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onUp, { passive: true });
        window.addEventListener('touchcancel', onUp, { passive: true });

        render();
        window.addEventListener('resize', render, { passive: true });
      });
    }
  };
})(Drupal);
