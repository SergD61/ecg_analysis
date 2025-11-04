<?php

namespace Drupal\ecg_analysis\Controller;

use Drupal\Core\Controller\ControllerBase;
use Drupal\file\Entity\File;
use Drupal\file\FileInterface;
use Drupal\Core\Url;
use Drupal\Core\Link;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Drupal\Core\Database\Database;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;

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

	public function minuteCsv($fid, Request $request): StreamedResponse {
		$uid = \Drupal::currentUser()->id();
		// UI передаёт минуты в человеко-понятной нумерации (1-based).
		$min_ui = max(1, (int) $request->query->get('min', 1));
		$min = $min_ui - 1; // 0-based для чтения из файла

		$connection = \Drupal::database();
		$record = $connection->select('ecg_raw_index', 'e')
			->fields('e')
			->condition('e.fid', $fid)
			->condition('e.uid', $uid) // защита по владельцу
			->execute()
			->fetchAssoc();

		if (!$record) {
			throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException();
		}

		$uri = $record['uri'];
		$fs = (int) ($record['fs'] ?: 125);
		$perMinute = 60 * $fs;

		$startSample = $min * $perMinute;
		$bytesPerSample = 2; // int16 LE
		$offsetBytes = $startSample * $bytesPerSample;
		$lengthSamples = $perMinute;

		// Чтение куска файла потоково.
		$wrapper = \Drupal::service('stream_wrapper_manager')->getViaUri($uri);
		$realPath = $wrapper->realpath();
		if (!is_readable($realPath)) {
			throw new \Symfony\Component\HttpKernel\Exception\NotFoundHttpException('Raw file is not readable.');
		}

		$response = new StreamedResponse();
		$response->setCallback(function() use ($realPath, $offsetBytes, $lengthSamples, $fs, $startSample) {
			$out = fopen('php://output', 'w');

			// Заголовки CSV
			fputcsv($out, ['global_sample', 'sample_in_minute', 'amplitude']);

			$fh = fopen($realPath, 'rb');
			if ($fh === false) {
				// пустой CSV при проблеме
				fclose($out);
				return;
			}

			// Перематываемся на нужный оффсет.
			fseek($fh, $offsetBytes, SEEK_SET);

			// Считываем блоком (например, по 8К) и разбираем в int16 LE.
			$bytesToRead = $lengthSamples * 2;
			$chunkSize = 8192;
			$buffer = '';
			$read = 0;
			$sampleIndexInMinute = 0;
			$global = $startSample;

			while ($read < $bytesToRead && !feof($fh)) {
				$need = min($chunkSize, $bytesToRead - $read);
				$chunk = fread($fh, $need);
				if ($chunk === false || $chunk === '') break;
				$buffer .= $chunk;
				$read += strlen($chunk);

				// Обрабатываем целые пары байт
				$pairs = intdiv(strlen($buffer), 2);
				for ($i = 0; $i < $pairs; $i++) {
					$lo = ord($buffer[2*$i]);
					$hi = ord($buffer[2*$i + 1]);
					// int16 LE в signed
					$val = $hi << 8 | $lo;
					if ($val & 0x8000) $val = $val - 0x10000;

					fputcsv($out, [$global, $sampleIndexInMinute, $val]);

					$sampleIndexInMinute++;
					$global++;

					if ($sampleIndexInMinute >= $lengthSamples) {
						// нужная минута выгружена
						break 2;
					}
				}
				// Оставляем «хвост» (если нечётное кол-во байт — маловероятно, но безопасно)
				$buffer = substr($buffer, $pairs * 2);
			}

			fclose($fh);
			fclose($out);
		});

		$filename = sprintf('ecg_fid%s_min%d.csv', $fid, $min_ui);
		$response->headers->set('Content-Type', 'text/csv; charset=UTF-8');
		$response->headers->set('Content-Disposition', 'attachment; filename="'.$filename.'"');

		return $response;
	}	
	
	public function minuteJson(FileInterface $fid): JsonResponse {
		$file = $fid; $fid = (int) $file->id();
		$uid = \Drupal::currentUser()->id();
		$conn = Database::getConnection();
		$record = $conn->select('ecg_raw_index', 'e')
			->fields('e')
			->condition('e.fid', $fid)
			->condition('e.uid', $uid)
			->execute()
			->fetchAssoc();

		if (!$record) {
			throw new \Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException('Файл не найден или принадлежит другому пользователю.');
		}
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
