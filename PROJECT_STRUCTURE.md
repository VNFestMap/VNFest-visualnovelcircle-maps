# Project Structure

This repository is the public web root for the VNFest Galgame club map. Root-level HTML files are kept in place because they are public routes.

## Public Runtime

- `admin/` - admin pages.
- `api/` - PHP API endpoints.
- `css/` - shared page styles.
- `js/` - shared browser scripts.
- `includes/` - PHP shared modules.
- `data/` - runtime data placeholders and protected writable folders.
- `uploads/` - protected upload placeholders.
- `image/background/` - local background image drop folder.
- `images/` - bundled site images and icons.
- `wiki/` - generated Wiki pages, content JSON, and Wiki library files.
- `moe/` - Moe contest pages and assets.
- `twelve/` - Twelve contest pages and assets.
- `Galgame_events/` - GalOnly activity pages; public assets live in `Galgame_events/assets/`.
- `JUYOU/` - JUYOU event page and local assets.
- `club-operation-portrait/` - standalone club operation portrait tool.
- `Game/galgame_club_sim/` - standalone Galgame club simulator.
- `Game/spy/` - served build output of the 谁是卧底 (spy game); entry card lives in `club_square.html`. Real multiplayer backend: `api/spy_rooms.php|spy_table.php|spy_actions.php` over the `spy_*` tables, rules engine in `includes/spy_game.php` (+ `includes/spy_rules.php`), phase timeouts and idle-room reaping by `scripts/spy_worker.php` (server cron, every minute; `--reap` hourly).
- `Game/spy-react/` - Vite source project for `Game/spy/`. `npm install && npm run build` writes straight into `Game/spy/`; `node_modules/` is not part of the delivery. Contract check: `node scripts/test-page-i18n-contract.mjs` (with cwd = repo root); rules-engine assertions: `php scripts/test-spy-game.php`.
- `tools/` - small public utility pages, including `tools/GalgameTool/` (Galgame 履历书自助工具).
- `exam/` - club recognition assessment pages (list, detail, quiz, claim code redeem) and their assets; backed by the `recognition_*` tables and `includes/recognition/` modules. Renamed from `trial/` (同好会试炼 → 同好会考核); `trial/index.html` stays as a redirect stub for legacy links.
- `user-v2-assets/` - built assets used by the root `user.html` entry.

## Public Root Entries

The following files intentionally stay at the web root so existing links keep working:

- `index.html`
- `login.html`
- `user.html`
- `user-v2.html`
- `club_square.html`
- `club_share.html`
- `vote.html`
- `star_map.html`
- `submit.html`
- `submit_event.html`
- `submit_publication.html`
- `feedback.html`
- `achievements.html` - redirect stub to `user.html?tab=achievements` (the achievement zone moved into the user center)
- `verify.html` - public credential verification page

## Development And Operations

- `scripts/` - tests, migrations, generators, and packaging helpers.
- `user-v2-react/` - source project for the rebuilt user center.
- `docs/` - local design/reference workspace; ignored by Git.
- `_local/` - ignored local quarantine for logs, archives, duplicate exports, and source materials that should not affect runtime checks or builds.

## Organization Rules

- Keep public URL entry files at the root unless a redirect or compatibility wrapper is added.
- Put feature-owned browser assets inside that feature directory, such as `Galgame_events/assets/`.
- Keep PHP endpoints in `api/`; do not place API copies under `js/`.
- Keep browser scripts in `js/`; do not nest a second `js/` folder inside it.
- Keep logs, compressed backups, exported archives, and raw source materials under `_local/` or another ignored operations directory.
- Recognition/trial backend lives in `includes/recognition/` (one responsibility per file: capability / roles / events / rules / credential / outbox / pipeline / signature); only `credential.php` may create or change credential state. All `recognition_*` tables must be maintained in both dialect branches of `scripts/migrate.php`.
