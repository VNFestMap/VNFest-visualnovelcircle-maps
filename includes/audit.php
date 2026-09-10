<?php
// includes/audit.php - 审计日志
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

function logAction(string $action, ?string $targetType = null, ?int $targetId = null, ?array $details = null): void {
    $user = getCurrentUser();
    $db = getDB();
    $details = $details ?? [];

    // Keep request context inside the existing JSON column so deployments do not
    // need a schema migration. Only the request path is stored: query strings can
    // contain verification codes or tokens and must never enter the audit log.
    $requestPath = '';
    if (!empty($_SERVER['REQUEST_URI'])) {
        $parsedPath = parse_url((string)$_SERVER['REQUEST_URI'], PHP_URL_PATH);
        $requestPath = is_string($parsedPath) ? $parsedPath : '';
    }
    $details['_context'] = [
        'method' => substr((string)($_SERVER['REQUEST_METHOD'] ?? 'CLI'), 0, 12),
        'path' => substr($requestPath, 0, 255),
        'user_agent' => substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 500),
        // This is the role at operation time. The users table only reflects the
        // actor's current role when an administrator reads historical records.
        'actor_role' => isset($user['role']) ? (string)$user['role'] : null,
    ];
    $jsonFlags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;
    if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) {
        $jsonFlags |= JSON_INVALID_UTF8_SUBSTITUTE;
    }
    $stmt = $db->prepare(
        "INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
         VALUES (?, ?, ?, ?, ?, ?)"
    );
    $stmt->execute([
        $user['id'] ?? null,
        $action,
        $targetType,
        $targetId,
        json_encode($details, $jsonFlags),
        $_SERVER['REMOTE_ADDR'] ?? ''
    ]);
}
