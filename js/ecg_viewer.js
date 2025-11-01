/**
 * ecg_viewer.js — простой просмотрщик ЭКГ на canvas
 * Ожидает:
 *   drupalSettings.ecgAnalysis = {
 *     fs: number,              // частота дискретизации (Гц), напр. 125
 *     waveHead: number[],      // массив int (первые секунды для предпросмотра)
 *     rpeaks: number[]         // индексы отсчётов R-пиков (опционально)
 *   }
 * В шаблоне должен быть <canvas id="ecg-canvas">.
 */
(function (Drupal) {
  'use strict';

  // Утилиты
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function resizeCanvasToDisplaySize(canvas, ctx) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    // Если размеры не заданы стилями — зададим безопасные
    const cssW = rect.width  || 1200;
    const cssH = rect.height || 300;

    // Физические пиксели
    const needW = Math.round(cssW * dpr);
    const needH = Math.round(cssH * dpr);

    if (canvas.width !== needW || canvas.height !== needH) {
      canvas.width  = needW;
      canvas.height = needH;
    }

    // Все дальнейшие операции рисования будут масштабированы под DPR
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width: cssW, height: cssH, dpr };
  }

  function drawGrid(ctx, w, h, fs, viewStart, viewLen) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';

    // Вертикальные линии каждую секунду
    const samplesPerSec = Math.max(1, fs | 0);
    const tStartSec = Math.floor(viewStart / samplesPerSec);
    const tEndSec   = Math.ceil((viewStart + viewLen) / samplesPerSec);

    ctx.beginPath();
    for (let s = tStartSec; s <= tEndSec; s++) {
      const sx = (s * samplesPerSec - viewStart) / viewLen * w;
      if (sx >= -1 && sx <= w + 1) {
        ctx.moveTo(sx + 0.5, 0);
        ctx.lineTo(sx + 0.5, h);
      }
    }
    ctx.stroke();

    // Горизонтальные линии 5 шт по высоте
    ctx.beginPath();
    const rows = 5;
    for (let i = 1; i < rows; i++) {
      const y = (i / rows) * h;
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();

    ctx.restore();
  }

  function drawSignal(ctx, w, h, data, fs, viewStart, viewLen) {
    if (!data || data.length < 2) return;

    // Видимые границы индексов
    const start = Math.max(0, Math.floor(viewStart));
    const end   = Math.min(data.length, Math.ceil(viewStart + viewLen));
    if (end - start < 2) return;

    // DC-смещение по видимой области
    let sum = 0;
    for (let i = start; i < end; i++) sum += data[i];
    const mean = sum / (end - start);

    // Диапазон по амплитуде (после вычитания среднего)
    let vmin =  Infinity;
    let vmax = -Infinity;
    for (let i = start; i < end; i++) {
      const v = data[i] - mean;
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }
    // Паддинг 10%
    const pad = (vmax - vmin) * 0.10;
    const ymin = vmin - pad;
    const ymax = vmax + pad;
    const yrange = (ymax - ymin) || 1;

    // Децимация по ширине: одна точка на колонку (минимум шаг 1)
    const approxPoints = end - start;
    const step = Math.max(1, Math.floor(approxPoints / Math.max(1, Math.floor(w))));

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#0b66e0';
    ctx.beginPath();

    let first = true;
    for (let i = start; i < end; i += step) {
      const x = ((i - viewStart) / viewLen) * w;
      const vAdj = data[i] - mean;
      const y = h - ((vAdj - ymin) / yrange) * h;
      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.restore();

    return { ymin, ymax, mean }; // на случай отладки/оверлеев
  }

  function drawRPeaks(ctx, w, h, rpeaks, fs, viewStart, viewLen) {
    if (!rpeaks || !rpeaks.length) return;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(220, 0, 0, 0.85)';
    for (let k = 0; k < rpeaks.length; k++) {
      const s = rpeaks[k];
      if (s < viewStart || s > viewStart + viewLen) continue;
      const x = ((s - viewStart) / viewLen) * w;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }
    ctx.restore();
  }

  Drupal.behaviors.ecgViewer = {
    attach: function (context, settings) {
      const cfg = (settings && settings.ecgAnalysis) || {};
      const data = (cfg.waveHead || []).map(Number);
      const fs   = Number(cfg.fs || 125);
      const rpeaks = Array.isArray(cfg.rpeaks) ? cfg.rpeaks : [];

      // Инициализируем один раз на элемент
      const canvas = context.querySelector && context.querySelector('#ecg-canvas');
      if (!canvas || canvas.dataset.ecgViewerInit === '1') return;
      canvas.dataset.ecgViewerInit = '1';

      // Если данных нет — просто выходим
      if (!data.length) return;

      // Убедимся, что у canvas есть видимая высота (если нет — дадим дефолт)
      const hasExplicitHeight = !!canvas.style.height || !!canvas.getAttribute('height');
      if (!hasExplicitHeight) {
        // Только если не задано: безопасный дефолт
        canvas.style.width = canvas.style.width || '100%';
        canvas.style.height = canvas.style.height || '300px';
      }

      const ctx = canvas.getContext('2d');

      // Начальные параметры просмотра: 10 секунд или весь массив, если он короче
      const initialLen = Math.min(data.length, Math.max(fs * 10, 50));
      let viewStart = 0;              // индекс первого видимого сэмпла (float)
      let viewLen   = initialLen;     // сколько сэмплов влезает в текущий вид

      // Отрисовка
      function render() {
        const dims = resizeCanvasToDisplaySize(canvas, ctx);
        const w = dims.width;
        const h = dims.height;

        // Фон
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);

        // Сетка
        drawGrid(ctx, w, h, fs, viewStart, viewLen);

        // Сигнал
        drawSignal(ctx, w, h, data, fs, viewStart, viewLen);

        // R-пики
        drawRPeaks(ctx, w, h, rpeaks, fs, viewStart, viewLen);
      }

      // Зум мышью (горизонтальный). Центрируем вокруг курсора.
      function onWheel(e) {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left);
        const frac = clamp(x / Math.max(1, rect.width), 0, 1);

        const zoomFactor = Math.exp(-e.deltaY * 0.0015); // <1 — приближение, >1 — отдаление
        const minLen = 25;                       // минимум сэмплов в окне
        const maxLen = data.length;

        const centerSample = viewStart + frac * viewLen;
        const newLen = clamp(viewLen * zoomFactor, minLen, maxLen);
        viewStart = clamp(centerSample - frac * newLen, 0, Math.max(0, data.length - newLen));
        viewLen = newLen;

        render();
      }

      // Панорамирование: Drag
      let dragging = false;
      let lastX = 0;
      function onDown(e) {
        dragging = true;
        lastX = (e.touches ? e.touches[0].clientX : e.clientX);
        e.preventDefault();
      }
      function onMove(e) {
        if (!dragging) return;
        const clientX = (e.touches ? e.touches[0].clientX : e.clientX);
        const rect = canvas.getBoundingClientRect();
        const dx = clientX - lastX;
        lastX = clientX;

        // dx пикселей => смещение в сэмплах
        const frac = dx / Math.max(1, rect.width);
        const deltaSamples = frac * viewLen;
        viewStart = clamp(viewStart - deltaSamples, 0, Math.max(0, data.length - viewLen));

        render();
        e.preventDefault();
      }
      function onUp() {
        dragging = false;
      }

      // Resize
      const ro = new ResizeObserver(() => render());
      ro.observe(canvas);

      // Подписки
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('mousedown', onDown, { passive: false });
      canvas.addEventListener('mousemove', onMove, { passive: false });
      window.addEventListener('mouseup', onUp, { passive: true });

      canvas.addEventListener('touchstart', onDown, { passive: false });
      canvas.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onUp, { passive: true });
      window.addEventListener('touchcancel', onUp, { passive: true });

      // Первый рендер
      render();
    }
  };
})(Drupal);
