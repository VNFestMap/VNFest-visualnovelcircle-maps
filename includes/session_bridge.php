<?php
/**
 * PHP <-> Go session bridge.
 *
 * The bridge is best-effort until its schema is installed. Older PHP
 * deployments therefore continue to work, while Go-created PHPSESSID values
 * can be restored by a PHP rollback deployment after the table exists.
 */

const VNFEST_SESSION_BRIDGE_KEYS = [
    'user_id',
    'oauth_provider',
    'oauth_mode',
    'oauth_return_to',
    'oauth_started_at',
    'oauth_pending',
    'oauth_pending_error',
    'qq_state',
    'discord_state',
];

function sessionBridgePayload(): array {
    $payload = [];
    foreach (VNFEST_SESSION_BRIDGE_KEYS as $key) {
        if (array_key_exists($key, $_SESSION)) {
            $payload[$key] = $_SESSION[$key];
        }
    }
    return $payload;
}

function sessionBridgeKnown(string $sessionId): bool {
    if ($sessionId === '' || !function_exists('getDB')) return false;
    try {
        $stmt = getDB()->prepare(
            'SELECT 1 FROM vnfest_session_bridge WHERE session_id = ? AND is_valid = 1 AND expires_at > CURRENT_TIMESTAMP LIMIT 1'
        );
        $stmt->execute([$sessionId]);
        return (bool)$stmt->fetchColumn();
    } catch (Throwable $e) {
        return false;
    }
}

function sessionBridgeSyncFromDatabase(string $sessionId): void {
    if ($sessionId === '' || !function_exists('getDB')) return;
    try {
        $stmt = getDB()->prepare(
            'SELECT payload_json FROM vnfest_session_bridge WHERE session_id = ? AND is_valid = 1 AND expires_at > CURRENT_TIMESTAMP LIMIT 1'
        );
        $stmt->execute([$sessionId]);
        $payload = $stmt->fetchColumn();
        if (!is_string($payload) || $payload === '') return;
        $decoded = json_decode($payload, true);
        if (!is_array($decoded)) return;
        foreach (VNFEST_SESSION_BRIDGE_KEYS as $key) {
            if (array_key_exists($key, $decoded) && !array_key_exists($key, $_SESSION)) {
                $_SESSION[$key] = $decoded[$key];
            }
        }
    } catch (Throwable $e) {
        // Missing bridge schema must not cause a PHP availability outage.
    }
}

function sessionBridgeSave(string $sessionId, ?int $userId = null, ?int $lifetime = null): void {
    if ($sessionId === '' || !function_exists('getDB')) return;
    try {
        sessionBridgeWrite(getDB(), $sessionId, $userId, sessionBridgePayload(), $lifetime);
    } catch (Throwable $e) {
        // Best effort by design; PHP keeps its original session path.
    }
}

// Login uses this strict writer inside the caller's transaction. Do not hide a
// bridge write failure after retiring the current browser's previous session.
function sessionBridgeWrite(PDO $db, string $sessionId, ?int $userId, array $payload, ?int $lifetime = null): void {
        if ($userId !== null) $payload['user_id'] = $userId;
        $lifetime = $lifetime ?? 604800;
        $now = time();
        $params = [
            $sessionId,
            $userId,
            json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            date('Y-m-d H:i:s', $now + $lifetime),
            1,
            date('Y-m-d H:i:s', $now),
            date('Y-m-d H:i:s', $now),
        ];
        if (defined('DB_DRIVER') && DB_DRIVER === 'mysql') {
            $sql = 'INSERT INTO vnfest_session_bridge
                (session_id, user_id, payload_json, expires_at, is_valid, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), payload_json=VALUES(payload_json),
                expires_at=VALUES(expires_at), is_valid=VALUES(is_valid), updated_at=VALUES(updated_at)';
        } else {
            $sql = 'INSERT INTO vnfest_session_bridge
                (session_id, user_id, payload_json, expires_at, is_valid, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET user_id=excluded.user_id,
                payload_json=excluded.payload_json, expires_at=excluded.expires_at,
                is_valid=excluded.is_valid, updated_at=excluded.updated_at';
        }
        $db->prepare($sql)->execute($params);
}

function sessionBridgeTableExists(PDO $db): bool {
    try {
        $db->query('SELECT 1 FROM vnfest_session_bridge LIMIT 0');
        return true;
    } catch (PDOException $e) {
        if (str_contains(strtolower($e->getMessage()), 'no such table: vnfest_session_bridge')
            || ($e->getCode() === '42S02' && str_contains($e->getMessage(), 'vnfest_session_bridge'))) return false;
        throw $e;
    }
}

function sessionBridgeLoginIsValid(string $sessionId, int $userId): bool {
    $db = getDB();
    $stmt = $db->prepare('SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND is_valid = 1 AND expires_at > CURRENT_TIMESTAMP');
    $stmt->execute([$sessionId, $userId]);
    if (!$stmt->fetchColumn()) return false;
    if (!sessionBridgeTableExists($db)) return true;
    $stmt = $db->prepare('SELECT user_id, is_valid, expires_at > CURRENT_TIMESTAMP AS unexpired FROM vnfest_session_bridge WHERE session_id = ?');
    $stmt->execute([$sessionId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    // Legacy PHP sessions may predate the bridge and are imported on access.
    return !$row || ((int)$row['user_id'] === $userId && (int)$row['is_valid'] === 1 && (int)$row['unexpired'] === 1);
}

function sessionBridgeInvalidate(string $sessionId): void {
    if ($sessionId === '' || !function_exists('getDB')) return;
    try {
        getDB()->prepare(
            'UPDATE vnfest_session_bridge SET is_valid = 0, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?'
        )->execute([$sessionId]);
    } catch (Throwable $e) {
        // Best effort by design.
    }
}
