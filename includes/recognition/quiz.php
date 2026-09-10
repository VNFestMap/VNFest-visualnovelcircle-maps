<?php
// includes/recognition/quiz.php - 答题考核引擎：组卷 / 判分 / 内容校验
//
// 内容 schema（content_snapshot.quiz）：
//   v1（历史）: { questions: [...], shuffle: bool, rules: ... }
//   v2（现行）: { schema_version: 2, questions: [...], settings: {...}, rules: ... }
// v1 快照只读兼容：乱序沿用顶层 shuffle 字段，其余设置取默认值。
//
// 题型：single 单选 / multiple 多选 / judge 判断 / fill_blank 填空 /
//        order 排序（选项顺序即答案，按位置正确率得分） /
//        fill_multi 多空填空（answer_texts 逐空判分）
// 题目可选字段：image（题干图）、option_images（与选项等长的选项图数组），
//        URL 仅限站内 data/quiz_images/ 前缀。
//
// settings 字段：
//   shuffle          题目乱序
//   shuffle_options  选项乱序（选项携带原始索引，判分不受影响）
//   pick_count       抽题数量，0 = 全部
//   time_limit       限时（分钟），0 = 不限，上限 180
//   multiple_partial 多选半分：得分 = max(0, 选对-选错)/正确答案数 × 分值
//   result_mode      immediate=立即显示分数 / pass_only=只显示结果 / hidden=交卷后不显示

/**
 * 读取考试设置（v1 快照兼容：乱序取顶层 quiz.shuffle）
 */
function recogQuizSettings(array $quiz): array {
    $s = is_array($quiz['settings'] ?? null) ? $quiz['settings'] : [];
    return [
        'shuffle' => isset($s['shuffle']) ? (bool)$s['shuffle'] : (bool)($quiz['shuffle'] ?? false),
        'shuffle_options' => !empty($s['shuffle_options']),
        'pick_count' => max(0, (int)($s['pick_count'] ?? 0)),
        'time_limit' => max(0, min(180, (int)($s['time_limit'] ?? 0))),
        'multiple_partial' => !empty($s['multiple_partial']),
        'result_mode' => in_array($s['result_mode'] ?? '', ['immediate', 'pass_only', 'hidden'], true)
            ? $s['result_mode'] : 'immediate',
    ];
}

/**
 * 组卷：题目乱序 / 抽题 / 选项乱序
 * 选项以 {text, oi} 输出（oi 为原始索引），提交判分按原始索引进行，乱序不影响判分。
 * @return array 试卷题目列表 [ {seq, orig, type, question, options, points, explanation} ]
 */
function recogBuildPaper(array $content): array {
    $quiz = $content['quiz'] ?? [];
    $questions = $quiz['questions'] ?? [];
    if (!$questions) return [];
    $settings = recogQuizSettings($quiz);

    $indexes = range(0, count($questions) - 1);
    if ($settings['pick_count'] > 0 && $settings['pick_count'] < count($indexes)) {
        // 抽题本身就是随机取样，不依赖"题目乱序"开关（否则会固定抽走题库开头 N 题）
        shuffle($indexes);
        $indexes = array_slice($indexes, 0, $settings['pick_count']);
        if (!$settings['shuffle']) {
            sort($indexes); // 未开题目乱序时，抽中的题按题库原序呈现
        }
    }
    if ($settings['shuffle']) {
        shuffle($indexes);
    }

    $paper = [];
    foreach ($indexes as $seq => $orig) {
        $q = $questions[$orig];
        $type = (string)($q['type'] ?? '');
        $rawOptions = (array)($q['options'] ?? []);
        $optIndexes = $rawOptions ? range(0, count($rawOptions) - 1) : [];
        // 排序题必须打乱呈现（否则答案直接可见），不受选项乱序开关控制；
        // 判分按原始索引进行，乱序不影响结果。
        $mustShuffle = $type === 'order' && count($optIndexes) > 1;
        if ($mustShuffle || ($settings['shuffle_options'] && in_array($type, ['single', 'multiple', 'judge'], true) && count($optIndexes) > 1)) {
            shuffle($optIndexes);
            if ($mustShuffle && $optIndexes === range(0, count($rawOptions) - 1)) {
                // 极小概率洗回原序，对调首尾避免泄题
                $last = count($optIndexes) - 1;
                [$optIndexes[0], $optIndexes[$last]] = [$optIndexes[$last], $optIndexes[0]];
            }
        }
        $options = [];
        foreach ($optIndexes as $oi) {
            $options[] = ['text' => (string)$rawOptions[$oi], 'oi' => $oi];
        }
        $item = [
            'seq' => $seq,
            'orig' => $orig, // 判分用原始索引（排序题中同时即正确位置）
            'type' => $type,
            'question' => (string)($q['question'] ?? ''),
            'options' => $options,
            'points' => max(1, (int)($q['points'] ?? 10)),
            'explanation' => trim((string)($q['explanation'] ?? '')),
        ];
        if (!empty($q['image'])) $item['image'] = (string)$q['image'];
        if (!empty($q['option_images'])) $item['option_images'] = $q['option_images'];
        if ($type === 'fill_multi') $item['blanks'] = count((array)($q['answer_texts'] ?? []));
        $paper[] = $item;
    }
    return $paper;
}

// 大小写归一：无 mbstring 扩展时回退 strtolower（对 UTF-8 多字节字符无副作用，仅折叠 ASCII 字母）
function recogLower(string $s): string {
    return function_exists('mb_strtolower') ? mb_strtolower($s) : strtolower($s);
}

/**
 * 判分：单选/判断精确匹配；多选全对得分或半分（按设置）；填空忽略首尾空白与大小写
 * @param array $settings recogQuizSettings() 结果，影响多选半分
 * @return array{score:int, raw:float, total:int, detail:array}
 *         score 为卷面累计分（题目分值之和，不折算）；detail[题号] = {correct, earned, explanation}
 */
function recogGradeQuestions(array $questions, array $answers, array $settings = []): array {
    $multiplePartial = !empty($settings['multiple_partial']);
    $score = 0.0;
    $total = 0;
    $detail = [];
    foreach ($questions as $i => $q) {
        $points = max(1, (int)($q['points'] ?? 10));
        $total += $points;
        $given = $answers[(string)$i] ?? $answers[$i] ?? null;
        $correct = false;
        $earned = 0.0;

        if (in_array($q['type'], ['single', 'judge'], true)) {
            $expected = ($q['answer'] ?? [])[0] ?? null;
            $correct = ($given !== null && (int)$given === (int)$expected);
            $earned = $correct ? (float)$points : 0.0;
        } elseif ($q['type'] === 'multiple') {
            $expected = array_map('intval', (array)($q['answer'] ?? []));
            $givenArr = is_array($given) ? array_map('intval', $given) : [];
            if ($expected !== []) {
                if ($multiplePartial) {
                    $hit = count(array_intersect($givenArr, $expected));
                    $miss = count(array_diff($givenArr, $expected));
                    $earned = max(0, $hit - $miss) / count($expected) * $points;
                    $correct = $hit === count($expected) && $miss === 0;
                } else {
                    $e = $expected;
                    $g = $givenArr;
                    sort($e); sort($g);
                    $correct = $e === $g;
                    $earned = $correct ? (float)$points : 0.0;
                }
            }
        } elseif ($q['type'] === 'fill_blank') {
            $expected = recogLower(trim((string)($q['answer_text'] ?? '')));
            $correct = $expected !== '' && recogLower(trim((string)$given)) === $expected;
            $earned = $correct ? (float)$points : 0.0;
        } elseif ($q['type'] === 'order') {
            // 提交为按作答顺序排列的原始索引数组；位置 k 的原始索引等于 k 即正确，按正确率给分
            $totalOpts = count((array)($q['options'] ?? []));
            $givenArr = is_array($given) ? array_map('intval', $given) : [];
            $hits = 0;
            if ($totalOpts > 0) {
                for ($k = 0; $k < $totalOpts; $k++) {
                    if (($givenArr[$k] ?? -1) === $k) $hits++;
                }
            }
            $correct = $totalOpts > 0 && $hits === $totalOpts;
            $earned = $totalOpts > 0 ? round($points * $hits / $totalOpts, 1) : 0.0;
        } elseif ($q['type'] === 'fill_multi') {
            // 逐空判分（忽略大小写与首尾空白），按正确空数比例给分
            $expectedList = array_values((array)($q['answer_texts'] ?? []));
            $givenList = is_array($given) ? array_values($given) : [];
            $hits = 0;
            foreach ($expectedList as $k => $expText) {
                $exp = recogLower(trim((string)$expText));
                if ($exp !== '' && recogLower(trim((string)($givenList[$k] ?? ''))) === $exp) $hits++;
            }
            $totalBlanks = count($expectedList);
            $correct = $totalBlanks > 0 && $hits === $totalBlanks;
            $earned = $totalBlanks > 0 ? round($points * $hits / $totalBlanks, 1) : 0.0;
        }

        $score += $earned;
        $detail[$i] = [
            'correct' => $correct,
            'earned' => round($earned, 1),
            'explanation' => trim((string)($q['explanation'] ?? '')),
        ];
    }
    // 卷面累计分：得分 = 答对题目分值之和（不折算百分制），及格由 score_gte 规则与卷面分直接比较
    return ['score' => (int)round($score), 'raw' => round($score, 1), 'total' => $total, 'detail' => $detail];
}

/**
 * 题目图片 URL 合法性：仅允许站内 quiz_image.php 落盘路径，拒绝外部/任意路径注入
 */
function recogIsQuizImageUrl(string $url): bool {
    return preg_match('#^data/quiz_images/[A-Za-z0-9_\-.]+\.(jpg|jpeg|png|gif|webp)$#i', $url) === 1;
}

/**
 * 校验并规范化题目与考试设置（保存/发布共用）
 * 新保存的内容一律规范为 schema v2（settings 结构）
 * @param array $quiz 按引用传入，就地规范化
 * @return string|null 错误信息
 */
function recogValidateQuizContent(array &$quiz): ?string {
    $questions = $quiz['questions'] ?? [];
    if (!is_array($questions) || count($questions) > 500) {
        return '题目数量非法（最多 500 题）';
    }
    foreach ($questions as $i => $q) {
        $no = '第 ' . ($i + 1) . ' 题';
        $t = $q['type'] ?? '';
        if (!in_array($t, ['single', 'multiple', 'judge', 'fill_blank', 'order', 'fill_multi'], true)) {
            return $no . '题型不支持';
        }
        if (trim((string)($q['question'] ?? '')) === '') {
            return $no . '题干为空';
        }
        $points = (int)($q['points'] ?? 10);
        if ($points < 1 || $points > 100) {
            return $no . '分值需在 1–100 之间';
        }
        $questions[$i]['points'] = $points;
        $explanation = trim((string)($q['explanation'] ?? ''));
        if (strlen($explanation) > 1500) {
            return $no . '答案说明过长（最多 500 字）';
        }
        $questions[$i]['explanation'] = $explanation;

        // 题干图（可选）：仅允许站内题目图片路径，避免快照携带任意外链/路径注入；
        // 空值直接丢弃，保持快照干净。
        if (!empty($q['image'])) {
            if (!recogIsQuizImageUrl((string)$q['image'])) {
                return $no . '题干图片地址非法';
            }
            $questions[$i]['image'] = (string)$q['image'];
        } else {
            unset($questions[$i]['image']);
        }

        if (in_array($t, ['single', 'multiple', 'judge', 'order'], true)) {
            $options = $q['options'] ?? [];
            if (!is_array($options) || count($options) < 2) {
                return $no . '选项不足';
            }
            if ($t === 'order' && count($options) > 20) {
                return $no . '排序题选项不能超过 20 个';
            }
            if ($t === 'order') {
                // 排序题：选项排列顺序即正确答案，无需 answer 字段
                unset($questions[$i]['answer']);
            } else {
                $answer = $q['answer'] ?? [];
                if (!is_array($answer) || !$answer) {
                    return $no . '未设置答案';
                }
                foreach ($answer as $a) {
                    if (!is_int($a) || $a < 0 || $a >= count($options)) {
                        return $no . '答案索引越界';
                    }
                }
                if ($t === 'single' && count($answer) !== 1) {
                    return $no . '单选题只能有一个答案';
                }
            }
            // 选项图（可选）：与选项等长，逐项校验；全空则丢弃。
            if (!empty($q['option_images'])) {
                $optImgs = $q['option_images'];
                if (!is_array($optImgs) || count($optImgs) !== count($options)) {
                    return $no . '选项图数量与选项不一致';
                }
                $hasAny = false;
                foreach ($optImgs as $oi => $imgUrl) {
                    $imgUrl = (string)$imgUrl;
                    if ($imgUrl !== '' && !recogIsQuizImageUrl($imgUrl)) {
                        return $no . '选项图地址非法';
                    }
                    $optImgs[$oi] = $imgUrl;
                    if ($imgUrl !== '') $hasAny = true;
                }
                if ($hasAny) {
                    $questions[$i]['option_images'] = $optImgs;
                } else {
                    unset($questions[$i]['option_images']);
                }
            } else {
                unset($questions[$i]['option_images']);
            }
        } elseif ($t === 'fill_multi') {
            // 多空填空：逐空参考答案，1–10 空，空数即空位数（无需 answer/answer_text）。
            $texts = $q['answer_texts'] ?? [];
            if (!is_array($texts) || count($texts) < 1 || count($texts) > 10) {
                return $no . '多空填空需 1–10 个空';
            }
            foreach ($texts as $k => $txt) {
                if (trim((string)$txt) === '') {
                    return $no . '第 ' . ($k + 1) . ' 个空缺少参考答案';
                }
                $texts[$k] = trim((string)$txt);
            }
            $questions[$i]['answer_texts'] = $texts;
            unset($questions[$i]['answer'], $questions[$i]['answer_text']);
        } else {
            if (trim((string)($q['answer_text'] ?? '')) === '') {
                return $no . '填空题缺少参考答案';
            }
        }
    }
    $quiz['questions'] = $questions;

    // 考试设置规范化（兼容 v1 顶层 shuffle）
    $s = is_array($quiz['settings'] ?? null) ? $quiz['settings'] : [];
    $pick = max(0, (int)($s['pick_count'] ?? 0));
    if ($pick > count($questions)) {
        return '抽题数量不能超过总题数';
    }
    $timeLimit = max(0, (int)($s['time_limit'] ?? 0));
    if ($timeLimit > 180) {
        return '限时不能超过 180 分钟';
    }
    $resultMode = (string)($s['result_mode'] ?? 'immediate');
    if (!in_array($resultMode, ['immediate', 'pass_only', 'hidden'], true)) {
        return '成绩显示模式非法';
    }
    $quiz['settings'] = [
        'shuffle' => isset($s['shuffle']) ? (bool)$s['shuffle'] : (bool)($quiz['shuffle'] ?? false),
        'shuffle_options' => !empty($s['shuffle_options']),
        'pick_count' => $pick,
        'time_limit' => $timeLimit,
        'multiple_partial' => !empty($s['multiple_partial']),
        'result_mode' => $resultMode,
    ];
    $quiz['schema_version'] = 2;
    unset($quiz['shuffle']); // v1 顶层字段并入 settings
    return null;
}
