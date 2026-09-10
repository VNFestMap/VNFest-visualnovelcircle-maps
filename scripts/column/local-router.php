<?php
declare(strict_types=1);

$requestPath = parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/';
if (preg_match('#^/column/(search|article|edit|my|admin)(?:/|$)#', $requestPath)) {
    require __DIR__ . '/../../column/index.html';
    return true;
}
return false;
