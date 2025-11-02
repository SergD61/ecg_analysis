<?php

namespace Drupal\ecg_analysis\Controller;

use Drupal\Core\Controller\ControllerBase;
use Drupal\file\Entity\File;
use Drupal\file\FileInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;

final class EcgReportController extends ControllerBase {

  private const FS = 125;
  private const PREVIEW_SECONDS = 60;

  public static function create(ContainerInterface $container) {
    return new static();
  }

  /**
   * @param \Drupal\file\FileInterface|int|string $fid
   */
  public function report($fid) {
    // Универсально приводим к FileInterface.
    if ($fid instanceof FileInterface) {
      $file = $fid;
    } else {
      $file = File::load((int) $fid);
      if (!$file) {
        $this->messenger()->addError($this->t('Cannot load file entity by id @id', ['@id' => $fid]));
        return ['#markup' => $this->t('File entity not found.')];
      }
    }

    $uri = $file->getFileUri();
    // Избежим проблем со stream-wrapper: читаем через realpath().
    $real = \Drupal::service('file_system')->realpath($uri);
    if (!$real || !is_readable($real)) {
      $this->messenger()->addError($this->t('Cannot open file @f', ['@f' => $file->getFilename()]));
      return ['#markup' => $this->t('Failed to open the file.')];
    }

    $preview_needed = self::FS * self::PREVIEW_SECONDS;
    $preview = [];
    $total_samples = 0;

    $stream = fopen($real, 'rb');
    if (!$stream) {
      $this->messenger()->addError($this->t('Cannot open file @f', ['@f' => $file->getFilename()]));
      return ['#markup' => $this->t('Failed to open the file.')];
    }

    $carry = '';
    while (!feof($stream)) {
      $chunk = fread($stream, 1 << 20);
      if ($chunk === false || $chunk === '') continue;
      if ($carry !== '') { $chunk = $carry . $chunk; $carry = ''; }
      $len = strlen($chunk);
      if ($len % 2 === 1) { $carry = $chunk[$len - 1]; $chunk = substr($chunk, 0, $len - 1); $len--; }

      for ($i = 0; $i < $len; $i += 2) {
        $low = ord($chunk[$i]);
        $high = ord($chunk[$i + 1]);
        $val = ($high << 8) | $low;
        if ($val > 32767) $val -= 65536;

        if ($total_samples < $preview_needed) $preview[] = $val;
        $total_samples++;
      }
    }
    fclose($stream);

    $duration_s = $total_samples > 0 ? round($total_samples / self::FS, 2) : 0;

    return [
      '#theme' => 'ecg_report',
      '#file_name' => $file->getFilename(),
      '#summary' => ['beats' => '-', 'hr_bpm' => '-', 'sdnn_ms' => '-', 'rmssd_ms' => '-'],
      '#duration' => $duration_s,
      '#fs' => self::FS,
			'#total_samples' => $total_samples,
      '#rr_ms' => [],
      '#attached' => [
        'library' => ['ecg_analysis/viewer'],
        'drupalSettings' => [
          'ecgAnalysis' => [
            'fs' => self::FS,
            'waveHead' => $preview,
            'rpeaks' => [],
          ],
        ],
      ],
    ];
  }
}
