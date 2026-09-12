<p align="right">
  <a href="README.md">中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <img src="images/VNF.png" alt="VNFest" width="420">
</p>

<p align="center">
  <b>Visual Novel Circle Directory, Club Operations, Event Publishing, Publication Calls for Submissions, Project Contests & Wiki — for High School Galgame / Visual Novel Clubs in China and Japan</b>
</p>

<p align="center">
  <a href="https://www.map.vnfest.top"><img alt="Website" src="https://img.shields.io/badge/🌐_Visit-map.vnfest.top-2ecc71?style=flat-square"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-2.2.0-2ecc71?style=flat-square">
  <img alt="PHP" src="https://img.shields.io/badge/PHP-8.x-777bb4?style=flat-square&logo=php&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-18-61dafb?style=flat-square&logo=react&logoColor=white">
  <img alt="D3.js" src="https://img.shields.io/badge/D3.js-7.9-f9a03c?style=flat-square&logo=d3.js&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-GPLv3-355c9b?style=flat-square">
</p>

---

## What Is This

**VNFest** (Visual Novel Festival) is not just a circle directory. It is a lightweight operations platform purpose-built for visual novel clubs, linking together map navigation, club profile management, member administration, event calendars, publication calls for submissions, project collaboration, voting contests, and a Wiki encyclopedia into one seamless workflow.

Whether you are an enthusiast looking for a club, a club admin maintaining your organization's information, an event organizer planning activities, or an editor contributing to the encyclopedia — VNFest has a dedicated entry point for you.

```text
Discover circles → View details → Apply to join → Participate in events → Submit to publications / Wiki → Join project contests
```

> **Live demo:** [https://www.map.vnfest.top](https://www.map.vnfest.top)
> No registration required — enter guest mode to browse the map and circle information.

---

## Features in Detail

### 🗺️ Map & Discovery

The core VNFest experience begins with an interactive map.

The China map covers all provinces, and the Japan map is precise down to the prefecture level, with each region displaying registered visual novel circles. Click any area to view that region's circle list, or switch freely between map view and list view.

In addition to map browsing, the platform provides a province index, keyword search, type filtering (school clubs / community organizations / online communities), and multi-dimensional sorting for discovery. A single circle can be associated with multiple provinces, ensuring cross-regional organizations are properly represented.

Guests can browse all map data and circle details without logging in; once logged in, users gain access to management controls for editing the clubs they are responsible for.

### 📋 Circle Profiles

Every circle has a comprehensive profile page, including name, region, affiliated school, organization type, contact information, and a detailed introduction.

Club admins can upload and crop a club avatar, maintain the club bio, and update contact details. The system supports a three-tier permission model: regular members, circle admins, and super administrators — each role sees a different set of available actions.

For member management, the platform supports join requests, admin review, and quick-join via binding codes. Circle detail pages also feature a recommendation board (where other users can recommend their favorite clubs) and a message board (where members and visitors can leave messages and interact), turning what would be a static info page into a living community page.

### 📅 Events & Publications

The **event system** offers both a calendar view and a list view. Circle admins can publish events, manage submissions, review content, and track registration data. Users can sign up for events directly on the event page.

**Publication calls for submissions** allow admins to post submission guidelines, track submission status (pending review / accepted / published), and link publications back to the originating circle.

**GalOnly events** have their own dedicated landing page and review panel, along with a full **Staff recruitment system** — users can submit staff applications online, administrators screen candidates through voting and review workflows, and a final schedule roster is locked in.

### 🏗️ Project Hub

The Project Hub is the center of inter-club collaboration.

Admins can create project plans, invite other members, and assign roles (planning / art / writing / technical). Each project has clear status tracking — from preparation, in progress, completed, to shelved — all at a glance. Projects also support file attachments, making it easy for teams to share materials and documents.

All projects are aggregated and publicly displayed in the Circle Square, giving broader visibility to ongoing community projects.

### 🏆 Voting Contests

VNFest features a unified voting foundation that supports flexible multi-phase, multi-round configurations. Two signature contests are built on top of this system:

**Twelve** — a works-based selection system. The flow is nomination → preliminary round → group scoring/voting, ultimately producing the annual Top 12 visual novels. Data sources prioritize Bangumi search results, supplemented by VNDB data, while still providing a manual nomination entry point.

**Moe Contest** — a character-based battle system. The flow is nomination → preliminary round → power-of-2 bracket 1v1 elimination tournament, ultimately crowning the Moe King. The elimination stage features a dedicated bracket visualization component with zoom, pan, and drag interactions, displaying real-time voting status and vote counts for each match.

Both contests come with their own Hub page, detail page, and contest management backend, enabling the entire workflow from nomination to finals to be completed online.

### 👤 User Center

The v2.0 User Center is a complete rewrite, migrating from a monolithic HTML page to a React 18-based SPA architecture.

It provides a one-stop experience for profile editing, club management, messaging and notifications, and the growth system. Pages load faster, interactions are smoother, and the architecture provides a solid foundation for future feature expansion.

Supports local account registration/login, email verification codes, password recovery, as well as QQ and Discord third-party OAuth login.

### 📖 Wiki Encyclopedia

The VNFest Wiki uses an encyclopedia-style layout — left sidebar navigation + right content area — consistent with the experience of traditional Wiki sites.

The editor supports visual (WYSIWYG) editing and allows inserting images, infoboxes, timelines, external links, and structured content blocks. Content supports both Chinese and Japanese bilingual editing, meeting the needs of different user groups.

Once editing is complete, Wiki pages can be directly generated and published as static HTML with no additional build steps. The Wiki homepage provides quick-access entry points such as "Recent Changes" and "Public Archives" for easy browsing and maintenance.

### 📚 Public Archives

A digital archiving system for circle publications. Supports PDF and image format uploads, and administrators can maintain publication metadata (title, author, publication date, associated circle, etc.).

Includes a built-in PDF reader tool with 3D page-turning preview effects, allowing users to browse publication content online without downloading.

### 🌌 Circle Square

Circle Square is the information hub of the entire platform, centrally displaying all public contests, projects, and events.

Designed with a deep-space theme and featuring five-color event cards for categorical identification, users can instantly distinguish different types of community activity at a glance. Supports Chinese/Japanese bilingual switching, ensuring users of different languages can browse without barriers.

### 🌟 United Star Map

The United Star Map is a visually immersive exploration entry point.

The page adopts a Cinematic Frontend v2 design — radial gradient backgrounds, radar sweep animations, and vignette effects create an atmosphere of space exploration. Supports an immersive mode that hides HUD elements, allowing users to fully immerse themselves in starmap browsing.

---

## Who Uses It

| Role | What They Can Do |
|------|-----------------|
| **Guests** | Browse the map, view circle details, read the Wiki, watch contests |
| **Registered Users** | Join circles, sign up for events, submit to publications, edit the Wiki, participate in voting |
| **Circle Admins** | Maintain club profiles, publish events and calls for submissions, manage members, create projects, launch contests |
| **Administrators** | Review circles, manage GalOnly events, operate Moe Contest / Twelve contests, site-wide notifications |

---

## v2.1 Highlights

> From v2.0 to v2.1, VNFest completed a full-chain upgrade of community interaction and operations governance.

| Highlight | Description |
|-----------|-------------|
| **Editorial Column** | A dedicated article space with series, rich-text writing, comments and optional club attribution |
| **Super Admin Console** | Operations dashboards: review trends, top-12 circle regions, operation logs |
| **Beijing GalOnly 2nd** | Dual flows for booth applications and staff recruitment, with dedicated review and event logos |
| **MakoQuiz Integration** | Quiz score reporting + HMAC bind tokens for secure cross-site account sharing |
| **Centralized Preferences** | Language, theme and map controls unified in one place; account language synced across devices |
| **Wiki Guide** | Bilingual (ZH/JA) usage documentation with grouped navigation and in-site search |
| **Jiangsu Sub-map** | 13 prefecture-level cities as a self-contained offline SVG — no external map requests |
| **AstrBot beta0.5** | Bot query/sync plugin release with a plugin download entry |

---

## Technical Architecture

```text
┌──────────────────────────────────────────────────────┐
│                    Browser / Client                    │
│   HTML + CSS + Vanilla JS    │    React 18 SPA       │
│   D3.js 7 (Map Visualization) │   (User Center)       │
└────────────────┬─────────────┴───────────┬───────────┘
                 │  fetch() / REST         │
┌────────────────┴─────────────────────────┴───────────┐
│                   PHP 8.x Backend                      │
│   api/*.php (endpoints)  │  includes/*.php (shared)    │
│   __DIR__ relative paths, zero framework dependency    │
└────────────────┬─────────────────────────────────────┘
                 │
┌────────────────┴─────────────────────────────────────┐
│                     Data Layer                         │
│   JSON runtime files   │  SQLite / MySQL via PDO      │
│   data/*.json          │  data/galgame.db             │
└──────────────────────────────────────────────────────┘
```

| Layer | Technology |
|-------|-----------|
| Frontend | HTML · CSS · Vanilla JavaScript · React 18 · D3.js 7 |
| Backend | PHP 8.x (`__DIR__` relative paths, zero framework dependency) |
| Data | JSON runtime files · SQLite / MySQL via PDO |
| Build | Vite (User Center SPA) |
| Testing | Node.js contract tests (39+ test scripts) |
| Deployment | Docker · GitHub Actions CI/CD · Watchtower auto rolling updates |
| i18n | Chinese / Japanese bilingual support |

---

## Project Structure

```text
.
├─ admin/                  Admin panel (reviews, contest management, Wiki editing)
├─ api/                    PHP API endpoints (60+ interfaces)
├─ css/                    Site-wide styles
├─ data/                   Runtime data directory (excluded from Git)
├─ Galgame_events/         GalOnly event pages and assets
├─ Game/                   Visual novel circle simulator
├─ image/background/       Local wallpaper directory
├─ images/                 Built-in site image assets
├─ includes/               PHP shared modules (auth, email, notifications, OAuth…)
├─ js/                     Frontend scripts (map, voting, project management…)
├─ JUYOU/                  JUYOU event page
├─ moe/                    Moe Contest system (including bracket visualization)
├─ scripts/                Test, migration, and build scripts
├─ tools/                  Public tool pages (PDF reader, etc.)
├─ twelve/                 Twelve contest pages
├─ user-v2-react/          User Center React source code
├─ wiki/                   Wiki pages, editor, and content data
│
├─ index.html              Main map entry
├─ login.html              Login / registration entry
├─ user.html               User Center (React SPA)
├─ star_map.html           United Star Map
├─ club_square.html        Events Hub
├─ vote.html               Voting event entry
├─ submit*.html            Submission entry points (events / publications / general)
│
├─ Dockerfile              Container image definition
├─ docker-compose.yml      Service orchestration config
├─ PROJECT_STRUCTURE.md    Directory boundaries and organization rules
└─ README.md
```

> The HTML files in the root directory serve as public URL route entry points and are kept in the web root for backward compatibility with existing links.
> For complete directory boundaries and organization rules, see [`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md).

---

## Getting Started

### Requirements

- PHP 8.0+ (with `mbstring` and `pdo_sqlite` extensions)
- Node.js 18+ (for testing and builds)
- Git

### Running Locally

```bash
# 1. Clone the repository
git clone https://github.com/VNFestMap/china-visualnovelcircle-maps.git
cd china-visualnovelcircle-maps

# 2. Install dependencies
npm install

# 3. Prepare the config file
cp config.example.php config.php
# Edit config.php to set the database path and site URL

# 4. Start the PHP development server
php -S 127.0.0.1:8000
```

Open your browser and visit:

| Page | URL |
|------|-----|
| Login / Register | `http://127.0.0.1:8000/login.html` |
| Guest mode browsing | `http://127.0.0.1:8000/index.html?guest=1` |

### Running Tests

```bash
npm run check
```

This command runs all 40+ contract tests, covering frontend interactions, Wiki generation, upload contracts, circle editing, backend privacy, growth system, user pages, internationalization, performance optimization, voting flows, bot sync, and overall project health.

---

## Deployment

The project supports Docker containerized deployment. GitHub Actions automatically builds images and pushes them to GHCR, while Watchtower on the server handles automatic pulling and rolling updates.

```bash
# One-click deploy with Docker Compose
docker compose up -d

# Or use the deployment script (includes data backup and permission setup)
bash scripts/deploy.sh
```

For detailed deployment configuration, environment variable documentation, and operations guides, see [`DEPLOY.md`](DEPLOY.md).

---

## Version History

| Version | Key Theme |
|---------|-----------|
| **[v2.2.0](RELEASE_NOTES_2.2.0.md)** | React circle feed, standalone search, mutual-follow messaging, React admin workspace, OAuth credential upgrades, and GalgameTool Tier/MEME tools |
| **v2.1.0** | Editorial column, Super Admin Console, Beijing GalOnly, MakoQuiz integration, centralized preferences, Wiki guide |
| **v2.0.0** | User Center SPA, Staff recruitment, Public Archives, bracket visualization, unified design system |
| v1.7.x | Project Hub, Twelve, Moe Contest engine, voting events, Circle Square, Docker CI/CD |
| v1.6.x | Wiki subsystem, circle binding codes, notification system, multi-platform publishing (desktop / Android) |
| v1.5.0 | User panel redesign, GalOnly high school channel, event calendar registration |
| v1.0 | National circle map launch, Japan expansion, user system |

---

## Contributing

Issues and Pull Requests are welcome.

Before submitting, please confirm:

```bash
# 1. Run contract tests
npm run check

# 2. Check your staged changes
git status --short
git status --ignored --short
```

Make sure that local configuration files (`config.php`, `.env`), runtime data (`data/*.json`, `data/cache/`), user-uploaded files (`uploads/`), and build artifacts (`node_modules/`, `dist/`) are not included in your commit.

For multi-contributor collaboration guidelines, see [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## License

This project is released under the [GNU General Public License v3.0](LICENSE).

---

<p align="center">
  <sub>VNFest — Visual Novel Festival</sub><br>
  <sub>Made with ❤️ for the visual novel community</sub>
</p>
