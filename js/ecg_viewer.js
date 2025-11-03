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
	const VERTICAL_PADDING = 0.06;  // 6% сверху и снизу
	
	// Максимальная допустимая амплитуда сигнала (в отсчётах int16)
	const AMP_HARD_CAP = 1500; // можно 1000..2000, подстройте по месту
	// опционально: позволить задать через drupalSettings.ecgAnalysis.ampCap

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

		// --- ЕДИНЫЙ "tight fit" масштаб по минуте с ЖЁСТКИМ ПОТОЛКОМ ---
		let lo = (stats && Number.isFinite(stats.ymin)) ? stats.ymin : 0;
		let hi = (stats && Number.isFinite(stats.ymax)) ? stats.ymax : 1;

		// 1) прижмём статистику к жёсткой рамке ±CAP
		// кап можно взять из drupalSettings.ecgAnalysis.ampCap, если передан
		const capFromSettings = (window.drupalSettings && window.drupalSettings.ecgAnalysis && Number(window.drupalSettings.ecgAnalysis.ampCap)) || null;
		const CAP = Number.isFinite(capFromSettings) ? capFromSettings : AMP_HARD_CAP;

		lo = Math.max(lo, -CAP);
		hi = Math.min(hi, +CAP);

		// если весь диапазон «сломался» (всё выше CAP или всё ниже -CAP) — поднимем базовый диапазон
		if (!(hi > lo)) { lo = -CAP; hi = CAP; }

		// небольшой внутренний отступ (как было)
		const padTop = VERTICAL_PADDING * h;
		const padBot = VERTICAL_PADDING * h;
		const innerH = Math.max(1, h - padTop - padBot);

		const toX = (i) => ((i - viewStart) / viewLen) * w;
		const toY = (v) => {
			const vv = Math.max(-CAP, Math.min(+CAP, v)); // на всякий случай отсекаем и саму кривую
			const frac = (vv - lo) / (hi - lo);           // 0..1
			const yInner = (1 - frac) * innerH;
			return Math.round(padTop + yInner) + 0.5;
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
			const filename = cfg.filename || '';
			const startTsRounded = Number(cfg.startTsRounded || 0);
			let   currentTsRounded = Number(cfg.currentTsRounded || 0);
			const data = (cfg.waveHead || []).map(Number);
			let fs     = Number(cfg.fs || 125);
			let rpeaks = Array.isArray(cfg.rpeaks) ? cfg.rpeaks : [];			
			const totalMinutes  = Number(cfg.totalMinutes || 1);
			const currentMinute = Number(cfg.currentMinute || 1);
			const fid = cfg.fid;
			const durationHM = cfg.duration_hm || '';
			const elDuration = document.getElementById('ecg-duration');
			if (elDuration && durationHM) elDuration.textContent = `длительность: ${durationHM} ч`;

			const fileLine = context.querySelector('.ecg-fileline');
			const fileLineTime = context.querySelector('.ecg-fileline-time');
			if (fileLine) fileLine.textContent = 'Файл: ' + filename;
			if (fileLineTime)	fileLineTime.textContent = fmtYmdHM(startTsRounded);
			
			// форматирование времени начала (округлено до минуты):
			function fmtStart(ts) {
				if (!ts) return '';
				const d = new Date(ts * 1000);
				// Локально: YYYY-MM-DD HH:MM
				const yyyy = d.getFullYear();
				const mm   = String(d.getMonth()+1).padStart(2,'0');
				const dd   = String(d.getDate()).padStart(2,'0');
				const HH   = String(d.getHours()).padStart(2,'0');
				const MM   = String(d.getMinutes()).padStart(2,'0');
				return `${yyyy}-${mm}-${dd} ${HH}:${MM}`;
			}
			function fmtYmdHM(tsSec) {
				if (!tsSec) return '';
				const d = new Date(tsSec * 1000);
				const yyyy = d.getFullYear();
				const mm   = String(d.getMonth()+1).padStart(2,'0');
				const dd   = String(d.getDate()).padStart(2,'0');
				const HH   = String(d.getHours()).padStart(2,'0');
				const MM   = String(d.getMinutes()).padStart(2,'0');
				return `${yyyy}-${mm}-${dd} ${HH}:${MM}`;
			}
			// ссылка на функцию перерисовки, появится после init canvas
			let scheduleRender = null;

			// состояние навигации по минутам, чтобы Prev/Next считались верно
			let state = {
				current: Number(cfg.currentMinute || 1),
				total:   Number(cfg.totalMinutes  || 1),
			};

			// инициализация панели:
			const toolbar = context.querySelector && context.querySelector('#ecg-toolbar');
			if (toolbar) {
				const elPrev = toolbar.querySelector('#ecg-prev');
				const elNext = toolbar.querySelector('#ecg-next');
				const elStart= toolbar.querySelector('#ecg-start');
				const elCnt  = toolbar.querySelector('#ecg-counter');
				const elGoto = toolbar.querySelector('#ecg-goto');
				const elGo   = toolbar.querySelector('#ecg-go');

				// если контроллер не передал currentTsRounded — посчитаем от старта и номера минуты
				if (!currentTsRounded && startTsRounded && currentMinute) {
					currentTsRounded = startTsRounded + 60 * (currentMinute - 1);
				}

				// элемент для текущего времени
				const elCurrent = toolbar.querySelector('#ecg-current');

				// первичное заполнение полей
				if (elStart)   elStart.textContent   = `Начало: ${fmtYmdHM(startTsRounded)}`;
				if (elCnt)     elCnt.textContent     = `${currentMinute} из ${totalMinutes}`;
				if (elGoto)  { elGoto.min = 1; elGoto.max = Math.max(1, totalMinutes); elGoto.value = currentMinute; }
				if (elPrev)    elPrev.disabled        = (currentMinute <= 1);
				if (elNext)    elNext.disabled        = (currentMinute >= totalMinutes);
				if (elCurrent) elCurrent.textContent  = `Текущая минута: ${fmtYmdHM(currentTsRounded)}`;

				// текстовые поля:
				if (elStart) elStart.textContent = fmtStart(startTsRounded);
				if (elCnt)   elCnt.textContent   = `${currentMinute} из ${totalMinutes}`;
				if (elGoto) {
					elGoto.min = 1;
					elGoto.max = Math.max(1, totalMinutes);
					elGoto.value = currentMinute;
				}

				// дизейблим кнопки, если вышли за границы
				if (elPrev) elPrev.disabled = (currentMinute <= 1);
				if (elNext) elNext.disabled = (currentMinute >= totalMinutes);

				// хелпер: перейти на минуту N (1-based)
				function gotoMinuteAjax(n) {
					n = Math.max(1, Math.min(state.total, Math.floor(Number(n)||1)));
					const base = window.location.pathname; // /admin/ecg/report/{fid}
					const url  = `${base}/minute?min=${n}`;

					fetch(url, { headers: { 'Accept': 'application/json' }})
						.then(r => r.json())
						.then(j => {
							// данные и метаданные
							cfg.waveHead = j.waveHead;
							cfg.fs = j.fs;
							cfg.rpeaks = j.rpeaks || [];

							fs = Number(cfg.fs || 125);        // важно: обновляем переменную, а не только cfg
							rpeaks = cfg.rpeaks;               // тоже обновляем ссылку

							// состояние минут
							state.current = Number(j.currentMinute || 1);
							state.total   = Number(j.totalMinutes  || 1);

							// UI
							if (elCnt)   elCnt.textContent   = `${state.current} из ${state.total}`;
							if (elStart) elStart.textContent = `Начало: ${fmtYmdHM(startTsRounded)}`;
							const elCurrent = document.getElementById('ecg-current');
							if (elCurrent) elCurrent.textContent = `Текущая минута: ${fmtYmdHM(currentTsRounded)}`;
							if (elGoto)  elGoto.value = state.current;
							if (elPrev)  elPrev.disabled = (state.current <= 1);
							if (elNext)  elNext.disabled = (state.current >= state.total);
							currentTsRounded = Number(j.startTsRounded || 0) + 60 * (Number(j.currentMinute || 1) - 1);
							if (elCurrent) elCurrent.textContent = `Текущая минута: ${fmtYmdHM(currentTsRounded)}`;

							// подменяем массив данных и перерисовываем
							data.length = 0; Array.prototype.push.apply(data, j.waveHead.map(Number));
							if (typeof scheduleRender === 'function') scheduleRender();
							// обновим адресную строку без перезагрузки
							history.replaceState(null, '', `${base}?min=${state.current}`);
						})
						.catch(console.error);
				}
				// обработчики:
				if (elPrev) elPrev.addEventListener('click', () => gotoMinuteAjax(state.current - 1));
				if (elNext) elNext.addEventListener('click', () => gotoMinuteAjax(state.current + 1));
				if (elGo && elGoto) elGo.addEventListener('click', () => gotoMinuteAjax(elGoto.value));
				if (elGoto) elGoto.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') { e.preventDefault(); gotoMinuteAjax(elGoto.value); }
				});
			}
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
				scheduleRender = render;

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
