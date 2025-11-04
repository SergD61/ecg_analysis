# ECG Analysis (Drupal 11 module)

**Repository:** [https://github.com/SergD61/ecg_analysis](https://github.com/SergD61/ecg_analysis)  
**License:** MIT

---

## Overview

`ecg_analysis` — модуль для Drupal 11, предназначенный для загрузки, расшифровки и визуального анализа длительных ЭКГ-записей.  
Модуль реализует потоковую обработку бинарных файлов (`int16 LE`, частота — 125 Гц) и предоставляет удобный интерфейс для постраничного просмотра сигнала.

---

## Current Features

- **File upload:** `/admin/ecg/upload-raw`
  - Загрузка бинарных файлов
  - Антидубликаты по MD5 + размер
  - Автоматическое размещение в `public://ecg_raw/`

- **Report view:** `/admin/ecg/report/{fid}`
  - Потоковое чтение без загрузки всего файла в память
  - Расчёт `total_samples`, `duration` (в ч:мин)
  - Отображение имени файла, времени начала и текущей минуты
  - Поминутная навигация (6 панелей × 10 секунд)
  - Кнопки «Пред. / След.» и поле для перехода к минуте
  - Обновление без перезагрузки страницы (AJAX)

- **Visualization:**
  - Адаптивный canvas-график (до 1250 px по ширине)
  - Единый вертикальный масштаб для всех панелей
  - Защита от выбросов: **жёсткий потолок амплитуды ±1500**
  - Retina-friendly рендеринг и плавное масштабирование

---

## Key Files

| Path | Purpose |
|------|----------|
| `src/Form/EcgRawUploadForm.php` | Загрузка и валидация файлов |
| `src/Controller/EcgReportController.php` | Потоковый парсинг, AJAX минуты |
| `templates/ecg-report.html.twig` | Шаблон отчёта |
| `js/ecg_viewer.js` | Визуализатор ЭКГ |
| `css/ecg_style.css` | Стили интерфейса |
| `ecg_analysis.libraries.yml` | Подключение JS и CSS |

---

## Next Steps (new branch)

Planned for the next branch → `feature/r-peak-detection`:

1. **R-peak detection** and RR-interval analysis  
2. **Noise segmentation** and visual marking  
3. **Robust scaling** (percentiles 1–99%)  
4. **Export to CSV / JSON**  
5. **UI actions:** Download, Recalculate, Labels  
6. **header auto-detection** (`HEADER_BYTES`)

---

### Author

Project developed by **SergD61**


