<?php

/**
 * Keep the membership columns needed by code redemption available on older deployments.
 * This is intentionally additive so the registration flow can use the existing schema
 * without requiring a separate migration step first.
 */
function clubCodeEnsureMembershipColumns(PDO $db): void
{
    $columns = [
        'country' => "VARCHAR(20) DEFAULT 'china'",
        'left_at' => 'DATETIME NULL',
        'join_method' => "VARCHAR(50) DEFAULT 'school_no_code'",
        'contact_account' => "VARCHAR(255) DEFAULT ''",
    ];

    foreach ($columns as $column => $definition) {
        $exists = false;
        try {
            $stmt = $db->query('PRAGMA table_info(club_memberships)');
            $cols = $stmt->fetchAll(PDO::FETCH_COLUMN, 1);
            $exists = in_array($column, $cols, true);
        } catch (Throwable $e) {
            try {
                $stmt = $db->query("SHOW COLUMNS FROM `club_memberships` LIKE '$column'");
                $exists = (bool)$stmt->fetch();
            } catch (Throwable $e2) {
                // The following ALTER will surface a real schema problem if necessary.
            }
        }

        if (!$exists) {
            try {
                $db->exec("ALTER TABLE `club_memberships` ADD COLUMN `$column` $definition");
            } catch (Throwable $e) {
                error_log('Unable to add club membership redemption column: ' . $e->getMessage());
            }
        }
    }
}

function clubCodeFetch(PDO $db, string $code): ?array
{
    $forUpdate = $db->inTransaction()
        && $db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql'
        ? ' FOR UPDATE' : '';
    $stmt = $db->prepare(
        "SELECT id, club_id, code, created_by, max_uses, use_count, expires_at, is_active, country
         FROM club_verification_codes WHERE code = ?" . $forUpdate
    );
    $stmt->execute([$code]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function clubCodeGetClubName(int $clubId, string $country = 'china'): string
{
    $file = $country === 'japan'
        ? __DIR__ . '/../data/clubs_japan.json'
        : __DIR__ . '/../data/clubs.json';
    if (!is_file($file)) return '同好会#' . $clubId;
    $payload = json_decode((string)file_get_contents($file), true);
    if (!is_array($payload)) return '同好会#' . $clubId;
    foreach (($payload['data'] ?? []) as $club) {
        if (is_array($club) && (int)($club['id'] ?? 0) === $clubId) {
            return (string)($club['display_name'] ?? $club['name'] ?? $club['school'] ?? ('同好会#' . $clubId));
        }
    }
    return '同好会#' . $clubId;
}

function clubCodeValidationMessage(array $verificationCode): ?string
{
    if (!(int)($verificationCode['is_active'] ?? 0)) {
        return '绑定码已被禁用';
    }
    if (!empty($verificationCode['expires_at'])
        && (string)$verificationCode['expires_at'] < date('Y-m-d H:i:s')) {
        return '绑定码已过期';
    }
    if ((int)($verificationCode['use_count'] ?? 0) >= (int)($verificationCode['max_uses'] ?? 0)) {
        return '绑定码已达使用上限';
    }
    return null;
}

class ClubCodeBindingException extends RuntimeException
{
}

/**
 * Bind a user as an active member and consume one code.
 * The caller owns the transaction; on failure this function makes no partial DB commit.
 *
 * @return array{success:bool,message:string,code_id?:int,club_id?:int,country?:string,club_name?:string}
 */
function clubCodeBindUser(PDO $db, int $userId, string $rawCode): array
{
    $code = strtoupper(trim($rawCode));
    if ($code === '') {
        return ['success' => false, 'message' => '请填写绑定码'];
    }

    $verificationCode = clubCodeFetch($db, $code);
    if (!$verificationCode) {
        return ['success' => false, 'message' => '绑定码无效'];
    }

    $validationMessage = clubCodeValidationMessage($verificationCode);
    if ($validationMessage !== null) {
        return ['success' => false, 'message' => $validationMessage];
    }

    $clubId = (int)$verificationCode['club_id'];
    $country = trim((string)($verificationCode['country'] ?? 'china')) ?: 'china';
    $joinedAt = date('Y-m-d H:i:s');

    try {
        $stmt = $db->prepare(
            'SELECT id, status FROM club_memberships WHERE user_id = ? AND club_id = ? AND country = ?'
        );
        $stmt->execute([$userId, $clubId, $country]);
    } catch (Throwable $e) {
        // Compatibility with a deployment that has not added country yet.
        $stmt = $db->prepare(
            'SELECT id, status FROM club_memberships WHERE user_id = ? AND club_id = ?'
        );
        $stmt->execute([$userId, $clubId]);
    }
    $existing = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($existing && (string)$existing['status'] === 'active') {
        return ['success' => false, 'message' => '你已经是该同好会的成员'];
    }

    if ($existing) {
        $stmt = $db->prepare(
            "UPDATE club_memberships
             SET status = 'active', role = 'member', join_method = 'school_code', joined_at = ?, left_at = NULL
             WHERE id = ?"
        );
        $stmt->execute([$joinedAt, $existing['id']]);
    } else {
        $stmt = $db->prepare(
            "INSERT INTO club_memberships (user_id, club_id, country, role, status, join_method, joined_at)
             VALUES (?, ?, ?, 'member', 'active', 'school_code', ?)"
        );
        $stmt->execute([$userId, $clubId, $country, $joinedAt]);
    }

    // Keep the limit check in the UPDATE as well as the earlier validation. The row is
    // locked on MySQL transactions, and the conditional update also protects other drivers.
    $stmt = $db->prepare(
        'UPDATE club_verification_codes
         SET use_count = use_count + 1
         WHERE id = ? AND is_active = 1 AND use_count < max_uses'
    );
    $stmt->execute([$verificationCode['id']]);
    if ($stmt->rowCount() !== 1) {
        throw new ClubCodeBindingException('绑定码已达使用上限');
    }

    return [
        'success' => true,
        'message' => '绑定成功',
        'code_id' => (int)$verificationCode['id'],
        'club_id' => $clubId,
        'country' => $country,
        'club_name' => clubCodeGetClubName($clubId, $country),
    ];
}
