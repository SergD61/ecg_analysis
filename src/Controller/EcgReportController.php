<?php

namespace Drupal\ecg_analysis\Controller;

use Drupal\Core\Controller\ControllerBase;
use Drupal\file\Entity\File;
use Drupal\file\FileInterface;
use Drupal\Core\Url;
use Drupal\Core\Link;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;

/**
 * Builds an ECG report page with minute pagination.
 */
final class EcgReportController extends ControllerBase {

	private const HEADER_BYTES = 0; // TODO: поменять, когда узнаем размер заголовка ER1

  // Частота дискретизации подтверждена расчётами длительности.
  private const FS = 125;

  // Сколько секунд отрисовываем на странице (1 минута = 6×10с в viewer).
  private const PAGE_SECONDS = 60;

  public static function create(ContainerInterface $container) {
    return new static();
  }

	public function minuteJson(FileInterface $fid): JsonResponse {
		$file = $fid; $fid = (int) $file->id();
		$fs = 125;

		$fs_service = \Drupal::service('file_system');
		$path = $fs_service->realpath($file->getFileUri());

		// (опционально) headerBytes = $this->detectHeaderBytes($path);
		$headerBytes = 0;

		$size_bytes_total = filesize($path);
		$data_bytes = max(0, $size_bytes_total - $headerBytes);
		$total_samples = intdiv($data_bytes, 2);

		$req = \Drupal::request();
		$currentMinute = max(1, (int) $req->query->get('min', 1));
		$samplesPerMinute = $fs * 60;
		$totalMinutes = max(1, (int) ceil($total_samples / $samplesPerMinute));
		if ($currentMinute > $totalMinutes) $currentMinute = $totalMinutes;

		// чтение окна
		$offsetSamples = ($currentMinute - 1) * $samplesPerMinute;
		$needSamples   = 60 * $fs;
		$preview = [];

		$fp = fopen($path, 'rb');
		if ($fp) {
			fseek($fp, $headerBytes + $offsetSamples*2, SEEK_SET);
			$chunk = 8192;
			while (!feof($fp) && count($preview) < $needSamples) {
				$bin = fread($fp, $chunk);
				$len = strlen($bin);
				for ($i=0; $i+1<$len && count($preview)<$needSamples; $i+=2) {
					$u = unpack('v', substr($bin, $i, 2))[1];
					if ($u >= 0x8000) $u -= 0x10000;
					$preview[] = $u;
				}
			}
			fclose($fp);
		}

		// округлённый старт (как раньше)
		$startTs = (int) $file->getCreatedTime();
		$startTsRounded = (int) floor($startTs / 60) * 60;
		return new JsonResponse([
			'fs' => $fs,
			'waveHead' => $preview,
			'rpeaks' => [],
			'totalMinutes' => $totalMinutes,
			'currentMinute' => $currentMinute,
			'startTsRounded' => $startTsRounded,
			'fid' => $fid,
		]);
	}
	
  /**
   * Отчёт по файлу.
   *
   * @param int $fid
   *   File entity id.
   *
   * @return array
   *   Render array.
   */

	public function report(FileInterface $fid): array {
		// Частота (если у вас вычисляется где-то — подставьте вашу переменную)
		$fs = 125;

		// Идентификатор и путь
		$file = $fid;
		$fid  = (int) $file->id();
		$filename = $file->getFilename();
		$fs_service = \Drupal::service('file_system');
		$uri = $file->getFileUri();
		$path = $fs_service->realpath($uri);
		if (!is_readable($path)) {
			return [
				'#type' => 'markup',
				'#markup' => $this->t('File is not readable: @path', ['@path' => $path]),
			];
		}

		// Общая длина в сэмплах с учётом возможного заголовка
		$size_bytes_total = filesize($path);
		$data_bytes = max(0, $size_bytes_total - self::HEADER_BYTES);
		$total_samples = intdiv($data_bytes, 2);

		// Минутная пагинация (?min=1..N)
		$request = \Drupal::request();
		$currentMinute = max(1, (int) $request->query->get('min', 1));
		$samplesPerMinute = $fs * 60;
		$totalMinutes = max(1, (int) ceil($total_samples / $samplesPerMinute));
		if ($currentMinute > $totalMinutes) {
			$currentMinute = $totalMinutes;
		}

		// Время начала записи (берём createdTime файла) и округляем до минуты
		$startTs = (int) $file->getCreatedTime();
		$startTsRounded = (int) floor($startTs / 60) * 60;
		$startIso = gmdate('c', $startTsRounded);

		// Чтение ровно 60 сек текущей минуты
		$offsetSamples = ($currentMinute - 1) * $samplesPerMinute;
		$needSamples   = 60 * $fs; // одна минутная страница
		$preview = [];

		$fp = fopen($path, 'rb');
		if ($fp) {
			$base = self::HEADER_BYTES;              // начало данных после заголовка
			$skipBytes = (int) $offsetSamples * 2;   // int16LE → 2 байта
			fseek($fp, $base + $skipBytes, SEEK_SET);

			$chunk = 8192;
			while (!feof($fp) && count($preview) < $needSamples) {
				$bin = fread($fp, $chunk);
				$len = strlen($bin);
				for ($i = 0; $i + 1 < $len && count($preview) < $needSamples; $i += 2) {
					$u = unpack('v', substr($bin, $i, 2))[1]; // uint16 LE
					if ($u >= 0x8000) $u -= 0x10000;         // → int16 signed
					$preview[] = $u;
				}
			}
			fclose($fp);
		}

		// Продолжительность всей записи в секундах
		$duration_s  = (int) floor($total_samples / $fs);
		$duration_hm = sprintf('%02d:%02d', intdiv($duration_s, 3600), intdiv($duration_s % 3600, 60));
		$filename    = $file->getFilename();

		// rpeaks пока пусто (позже добавим детекцию)
		$rpeaks = [];
		$currentTsRounded = $startTsRounded + 60 * ($currentMinute - 1);

		return [
			'#theme' => 'ecg_report',
			'#fid' => $fid,
			'#fs' => $fs,
			'#total_samples' => $total_samples,
			'#duration_s' => $duration_s,
			'#duration_hm' => $duration_hm,
			'#rr_ms' => [],
			'#filename' => $filename,

			'#attached' => [
				'library' => ['ecg_analysis/viewer'],
				'drupalSettings' => [
					'ecgAnalysis' => [
						'duration_hm' => $duration_hm, // (опционально для JS)
						'fs' => $fs,
						'waveHead' => $preview,   // 60с текущей минуты
						'rpeaks' => $rpeaks,

						// Метаданные для шапки и навигации
						'totalMinutes' => $totalMinutes,
						'currentMinute' => $currentMinute,
						'startTsRounded' => $startTsRounded,
						'startIso' => $startIso,
						'fid' => $fid,
						'filename' => $filename,
						'startTsRounded' => $startTsRounded,
						'currentTsRounded' => $currentTsRounded,
					],
				],
			],
		];
	}

}
