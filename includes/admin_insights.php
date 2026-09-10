<?php
/**
 * Super-admin operational insights aggregation.
 *
 * This file intentionally contains no HTTP handling and no audit writes so it
 * can be exercised with temporary JSON fixtures and an in-memory SQLite DB.
 */

if (!function_exists('adminInsightsJsonRows')) {
    function adminInsightsJsonRows(string $path, ?string $key = null, array &$sources = []): array {
        $sourceKey = basename($path);
        if (!is_file($path)) {
            $sources[$sourceKey] = ['status' => 'missing'];
            return [];
        }
        $raw = @file_get_contents($path);
        if ($raw === false) {
            $sources[$sourceKey] = ['status' => 'unreadable'];
            return [];
        }
        $decoded = json_decode($raw, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            $sources[$sourceKey] = ['status' => 'invalid'];
            return [];
        }
        $rows = $key === null ? $decoded : ($decoded[$key] ?? []);
        if (!is_array($rows)) {
            $sources[$sourceKey] = ['status' => 'invalid_shape'];
            return [];
        }
        $sources[$sourceKey] = ['status' => 'ok', 'count' => count($rows)];
        return array_values(array_filter($rows, 'is_array'));
    }
}

if (!function_exists('adminInsightsTimezone')) {
    function adminInsightsTimezone(): DateTimeZone {
        static $timezone = null;
        if ($timezone === null) $timezone = new DateTimeZone('Asia/Shanghai');
        return $timezone;
    }
}

if (!function_exists('adminInsightsParseDate')) {
    function adminInsightsParseDate($value, bool $dateOnly = false): ?DateTimeImmutable {
        $value = trim((string)($value ?? ''));
        if ($value === '') return null;
        try {
            $timezone = adminInsightsTimezone();
            if ($dateOnly && preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)) {
                return new DateTimeImmutable($value . ' 00:00:00', $timezone);
            }
            $date = new DateTimeImmutable($value, $timezone);
            return $date->setTimezone($timezone);
        } catch (Throwable $e) {
            return null;
        }
    }
}

if (!function_exists('adminInsightsDateKey')) {
    function adminInsightsDateKey(?DateTimeImmutable $date): string {
        return $date ? $date->setTimezone(adminInsightsTimezone())->format('Y-m-d') : '';
    }
}

if (!function_exists('adminInsightsRange')) {
    function adminInsightsRange(?string $from = null, ?string $to = null): array {
        $timezone = adminInsightsTimezone();
        $today = new DateTimeImmutable('today', $timezone);
        $toDate = adminInsightsParseDate($to, true) ?: $today;
        $fromDate = adminInsightsParseDate($from, true) ?: $toDate->modify('-29 days');
        if ($fromDate > $toDate) [$fromDate, $toDate] = [$toDate, $fromDate];
        $maxFrom = $toDate->modify('-365 days');
        if ($fromDate < $maxFrom) $fromDate = $maxFrom;
        return [
            'from' => $fromDate->format('Y-m-d'),
            'to' => $toDate->format('Y-m-d'),
            'from_date' => $fromDate,
            'to_date' => $toDate,
            'days' => (int)$fromDate->diff($toDate)->format('%a') + 1,
        ];
    }
}

if (!function_exists('adminInsightsDateInRange')) {
    function adminInsightsDateInRange(?DateTimeImmutable $date, array $range): bool {
        if (!$date) return false;
        $key = adminInsightsDateKey($date);
        return $key >= $range['from'] && $key <= $range['to'];
    }
}

if (!function_exists('adminInsightsAgeHours')) {
    function adminInsightsAgeHours(?DateTimeImmutable $start, ?DateTimeImmutable $end = null): ?float {
        if (!$start) return null;
        $end = $end ?: new DateTimeImmutable('now', adminInsightsTimezone());
        return max(0, round(($end->getTimestamp() - $start->getTimestamp()) / 3600, 2));
    }
}

if (!function_exists('adminInsightsPercentile')) {
    function adminInsightsPercentile(array $values, float $percentile): ?float {
        $values = array_values(array_filter(array_map('floatval', $values), static fn($value) => is_finite($value)));
        if (!$values) return null;
        sort($values, SORT_NUMERIC);
        $index = ($percentile / 100) * (count($values) - 1);
        $lower = (int)floor($index);
        $upper = (int)ceil($index);
        if ($lower === $upper) return round($values[$lower], 2);
        $weight = $index - $lower;
        return round($values[$lower] + ($values[$upper] - $values[$lower]) * $weight, 2);
    }
}

if (!function_exists('adminInsightsFormatType')) {
    function adminInsightsFormatType(string $type): string {
        return [
            'club' => '同好会申请',
            'event' => '活动申请',
            'publication' => '企划申请',
            'membership' => '成员绑定',
            'feedback' => '反馈建议',
        ][$type] ?? $type;
    }
}

if (!function_exists('adminInsightsNormalizeSubmission')) {
    function adminInsightsNormalizeSubmission(string $type, array $row): array {
        $id = (int)($row['id'] ?? 0);
        $title = match ($type) {
            'club' => trim((string)($row['name'] ?? '未命名同好会')),
            'event' => trim((string)($row['event'] ?? '未命名活动')),
            'publication' => trim((string)($row['publicationName'] ?? '未命名企划')),
            'feedback' => trim((string)($row['title'] ?? '未命名反馈')),
            default => '未命名记录',
        } ?: '未命名记录';
        $submittedValue = $type === 'membership' ? ($row['joined_at'] ?? '') : ($row['submitted_at'] ?? ($row['timestamp'] ?? ''));
        $status = (string)($row['status'] ?? 'pending');
        $reviewedValue = $row['reviewed_at'] ?? '';
        if ($reviewedValue === '' && $status === 'approved') $reviewedValue = $row['approved_at'] ?? '';
        if ($reviewedValue === '' && $status === 'rejected') $reviewedValue = $row['rejected_at'] ?? '';
        if ($reviewedValue === '' && $type === 'feedback' && $status !== 'pending') $reviewedValue = $row['updated_at'] ?? '';
        return [
            'type' => $type,
            'type_label' => adminInsightsFormatType($type),
            'id' => $id,
            'title' => $title,
            'status' => trim($status) ?: 'pending',
            'country' => strtolower(trim((string)($row['country'] ?? 'china'))) === 'japan' ? 'japan' : 'china',
            'club_id' => (int)($row['club_id'] ?? 0),
            'submitted_at' => adminInsightsParseDate($submittedValue),
            'reviewed_at' => adminInsightsParseDate($reviewedValue),
            'reviewed_at_explicit' => $reviewedValue !== '',
            'reviewed_by' => (int)($row['reviewed_by'] ?? 0),
            'raw' => $row,
        ];
    }
}

if (!function_exists('adminInsightsLoadRecords')) {
    function adminInsightsLoadRecords(?PDO $db = null, ?string $dataPath = null, array &$sources = []): array {
        $dataPath = $dataPath ?: dirname(__DIR__) . '/data';
        $specs = [
            'club' => ['submissions.json', null],
            'event' => ['submissions_event.json', null],
            'publication' => ['submissions_publication.json', null],
            'feedback' => ['feedback.json', null],
        ];
        $records = [];
        foreach ($specs as $type => [$file, $key]) {
            foreach (adminInsightsJsonRows($dataPath . '/' . $file, $key, $sources) as $row) {
                $records[] = adminInsightsNormalizeSubmission($type, $row);
            }
        }

        if ($db) {
            try {
                $membershipRows = $db->query('SELECT id, club_id, country, status, joined_at, reviewed_at, reviewed_by FROM club_memberships')->fetchAll(PDO::FETCH_ASSOC);
            } catch (Throwable $e) {
                try {
                    $membershipRows = $db->query('SELECT id, club_id, status, joined_at FROM club_memberships')->fetchAll(PDO::FETCH_ASSOC);
                } catch (Throwable $ignored) {
                    $membershipRows = [];
                    $sources['club_memberships'] = ['status' => 'unavailable'];
                }
            }
            if (!isset($sources['club_memberships'])) $sources['club_memberships'] = ['status' => 'ok', 'count' => count($membershipRows)];
            foreach ($membershipRows as $row) {
                $records[] = adminInsightsNormalizeSubmission('membership', $row);
            }
        }
        return $records;
    }
}

if (!function_exists('adminInsightsBuildActionUrl')) {
    function adminInsightsBuildActionUrl(array $record): string {
        $base = 'reviews.html?';
        if ($record['type'] === 'membership') {
            return $base . 'module=review&tab=membership&status=pending&id=' . (int)$record['id'];
        }
        return $base . 'module=review&tab=' . rawurlencode($record['type']) . '&status=pending&id=' . (int)$record['id'];
    }
}

if (!function_exists('adminInsightsLoadMembershipHealth')) {
    function adminInsightsLoadMembershipHealth(?PDO $db, array &$sources = []): array {
        $health = [];
        if (!$db) return $health;
        try {
            $rows = $db->query('SELECT club_id, country, role, status, joined_at FROM club_memberships')->fetchAll(PDO::FETCH_ASSOC);
        } catch (Throwable $e) {
            try {
                $rows = $db->query('SELECT club_id, role, status, joined_at FROM club_memberships')->fetchAll(PDO::FETCH_ASSOC);
            } catch (Throwable $ignored) {
                $sources['club_memberships'] = ['status' => 'unavailable'];
                return $health;
            }
        }
        foreach ($rows as $row) {
            $country = strtolower(trim((string)($row['country'] ?? 'china'))) === 'japan' ? 'japan' : 'china';
            $key = $country . ':' . (int)($row['club_id'] ?? 0);
            if (!isset($health[$key])) {
                $health[$key] = [
                    'club_id' => (int)($row['club_id'] ?? 0),
                    'country' => $country,
                    'representatives' => 0,
                    'managers' => 0,
                    'active_members' => 0,
                    'pending_members' => 0,
                    'oldest_pending_at' => null,
                    'pending_ids' => [],
                ];
            }
            $status = trim((string)($row['status'] ?? ''));
            $role = trim((string)($row['role'] ?? ''));
            if ($status === 'active') {
                $health[$key]['active_members']++;
                if ($role === 'representative') $health[$key]['representatives']++;
                if (in_array($role, ['representative', 'manager'], true)) $health[$key]['managers']++;
            }
            if ($status === 'pending') {
                $health[$key]['pending_members']++;
                $health[$key]['pending_ids'][] = (int)($row['id'] ?? 0);
                $joined = adminInsightsParseDate($row['joined_at'] ?? '');
                if ($joined && (!$health[$key]['oldest_pending_at'] || $joined < $health[$key]['oldest_pending_at'])) {
                    $health[$key]['oldest_pending_at'] = $joined;
                }
            }
        }
        return $health;
    }
}

if (!function_exists('adminInsightsSortIssues')) {
    function adminInsightsSortIssues(array &$issues): void {
        usort($issues, static function (array $a, array $b): int {
            $severityRank = ['urgent' => 0, 'warning' => 1, 'info' => 2];
            $severity = ($severityRank[$a['severity'] ?? ''] ?? 9) <=> ($severityRank[$b['severity'] ?? ''] ?? 9);
            if ($severity !== 0) return $severity;

            $aType = (string)($a['type'] ?? '');
            $bType = (string)($b['type'] ?? '');
            if ($aType === 'queue' && $bType === 'queue') {
                $age = ((float)($b['age_hours'] ?? 0)) <=> ((float)($a['age_hours'] ?? 0));
                if ($age !== 0) return $age;
            } elseif ($aType !== 'queue' && $bType !== 'queue') {
                $aScore = !isset($a['score']) ? PHP_INT_MAX : (float)$a['score'];
                $bScore = !isset($b['score']) ? PHP_INT_MAX : (float)$b['score'];
                $score = $aScore <=> $bScore;
                if ($score !== 0) return $score;
            } else {
                $typeOrder = ['queue' => 0, 'governance' => 1, 'public_quality' => 2];
                $type = ($typeOrder[$aType] ?? 9) <=> ($typeOrder[$bType] ?? 9);
                if ($type !== 0) return $type;
            }
            $title = strcmp((string)($a['title'] ?? ''), (string)($b['title'] ?? ''));
            if ($title !== 0) return $title;
            return strcmp((string)($a['issue_code'] ?? ''), (string)($b['issue_code'] ?? ''));
        });
    }
}

if (!function_exists('adminInsightsQuality')) {
    function adminInsightsQuality(?PDO $db = null, ?string $dataPath = null, ?string $wikiPath = null, string $countryFilter = 'all', array &$sources = []): array {
        $dataPath = $dataPath ?: dirname(__DIR__) . '/data';
        $wikiPath = $wikiPath ?: dirname(__DIR__) . '/wiki';
        $clubs = [];
        foreach ([['clubs.json', 'china'], ['clubs_japan.json', 'japan']] as [$file, $country]) {
            foreach (adminInsightsJsonRows($dataPath . '/' . $file, 'data', $sources) as $club) {
                $club['country'] = $country;
                if ($countryFilter !== 'all' && $countryFilter !== $country) continue;
                $clubs[] = $club;
            }
        }
        $membershipHealth = adminInsightsLoadMembershipHealth($db, $sources);
        $publicScores = [];
        $governanceScores = [];
        $publicBuckets = ['90-100' => 0, '70-89' => 0, '50-69' => 0, '0-49' => 0];
        $governanceBuckets = ['90-100' => 0, '70-89' => 0, '50-69' => 0, '0-49' => 0];
        $missingPublic = [];
        $governanceIssues = [];
        $lowScoreClubs = [];
        $issues = [];

        foreach ($clubs as $club) {
            $clubCountry = $club['country'] ?? 'china';
            $clubId = (int)($club['id'] ?? 0);
            $clubKey = $clubCountry . ':' . $clubId;
            $wiki = function_exists('growthWikiForClub') ? growthWikiForClub($clubCountry, $clubId) : null;
            $events = function_exists('growthEventsForClub') ? growthEventsForClub($club) : [];
            $publications = function_exists('growthPublicationsForClub') ? growthPublicationsForClub($club) : [];
            $public = function_exists('growthClubCompleteness')
                ? growthClubCompleteness($club, $wiki, $events, $publications)
                : ['score' => 0, 'missing' => []];
            $publicScore = (int)($public['score'] ?? 0);
            $publicScores[] = $publicScore;
            if ($publicScore < 70) {
                $lowScoreClubs[] = [
                    'club_id' => $clubId,
                    'country' => $clubCountry,
                    'title' => trim((string)($club['display_name'] ?? $club['name'] ?? $club['school'] ?? '未命名同好会')),
                    'score' => $publicScore,
                    'missing' => array_values($public['missing'] ?? []),
                    'updated_at' => adminInsightsParseDate($club['updated_at'] ?? ''),
                    'action_url' => 'reviews.html?module=clubs&country=' . rawurlencode($clubCountry) . '&club_id=' . $clubId . '&search=' . rawurlencode((string)($club['name'] ?? $club['school'] ?? '')),
                ];
            }
            $publicBucket = $publicScore >= 90 ? '90-100' : ($publicScore >= 70 ? '70-89' : ($publicScore >= 50 ? '50-69' : '0-49'));
            $publicBuckets[$publicBucket]++;
            $publicMissingLabels = [
                'logo' => '缺少 Logo',
                'intro' => '缺少简介',
                'public_contact' => '联系方式展示策略待确认',
                'external_links' => '缺少外部链接',
                'wiki' => '缺少 Wiki',
                'events' => '暂无关联活动',
                'publications' => '暂无关联刊物/企划',
            ];
            foreach (($public['missing'] ?? []) as $missing) {
                $missingPublic[$missing] = ($missingPublic[$missing] ?? 0) + 1;
                if ($publicScore < 70 || in_array($missing, ['logo', 'intro', 'wiki'], true)) {
                    $issues[] = [
                        'severity' => $publicScore < 50 ? 'warning' : 'info',
                        'type' => 'public_quality',
                        'issue_code' => 'missing_' . $missing,
                        'type_label' => '公开资料',
                        'title' => trim((string)($club['display_name'] ?? $club['name'] ?? $club['school'] ?? '未命名同好会')),
                        'message' => $publicMissingLabels[$missing] ?? '公开资料不完整',
                        'score' => $publicScore,
                        'country' => $clubCountry,
                        'club_id' => $clubId,
                        'updated_at' => adminInsightsParseDate($club['updated_at'] ?? ''),
                        'action_url' => 'reviews.html?module=clubs&country=' . rawurlencode($clubCountry) . '&club_id=' . $clubId . '&search=' . rawurlencode((string)($club['name'] ?? $club['school'] ?? '')),
                    ];
                }
            }

            $membership = $membershipHealth[$clubKey] ?? [
                'representatives' => 0, 'managers' => 0, 'active_members' => 0,
                'pending_members' => 0, 'oldest_pending_at' => null, 'pending_ids' => [],
            ];
            $checks = [];
            $checks['representative'] = [($membership['representatives'] ?? 0) > 0, false];
            $checks['management'] = [($membership['managers'] ?? 0) > 0, false];
            $oldestPendingHours = adminInsightsAgeHours($membership['oldest_pending_at'] ?? null);
            $checks['pending'] = [$oldestPendingHours === null || $oldestPendingHours < 72, false];
            $hasContact = trim((string)($club['info'] ?? '')) !== '';
            $protected = !empty($club['protected']);
            $visible = !empty($club['visible_by_default']);
            $checks['visibility'] = [!$hasContact || !$protected || !$visible, false];
            $updatedAt = adminInsightsParseDate($club['updated_at'] ?? '');
            if (!$updatedAt) {
                $checks['freshness'] = [null, true];
            } else {
                $checks['freshness'] = [adminInsightsAgeHours($updatedAt) <= 180 * 24, false];
            }
            $passed = 0;
            $evaluable = 0;
            foreach ($checks as [$ok, $unknown]) {
                if ($unknown || $ok === null) continue;
                $evaluable++;
                if ($ok) $passed++;
            }
            $governanceScore = $evaluable > 0 ? (int)round($passed / $evaluable * 100) : null;
            if ($governanceScore !== null) {
                $governanceScores[] = $governanceScore;
                $bucket = $governanceScore >= 90 ? '90-100' : ($governanceScore >= 70 ? '70-89' : ($governanceScore >= 50 ? '50-69' : '0-49'));
                $governanceBuckets[$bucket]++;
            }
            if ($updatedAt === null) $governanceIssues['unknown_freshness'] = ($governanceIssues['unknown_freshness'] ?? 0) + 1;
            if (($membership['representatives'] ?? 0) <= 0) {
                $governanceIssues['no_representative'] = ($governanceIssues['no_representative'] ?? 0) + 1;
                $issues[] = [
                    'severity' => 'urgent', 'type' => 'governance', 'issue_code' => 'no_representative',
                    'type_label' => '治理', 'title' => trim((string)($club['display_name'] ?? $club['name'] ?? '未命名同好会')),
                    'message' => '没有有效负责人', 'score' => $governanceScore, 'country' => $clubCountry,
                    'club_id' => $clubId, 'updated_at' => $updatedAt,
                    'action_url' => 'reviews.html?module=clubs&country=' . rawurlencode($clubCountry) . '&club_id=' . $clubId . '&search=' . rawurlencode((string)($club['name'] ?? '')),
                ];
            }
            if (($membership['managers'] ?? 0) <= 0) {
                $governanceIssues['no_management'] = ($governanceIssues['no_management'] ?? 0) + 1;
                $issues[] = [
                    'severity' => 'warning', 'type' => 'governance', 'issue_code' => 'no_management',
                    'type_label' => '治理', 'title' => trim((string)($club['display_name'] ?? $club['name'] ?? '未命名同好会')),
                    'message' => '没有有效负责人或管理员', 'score' => $governanceScore, 'country' => $clubCountry,
                    'club_id' => $clubId, 'updated_at' => $updatedAt,
                    'action_url' => 'reviews.html?module=clubs&country=' . rawurlencode($clubCountry) . '&club_id=' . $clubId . '&search=' . rawurlencode((string)($club['name'] ?? '')),
                ];
            }
            if ($oldestPendingHours !== null && $oldestPendingHours >= 72) {
                $governanceIssues['overdue_membership'] = ($governanceIssues['overdue_membership'] ?? 0) + 1;
                $issues[] = [
                    'severity' => 'urgent', 'type' => 'governance', 'issue_code' => 'overdue_membership',
                    'type_label' => '治理', 'title' => trim((string)($club['display_name'] ?? $club['name'] ?? '未命名同好会')),
                    'message' => '存在超过 72 小时的成员绑定申请', 'score' => $governanceScore, 'country' => $clubCountry,
                    'club_id' => $clubId, 'updated_at' => $membership['oldest_pending_at'],
                    'action_url' => 'reviews.html?module=review&tab=membership&status=pending&id=' . (int)(($membership['pending_ids'][0] ?? 0)),
                ];
            }
            if (!$checks['visibility'][0]) {
                $governanceIssues['visibility_conflict'] = ($governanceIssues['visibility_conflict'] ?? 0) + 1;
                $issues[] = [
                    'severity' => 'warning', 'type' => 'governance', 'issue_code' => 'visibility_conflict',
                    'type_label' => '治理', 'title' => trim((string)($club['display_name'] ?? $club['name'] ?? '未命名同好会')),
                    'message' => '联系方式同时设置为保护和默认公开', 'score' => $governanceScore, 'country' => $clubCountry,
                    'club_id' => $clubId, 'updated_at' => $updatedAt,
                    'action_url' => 'reviews.html?module=clubs&country=' . rawurlencode($clubCountry) . '&club_id=' . $clubId . '&search=' . rawurlencode((string)($club['name'] ?? '')),
                ];
            }
            if ($updatedAt && adminInsightsAgeHours($updatedAt) > 180 * 24) {
                $governanceIssues['stale_update'] = ($governanceIssues['stale_update'] ?? 0) + 1;
                $issues[] = [
                    'severity' => 'warning', 'type' => 'governance', 'issue_code' => 'stale_update',
                    'type_label' => '治理', 'title' => trim((string)($club['display_name'] ?? $club['name'] ?? '未命名同好会')),
                    'message' => '超过 180 天未更新', 'score' => $governanceScore, 'country' => $clubCountry,
                    'club_id' => $clubId, 'updated_at' => $updatedAt,
                    'action_url' => 'reviews.html?module=clubs&country=' . rawurlencode($clubCountry) . '&club_id=' . $clubId . '&search=' . rawurlencode((string)($club['name'] ?? '')),
                ];
            }
        }

        adminInsightsSortIssues($issues);
        $serializeIssue = static function (array $issue): array {
            $issue['updated_at'] = $issue['updated_at'] instanceof DateTimeImmutable ? $issue['updated_at']->format(DateTimeInterface::ATOM) : null;
            return $issue;
        };
        $issues = array_map($serializeIssue, $issues);
        usort($lowScoreClubs, static function (array $a, array $b): int {
            $score = ((int)$a['score']) <=> ((int)$b['score']);
            if ($score !== 0) return $score;
            $country = strcmp((string)$a['country'], (string)$b['country']);
            if ($country !== 0) return $country;
            return strcmp((string)$a['title'], (string)$b['title']);
        });
        $lowScoreClubs = array_map($serializeIssue, array_slice($lowScoreClubs, 0, 50));
        $avg = static fn(array $values): ?float => $values ? round(array_sum($values) / count($values), 1) : null;
        return [
            'public' => [
                'average_score' => $avg($publicScores),
                'evaluated' => count($publicScores),
                'buckets' => array_map(static fn($key, $value) => ['label' => $key, 'count' => $value], array_keys($publicBuckets), array_values($publicBuckets)),
                'missing_dimensions' => array_map(static fn($key, $value) => ['dimension' => $key, 'count' => $value], array_keys($missingPublic), array_values($missingPublic)),
                'low_score_clubs' => $lowScoreClubs,
            ],
            'governance' => [
                'average_score' => $avg($governanceScores),
                'evaluated' => count($governanceScores),
                'unknown_freshness' => (int)($governanceIssues['unknown_freshness'] ?? 0),
                'buckets' => array_map(static fn($key, $value) => ['label' => $key, 'count' => $value], array_keys($governanceBuckets), array_values($governanceBuckets)),
                'issue_counts' => array_map(static fn($key, $value) => ['issue_code' => $key, 'count' => $value], array_keys($governanceIssues), array_values($governanceIssues)),
            ],
            'issues' => $issues,
        ];
    }
}

if (!function_exists('adminInsightsQueueAndReview')) {
    function adminInsightsQueueAndReview(array $records, array $range, ?DateTimeImmutable $now = null): array {
        $now = $now ?: new DateTimeImmutable('now', adminInsightsTimezone());
        $types = ['club', 'event', 'publication', 'membership', 'feedback'];
        $byType = [];
        foreach ($types as $type) {
            $byType[$type] = ['type' => $type, 'pending' => 0, 'overdue_24h' => 0, 'overdue_72h' => 0, 'oldest_wait_hours' => null, 'incoming' => 0, 'processed' => 0];
        }
        $trend = [];
        $cursor = $range['from_date'];
        for ($i = 0; $i < $range['days']; $i++) {
            $key = $cursor->modify('+' . $i . ' days')->format('Y-m-d');
            $trend[$key] = ['date' => $key, 'incoming' => 0, 'processed' => 0, 'backlog' => 0];
        }
        $reviewDurations = [];
        $durationsByType = array_fill_keys($types, []);
        $processed = $approved = $rejected = $terminal = 0;
        $priority = [];
        foreach ($records as $record) {
            $type = $record['type'];
            if (!isset($byType[$type])) continue;
            $submitted = $record['submitted_at'];
            $reviewed = $record['reviewed_at'];
            $status = $record['status'];
            if ($status === 'pending') {
                $byType[$type]['pending']++;
                $age = adminInsightsAgeHours($submitted, $now);
                if ($age !== null) {
                    if ($age >= 24) $byType[$type]['overdue_24h']++;
                    if ($age >= 72) $byType[$type]['overdue_72h']++;
                    if ($byType[$type]['oldest_wait_hours'] === null || $age > $byType[$type]['oldest_wait_hours']) $byType[$type]['oldest_wait_hours'] = $age;
                    $priority[] = [
                        'severity' => $age >= 72 ? 'urgent' : ($age >= 24 ? 'warning' : 'info'),
                        'type' => 'queue', 'issue_code' => 'pending_' . $type, 'type_label' => $record['type_label'],
                        'title' => $record['title'], 'message' => '待处理 ' . ($age >= 72 ? '超过 72 小时' : '尚未处理'),
                        'age_hours' => $age, 'record_id' => $record['id'], 'country' => $record['country'],
                        'action_url' => adminInsightsBuildActionUrl($record),
                    ];
                }
            }
            if (adminInsightsDateInRange($submitted, $range)) {
                $key = adminInsightsDateKey($submitted);
                if (isset($trend[$key])) {
                    $trend[$key]['incoming']++;
                    $byType[$type]['incoming']++;
                }
            }
            if (in_array($status, ['approved', 'rejected'], true)) {
                if (adminInsightsDateInRange($reviewed, $range)) {
                    $terminal++;
                    if ($status === 'approved') {
                        $approved++;
                        $byType[$type]['approved'] = (int)($byType[$type]['approved'] ?? 0) + 1;
                    }
                    if ($status === 'rejected') {
                        $rejected++;
                        $byType[$type]['rejected'] = (int)($byType[$type]['rejected'] ?? 0) + 1;
                    }
                    $key = adminInsightsDateKey($reviewed);
                    if (isset($trend[$key])) {
                        $trend[$key]['processed']++;
                        $byType[$type]['processed']++;
                    }
                    $processed++;
                    if ($submitted && $reviewed && $reviewed >= $submitted) {
                        $duration = adminInsightsAgeHours($submitted, $reviewed);
                        if ($duration !== null) {
                            $reviewDurations[] = $duration;
                            $durationsByType[$type][] = $duration;
                        }
                    }
                }
            }
        }
        foreach ($trend as $key => &$row) {
            $row['backlog'] = 0;
            foreach ($records as $record) {
                if (!$record['submitted_at'] || adminInsightsDateKey($record['submitted_at']) > $key) continue;
                if ($record['status'] === 'pending' || !$record['reviewed_at'] || adminInsightsDateKey($record['reviewed_at']) > $key) $row['backlog']++;
            }
        }
        unset($row);
        foreach ($byType as $type => &$row) {
            $terminalByType = (int)($row['approved'] ?? 0) + (int)($row['rejected'] ?? 0);
            $row['terminal_records'] = $terminalByType;
            $row['pass_rate_pct'] = $terminalByType > 0 ? round((int)($row['approved'] ?? 0) / $terminalByType * 100, 1) : null;
            $row['median_hours'] = adminInsightsPercentile($durationsByType[$type] ?? [], 50);
            $row['p90_hours'] = adminInsightsPercentile($durationsByType[$type] ?? [], 90);
        }
        unset($row);
        $queuePending = array_sum(array_column($byType, 'pending'));
        $overdue24 = array_sum(array_column($byType, 'overdue_24h'));
        $overdue72 = array_sum(array_column($byType, 'overdue_72h'));
        usort($priority, static function (array $a, array $b): int {
            $rank = ['urgent' => 0, 'warning' => 1, 'info' => 2];
            $severity = ($rank[$a['severity']] ?? 9) <=> ($rank[$b['severity']] ?? 9);
            if ($severity !== 0) return $severity;
            return ((float)($b['age_hours'] ?? 0)) <=> ((float)($a['age_hours'] ?? 0));
        });
        return [
            'queue' => [
                'pending' => $queuePending,
                'overdue_24h' => $overdue24,
                'overdue_72h' => $overdue72,
                'oldest_wait_hours' => $queuePending ? max(array_map(static fn($row) => (float)($row['oldest_wait_hours'] ?? 0), $byType)) : null,
                'by_type' => array_values($byType),
            ],
            'review' => [
                'processed' => $processed,
                'approved' => $approved,
                'rejected' => $rejected,
                'terminal_records' => $terminal,
                'pass_rate_pct' => ($approved + $rejected) > 0 ? round($approved / ($approved + $rejected) * 100, 1) : null,
                'median_hours' => adminInsightsPercentile($reviewDurations, 50),
                'p90_hours' => adminInsightsPercentile($reviewDurations, 90),
                'trend' => array_values($trend),
                'by_type' => array_values($byType),
            ],
            'priority_queue' => $priority,
            'review_time_coverage' => [
                'reliable' => count($reviewDurations),
                'terminal_records' => $terminal,
                'percentage' => $terminal > 0 ? round(count($reviewDurations) / $terminal * 100, 1) : null,
            ],
        ];
    }
}

if (!function_exists('adminInsightsSerialize')) {
    function adminInsightsStampReviewTransitions(array $previousRows, array $incomingRows, int $reviewerId, ?string $now = null): array {
        $now = $now ?: (new DateTimeImmutable('now', adminInsightsTimezone()))->format(DateTimeInterface::ATOM);
        $previous = [];
        foreach ($previousRows as $row) {
            if (!is_array($row)) continue;
            $previous[(string)($row['id'] ?? '')] = $row;
        }
        foreach ($incomingRows as &$row) {
            if (!is_array($row)) continue;
            $id = (string)($row['id'] ?? '');
            $status = (string)($row['status'] ?? 'pending');
            if (!in_array($status, ['approved', 'rejected'], true)) {
                unset($row['reviewed_at'], $row['reviewed_by']);
                continue;
            }
            $old = $previous[$id] ?? null;
            $oldStatus = (string)($old['status'] ?? '');
            if (!$old || $oldStatus === 'pending') {
                $row['reviewed_at'] = $now;
                $row['reviewed_by'] = $reviewerId > 0 ? $reviewerId : null;
            } elseif (!empty($old['reviewed_at'])) {
                $row['reviewed_at'] = $old['reviewed_at'];
                $row['reviewed_by'] = $old['reviewed_by'] ?? null;
            } else {
                unset($row['reviewed_at'], $row['reviewed_by']);
            }
        }
        unset($row);
        return $incomingRows;
    }

    function adminInsightsSerialize(array $value): array {
        array_walk_recursive($value, static function (&$item): void {
            if ($item instanceof DateTimeInterface) $item = $item->format(DateTimeInterface::ATOM);
        });
        return $value;
    }
}

if (!function_exists('adminInsightsSummary')) {
    function adminInsightsSummary(PDO $db, ?string $from = null, ?string $to = null, string $country = 'all', ?string $dataPath = null, ?string $wikiPath = null): array {
        $range = adminInsightsRange($from, $to);
        $country = in_array($country, ['china', 'japan'], true) ? $country : 'all';
        $sources = [];
        $records = adminInsightsLoadRecords($db, $dataPath, $sources);
        if ($country !== 'all') $records = array_values(array_filter($records, static fn($record) => $record['country'] === $country || $record['type'] === 'feedback'));
        $queueReview = adminInsightsQueueAndReview($records, $range);
        $quality = adminInsightsQuality($db, $dataPath, $wikiPath, $country, $sources);
        $priority = array_merge($queueReview['priority_queue'], $quality['issues']);
        adminInsightsSortIssues($priority);
        $payload = [
            'success' => true,
            'meta' => [
                'timezone' => 'Asia/Shanghai',
                'generated_at' => (new DateTimeImmutable('now', adminInsightsTimezone()))->format(DateTimeInterface::ATOM),
                'range' => ['from' => $range['from'], 'to' => $range['to']],
                'country' => $country,
                'sources' => $sources,
                'review_time_coverage' => $queueReview['review_time_coverage'],
            ],
            'queue' => $queueReview['queue'],
            'review' => $queueReview['review'],
            'quality' => $quality,
            'priority_items' => array_slice($priority, 0, 50),
        ];
        unset($payload['quality']['issues']);
        return adminInsightsSerialize($payload);
    }
}

if (!function_exists('adminInsightsIssues')) {
    function adminInsightsIssues(PDO $db, string $type = 'all', string $severity = 'all', string $country = 'all', int $page = 1, int $perPage = 50, ?string $dataPath = null, ?string $wikiPath = null): array {
        $sources = [];
        $records = adminInsightsLoadRecords($db, $dataPath, $sources);
        $range = adminInsightsRange(null, null);
        $queueReview = adminInsightsQueueAndReview($records, $range);
        $quality = adminInsightsQuality($db, $dataPath, $wikiPath, $country, $sources);
        $issues = array_merge($queueReview['priority_queue'], $quality['issues']);
        adminInsightsSortIssues($issues);
        if ($type !== 'all') $issues = array_values(array_filter($issues, static fn($item) => ($item['type'] ?? '') === $type));
        if ($severity !== 'all') $issues = array_values(array_filter($issues, static fn($item) => ($item['severity'] ?? '') === $severity));
        if ($country !== 'all') $issues = array_values(array_filter($issues, static fn($item) => ($item['country'] ?? '') === $country));
        $page = max(1, $page);
        $perPage = min(100, max(1, $perPage));
        $total = count($issues);
        return adminInsightsSerialize([
            'success' => true,
            'meta' => ['timezone' => 'Asia/Shanghai', 'generated_at' => (new DateTimeImmutable('now', adminInsightsTimezone()))->format(DateTimeInterface::ATOM), 'sources' => $sources],
            'issues' => array_slice($issues, ($page - 1) * $perPage, $perPage),
            'total' => $total,
            'page' => $page,
            'per_page' => $perPage,
        ]);
    }
}
