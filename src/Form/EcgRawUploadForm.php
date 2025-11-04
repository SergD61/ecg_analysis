<?php

namespace Drupal\ecg_analysis\Form;

use Drupal\Core\Form\FormBase;
use Drupal\Core\Form\FormStateInterface;
use Drupal\Core\File\FileSystemInterface;
use Drupal\file\Entity\File;
use Drupal\Core\Url;
use Drupal\Core\Link;
use Drupal\Core\Database\Database;
use Symfony\Component\HttpFoundation\File\UploadedFile;
use Drupal\Core\Session\AccountProxyInterface;

final class EcgRawUploadForm extends FormBase {

  public function getFormId(): string {
    return 'ecg_raw_upload_form';
  }

	private function formatBytes(int $bytes): string {
		$units = ['B','KB','MB','GB','TB'];
		$i = 0;
		$val = max(0, $bytes);
		while ($val >= 1024 && $i < count($units) - 1) {
			$val /= 1024;
			$i++;
		}
		// 0/1 десятичный знак для красоты.
		$formatted = ($val >= 100 || $i === 0) ? (string) round($val) : number_format($val, 1, '.', '');
		return $formatted . ' ' . $units[$i];
	}
	
  public function buildForm(array $form, FormStateInterface $form_state): array {
    $params = \Drupal::request()->query->all();
    $duplicate_fid = isset($params['duplicate']) ? (int)$params['duplicate'] : 0;
		
		$form['#attributes']['enctype'] = 'multipart/form-data';
    $form['upload'] = [
      '#type' => 'details',
      '#title' => $this->t('Upload ER1 raw file (binary, no extension)'),
      '#open' => TRUE,
    ];
		$form['upload']['file'] = [
			'#type' => 'file',
			'#title' => $this->t('File'),
			'#name' => 'ecg_raw',                // ВАЖНО: явное имя поля
			'#attributes' => [
				'accept' => '*/*',                 // можно и без этого
			],
			'#description' => $this->t('Upload ER1 raw file (can be without extension). Duplicates by checksum are rejected.'),
		];
		$form['upload']['submit'] = [
			'#type' => 'submit',
			'#value' => $this->t('Upload'),
		];
    // List of already indexed files (from newest)
    $headers = [
      $this->t('FID'),
      $this->t('Name'),
      $this->t('Size'),
      $this->t('MD5'),
      $this->t('Uploaded'),
      $this->t('Actions'),
    ];

    $rows = [];
		$uid = \Drupal::currentUser()->id();
    $result = Database::getConnection()->select('ecg_raw_index', 'i')
      ->fields('i', ['fid', 'filename', 'size', 'md5', 'created'])
			->condition('i.uid', (int) $uid)
      ->orderBy('created', 'DESC')
      ->execute();

    foreach ($result as $r) {
      $fid = (int)$r->fid;
      $is_dup = ($duplicate_fid && $fid === $duplicate_fid);
      $file_link = Link::fromTextAndUrl($r->filename, Url::fromRoute('ecg_analysis.report', ['fid' => $fid]))->toString();
      $rows[] = [
        'data' => [
          $fid,
          ['data' => ['#markup' => $file_link]],
          $this->formatBytes((int) $r->size),
          $r->md5,
          \Drupal::service('date.formatter')->format((int)$r->created, 'short'),
          [
            'data' => [
              '#type' => 'operations',
              '#links' => [
                'report' => [
                  'title' => $this->t('Open report'),
                  'url' => Url::fromRoute('ecg_analysis.report', ['fid' => $fid]),
                ],
                'download' => [
                  'title' => $this->t('Download'),
                  'url' => Url::fromUri('base:/system/files/ecg_raw/' . $r->filename),
                ],
              ],
            ],
          ],
        ],
        'class' => $is_dup ? ['is-duplicate'] : [],
      ];
    }

    $form['list'] = [
      '#type' => 'table',
      '#header' => $headers,
      '#rows' => $rows,
      '#empty' => $this->t('No raw ECG files yet.'),
      '#attributes' => ['class' => ['ecg-raw-list']],
    ];

    // Подсветка "is-duplicate" через небольшой инлайн-CSS, либо добавьте в ваш ecg_style.css
    $form['#attached']['html_head'][] = [
      [
        '#tag' => 'style',
        '#value' => '.ecg-raw-list tr.is-duplicate { outline: 2px solid #d93025; }',
      ],
      'ecg_raw_dup_style',
    ];

    return $form;
  }

	public function validateForm(array &$form, FormStateInterface $form_state): void {
		/** @var UploadedFile|null $uploaded */
		$uploaded = \Drupal::request()->files->get('ecg_raw');
		if (!$uploaded || !$uploaded->isValid()) {
			$form_state->setErrorByName('file', $this->t('No file received. Check PHP limits (upload_max_filesize, post_max_size).'));
			return;
		}

		$path = $uploaded->getRealPath();
		if (!$path || !is_readable($path)) {
			$form_state->setErrorByName('file', $this->t('Cannot read uploaded temporary file.'));
			return;
		}

		// Потоковый md5
		$ctx = hash_init('md5');
		$fh = fopen($path, 'rb');
		while (!feof($fh)) {
			$chunk = fread($fh, 1 << 20);
			if ($chunk === false) break;
			hash_update($ctx, $chunk);
		}
		fclose($fh);
		$md5  = hash_final($ctx);
		$size = (int) filesize($path);

		// Проверка дубликата
		$uid = \Drupal::currentUser()->id();
		$dup = Database::getConnection()->select('ecg_raw_index', 'i')
			->fields('i', ['fid'])
			->condition('i.uid', (int) $uid)   // ← важно!
			->condition('i.md5', $md5)
			->condition('i.size', (int) $file->getSize())
			->execute()
			->fetchField();
		if ($dup) {
			$url  = \Drupal\Core\Url::fromRoute('ecg_analysis.upload', [], ['query' => ['duplicate' => (int) $dup]]);
			$link = \Drupal\Core\Link::fromTextAndUrl($this->t('see existing file'), $url)->toString();
			$form_state->setErrorByName('file', $this->t('This file is already uploaded — @link.', ['@link' => $link]));
			return;
		}

		$form_state->set('ecg_md5',  $md5);
		$form_state->set('ecg_size', $size);
	}

	public function submitForm(array &$form, FormStateInterface $form_state): void {
		/** @var UploadedFile|null $uploaded */
		$uploaded = \Drupal::request()->files->get('ecg_raw');
		if (!$uploaded || !$uploaded->isValid()) {
			return;
		}

		$fs  = \Drupal::service('file_system');

		// 1) Готовим каталог (важно: аргумент — ПЕРЕМЕННАЯ).
		$dir = 'public://ecg_raw';
		$ok  = $fs->prepareDirectory($dir, FileSystemInterface::CREATE_DIRECTORY | FileSystemInterface::MODIFY_PERMISSIONS);
		if (!$ok) {
			\Drupal::logger('ecg_analysis')->error('Failed to prepare directory @d', ['@d' => $dir]);
			$this->messenger()->addError($this->t('Cannot prepare directory @d.', ['@d' => $dir]));
			return;
		}

		// 2) Имя файла. Если нет расширения — добавим .bin (можете убрать, если хотите без расширения).
		$orig = $uploaded->getClientOriginalName() ?: ('er1_' . \Drupal::time()->getRequestTime());
		if (pathinfo($orig, PATHINFO_EXTENSION) === '') {
			$orig .= '.bin';
		}
		$basename   = $fs->basename($orig);
		$tempPath   = $uploaded->getRealPath();
		$destUri    = $dir . '/' . $basename;

		// 3) КОПИРУЕМ (а не moveUploadedFile) — сюда можно передать ПОЛНЫЙ путь назначения.
		$result_uri = $fs->copy($tempPath, $destUri, FileSystemInterface::EXISTS_RENAME);
		if ($result_uri === FALSE) {
			\Drupal::logger('ecg_analysis')->error('Failed to copy to @dest', ['@dest' => $destUri]);
			$this->messenger()->addError($this->t('Cannot move uploaded file to public storage.'));
			return;
		}

		// 4) Размер файла — берём с диска и СТАВИМ В entity.
		$real = $fs->realpath($result_uri);
		$filesize = ($real && is_file($real)) ? filesize($real) : 0;

		// 5) Создаём File-entity: указываем и uri, и filename, и filesize, и статус.
		$file = File::create([
			'uri'      => $result_uri,
			'filename' => basename($result_uri),   // важно, чтобы не стало "1"
			'filesize' => $filesize,               // важно, чтобы не было 0
			'status'   => File::STATUS_PERMANENT,
		]);
		$file->save();

		// 6) Не даём удалить cron’ом.
		\Drupal::service('file.usage')->add($file, 'ecg_analysis', 'ecg_raw', $file->id());

		// 7) Индексация (md5 мы считали в validateForm()).
		$md5 = (string) $form_state->get('ecg_md5');
		\ecg_analysis_index_file($file, $md5);

		// 8) Сообщение для человека.
		$this->messenger()->addStatus($this->t('Uploaded and indexed: @name', [
			'@name' => $file->getFilename(),
		]));

		// 9) Переход к отчёту.
		$form_state->setRedirect('ecg_analysis.report', ['fid' => $file->id()]);
	}
}
