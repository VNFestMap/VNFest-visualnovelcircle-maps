<?php
// includes/recognition/quiz_import.php - makoquiz 简报 → 本站题库格式转译
//
// makoquiz 的 presentation.json 以「幻灯片」为单位（16 种题型，含现场互动型）；
// 本站考核引擎只收可自动判分的题型，转译时逐题映射，无法映射的跳过并计数。
//
// 映射表：
//   single    → single        （无正确答案的投票题跳过；多个正确自动转 multiple）
//   multi     → multiple
//   truefalse → judge         （选项统一规范为 对/错）
//   order     → order         （items 顺序即正确答案）
//   type      → fill_blank    （取首个可接受答案；同义写法 | 分隔取第一个）
//   soup      → fill_blank    （海龟汤按填空转译，阶段提示不保留）
//   list      → fill_multi    （每条答案取首个同义写法，最多 10 空）
//   number    → fill_blank    （容差容错机制无法保留，转精确文本比对）
//   reveal/music → 选择题    （选项结构与选择题一致，题干即猜图/猜曲）
//   其余（match/categorize/scale/open/qa/content）→ 跳过
//
// 素材（图片/音频）不随转译迁移：市集包里是 zip 内相对路径，落地本站需逐张
// 重新上传，成本与版权审核都不划算；需要图片时在设计器里重新添加。

/**
 * 将 makoquiz presentation 转为本站题库结构
 * @return array{questions: array, settings: array, notes: array}
 */
function recogConvertMakoquizPresentation(array $pres): array {
    $questions = [];
    $notes = [];
    $skippedTypes = [];
    $skippedBad = 0;

    $slides = is_array($pres['slides'] ?? null) ? $pres['slides'] : [];
    foreach ($slides as $s) {
        if (!is_array($s)) { $skippedBad++; continue; }
        $type = (string)($s['type'] ?? '');
        $title = trim((string)($s['title'] ?? ''));
        $explain = trim((string)($s['explain']['text'] ?? ''));
        $points = ($s['points'] ?? 'standard') === 'double' ? 20 : (($s['points'] ?? '') === 'none' ? 5 : 10);

        $q = null;
        switch ($type) {
            case 'single':
            case 'multi':
            case 'reveal':
            case 'music': {
                // reveal/music 的选项结构与选择题一致，题干即猜图/猜曲——按选择题转译
                $opts = is_array($s['options'] ?? null) ? $s['options'] : [];
                $texts = [];
                $answers = [];
                foreach ($opts as $oi => $o) {
                    $t = trim((string)($o['text'] ?? ''));
                    if ($t === '') continue;
                    if (!empty($o['correct'])) $answers[] = count($texts);
                    $texts[] = $t;
                }
                if (count($texts) < 2 || !$answers) { $skippedBad++; break; }
                $q = ['type' => count($answers) > 1 ? 'multiple' : 'single', 'question' => $title, 'options' => $texts, 'answer' => $answers, 'points' => $points];
                break;
            }
            case 'truefalse': {
                $opts = is_array($s['options'] ?? null) ? $s['options'] : [];
                $correctIdx = null;
                foreach ($opts as $oi => $o) {
                    if (!empty($o['correct'])) { $correctIdx = $oi; break; }
                }
                if ($correctIdx === null || count($opts) < 2) { $skippedBad++; break; }
                // 本站判断题选项固定为 对/错：按「第一个选项=对」的惯例映射正确索引
                $q = ['type' => 'judge', 'question' => $title, 'options' => ['对', '错'], 'answer' => [$correctIdx === 0 ? 0 : 1], 'points' => $points];
                break;
            }
            case 'order': {
                $items = is_array($s['items'] ?? null) ? $s['items'] : [];
                $texts = [];
                foreach ($items as $it) {
                    $t = trim((string)($it['text'] ?? ''));
                    if ($t !== '') $texts[] = $t;
                }
                if (count($texts) < 2 || count($texts) > 20) { $skippedBad++; break; }
                $q = ['type' => 'order', 'question' => $title, 'options' => $texts, 'points' => $points];
                break;
            }
            case 'type':
            case 'soup': {
                $accepted = is_array($s['accepted'] ?? null) ? $s['accepted'] : [];
                $first = '';
                foreach ($accepted as $a) {
                    $a = trim((string)$a);
                    if ($a !== '') { $first = trim(explode('|', $a)[0]); break; }
                }
                if ($first === '' || $title === '') { $skippedBad++; break; }
                $q = ['type' => 'fill_blank', 'question' => $title, 'answer_text' => $first, 'points' => $points];
                if ($type === 'soup') $notes[] = '海龟汤题「' . mbSafeSub($title, 20) . '」按填空题转译，阶段提示未保留';
                break;
            }
            case 'list': {
                $accepted = is_array($s['accepted'] ?? null) ? $s['accepted'] : [];
                $texts = [];
                foreach ($accepted as $a) {
                    $a = trim((string)$a);
                    if ($a === '') continue;
                    $texts[] = trim(explode('|', $a)[0]);
                    if (count($texts) >= 10) break;
                }
                if (!$texts || $title === '') { $skippedBad++; break; }
                $q = ['type' => 'fill_multi', 'question' => $title, 'answer_texts' => $texts, 'points' => $points];
                break;
            }
            case 'number': {
                if (!isset($s['answer']) || $title === '') { $skippedBad++; break; }
                $unit = trim((string)($s['unit'] ?? ''));
                $q = ['type' => 'fill_blank', 'question' => $title, 'answer_text' => (string)$s['answer'] . $unit, 'points' => $points];
                $notes[] = '数字题「' . mbSafeSub($title, 20) . '」转为精确填空（原容差机制不保留）';
                break;
            }
            default:
                $skippedTypes[$type] = ($skippedTypes[$type] ?? 0) + 1;
                continue 2;
        }
        if ($q === null) continue;
        if ($explain !== '') $q['explanation'] = $explain;
        $questions[] = $q;
    }

    foreach ($skippedTypes as $t => $n) {
        $notes[] = '跳过不支持的题型 ' . $t . ' × ' . $n . '（配对/分类/猜图阶段式/互动页等需现场主持，无法自动判分）';
    }
    if ($skippedBad > 0) $notes[] = '跳过 ' . $skippedBad . ' 道结构不完整或无答案的题';

    return [
        'questions' => $questions,
        'settings' => ['shuffle' => true, 'shuffle_options' => true, 'pick_count' => 0, 'time_limit' => 0, 'multiple_partial' => true, 'result_mode' => 'immediate'],
        'notes' => $notes,
    ];
}

// 无 mbstring 时的安全截断（仅用于提示文案）
function mbSafeSub(string $s, int $n): string {
    if (function_exists('mb_substr')) return mb_substr($s, 0, $n);
    return strlen($s) > $n * 3 ? substr($s, 0, $n * 3) : $s;
}
