<?php

namespace Drupal\ecg_analysis\Service;

class EcgAnalyzer {

  /**
   * Analyze raw ECG binary (int16 LE), single-lead.
   * @return array{duration_s: float, rpeaks: array<int>, rr_ms: array<float>, summary: array<string,mixed>, wave_head: array<int>}
   */
  public function analyze(string $path, int $fs = 125, int $seconds = 0): array {
    if (!is_file($path)) {
      return [
        'duration_s' => 0,
        'rpeaks' => [],
        'rr_ms' => [],
        'summary' => ['error' => 'File not found'],
        'wave_head' => [],
      ];
    }

    // Read binary as int16 LE.
    $bytes = ($seconds > 0) ? $fs * $seconds * 2 : filesize($path);
    $fh = fopen($path, 'rb');
    if (!$fh) {
      return [ 'duration_s' => 0, 'rpeaks' => [], 'rr_ms' => [], 'summary' => ['error' => 'Cannot open'], 'wave_head' => [] ];
    }
    $bin = fread($fh, $bytes);
    fclose($fh);

    $N = (int) (strlen($bin) / 2);
    $u16 = unpack('v*', substr($bin, 0, $N * 2));
    $raw = [];
    foreach ($u16 as $w) { $raw[] = ($w >= 0x8000) ? ($w - 0x10000) : $w; }

    // Duration.
    $duration_s = $N / max(1, $fs);

    // --- Simple bandpass: HPF 0.67 Hz + LPF 35 Hz ---
    $HPF_fc = 0.67; $LPF_fc = 35.0;
    $dt = 1.0 / $fs;
    $alpha_hpf = exp(-2.0 * M_PI * $HPF_fc * $dt);
    $alpha_lpf = exp(-2.0 * M_PI * $LPF_fc * $dt);

    $y_hpf = array_fill(0, $N, 0.0); $py = 0.0; $px = 0.0;
    for ($i=0; $i<$N; $i++) { $x=(float)$raw[$i]; $y=$alpha_hpf*($py + $x - $px); $y_hpf[$i]=$y; $py=$y; $px=$x; }

    $band = array_fill(0, $N, 0.0); $pv = 0.0;
    for ($i=0; $i<$N; $i++) { $pv = (1.0 - $alpha_lpf) * $y_hpf[$i] + $alpha_lpf * $pv; $band[$i] = $pv; }

    // --- Pan–Tompkins-lite features ---
    $der = array_fill(0, $N, 0.0); $pd = $band[0];
    for ($i=0; $i<$N; $i++) { $der[$i] = $band[$i] - $pd; $pd = $band[$i]; }

    $INT_WIN = 0.10; // 100 ms
    $winN = max(1, (int) round($INT_WIN * $fs));
    $mi = array_fill(0, $N, 0.0);
    $buf = array_fill(0, $winN, 0.0); $sum = 0.0; $idx = 0;
    for ($i=0; $i<$N; $i++) {
      $sq = $der[$i] * $der[$i];
      $sum -= $buf[$idx]; $buf[$idx] = $sq; $sum += $sq; $idx = ($idx + 1) % $winN; $mi[$i] = $sum / $winN;
    }

    $ENV_DEC = 0.995; $TH_GAIN = 0.45; $env = array_fill(0,$N,0.0); $e=0.0;
    for ($i=0; $i<$N; $i++) { $e = max($e*$ENV_DEC, $mi[$i]); $env[$i] = $e; }
    $thr = array_map(fn($v)=>$TH_GAIN*$v, $env);

    // Peak picking with refractory
    $REFRACT = 0.240; $refract = (int) round($REFRACT * $fs);
    $r_idx = []; $r_amp = []; $last = -1e9;
    for ($i=1; $i<$N-1; $i++) {
      if ($mi[$i] > $thr[$i] && $mi[$i] >= $mi[$i-1] && $mi[$i] >= $mi[$i+1]) {
        if ($i - $last >= $refract) {
          $w = (int) round(0.050 * $fs);
          $a = max(0, $i - $w); $b = min($N-1, $i + $w);
          $imax = $a; $amax = $band[$a];
          for ($k=$a; $k<=$b; $k++) if ($band[$k] > $amax) { $amax = $band[$k]; $imax = $k; }
          $r_idx[] = $imax; $r_amp[] = $amax; $last = $imax;
        }
      }
    }

    // RR series
    $rr_ms = [];
    for ($j=1; $j<count($r_idx); $j++) {
      $rr_ms[] = 1000.0 * ($r_idx[$j] - $r_idx[$j-1]) / max(1,$fs);
    }

    // Summary metrics
    $hr = 0.0; if ($duration_s > 0) { $hr = (count($r_idx) / $duration_s) * 60.0; }
    $sdnn = $this->std($rr_ms);
    $rmssd = $this->rmssd($rr_ms);

    // head of waveform for immediate draw (first ~10 seconds)
    $headN = min($N, (int) round(min(10, $duration_s) * $fs));
    $wave_head = array_slice($band, 0, $headN);

    return [
      'duration_s' => $duration_s,
      'rpeaks' => $r_idx,
      'rr_ms' => $rr_ms,
      'summary' => [
        'beats' => count($r_idx),
        'hr_bpm' => round($hr, 1),
        'sdnn_ms' => round($sdnn, 1),
        'rmssd_ms' => round($rmssd, 1),
      ],
      'wave_head' => array_map(fn($v)=> (int) round($v), $wave_head),
    ];
  }

  private function std(array $arr): float {
    $n = count($arr); if ($n < 2) return 0.0;
    $m = array_sum($arr)/$n; $s=0.0; foreach ($arr as $v) { $d=$v-$m; $s += $d*$d; }
    return sqrt($s/($n-1));
  }

  private function rmssd(array $rr_ms): float {
    $n = count($rr_ms); if ($n < 2) return 0.0;
    $s=0.0; for ($i=1; $i<$n; $i++) { $d=$rr_ms[$i]-$rr_ms[$i-1]; $s += $d*$d; }
    return sqrt($s/($n-1));
  }
}
